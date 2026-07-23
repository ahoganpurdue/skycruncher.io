//! Zero-copy Arrow IPC file access: memmap2 read-only map → `bytes::Bytes::from_owner` →
//! `arrow_buffer::Buffer` → footer parse → `FileDecoder::with_require_alignment(true)` →
//! per-block `slice_with_length` → `read_record_batch`. Column views are `ScalarBuffer<T>`
//! clones (Arc'd slices into the mapped file — no copies, mmap kept alive by refcount).
//!
//! HDD reality (D: is a spinning disk): an optional sequential prefetch pass streams the file
//! through a plain read loop before mapping. On Windows a plain sequential `ReadFile` loop
//! engages the OS readahead far more reliably than page-fault walking a mapping, and it warms
//! the identical page-cache pages the mmap will fault. Cheap byte-sum defeats dead-code elim.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use arrow_array::cast::AsArray;
use arrow_array::types::{ArrowPrimitiveType, Float32Type, Float64Type, Int32Type, UInt32Type, UInt64Type};
use arrow_array::{Array, RecordBatch};
use arrow_buffer::{Buffer, ScalarBuffer};
use arrow_ipc::convert::fb_to_schema;
use arrow_ipc::reader::{read_footer_length, FileDecoder};
use arrow_ipc::root_as_footer;
use arrow_schema::{DataType, Schema, SchemaRef};

use super::manifest::BandBlob;
use super::IndexError;

/// Expected stars.arrow columns (name, type, order) — ground truth from the builder.
pub const STAR_COLUMNS: [(&str, DataType); 4] = [
    ("ra_deg", DataType::Float64),
    ("dec_deg", DataType::Float64),
    ("g_mag", DataType::Float32),
    ("source_id", DataType::UInt64),
];

/// Expected band_i.arrow columns (name, type, order).
pub const BAND_COLUMNS: [(&str, DataType); 10] = [
    ("code0", DataType::Float32),
    ("code1", DataType::Float32),
    ("code2", DataType::Float32),
    ("code3", DataType::Float32),
    ("star0", DataType::UInt32),
    ("star1", DataType::UInt32),
    ("star2", DataType::UInt32),
    ("star3", DataType::UInt32),
    ("diam_deg", DataType::Float32),
    ("code_key", DataType::Int32),
];

/// Per-file open accounting.
#[derive(Debug, Default, Clone)]
pub struct OpenStats {
    pub file_bytes: u64,
    pub prefetch_ms: u64,
    pub parse_ms: u64,
}

fn io_err(path: &Path, e: std::io::Error) -> IndexError {
    IndexError::Io {
        path: path.display().to_string(),
        source: e,
    }
}

fn arrow_err(path: &Path, msg: impl Into<String>) -> IndexError {
    IndexError::Arrow {
        path: path.display().to_string(),
        msg: msg.into(),
    }
}

fn schema_err(path: &Path, msg: impl Into<String>) -> IndexError {
    IndexError::Schema {
        path: path.display().to_string(),
        msg: msg.into(),
    }
}

/// Sequential page-warm pass (see module docs). Returns (defeat-DCE sum, wall ms).
fn prefetch_sequential(path: &Path) -> Result<(u64, u64), IndexError> {
    let t = Instant::now();
    let mut f = File::open(path).map_err(|e| io_err(path, e))?;
    let mut chunk = vec![0u8; 1 << 20];
    let mut sum: u64 = 0;
    loop {
        let n = f.read(&mut chunk).map_err(|e| io_err(path, e))?;
        if n == 0 {
            break;
        }
        // one touch per 4 KiB page of the chunk — cheap, non-eliminable
        let mut i = 0;
        while i < n {
            sum = sum.wrapping_add(chunk[i] as u64);
            i += 4096;
        }
    }
    Ok((std::hint::black_box(sum), t.elapsed().as_millis() as u64))
}

/// A fully parsed, zero-copy-mapped Arrow IPC file. (The mapped file stays alive through the
/// refcounted `Buffer` slices held by every column view — no owner field needed.)
pub(crate) struct IpcFile {
    pub schema: SchemaRef,
    pub batches: Vec<RecordBatch>,
    pub stats: OpenStats,
}

pub(crate) fn open_ipc(path: &Path, prefetch: bool) -> Result<IpcFile, IndexError> {
    let (_, prefetch_ms) = if prefetch {
        prefetch_sequential(path)?
    } else {
        (0, 0)
    };

    let t = Instant::now();
    let file = File::open(path).map_err(|e| io_err(path, e))?;
    // SAFETY: read-only mapping of an immutable, checksum-verified release file. The release
    // contract forbids in-place mutation; a concurrent writer would be a contract violation
    // upstream of this reader.
    let mmap = unsafe { memmap2::Mmap::map(&file) }.map_err(|e| io_err(path, e))?;
    let file_bytes = mmap.len() as u64;
    let buffer = Buffer::from(bytes::Bytes::from_owner(mmap));
    let data: &[u8] = buffer.as_slice();

    if data.len() < 18 {
        return Err(arrow_err(path, format!("file too small ({} bytes)", data.len())));
    }
    let trailer: [u8; 10] = data[data.len() - 10..].try_into().expect("10-byte trailer");
    let footer_len =
        read_footer_length(trailer).map_err(|e| arrow_err(path, format!("footer length: {e}")))?;
    let footer_end = data.len() - 10;
    if footer_len > footer_end {
        return Err(arrow_err(path, format!("footer length {footer_len} exceeds file")));
    }
    let footer = root_as_footer(&data[footer_end - footer_len..footer_end])
        .map_err(|e| arrow_err(path, format!("footer flatbuffer: {e:?}")))?;
    let fb_schema = footer
        .schema()
        .ok_or_else(|| arrow_err(path, "footer missing schema"))?;
    let schema: SchemaRef = Arc::new(fb_to_schema(fb_schema));
    if let Some(dicts) = footer.dictionaries() {
        if !dicts.is_empty() {
            return Err(schema_err(path, "dictionary batches unsupported in this format"));
        }
    }

    let decoder = FileDecoder::new(schema.clone(), footer.version()).with_require_alignment(true);
    let blocks = footer
        .recordBatches()
        .ok_or_else(|| arrow_err(path, "footer missing recordBatches"))?;
    let mut batches = Vec::with_capacity(blocks.len());
    for i in 0..blocks.len() {
        let block = blocks.get(i);
        let offset = block.offset() as usize;
        let len = block.metaDataLength() as usize + block.bodyLength() as usize;
        if offset.saturating_add(len) > data.len() {
            return Err(arrow_err(path, format!("block {i} range {offset}+{len} exceeds file")));
        }
        let slice = buffer.slice_with_length(offset, len);
        let batch = decoder
            .read_record_batch(block, &slice)
            .map_err(|e| arrow_err(path, format!("block {i} decode: {e}")))?
            .ok_or_else(|| arrow_err(path, format!("block {i} decoded to nothing")))?;
        batches.push(batch);
    }
    let parse_ms = t.elapsed().as_millis() as u64;

    Ok(IpcFile {
        schema,
        batches,
        stats: OpenStats {
            file_bytes,
            prefetch_ms,
            parse_ms,
        },
    })
}

fn require_schema(
    path: &Path,
    schema: &Schema,
    expected: &[(&str, DataType)],
) -> Result<(), IndexError> {
    if schema.fields().len() != expected.len() {
        return Err(schema_err(
            path,
            format!(
                "{} columns, expected {} ({:?})",
                schema.fields().len(),
                expected.len(),
                schema.fields().iter().map(|f| f.name().clone()).collect::<Vec<_>>()
            ),
        ));
    }
    for (i, (name, dt)) in expected.iter().enumerate() {
        let f = schema.field(i);
        if f.name() != name {
            return Err(schema_err(path, format!("column {i} named '{}', expected '{name}'", f.name())));
        }
        if f.data_type() != dt {
            return Err(schema_err(
                path,
                format!("column '{name}' type {:?}, expected {dt:?}", f.data_type()),
            ));
        }
        if f.is_nullable() {
            return Err(schema_err(path, format!("column '{name}' nullable — contract is no validity buffers")));
        }
    }
    Ok(())
}

/// Downcast column `i` of a batch to a primitive `ScalarBuffer` view (validity-free contract).
fn col<T: ArrowPrimitiveType>(
    path: &Path,
    batch: &RecordBatch,
    i: usize,
) -> Result<ScalarBuffer<T::Native>, IndexError> {
    let a = batch.column(i);
    if a.null_count() != 0 {
        return Err(schema_err(path, format!("column {i} has {} nulls", a.null_count())));
    }
    let p = a
        .as_primitive_opt::<T>()
        .ok_or_else(|| schema_err(path, format!("column {i} downcast failed ({:?})", a.data_type())))?;
    Ok(p.values().clone())
}

/// The star table: one record batch, brightness-rank row order (row index = brightness rank).
pub struct StarTable {
    pub ra: ScalarBuffer<f64>,
    pub dec: ScalarBuffer<f64>,
    pub gmag: ScalarBuffer<f32>,
    pub source_id: ScalarBuffer<u64>,
    pub n_rows: u64,
}

impl StarTable {
    pub fn open(
        path: &Path,
        expected_rows: u64,
        prefetch: bool,
    ) -> Result<(StarTable, OpenStats), IndexError> {
        let ipc = open_ipc(path, prefetch)?;
        require_schema(path, &ipc.schema, &STAR_COLUMNS)?;
        if ipc.batches.len() != 1 {
            return Err(arrow_err(
                path,
                format!("{} record batches, expected exactly 1", ipc.batches.len()),
            ));
        }
        let batch = &ipc.batches[0];
        let n = batch.num_rows() as u64;
        if n != expected_rows {
            return Err(IndexError::Validation(format!(
                "{}: {} rows != manifest stars.rows {}",
                path.display(),
                n,
                expected_rows
            )));
        }
        let table = StarTable {
            ra: col::<Float64Type>(path, batch, 0)?,
            dec: col::<Float64Type>(path, batch, 1)?,
            gmag: col::<Float32Type>(path, batch, 2)?,
            source_id: col::<UInt64Type>(path, batch, 3)?,
            n_rows: n,
        };
        Ok((table, ipc.stats))
    }
}

/// One quad row, materialized (spot access / test paths — the hot path reads columns).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuadRow {
    pub code: [f32; 4],
    pub star: [u32; 4],
    pub diam_deg: f32,
    pub code_key: i32,
}

/// Per-record-batch primitive column views of a band file.
pub struct QuadBatchCols {
    pub code: [ScalarBuffer<f32>; 4],
    pub star: [ScalarBuffer<u32>; 4],
    pub diam: ScalarBuffer<f32>,
    pub key: ScalarBuffer<i32>,
    pub n_rows: usize,
}

/// A mapped band file: batched column views + uniform batch addressing
/// (global row r ⇒ batch r / batch_rows, offset r % batch_rows).
pub struct BandView {
    pub batches: Vec<QuadBatchCols>,
    pub n_rows: u64,
    pub batch_rows: usize,
}

impl BandView {
    /// Open + validate a band file against its manifest blob: batch counts/sizes, column
    /// schema, global code_key sort order, and per-batch key min/max.
    pub fn open(
        path: &Path,
        blob: &BandBlob,
        batch_rows: usize,
        prefetch: bool,
    ) -> Result<(BandView, OpenStats), IndexError> {
        if batch_rows == 0 {
            return Err(IndexError::Validation("batch_rows must be >= 1".into()));
        }
        let ipc = open_ipc(path, prefetch)?;
        require_schema(path, &ipc.schema, &BAND_COLUMNS)?;

        // Builder emits ONE 0-row batch (and an empty manifest batches[]) for an empty band.
        if blob.n_quads == 0 {
            let total: usize = ipc.batches.iter().map(|b| b.num_rows()).sum();
            if total != 0 {
                return Err(IndexError::Validation(format!(
                    "{}: {} rows but manifest nQuads == 0",
                    path.display(),
                    total
                )));
            }
            return Ok((
                BandView {
                    batches: Vec::new(),
                    n_rows: 0,
                    batch_rows,
                },
                ipc.stats,
            ));
        }

        if ipc.batches.len() != blob.batches.len() {
            return Err(IndexError::Validation(format!(
                "{}: {} record batches != manifest {} batch metas",
                path.display(),
                ipc.batches.len(),
                blob.batches.len()
            )));
        }

        let mut batches = Vec::with_capacity(ipc.batches.len());
        let mut total: u64 = 0;
        for (j, batch) in ipc.batches.iter().enumerate() {
            let meta = &blob.batches[j];
            let n = batch.num_rows();
            if n as u64 != meta.rows {
                return Err(IndexError::Validation(format!(
                    "{}: batch {j} has {n} rows != manifest {}",
                    path.display(),
                    meta.rows
                )));
            }
            let is_last = j == ipc.batches.len() - 1;
            if !is_last && n != batch_rows {
                return Err(IndexError::Validation(format!(
                    "{}: non-last batch {j} has {n} rows != batchRows {batch_rows}",
                    path.display()
                )));
            }
            batches.push(QuadBatchCols {
                code: [
                    col::<Float32Type>(path, batch, 0)?,
                    col::<Float32Type>(path, batch, 1)?,
                    col::<Float32Type>(path, batch, 2)?,
                    col::<Float32Type>(path, batch, 3)?,
                ],
                star: [
                    col::<UInt32Type>(path, batch, 4)?,
                    col::<UInt32Type>(path, batch, 5)?,
                    col::<UInt32Type>(path, batch, 6)?,
                    col::<UInt32Type>(path, batch, 7)?,
                ],
                diam: col::<Float32Type>(path, batch, 8)?,
                key: col::<Int32Type>(path, batch, 9)?,
                n_rows: n,
            });
            total += n as u64;
        }
        if total != blob.n_quads {
            return Err(IndexError::Validation(format!(
                "{}: {total} total rows != manifest nQuads {}",
                path.display(),
                blob.n_quads
            )));
        }

        // Global sort-order + per-batch min/max validation (single linear pass, mmap-warm).
        let mut prev = i32::MIN;
        for (j, b) in batches.iter().enumerate() {
            let keys: &[i32] = b.key.as_ref();
            let meta = &blob.batches[j];
            if keys.is_empty() {
                continue;
            }
            if keys[0] != meta.code_key_min || keys[keys.len() - 1] != meta.code_key_max {
                return Err(IndexError::Validation(format!(
                    "{}: batch {j} key span [{}, {}] != manifest [{}, {}]",
                    path.display(),
                    keys[0],
                    keys[keys.len() - 1],
                    meta.code_key_min,
                    meta.code_key_max
                )));
            }
            for &k in keys {
                if k < prev {
                    return Err(IndexError::Validation(format!(
                        "{}: code_key sort violation in batch {j} ({k} after {prev})",
                        path.display()
                    )));
                }
                if k < 0 {
                    return Err(IndexError::Validation(format!(
                        "{}: negative code_key {k} in batch {j}",
                        path.display()
                    )));
                }
                prev = k;
            }
        }

        Ok((
            BandView {
                batches,
                n_rows: total,
                batch_rows,
            },
            ipc.stats,
        ))
    }

    /// (batch, offset) of a global row.
    #[inline]
    pub fn locate(&self, row: u64) -> (usize, usize) {
        let r = row as usize;
        (r / self.batch_rows, r % self.batch_rows)
    }

    #[inline]
    pub fn key_at(&self, row: u64) -> i32 {
        let (b, o) = self.locate(row);
        self.batches[b].key[o]
    }

    /// Materialize one quad row (crosses batch addressing transparently).
    #[inline]
    pub fn quad_at(&self, row: u64) -> QuadRow {
        let (b, o) = self.locate(row);
        let c = &self.batches[b];
        QuadRow {
            code: [c.code[0][o], c.code[1][o], c.code[2][o], c.code[3][o]],
            star: [c.star[0][o], c.star[1][o], c.star[2][o], c.star[3][o]],
            diam_deg: c.diam[o],
            code_key: c.key[o],
        }
    }
}
