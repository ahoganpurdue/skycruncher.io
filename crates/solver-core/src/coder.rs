//! Canonical quad coder — BIT-FAITHFUL port of the production JS coder
//! `rest-integration/tools/quadindex/coder.mjs buildQuadCodes` (:112-165) plus
//! the index quantisation `codeBin`/`codeKey` from
//! `rest-integration/tools/quadindex/build_quad_index.mjs` (:339-346).
//!
//! This is the single most correctness-critical lane in the program: an index
//! built with one convention and queried with another silently misses every
//! true match (the classic quad-index bug). The g15u release's stored codes
//! are the golden vectors (tests/m2_coder_conformance.rs) — the conformance
//! check the legacy stack never had (ledger row 20).
//!
//! CONVENTIONS (the shared-coder ones; NOT band_hash.mjs's divergent widest-
//! pair/B→(1,1) `quadCode`, which must never be ported):
//!   - enumerate pairs i<j; pair admitted iff separation² ∈ [sepMin², sepMax²]
//!     (JS rejects on `d2 < sepMin2 || d2 > sepMax2` — boundaries INCLUDED);
//!   - interior = other points with (P−mid)² <= d²/4 (<= INCLUSIVE);
//!   - fewer than 2 interior → no quads for this pair;
//!   - more than capInterior → stable-sort by w DESC (JS Array.sort is stable;
//!     ties keep interior-array order) and truncate;
//!   - complex basis z(p) = (p−A)/(B−A) via the exact dot/cross forms with
//!     inv = 1/d² computed once per pair;
//!   - every interior 2-subset (u<v in interior-array order) is one quad;
//!   - fold iff cx+dx > 1 STRICT (swap A/B; (cx,cy,dx,dy)→(1−cx,−cy,1−dx,−dy));
//!   - C/D swap iff dx < cx STRICT;
//!   - emit f64 code [cx,cy,dx,dy] + ids (ai,bi,ci,di).
//!
//! f32 narrowing happens ONLY at comparison/storage boundaries (`as f32` =
//! round-to-nearest-even, matching JS `Float32Array` assignment). `code_key`
//! is ALWAYS computed from the F64 code (the builder did; never from f32).
//!
//! LAW 1: COORDINATE-ledger math. No I/O, no env, no units knowledge.

/// Code-space bounds (coder.mjs :62-63): interior C,D live in ≈[−0.5, 1.5].
pub const CODE_LO: f64 = -0.5;
/// See [`CODE_LO`].
pub const CODE_HI: f64 = 1.5;
/// The a-priori 4D code-space match tolerance (coder.mjs :65, LAW-2 frozen).
pub const DEFAULT_CODE_TOL: f64 = 0.015;
/// The g15u release's quantisation bin count (manifest `schema.nbins`).
pub const NBINS: i32 = 128;

/// A planar point with brightness weight (w = flux or −mag; higher = brighter).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointW {
    pub x: f64,
    pub y: f64,
    pub w: f64,
}

/// One emitted quad: canonical post-fold code + point indices in canonical
/// A,B,C,D order (indices into the input `pts` slice) — exactly what the JS
/// coder's parallel `codes`/`quads` arrays carry per quad.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuadCode {
    /// Canonical f64 code [cx, cy, dx, dy].
    pub code: [f64; 4],
    /// Canonical A,B,C,D indices into the input point slice.
    pub ids: [u32; 4],
}

impl QuadCode {
    /// Storage/comparison narrowing: `as f32` = IEEE round-to-nearest-even,
    /// identical to a JS `Float32Array` assignment (what `encodeBand` stored).
    #[inline]
    pub fn code_f32(&self) -> [f32; 4] {
        [self.code[0] as f32, self.code[1] as f32, self.code[2] as f32, self.code[3] as f32]
    }
}

/// BIT-FAITHFUL port of coder.mjs `buildQuadCodes` (:112-165).
///
/// Appends every emitted quad to `out` (cleared first; capacity is reused —
/// callers on the hot path pass a pre-sized scratch Vec). Emission order is
/// the JS order: pair (i<j) outer loops, interior 2-subset (u<v) inner loops.
///
/// `sep_min = 0.0`, `sep_max = f64::INFINITY`, `cap_interior = 2` reproduces
/// the builder call `codeQuad4` (build_quad_index.mjs :324-336) exactly: with
/// 4 points the interior can hold at most 2, so the cap branch never binds.
pub fn build_quad_codes(
    pts: &[PointW],
    sep_min: f64,
    sep_max: f64,
    cap_interior: usize,
    out: &mut Vec<QuadCode>,
) {
    out.clear();
    let n = pts.len();
    let sep_min2 = sep_min * sep_min;
    let sep_max2 = sep_max * sep_max;
    // Scratch reused across pairs; small (≤ n) — allocation cost amortizes to
    // zero on the hot path because capacity persists across pair iterations.
    let mut interior: Vec<u32> = Vec::with_capacity(n);
    for i in 0..n {
        let a = pts[i];
        for j in (i + 1)..n {
            let b = pts[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            // JS :123 — strict rejects, so exact-boundary separations are KEPT.
            if d2 < sep_min2 || d2 > sep_max2 {
                continue;
            }
            // interior of the circle with diameter AB (JS :125-133; <= inclusive)
            let mx = (a.x + b.x) / 2.0;
            let my = (a.y + b.y) / 2.0;
            let r2 = d2 / 4.0;
            interior.clear();
            for k in 0..n {
                if k == i || k == j {
                    continue;
                }
                let p = pts[k];
                let ex = p.x - mx;
                let ey = p.y - my;
                if ex * ex + ey * ey <= r2 {
                    interior.push(k as u32);
                }
            }
            if interior.len() < 2 {
                continue;
            }
            if interior.len() > cap_interior {
                // JS :136 `interior.sort((a,b) => pts[b].w - pts[a].w)` — a
                // STABLE sort by w descending; ties keep interior-array
                // (ascending-k) order. Rust's sort_by is stable; the
                // comparator returns Equal exactly when the JS comparator
                // returns 0 (finite w assumed, as in the JS lane).
                interior.sort_by(|&p, &q| {
                    pts[q as usize].w.partial_cmp(&pts[p as usize].w).unwrap_or(std::cmp::Ordering::Equal)
                });
                interior.truncate(cap_interior);
            }
            // complex basis: z(p) = (p - A) / (B - A)   (JS :139-142)
            let inv = 1.0 / d2; // 1/|B-A|² — computed ONCE per pair
            let zx = |p: &PointW| ((p.x - a.x) * dx + (p.y - a.y) * dy) * inv;
            let zy = |p: &PointW| ((p.y - a.y) * dx - (p.x - a.x) * dy) * inv;
            for u in 0..interior.len() {
                for v in (u + 1)..interior.len() {
                    let mut ci = interior[u];
                    let mut di = interior[v];
                    let mut cx = zx(&pts[ci as usize]);
                    let mut cy = zy(&pts[ci as usize]);
                    let mut dx2 = zx(&pts[di as usize]);
                    let mut dy2 = zy(&pts[di as usize]);
                    let mut ai = i as u32;
                    let mut bi = j as u32;
                    // canon 1 (JS :150-153): fold iff cx+dx > 1 STRICT
                    // (cx+dx exactly 1 → NO fold).
                    if cx + dx2 > 1.0 {
                        ai = j as u32;
                        bi = i as u32;
                        cx = 1.0 - cx;
                        cy = -cy;
                        dx2 = 1.0 - dx2;
                        dy2 = -dy2;
                    }
                    // canon 2 (JS :155-157): order C,D by code x — swap iff
                    // dx < cx STRICT (dx == cx → NO swap).
                    if dx2 < cx {
                        std::mem::swap(&mut cx, &mut dx2);
                        std::mem::swap(&mut cy, &mut dy2);
                        std::mem::swap(&mut ci, &mut di);
                    }
                    out.push(QuadCode { code: [cx, cy, dx2, dy2], ids: [ai, bi, ci, di] });
                }
            }
        }
    }
}

/// build_quad_index.mjs `codeBin` (:339-342): quantise one f64 code component
/// to a bin in [0, NBINS-1]. `floor(((v − CODE_LO) / (CODE_HI − CODE_LO)) ·
/// nbins)`, clamped (bin-edge clamp at 0/127, NO wrap). The divisor (2.0) and
/// nbins (128) are exact powers of two, so no rounding enters the scaling —
/// JS and Rust agree bit-for-bit.
#[inline]
pub fn code_bin(v: f64) -> i32 {
    let b = ((v - CODE_LO) / (CODE_HI - CODE_LO) * NBINS as f64).floor();
    // JS clamps AFTER floor: b < 0 ? 0 : b >= nbins ? nbins - 1 : b.
    if b < 0.0 {
        0
    } else if b >= NBINS as f64 {
        NBINS - 1
    } else {
        b as i32
    }
}

/// build_quad_index.mjs `codeKey` (:343-346): mixed-radix base-128 key over
/// [cx, cy, dx, dy] — ALWAYS computed from the F64 code (the builder fed
/// `c.code` f64 values; feeding the stored f32 back in can land in a
/// neighbouring bin and is a conformance bug). Max 128⁴−1 = 268 435 455 < 2³¹.
#[inline]
pub fn code_key(code: &[f64; 4]) -> i32 {
    let b0 = code_bin(code[0]);
    let b1 = code_bin(code[1]);
    let b2 = code_bin(code[2]);
    let b3 = code_bin(code[3]);
    ((b0 * NBINS + b1) * NBINS + b2) * NBINS + b3
}

/// Per-dimension neighbour cell range for codeTol probing: the inclusive bin
/// interval [bin(v − tol), bin(v + tol)]. `code_bin`'s clamp gives the 0/127
/// no-wrap edge behaviour (explicit test case). The grid may only
/// OVER-generate — the exact 4D Euclidean ≤ tol test is always final
/// (coder.mjs invariant; assertBucketPrefilterSafe: 128 ≤ 133 admissible at
/// tol 0.015).
#[inline]
pub fn code_bin_range(v: f64, tol: f64) -> (i32, i32) {
    (code_bin(v - tol), code_bin(v + tol))
}

/// The four per-dimension probe ranges for one f64 code.
#[inline]
pub fn code_key_ranges(code: &[f64; 4], tol: f64) -> [(i32, i32); 4] {
    [
        code_bin_range(code[0], tol),
        code_bin_range(code[1], tol),
        code_bin_range(code[2], tol),
        code_bin_range(code[3], tol),
    ]
}
