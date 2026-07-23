//! SolveConfig — ONE immutable, fully-resolved configuration constructed at the CLI boundary
//! and serialized verbatim into every receipt (audit P0-5). No env reads below this type.
//!
//! Three separated concerns (audit §Swappable module contracts):
//!   EvidencePolicy — likelihood model + acceptance thresholds (scientific semantics)
//!   SearchPolicy  — what to search, in what order, how deep
//!   ExecutionPlan — how to execute (threads, prefetch, verify mode); may NEVER alter semantics
//!
//! All defaults are PROVISIONAL (a.net-verbatim / TS-oracle-verbatim / M-1-frozen), owner
//! ratification table due with M6. Never tuned to make a test pass.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidencePolicy {
    /// Verify positional sigma in px (TS oracle default 3.0; a.net verify_pix analog).
    pub verify_pix_sigma: f64,
    /// Distractor fraction D (a.net distractor_ratio, 0.25).
    pub distractor: f64,
    /// Nearest-ref search radius in sigmas (5.0).
    pub max_match_sigma: f64,
    /// Sigma growth with distance from the quad anchor (a.net gamma).
    pub do_gamma: bool,
    /// Radius-of-relevance culling + effective area.
    pub do_ror: bool,
    /// Effective-area grid N (16 -> 16x16).
    pub eff_area_grid_n: u32,
    /// Bail threshold: ln(1e-100).
    pub log_bail: f64,
    /// Accept threshold on prefix-max log-odds: ln(1e9) (a.net odds_to_solve).
    pub log_accept: f64,
    /// Minimum one-to-one matches required to attempt the TAN refine.
    pub refine_min_matches: u32,
    /// Refine sigma-clip factor (3.0 * RMS) and max iterations.
    pub refine_clip_rms: f64,
    pub refine_max_iter: u32,
}

impl Default for EvidencePolicy {
    fn default() -> Self {
        Self {
            verify_pix_sigma: 3.0,
            distractor: 0.25,
            max_match_sigma: 5.0,
            do_gamma: true,
            do_ror: true,
            eff_area_grid_n: 16,
            log_bail: -230.258_509_299_404_57, // ln(1e-100)
            log_accept: 20.723_265_836_946_41, // ln(1e9)
            refine_min_matches: 6,
            refine_clip_rms: 3.0,
            refine_max_iter: 5,
        }
    }
}

/// Band sweep order within a det-quad's per-quad hypothesis stream (SEARCH POLICY, NOT a
/// calibrated gate). Reorders BOTH the lazy re-tangent coding sweep AND the `band`
/// component of the canonical hit-emission order; the outer ladder and the rest of the
/// (quad_seq, parity, …, sample, cat_row) contract are untouched. `Ascending` is the
/// M-1/M4b-frozen default and MUST serialize byte-identically to a receipt that predates
/// this field (drives the `skip_serializing_if` on the `band_order` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum BandOrder {
    /// Fine → coarse: band index 0, 1, 2, … (the frozen canonical stream).
    #[default]
    Ascending,
    /// Coarse → fine: band index n-1, …, 1, 0.
    Descending,
    /// Static per-release permutation, fewest stored quads first (a genuinely PRE-SCAN
    /// quantity read from the manifest; ties broken by band index ascending — deterministic).
    CheapestFirst,
}

impl BandOrder {
    /// True at the frozen default — the `skip_serializing_if` predicate that keeps an
    /// ascending receipt's `resolved_config.search` byte-identical to a pre-field receipt.
    pub fn is_ascending(&self) -> bool {
        matches!(self, BandOrder::Ascending)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPolicy {
    /// Blind scale window, arcsec/px (narrower via request priors => HINTED).
    pub scale_lo_asec: f64,
    pub scale_hi_asec: f64,
    /// 4-D code-space match tolerance (coder.mjs DEFAULT_CODE_TOL, manifest-conformant).
    pub code_tol: f64,
    /// Detection dedup radius, px (M-1 frozen).
    pub dedup_px: f64,
    /// Uniformize grid (cells x, cells y) (M-1 frozen 10x10).
    pub uniformize_grid: (u32, u32),
    /// Priority key: detection priority = min(rank_flux, peak_arm_weight * rank_peak) (M-1: UNION, weight 2).
    pub peak_arm_weight: u32,
    /// Rung ladder over uniformized ranks; None = all detections (M-1 frozen).
    pub rung_ladder: Vec<u32>,
    /// After the last listed rung, continue to the full pool if budget remains.
    pub rung_final_all: bool,
    /// Per-pair interior cap for quad generation (Fable review: 12, arrival order).
    pub interior_cap: u32,
    /// Band-annulus slack factor for sky-true admission (diam-vs-annulus near-ties + codetol only).
    pub band_slack: f64,
    /// Sensitivity threshold: re-tangent correction below this fraction of code_tol may reuse
    /// the shared flat code (efficiency; correctness-neutral superset probing).
    pub retangent_share_frac: f64,
    /// Coverage-gate: NO_MATCH is legal only if every nonempty compatible band got >= this many probes.
    pub min_probes_per_band: u32,
    /// Verify caps: reference stars gathered (per-cell uniform) and test detections.
    pub verify_ref_cap: u32,
    pub verify_test_cap: u32,
    /// Bounded near-duplicate proposal window.
    pub dedup_ring: u32,
    /// Wall-clock budget (ms) and the fraction reserved for verify/refine of an accepted candidate.
    pub budget_ms: u64,
    pub verify_reserve_frac: f64,
    /// Band sweep order (SEARCH POLICY). Default Ascending; OMITTED from the receipt at the
    /// default so ascending receipts stay byte-identical to pre-field receipts (digest law).
    #[serde(default, skip_serializing_if = "BandOrder::is_ascending")]
    pub band_order: BandOrder,
    /// Optional per-(rung, band) in-tolerance hit budget: after this many in-tol hits land
    /// in a band within one rung, further hits are counted UNSEARCHED (skipped_hits ⇒ bars
    /// NO_MATCH, honesty rule). None = uncapped (frozen default; omitted at the default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_rung_band_hit_budget: Option<u64>,
    /// Abort the in-flight search the instant an accept is CONFIRMED (froze_confirmed) —
    /// skip the remainder of the accepting rung's coding/probing/drain work (SEARCH POLICY,
    /// NOT a calibrated gate; the coordinator already stops calling `next_rung` once solved,
    /// so this only cuts the CURRENT rung's continuation). Default false = current drain-all
    /// behavior; omitted from the receipt at the default so flag-off receipts stay
    /// byte-identical to pre-field receipts (digest law).
    #[serde(default, skip_serializing_if = "is_false")]
    pub abort_on_accept: bool,
    /// Band-MAJOR search structure (SEARCH POLICY, NOT a calibrated gate): within each rung,
    /// enumerate the rung's det-quads ONCE, then code+probe+verify bands COARSE→FINE
    /// (descending band index) — a whole band drained before any finer band is coded — so a
    /// coarse-band accept lands BEFORE finer bands are ever coded (the owner's "true
    /// sequence"). Composed with `abort_on_accept`, finer bands past a confirmed accept are
    /// never coded. Default false = the deferred det-quad-major (band-inner) path; omitted
    /// from the receipt at the default so flag-off receipts stay byte-identical to pre-field
    /// receipts (digest law).
    #[serde(default, skip_serializing_if = "is_false")]
    pub band_major: bool,
}

/// `skip_serializing_if` predicate for a bool that defaults false — keeps the field OMITTED
/// from the receipt at the default so a flag-off `resolved_config` stays byte-identical to a
/// pre-field receipt (digest law; no bool-skip precedent existed in this file, so this is the
/// written helper the field's serde attr references rather than an improvised attr).
fn is_false(b: &bool) -> bool {
    !*b
}

impl Default for SearchPolicy {
    fn default() -> Self {
        Self {
            scale_lo_asec: 0.5,
            scale_hi_asec: 300.0,
            code_tol: 0.015,
            dedup_px: 4.0,
            uniformize_grid: (10, 10),
            peak_arm_weight: 2,
            rung_ladder: vec![100, 200, 400, 800, 1600, 3200],
            rung_final_all: true,
            interior_cap: 12,
            band_slack: 1.06,
            retangent_share_frac: 0.25,
            min_probes_per_band: 50,
            verify_ref_cap: 400,
            verify_test_cap: 400,
            dedup_ring: 64,
            budget_ms: 90_000,
            verify_reserve_frac: 0.15,
            band_order: BandOrder::Ascending,
            per_rung_band_hit_budget: None,
            abort_on_accept: false,
            band_major: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReleaseVerifyMode {
    /// Full sha256 of every file + aggregate md5.
    Full,
    /// Manifest re-hash + size/mtime stamp check (default warm path).
    Stamp,
    /// Skipped — receipt marked SKIPPED_UNVERIFIED (benchmark isolation only).
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    /// v0: 1. Parallelism may only change wall-clock, never decisions (retirement cursor).
    pub threads: u32,
    /// Sequential page-warm pass over mapped files at index open (HDD reality).
    pub prefetch: bool,
    pub release_verify: ReleaseVerifyMode,
}

impl Default for ExecutionPlan {
    fn default() -> Self {
        Self { threads: 1, prefetch: true, release_verify: ReleaseVerifyMode::Stamp }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SolveConfig {
    pub evidence: EvidencePolicy,
    pub search: SearchPolicy,
    pub execution: ExecutionPlan,
}
