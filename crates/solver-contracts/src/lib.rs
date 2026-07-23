//! solver-contracts — pure data types for the greenfield solver core. No I/O.
//!
//! Versioning discipline (audit §Arrow contract): data-format, coder, verification-policy and
//! implementation versions are SEPARATE identifiers, all stamped into every receipt.

pub mod config;
pub mod coordinates;
pub mod receipt;
pub mod request;
pub mod result;

/// Implementation version of the solver core (bump on any behavior change).
pub const SOLVER_CORE_VERSION: &str = "0.1.0";
/// Quad-coder convention version. `g15u-anet-1`: coder.mjs buildQuadCodes semantics —
/// all-qualifying-pairs A/B, z=(p-A)/(B-A), fold (1-x,-y) iff cx+dx>1 strict, C/D swap iff
/// dx<cx strict, NO mirror canonicalization, f64 math / f32 storage, code_key from f64 code,
/// CODE_LO=-0.5 CODE_HI=1.5 nbins=128; catalog side gnomonic (degrees) about the 4-star
/// unit-vector mean.
pub const QUAD_CODER_VERSION: &str = "g15u-anet-1";
/// Verification policy version. `anet-rvsl-1`: real_verify_star_lists semantics per the TS
/// oracle (keep-vs-switch, RoR, sigma growth, prefix-max) + seed exclusion by input filtering.
pub const VERIFY_POLICY_VERSION: &str = "anet-rvsl-1";
/// Index data-format we consume (g15u manifest `format_version`).
pub const INDEX_FORMAT_VERSION: u32 = 1;
