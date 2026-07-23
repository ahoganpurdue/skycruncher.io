//! Terminal states and the solve result. Honest-or-absent: never a fabricated or
//! partially-verified result; truncation is telemetry, never a veto (audit P0-1).

use serde::{Deserialize, Serialize};

use crate::coordinates::TanWcs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalState {
    Solved,
    NoMatch,
    BudgetExhausted,
    Cancelled,
    IndexUnavailable,
    BackendFailed,
}

/// One-to-one correspondence row from the FINAL (post-refine, re-verified) match.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchRow {
    pub det_id: u32,
    /// Release-local star row (row index into stars.arrow).
    pub star_row: u32,
    pub residual_x: f64,
    pub residual_y: f64,
    pub log_lr: f64,
    pub test_order: u32,
}

/// Verification statistics of one verifier run (mirrors the TS oracle's result fields).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VerifyStats {
    /// Prefix-max signed log-odds (THE acceptance statistic).
    pub log_odds: f64,
    pub besti: i64,
    pub best_worst: f64,
    pub final_odds: f64,
    pub n_matched: u32,
    pub n_distractor: u32,
    pub n_conflict: u32,
    pub n_test: u32,
    pub n_ref: u32,
    pub eff_area: f64,
    pub bailed_at: i64,
    pub stopped_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolvedResult {
    /// The WCS that passed the FINAL judge (never the pre-refine pose).
    pub wcs: TanWcs,
    pub scale_arcsec_px: f64,
    pub parity_sign: i8,
    /// Final (post-refine, seed-excluded, independent-rematch) verification.
    pub final_verify: VerifyStats,
    /// Accepting hypothesis provenance.
    pub band: u32,
    pub rung: u32,
    pub hypothesis_seq: u64,
    pub matches: Vec<MatchRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolveResult {
    pub state: TerminalState,
    /// Present iff state == Solved.
    pub solved: Option<SolvedResult>,
    /// Search-completeness telemetry (NEVER a veto): true when eligible space was left
    /// unsearched at termination.
    pub search_truncated: bool,
}
