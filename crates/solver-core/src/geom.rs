//! Sphere/tangent-plane geometry — BIT-FAITHFUL f64 ports of the builder's
//! `rest-integration/tools/solverkit/band_hash.mjs` (:20-46).
//!
//! CONFORMANCE CONTRACT (M2, plan rev 2): identical formulas AND operation
//! order to the JS source of truth so the g15u release's stored quad codes are
//! reproducible bit-exactly (after the same f32 narrowing the builder applied).
//! Any change here must re-pass tests/m2_coder_conformance.rs (stored-byte
//! golden vectors).
//!
//! Known residual divergence risks (escalation-ruled, never loosened):
//!   - JS `Math.hypot(x,y,z)` in `meanRaDec` uses V8's compensated/scaled
//!     algorithm; we use the plan-prescribed naive `(x²+y²+z²).sqrt()`. May
//!     differ by ~1 ulp in f64; flagged LIBM_ULP if it ever flips a stored f32
//!     or a code_key bin.
//!   - JS trig (V8 fdlibm) vs Rust/MSVC libm may differ by ≤1 ulp. Same rule.
//!
//! LAW 1: COORDINATE-ledger math only (functions over positions; no pixels).

use solver_contracts::coordinates::{SkyDeg, TangentDeg, UnitVec3};

/// Degrees → radians factor, exactly as JS `common.mjs` computes it
/// (`Math.PI / 180`; identical IEEE-754 double here).
pub const D2R: f64 = std::f64::consts::PI / 180.0;

/// JS-truthiness clamp port of band_hash.mjs `clamp` (:17):
/// `(x < lo ? lo : x > hi ? hi : x)` — NaN passes through (both compares false).
#[inline]
fn clamp_js(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

/// band_hash.mjs `unitVec` (:20-23): unit direction from (ra_deg, dec_deg).
/// Component order and operation order identical: r = ra*D2R, d = dec*D2R,
/// cd = cos(d); [cd*cos(r), cd*sin(r), sin(d)].
#[inline]
pub fn unit_vec(ra_deg: f64, dec_deg: f64) -> UnitVec3 {
    let r = ra_deg * D2R;
    let d = dec_deg * D2R;
    let cd = d.cos();
    UnitVec3 { x: cd * r.cos(), y: cd * r.sin(), z: d.sin() }
}

/// band_hash.mjs `dotDeg` (:24-26): great-circle separation in DEGREES.
/// `acos(clamp(dot, -1, 1)) / D2R` with the exact left-to-right dot sum
/// `u.x*v.x + u.y*v.y + u.z*v.z`.
#[inline]
pub fn dot_deg(u: &UnitVec3, v: &UnitVec3) -> f64 {
    let dot = u.x * v.x + u.y * v.y + u.z * v.z;
    clamp_js(dot, -1.0, 1.0).acos() / D2R
}

/// band_hash.mjs `meanRaDec` (:28-35): mean sky direction of a star list
/// (unit-vector sum IN LIST ORDER — summation order is part of the contract —
/// normalized, RA-wrap safe).
///
/// JS normalizes by `Math.hypot(x, y, z) || 1`; per the plan we use the naive
/// `(x*x + y*y + z*z).sqrt()` (see module header for the ulp caveat). The
/// `|| 1` JS-falsy fallback (0 or NaN → 1) is ported explicitly.
pub fn mean_ra_dec(stars: &[SkyDeg]) -> SkyDeg {
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    for s in stars {
        let u = unit_vec(s.ra, s.dec);
        x += u.x;
        y += u.y;
        z += u.z;
    }
    let n = (x * x + y * y + z * z).sqrt();
    let n = if n == 0.0 || n.is_nan() { 1.0 } else { n }; // JS `|| 1`
    x /= n;
    y /= n;
    z /= n;
    let dec = clamp_js(z, -1.0, 1.0).asin() / D2R;
    let mut ra = y.atan2(x) / D2R;
    if ra < 0.0 {
        ra += 360.0;
    }
    SkyDeg { ra, dec }
}

/// band_hash.mjs `gnomonic` (:39-46): standard gnomonic projection about
/// (ra0, dec0), inputs and outputs in DEGREES (the builder convention — the
/// `/ D2R` on output is part of the stored-code contract). Returns `None`
/// behind the tangent point via the exact `cosc <= 1e-6` guard.
#[inline]
pub fn gnomonic(ra_deg: f64, dec_deg: f64, ra0_deg: f64, dec0_deg: f64) -> Option<TangentDeg> {
    let ra = ra_deg * D2R;
    let dec = dec_deg * D2R;
    let ra0 = ra0_deg * D2R;
    let dec0 = dec0_deg * D2R;
    let sd = dec.sin();
    let cd = dec.cos();
    let sd0 = dec0.sin();
    let cd0 = dec0.cos();
    let dra = ra - ra0;
    let cdra = dra.cos();
    let sdra = dra.sin();
    let cosc = sd0 * sd + cd0 * cd * cdra;
    if cosc <= 1e-6 {
        return None;
    }
    Some(TangentDeg {
        x: (cd * sdra) / cosc / D2R,
        y: (cd0 * sd - sd0 * cd * cdra) / cosc / D2R,
    })
}
