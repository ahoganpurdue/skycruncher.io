//! Starplates native provider — versioned, content-addressed, HEALPix-partitioned
//! Arrow star-catalog store plus the `query_catalog_v2` binary protocol.
//!
//! Authoritative contract: `docs/STARPLATES_SPEC.md`
//!   §2  release layout & manifest        -> `manifest`
//!   §3  cell byte format (FROZEN)        -> `arrow_io`
//!   §5  native protocol (FROZEN)         -> `query` + `arrow_io`
//!   §6  local store, verify, self-heal   -> `store`
//!   §7  R2 sync (flag-gated, additive)   -> `sync`
//!
//! Nothing in this module is reachable unless the frontend explicitly invokes
//! the new commands (`starplates_init`, `query_catalog_v2`, `starplates_sync`,
//! `starplates_status`). This is now the sole native catalog path — the legacy
//! `init_catalog`/`query_catalog`/vanguard.bin reader was retired 2026-07-10.

pub mod arrow_io;
pub mod geometry;
pub mod manifest;
pub mod query;
pub mod store;
pub mod sync;

/// Gaia DR3 reference epoch J2016.0 (JD, TCB) — the constant the retired v1
/// vanguard.bin reader also used, per spec §5.3.
pub const GAIA_DR3_EPOCH_JD: f64 = 2457388.5;

/// Spec §5.1: `0 < radius_deg <= 16.0` (mirrors SECTOR_LOAD_MAX_RADIUS_DEG=16).
pub const MAX_QUERY_RADIUS_DEG: f64 = 16.0;

/// Spec §6.1: explicit store-dir override. Dev convention: `D:\AstroLogic\starplates`.
pub const STORE_ENV_OVERRIDE: &str = "SKYCRUNCHER_STARPLATES_DIR";

/// Sync base URL override (spec §7 leaves the public base URL to config; this
/// env var or the command's `base_url` argument supplies it — no silent default).
pub const SYNC_BASE_URL_ENV: &str = "SKYCRUNCHER_STARPLATES_BASE_URL";

/// Lowercase hex SHA-256 of a byte slice (manifest + CAS verification, spec §6.3).
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(out, "{:02x}", b);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_known_vector() {
        // NIST FIPS 180-4 test vector: sha256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Empty input
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
