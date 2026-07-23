//! quadgen — the wide-field candidate stream (M4a):
//! incremental det-quad generation in a.net activation order, SKY-TRUE band targeting,
//! scale-hypothesis re-tangent coding, and index probing.
//!
//! This lane is the measured kill of the two legacy defects (plan rev 2 §0 conformance):
//!   1. whole-frame pixel coding (34.1% in-tol ceiling) → per-(quad, band-sample) local
//!      re-tangent coding about the 4-member unit-vector mean, the exact builder recipe
//!      (`G3_GEOMETRY_DECISION.md`, LOCAL arm frac≤tol = 1.000);
//!   2. starved pool (0 truth sets enumerated) → consumes the M-1 frozen uncapped pool
//!      (prep.rs) with depth controlled by the rung ladder.
//!
//! GEOMETRY (all f64):
//!   scale s in deg/px = arcsec/3600. Unprojection about the frame center: tangent coords
//!   (u,v) = ((x − W/2)·s, (y − H/2)·s) DEGREES treated as gnomonic offsets about an
//!   abstract tangent point; unit direction = normalize(1, u·D2R, v·D2R).
//!   PAIR separation under s = great-circle angle between the two unprojected directions —
//!   NEVER d_px·s (gnomonic stretch reaches sec²θ≈1.8 at this frame class's corners).
//!
//!   MEASURED DEVIATION from the plan's "monotone in s" claim (derived + unit-tested here):
//!   sep(s) is monotone increasing ONLY while s < s* where the interior maximum
//!   s*·D2R = |P1−P2| / sqrt(C(A+B) − 2AB)  (A=|P1|², B=|P2|², C=P1·P2, when C(A+B) > 2AB;
//!   otherwise monotone on all s). Beyond s* a near-radial pair's separation DECREASES
//!   toward the azimuthal angle (both points compress toward the same horizon point). For
//!   wide radial pairs s* ≈ 100–300″/px — INSIDE the blind window. Admission and sampling
//!   therefore use the true extremum-aware range/solver below, preferring the rising
//!   branch (the physically ordinary regime) and falling back to the falling branch when a
//!   target is only reachable there.
//!
//! PARITY: parity 0 = detection coords as-is; parity 1 handled at the CODE level — negate
//! code components 1 and 3 (canonical-preserving: fold/order tests read x only; reflection
//! conjugates the complex basis; proven bit-exact in tests/m4a_synthetic.rs).
//!
//! SCALE SAMPLING per (pair, band) — EXACT RULE (the plan left the rule to be documented
//! here; MEASURED REVISION 2026-07-20, tests/m4a_synthetic.rs): the plan's bound
//! err ≈ 0.25·ε·sin²θ_max with a 1-or-2-sample cap is UNSAFE as a general-geometry bound —
//! the synthetic wide-field ensemble measured continuous-branch coefficients k well above
//! the plan's empirical 0.25 (a band-13-edge quad coded at err 0.0178 > tol under the
//! 1-sample rule). The implemented rule is the plan's own mandate generalized
//! ("sensitivity-driven multi-sample is mandatory"): split the band's log-annulus into n
//! equal segments and sample each segment's geometric center — targets
//! lo·(hi/lo)^((2i+1)/(2n)) — where n is the smallest count whose per-segment edge ratio
//! r = (hi/lo)^(1/(2n)) satisfies K_SAFE·(r−1)·B ≤ code_tol/2, with
//! B = min(sin²θ_max, tanθ_max·hi_rad). The second term of B is the small-quad refinement:
//! for a quad whose angular extent (≤ the band's hi edge, by construction) is much smaller
//! than its field angle, the scale-mismatch distortion is locally affine and the code error
//! is set by the magnification VARIATION across the quad (∼tanθ·Δθ), not sin²θ — without it
//! fine-band probing of corner detections over-samples ~20×. K_SAFE = 1.0 (4× the plan's
//! empirical 0.25; above every continuous-branch k the synthetic gate measures). n = 1
//! reproduces the plan's sqrt(lo·hi) sample bit-for-bit; n = 2 reproduces the two
//! half-annulus geometric means (2^(∓1/8) shifts). n caps at MAX_SAMPLES (8); hitting the
//! cap is COUNTED (`samples_capped`), never silently extended.
//!
//! Distinct failure mode, measured and accepted: a quad near the coder's canonical fold
//! (cx+dx = 1) or C/D-order (dx = cx) decision boundary can FLIP branches under scale
//! mismatch — an O(1) code jump no sampling density fixes (astrometry.net shares this
//! attrition class). The synthetic gate bounds the flip RATE; the desk-check measures the
//! composite effect on real truth quads.
//!
//! CANONICAL EMISSION ORDER (deterministic, the M4b retirement contract):
//! (rung asc, activation rank n asc, pair (p0,p1) asc, interior subset lex, parity 0 then 1,
//! band asc, sample asc, cat_row asc). `quad_seq` linearizes (rung, n, pair, subset).
//!
//! LAW 1: COORDINATE-ledger math on the abstract sphere; pixel coords enter only as
//! detection positions. No I/O, no env reads (grep-guard).

use crate::coder::{self, QuadCode};
use crate::geom;
use crate::index::probe::ProbeBlock;
use crate::index::QuadIndex;
use crate::prep::PreparedFrame;
use solver_contracts::config::{BandOrder, SearchPolicy};
use solver_contracts::coordinates::{SkyDeg, UnitVec3};

pub use crate::geom::D2R;

/// 2^(1/4): band-edge/geomean separation ratio of the √2 annuli (1-sample worst case).
pub const BAND_EDGE_RATIO_1: f64 = 1.189_207_115_002_721_1;
/// 2^(1/8): half-annulus-edge/half-annulus-geomean ratio (2-sample worst case).
pub const BAND_EDGE_RATIO_2: f64 = 1.090_507_732_665_257_7;

/// Per-band metadata the generator needs (decoupled from `QuadIndex` so synthetic tests can
/// target the real g15u annuli without an index on disk).
#[derive(Debug, Clone, Copy)]
pub struct BandMeta {
    pub index: u32,
    pub lo_deg: f64,
    pub hi_deg: f64,
    pub n_quads: u64,
}

/// Extract band metadata from an opened release.
pub fn band_metas(idx: &QuadIndex) -> Vec<BandMeta> {
    idx.bands
        .iter()
        .map(|b| BandMeta {
            index: b.index,
            lo_deg: b.lo_deg,
            hi_deg: b.hi_deg,
            n_quads: b.n_quads,
        })
        .collect()
}

/// The static band permutation for a `BandOrder` policy over `bands` (position == band
/// index, the module-wide invariant). Returns `(sweep, rank)`:
///   `sweep[k]` = the band position to visit k-th (first `bands.len()` entries valid);
///   `rank[pos]` = the sweep position of band `pos` (the `band` component of the canonical
///   hit-emission order). `Ascending` is the identity — the byte-identical frozen path.
/// CheapestFirst orders by stored quad count ascending (a PRE-SCAN manifest quantity),
/// ties by band index — fully deterministic. Empty bands are ordered too but are masked
/// out downstream, so their placement is inert.
pub fn compute_band_order(bands: &[BandMeta], order: BandOrder) -> ([u8; 16], [u32; 16]) {
    let n = bands.len();
    let mut positions: Vec<usize> = (0..n).collect();
    match order {
        BandOrder::Ascending => {}
        BandOrder::Descending => positions.reverse(),
        BandOrder::CheapestFirst => {
            positions.sort_by(|&a, &b| bands[a].n_quads.cmp(&bands[b].n_quads).then(a.cmp(&b)));
        }
    }
    let mut sweep: [u8; 16] = [0; 16];
    let mut rank: [u32; 16] = [0; 16];
    for (k, &pos) in positions.iter().enumerate() {
        sweep[k] = pos as u8;
        rank[pos] = k as u32;
    }
    (sweep, rank)
}

/// One in-tolerance probe hit (the candidate stream unit).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CandidateHit {
    /// Detection ids in the CODE's canonical A,B,C,D order (vertex-correspondent with the
    /// stored row's star0..3 — `encodeBand` stores canonical post-fold order).
    pub det_ids: [u32; 4],
    pub band: u32,
    /// Global row in the band file (batch·batchRows + offset).
    pub cat_row: u64,
    pub parity: u8,
    pub sample: u8,
    pub code_dist2: f64,
    /// The scale hypothesis (deg/px) this code was computed at.
    pub s_sample: f64,
    /// Canonical quad sequence number (rung, n, pair, subset linearized).
    pub quad_seq: u64,
}

/// Streaming consumer of the candidate stream. `on_hit` receives hits in CANONICAL order.
/// `on_quad`/`on_coded` are telemetry taps (desk-check cross-referencing, determinism
/// tests); default no-ops.
pub trait CandidateSink {
    /// Every enumerated quad, in canonical order. `det_ids` in (pair a, pair b, c, d)
    /// ENUMERATION order (not code-canonical).
    fn on_quad(&mut self, _quad_seq: u64, _det_ids: [u32; 4]) {}
    /// Every coded (quad, band, sample, parity) — call order per quad: band asc, sample
    /// asc, parity asc. `det_ids` in code-canonical order.
    fn on_coded(
        &mut self,
        _quad_seq: u64,
        _det_ids: [u32; 4],
        _band: u32,
        _parity: u8,
        _sample: u8,
        _s: f64,
        _code: &[f64; 4],
    ) {
    }
    fn on_hit(&mut self, hit: &CandidateHit);
    /// Telemetry tap: has this sink CONFIRMED an accept (frozen the decision)? Default false.
    /// The generator polls this in the flush drain to snapshot per-band counters flush-exact
    /// at the confirmed freeze. Only the solving sink overrides it; no behavior depends on it.
    fn froze_confirmed(&self) -> bool {
        false
    }
}

/// Per-band probe counters (receipt telemetry; MEASURED).
#[derive(Debug, Default, Clone, Copy)]
pub struct BandCounters {
    /// (quad, band) targetings admitted by the sky-true compat mask.
    pub det_quads: u64,
    /// Key lookups issued (one per (pending-entry, neighbor-key)).
    pub probes: u64,
    /// Index rows scanned across all key hits.
    pub raw_hits: u64,
    /// Rows passing the exact 4-D f64 distance ≤ code_tol².
    pub in_tol_hits: u64,
    /// (quad, band) targetings coded with one / two / three-or-more scale samples.
    pub samples_one: u64,
    pub samples_two: u64,
    pub samples_multi: u64,
    /// Codings where the enumeration basis pair was rejected by the re-tangented coder
    /// (C/D left the AB circle in the local frame) or a member unprojected behind the
    /// tangent point.
    pub coder_rejected: u64,
    /// Targetings whose demanded sample count exceeded MAX_SAMPLES (clamped + counted,
    /// never silently extended).
    pub samples_capped: u64,
}

/// Per-rung generation report.
#[derive(Debug, Clone, Copy)]
pub struct RungReport {
    pub rung_index: usize,
    /// Activated pool ranks (1-based, inclusive) this rung.
    pub rank_start: u32,
    pub rank_end: u32,
    pub pairs_total: usize,
    pub quads_emitted: u64,
    pub hits_emitted: u64,
    pub wall_ms: u64,
}

// ───────────────────────────── geometry ─────────────────────────────

/// Unit direction of pixel (x, y) at scale `s_deg_px` about the abstract frame-center
/// tangent point: (u,v) = ((x−W/2)s, (y−H/2)s) deg; V = normalize(1, u·D2R, v·D2R).
#[inline]
pub fn unproject_px(x: f64, y: f64, w: f64, h: f64, s_deg_px: f64) -> UnitVec3 {
    let u = (x - w * 0.5) * s_deg_px * D2R;
    let v = (y - h * 0.5) * s_deg_px * D2R;
    let n = (1.0 + u * u + v * v).sqrt();
    UnitVec3 { x: 1.0 / n, y: u / n, z: v / n }
}

/// Sky angles (deg) of an abstract-frame direction (ra = atan2(y,x), dec = asin(z)).
#[inline]
fn dir_to_sky(v: UnitVec3) -> SkyDeg {
    let ra = v.y.atan2(v.x) / D2R;
    let z = v.z.clamp(-1.0, 1.0);
    SkyDeg { ra: if ra < 0.0 { ra + 360.0 } else { ra }, dec: z.asin() / D2R }
}

/// Precomputed frame-centered pixel dot products of a pair — everything the sky-true
/// separation function sep(s) needs.
#[derive(Debug, Clone, Copy)]
pub struct PairGeom {
    /// |P1|², |P2|², P1·P2 (P = pixel offset from frame center).
    pub aa: f64,
    pub bb: f64,
    pub ab: f64,
    /// |P1−P2|² (pixel separation squared).
    pub d2: f64,
}

impl PairGeom {
    #[inline]
    pub fn new(x1: f64, y1: f64, x2: f64, y2: f64, w: f64, h: f64) -> Self {
        let (cx, cy) = (w * 0.5, h * 0.5);
        let (p1x, p1y) = (x1 - cx, y1 - cy);
        let (p2x, p2y) = (x2 - cx, y2 - cy);
        let dx = p1x - p2x;
        let dy = p1y - p2y;
        Self {
            aa: p1x * p1x + p1y * p1y,
            bb: p2x * p2x + p2y * p2y,
            ab: p1x * p2x + p1y * p2y,
            d2: dx * dx + dy * dy,
        }
    }

    /// cos of the great-circle separation at τ = s·D2R (rad/px).
    #[inline]
    fn cos_sep_tau(&self, tau: f64) -> f64 {
        let t2 = tau * tau;
        let n = 1.0 + t2 * self.ab;
        let d1 = 1.0 + t2 * self.aa;
        let d2 = 1.0 + t2 * self.bb;
        n / (d1 * d2).sqrt()
    }

    #[inline]
    fn sep_rad_tau(&self, tau: f64) -> f64 {
        self.cos_sep_tau(tau).clamp(-1.0, 1.0).acos()
    }

    /// Great-circle separation (deg) under scale hypothesis s (deg/px).
    #[inline]
    pub fn sep_deg(&self, s_deg_px: f64) -> f64 {
        self.sep_rad_tau(s_deg_px * D2R) / D2R
    }

    /// d(sep_rad)/dτ.
    #[inline]
    fn dsep_dtau(&self, tau: f64) -> f64 {
        let t2 = tau * tau;
        let n = 1.0 + t2 * self.ab;
        let d1 = 1.0 + t2 * self.aa;
        let d2 = 1.0 + t2 * self.bb;
        let dd = d1 * d2;
        // d cos/dτ = τ·[2C·D1·D2 − N(A·D2 + B·D1)] / (D1·D2)^{3/2}
        let dcos = tau * (2.0 * self.ab * dd - n * (self.aa * d2 + self.bb * d1)) / (dd * dd.sqrt());
        let c = (n / dd.sqrt()).clamp(-1.0, 1.0);
        let sin = (1.0 - c * c).sqrt().max(1e-300);
        -dcos / sin
    }

    /// The interior separation maximum τ* (rad/px), if the pair is in the non-monotone
    /// (near-radial) regime. sep rises on (0, τ*), falls beyond toward the azimuthal angle.
    #[inline]
    pub fn tau_peak(&self) -> Option<f64> {
        let den = self.ab * (self.aa + self.bb) - 2.0 * self.aa * self.bb;
        if den > 0.0 && self.d2 > 0.0 {
            Some((self.d2 / den).sqrt())
        } else {
            None
        }
    }

    /// (min, max) separation in deg over the scale window [s_lo, s_hi] (deg/px) —
    /// extremum-aware (see module docs; the interior critical point is always a maximum,
    /// so the minimum is at an endpoint).
    pub fn sep_range_deg(&self, s_lo: f64, s_hi: f64) -> (f64, f64) {
        let (tl, th) = (s_lo * D2R, s_hi * D2R);
        let fl = self.sep_rad_tau(tl);
        let fh = self.sep_rad_tau(th);
        let mut mx = fl.max(fh);
        if let Some(tp) = self.tau_peak() {
            if tp > tl && tp < th {
                mx = mx.max(self.sep_rad_tau(tp));
            }
        }
        (fl.min(fh) / D2R, mx / D2R)
    }

    /// Solve sep(s) = target_deg on [s_lo, s_hi] (deg/px), deterministic:
    ///   - rising-branch root preferred (the ordinary regime);
    ///   - falling-branch root when the target is only reachable there;
    ///   - otherwise clamps to the nearest achievable scale (window edge or the peak).
    /// Newton with bisection safeguard on a monotone bracket; ~2-3 Newton steps typical.
    pub fn solve_scale_for_sep(&self, target_deg: f64, s_lo: f64, s_hi: f64) -> f64 {
        let t = target_deg * D2R;
        let (tl, th) = (s_lo * D2R, s_hi * D2R);
        let fl = self.sep_rad_tau(tl);
        let fh = self.sep_rad_tau(th);
        let peak = self.tau_peak().filter(|&tp| tp > tl && tp < th);
        // rising interval [tl, r_end]; falling interval [r_end, th] when a peak is inside
        let r_end = peak.unwrap_or(th);
        let fr_end = self.sep_rad_tau(r_end);
        let tau = if t <= fl {
            // at/below the window floor — includes the rare falling-only-reachable case
            if peak.is_some() && fh <= t && t < fl {
                self.solve_monotone(t, r_end, th, false)
            } else {
                tl
            }
        } else if t <= fr_end {
            self.solve_monotone(t, tl, r_end, true)
        } else {
            // above the rising max: unreachable — clamp to argmax (peak or window top)
            r_end
        };
        tau / D2R
    }

    /// Safeguarded Newton on a monotone bracket [a, b] (rising or falling), root of
    /// sep(τ) = t known to lie inside. Deterministic iteration count/paths.
    fn solve_monotone(&self, t: f64, mut a: f64, mut b: f64, rising: bool) -> f64 {
        let mut x = 0.5 * (a + b);
        // Good initial guess for the ordinary rising case: naive planar scale.
        if rising && self.d2 > 0.0 {
            let naive = t / self.d2.sqrt();
            if naive > a && naive < b {
                x = naive;
            }
        }
        for _ in 0..64 {
            let f = self.sep_rad_tau(x) - t;
            if f.abs() <= 1e-13 {
                return x;
            }
            let below = if rising { f < 0.0 } else { f > 0.0 };
            if below {
                a = x;
            } else {
                b = x;
            }
            let d = self.dsep_dtau(x);
            let mut nx = if d.abs() > 1e-300 { x - f / d } else { 0.5 * (a + b) };
            if !(nx > a && nx < b) {
                nx = 0.5 * (a + b);
            }
            if (nx - x).abs() <= 1e-16 * x.abs() {
                return nx;
            }
            x = nx;
        }
        x
    }
}

/// sin²(field angle) of a point with |P|² = `r2_px` at scale s: (τ²r²)/(1+τ²r²).
#[inline]
pub fn sin2_field_angle(r2_px: f64, s_deg_px: f64) -> f64 {
    let v = (s_deg_px * D2R) * (s_deg_px * D2R) * r2_px;
    v / (1.0 + v)
}

/// Sampling-rule safety coefficient (module docs: measured revision of the plan's k≈0.25;
/// design parameter of this lane, NOT an owner-guarded constant — code_tol is).
pub const K_SAFE: f64 = 1.0;
/// Hard cap on scale samples per (quad, band); hitting it is counted, never extended.
pub const MAX_SAMPLES: usize = 8;

/// The scale-sample set for one (pair, band) targeting (see module docs for the rule).
#[derive(Debug, Clone, Copy)]
pub struct SampleSet {
    pub scales: [f64; MAX_SAMPLES],
    /// Segments demanded by the bound BEFORE clamp-collapse dedup (1..=MAX_SAMPLES).
    pub n: u8,
    /// Distinct scales actually present in `scales` (≤ n; window clamping can collapse).
    pub n_distinct: u8,
    pub capped: bool,
}

impl SampleSet {
    /// The worst-case sep-mismatch ratio the rule permits for a true separation inside the
    /// band: the per-segment edge/center ratio (hi/lo)^(1/(2n)). Window clamping can only
    /// occur when the true scale itself sits at the window edge, so this is the design
    /// bound the synthetic gate stresses.
    pub fn worst_ratio(&self, lo_deg: f64, hi_deg: f64) -> f64 {
        (hi_deg / lo_deg).powf(1.0 / (2.0 * self.n as f64))
    }
}

/// The exact sampling rule (module docs): n log-annulus segments, geometric-center targets,
/// n from K_SAFE·(r−1)·B ≤ tol/2 with B = min(sin²θ_max, tanθ_max·hi_rad) evaluated at the
/// band's hi-edge scale (the largest — conservative — field angle the band can demand).
pub fn sample_scales(
    g: &PairGeom,
    lo_deg: f64,
    hi_deg: f64,
    r2max_px: f64,
    tol: f64,
    s_lo: f64,
    s_hi: f64,
) -> SampleSet {
    // conservative field-angle basis: at the scale reaching the band's hi edge
    let s_edge = g.solve_scale_for_sep(hi_deg, s_lo, s_hi);
    let sin2 = sin2_field_angle(r2max_px, s_edge);
    let tan_theta = (sin2 / (1.0 - sin2).max(1e-12)).sqrt();
    let b = sin2.min(tan_theta * hi_deg * D2R);
    let ln_band_half = (hi_deg / lo_deg).ln() * 0.5;
    let (n, capped) = if b <= 1e-12 {
        (1usize, false)
    } else {
        let r_max = 1.0 + tol / (2.0 * K_SAFE * b);
        let need = (ln_band_half / r_max.ln()).ceil() as usize;
        if need <= 1 {
            (1, false)
        } else if need > MAX_SAMPLES {
            (MAX_SAMPLES, true)
        } else {
            (need, false)
        }
    };
    let mut out = SampleSet { scales: [0.0; MAX_SAMPLES], n: n as u8, n_distinct: 0, capped };
    let mut m = 0usize;
    for i in 0..n {
        let target = lo_deg * (hi_deg / lo_deg).powf((2 * i + 1) as f64 / (2 * n) as f64);
        let s = g.solve_scale_for_sep(target, s_lo, s_hi);
        // window clamping can collapse neighbours onto the same scale — dedupe (targets are
        // ascending, so a collapse is always against the previous sample)
        if m == 0 || (s - out.scales[m - 1]).abs() > 1e-12 * s.abs() {
            out.scales[m] = s;
            m += 1;
        }
    }
    out.n_distinct = m as u8;
    out
}

// ───────────────────────── re-tangent coding ─────────────────────────

/// One coded det quad: canonical f64 code + the canonical A,B,C,D order as indices into the
/// 4-point input.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CodedQuad {
    pub code: [f64; 4],
    pub canon: [u8; 4],
}

/// Parity-1 code: negate components 1 and 3 (canonical-preserving; module docs).
#[inline]
pub fn mirror_code(code: &[f64; 4]) -> [f64; 4] {
    [code[0], -code[1], code[2], -code[3]]
}

/// Re-tangent coding at scale hypothesis `s_deg_px` (deg/px): unproject the 4 members about
/// the frame center → unit-vector mean (builder's meanRaDec) → gnomonic about that centroid
/// (builder convention, degrees) → canonical coder on those points with
/// {sepMin 0, sepMax ∞, capInterior 2}. The quad's basis is the ENUMERATION pair
/// (pts[0], pts[1]); the coder re-arbitrates interior in the re-tangented plane and is
/// authoritative — `None` when it rejects the basis (or a member unprojects behind the
/// centroid tangent point, impossible for sane geometry).
///
/// `scratch` is a caller-owned reusable Vec (hot-path zero-alloc contract).
pub fn code_quad_at_scale(
    pts_px: &[(f64, f64); 4],
    w: f64,
    h: f64,
    s_deg_px: f64,
    scratch: &mut Vec<QuadCode>,
) -> Option<CodedQuad> {
    let mut sky = [SkyDeg { ra: 0.0, dec: 0.0 }; 4];
    for (k, &(x, y)) in pts_px.iter().enumerate() {
        sky[k] = dir_to_sky(unproject_px(x, y, w, h, s_deg_px));
    }
    let c = geom::mean_ra_dec(&sky);
    let mut pts = [coder::PointW { x: 0.0, y: 0.0, w: 0.0 }; 4];
    for k in 0..4 {
        let t = geom::gnomonic(sky[k].ra, sky[k].dec, c.ra, c.dec)?;
        // w = 0 for all: with 4 points the coder's interior cap (2) never binds, so the
        // brightness weight is inert (Fable-confirmed; builder codeQuad4 identical shape).
        pts[k] = coder::PointW { x: t.x, y: t.y, w: 0.0 };
    }
    coder::build_quad_codes(&pts, 0.0, f64::INFINITY, 2, scratch);
    for qc in scratch.iter() {
        let (a, b) = (qc.ids[0], qc.ids[1]);
        if (a == 0 && b == 1) || (a == 1 && b == 0) {
            return Some(CodedQuad {
                code: qc.code,
                canon: [qc.ids[0] as u8, qc.ids[1] as u8, qc.ids[2] as u8, qc.ids[3] as u8],
            });
        }
    }
    None
}

// ───────────────────────── incremental generation ─────────────────────────

#[derive(Debug, Clone, Copy)]
struct Pair {
    /// Pool indices (uniformized order), i < j by activation.
    i: u32,
    j: u32,
    geom: PairGeom,
    /// AB-diameter circle in PIXEL space (cheap interior prefilter; the re-tangented coder
    /// re-arbitrates and is authoritative).
    mx: f64,
    my: f64,
    r2: f64,
    /// Sky-true compatible bands under the blind scale window (slack applied both sides).
    band_mask: u16,
    n_int: u8,
}

#[derive(Debug, Clone, Copy)]
struct QuadItem {
    p0: u32,
    p1: u32,
    c: u32,
    d: u32,
    pair_idx: u32,
}

/// A materialized det-quad for the BAND-MAJOR path: the enumeration item plus its assigned
/// canonical `quad_seq`. Geometry (positions/spans) is re-derived from `q` at coding time —
/// NO per-band codes are stored (the whole point of band-major; ~one QuadItem + u64/quad).
#[derive(Debug, Clone, Copy)]
struct MatQuad {
    q: QuadItem,
    seq: u64,
}

#[derive(Debug, Clone, Copy)]
struct Pending {
    quad_seq: u64,
    det_ids: [u32; 4],
    band: u32,
    parity: u8,
    sample: u8,
    s: f64,
    code: [f64; 4],
}

/// The incremental candidate-stream generator. Construct once per solve; drive with
/// `next_rung` (M4b drains verification between rungs).
pub struct QuadGen<'a> {
    prep: &'a PreparedFrame,
    w: f64,
    h: f64,
    policy: SearchPolicy,
    bands: Vec<BandMeta>,
    s_lo: f64,
    s_hi: f64,
    tol: f64,
    /// Global pixel admission floor: below this d², no scale in the (slacked) window can
    /// lift the pair to the smallest nonempty band edge (planar ≥ true bound). There is NO
    /// upper pixel cutoff: a positive lower bound on sep given planar distance does not
    /// exist (horizon compression), so wide pairs are admitted and the sky-true mask rules.
    min_pair_d2: f64,
    /// |P|² from frame center per pool detection (bound computation).
    r2_px: Vec<f64>,
    pairs: Vec<Pair>,
    /// Fixed-stride interior arena (stride = interior_cap), arrival order.
    interior: Vec<u32>,
    cap: usize,
    next_rank: usize,
    rung_idx: usize,
    quad_seq: u64,
    total_quads: u64,
    /// Band visit order under `policy.band_order` (Copy; first `bands.len()` valid).
    /// Ascending = identity ⇒ the frozen byte-identical coding sweep.
    band_sweep: [u8; 16],
    /// Sweep rank of each band position — the `band` key of the canonical hit-emission
    /// order. Ascending = identity.
    band_rank: [u32; 16],
    counters: Vec<BandCounters>,
    // ── Phase-0 telemetry (per-band walls + freeze-instant snapshot); does NOT affect the
    //    decision — pure observation over the existing timed regions. ──
    /// Per-band coding/probe SWEEP wall (ns), keyed by band index (flush block-sweep region).
    probe_wall_ns: Vec<u64>,
    /// Per-band VERIFY wall (ns), keyed by hit band (per-hit `on_hit` region in the drain).
    verify_wall_ns: Vec<u64>,
    /// Total `Instant` reads issued by the two wall timers (overhead-bound accounting).
    timer_calls: u64,
    /// Per-band counter snapshot taken the first time the sink reports a CONFIRMED freeze
    /// (flush-exact). None until/unless that happens.
    at_accept_counters: Option<Vec<BandCounters>>,
    /// Set true when `policy.abort_on_accept` engaged and broke the in-flight rung's
    /// continuation loops at a CONFIRMED freeze. Never set when the flag is off (⇒ the
    /// frozen drain-all path is byte-identical). Read by the coordinator for telemetry.
    aborted: bool,
    // scratch (construct-once)
    quad_buf: Vec<QuadItem>,
    /// Per-rung materialization buffer for the BAND-MAJOR path (empty + untouched on the
    /// default det-quad-major path). Holds one rung's enumerated quads (bounded by the rung's
    /// rank slice) between Phase-1 enumeration and Phase-2 band-outer coding.
    rung_quads: Vec<MatQuad>,
    pending: Vec<Pending>,
    blocks: Vec<ProbeBlock>,
    hits_buf: Vec<CandidateHit>,
    coder_scratch: Vec<QuadCode>,
}

impl<'a> QuadGen<'a> {
    pub fn new(
        prep: &'a PreparedFrame,
        w: u32,
        h: u32,
        policy: &SearchPolicy,
        bands: Vec<BandMeta>,
    ) -> Self {
        assert!(bands.len() <= 16, "band_mask is u16");
        assert!(
            policy.interior_cap >= 2 && policy.interior_cap <= 64,
            "interior_cap out of range"
        );
        let s_lo = policy.scale_lo_asec / 3600.0;
        let s_hi = policy.scale_hi_asec / 3600.0;
        let min_lo = bands
            .iter()
            .filter(|b| b.n_quads > 0)
            .map(|b| b.lo_deg)
            .fold(f64::INFINITY, f64::min);
        let min_pair_px = if min_lo.is_finite() {
            min_lo / (policy.band_slack * s_hi)
        } else {
            f64::INFINITY // no nonempty band — nothing is admissible
        };
        let (band_sweep, band_rank) = compute_band_order(&bands, policy.band_order);
        let (wf, hf) = (w as f64, h as f64);
        let r2_px = prep
            .x
            .iter()
            .zip(prep.y.iter())
            .map(|(&x, &y)| {
                let dx = x - wf * 0.5;
                let dy = y - hf * 0.5;
                dx * dx + dy * dy
            })
            .collect();
        Self {
            prep,
            w: wf,
            h: hf,
            s_lo,
            s_hi,
            tol: policy.code_tol,
            min_pair_d2: min_pair_px * min_pair_px,
            r2_px,
            pairs: Vec::new(),
            interior: Vec::new(),
            cap: policy.interior_cap as usize,
            next_rank: 0,
            rung_idx: 0,
            quad_seq: 0,
            total_quads: 0,
            band_sweep,
            band_rank,
            counters: vec![BandCounters::default(); bands.len()],
            probe_wall_ns: vec![0u64; bands.len()],
            verify_wall_ns: vec![0u64; bands.len()],
            timer_calls: 0,
            at_accept_counters: None,
            aborted: false,
            quad_buf: Vec::new(),
            rung_quads: Vec::new(),
            pending: Vec::with_capacity(PENDING_FLUSH),
            blocks: (0..bands.len()).map(|_| ProbeBlock::with_capacity(1 << 14)).collect(),
            hits_buf: Vec::new(),
            coder_scratch: Vec::with_capacity(8),
            policy: policy.clone(),
            bands,
        }
    }

    #[inline]
    pub fn counters(&self) -> &[BandCounters] {
        &self.counters
    }

    /// Per-band coding/probe SWEEP wall (ns), band-indexed (Phase-0 telemetry).
    #[inline]
    pub fn probe_wall_ns(&self) -> &[u64] {
        &self.probe_wall_ns
    }

    /// Per-band VERIFY wall (ns), band-indexed (Phase-0 telemetry).
    #[inline]
    pub fn verify_wall_ns(&self) -> &[u64] {
        &self.verify_wall_ns
    }

    /// Total `Instant` reads issued by the wall timers (overhead-bound accounting).
    #[inline]
    pub fn timer_calls(&self) -> u64 {
        self.timer_calls
    }

    /// Per-band counter snapshot at the CONFIRMED freeze (flush-exact); None if never frozen.
    #[inline]
    pub fn at_accept_counters(&self) -> Option<&[BandCounters]> {
        self.at_accept_counters.as_deref()
    }

    /// True iff `policy.abort_on_accept` engaged and cut the in-flight rung short at a
    /// confirmed freeze (Phase-0 A/B telemetry). Always false on the frozen drain-all path.
    #[inline]
    pub fn aborted(&self) -> bool {
        self.aborted
    }

    /// Abort predicate: flag-gated on a CONFIRMED freeze (`sink.froze_confirmed()`). When
    /// the flag is off this is ALWAYS false — the frozen drain-all continuation runs
    /// bit-for-bit as before. When on, the three continuation loops break the instant the
    /// sink confirms an accept, skipping the accepting rung's remaining coding/probing/drain.
    #[inline]
    fn abort_now(&self, sink: &dyn CandidateSink) -> bool {
        self.policy.abort_on_accept && sink.froze_confirmed()
    }

    #[inline]
    pub fn total_quads(&self) -> u64 {
        self.total_quads
    }

    #[inline]
    pub fn pairs_total(&self) -> usize {
        self.pairs.len()
    }

    /// Sky-true band compat mask for a pair: the slack-widened achievable separation range
    /// [min/slack, max·slack] (extremum-aware) intersected with each nonempty band's
    /// half-open annulus [lo, hi).
    fn band_mask(&self, g: &PairGeom) -> u16 {
        let (mn, mx) = g.sep_range_deg(self.s_lo, self.s_hi);
        let slack = self.policy.band_slack;
        let (mn_w, mx_w) = (mn / slack, mx * slack);
        let mut mask = 0u16;
        for b in &self.bands {
            if b.n_quads == 0 {
                continue;
            }
            if mx_w >= b.lo_deg && mn_w < b.hi_deg {
                mask |= 1u16 << b.index;
            }
        }
        mask
    }

    /// Generate the next rung of the ladder. Returns None when the pool is exhausted.
    /// `index` = None runs enumeration+coding without probing (synthetic/determinism tests).
    pub fn next_rung(
        &mut self,
        index: Option<&QuadIndex>,
        sink: &mut dyn CandidateSink,
    ) -> Option<RungReport> {
        let pool = self.prep.len();
        if self.next_rank >= pool {
            return None;
        }
        let ladder = &self.policy.rung_ladder;
        let rank_end = if self.rung_idx < ladder.len() {
            (ladder[self.rung_idx] as usize).min(pool)
        } else if self.policy.rung_final_all {
            pool
        } else {
            return None;
        };
        if rank_end <= self.next_rank {
            // ladder rung already covered (e.g. pool smaller than a rung boundary)
            self.rung_idx += 1;
            return self.next_rung(index, sink);
        }
        let t0 = std::time::Instant::now();
        let rank_start = self.next_rank;
        let quads_before = self.total_quads;
        let hits_before: u64 = self.counters.iter().map(|c| c.in_tol_hits).sum();

        if self.policy.band_major {
            // BAND-MAJOR branch (flag-gated): the whole rung materializes, then codes
            // bands coarse→fine with per-band verification + its own abort handling.
            self.run_rung_band_major(rank_start, rank_end, index, sink);
        } else {
            for n in rank_start..rank_end {
                self.activate(n as u32, index, sink);
                if self.abort_now(&*sink) {
                    self.aborted = true;
                    break;
                }
            }
            // On abort the accepting rung is decided — skip the final probe/drain flush (its
            // per-band sweep is exactly the post-accept work the abort exists to cut). The
            // generator is left holding unflushed `pending`, but the coordinator never calls
            // `next_rung` again once solved, so no invariant depends on this last drain running.
            if !self.aborted {
                self.flush(index, sink);
            }
        }

        self.next_rank = rank_end;
        self.rung_idx += 1;
        Some(RungReport {
            rung_index: self.rung_idx - 1,
            rank_start: rank_start as u32 + 1,
            rank_end: rank_end as u32,
            pairs_total: self.pairs.len(),
            quads_emitted: self.total_quads - quads_before,
            hits_emitted: self.counters.iter().map(|c| c.in_tol_hits).sum::<u64>() - hits_before,
            wall_ms: t0.elapsed().as_millis() as u64,
        })
    }

    /// Enumeration step for pool rank n (a.net order), building + canonically sorting
    /// `self.quad_buf` and mutating `pairs`/`interior` — NO coding/probing. (a) extend
    /// existing pairs whose pixel circle contains n (emit quads with each EARLIER interior
    /// member), then append n; (b) create pairs (i, n) for all i < n passing the global pixel
    /// admission, collect interior from ranks < n (arrival order, cap), emit all 2-subsets.
    /// Shared by the default `activate` (which then codes each quad in place) and the
    /// band-major materialization phase (which collects the quads first).
    fn enumerate_into_quad_buf(&mut self, n: u32) {
        let x = &self.prep.x;
        let y = &self.prep.y;
        let (xn, yn) = (x[n as usize], y[n as usize]);
        self.quad_buf.clear();

        // (a) existing pairs
        for (pi, p) in self.pairs.iter_mut().enumerate() {
            if (p.n_int as usize) >= self.cap {
                continue;
            }
            let ex = xn - p.mx;
            let ey = yn - p.my;
            if ex * ex + ey * ey > p.r2 {
                continue; // pixel prefilter (inclusive boundary kept: coder re-arbitrates)
            }
            let base = pi * self.cap;
            for k in 0..p.n_int as usize {
                let m = self.interior[base + k];
                self.quad_buf.push(QuadItem { p0: p.i, p1: p.j, c: m, d: n, pair_idx: pi as u32 });
            }
            self.interior[base + p.n_int as usize] = n;
            p.n_int += 1;
        }

        // (b) new pairs (i, n)
        for i in 0..n {
            let (xi, yi) = (x[i as usize], y[i as usize]);
            let dx = xi - xn;
            let dy = yi - yn;
            let d2 = dx * dx + dy * dy;
            if d2 < self.min_pair_d2 {
                continue;
            }
            let g = PairGeom::new(xi, yi, xn, yn, self.w, self.h);
            let mask = self.band_mask(&g);
            if mask == 0 {
                continue;
            }
            let pair_idx = self.pairs.len() as u32;
            let mut p = Pair {
                i,
                j: n,
                geom: g,
                mx: (xi + xn) * 0.5,
                my: (yi + yn) * 0.5,
                r2: d2 * 0.25,
                band_mask: mask,
                n_int: 0,
            };
            self.interior.resize(self.interior.len() + self.cap, 0);
            let base = pair_idx as usize * self.cap;
            for k in 0..n {
                if k == i {
                    continue;
                }
                if (p.n_int as usize) >= self.cap {
                    break;
                }
                let ex = x[k as usize] - p.mx;
                let ey = y[k as usize] - p.my;
                if ex * ex + ey * ey <= p.r2 {
                    self.interior[base + p.n_int as usize] = k;
                    p.n_int += 1;
                }
            }
            for u in 0..p.n_int as usize {
                for v in (u + 1)..p.n_int as usize {
                    self.quad_buf.push(QuadItem {
                        p0: i,
                        p1: n,
                        c: self.interior[base + u],
                        d: self.interior[base + v],
                        pair_idx,
                    });
                }
            }
            self.pairs.push(p);
        }

        // canonical within-step order: pair asc, subset lex (c < d always holds — interior
        // members are stored in arrival = rank order)
        self.quad_buf.sort_unstable_by_key(|q| (q.p0, q.p1, q.c, q.d));
    }

    /// Default (det-quad-major) activation step for pool rank n: enumerate this rank's quads
    /// then CODE each immediately against all its compatible bands in sweep order (band
    /// inner). Byte-identical to the pre-refactor path (the enumeration moved into
    /// `enumerate_into_quad_buf`; the process loop is unchanged).
    fn activate(&mut self, n: u32, index: Option<&QuadIndex>, sink: &mut dyn CandidateSink) {
        self.enumerate_into_quad_buf(n);
        let buf = std::mem::take(&mut self.quad_buf);
        for q in &buf {
            self.process_quad(q, sink);
            if self.pending.len() >= PENDING_FLUSH {
                self.flush(index, sink);
            }
            // Break the coding sweep the instant an accept is confirmed (flag-gated). A
            // freeze can only be reported from inside a flush's drain, so this fires only
            // after a flush above (this iteration or a prior one) confirmed the accept.
            if self.abort_now(&*sink) {
                self.aborted = true;
                break;
            }
        }
        self.quad_buf = buf;
    }

    /// Code + queue probes for one enumerated quad across its pair's compatible bands.
    fn process_quad(&mut self, q: &QuadItem, sink: &mut dyn CandidateSink) {
        let seq = self.quad_seq;
        self.quad_seq += 1;
        self.total_quads += 1;
        let ids = |p: u32| self.prep.det_id[p as usize];
        let det_enum = [ids(q.p0), ids(q.p1), ids(q.c), ids(q.d)];
        sink.on_quad(seq, det_enum);

        let pool = [q.p0, q.p1, q.c, q.d];
        let pts: [(f64, f64); 4] = [
            (self.prep.x[q.p0 as usize], self.prep.y[q.p0 as usize]),
            (self.prep.x[q.p1 as usize], self.prep.y[q.p1 as usize]),
            (self.prep.x[q.c as usize], self.prep.y[q.c as usize]),
            (self.prep.x[q.d as usize], self.prep.y[q.d as usize]),
        ];
        let r2max = pool
            .iter()
            .map(|&p| self.r2_px[p as usize])
            .fold(0.0f64, f64::max);
        let pair = self.pairs[q.pair_idx as usize];
        let mask = pair.band_mask;

        // Lazy re-tangent coding in policy sweep order: a band's code is computed ONLY when
        // the sweep reaches it (never precomputed across bands). Ascending sweep = identity
        // ⇒ the frozen (band asc, sample asc, parity asc) coded stream, bit-for-bit.
        let sweep = self.band_sweep;
        for si in 0..self.bands.len() {
            let bi = sweep[si] as usize;
            if mask & (1u16 << bi) == 0 {
                continue;
            }
            self.code_band(seq, pool, &pts, r2max, &pair.geom, bi, sink);
        }
    }

    /// Code one enumerated quad against ONE band `bi` (the caller has already checked band
    /// compatibility against the pair mask): sample scales, re-tangent-code each sample ×
    /// parity, push pendings, queue probe keys into `blocks[bi]`, and bump the per-band coder
    /// counters. Shared by the default det-quad-major `process_quad` (called per band in
    /// sweep order, band-inner) and the BAND-MAJOR path (called band-outer, one band across
    /// all materialized quads). `pool` = enumeration ids [p0,p1,c,d]; `pts` their pixel
    /// coords; `r2max` the max frame-center |P|²; `g` the pair geometry (sample_scales basis).
    /// The per-band counter increments are order-independent sums, so band-outer vs band-inner
    /// call order yields identical totals (only unreached bands after an abort differ).
    #[allow(clippy::too_many_arguments)]
    fn code_band(
        &mut self,
        seq: u64,
        pool: [u32; 4],
        pts: &[(f64, f64); 4],
        r2max: f64,
        g: &PairGeom,
        bi: usize,
        sink: &mut dyn CandidateSink,
    ) {
        self.counters[bi].det_quads += 1;
        let ss = sample_scales(
            g,
            self.bands[bi].lo_deg,
            self.bands[bi].hi_deg,
            r2max,
            self.tol,
            self.s_lo,
            self.s_hi,
        );
        match ss.n_distinct {
            1 => self.counters[bi].samples_one += 1,
            2 => self.counters[bi].samples_two += 1,
            _ => self.counters[bi].samples_multi += 1,
        }
        if ss.capped {
            self.counters[bi].samples_capped += 1;
        }
        for si in 0..ss.n_distinct as usize {
            let s = ss.scales[si];
            let Some(coded) = code_quad_at_scale(pts, self.w, self.h, s, &mut self.coder_scratch)
            else {
                self.counters[bi].coder_rejected += 1;
                continue;
            };
            let det_canon = [
                self.prep.det_id[pool[coded.canon[0] as usize] as usize],
                self.prep.det_id[pool[coded.canon[1] as usize] as usize],
                self.prep.det_id[pool[coded.canon[2] as usize] as usize],
                self.prep.det_id[pool[coded.canon[3] as usize] as usize],
            ];
            for parity in 0u8..2 {
                let code = if parity == 0 { coded.code } else { mirror_code(&coded.code) };
                sink.on_coded(seq, det_canon, bi as u32, parity, si as u8, s, &code);
                let slot = self.pending.len() as u32;
                self.pending.push(Pending {
                    quad_seq: seq,
                    det_ids: det_canon,
                    band: bi as u32,
                    parity,
                    sample: si as u8,
                    s,
                    code,
                });
                let r = coder::code_key_ranges(&code, self.tol);
                for b0 in r[0].0..=r[0].1 {
                    for b1 in r[1].0..=r[1].1 {
                        for b2 in r[2].0..=r[2].1 {
                            for b3 in r[3].0..=r[3].1 {
                                let key = ((b0 * coder::NBINS + b1) * coder::NBINS + b2)
                                    * coder::NBINS
                                    + b3;
                                self.blocks[bi].push(key, slot);
                            }
                        }
                    }
                }
            }
        }
    }

    /// BAND-MAJOR rung body (flag-gated; the default path never enters here). Two phases:
    ///   Phase 1 — enumerate the rung's det-quads ONCE (identical enumeration + pair/interior
    ///     mutation and canonical `quad_seq` assignment to the default path — geometry only, no
    ///     coding ⇒ no accept can fire) and materialize (QuadItem, seq) into `rung_quads`.
    ///   Phase 2 — code + probe + verify bands COARSE→FINE (descending band index), one band
    ///     fully drained (single-band flush ⇒ per-band verification) before any finer band is
    ///     coded. Under `abort_on_accept`, a confirmed accept at a coarse band stops the band
    ///     sweep so finer bands (and, past the accepting band, any remaining quads) are never
    ///     coded. With abort off, all compatible bands are coded coarse-first and drain
    ///     cheaply once frozen (decision-neutral).
    fn run_rung_band_major(
        &mut self,
        rank_start: usize,
        rank_end: usize,
        index: Option<&QuadIndex>,
        sink: &mut dyn CandidateSink,
    ) {
        // ── Phase 1: enumerate + materialize (no coding/probing ⇒ no freeze here) ──
        self.rung_quads.clear();
        for n in rank_start..rank_end {
            self.enumerate_into_quad_buf(n as u32);
            let buf = std::mem::take(&mut self.quad_buf);
            for q in &buf {
                let seq = self.quad_seq;
                self.quad_seq += 1;
                self.total_quads += 1;
                let det_enum = [
                    self.prep.det_id[q.p0 as usize],
                    self.prep.det_id[q.p1 as usize],
                    self.prep.det_id[q.c as usize],
                    self.prep.det_id[q.d as usize],
                ];
                sink.on_quad(seq, det_enum);
                self.rung_quads.push(MatQuad { q: *q, seq });
            }
            self.quad_buf = buf;
        }

        // ── Phase 2: band-outer coding, coarse → fine (descending band index) ──
        let quads = std::mem::take(&mut self.rung_quads);
        let n_bands = self.bands.len();
        'bands: for bi in (0..n_bands).rev() {
            let band_bit = 1u16 << bi;
            for mq in &quads {
                let q = mq.q;
                let pair = self.pairs[q.pair_idx as usize];
                if pair.band_mask & band_bit == 0 {
                    continue;
                }
                let pool = [q.p0, q.p1, q.c, q.d];
                let pts: [(f64, f64); 4] = [
                    (self.prep.x[q.p0 as usize], self.prep.y[q.p0 as usize]),
                    (self.prep.x[q.p1 as usize], self.prep.y[q.p1 as usize]),
                    (self.prep.x[q.c as usize], self.prep.y[q.c as usize]),
                    (self.prep.x[q.d as usize], self.prep.y[q.d as usize]),
                ];
                let r2max = pool
                    .iter()
                    .map(|&p| self.r2_px[p as usize])
                    .fold(0.0f64, f64::max);
                self.code_band(mq.seq, pool, &pts, r2max, &pair.geom, bi, sink);
                // Single-band flush at the pending threshold: `pending`/`blocks` only ever
                // hold THIS band (all finer bands' blocks are empty), so a mid-band flush is
                // still single-band. `flush` sets `self.aborted` on a confirmed accept when
                // abort_on_accept is on.
                if self.pending.len() >= PENDING_FLUSH {
                    self.flush(index, sink);
                    if self.aborted {
                        break 'bands;
                    }
                }
            }
            // Drain this band's remaining pending (single-band ⇒ per-band verification), then
            // check abort before coding any finer band.
            self.flush(index, sink);
            if self.aborted {
                break;
            }
        }
        self.rung_quads = quads;
    }

    /// Probe the queued (key, slot) blocks against the index, collect in-tolerance hits,
    /// emit them to the sink in CANONICAL order, and reset the block scratch. Pendings are
    /// a contiguous quad_seq range, so per-flush canonical sorting composes to a globally
    /// canonical stream.
    fn flush(&mut self, index: Option<&QuadIndex>, sink: &mut dyn CandidateSink) {
        if self.pending.is_empty() {
            return;
        }
        if let Some(idx) = index {
            let tol2 = self.tol * self.tol;
            let Self { blocks, pending, counters, hits_buf, probe_wall_ns, timer_calls, .. } =
                self;
            for (bi, block) in blocks.iter_mut().enumerate() {
                if block.is_empty() {
                    continue;
                }
                // Phase-0 per-band probe/coding SWEEP wall (telemetry; 2 Instant reads/band).
                let t_probe = std::time::Instant::now();
                let band = idx.band(bi as u32);
                block.sort();
                let ctr = &mut counters[bi];
                block.sweep(band, |slot, row_start, count| {
                    ctr.probes += 1;
                    if count == 0 {
                        return;
                    }
                    ctr.raw_hits += count as u64;
                    let p = &pending[slot as usize];
                    for r in row_start..row_start + count as u64 {
                        let row = band.row(r);
                        let d0 = p.code[0] - row.code[0] as f64;
                        let d1 = p.code[1] - row.code[1] as f64;
                        let d2 = p.code[2] - row.code[2] as f64;
                        let d3 = p.code[3] - row.code[3] as f64;
                        let dist2 = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
                        if dist2 <= tol2 {
                            ctr.in_tol_hits += 1;
                            hits_buf.push(CandidateHit {
                                det_ids: p.det_ids,
                                band: p.band,
                                cat_row: r,
                                parity: p.parity,
                                sample: p.sample,
                                code_dist2: dist2,
                                s_sample: p.s,
                                quad_seq: p.quad_seq,
                            });
                        }
                    }
                });
                probe_wall_ns[bi] += t_probe.elapsed().as_nanos() as u64;
                *timer_calls += 2;
            }
            // Canonical hit-emission order. The `band` key is the POLICY sweep rank (Copy
            // array; Ascending ⇒ rank == band index ⇒ the frozen order). Coarse/cheapest
            // policies verify their preferred bands first within a quad_seq.
            let band_rank = self.band_rank;
            self.hits_buf.sort_unstable_by(|a, b| {
                (a.quad_seq, a.parity, band_rank[a.band as usize], a.sample, a.cat_row).cmp(
                    &(b.quad_seq, b.parity, band_rank[b.band as usize], b.sample, b.cat_row),
                )
            });
            // Deferred batched drain. Hits are quad-major sorted (NOT band-contiguous), so
            // VERIFY wall is attributed PER-HIT to `h.band`. The first hit observed AFTER the
            // sink reports a confirmed freeze snapshots the per-band counters flush-exact.
            let abort_on_accept = self.policy.abort_on_accept;
            let Self {
                hits_buf, verify_wall_ns, timer_calls, counters, at_accept_counters, aborted, ..
            } = self;
            for h in hits_buf.iter() {
                let t_verify = std::time::Instant::now();
                sink.on_hit(h);
                verify_wall_ns[h.band as usize] += t_verify.elapsed().as_nanos() as u64;
                *timer_calls += 2;
                if at_accept_counters.is_none() && sink.froze_confirmed() {
                    *at_accept_counters = Some(counters.clone());
                }
                // Flag-gated abort: stop draining the remaining in-tol hits of this flush the
                // instant the accept is confirmed. `at_accept_counters` is snapshotted just
                // above on the same confirming hit, so the Phase-0 flush-exact snapshot is
                // still taken before the break.
                if abort_on_accept && sink.froze_confirmed() {
                    *aborted = true;
                    break;
                }
            }
            hits_buf.clear();
        }
        for b in &mut self.blocks {
            b.clear();
        }
        self.pending.clear();
    }
}

/// Pending-entry flush threshold (bounds probe-block memory; ~72 B/entry).
const PENDING_FLUSH: usize = 8192;
