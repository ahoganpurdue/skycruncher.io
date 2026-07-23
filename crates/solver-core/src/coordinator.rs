//! coordinator — the immediate-verification control loop (M4b lane; audit §Immediate-
//! verification control flow):
//!
//!   prepare once (prep pool, star grid, prefix tables, warm every workspace)
//!   per rung: drain the quadgen candidate stream; per candidate in CANONICAL order:
//!     cheap gates → Kabsch pose → immediate seed-excluded verification
//!     log_odds ≥ log_accept ⇒ FREEZE search → σ-clipped TAN refine → INDEPENDENT
//!     rematch (fresh per-cell-uniform gather, fresh test list, seed still excluded)
//!     → SAME verifier, SAME thresholds → pass ⇒ SOLVED / fail ⇒ REJECTED_AFTER_REFINE,
//!     search resumes
//!   ladder exhaustion / budget → terminal state under the honesty rules (NO_MATCH legal
//!   only with per-band probe coverage; truncation is telemetry, never a veto).
//!
//! EXECUTION SHAPE: M4a's `QuadGen` pushes hits into a `CandidateSink` during
//! `next_rung`; this module IS that sink, so verification is immediate (per candidate,
//! not per rung). An accept freezes decision-making — subsequent `on_hit` calls return
//! instantly — but generation of the in-flight rung runs to completion (the sink API has
//! no abort channel; wasted generation is bounded and decision-neutral because
//! verification order is canonical either way). Cancellation granularity is therefore
//! per-candidate for verify work and per-rung for generation — recorded limitation.
//!
//! REFERENCE GATHERING (plan rev 2, Fable geometry F3): verify references are
//! PER-CELL-UNIFORM brightest, not global-brightest — a global-brightest cone gather
//! reproduces the §0 pool defect on the reference side. Implementation: one
//! brightness-ordered cone gather (oversampled ×`REF_GATHER_FACTOR`), project to px,
//! keep the frame rect + a small matchable margin, bucket into a 16×16 pixel-tile grid,
//! then round-robin the per-tile brightness lists (depth 0 across all tiles, depth 1, …)
//! up to `verify_ref_cap`. Deterministic; spatially uniform by construction. Residual
//! risk: an extremely skewed field can exhaust the oversampled gather before sparse
//! tiles fill — gather size + nonempty-tile count are recorded in telemetry.
//!
//! IN-LOOP EARLY STOP: candidate verifies run with `log_stop = log_accept` (a.net's
//! decisive-accept stop; prefix-max is monotone under continuation, so the trigger set
//! is identical to a full scan). The post-refine re-judge runs the FULL scan
//! (`log_stop = +∞`) — the shipped WCS's judge reports the complete match set.
//!
//! DIGEST DETERMINISM NOTE: contracts place `PerRungCounters.wall_ms` inside the
//! digested decision section. Wall time is not deterministic, so the DECISION copy
//! carries wall_ms = 0 and the real per-rung walls live in telemetry `stage_ms`
//! ("rung_<i>"). Flagged in the M4b report as a contracts wart (field placement).
//!
//! LAW 1: consumes COORDINATE-ledger geometry (hypo/refine/verify) over PIXEL-ledger
//! detections; this module itself owns control flow + receipts only. No env reads.

use std::collections::BTreeMap;
use std::time::Instant;

use sha2::{Digest, Sha256};
use solver_contracts::config::{BandOrder, SolveConfig};
use solver_contracts::coordinates::{SkyDeg, TanWcs};
use solver_contracts::receipt::{
    BuildInfo, FreezeEvent, FreezeOutcome, IndexProvenance, PerBandCounters, PerRungCounters,
    PrepCounters, ReceiptDecision, ReceiptTelemetry, SearchCounters, SolveReceipt,
};
use solver_contracts::request::SolveRequest;
use solver_contracts::result::{SolveResult, SolvedResult, TerminalState, VerifyStats};

use crate::hypo::{self, project_tan, DupRing, GateParams, GateReject, Pose};
use crate::index::QuadIndex;
use crate::prep::{self, PreparedFrame};
use crate::quadgen::{band_metas, BandMeta, CandidateHit, CandidateSink, PairGeom, QuadGen};
use crate::refine::{self, MatchExtractScratch, RefineParams, RefineScratch};
use crate::runtime::{RetirementCursor, SolveRuntime};
use crate::stars::{StarGrid, StarsView};
use crate::verify::{verify_with_seed_exclusion, VerifyOpts, VerifyTrace, VerifyWorkspace};

/// Ref-gather oversample factor over `verify_ref_cap` (per-cell-uniform selection pool).
pub const REF_GATHER_FACTOR: usize = 8;
/// Pixel-tile grid side for per-cell-uniform reference selection (256 tiles).
pub const REF_TILE_N: usize = 16;
/// Field-circle slack for reference gathering (plan: proposal field radius × 1.05).
pub const FIELD_RADIUS_SLACK: f64 = 1.05;

/// Everything computed once per request before the loop (allocation-free loop contract:
/// ALL variable-size state is built or capacity-warmed here or in `Engine::new`).
pub struct Prepared {
    pub frame: PreparedFrame,
    pub grid: StarGrid,
    pub band_metas: Vec<BandMeta>,
    /// Nonempty bands whose annulus intersects the frame's achievable separation range
    /// (PROVISIONAL rule — see `compatible_bands`); the NO_MATCH coverage denominator.
    pub compatible: Vec<u32>,
    /// Ladder schedule: (ladder rung index, rank_start, rank_end) per expected
    /// `next_rung` call (mirrors QuadGen's internal skip rules; asserted against reports).
    pub rung_schedule: Vec<(u32, u32, u32)>,
    /// Fixed verification test list: top `verify_test_cap` of the prepared pool, order
    /// preserved via strictly-descending synthetic brightness.
    pub tests: Vec<(f64, f64, f64)>,
    pub test_ids: Vec<u32>,
    pub w: f64,
    pub h: f64,
    pub prep_ms: u64,
    pub grid_ms: u64,
    pub prefix_ms: u64,
}

/// Compatible-band rule (PROVISIONAL, recorded for ratification): nonempty ∧
/// lo < (max diag-pair separation over the slacked scale window) ∧
/// hi > dedup_px·s_lo/slack (no two pool detections can sit closer than the dedup
/// radius, so no quad can be smaller than that at the minimum scale).
pub fn compatible_bands(metas: &[BandMeta], config: &SolveConfig, w: f64, h: f64) -> Vec<u32> {
    let p = &config.search;
    let s_lo = p.scale_lo_asec / 3600.0;
    let s_hi = p.scale_hi_asec / 3600.0;
    let diag = PairGeom::new(0.0, 0.0, (w - 1.0).max(1.0), (h - 1.0).max(1.0), w, h);
    let (_, max_sep) = diag.sep_range_deg(s_lo, s_hi);
    let max_sep = max_sep * p.band_slack;
    let min_sep = p.dedup_px * s_lo / p.band_slack;
    metas
        .iter()
        .filter(|b| b.n_quads > 0 && b.lo_deg < max_sep && b.hi_deg > min_sep)
        .map(|b| b.index)
        .collect()
}

/// Simulate QuadGen's rung advance (rank boundaries + skip-covered-rungs rule) so the
/// engine knows the ladder rung DURING a rung's hits (reports arrive after).
fn rung_schedule(pool: usize, config: &SolveConfig) -> Vec<(u32, u32, u32)> {
    let ladder = &config.search.rung_ladder;
    let mut out = Vec::new();
    let mut next_rank = 0usize;
    let mut idx = 0usize;
    loop {
        if next_rank >= pool {
            break;
        }
        let rank_end = if idx < ladder.len() {
            (ladder[idx] as usize).min(pool)
        } else if config.search.rung_final_all {
            pool
        } else {
            break;
        };
        if rank_end > next_rank {
            out.push((idx as u32, next_rank as u32, rank_end as u32));
            next_rank = rank_end;
        }
        idx += 1;
        if idx > ladder.len() {
            break;
        }
    }
    out
}

/// Prepare phase: prep pool → star grid → compatible bands → prefix tables → test list.
pub fn prepare(request: &SolveRequest, config: &SolveConfig, index: &mut QuadIndex) -> Prepared {
    let (w, h) = (request.width as f64, request.height as f64);

    let t = Instant::now();
    let frame = prep::prepare(&request.detections, request.width, request.height, &config.search);
    let prep_ms = t.elapsed().as_millis() as u64;

    let t = Instant::now();
    let grid = StarGrid::build(StarsView {
        ra_deg: &index.stars.ra,
        dec_deg: &index.stars.dec,
    });
    let grid_ms = t.elapsed().as_millis() as u64;

    let metas = band_metas(index);
    let compatible = compatible_bands(&metas, config, w, h);

    // Prefix tables for every nonempty band (safe superset of anything quadgen probes;
    // build = one linear key pass per band). The solve loop never builds one.
    let t = Instant::now();
    let nonempty: Vec<u32> = metas.iter().filter(|b| b.n_quads > 0).map(|b| b.index).collect();
    index
        .build_prefix_tables(&nonempty)
        .expect("prefix table build (band indices are from this index)");
    let prefix_ms = t.elapsed().as_millis() as u64;

    // Fixed test list: top-N of the prepared (uniformized) order; strictly-descending
    // synthetic brightness keeps the verifier's bright-first sort identical to pool order.
    let n_tests = frame.len().min(config.search.verify_test_cap as usize);
    let mut tests = Vec::with_capacity(n_tests);
    let mut test_ids = Vec::with_capacity(n_tests);
    for i in 0..n_tests {
        tests.push((frame.x[i], frame.y[i], (n_tests - i) as f64));
        test_ids.push(frame.det_id[i]);
    }

    let rung_schedule = rung_schedule(frame.len(), config);

    Prepared {
        band_metas: metas,
        compatible,
        rung_schedule,
        tests,
        test_ids,
        w,
        h,
        prep_ms,
        grid_ms,
        prefix_ms,
        frame,
        grid,
    }
}

/// Why the search stopped drawing candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    None,
    SearchDeadline,
    Cancelled,
}

/// The output of one engine run (receipt-ready; assembled into `SolveReceipt` by
/// `assemble_receipt` AFTER the terminal state — receipt strings never allocate inside
/// the loop window).
pub struct SolveRun {
    pub result: SolveResult,
    pub search: SearchCounters,
    pub prep: PrepCounters,
    /// (ladder rung index, wall ms) — telemetry copies of the zeroed decision field.
    pub rung_wall_ms: Vec<(u32, u64)>,
    pub search_ms: u64,
    pub rejected_after_refine: u64,
    /// In-tolerance hits drained unexamined after a stop (unsearched space; bars NO_MATCH).
    pub skipped_hits: u64,
    /// Last reference gather size + nonempty tiles (uniformity telemetry).
    pub last_gather: u32,
    pub last_gather_tiles: u32,
    // ── Phase-0 cascade telemetry (carried to ReceiptTelemetry; never digested) ──
    pub freeze_events: Vec<FreezeEvent>,
    pub confirmed_freeze_elapsed_ms: Option<u64>,
    pub post_chain_confirmed_elapsed_ms: Option<u64>,
    pub at_accept_per_band: Option<BTreeMap<u32, PerBandCounters>>,
    pub per_band_probe_wall_ms: BTreeMap<u32, u64>,
    pub per_band_verify_wall_ms: BTreeMap<u32, u64>,
    pub timer_calls: u64,
    /// SearchPolicy.abort_on_accept engaged and cut the in-flight rung short at the
    /// confirmed freeze (telemetry-only; digest-neutral).
    pub search_aborted_on_accept: bool,
    /// Runtime elapsed (ms) at the instant the abort broke the search loops. None unless
    /// the search was aborted.
    pub abort_elapsed_ms: Option<u64>,
}

/// ORACLE_ASSISTED layer-5 outcome (M4.5 desk-check `would_verify_at_pose`). NOT a
/// solving-surface type — pure telemetry of a would-verify probe at a diagnostic pose.
#[derive(Debug, Clone, Copy)]
pub struct WouldVerify {
    /// Prefix-max log-odds under the blind loop's own proposal opts (`opts_scan`, which
    /// early-stops at log_accept — so an ACCEPTing probe reports ~log_accept, not the full
    /// magnitude; the accept DECISION is identical to a full scan, prefix-max being monotone).
    pub log_odds: f64,
    /// log_odds ≥ log_accept — the blind loop would FREEZE here and enter the accept chain.
    pub accept: bool,
    /// The scan bailed (running odds < log_bail).
    pub bailed: bool,
    pub n_matched: u32,
    pub n_ref: u32,
    pub n_test: u32,
    /// Per-cell-uniform reference gather size + nonempty tiles at this pose (uniformity).
    pub gather: u32,
    pub tiles: u32,
}

/// The verification side of the loop — the `CandidateSink` the generator drives.
struct VerifyState<'a> {
    index: &'a QuadIndex,
    prepared: &'a Prepared,
    runtime: &'a SolveRuntime,
    gates: GateParams,
    opts_scan: VerifyOpts,
    opts_full: VerifyOpts,
    refine_params: RefineParams,
    log_accept: f64,
    ref_cap: usize,
    gather_cap: usize,
    ref_margin_px: f64,

    ring: DupRing,
    cursor: RetirementCursor,
    ws: VerifyWorkspace,
    ext: MatchExtractScratch,
    refine_scratch: RefineScratch,

    // gather scratch
    gather: Vec<u32>,
    cand_px: Vec<[f64; 2]>,
    cand_row: Vec<u32>,
    cand_tile: Vec<u16>,
    tile_count: Vec<u32>,
    tile_start: Vec<u32>,
    tile_slot: Vec<u32>,
    ref_px: Vec<[f64; 2]>,
    ref_rows: Vec<u32>,

    // accept-chain scratch
    match_rows: Vec<solver_contracts::result::MatchRow>,
    match_det_px: Vec<[f64; 2]>,
    match_sky: Vec<SkyDeg>,
    final_rows: Vec<solver_contracts::result::MatchRow>,

    // counters + state
    counters: SearchCounters,
    rung_now: u32,
    proposals_rung: u64,
    verified_rung: u64,
    stop: Stop,
    solved: Option<SolvedResult>,
    rejected_after_refine: u64,
    /// In-tolerance hits drained UNEXAMINED after a deadline/cancel stop OR over a tripped
    /// per-band hit budget — unsearched space; any nonzero value bars NO_MATCH (honesty
    /// rule; hit-density finding).
    skipped_hits: u64,
    /// Optional per-(rung, band) in-tolerance hit budget (SearchPolicy). None = uncapped —
    /// the whole budget path is dormant (untouched ⇒ digest-neutral).
    band_hit_budget: Option<u64>,
    /// In-tol hits admitted for verification per band in the CURRENT rung (budget
    /// accounting; band entries pre-inserted, values reset per rung, touched only when
    /// `band_hit_budget` is Some).
    rung_band_hits: BTreeMap<u32, u64>,
    last_gather: u32,
    last_gather_tiles: u32,
    // ── Phase-0 freeze telemetry (never affects the decision) ──
    /// Every freeze (log-odds ≥ accept), in order; REJECTED_AFTER_REFINE resumes the search.
    freeze_events: Vec<FreezeEvent>,
    /// Elapsed ms at the CONFIRMED freeze (pre accept-chain). Set once, on the confirming hit.
    confirmed_freeze_elapsed_ms: Option<u64>,
    /// Elapsed ms after the accept chain returned SOLVED (post refine + rematch).
    post_chain_confirmed_elapsed_ms: Option<u64>,
    /// Verify-side per-band counters (proposals/verified/bailed) captured at the confirmed
    /// freeze — merged with the quadgen flush-exact snapshot into `at_accept_per_band`.
    at_accept_verify_per_band: Option<BTreeMap<u32, PerBandCounters>>,
}

impl<'a> VerifyState<'a> {
    #[inline]
    fn det_px(&self, det_id: u32) -> [f64; 2] {
        let i = self
            .prepared
            .frame
            .pool_index_of(det_id)
            .expect("candidate det id must be in the prepared pool") as usize;
        [self.prepared.frame.x[i], self.prepared.frame.y[i]]
    }

    /// Angular field radius (deg) of the frame under a pose: max corner distance from
    /// CRVAL (crpix = frame center), exact for TAN (angle = atan(plane radius)).
    fn field_radius_deg(&self, wcs: &TanWcs) -> f64 {
        let (w, h) = (self.prepared.w, self.prepared.h);
        let corners = [[0.0, 0.0], [w, 0.0], [0.0, h], [w, h]];
        let mut max_t2 = 0.0f64;
        for c in corners {
            let dx = c[0] - wcs.crpix.x;
            let dy = c[1] - wcs.crpix.y;
            let tx = wcs.cd[0][0] * dx + wcs.cd[0][1] * dy;
            let ty = wcs.cd[1][0] * dx + wcs.cd[1][1] * dy;
            let t2 = tx * tx + ty * ty;
            if t2 > max_t2 {
                max_t2 = t2;
            }
        }
        (max_t2.sqrt() * crate::geom::D2R).atan() / crate::geom::D2R
    }

    /// Per-cell-uniform reference gather at a pose (module header). Fills
    /// `ref_px`/`ref_rows` (≤ ref_cap), parallel.
    fn gather_refs(&mut self, wcs: &TanWcs) {
        let (w, h) = (self.prepared.w, self.prepared.h);
        let radius = self.field_radius_deg(wcs) * FIELD_RADIUS_SLACK;
        let stars = StarsView {
            ra_deg: &self.index.stars.ra,
            dec_deg: &self.index.stars.dec,
        };
        self.prepared
            .grid
            .brightest_in_cone(stars, wcs.crval, radius, self.gather_cap, &mut self.gather);
        self.last_gather = self.gather.len() as u32;

        // project + frame(+margin) filter + tile assignment (brightness order preserved)
        self.cand_px.clear();
        self.cand_row.clear();
        self.cand_tile.clear();
        let m = self.ref_margin_px;
        for &row in &self.gather {
            let sky = SkyDeg {
                ra: stars.ra_deg[row as usize],
                dec: stars.dec_deg[row as usize],
            };
            let Some(p) = project_tan(wcs, sky) else { continue };
            if !(p.x >= -m && p.x < w + m && p.y >= -m && p.y < h + m) {
                continue;
            }
            let tx = ((p.x / w) * REF_TILE_N as f64).floor() as i64;
            let ty = ((p.y / h) * REF_TILE_N as f64).floor() as i64;
            let tx = tx.clamp(0, REF_TILE_N as i64 - 1) as usize;
            let ty = ty.clamp(0, REF_TILE_N as i64 - 1) as usize;
            self.cand_px.push([p.x, p.y]);
            self.cand_row.push(row);
            self.cand_tile.push((ty * REF_TILE_N + tx) as u16);
        }

        // CSR by tile (counting sort in brightness order ⇒ per-tile lists brightness-sorted)
        let ntiles = REF_TILE_N * REF_TILE_N;
        self.tile_count.iter_mut().for_each(|c| *c = 0);
        for &t in &self.cand_tile {
            self.tile_count[t as usize] += 1;
        }
        let mut acc = 0u32;
        for t in 0..ntiles {
            self.tile_start[t] = acc;
            acc += self.tile_count[t];
        }
        self.tile_start[ntiles] = acc;
        self.tile_slot.clear();
        self.tile_slot.resize(self.cand_tile.len(), 0);
        let mut fill: [u32; REF_TILE_N * REF_TILE_N] = [0; REF_TILE_N * REF_TILE_N];
        for (i, &t) in self.cand_tile.iter().enumerate() {
            let t = t as usize;
            self.tile_slot[(self.tile_start[t] + fill[t]) as usize] = i as u32;
            fill[t] += 1;
        }
        self.last_gather_tiles = self.tile_count.iter().take(ntiles).filter(|&&c| c > 0).count() as u32;

        // round-robin: depth 0 across tiles asc, depth 1, … until cap or exhausted
        self.ref_px.clear();
        self.ref_rows.clear();
        let mut depth = 0u32;
        'rr: loop {
            let mut any = false;
            for t in 0..ntiles {
                if depth < self.tile_count[t] {
                    any = true;
                    let idx = self.tile_slot[(self.tile_start[t] + depth) as usize] as usize;
                    self.ref_px.push(self.cand_px[idx]);
                    self.ref_rows.push(self.cand_row[idx]);
                    if self.ref_px.len() >= self.ref_cap {
                        break 'rr;
                    }
                }
            }
            if !any {
                break;
            }
            depth += 1;
        }
    }

    /// Seed indices of the 4 quad detections in the fixed test list (test list = pool
    /// prefix, so index == pool index when < cap; MAX = absent ⇒ nothing to remove).
    fn seed_test_indices(&self, det_ids: &[u32; 4]) -> [usize; 4] {
        let cap = self.prepared.tests.len();
        let mut out = [usize::MAX; 4];
        for (k, &id) in det_ids.iter().enumerate() {
            if let Some(i) = self.prepared.frame.pool_index_of(id) {
                if (i as usize) < cap {
                    out[k] = i as usize;
                }
            }
        }
        out
    }

    /// Seed indices of the 4 catalog star rows in the CURRENT ref list (MAX = absent).
    fn seed_ref_indices(&self, star_rows: &[u32; 4]) -> [usize; 4] {
        let mut out = [usize::MAX; 4];
        for (k, &sr) in star_rows.iter().enumerate() {
            if let Some(pos) = self.ref_rows.iter().position(|&r| r == sr) {
                out[k] = pos;
            }
        }
        out
    }

    /// The accept chain: extract matches → refine → independent rematch → re-judge.
    /// Returns the solved result if the refined pose passes the FINAL judge.
    fn accept_chain(
        &mut self,
        hit: &CandidateHit,
        pose: &Pose,
        star_rows: [u32; 4],
        det_a: [f64; 2],
        det_b: [f64; 2],
        seq: u64,
        accept_stats: &VerifyStats,
    ) -> Option<SolvedResult> {
        let (w, h) = (self.prepared.w, self.prepared.h);
        let seed_test = self.seed_test_indices(&hit.det_ids);
        let seed_ref = self.seed_ref_indices(&star_rows);

        // 1 — matches from the ACCEPT verify (trace replay on its exact inputs).
        let trace = self.ws.trace.take().expect("trace always-on");
        refine::extract_matches(
            &self.ref_px,
            &self.ref_rows,
            &self.prepared.tests,
            &self.prepared.test_ids,
            seed_ref,
            seed_test,
            det_a,
            det_b,
            w,
            h,
            &self.opts_scan,
            accept_stats,
            &trace,
            &mut self.ext,
            &mut self.match_rows,
        );
        self.ws.trace = Some(trace);

        // 2 — σ-clipped TAN refine over the accepted one-to-one matches.
        self.match_det_px.clear();
        self.match_sky.clear();
        for m in &self.match_rows {
            self.match_det_px.push(self.det_px(m.det_id));
            self.match_sky.push(SkyDeg {
                ra: self.index.stars.ra[m.star_row as usize],
                dec: self.index.stars.dec[m.star_row as usize],
            });
        }
        // borrow dance: det px lookup above needs &self, refine below needs the arrays
        let refined = refine::refine_tan(
            &pose.wcs,
            &self.match_det_px,
            &self.match_sky,
            &self.refine_params,
            &mut self.refine_scratch,
        );

        // 3 — INDEPENDENT rematch: fresh per-cell-uniform gather at the refined pose,
        //     same fixed test list, seed still excluded (same 4 det ids + 4 star rows),
        //     SAME verifier, SAME thresholds; full scan (the shipped WCS's judge).
        self.gather_refs(&refined.wcs);
        let seed_ref2 = self.seed_ref_indices(&star_rows);
        let final_stats = verify_with_seed_exclusion(
            &self.ref_px,
            seed_ref2,
            &self.prepared.tests,
            seed_test,
            det_a,
            det_b,
            w,
            h,
            &self.opts_full,
            &mut self.ws,
        );
        if !(final_stats.log_odds >= self.log_accept) {
            return None; // REJECTED_AFTER_REFINE — caller resumes the frozen search
        }

        // 4 — final match extraction (the re-judge's own trace/inputs).
        let trace = self.ws.trace.take().expect("trace always-on");
        refine::extract_matches(
            &self.ref_px,
            &self.ref_rows,
            &self.prepared.tests,
            &self.prepared.test_ids,
            seed_ref2,
            seed_test,
            det_a,
            det_b,
            w,
            h,
            &self.opts_full,
            &final_stats,
            &trace,
            &mut self.ext,
            &mut self.final_rows,
        );
        self.ws.trace = Some(trace);

        let wcs = refined.wcs;
        Some(SolvedResult {
            scale_arcsec_px: wcs.scale_arcsec_px(),
            parity_sign: wcs.parity_sign(),
            wcs,
            final_verify: final_stats,
            band: hit.band,
            rung: self.rung_now,
            hypothesis_seq: seq,
            matches: std::mem::take(&mut self.final_rows),
        })
    }

    #[inline]
    fn gate_reject(&mut self, r: GateReject) {
        *self
            .counters
            .cheap_gate_rejects
            .get_mut(r.counter_name())
            .expect("gate counter pre-inserted") += 1;
        if matches!(r, GateReject::RingIdentity | GateReject::RingPose) {
            self.counters.dedup_ring_skips += 1;
        }
    }
}

impl<'a> CandidateSink for VerifyState<'a> {
    #[inline]
    fn froze_confirmed(&self) -> bool {
        self.solved.is_some()
    }

    fn on_hit(&mut self, hit: &CandidateHit) {
        // frozen (solved): drain the in-flight rung cheaply (search decided — not skips).
        if self.solved.is_some() {
            return;
        }
        // stopped (deadline/cancel): every further eligible hit is UNSEARCHED SPACE —
        // counted, and NO_MATCH is barred while any such skip exists (honesty rule).
        if self.stop != Stop::None {
            self.skipped_hits += 1;
            return;
        }
        // bounded-loop cancellation/deadline contract.
        if self.runtime.is_cancelled() {
            self.stop = Stop::Cancelled;
            self.skipped_hits += 1;
            return;
        }
        if self.runtime.search_expired() {
            self.stop = Stop::SearchDeadline;
            self.skipped_hits += 1;
            return;
        }
        // Per-(rung, band) hit budget: beyond the cap this hit is UNSEARCHED SPACE — counted
        // exactly like a deadline skip (bars NO_MATCH). Dormant/digest-neutral when None.
        if let Some(budget) = self.band_hit_budget {
            let c = self
                .rung_band_hits
                .get_mut(&hit.band)
                .expect("band pre-inserted in budget map");
            if *c >= budget {
                self.skipped_hits += 1;
                return;
            }
            *c += 1;
        }

        let seq = self.cursor.next_seq();
        let (w, h) = (self.prepared.w, self.prepared.h);

        // Catalog row: star ROWS + stored diameter (one band-row read). Star COORDINATES
        // are fetched only after the pre-fit gates — the hit-density finding (M4a desk
        // check, ~46 chance hits/quad): abscale kills most chance hits from diam_deg +
        // det A/B alone, sparing 4 random-access star-table reads per killed hit.
        let row = self.index.band(hit.band).row(hit.cat_row);
        let star_rows = row.star;
        let diam_deg = row.diam_deg as f64;
        let det_a_px = self.det_px(hit.det_ids[0]);
        let det_b_px = self.det_px(hit.det_ids[1]);

        let s_impl = match hypo::gate_prefit(
            det_a_px,
            det_b_px,
            diam_deg,
            hit.cat_row,
            hit.band,
            hit.parity,
            hit.s_sample,
            w,
            h,
            &self.gates,
            &self.ring,
        ) {
            Ok(s) => s,
            Err(r) => {
                self.gate_reject(r);
                self.cursor.retire(seq);
                return;
            }
        };

        // survivors only: fetch star coordinates + remaining det pixels, fit the pose.
        let cat_sky = [
            SkyDeg {
                ra: self.index.stars.ra[star_rows[0] as usize],
                dec: self.index.stars.dec[star_rows[0] as usize],
            },
            SkyDeg {
                ra: self.index.stars.ra[star_rows[1] as usize],
                dec: self.index.stars.dec[star_rows[1] as usize],
            },
            SkyDeg {
                ra: self.index.stars.ra[star_rows[2] as usize],
                dec: self.index.stars.dec[star_rows[2] as usize],
            },
            SkyDeg {
                ra: self.index.stars.ra[star_rows[3] as usize],
                dec: self.index.stars.dec[star_rows[3] as usize],
            },
        ];
        let det_px = [
            det_a_px,
            det_b_px,
            self.det_px(hit.det_ids[2]),
            self.det_px(hit.det_ids[3]),
        ];
        let pose = match hypo::gate_fit(
            &det_px,
            &cat_sky,
            diam_deg,
            s_impl,
            hit.parity,
            w,
            h,
            &self.gates,
            &self.ring,
        ) {
            Ok(p) => p,
            Err(r) => {
                self.gate_reject(r);
                self.cursor.retire(seq);
                return;
            }
        };

        let band_ctr = self
            .counters
            .per_band
            .get_mut(&hit.band)
            .expect("band counters pre-inserted");
        band_ctr.proposals += 1;
        self.proposals_rung += 1;

        // immediate seed-excluded verification at the proposal pose.
        self.gather_refs(&pose.wcs);
        let seed_ref = self.seed_ref_indices(&star_rows);
        let seed_test = self.seed_test_indices(&hit.det_ids);
        let det_a = det_px[0];
        let det_b = det_px[1];
        let stats = verify_with_seed_exclusion(
            &self.ref_px,
            seed_ref,
            &self.prepared.tests,
            seed_test,
            det_a,
            det_b,
            w,
            h,
            &self.opts_scan,
            &mut self.ws,
        );
        let band_ctr = self
            .counters
            .per_band
            .get_mut(&hit.band)
            .expect("band counters pre-inserted");
        band_ctr.verified += 1;
        self.verified_rung += 1;
        if stats.bailed_at >= 0 {
            band_ctr.bailed += 1;
        }
        self.ring.push(hit.cat_row, hit.band, &pose);

        if stats.log_odds >= self.log_accept {
            // FREEZE: no further candidate is examined unless the chain rejects.
            // Phase-0 telemetry: elapsed at the freeze instant (BEFORE the accept chain runs).
            let freeze_elapsed = self.runtime.wall_ms();
            match self.accept_chain(hit, &pose, star_rows, det_a, det_b, seq, &stats) {
                Some(solved) => {
                    // Verify-side per-band snapshot at the confirming hit (proposals/verified/
                    // bailed already incremented above; the accept chain does not touch them).
                    self.at_accept_verify_per_band = Some(self.counters.per_band.clone());
                    self.confirmed_freeze_elapsed_ms = Some(freeze_elapsed);
                    self.post_chain_confirmed_elapsed_ms = Some(self.runtime.wall_ms());
                    self.freeze_events.push(FreezeEvent {
                        elapsed_ms: freeze_elapsed,
                        outcome: FreezeOutcome::Confirmed,
                    });
                    self.solved = Some(solved);
                }
                None => {
                    self.freeze_events.push(FreezeEvent {
                        elapsed_ms: freeze_elapsed,
                        outcome: FreezeOutcome::RejectedAfterRefine,
                    });
                    self.rejected_after_refine += 1; // search resumes (frozen flag never set)
                }
            }
        }
        self.cursor.retire(seq);
    }
}

/// The solve engine: generator + verification sink, two-phase (new = warm, run = loop).
pub struct Engine<'a> {
    qg: QuadGen<'a>,
    st: VerifyState<'a>,
    config: &'a SolveConfig,
    prepared: &'a Prepared,
}

impl<'a> Engine<'a> {
    /// Construct + WARM every workspace (the zero-alloc window starts after this).
    pub fn new(
        prepared: &'a Prepared,
        index: &'a QuadIndex,
        config: &'a SolveConfig,
        runtime: &'a SolveRuntime,
    ) -> Self {
        let qg = QuadGen::new(
            &prepared.frame,
            prepared.w as u32,
            prepared.h as u32,
            &config.search,
            prepared.band_metas.clone(),
        );

        let mut opts_scan = VerifyOpts::from(&config.evidence);
        opts_scan.log_stop = config.evidence.log_accept; // decisive-accept early stop
        let opts_full = VerifyOpts::from(&config.evidence); // log_stop = +inf (full judge)

        let ref_cap = config.search.verify_ref_cap as usize;
        let test_cap = prepared.tests.len();
        let gather_cap = ref_cap * REF_GATHER_FACTOR;
        let ntiles = REF_TILE_N * REF_TILE_N;

        let mut counters = SearchCounters::default();
        // Pre-insert EVERY map entry (BTreeMap/String inserts allocate — prepare-phase only).
        for b in &prepared.band_metas {
            counters.per_band.insert(b.index, PerBandCounters::default());
        }
        for &(rung, _, _) in &prepared.rung_schedule {
            counters.per_rung.insert(rung, PerRungCounters::default());
        }
        for g in GateReject::ALL {
            counters.cheap_gate_rejects.insert(g.counter_name().to_string(), 0);
        }

        // Budget accounting map: pre-insert every band (prepare-phase alloc) so the loop
        // path stays alloc-free even when the budget is engaged.
        let mut rung_band_hits: BTreeMap<u32, u64> = BTreeMap::new();
        for b in &prepared.band_metas {
            rung_band_hits.insert(b.index, 0);
        }

        let mut st = VerifyState {
            index,
            prepared,
            runtime,
            gates: GateParams::from_policy(&config.search, prepared.w, prepared.h),
            opts_scan,
            opts_full,
            refine_params: RefineParams::from(&config.evidence),
            log_accept: config.evidence.log_accept,
            ref_cap,
            gather_cap,
            ref_margin_px: 2.0 * config.evidence.verify_pix_sigma * config.evidence.max_match_sigma,
            ring: DupRing::new(config.search.dedup_ring as usize),
            cursor: RetirementCursor::new(),
            ws: VerifyWorkspace::new(),
            ext: MatchExtractScratch::new(),
            refine_scratch: RefineScratch::new(),
            gather: Vec::with_capacity(gather_cap),
            cand_px: Vec::with_capacity(gather_cap),
            cand_row: Vec::with_capacity(gather_cap),
            cand_tile: Vec::with_capacity(gather_cap),
            tile_count: vec![0u32; ntiles],
            tile_start: vec![0u32; ntiles + 1],
            tile_slot: Vec::with_capacity(gather_cap),
            ref_px: Vec::with_capacity(ref_cap),
            ref_rows: Vec::with_capacity(ref_cap),
            match_rows: Vec::with_capacity(test_cap.max(4)),
            match_det_px: Vec::with_capacity(test_cap.max(4)),
            match_sky: Vec::with_capacity(test_cap.max(4)),
            final_rows: Vec::with_capacity(test_cap.max(4)),
            counters,
            rung_now: 0,
            proposals_rung: 0,
            verified_rung: 0,
            stop: Stop::None,
            solved: None,
            rejected_after_refine: 0,
            skipped_hits: 0,
            band_hit_budget: config.search.per_rung_band_hit_budget,
            rung_band_hits,
            last_gather: 0,
            last_gather_tiles: 0,
            freeze_events: Vec::new(),
            confirmed_freeze_elapsed_ms: None,
            post_chain_confirmed_elapsed_ms: None,
            at_accept_verify_per_band: None,
        };

        // Workspace warmup: one synthetic verify at full caps with trace on — grows every
        // internal buffer (order/theta/ref_c/test_c/seed filters/trace) to steady-state
        // capacity so the loop window allocates nothing in the verify chain.
        st.ws.trace = Some(VerifyTrace::default());
        {
            let mut warm_refs = std::mem::take(&mut st.cand_px);
            warm_refs.clear();
            let mut warm_tests: Vec<(f64, f64, f64)> = Vec::with_capacity(test_cap.max(1));
            for i in 0..ref_cap {
                let fx = (i % 20) as f64 * prepared.w.max(20.0) / 20.0;
                let fy = (i / 20) as f64 * prepared.h.max(20.0) / 20.0;
                warm_refs.push([fx, fy]);
            }
            for i in 0..test_cap.max(1) {
                warm_tests.push((
                    (i % 17) as f64 * prepared.w.max(17.0) / 17.0,
                    (i / 17) as f64 * prepared.h.max(17.0) / 17.0,
                    (test_cap + 1 - i) as f64,
                ));
            }
            let _ = verify_with_seed_exclusion(
                &warm_refs,
                [usize::MAX; 4],
                &warm_tests,
                [usize::MAX; 4],
                [0.0, 0.0],
                [prepared.w.max(1.0), prepared.h.max(1.0)],
                prepared.w.max(1.0),
                prepared.h.max(1.0),
                &st.opts_full,
                &mut st.ws,
            );
            st.ext.warm(ref_cap, test_cap.max(1));
            st.refine_scratch.warm(test_cap.max(4));
            warm_refs.clear();
            st.cand_px = warm_refs;
        }

        Self {
            qg,
            st,
            config,
            prepared,
        }
    }

    /// ORACLE_ASSISTED layer-5 desk-check entry (M4.5 truth-family desk-check). Runs the
    /// EXACT per-candidate seeded verify chain the blind loop runs in `on_hit` — the PRIVATE
    /// per-cell-uniform `gather_refs`, the `seed_ref_indices`/`seed_test_indices` seed
    /// exclusion, and the ported `verify_with_seed_exclusion` under the SAME proposal opts
    /// (`opts_scan`, log_stop = log_accept) — at a diagnostic-supplied pose, and reports the
    /// outcome. This is a would-verify TELEMETRY probe: it does NOT freeze the search, mutate
    /// solve state, run the refine/rematch accept chain, or touch the dedup ring. The blind
    /// `solve` path (`run`/`on_hit`) NEVER routes through here — it has no caller in the
    /// solving surface (grep-checkable), so the M4b lane semantics are byte-unchanged.
    ///
    /// `det_ids` is the hit's code-canonical [A,B,C,D]; the a.net quad anchor is
    /// midpoint(det A, det B) with Q² = dist²(qc, A) — det A/B looked up from the prepared
    /// pool exactly as `on_hit` does. `star_rows` are the matched catalog rows (seed
    /// exclusion on the ref side). NO frozen bar — the returned odds/class are M5 risk
    /// telemetry only.
    ///
    /// FORBIDDEN alternative, rejected by construction: `debug_verify_cycle` uses dummy
    /// `[usize::MAX; 4]` seeds and a synthetic anchor — NO seed exclusion — so its odds would
    /// be an over-claim; this entry uses the hit's real 4 seeds on both lists.
    #[doc(hidden)]
    pub fn would_verify_at_pose(
        &mut self,
        wcs: &TanWcs,
        star_rows: &[u32; 4],
        det_ids: &[u32; 4],
    ) -> WouldVerify {
        let (w, h) = (self.prepared.w, self.prepared.h);
        let det_a = self.st.det_px(det_ids[0]);
        let det_b = self.st.det_px(det_ids[1]);
        self.st.gather_refs(wcs);
        let seed_ref = self.st.seed_ref_indices(star_rows);
        let seed_test = self.st.seed_test_indices(det_ids);
        let stats = verify_with_seed_exclusion(
            &self.st.ref_px,
            seed_ref,
            &self.prepared.tests,
            seed_test,
            det_a,
            det_b,
            w,
            h,
            &self.st.opts_scan,
            &mut self.st.ws,
        );
        WouldVerify {
            log_odds: stats.log_odds,
            accept: stats.log_odds >= self.st.log_accept,
            bailed: stats.bailed_at >= 0,
            n_matched: stats.n_matched,
            n_ref: stats.n_ref,
            n_test: stats.n_test,
            gather: self.st.last_gather,
            tiles: self.st.last_gather_tiles,
        }
    }

    /// Test-support (zero-alloc gate): one in-loop reference-gather + seed-excluded
    /// verify cycle at `wcs` — the exact per-candidate verification chain minus the
    /// candidate-specific seeds. Not part of the public solving surface.
    #[doc(hidden)]
    pub fn debug_verify_cycle(&mut self, wcs: &TanWcs) -> VerifyStats {
        self.st.gather_refs(wcs);
        let (w, h) = (self.prepared.w, self.prepared.h);
        verify_with_seed_exclusion(
            &self.st.ref_px,
            [usize::MAX; 4],
            &self.prepared.tests,
            [usize::MAX; 4],
            [w * 0.25, h * 0.25],
            [w * 0.75, h * 0.75],
            w,
            h,
            &self.st.opts_scan,
            &mut self.st.ws,
        )
    }

    /// The solve loop: rung-by-rung generation with immediate per-candidate verification.
    /// Returns after a terminal state; receipt assembly happens outside.
    pub fn run(&mut self) -> SolveRun {
        let t_search = Instant::now();
        let mut rung_wall: Vec<(u32, u64)> = Vec::with_capacity(self.prepared.rung_schedule.len());
        let mut ladder_exhausted = false;
        let mut call_idx = 0usize;
        // Phase-0 A/B telemetry: runtime elapsed at the instant abort-on-accept broke the
        // in-flight rung (captured once, right after the aborting `next_rung` returns).
        let mut abort_elapsed_ms: Option<u64> = None;

        // probe/raw/det_quads snapshots for per-rung deltas
        let mut probes_prev: u64 = 0;

        loop {
            if self.st.solved.is_some() || self.st.stop != Stop::None {
                break;
            }
            if self.st.runtime.is_cancelled() {
                self.st.stop = Stop::Cancelled;
                break;
            }
            if self.st.runtime.search_expired() {
                self.st.stop = Stop::SearchDeadline;
                break;
            }
            let Some(&(rung, _, rank_end)) = self.prepared.rung_schedule.get(call_idx) else {
                ladder_exhausted = true;
                break;
            };
            self.st.rung_now = rung;
            self.st.proposals_rung = 0;
            self.st.verified_rung = 0;
            if self.st.band_hit_budget.is_some() {
                for v in self.st.rung_band_hits.values_mut() {
                    *v = 0;
                }
            }

            let report = match self.qg.next_rung(Some(self.st.index), &mut self.st) {
                Some(r) => r,
                None => {
                    ladder_exhausted = true;
                    break;
                }
            };
            assert_eq!(
                report.rung_index as u32, rung,
                "rung schedule drift vs quadgen (schedule says {rung}, report {})",
                report.rung_index
            );
            if abort_elapsed_ms.is_none() && self.qg.aborted() {
                abort_elapsed_ms = Some(self.st.runtime.wall_ms());
            }

            // per-rung counters (decision copy: wall_ms = 0; real wall in telemetry)
            let probes_now: u64 = self.qg.counters().iter().map(|c| c.probes).sum();
            let rc = self
                .st
                .counters
                .per_rung
                .get_mut(&rung)
                .expect("rung counters pre-inserted");
            rc.wall_ms = 0;
            rc.pool_size = rank_end;
            rc.det_quads = report.quads_emitted;
            rc.probes = probes_now - probes_prev;
            rc.proposals = self.st.proposals_rung;
            rc.verified = self.st.verified_rung;
            probes_prev = probes_now;
            rung_wall.push((rung, report.wall_ms));

            call_idx += 1;
        }
        let search_ms = t_search.elapsed().as_millis() as u64;

        // fold generator band counters into the receipt counters
        for (bi, c) in self.qg.counters().iter().enumerate() {
            let e = self
                .st
                .counters
                .per_band
                .get_mut(&(bi as u32))
                .expect("band counters pre-inserted");
            e.det_quads = c.det_quads;
            e.probes = c.probes;
            e.raw_hits = c.raw_hits;
        }

        // fine-band concentration WARN: >90% of probes in the two finest compatible bands
        let total_probes: u64 = self
            .st
            .counters
            .per_band
            .values()
            .map(|c| c.probes)
            .sum();
        let mut finest: Vec<u32> = self.prepared.compatible.clone();
        finest.sort_unstable();
        let fine2: u64 = finest
            .iter()
            .take(2)
            .map(|b| self.st.counters.per_band[b].probes)
            .sum();
        self.st.counters.fine_band_concentration_warn =
            total_probes > 0 && (fine2 as f64) > 0.9 * (total_probes as f64);

        // terminal state under the honesty rules
        let solved = self.st.solved.take();
        let (state, truncated) = if solved.is_some() {
            (TerminalState::Solved, !ladder_exhausted)
        } else if self.st.stop == Stop::Cancelled {
            (TerminalState::Cancelled, true)
        } else if ladder_exhausted {
            let coverage_met = self.prepared.compatible.iter().all(|b| {
                self.st.counters.per_band[b].probes >= self.config.search.min_probes_per_band as u64
            });
            // NO_MATCH requires: full ladder + per-band probe coverage + ZERO in-tol hits
            // drained unexamined (skipped hits = eligible space left unsearched).
            if coverage_met && self.st.skipped_hits == 0 {
                (TerminalState::NoMatch, false)
            } else {
                // refuse to claim NO_MATCH over under-probed bands or skipped hits
                (TerminalState::BudgetExhausted, self.st.skipped_hits > 0)
            }
        } else {
            (TerminalState::BudgetExhausted, true)
        };

        // ── Phase-0 cascade telemetry harvest (all outside the digest) ──
        // Per-band walls (ns → ms, rounded). Band index == receipt band key.
        let mut per_band_probe_wall_ms: BTreeMap<u32, u64> = BTreeMap::new();
        let mut per_band_verify_wall_ms: BTreeMap<u32, u64> = BTreeMap::new();
        let (probe_ns, verify_ns) = (self.qg.probe_wall_ns(), self.qg.verify_wall_ns());
        for bi in 0..probe_ns.len() {
            per_band_probe_wall_ms.insert(bi as u32, (probe_ns[bi] + 500_000) / 1_000_000);
            per_band_verify_wall_ms.insert(bi as u32, (verify_ns[bi] + 500_000) / 1_000_000);
        }
        let timer_calls = self.qg.timer_calls();
        // at-accept per-band snapshot: verify-side (proposals/verified/bailed) captured at the
        // confirmed freeze, overlaid with the quadgen flush-exact det_quads/probes/raw_hits.
        let at_accept_per_band = self.st.at_accept_verify_per_band.take().map(|mut m| {
            if let Some(snap) = self.qg.at_accept_counters() {
                for (bi, c) in snap.iter().enumerate() {
                    let e = m.entry(bi as u32).or_default();
                    e.det_quads = c.det_quads;
                    e.probes = c.probes;
                    e.raw_hits = c.raw_hits;
                }
            }
            m
        });

        SolveRun {
            result: SolveResult {
                state,
                solved,
                search_truncated: truncated,
            },
            search: std::mem::take(&mut self.st.counters),
            prep: PrepCounters {
                raw: self.prepared.frame.counters.raw,
                valid: self.prepared.frame.counters.valid,
                deduped: self.prepared.frame.counters.deduped,
                pool: self.prepared.frame.counters.pool,
                peak_arm_promoted: self.prepared.frame.counters.peak_arm_promoted,
            },
            rung_wall_ms: rung_wall,
            search_ms,
            rejected_after_refine: self.st.rejected_after_refine,
            skipped_hits: self.st.skipped_hits,
            last_gather: self.st.last_gather,
            last_gather_tiles: self.st.last_gather_tiles,
            freeze_events: std::mem::take(&mut self.st.freeze_events),
            confirmed_freeze_elapsed_ms: self.st.confirmed_freeze_elapsed_ms,
            post_chain_confirmed_elapsed_ms: self.st.post_chain_confirmed_elapsed_ms,
            at_accept_per_band,
            per_band_probe_wall_ms,
            per_band_verify_wall_ms,
            timer_calls,
            search_aborted_on_accept: self.qg.aborted(),
            abort_elapsed_ms,
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// receipts
// ───────────────────────────────────────────────────────────────────────────

/// Index provenance for the receipt (from the opened release).
pub fn index_provenance(index: &QuadIndex) -> IndexProvenance {
    IndexProvenance {
        release_id: index.manifest.release.clone(),
        release_dir: index.dir.display().to_string(),
        format_version: index.manifest.format_version,
        aggregate_md5: index.manifest.aggregate_md5.clone(),
        verify_mode: index.verify.receipt_marker().to_string(),
        bands_present: index.manifest.bands.len() as u32,
        total_quads: index.manifest.totals.quads,
        total_stars: index.manifest.totals.stars,
    }
}

/// SHA-256 hex of arbitrary bytes (CLI input digests ride this too — the CLI crate
/// deliberately has no hashing dependency of its own).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// SHA-256 hex over the canonical serde_json serialization of the decision section
/// (struct-declaration field order; BTreeMap-only containers ⇒ byte-stable).
pub fn decision_digest(decision: &ReceiptDecision) -> String {
    let bytes = serde_json::to_vec(decision).expect("decision serialization");
    sha256_hex(&bytes)
}

/// Assemble the full receipt AFTER the terminal state (allocation-free loop contract:
/// nothing here runs inside the solve window).
#[allow(clippy::too_many_arguments)]
pub fn assemble_receipt(
    frame_id: &str,
    input_digest: &str,
    request: &SolveRequest,
    config: &SolveConfig,
    build: BuildInfo,
    index: &QuadIndex,
    prepared: &Prepared,
    run: SolveRun,
    started_utc: String,
    threads_used: u32,
) -> SolveReceipt {
    let decision = ReceiptDecision {
        frame_id: frame_id.to_string(),
        input_digest: input_digest.to_string(),
        classification: request.classification(),
        resolved_config: config.clone(),
        build,
        index: index_provenance(index),
        result: run.result,
        prep: run.prep,
        search: run.search,
    };
    let digest = decision_digest(&decision);

    let mut stage_ms: BTreeMap<String, u64> = BTreeMap::new();
    stage_ms.insert("prep".into(), prepared.prep_ms);
    stage_ms.insert("star_grid".into(), prepared.grid_ms);
    stage_ms.insert("prefix_tables".into(), prepared.prefix_ms);
    stage_ms.insert("search".into(), run.search_ms);
    for (rung, wall) in &run.rung_wall_ms {
        stage_ms.insert(format!("rung_{rung}"), *wall);
    }
    stage_ms.insert("index_verify".into(), index.open_stats.verify_ms);
    stage_ms.insert("index_parse".into(), index.open_stats.parse_ms);

    let mut cache_state: BTreeMap<String, String> = BTreeMap::new();
    cache_state.insert(
        "index_prefetch".into(),
        if index.open_stats.prefetch_ms > 1000 {
            "COLD".into()
        } else {
            "OS_WARM".into()
        },
    );
    cache_state.insert(
        "ref_gather_last".into(),
        format!(
            "{} rows / {} tiles",
            run.last_gather, run.last_gather_tiles
        ),
    );
    // Explicit, receipt-recorded hit-processing order policy (hit-density directive); this
    // string is telemetry (outside the digest) and reflects the run's actual policy.
    let budget_note = match config.search.per_rung_band_hit_budget {
        Some(b) => format!("; per-(rung,band) hit budget {b} (overflow ⇒ skipped_hits)"),
        None => String::new(),
    };
    let hit_order_policy = if config.search.band_major {
        // BAND-MAJOR: bands coded + verified coarse→fine, one band before any finer band is
        // coded — NEVER the band-inner immediate-per-hit ascending order.
        let abort_note = if config.search.abort_on_accept {
            "; finer bands past a confirmed accept are never coded (abort_on_accept)"
        } else {
            ""
        };
        format!(
            "band-major: bands descending (coarse→fine), each band coded+probed+verified in \
             quadgen-canonical (quad_seq[rung,rank,pair,subset], parity, sample, cat_row asc) \
             before any finer band is coded; per-band verification{abort_note}; deadline skips \
             counted (bars NO_MATCH){budget_note}"
        )
    } else {
        // The `band` key of the immediate per-hit order is the resolved SearchPolicy.band_order
        // (M4b open-item ① formalized).
        let band_key = match config.search.band_order {
            BandOrder::Ascending => "band asc",
            BandOrder::Descending => "band desc (coarse-first)",
            BandOrder::CheapestFirst => "band cheapest-first (fewest stored quads first)",
        };
        format!(
            "quadgen-canonical: (quad_seq[rung,rank,pair,subset], parity, {band_key}, sample, \
             cat_row asc); immediate per-hit verification; deadline skips counted (bars \
             NO_MATCH){budget_note}"
        )
    };
    cache_state.insert("hit_order_policy".into(), hit_order_policy);
    cache_state.insert("skipped_hits".into(), run.skipped_hits.to_string());

    let telemetry = ReceiptTelemetry {
        runtime: "NATIVE_CLI".into(),
        started_utc,
        wall_ms: prepared.prep_ms + prepared.grid_ms + prepared.prefix_ms + run.search_ms,
        stage_ms,
        cache_state,
        prefetch_ms: index.open_stats.prefetch_ms,
        threads_used,
        per_band_probe_wall_ms: run.per_band_probe_wall_ms,
        per_band_verify_wall_ms: run.per_band_verify_wall_ms,
        freeze_events: run.freeze_events,
        confirmed_freeze_elapsed_ms: run.confirmed_freeze_elapsed_ms,
        post_chain_confirmed_elapsed_ms: run.post_chain_confirmed_elapsed_ms,
        at_accept_per_band: run.at_accept_per_band,
        timer_calls: run.timer_calls,
        search_aborted_on_accept: run.search_aborted_on_accept,
        abort_elapsed_ms: run.abort_elapsed_ms,
    };

    SolveReceipt {
        decision,
        decision_digest: digest,
        telemetry,
    }
}
