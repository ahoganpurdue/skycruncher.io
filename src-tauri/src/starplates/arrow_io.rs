//! Arrow IPC encode/decode for the starplates byte contracts.
//!
//! - Cell files: Arrow IPC **file** format (`ARROW1` magic + footer), exactly one
//!   record batch, uncompressed, no validity buffers, 64-byte alignment,
//!   MetadataVersion::V5 (spec §3.2 FROZEN).
//! - Query responses: Arrow IPC **stream** format, same columns with positions
//!   propagated, schema custom_metadata carrying provenance (spec §5.2 FROZEN).
//!
//! Column schema (exact names, types, order — spec §3.2):
//!   ra_deg f64, dec_deg f64, pm_ra_masyr f32, pm_dec_masyr f32,
//!   g_mag f32, bp_rp f32, source_id u64
//!
//! DEVIATION (documented in docs/STARPLATES_SPEC.md deviation ledger): cell
//! files written by THIS writer carry the six logical schema-metadata fields
//! folded into a single `skycruncher` key. arrow-rs (=54.3.1) serializes schema
//! metadata by iterating a std HashMap (arrow-ipc convert.rs `metadata_to_fb`),
//! whose order is randomized per process — six discrete keys would violate the
//! §3.3 byte-determinism gate. Readers never depend on cell metadata (the
//! manifest is authoritative), and the RESPONSE keeps the discrete keys of
//! §5.2 because responses are ephemeral (determinism not required, TS reads
//! the keys individually).

use arrow_array::{Array, Float32Array, Float64Array, RecordBatch, UInt64Array};
use arrow_ipc::reader::{FileReader, StreamReader};
use arrow_ipc::writer::{FileWriter, IpcWriteOptions, StreamWriter};
use arrow_ipc::MetadataVersion;
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

pub const ARROW_FILE_MAGIC: &[u8; 6] = b"ARROW1";

/// One catalog row, in release units (spec §3.2 semantics).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StarRow {
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub pm_ra_masyr: f32,
    pub pm_dec_masyr: f32,
    pub g_mag: f32,
    pub bp_rp: f32,
    pub source_id: u64,
}

fn schema_fields() -> Vec<Field> {
    vec![
        Field::new("ra_deg", DataType::Float64, false),
        Field::new("dec_deg", DataType::Float64, false),
        Field::new("pm_ra_masyr", DataType::Float32, false),
        Field::new("pm_dec_masyr", DataType::Float32, false),
        Field::new("g_mag", DataType::Float32, false),
        Field::new("bp_rp", DataType::Float32, false),
        Field::new("source_id", DataType::UInt64, false),
    ]
}

fn write_options() -> IpcWriteOptions {
    // 64-byte alignment, modern (non-legacy) format, MetadataVersion::V5 — spec §3.2.
    IpcWriteOptions::try_new(64, false, MetadataVersion::V5)
        .expect("static IPC write options are valid")
}

/// Sort in the release row order: g_mag asc, ties source_id asc (spec §3.2).
pub fn sort_rows(rows: &mut [StarRow]) {
    rows.sort_by(|a, b| {
        a.g_mag
            .total_cmp(&b.g_mag)
            .then_with(|| a.source_id.cmp(&b.source_id))
    });
}

fn build_batch(
    rows: &[StarRow],
    metadata: HashMap<String, String>,
) -> Result<(Arc<Schema>, RecordBatch), String> {
    let schema = Arc::new(Schema::new(schema_fields()).with_metadata(metadata));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Float64Array::from(rows.iter().map(|r| r.ra_deg).collect::<Vec<_>>())),
            Arc::new(Float64Array::from(rows.iter().map(|r| r.dec_deg).collect::<Vec<_>>())),
            Arc::new(Float32Array::from(rows.iter().map(|r| r.pm_ra_masyr).collect::<Vec<_>>())),
            Arc::new(Float32Array::from(rows.iter().map(|r| r.pm_dec_masyr).collect::<Vec<_>>())),
            Arc::new(Float32Array::from(rows.iter().map(|r| r.g_mag).collect::<Vec<_>>())),
            Arc::new(Float32Array::from(rows.iter().map(|r| r.bp_rp).collect::<Vec<_>>())),
            Arc::new(UInt64Array::from(rows.iter().map(|r| r.source_id).collect::<Vec<_>>())),
        ],
    )
    .map_err(|e| format!("arrow batch build failed: {e}"))?;
    Ok((schema, batch))
}

/// Canonical single-key cell metadata value (deviation note above): the six
/// §3.2 logical fields, key-sorted, `;`-joined. Deterministic by construction.
pub fn cell_metadata_value(
    release: &str,
    format_version: u32,
    tier: &str,
    healpix_order: Option<u8>,
    cell: Option<u64>,
) -> String {
    format!(
        "cell={};epoch=J2016.0;format_version={};healpix_order={};release={};tier={}",
        cell.map(|c| c.to_string()).unwrap_or_default(),
        format_version,
        healpix_order.map(|o| o.to_string()).unwrap_or_default(),
        release,
        tier
    )
}

/// Encode one cell (or the T0 all-sky blob) as Arrow IPC FILE bytes.
/// `rows` MUST already be in release order (`sort_rows`).
pub fn write_cell_file(rows: &[StarRow], metadata_value: &str) -> Result<Vec<u8>, String> {
    debug_assert!(
        rows.windows(2).all(|w| {
            w[0].g_mag < w[1].g_mag
                || (w[0].g_mag == w[1].g_mag && w[0].source_id <= w[1].source_id)
        }),
        "rows must be pre-sorted g_mag asc, source_id asc"
    );
    let mut md = HashMap::new();
    md.insert("skycruncher".to_string(), metadata_value.to_string());
    let (schema, batch) = build_batch(rows, md)?;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = FileWriter::try_new_with_options(&mut buf, &schema, write_options())
            .map_err(|e| format!("arrow file writer init failed: {e}"))?;
        writer.write(&batch).map_err(|e| format!("arrow file write failed: {e}"))?;
        writer.finish().map_err(|e| format!("arrow file finish failed: {e}"))?;
    }
    Ok(buf)
}

fn validate_schema(schema: &Schema, label: &str) -> Result<(), String> {
    let expected = schema_fields();
    if schema.fields().len() != expected.len() {
        return Err(format!(
            "E_CELL_CORRUPT:{label}: {} columns (expected {})",
            schema.fields().len(),
            expected.len()
        ));
    }
    for (got, want) in schema.fields().iter().zip(expected.iter()) {
        if got.name() != want.name() || got.data_type() != want.data_type() {
            return Err(format!(
                "E_CELL_CORRUPT:{label}: column {:?}:{:?} (expected {:?}:{:?})",
                got.name(),
                got.data_type(),
                want.name(),
                want.data_type()
            ));
        }
    }
    Ok(())
}

fn batch_to_rows(batch: &RecordBatch, label: &str) -> Result<Vec<StarRow>, String> {
    let err = |what: &str| format!("E_CELL_CORRUPT:{label}: {what}");
    for i in 0..batch.num_columns() {
        if batch.column(i).null_count() != 0 {
            return Err(err("null values present (spec §3.2: no validity buffers)"));
        }
    }
    let ra = batch.column(0).as_any().downcast_ref::<Float64Array>().ok_or_else(|| err("ra_deg not f64"))?;
    let dec = batch.column(1).as_any().downcast_ref::<Float64Array>().ok_or_else(|| err("dec_deg not f64"))?;
    let pm_ra = batch.column(2).as_any().downcast_ref::<Float32Array>().ok_or_else(|| err("pm_ra_masyr not f32"))?;
    let pm_dec = batch.column(3).as_any().downcast_ref::<Float32Array>().ok_or_else(|| err("pm_dec_masyr not f32"))?;
    let g_mag = batch.column(4).as_any().downcast_ref::<Float32Array>().ok_or_else(|| err("g_mag not f32"))?;
    let bp_rp = batch.column(5).as_any().downcast_ref::<Float32Array>().ok_or_else(|| err("bp_rp not f32"))?;
    let sid = batch.column(6).as_any().downcast_ref::<UInt64Array>().ok_or_else(|| err("source_id not u64"))?;
    let n = batch.num_rows();
    let mut rows = Vec::with_capacity(n);
    for i in 0..n {
        rows.push(StarRow {
            ra_deg: ra.value(i),
            dec_deg: dec.value(i),
            pm_ra_masyr: pm_ra.value(i),
            pm_dec_masyr: pm_dec.value(i),
            g_mag: g_mag.value(i),
            bp_rp: bp_rp.value(i),
            source_id: sid.value(i),
        });
    }
    Ok(rows)
}

/// Decode a cell FILE. `label` names the cell in E_CELL_CORRUPT diagnostics.
pub fn read_cell_file(bytes: &[u8], label: &str) -> Result<Vec<StarRow>, String> {
    if bytes.len() < 12 || &bytes[0..6] != ARROW_FILE_MAGIC {
        return Err(format!("E_CELL_CORRUPT:{label}: missing ARROW1 magic"));
    }
    let reader = FileReader::try_new(Cursor::new(bytes), None)
        .map_err(|e| format!("E_CELL_CORRUPT:{label}: {e}"))?;
    validate_schema(reader.schema().as_ref(), label)?;
    if reader.num_batches() != 1 {
        return Err(format!(
            "E_CELL_CORRUPT:{label}: {} record batches (spec §3.2: exactly one)",
            reader.num_batches()
        ));
    }
    let mut rows = Vec::new();
    for batch in reader {
        let batch = batch.map_err(|e| format!("E_CELL_CORRUPT:{label}: {e}"))?;
        rows.extend(batch_to_rows(&batch, label)?);
    }
    Ok(rows)
}

/// Provenance metadata stamped into every `query_catalog_v2` response (spec §5.2).
#[derive(Debug, Clone)]
pub struct ResponseMeta {
    pub release: String,
    /// Formatted with Rust's shortest-round-trip Display ("as passed").
    pub epoch_jd: f64,
    pub tier_depth: String,
    /// (token, sha256) pairs; token is `order:cell` for T1 cells (ascending)
    /// plus the literal `t0` token when the bootstrap blob served rows
    /// (documented deviation — spec ledger).
    pub cells_served: Vec<(String, String)>,
    /// None => not computable for this release => honest "--" (spec §1).
    pub cells_absent_release: Option<u32>,
    pub cells_absent_local: u32,
}

/// Encode a query response as Arrow IPC STREAM bytes (spec §5.2 FROZEN):
/// one record batch, positions already propagated, rows sorted g_mag/source_id.
pub fn write_response_stream(rows: &[StarRow], meta: &ResponseMeta) -> Result<Vec<u8>, String> {
    let mut md = HashMap::new();
    md.insert("skycruncher.release".to_string(), meta.release.clone());
    md.insert("skycruncher.epoch_jd".to_string(), format!("{}", meta.epoch_jd));
    md.insert("skycruncher.positions".to_string(), "propagated".to_string());
    md.insert("skycruncher.tier_depth".to_string(), meta.tier_depth.clone());
    md.insert(
        "skycruncher.cells_served".to_string(),
        meta.cells_served.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>().join(","),
    );
    md.insert(
        "skycruncher.cell_shas".to_string(),
        meta.cells_served.iter().map(|(_, s)| s.as_str()).collect::<Vec<_>>().join(","),
    );
    md.insert(
        "skycruncher.cells_absent_release".to_string(),
        meta.cells_absent_release.map(|n| n.to_string()).unwrap_or_else(|| "--".to_string()),
    );
    md.insert(
        "skycruncher.cells_absent_local".to_string(),
        meta.cells_absent_local.to_string(),
    );
    let (schema, batch) = build_batch(rows, md)?;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = StreamWriter::try_new_with_options(&mut buf, &schema, write_options())
            .map_err(|e| format!("arrow stream writer init failed: {e}"))?;
        writer.write(&batch).map_err(|e| format!("arrow stream write failed: {e}"))?;
        writer.finish().map_err(|e| format!("arrow stream finish failed: {e}"))?;
    }
    Ok(buf)
}

/// Test/diagnostic helper: decode a response stream back into rows + metadata.
pub fn read_response_stream(bytes: &[u8]) -> Result<(Vec<StarRow>, HashMap<String, String>), String> {
    let reader = StreamReader::try_new(Cursor::new(bytes), None)
        .map_err(|e| format!("stream decode failed: {e}"))?;
    let metadata = reader.schema().metadata().clone();
    validate_schema(reader.schema().as_ref(), "response")?;
    let mut rows = Vec::new();
    let mut batches = 0usize;
    for batch in reader {
        let batch = batch.map_err(|e| format!("stream decode failed: {e}"))?;
        rows.extend(batch_to_rows(&batch, "response")?);
        batches += 1;
    }
    if batches != 1 {
        return Err(format!("response has {batches} record batches (spec §5.2: exactly one)"));
    }
    Ok((rows, metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample_rows() -> Vec<StarRow> {
        let mut rows = vec![
            StarRow { ra_deg: 170.1, dec_deg: 12.9, pm_ra_masyr: -10.5, pm_dec_masyr: 3.25, g_mag: 9.5, bp_rp: 0.65, source_id: (2417u64 << 49) | 77 },
            StarRow { ra_deg: 170.0, dec_deg: 13.0, pm_ra_masyr: 1.0, pm_dec_masyr: -2.0, g_mag: 5.25, bp_rp: 1.5, source_id: (2417u64 << 49) | 3 },
            StarRow { ra_deg: 169.9, dec_deg: 12.7, pm_ra_masyr: 0.0, pm_dec_masyr: 0.0, g_mag: 5.25, bp_rp: -0.125, source_id: (2417u64 << 49) | 1 },
        ];
        sort_rows(&mut rows);
        rows
    }

    #[test]
    fn sort_is_gmag_then_source_id() {
        let rows = sample_rows();
        assert_eq!(rows[0].source_id, (2417u64 << 49) | 1); // 5.25 tie broken by sid
        assert_eq!(rows[1].source_id, (2417u64 << 49) | 3);
        assert!((rows[2].g_mag - 9.5).abs() < 1e-6);
    }

    #[test]
    fn cell_file_round_trip_and_magic() {
        let rows = sample_rows();
        let meta = cell_metadata_value("starplates-2026.07-gdr3", 1, "t1", Some(5), Some(2417));
        let bytes = write_cell_file(&rows, &meta).unwrap();
        assert_eq!(&bytes[0..6], ARROW_FILE_MAGIC);
        assert_eq!(&bytes[bytes.len() - 6..], ARROW_FILE_MAGIC); // file format = magic at both ends
        let back = read_cell_file(&bytes, "5:2417").unwrap();
        assert_eq!(back, rows); // exact f64/f32/u64 fidelity
    }

    #[test]
    fn cell_file_write_is_deterministic_in_process() {
        let rows = sample_rows();
        let meta = cell_metadata_value("starplates-2026.07-gdr3", 1, "t1", Some(5), Some(2417));
        let a = write_cell_file(&rows, &meta).unwrap();
        let b = write_cell_file(&rows, &meta).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn response_stream_layout_and_metadata() {
        let rows = sample_rows();
        let meta = ResponseMeta {
            release: "starplates-2026.07-gdr3".into(),
            epoch_jd: 2461234.5,
            tier_depth: "t1".into(),
            cells_served: vec![
                ("5:2417".into(), "ab".repeat(32)),
                ("t0".into(), "cd".repeat(32)),
            ],
            cells_absent_release: Some(3),
            cells_absent_local: 1,
        };
        let bytes = write_response_stream(&rows, &meta).unwrap();
        // Spec §5.2 byte layout: stream starts with the 0xFFFFFFFF continuation
        // marker and ends with the EOS marker [0xFFFFFFFF, 0x00000000].
        assert_eq!(&bytes[0..4], &[0xFF, 0xFF, 0xFF, 0xFF]);
        let tail = &bytes[bytes.len() - 8..];
        assert_eq!(tail, &[0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00]);

        let (back, md) = read_response_stream(&bytes).unwrap();
        assert_eq!(back, rows);
        assert_eq!(md["skycruncher.release"], "starplates-2026.07-gdr3");
        assert_eq!(md["skycruncher.epoch_jd"], "2461234.5");
        assert_eq!(md["skycruncher.positions"], "propagated");
        assert_eq!(md["skycruncher.tier_depth"], "t1");
        assert_eq!(md["skycruncher.cells_served"], format!("5:2417,t0"));
        assert_eq!(md["skycruncher.cell_shas"], format!("{},{}", "ab".repeat(32), "cd".repeat(32)));
        assert_eq!(md["skycruncher.cells_absent_release"], "3");
        assert_eq!(md["skycruncher.cells_absent_local"], "1");
    }

    #[test]
    fn empty_response_is_valid_single_batch() {
        let meta = ResponseMeta {
            release: "r".into(),
            epoch_jd: 2457388.5,
            tier_depth: "t0".into(),
            cells_served: vec![],
            cells_absent_release: None,
            cells_absent_local: 0,
        };
        let bytes = write_response_stream(&[], &meta).unwrap();
        let (rows, md) = read_response_stream(&bytes).unwrap();
        assert!(rows.is_empty());
        assert_eq!(md["skycruncher.cells_absent_release"], "--");
    }

    #[test]
    fn corrupt_magic_rejected() {
        let rows = sample_rows();
        let meta = cell_metadata_value("r", 1, "t1", Some(5), Some(2417));
        let mut bytes = write_cell_file(&rows, &meta).unwrap();
        bytes[0] ^= 0xFF;
        let err = read_cell_file(&bytes, "5:2417").unwrap_err();
        assert!(err.starts_with("E_CELL_CORRUPT:5:2417"), "{err}");
    }
}
