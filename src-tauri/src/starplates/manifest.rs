//! `manifest.json` model + validation (spec §2.3).
//!
//! Only the fields the native provider consumes are typed strictly; `source`,
//! `schema` and `tiers` are carried as loose JSON (forward compatible — the
//! provider derives every number it reports from `blobs`, which is measured
//! data, never from the prose sections).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub release: String,
    pub format_version: u32,
    pub writer: String,
    pub source: serde_json::Value,
    pub schema: serde_json::Value,
    pub tiers: serde_json::Value,
    pub blobs: Vec<BlobEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BlobEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub tier: String,
    pub healpix_order: Option<u8>,
    pub cell: Option<u64>,
    pub rows: u64,
    pub mag_min: Option<f64>,
    pub mag_max: Option<f64>,
    pub source_epoch: Option<String>,
    pub coverage: Option<f64>,
    pub center_ra_deg: Option<f64>,
    pub center_dec_deg: Option<f64>,
    pub radius_deg: Option<f64>,
}

/// `pinned.json` (spec §6.2): the store's single mutable pointer.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PinnedRelease {
    pub release: String,
    pub manifest_sha256: String,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let m: Manifest = serde_json::from_slice(bytes)
            .map_err(|e| format!("E_MANIFEST_INVALID: json parse failed: {e}"))?;
        m.validate()?;
        Ok(m)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.release.trim().is_empty() {
            return Err("E_MANIFEST_INVALID: empty release id".into());
        }
        if self.format_version != 1 {
            return Err(format!(
                "E_MANIFEST_INVALID: format_version {} unsupported (expected 1)",
                self.format_version
            ));
        }
        let mut t0_count = 0usize;
        for b in &self.blobs {
            if !is_hex64(&b.sha256) {
                return Err(format!(
                    "E_MANIFEST_INVALID: blob {} sha256 is not 64 lowercase hex chars",
                    b.path
                ));
            }
            if b.path.contains("..") || b.path.starts_with('/') || b.path.contains('\\') || b.path.contains(':') {
                return Err(format!("E_MANIFEST_INVALID: blob path {:?} is not release-relative", b.path));
            }
            match b.tier.as_str() {
                "t0" => t0_count += 1,
                "t1" | "t2" => {
                    if b.healpix_order.is_none()
                        || b.cell.is_none()
                        || b.center_ra_deg.is_none()
                        || b.center_dec_deg.is_none()
                        || b.radius_deg.is_none()
                    {
                        return Err(format!(
                            "E_MANIFEST_INVALID: cell blob {} missing healpix_order/cell/center/radius (cone resolution needs the data-derived bounds, spec §2.3)",
                            b.path
                        ));
                    }
                    let order = b.healpix_order.unwrap();
                    if order > 12 {
                        return Err(format!("E_MANIFEST_INVALID: blob {} healpix_order {} out of range", b.path, order));
                    }
                    let cell = b.cell.unwrap();
                    if cell >= crate::starplates::geometry::npix(order) {
                        return Err(format!("E_MANIFEST_INVALID: blob {} cell {} exceeds npix(order {})", b.path, cell, order));
                    }
                }
                other => {
                    return Err(format!("E_MANIFEST_INVALID: blob {} has unknown tier {:?}", b.path, other));
                }
            }
        }
        if t0_count > 1 {
            return Err(format!("E_MANIFEST_INVALID: {t0_count} t0 blobs (expected at most one)"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_manifest_json(mutate: impl Fn(&mut serde_json::Value)) -> Vec<u8> {
        let mut v = serde_json::json!({
            "release": "starplates-2026.07-gdr3",
            "format_version": 1,
            "writer": "test",
            "source": {},
            "schema": {},
            "tiers": {},
            "blobs": [
                {
                    "path": "t0/allsky.arrow",
                    "sha256": "aa".repeat(32),
                    "bytes": 10,
                    "tier": "t0",
                    "healpix_order": null,
                    "cell": null,
                    "rows": 1,
                    "mag_min": 1.0,
                    "mag_max": 9.0,
                    "source_epoch": "J2016.0",
                    "coverage": 0.79,
                    "center_ra_deg": null,
                    "center_dec_deg": null,
                    "radius_deg": null
                },
                {
                    "path": "t1/c5-02417.arrow",
                    "sha256": "bb".repeat(32),
                    "bytes": 10,
                    "tier": "t1",
                    "healpix_order": 5,
                    "cell": 2417,
                    "rows": 2,
                    "mag_min": 4.0,
                    "mag_max": 12.5,
                    "source_epoch": "J2016.0",
                    "coverage": 1.0,
                    "center_ra_deg": 170.03,
                    "center_dec_deg": 12.44,
                    "radius_deg": 1.02
                }
            ]
        });
        mutate(&mut v);
        serde_json::to_vec(&v).unwrap()
    }

    #[test]
    fn valid_manifest_parses() {
        let m = Manifest::parse(&minimal_manifest_json(|_| {})).unwrap();
        assert_eq!(m.release, "starplates-2026.07-gdr3");
        assert_eq!(m.blobs.len(), 2);
    }

    #[test]
    fn rejects_bad_format_version() {
        let bytes = minimal_manifest_json(|v| v["format_version"] = 2.into());
        let err = Manifest::parse(&bytes).unwrap_err();
        assert!(err.starts_with("E_MANIFEST_INVALID"), "{err}");
    }

    #[test]
    fn rejects_bad_sha_and_path_escapes() {
        let bytes = minimal_manifest_json(|v| v["blobs"][0]["sha256"] = "XYZ".into());
        assert!(Manifest::parse(&bytes).unwrap_err().starts_with("E_MANIFEST_INVALID"));
        let bytes = minimal_manifest_json(|v| v["blobs"][1]["path"] = "../evil.arrow".into());
        assert!(Manifest::parse(&bytes).unwrap_err().starts_with("E_MANIFEST_INVALID"));
    }

    #[test]
    fn rejects_t1_blob_without_cone_bounds() {
        let bytes = minimal_manifest_json(|v| v["blobs"][1]["center_ra_deg"] = serde_json::Value::Null);
        let err = Manifest::parse(&bytes).unwrap_err();
        assert!(err.contains("cone resolution"), "{err}");
    }
}
