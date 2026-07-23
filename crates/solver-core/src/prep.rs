//! Detection prep — the M-1 FROZEN pool policy (rev 2), exactly:
//! validity cull → UNION priority (min(rank_flux, weight·rank_peak)) → global dedup in
//! priority order (grid-accelerated, survivor-mapped) → 10×10 uniformize-ORDER (round-robin
//! passes), UNCAPPED — depth is the rung ladder's job, not a pool cap.
//!
//! Evidence: `test_results/greenfield_solver/M-1_desk_measurement.md` +
//! `frozen_prep_config.json` (saturation scrambles flux for G≲4 stars; `peak_value` carries
//! the brightness signal flux lost; UNION dominates FLUX/PEAK/PEAKBLOCK at every rung).
//!
//! RANK SEMANTICS (measured 2026-07-20, M4a build): ranks are PER-DETECTION (each detection
//! gets its own index in the flux-desc / peak-desc orderings). The M-1 policy *simulator*
//! keyed its rank maps by the source file's `id` field, which is NON-unique in the banked
//! CSM30799 detections (3,669 duplicated ids) — map-overwrite gave both twins the WORSE
//! twin's rank and depressed the frozen in-pool table (8/20/56 @100/200/400 bands≥10; the
//! clean per-detection semantics measure 13/64/168 on the same inputs, raw-id-keyed rerun
//! reproduces 8/20/56 exactly). The POLICY is unchanged; the table was artifact-depressed.
//! See tests/m4a_desk_check.rs gate (a) for the honest cross-check.
//!
//! Determinism: every ordering ends in (id asc, input-index asc). The Detection contract in
//! this program supplies UNIQUE ids (array index into the source detections list — the raw
//! file's `id` field is not unique and is NOT used as the contract id).
//!
//! LAW 1: PIXEL-ledger adjacent (detection bookkeeping only — no image ops, no coordinates).
//! No I/O, no env reads (grep-guard enforced).

use std::collections::HashMap;

use solver_contracts::config::SearchPolicy;
use solver_contracts::request::Detection;

/// Prep counters (receipt telemetry; every number MEASURED, never estimated).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PrepCounters {
    /// Detections offered.
    pub raw: u32,
    /// Survived the validity cull (finite x,y,flux; flux>0; in-frame).
    pub valid: u32,
    /// Dropped by the 4 px dedup (each has a survivor-map entry).
    pub deduped: u32,
    /// Final pool size (uncapped).
    pub pool: u32,
    /// Pool detections whose UNION priority came from the peak arm
    /// (weight·rank_peak < rank_flux, strict).
    pub peak_arm_promoted: u32,
}

/// One dedup suppression: `dropped_id` was suppressed by the already-kept `kept_id`
/// (first kept detection found within the dedup radius, deterministic grid scan order:
/// cell rows ascending, cells ascending, insertion order within a cell).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurvivorPair {
    pub dropped_id: u32,
    pub kept_id: u32,
}

/// The prepared frame: SoA in UNIFORMIZED order (`uni_rank[k] == k+1`; kept explicit so the
/// receipt can carry it without re-deriving), plus the dedup survivor mapping for
/// cross-referencing (truth-fixture members matched to a dropped detection resolve to the
/// kept survivor).
#[derive(Debug, Default)]
pub struct PreparedFrame {
    pub det_id: Vec<u32>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub flux: Vec<f64>,
    /// 1-based uniformized rank, in uniformized order (== index+1).
    pub uni_rank: Vec<u32>,
    pub counters: PrepCounters,
    pub survivors: Vec<SurvivorPair>,
    rank_by_id: HashMap<u32, u32>,
    survivor_by_id: HashMap<u32, u32>,
}

impl PreparedFrame {
    /// Pool position (0-based) of a KEPT detection id.
    #[inline]
    pub fn pool_index_of(&self, det_id: u32) -> Option<u32> {
        self.rank_by_id.get(&det_id).copied()
    }

    /// 1-based uniformized rank of a KEPT detection id.
    #[inline]
    pub fn rank_of(&self, det_id: u32) -> Option<u32> {
        self.pool_index_of(det_id).map(|i| i + 1)
    }

    /// Resolve a detection id through the dedup: kept ids map to themselves; dropped ids map
    /// to their survivor; ids that never entered the pool (invalid) resolve to None.
    #[inline]
    pub fn resolve_kept(&self, det_id: u32) -> Option<u32> {
        if self.rank_by_id.contains_key(&det_id) {
            Some(det_id)
        } else {
            self.survivor_by_id.get(&det_id).copied()
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.det_id.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.det_id.is_empty()
    }
}

/// Non-finite `peak_value` ranks last in the peak arm (validity only guards x/y/flux; a NaN
/// peak must not poison the descending sort into promoting junk).
#[inline]
fn peak_or_neg_inf(p: f64) -> f64 {
    if p.is_finite() {
        p
    } else {
        f64::NEG_INFINITY
    }
}

/// The M-1 frozen prep, exactly (see module docs). `w`/`h` in native pixels.
pub fn prepare(dets: &[Detection], w: u32, h: u32, policy: &SearchPolicy) -> PreparedFrame {
    let wf = w as f64;
    let hf = h as f64;

    // ── validity cull: finite x,y,flux; flux>0; in-frame; NO fwhm cull (frozen) ──
    let mut valid: Vec<u32> = Vec::with_capacity(dets.len());
    for (k, d) in dets.iter().enumerate() {
        if !(d.x.is_finite() && d.y.is_finite() && d.flux.is_finite()) {
            continue;
        }
        if !(d.flux > 0.0) {
            continue;
        }
        if !(d.x >= 0.0 && d.x < wf && d.y >= 0.0 && d.y < hf) {
            continue;
        }
        valid.push(k as u32);
    }

    // ── UNION priority: rank_flux (flux desc, id asc, idx asc) and rank_peak (peak desc,
    //    flux desc, id asc, idx asc); priority = min(rank_flux, weight·rank_peak) ──
    let mut by_flux = valid.clone();
    by_flux.sort_unstable_by(|&a, &b| {
        let (da, db) = (&dets[a as usize], &dets[b as usize]);
        db.flux
            .total_cmp(&da.flux)
            .then(da.id.cmp(&db.id))
            .then(a.cmp(&b))
    });
    let mut by_peak = valid.clone();
    by_peak.sort_unstable_by(|&a, &b| {
        let (da, db) = (&dets[a as usize], &dets[b as usize]);
        peak_or_neg_inf(db.peak_value)
            .total_cmp(&peak_or_neg_inf(da.peak_value))
            .then(db.flux.total_cmp(&da.flux))
            .then(da.id.cmp(&db.id))
            .then(a.cmp(&b))
    });
    // priority + peak-arm attribution, indexed by position in the ORIGINAL dets slice
    let mut priority: HashMap<u32, u64> = HashMap::with_capacity(valid.len());
    let mut from_peak: HashMap<u32, bool> = HashMap::with_capacity(valid.len());
    for (r, &k) in by_flux.iter().enumerate() {
        priority.insert(k, r as u64);
        from_peak.insert(k, false);
    }
    let weight = policy.peak_arm_weight as u64;
    for (r, &k) in by_peak.iter().enumerate() {
        let p = weight * r as u64;
        let e = priority.get_mut(&k).expect("valid idx present");
        if p < *e {
            *e = p;
            from_peak.insert(k, true);
        }
    }

    // priority order: (priority asc, id asc, idx asc)
    let mut ordered = valid.clone();
    ordered.sort_unstable_by(|&a, &b| {
        priority[&a]
            .cmp(&priority[&b])
            .then(dets[a as usize].id.cmp(&dets[b as usize].id))
            .then(a.cmp(&b))
    });

    // ── global dedup, strict < dedup_px², processed in priority order; survivor-mapped ──
    let dd = policy.dedup_px;
    let dd2 = dd * dd;
    let cs = (dd * 4.0).max(1.0); // cell ≥ radius so ±1-cell scan covers it (16 px at 4.0)
    let ncx = (wf / cs).ceil() as i64 + 1;
    let mut grid: HashMap<i64, Vec<u32>> = HashMap::new();
    let mut kept: Vec<u32> = Vec::with_capacity(ordered.len());
    let mut survivors: Vec<SurvivorPair> = Vec::new();
    let mut survivor_by_id: HashMap<u32, u32> = HashMap::new();
    for &k in &ordered {
        let d = &dets[k as usize];
        let cx = (d.x / cs).floor() as i64;
        let cy = (d.y / cs).floor() as i64;
        let mut suppressor: Option<u32> = None;
        'outer: for yy in (cy - 1)..=(cy + 1) {
            for xx in (cx - 1)..=(cx + 1) {
                let Some(list) = grid.get(&(xx + yy * ncx)) else { continue };
                for &e in list {
                    let de = &dets[e as usize];
                    let dx = de.x - d.x;
                    let dy = de.y - d.y;
                    if dx * dx + dy * dy < dd2 {
                        suppressor = Some(e);
                        break 'outer;
                    }
                }
            }
        }
        if let Some(s) = suppressor {
            survivors.push(SurvivorPair {
                dropped_id: d.id,
                kept_id: dets[s as usize].id,
            });
            survivor_by_id.insert(d.id, dets[s as usize].id);
            continue;
        }
        grid.entry(cx + cy * ncx).or_default().push(k);
        kept.push(k);
    }

    // ── uniformize-ORDER: grid cells, per-cell priority order, round-robin passes,
    //    within-pass priority order; UNCAPPED ──
    let (gx, gy) = policy.uniformize_grid;
    let (gx, gy) = (gx.max(1) as usize, gy.max(1) as usize);
    let mut cells: Vec<Vec<u32>> = vec![Vec::new(); gx * gy];
    for &k in &kept {
        let d = &dets[k as usize];
        let cx = (((d.x / wf) * gx as f64).floor() as usize).min(gx - 1);
        let cy = (((d.y / hf) * gy as f64).floor() as usize).min(gy - 1);
        cells[cy * gx + cx].push(k);
    }
    // per-cell lists inherit priority order from `kept` (already priority-sorted) — no
    // re-sort needed, but keep the comparator explicit for the round-robin pass sort below.
    let prio_cmp = |a: &u32, b: &u32| {
        priority[a]
            .cmp(&priority[b])
            .then(dets[*a as usize].id.cmp(&dets[*b as usize].id))
            .then(a.cmp(b))
    };
    let mut uniformized: Vec<u32> = Vec::with_capacity(kept.len());
    let mut pass: Vec<u32> = Vec::with_capacity(gx * gy);
    let mut depth = 0usize;
    loop {
        pass.clear();
        for c in &cells {
            if let Some(&k) = c.get(depth) {
                pass.push(k);
            }
        }
        if pass.is_empty() {
            break;
        }
        pass.sort_unstable_by(prio_cmp);
        uniformized.extend_from_slice(&pass);
        depth += 1;
    }

    // ── assemble SoA ──
    let n = uniformized.len();
    let mut out = PreparedFrame {
        det_id: Vec::with_capacity(n),
        x: Vec::with_capacity(n),
        y: Vec::with_capacity(n),
        flux: Vec::with_capacity(n),
        uni_rank: Vec::with_capacity(n),
        counters: PrepCounters {
            raw: dets.len() as u32,
            valid: valid.len() as u32,
            deduped: survivors.len() as u32,
            pool: n as u32,
            peak_arm_promoted: 0,
        },
        survivors,
        rank_by_id: HashMap::with_capacity(n),
        survivor_by_id,
    };
    let mut promoted = 0u32;
    for (pos, &k) in uniformized.iter().enumerate() {
        let d = &dets[k as usize];
        out.det_id.push(d.id);
        out.x.push(d.x);
        out.y.push(d.y);
        out.flux.push(d.flux);
        out.uni_rank.push(pos as u32 + 1);
        out.rank_by_id.insert(d.id, pos as u32);
        if from_peak[&k] {
            promoted += 1;
        }
    }
    out.counters.peak_arm_promoted = promoted;
    out
}
