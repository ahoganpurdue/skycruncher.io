//! deskcheck — ORACLE_ASSISTED truth-family desk-check (M4.5). OFF THE BLIND PATH.
//!
//! The ONE shared implementation of the CSM30799-class truth-family attrition walk, called
//! by BOTH `tests/m4a_desk_check.rs` (the frozen headline gate) and the `desk-check` CLI
//! subcommand. It cross-references the ORACLE-ASSISTED truth fixture
//! (`tests/fixtures/truth_csm30799.json`, built by `crates/conformance/truth_fixture_extract.mjs`
//! at the exact a.net pose) against the REAL BLIND pipeline (prep → quadgen → probe vs the
//! g15u release; NO oracle input enters the pipeline). It is a DIAGNOSTIC: the truth fixture
//! is oracle-derived, so nothing here is ever a solving-surface path.
//!
//! LAYERS (each an attrition class reported separately):
//!   1 PRESENT     all 4 members MATCHED to a valid detection, resolvable through the dedup
//!                 survivor map to distinct kept pool detections
//!   2a IN-POOL    all 4 kept dets have uniformized rank ≤ rung_max
//!   2b CODE-IN-TOL for each ENUMERATED set, the MIN 4-D f64 distance between the det-quad's
//!                 ACTUAL blind-path codings (the exact adaptive log-annulus samples quadgen
//!                 emitted, tapped via `CandidateSink::on_coded`) and the STORED truth catalog
//!                 code — surfaces bin-edge losses (in-tol but wrong key bucket) as their own
//!                 class, distinct from key-hit
//!   3 ENUMERATED  some emitted quad's det-id set equals the set's matched-det-id set
//!   4 KEY-HIT     a `CandidateHit`'s det-id set matches AND its cat_row's star set equals the
//!                 truth star set (cat_row resolved through the index)
//!   5 WOULD-VERIFY for each KEY-HIT, build the hypothesis exactly as the blind path would
//!                 (Kabsch pose at the hit's sampled scale + parity) and run the REAL seeded
//!                 verify chain at that pose (`coordinator::Engine::would_verify_at_pose`).
//!                 NO frozen bar — telemetry for M5 risk.
//!
//! DETECTION IDENTITY = ARRAY INDEX into the source detections[] (the raw `id` field has
//! 3,669 duplicates and is NEVER used as identity — the caller builds `Detection.id = i`).
//!
//! LAW 1: consumes the blind pipeline (COORDINATE + PIXEL ledgers) read-only. No I/O of its
//! own beyond what the caller supplies; no env reads (crate-wide grep-guard).

use std::collections::HashMap;
use std::time::Instant;

use solver_contracts::config::SolveConfig;
use solver_contracts::coordinates::SkyDeg;
use solver_contracts::request::{Detection, Priors, SolveRequest};

use crate::coordinator::{self, Engine, WouldVerify};
use crate::geom::D2R;
use crate::hypo::{self, DupRing, GateParams, GateReject};
use crate::index::QuadIndex;
use crate::prep::PrepCounters;
use crate::quadgen::{band_metas, sin2_field_angle, CandidateHit, CandidateSink, QuadGen};
use crate::runtime::SolveRuntime;

/// The classification every desk-check output is stamped with (never the blind path).
pub const CLASSIFICATION: &str = "ORACLE_ASSISTED";

// ───────────────────────────── truth fixture ─────────────────────────────

/// The subset of `truth_csm30799.json` the desk-check consumes.
pub struct TruthFixture {
    pub schema: String,
    pub frame: String,
    pub width: u32,
    pub height: u32,
    pub release: String,
    pub det_count_raw: u64,
    /// star row -> matched det ARRAY-INDEX id (`None` = ABSENT).
    pub member_det: HashMap<u32, Option<u32>>,
    /// (band, [4 star rows ascending]) truth sets, in fixture order.
    pub bands: Vec<(u32, Vec<[u32; 4]>)>,
}

impl TruthFixture {
    /// Parse the fixture JSON (value-based; no serde-derive dependency).
    pub fn parse(json: &str) -> Result<TruthFixture, String> {
        let v: serde_json::Value =
            serde_json::from_str(json).map_err(|e| format!("fixture JSON parse: {e}"))?;
        let u = |k: &str| v[k].as_u64().ok_or_else(|| format!("fixture missing u64 `{k}`"));
        let s = |k: &str| {
            v[k]
                .as_str()
                .map(|x| x.to_string())
                .ok_or_else(|| format!("fixture missing str `{k}`"))
        };
        let width = u("width")? as u32;
        let height = u("height")? as u32;

        let mut member_det: HashMap<u32, Option<u32>> = HashMap::new();
        for m in v["members"].as_array().ok_or("fixture missing members[]")? {
            let star = m["star"].as_u64().ok_or("member missing star")? as u32;
            let det = m["det"].as_i64().ok_or("member missing det")?;
            member_det.insert(star, (det >= 0).then_some(det as u32));
        }

        let mut bands: Vec<(u32, Vec<[u32; 4]>)> = Vec::new();
        for b in v["bands"].as_array().ok_or("fixture missing bands[]")? {
            let band = b["band"].as_u64().ok_or("band missing band")? as u32;
            let mut sets: Vec<[u32; 4]> = Vec::new();
            for s in b["sets"].as_array().ok_or("band missing sets[]")? {
                let arr = s.as_array().ok_or("set not an array")?;
                if arr.len() != 4 {
                    return Err(format!("set len {} != 4 in band {band}", arr.len()));
                }
                let stars: [u32; 4] = std::array::from_fn(|k| arr[k].as_u64().unwrap_or(0) as u32);
                sets.push(stars);
            }
            bands.push((band, sets));
        }

        Ok(TruthFixture {
            schema: s("schema")?,
            frame: s("frame")?,
            release: s("release")?,
            det_count_raw: u("det_count_raw")?,
            width,
            height,
            member_det,
            bands,
        })
    }
}

// ───────────────────────────── report structs ─────────────────────────────

/// Layer-5 (would-verify) outcome for one KEY-HIT truth set.
#[derive(Debug, Clone, Copy)]
pub enum Layer5 {
    /// The pose could not be built as the blind path would — the cheap gate that vetoed
    /// (abscale / FOV / rot-residual / fit-degenerate). Dedup-ring gates are disabled for
    /// this per-hit diagnostic (the ring is a search-pruning optimisation, not part of the
    /// pose), so only genuine geometry vetoes appear here.
    PoseRejected(&'static str),
    /// The real seeded verify chain ran at the pose.
    Verified(WouldVerify),
}

/// One truth 4-set walked through all five layers.
#[derive(Debug, Clone)]
pub struct SetRow {
    pub band: u32,
    pub stars: [u32; 4],
    /// Resolved kept det ids ascending — `None` if any member ABSENT / unresolvable /
    /// two members collapse to one detection (degenerate: can never be a 4-set).
    pub dets: Option<[u32; 4]>,
    /// Max uniformized rank over the 4 members (`None` iff `dets` is `None`).
    pub max_rank: Option<u32>,
    pub enumerated: bool,
    pub key_hit: bool,
    /// Layer 2b: MIN 4-D f64 distance from a blind-path coding of this det-quad (in this
    /// band) to the STORED truth catalog code, over every emitted (sample, parity).
    /// `None` = never coded in-band, or the truth quad has no stored row.
    pub min_code_dist: Option<f64>,
    /// Sample scale (deg/px) that achieved `min_code_dist`.
    pub min_code_sample_s: Option<f64>,
    /// Layer 2b field angle (deg) of the quad centroid at the min-code sample scale.
    pub field_angle_deg: Option<f64>,
    /// Layer 5 (populated only for key-hits).
    pub layer5: Option<Layer5>,
}

impl SetRow {
    /// Layer 1: all four members present + resolvable to a distinct 4-set.
    #[inline]
    pub fn present(&self) -> bool {
        self.dets.is_some()
    }
    /// Layer 2a: present AND all four kept dets ≤ the rung cap.
    #[inline]
    pub fn in_pool(&self, rung_max: u32) -> bool {
        self.max_rank.is_some_and(|r| r <= rung_max)
    }
    /// Layer 2b: coded within code_tol of the stored truth code somewhere on the ladder.
    #[inline]
    pub fn code_in_tol(&self, code_tol: f64) -> bool {
        self.min_code_dist.is_some_and(|d| d <= code_tol)
    }
    /// Layer 5: a key-hit whose pose actually verify-ACCEPTs.
    #[inline]
    pub fn would_verify_accept(&self) -> bool {
        matches!(self.layer5, Some(Layer5::Verified(w)) if w.accept)
    }
}

/// Per-band aggregate row of the attrition table.
#[derive(Debug, Clone, Copy, Default)]
pub struct BandAgg {
    pub band: u32,
    pub total: u32,
    pub present: u32,
    pub in_pool: u32,
    pub enumerated: u32,
    pub code_in_tol: u32,
    pub key_hit: u32,
    pub would_verify_accept: u32,
}

/// The full desk-check report.
#[derive(Debug, Clone)]
pub struct DeskReport {
    pub classification: &'static str,
    pub prep: PrepCounters,
    pub rung_max: u32,
    pub code_tol: f64,
    pub log_accept: f64,
    /// Every truth set, in fixture order.
    pub sets: Vec<SetRow>,
    /// (rank_end, wall_ms) per rung generated.
    pub rung_walls: Vec<(u32, u64)>,
    pub parity_hits: [u64; 2],
    pub prep_ms: u64,
    pub walk_ms: u64,
    pub layer5_ms: u64,
    /// Reference gather size / nonempty tiles from the last layer-5 probe (uniformity note).
    pub last_gather: u32,
    pub last_gather_tiles: u32,
}

impl DeskReport {
    /// Band ids present in the fixture, ascending.
    pub fn band_ids(&self) -> Vec<u32> {
        let mut v: Vec<u32> = self.sets.iter().map(|s| s.band).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// Aggregate one band's attrition counts (in-pool/enumerated/... measured only among
    /// in-pool sets, exactly as the frozen test's per-band table does).
    pub fn band_agg(&self, band: u32) -> BandAgg {
        let mut a = BandAgg { band, ..Default::default() };
        for s in self.sets.iter().filter(|s| s.band == band) {
            a.total += 1;
            if s.present() {
                a.present += 1;
            }
            if s.in_pool(self.rung_max) {
                a.in_pool += 1;
                if s.enumerated {
                    a.enumerated += 1;
                }
                if s.code_in_tol(self.code_tol) {
                    a.code_in_tol += 1;
                }
                if s.key_hit {
                    a.key_hit += 1;
                }
                if s.would_verify_accept() {
                    a.would_verify_accept += 1;
                }
            }
        }
        a
    }

    /// In-pool count for bands ≥ 10 at an arbitrary rung cap (gate (a): 13/64/168 @ 100/200/400).
    pub fn in_pool_ge10_at(&self, rung: u32) -> u32 {
        self.sets
            .iter()
            .filter(|s| s.band >= 10 && s.in_pool(rung))
            .count() as u32
    }

    /// bands ≥ 10 totals: (in-pool, enumerated, key-hit, would-verify-accept).
    pub fn ge10_totals(&self) -> (u32, u32, u32, u32) {
        let (mut ip, mut en, mut kh, mut wv) = (0u32, 0u32, 0u32, 0u32);
        for s in self.sets.iter().filter(|s| s.band >= 10 && s.in_pool(self.rung_max)) {
            ip += 1;
            if s.enumerated {
                en += 1;
            }
            if s.key_hit {
                kh += 1;
            }
            if s.would_verify_accept() {
                wv += 1;
            }
        }
        (ip, en, kh, wv)
    }

    /// Key-hit rate among ENUMERATED truth sets across all fixture bands (gate (c) vs the
    /// 0.341 legacy whole-frame ceiling).
    pub fn enumerated_keyhit_rate(&self) -> (u32, u32, f64) {
        let mut en = 0u32;
        let mut kh = 0u32;
        for s in self.sets.iter().filter(|s| s.in_pool(self.rung_max)) {
            if s.enumerated {
                en += 1;
            }
            if s.key_hit {
                kh += 1;
            }
        }
        let rate = if en > 0 { kh as f64 / en as f64 } else { 0.0 };
        (en, kh, rate)
    }
}

// ───────────────────────────── the walk ─────────────────────────────

/// The streaming sink for layers 2b/3/4. Records enumerated/key-hit per truth set, the min
/// blind-path code distance vs the stored truth code, and the first canonical key-hit
/// `CandidateHit` (the one the blind loop would encounter first — the layer-5 probe pose).
struct DeskSink<'a> {
    index: &'a QuadIndex,
    /// sorted kept-det 4-set -> truth set indices.
    by_detset: &'a HashMap<[u32; 4], Vec<usize>>,
    set_band: &'a [u32],
    set_stars: &'a [[u32; 4]],
    /// set index -> stored truth catalog code (only sets whose 4-star quad exists as a row).
    truth_code: &'a HashMap<usize, [f64; 4]>,
    enumerated: Vec<bool>,
    key_hit: Vec<bool>,
    first_keyhit: Vec<Option<CandidateHit>>,
    /// set index -> (min dist², sample scale at min).
    min_code: Vec<Option<(f64, f64)>>,
    parity_hits: [u64; 2],
}

impl<'a> CandidateSink for DeskSink<'a> {
    fn on_quad(&mut self, _seq: u64, ids: [u32; 4]) {
        let mut k = ids;
        k.sort_unstable();
        if let Some(list) = self.by_detset.get(&k) {
            for &si in list {
                self.enumerated[si] = true;
            }
        }
    }

    fn on_coded(
        &mut self,
        _seq: u64,
        det_ids: [u32; 4],
        band: u32,
        _parity: u8,
        _sample: u8,
        s: f64,
        code: &[f64; 4],
    ) {
        let mut k = det_ids;
        k.sort_unstable();
        let Some(list) = self.by_detset.get(&k) else { return };
        for &si in list {
            if self.set_band[si] != band {
                continue;
            }
            let Some(tc) = self.truth_code.get(&si) else { continue };
            let d0 = code[0] - tc[0];
            let d1 = code[1] - tc[1];
            let d2 = code[2] - tc[2];
            let d3 = code[3] - tc[3];
            let dist2 = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
            match self.min_code[si] {
                Some((best, _)) if best <= dist2 => {}
                _ => self.min_code[si] = Some((dist2, s)),
            }
        }
    }

    fn on_hit(&mut self, hit: &CandidateHit) {
        let mut k = hit.det_ids;
        k.sort_unstable();
        let Some(list) = self.by_detset.get(&k) else { return };
        let row = self.index.band(hit.band).row(hit.cat_row);
        let mut rs = row.star;
        rs.sort_unstable();
        let mut any = false;
        for &si in list {
            if self.set_stars[si] == rs {
                if !self.key_hit[si] {
                    self.first_keyhit[si] = Some(*hit);
                }
                self.key_hit[si] = true;
                any = true;
            }
        }
        if any {
            self.parity_hits[hit.parity as usize] += 1;
        }
    }
}

/// Scan bands 7-14 once, recording the STORED code (f32→f64) of every 4-star truth quad that
/// exists as a band row. Keyed by set index. O(total rows) time; O(truth sets) memory.
fn build_truth_code_map(
    index: &QuadIndex,
    set_band: &[u32],
    set_stars: &[[u32; 4]],
) -> HashMap<usize, [f64; 4]> {
    // (band, sorted stars) -> set index
    let mut want: HashMap<(u32, [u32; 4]), usize> = HashMap::with_capacity(set_stars.len());
    for (si, (&b, &ss)) in set_band.iter().zip(set_stars.iter()).enumerate() {
        want.insert((b, ss), si);
    }
    let mut out: HashMap<usize, [f64; 4]> = HashMap::with_capacity(set_stars.len());
    let mut bands: Vec<u32> = set_band.to_vec();
    bands.sort_unstable();
    bands.dedup();
    for b in bands {
        let band = index.band(b);
        for r in 0..band.n_quads {
            let row = band.row(r);
            let mut ss = row.star;
            ss.sort_unstable();
            if let Some(&si) = want.get(&(b, ss)) {
                out.entry(si).or_insert([
                    row.code[0] as f64,
                    row.code[1] as f64,
                    row.code[2] as f64,
                    row.code[3] as f64,
                ]);
            }
        }
    }
    out
}

/// Run the full ORACLE_ASSISTED desk-check (layers 1-5) against the banked frame. `index`
/// must be the opened g15u release; prefix tables + star grid are built here (via
/// `coordinator::prepare`, the blind path's own prepare). `rung_max` caps the ladder
/// (M4a/M4.5: 400 — bands ≥ 10 truth is fully in-pool @ 400).
pub fn run(
    dets: &[Detection],
    index: &mut QuadIndex,
    fixture: &TruthFixture,
    rung_max: u32,
) -> DeskReport {
    let config = SolveConfig::default();
    let (w, h) = (fixture.width, fixture.height);
    let code_tol = config.search.code_tol;
    let log_accept = config.evidence.log_accept;

    let request = SolveRequest {
        frame_id: fixture.frame.clone(),
        width: w,
        height: h,
        detections: dets.to_vec(),
        priors: Priors::default(),
    };

    // ── prep + star grid + prefix tables (the blind path's prepare) ──
    let t = Instant::now();
    let prepared = coordinator::prepare(&request, &config, index);
    let prep_ms = t.elapsed().as_millis() as u64;
    let prep_counters = prepared.frame.counters;
    let index: &QuadIndex = index; // reborrow immutable for the rest

    // ── resolve truth sets through the survivor map (identical to the frozen test) ──
    let mut set_band: Vec<u32> = Vec::new();
    let mut set_stars: Vec<[u32; 4]> = Vec::new();
    let mut set_dets: Vec<Option<[u32; 4]>> = Vec::new();
    let mut set_maxrank: Vec<Option<u32>> = Vec::new();
    for (band, sets) in &fixture.bands {
        for &stars in sets {
            let mut dets_r: [u32; 4] = [0; 4];
            let mut ok = true;
            let mut max_rank = 0u32;
            for k in 0..4 {
                let Some(&Some(d)) = fixture.member_det.get(&stars[k]) else {
                    ok = false;
                    break;
                };
                let Some(kept) = prepared.frame.resolve_kept(d) else {
                    ok = false;
                    break;
                };
                let Some(r) = prepared.frame.rank_of(kept) else {
                    ok = false;
                    break;
                };
                dets_r[k] = kept;
                max_rank = max_rank.max(r);
            }
            set_band.push(*band);
            set_stars.push(stars);
            if ok {
                dets_r.sort_unstable();
                let distinct = dets_r.windows(2).all(|p| p[0] != p[1]);
                set_dets.push(distinct.then_some(dets_r));
                set_maxrank.push(Some(max_rank));
            } else {
                set_dets.push(None);
                set_maxrank.push(None);
            }
        }
    }
    let n_sets = set_band.len();

    // ── stored truth codes (layer 2b reference) ──
    let truth_code = build_truth_code_map(index, &set_band, &set_stars);

    // ── detset -> set indices (distinct-det sets only) ──
    let mut by_detset: HashMap<[u32; 4], Vec<usize>> = HashMap::new();
    for (si, d) in set_dets.iter().enumerate() {
        if let Some(d) = d {
            by_detset.entry(*d).or_default().push(si);
        }
    }

    // ── the BLIND walk through rung ≤ rung_max (identical drive to the frozen test) ──
    let t = Instant::now();
    let mut sink = DeskSink {
        index,
        by_detset: &by_detset,
        set_band: &set_band,
        set_stars: &set_stars,
        truth_code: &truth_code,
        enumerated: vec![false; n_sets],
        key_hit: vec![false; n_sets],
        first_keyhit: vec![None; n_sets],
        min_code: vec![None; n_sets],
        parity_hits: [0, 0],
    };
    let bands = band_metas(index);
    let mut qg = QuadGen::new(&prepared.frame, w, h, &config.search, bands);
    let mut rung_walls: Vec<(u32, u64)> = Vec::new();
    while qg
        .next_rung(Some(index), &mut sink)
        .map(|r| {
            rung_walls.push((r.rank_end, r.wall_ms));
            r.rank_end
        })
        .is_some_and(|end| end < rung_max)
    {}
    let walk_ms = t.elapsed().as_millis() as u64;

    let enumerated = std::mem::take(&mut sink.enumerated);
    let key_hit = std::mem::take(&mut sink.key_hit);
    let first_keyhit = std::mem::take(&mut sink.first_keyhit);
    let min_code = std::mem::take(&mut sink.min_code);
    let parity_hits = sink.parity_hits;
    drop(sink);
    drop(qg);

    // ── assemble per-set rows (+ field angle from the min-code sample) ──
    let mut sets: Vec<SetRow> = Vec::with_capacity(n_sets);
    for i in 0..n_sets {
        let (min_code_dist, min_code_sample_s, field_angle_deg) = match min_code[i] {
            Some((dist2, s)) => {
                let fa = set_dets[i].and_then(|d| quad_field_angle_deg(&prepared, &d, s));
                (Some(dist2.sqrt()), Some(s), fa)
            }
            None => (None, None, None),
        };
        sets.push(SetRow {
            band: set_band[i],
            stars: set_stars[i],
            dets: set_dets[i],
            max_rank: set_maxrank[i],
            enumerated: enumerated[i],
            key_hit: key_hit[i],
            min_code_dist,
            min_code_sample_s,
            field_angle_deg,
            layer5: None,
        });
    }

    // ── LAYER 5: would-verify at the first canonical key-hit pose per key-hit set ──
    let t = Instant::now();
    let runtime = SolveRuntime::from_policy(&config.search);
    let mut engine = Engine::new(&prepared, index, &config, &runtime);
    let gates = GateParams::from_policy(&config.search, w as f64, h as f64);
    let mut last_gather = 0u32;
    let mut last_gather_tiles = 0u32;
    for i in 0..n_sets {
        if !key_hit[i] {
            continue;
        }
        let Some(hit) = first_keyhit[i] else { continue };
        let l5 = layer5_probe(&prepared, index, &mut engine, &gates, &hit);
        if let Layer5::Verified(w) = &l5 {
            last_gather = w.gather;
            last_gather_tiles = w.tiles;
        }
        sets[i].layer5 = Some(l5);
    }
    let layer5_ms = t.elapsed().as_millis() as u64;

    DeskReport {
        classification: CLASSIFICATION,
        prep: prep_counters,
        rung_max,
        code_tol,
        log_accept,
        sets,
        rung_walls,
        parity_hits,
        prep_ms,
        walk_ms,
        layer5_ms,
        last_gather,
        last_gather_tiles,
    }
}

/// Field angle (deg) of a det-quad's pixel centroid at scale `s` (deg/px): θ = asin√sin²θ,
/// with sin²θ from `sin2_field_angle` at |centroid − frame center|².
fn quad_field_angle_deg(prepared: &coordinator::Prepared, dets: &[u32; 4], s: f64) -> Option<f64> {
    let (w, h) = (prepared.w, prepared.h);
    let (mut cx, mut cy) = (0.0f64, 0.0f64);
    for &id in dets {
        let idx = prepared.frame.pool_index_of(id)? as usize;
        cx += prepared.frame.x[idx];
        cy += prepared.frame.y[idx];
    }
    cx /= 4.0;
    cy /= 4.0;
    let dx = cx - w * 0.5;
    let dy = cy - h * 0.5;
    let r2 = dx * dx + dy * dy;
    let sin2 = sin2_field_angle(r2, s);
    Some((sin2.clamp(0.0, 1.0)).sqrt().asin() / D2R)
}

/// Build the hypothesis exactly as the blind path would (gate_prefit → gate_fit, cheap gates
/// with the dedup ring DISABLED so only genuine geometry vetoes surface) and run the real
/// seeded verify chain at that pose.
fn layer5_probe(
    prepared: &coordinator::Prepared,
    index: &QuadIndex,
    engine: &mut Engine,
    gates: &GateParams,
    hit: &CandidateHit,
) -> Layer5 {
    let (w, h) = (prepared.w, prepared.h);
    let px = |id: u32| -> Option<[f64; 2]> {
        let i = prepared.frame.pool_index_of(id)? as usize;
        Some([prepared.frame.x[i], prepared.frame.y[i]])
    };
    let (Some(det_a), Some(det_b), Some(det_c), Some(det_d)) = (
        px(hit.det_ids[0]),
        px(hit.det_ids[1]),
        px(hit.det_ids[2]),
        px(hit.det_ids[3]),
    ) else {
        return Layer5::PoseRejected("det_absent");
    };

    let row = index.band(hit.band).row(hit.cat_row);
    let star_rows = row.star;
    let diam_deg = row.diam_deg as f64;
    let ring = DupRing::new(1); // empty: ring identity/pose gates never fire (see doc)

    let s_impl = match hypo::gate_prefit(
        det_a, det_b, diam_deg, hit.cat_row, hit.band, hit.parity, hit.s_sample, w, h, gates, &ring,
    ) {
        Ok(s) => s,
        Err(r) => return Layer5::PoseRejected(reject_name(r)),
    };
    let cat_sky = [
        SkyDeg { ra: index.stars.ra[star_rows[0] as usize], dec: index.stars.dec[star_rows[0] as usize] },
        SkyDeg { ra: index.stars.ra[star_rows[1] as usize], dec: index.stars.dec[star_rows[1] as usize] },
        SkyDeg { ra: index.stars.ra[star_rows[2] as usize], dec: index.stars.dec[star_rows[2] as usize] },
        SkyDeg { ra: index.stars.ra[star_rows[3] as usize], dec: index.stars.dec[star_rows[3] as usize] },
    ];
    let det_px = [det_a, det_b, det_c, det_d];
    let pose = match hypo::gate_fit(&det_px, &cat_sky, diam_deg, s_impl, hit.parity, w, h, gates, &ring) {
        Ok(p) => p,
        Err(r) => return Layer5::PoseRejected(reject_name(r)),
    };

    Layer5::Verified(engine.would_verify_at_pose(&pose.wcs, &star_rows, &hit.det_ids))
}

fn reject_name(r: GateReject) -> &'static str {
    r.counter_name()
}
