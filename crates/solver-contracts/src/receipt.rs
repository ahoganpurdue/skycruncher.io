//! SolveReceipt — audit §Required unified execution contract.
//! Split: `decision` (digested — everything that determines/states the scientific outcome)
//! vs `telemetry` (timings, cache state — excluded from the digest).
//! Output rules for byte-stable digests: no HashMap anywhere on this path (Vec/BTreeMap only),
//! canonical serde field order, one float formatter (serde_json's shortest-round-trip).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::SolveConfig;
use crate::request::RequestClass;
use crate::result::SolveResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildInfo {
    pub solver_core_version: String,
    pub quad_coder_version: String,
    pub verify_policy_version: String,
    /// Compile-time embedded (build.rs): what the binary was ACTUALLY built with.
    pub rustflags: String,
    pub opt_level: String,
    pub target: String,
    pub profile: String,
    /// Git commit of the source tree (stamped by the CLI at startup; UNVERIFIED if unavailable).
    pub git_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexProvenance {
    pub release_id: String,
    pub release_dir: String,
    pub format_version: u32,
    pub aggregate_md5: String,
    /// FULL | STAMP | SKIPPED_UNVERIFIED
    pub verify_mode: String,
    pub bands_present: u32,
    pub total_quads: u64,
    pub total_stars: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PerBandCounters {
    pub det_quads: u64,
    pub probes: u64,
    pub raw_hits: u64,
    pub proposals: u64,
    pub verified: u64,
    pub bailed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PerRungCounters {
    pub wall_ms: u64,
    pub pool_size: u32,
    pub det_quads: u64,
    pub probes: u64,
    pub proposals: u64,
    pub verified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SearchCounters {
    /// Keyed by band index (BTreeMap => deterministic order).
    pub per_band: BTreeMap<u32, PerBandCounters>,
    pub per_rung: BTreeMap<u32, PerRungCounters>,
    pub dedup_ring_skips: u64,
    pub cheap_gate_rejects: BTreeMap<String, u64>,
    /// WARN flag: >90% of probes in the two finest compatible bands (test1d signature).
    pub fine_band_concentration_warn: bool,
}

/// The digested section: determines + states the scientific outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptDecision {
    pub frame_id: String,
    /// SHA-256 of the raw detection input bytes.
    pub input_digest: String,
    /// Derived from request contents, never asserted.
    pub classification: RequestClass,
    pub resolved_config: SolveConfig,
    pub build: BuildInfo,
    pub index: IndexProvenance,
    pub result: SolveResult,
    pub prep: PrepCounters,
    pub search: SearchCounters,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PrepCounters {
    pub raw: u32,
    pub valid: u32,
    pub deduped: u32,
    pub pool: u32,
    /// Detections whose priority came from the peak arm (UNION policy telemetry).
    pub peak_arm_promoted: u32,
}

/// Outcome of one freeze (log-odds ≥ accept threshold). Telemetry-only — never digested.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FreezeOutcome {
    /// The accept chain (refine + independent rematch) confirmed — search stops.
    Confirmed,
    /// The accept chain rejected after refine — the search RESUMES; a later hit may re-freeze.
    RejectedAfterRefine,
}

/// One freeze event (Phase-0 cascade telemetry). A freeze fires whenever a proposal's
/// scan log-odds reaches the accept threshold; REJECTED_AFTER_REFINE resumes the search,
/// so this is a LIST, not a single field. `elapsed_ms` = runtime clock (since solve start)
/// at the freeze instant, BEFORE the accept chain runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreezeEvent {
    pub elapsed_ms: u64,
    pub outcome: FreezeOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReceiptTelemetry {
    pub runtime: String, // NATIVE_CLI
    pub started_utc: String,
    pub wall_ms: u64,
    pub stage_ms: BTreeMap<String, u64>,
    /// COLD | OS_WARM assessments per resource, best-effort.
    pub cache_state: BTreeMap<String, String>,
    pub prefetch_ms: u64,
    pub threads_used: u32,
    // ── Phase-0 cascade instrumentation (telemetry-only; NEVER enters the decision digest) ──
    /// Per-band coding/probe SWEEP wall (ms), keyed by band index. Timed around the per-band
    /// block sweep in the deferred flush. Sums (with the verify map) to ~search wall.
    #[serde(default)]
    pub per_band_probe_wall_ms: BTreeMap<u32, u64>,
    /// Per-band VERIFY wall (ms), keyed by band index. Timed PER-HIT around `on_hit` in the
    /// canonical drain loop (hits are quad-major sorted, not band-contiguous ⇒ per-hit keying
    /// is the only correct band attribution).
    #[serde(default)]
    pub per_band_verify_wall_ms: BTreeMap<u32, u64>,
    /// Every freeze, in order. Empty/absent on refusal paths.
    #[serde(default)]
    pub freeze_events: Vec<FreezeEvent>,
    /// Convenience: elapsed ms at the CONFIRMED freeze (pre-accept-chain). None if unsolved.
    #[serde(default)]
    pub confirmed_freeze_elapsed_ms: Option<u64>,
    /// Convenience: elapsed ms after the accept chain returned SOLVED (post refine + rematch).
    #[serde(default)]
    pub post_chain_confirmed_elapsed_ms: Option<u64>,
    /// Per-band counter snapshot at the CONFIRMED freeze (quadgen det_quads/probes/raw_hits
    /// captured flush-exact; proposals/verified/bailed captured at the confirming hit and
    /// frozen thereafter). Enables `post_accept = decision.search.per_band − at_accept`, per
    /// band — the Phase-0 kill inputs. None on refusal paths.
    #[serde(default)]
    pub at_accept_per_band: Option<BTreeMap<u32, PerBandCounters>>,
    /// Telemetry-overhead accounting: total `Instant` reads issued by the per-band wall
    /// timers (2 per non-empty band sweep + 2 per hit). Constructed overhead bound =
    /// timer_calls × measured per-call `Instant::now()` cost.
    #[serde(default)]
    pub timer_calls: u64,
    /// True when `SearchPolicy.abort_on_accept` engaged — the in-flight search was cut short
    /// at a CONFIRMED freeze rather than draining to rung/ladder end. Omitted (⇒ false) on
    /// every drain-all run. Telemetry-only; NEVER enters the decision digest.
    #[serde(default, skip_serializing_if = "is_false")]
    pub search_aborted_on_accept: bool,
    /// Runtime elapsed (ms, since solve start) at the instant the abort broke the search
    /// loops. None when the search was not aborted (flag off, or no confirmed freeze).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abort_elapsed_ms: Option<u64>,
}

/// `skip_serializing_if` predicate for a bool that defaults false (telemetry section).
fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolveReceipt {
    pub decision: ReceiptDecision,
    /// SHA-256 over the canonical serialization of `decision`.
    pub decision_digest: String,
    pub telemetry: ReceiptTelemetry,
}
