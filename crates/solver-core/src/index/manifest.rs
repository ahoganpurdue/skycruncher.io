//! Serde model of the g15u release `manifest.json` + loud-refuse structural validation.
//!
//! Ground truth (verified 2026-07-20 against the builder,
//! `rest-integration/tools/quadindex/build_quad_index.mjs` serializeIndex ~:790-853):
//!   - stars.arrow: ONE record batch, columns ra_deg:f64, dec_deg:f64, g_mag:f32, source_id:u64;
//!     rows sorted g-ascending ⇒ row index = brightness rank.
//!   - band_i.arrow: columns code0..3:f32, star0..3:u32, diam_deg:f32, code_key:i32; rows sorted
//!     by code_key asc; record batches of exactly `schema.batchRows` rows (last batch short).
//!   - `bands[i].batches[]` = {rowStart, rows, codeKeyMin, codeKeyMax}; key ranges may OVERLAP
//!     at batch boundaries (duplicate keys span batches) — global-row addressing is immune.
//!   - aggregate_md5 = md5 of sorted newline-joined "file:sha256" lines + trailing newline.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::IndexError;

/// Quantisation bin count contract (code_key = mixed-radix base-128 over 4 components).
pub const EXPECTED_NBINS: u32 = 128;
/// Number of scale bands in a g15u release.
pub const EXPECTED_BANDS: usize = 15;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    pub catalog: Option<String>,
    pub release: Option<String>,
    pub epoch: Option<String>,
    pub units: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    /// Documented star-column descriptor string.
    pub stars: String,
    /// Documented band-column descriptor string.
    pub band: String,
    pub ledger: Option<String>,
    pub ipc: Option<String>,
    pub compression: Option<String>,
    pub nbins: u32,
    #[serde(rename = "batchRows")]
    pub batch_rows: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarsBlob {
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
    pub rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchMeta {
    #[serde(rename = "rowStart")]
    pub row_start: u64,
    pub rows: u64,
    #[serde(rename = "codeKeyMin")]
    pub code_key_min: i32,
    #[serde(rename = "codeKeyMax")]
    pub code_key_max: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandBlob {
    pub index: u32,
    pub file: String,
    #[serde(rename = "loDeg")]
    pub lo_deg: f64,
    #[serde(rename = "hiDeg")]
    pub hi_deg: f64,
    #[serde(rename = "magLimit")]
    pub mag_limit: f64,
    #[serde(rename = "nQuads")]
    pub n_quads: u64,
    #[serde(default)]
    pub capped: bool,
    pub sha256: String,
    pub bytes: u64,
    pub batches: Vec<BatchMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Totals {
    pub quads: u64,
    pub stars: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub release: String,
    pub format_version: u32,
    pub writer: Option<String>,
    pub coder: Option<String>,
    pub source: Option<SourceInfo>,
    pub schema: SchemaInfo,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    pub edges: Vec<f64>,
    pub depths: Vec<f64>,
    pub stars: StarsBlob,
    pub bands: Vec<BandBlob>,
    pub totals: Totals,
    pub aggregate_md5: String,
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn safe_file_name(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

impl Manifest {
    pub fn load(path: &Path) -> Result<Manifest, IndexError> {
        let bytes = std::fs::read(path).map_err(|e| IndexError::Io {
            path: path.display().to_string(),
            source: e,
        })?;
        serde_json::from_slice(&bytes).map_err(|e| IndexError::ManifestParse {
            path: path.display().to_string(),
            msg: e.to_string(),
        })
    }

    /// Loud-refuse structural validation. Everything checked here is a *manifest-internal*
    /// invariant; Arrow-file conformance (actual schema/types/sort) is validated at mmap open.
    pub fn validate(&self) -> Result<(), IndexError> {
        let refuse = |msg: String| Err(IndexError::Validation(msg));

        if self.format_version != solver_contracts::INDEX_FORMAT_VERSION {
            return refuse(format!(
                "format_version {} != supported {}",
                self.format_version,
                solver_contracts::INDEX_FORMAT_VERSION
            ));
        }
        if self.bands.len() != EXPECTED_BANDS {
            return refuse(format!("expected {} bands, found {}", EXPECTED_BANDS, self.bands.len()));
        }
        if self.edges.len() != self.bands.len() + 1 {
            return refuse(format!(
                "edges len {} != bands+1 {}",
                self.edges.len(),
                self.bands.len() + 1
            ));
        }
        if self.depths.len() != self.bands.len() {
            return refuse(format!(
                "depths len {} != bands {}",
                self.depths.len(),
                self.bands.len()
            ));
        }
        if self.schema.nbins != EXPECTED_NBINS {
            return refuse(format!("schema.nbins {} != {}", self.schema.nbins, EXPECTED_NBINS));
        }
        if self.schema.batch_rows == 0 {
            return refuse("schema.batchRows must be >= 1".into());
        }
        // Documented column tokens (authoritative type check happens against the Arrow footer).
        for tok in ["ra_deg:f64", "dec_deg:f64", "g_mag:f32", "source_id:u64"] {
            if !self.schema.stars.contains(tok) {
                return refuse(format!(
                    "schema.stars descriptor missing '{tok}': {}",
                    self.schema.stars
                ));
            }
        }
        for tok in ["code0..3:f32", "star0..3:u32", "diam_deg:f32", "code_key:i32"] {
            if !self.schema.band.contains(tok) {
                return refuse(format!(
                    "schema.band descriptor missing '{tok}': {}",
                    self.schema.band
                ));
            }
        }
        if !safe_file_name(&self.stars.file) {
            return refuse(format!("unsafe stars file name '{}'", self.stars.file));
        }
        if self.stars.rows == 0 {
            return refuse("stars.rows == 0".into());
        }
        if !is_hex(&self.stars.sha256, 64) {
            return refuse(format!("stars.sha256 not 64-hex: '{}'", self.stars.sha256));
        }
        if !is_hex(&self.aggregate_md5, 32) {
            return refuse(format!("aggregate_md5 not 32-hex: '{}'", self.aggregate_md5));
        }

        let key_space: i64 = (self.schema.nbins as i64).pow(4);
        let mut quad_sum: u64 = 0;
        let mut byte_sum: u64 = self.stars.bytes;
        let mut names: Vec<&str> = vec![&self.stars.file];
        for (i, b) in self.bands.iter().enumerate() {
            if b.index as usize != i {
                return refuse(format!("band[{i}].index = {} (expected {i})", b.index));
            }
            if !safe_file_name(&b.file) {
                return refuse(format!("unsafe band file name '{}'", b.file));
            }
            names.push(&b.file);
            if !is_hex(&b.sha256, 64) {
                return refuse(format!("band[{i}].sha256 not 64-hex: '{}'", b.sha256));
            }
            if b.lo_deg != self.edges[i] || b.hi_deg != self.edges[i + 1] {
                return refuse(format!(
                    "band[{i}] annulus [{}, {}) != edges [{}, {})",
                    b.lo_deg,
                    b.hi_deg,
                    self.edges[i],
                    self.edges[i + 1]
                ));
            }
            if b.mag_limit != self.depths[i] {
                return refuse(format!(
                    "band[{i}].magLimit {} != depths[{i}] {}",
                    b.mag_limit, self.depths[i]
                ));
            }
            quad_sum += b.n_quads;
            byte_sum += b.bytes;

            // Batch layout: contiguous rowStart runs; every batch except the last exactly
            // batchRows; the builder emits an EMPTY batches[] for a 0-quad band (its Arrow
            // file still holds one 0-row record batch).
            if b.n_quads == 0 {
                if !b.batches.is_empty() {
                    return refuse(format!(
                        "band[{i}]: 0 quads but {} batch metas",
                        b.batches.len()
                    ));
                }
                continue;
            }
            if b.batches.is_empty() {
                return refuse(format!("band[{i}]: {} quads but no batch metas", b.n_quads));
            }
            let mut row_cursor: u64 = 0;
            for (j, m) in b.batches.iter().enumerate() {
                if m.row_start != row_cursor {
                    return refuse(format!(
                        "band[{i}] batch[{j}].rowStart {} != expected {}",
                        m.row_start, row_cursor
                    ));
                }
                let is_last = j == b.batches.len() - 1;
                if !is_last && m.rows != self.schema.batch_rows as u64 {
                    return refuse(format!(
                        "band[{i}] batch[{j}].rows {} != batchRows {} (non-last)",
                        m.rows, self.schema.batch_rows
                    ));
                }
                if m.rows == 0 || m.rows > self.schema.batch_rows as u64 {
                    return refuse(format!("band[{i}] batch[{j}].rows {} out of range", m.rows));
                }
                if m.code_key_min < 0
                    || m.code_key_max < m.code_key_min
                    || (m.code_key_max as i64) >= key_space
                {
                    return refuse(format!(
                        "band[{i}] batch[{j}] key range [{}, {}] outside [0, {})",
                        m.code_key_min, m.code_key_max, key_space
                    ));
                }
                if j > 0 && m.code_key_min < b.batches[j - 1].code_key_min {
                    return refuse(format!(
                        "band[{i}] batch[{j}].codeKeyMin {} < previous batch min {} (unsorted)",
                        m.code_key_min,
                        b.batches[j - 1].code_key_min
                    ));
                }
                row_cursor += m.rows;
            }
            if row_cursor != b.n_quads {
                return refuse(format!(
                    "band[{i}] batch rows sum {} != nQuads {}",
                    row_cursor, b.n_quads
                ));
            }
        }
        {
            let mut sorted = names.clone();
            sorted.sort_unstable();
            sorted.dedup();
            if sorted.len() != names.len() {
                return refuse("duplicate file names in manifest".into());
            }
        }
        if self.totals.quads != quad_sum {
            return refuse(format!("totals.quads {} != sum {}", self.totals.quads, quad_sum));
        }
        if self.totals.stars != self.stars.rows {
            return refuse(format!(
                "totals.stars {} != stars.rows {}",
                self.totals.stars, self.stars.rows
            ));
        }
        if self.totals.bytes != byte_sum {
            return refuse(format!("totals.bytes {} != sum {}", self.totals.bytes, byte_sum));
        }
        Ok(())
    }
}
