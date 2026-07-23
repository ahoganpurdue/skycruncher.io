//! hypo — pose hypothesis from a candidate quad hit: sphere-true rotation fit + TAN WCS
//! derivation + the cost-ascending cheap gates (M4b lane).
//!
//! GEOMETRY (plan rev 2 §Hypothesis construction — "no flat-plane fit"):
//! The 4 image detections are unprojected AT THE HYPOTHESIS SCALE about the frame center
//! into unit vectors on an abstract sphere; the pose is a pure 3D ROTATION mapping those
//! onto the 4 catalog unit vectors (from stars.arrow f64 — NEVER the stored f32 codes).
//! A flat similarity fit re-imports the gnomonic-curvature defect (§0: 34.1% in-tol
//! ceiling on an 86° frame); the rotation-on-the-sphere fit does not.
//!
//! DETECTION PLANE CONVENTION (must match M4a's quadgen coding convention):
//!   u = (x − W/2)·s,  v = (y − H/2)·s   [degrees; s = deg/px; x,y 0-based y-down px]
//!   parity 1 ⇒ v := −v BEFORE unprojection.
//! Equivalence note: quadgen realises parity 1 by negating code components 1 and 3
//! (cy, dy) of the flat code — that is exactly coding the point set {(u, −v)} because the
//! canonical coder's fold/order predicates read x only and the y components enter the code
//! linearly (plan rev 2, Fable-confirmed). Negating v before unprojection therefore
//! reconstructs the SAME planar point set whose code matched, so the vertex-preserving
//! A,B,C,D correspondence carries over unchanged.
//!
//! Unprojection = inverse gnomonic about the abstract pole P = (ra 0, dec 0) = (1,0,0),
//! with east basis E = (0,1,0) and north basis N = (0,0,1):
//!   dir(u, v) = normalize(1, u·D2R, v·D2R)
//! (exact inverse of `geom::gnomonic` about (0,0) — gnomonic x = (w.y/w.x)/D2R etc.).
//!
//! HYPOTHESIS SCALE (resolved ambiguity — recorded for the M4b report): the pose is fit at
//! the ABSCALE-IMPLIED scale s_impl solving sep_AB(s) = stored diam_deg, seeded from the
//! candidate's sampled scale. s_sample exists to control unprojection CURVATURE during
//! coding (bands sample √(lo·hi)); the matched catalog quad's diam_deg can sit anywhere in
//! the √2 annulus, so a pose fit AT s_sample would carry up to ±19% scale error — dead on
//! arrival at a 3 px-sigma verify on a 5796 px frame. a.net has no sampled scale at all:
//! scale emerges from the matched correspondence. s_impl is that emergence, computed
//! sky-true from the AB pair.
//!
//! ROTATION FIT (cited method): Wahba's problem for 4 equal-weight correspondences.
//! We use the closed-form mean-align + optimal-spin construction:
//!   R0 aligns mean(det dirs) onto mean(cat dirs) (Rodrigues);
//!   the residual freedom is a spin φ about the mean axis a, and the alignment score
//!   A cosφ + B sinφ + C(1−cosφ) is maximized in closed form at φ = atan2(B, A−C).
//! This is exact in the noise-free limit (the true rotation maps mean to mean), fully
//! deterministic, and deviates from the Davenport/Horn q-method optimum only at
//! O(residual²) — immaterial for a PROPOSAL that is immediately verified and later
//! LS-refined on many matches. The q-method itself (Davenport 1968; Horn JOSA-A 1987)
//! was rejected here because its 4×4 eigenproblem develops a near-degenerate eigenpair
//! (gap ≈ 2·Σρᵢ², ρ = angular radius of the quad) precisely for the narrow-band quads
//! this index is full of, making iterative eigensolvers slow or imprecise exactly where
//! the solver lives. The <1e-9 px round-trip gate (tests/m4b_hypo.rs) pins exactness.
//!
//! TAN DERIVATION (exact, not first-order): gnomonic projection commutes with rotation,
//! so the derived TAN WCS reproduces the rotated sphere PROJECTIVELY exactly:
//!   CRVAL = R·P;  CRPIX = frame center (0-based);  CD = M·diag(s, σ·s)
//! where M is the 2×2 tangent-basis rotation [E'·RE, E'·RN; N'·RE, N'·RN] (E',N' = east/
//! north at CRVAL) and σ = +1 (parity 0) / −1 (parity 1). det(CD) = σ·s² ⇒ parity bit 1
//! ⇔ parity_sign() = −1 under this convention — IDENTICAL to M4a's pinned convention
//! (m4a_synthetic.rs: "det(CD) > 0 → parity 0; < 0 → parity 1", camera-variant test).
//! ORACLE LABEL MAPPING (M4a measurement, hit-density desk check): the a.net oracle
//! label "parity 1" (CSM30799) produces hits on OUR parity 0 (470 vs 0) — a.net's parity
//! is stated in a FITS y-up frame, ours in the y-down detection frame, so the labels
//! INVERT: anet parity 1 ↔ our parity 0 ↔ det(CD) > 0. M5's prereg criterion
//! (sign(det(CD)) vs oracle parity) must apply this mapping at the LABEL layer; a
//! systematic flip there is a convention-mapping bug, never a geometry edit.
//!
//! LAW 1: COORDINATE-ledger math only. No I/O, no env reads (crate-wide grep-guard).

use solver_contracts::coordinates::{PixelXY, SkyDeg, TanWcs, UnitVec3};

use crate::geom::{self, D2R};

// ───────────────────────────────────────────────────────────────────────────
// small fixed-size linear algebra (f64, deterministic, no deps)
// ───────────────────────────────────────────────────────────────────────────

/// Row-major 3×3 matrix.
pub type Mat3 = [[f64; 3]; 3];

#[inline]
fn mat_vec(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

#[inline]
fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

#[inline]
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn norm3(a: [f64; 3]) -> f64 {
    dot3(a, a).sqrt()
}

#[inline]
fn normalize3(a: [f64; 3]) -> Option<[f64; 3]> {
    let n = norm3(a);
    if !(n > 0.0) || !n.is_finite() {
        return None;
    }
    Some([a[0] / n, a[1] / n, a[2] / n])
}

/// Rodrigues rotation about UNIT axis `k` by angle with the given (sin, cos).
/// R = I·c + sinφ·K + (1−c)·kkᵀ.
fn rot_axis_sincos(k: [f64; 3], s: f64, c: f64) -> Mat3 {
    let omc = 1.0 - c;
    [
        [
            c + k[0] * k[0] * omc,
            k[0] * k[1] * omc - k[2] * s,
            k[0] * k[2] * omc + k[1] * s,
        ],
        [
            k[1] * k[0] * omc + k[2] * s,
            c + k[1] * k[1] * omc,
            k[1] * k[2] * omc - k[0] * s,
        ],
        [
            k[2] * k[0] * omc - k[1] * s,
            k[2] * k[1] * omc + k[0] * s,
            c + k[2] * k[2] * omc,
        ],
    ]
}

// ───────────────────────────────────────────────────────────────────────────
// unprojection / projection primitives
// ───────────────────────────────────────────────────────────────────────────

/// Detection-plane coordinates (DEGREES) of a pixel at hypothesis scale `s_deg_px`,
/// parity applied (parity 1 negates v BEFORE unprojection — see module header).
#[inline]
pub fn det_plane(x: f64, y: f64, w: f64, h: f64, s_deg_px: f64, parity: u8) -> (f64, f64) {
    let u = (x - w / 2.0) * s_deg_px;
    let mut v = (y - h / 2.0) * s_deg_px;
    if parity == 1 {
        v = -v;
    }
    (u, v)
}

/// Inverse gnomonic about the abstract pole (1,0,0): plane (u,v) in DEGREES → unit vector.
#[inline]
pub fn unproject_about_pole(u_deg: f64, v_deg: f64) -> [f64; 3] {
    // dir ∝ (1, u·D2R, v·D2R); always normalizable (first component 1).
    let y = u_deg * D2R;
    let z = v_deg * D2R;
    let n = (1.0 + y * y + z * z).sqrt();
    [1.0 / n, y / n, z / n]
}

/// General inverse gnomonic: tangent-plane (x,y) in DEGREES about (ra0, dec0) → sky.
/// Exact inverse of `geom::gnomonic` (same conventions: degrees in/out, east/north basis).
pub fn inverse_gnomonic(x_deg: f64, y_deg: f64, ra0_deg: f64, dec0_deg: f64) -> SkyDeg {
    let x = x_deg * D2R;
    let y = y_deg * D2R;
    let (sd0, cd0) = (dec0_deg * D2R).sin_cos();
    // Direction ∝ C + x·E' + y·N' with C the tangent point, E'/N' east/north there.
    // In the frame where C = (cd0, 0, sd0) (ra0 = 0): E' = (0,1,0), N' = (−sd0, 0, cd0).
    let vx = cd0 - y * sd0;
    let vy = x;
    let vz = sd0 + y * cd0;
    let dec = (vz / (vx * vx + vy * vy + vz * vz).sqrt()).clamp(-1.0, 1.0).asin() / D2R;
    let mut ra = ra0_deg + vy.atan2(vx) / D2R;
    // normalize RA into [0, 360)
    ra %= 360.0;
    if ra < 0.0 {
        ra += 360.0;
    }
    SkyDeg { ra, dec }
}

/// Forward TAN projection sky → 0-based pixel through a `TanWcs`.
/// Returns `None` behind the tangent plane (geom's cosc guard) or for a singular CD.
pub fn project_tan(wcs: &TanWcs, sky: SkyDeg) -> Option<PixelXY> {
    let t = geom::gnomonic(sky.ra, sky.dec, wcs.crval.ra, wcs.crval.dec)?;
    let det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let dx = (t.x * wcs.cd[1][1] - t.y * wcs.cd[0][1]) / det;
    let dy = (t.y * wcs.cd[0][0] - t.x * wcs.cd[1][0]) / det;
    Some(PixelXY {
        x: wcs.crpix.x + dx,
        y: wcs.crpix.y + dy,
    })
}

/// Great-circle separation (deg) of two detections unprojected at scale `s` about the
/// frame center (parity-independent: reflection preserves separations).
#[inline]
pub fn det_pair_sep_deg(a: [f64; 2], b: [f64; 2], w: f64, h: f64, s_deg_px: f64) -> f64 {
    let (ua, va) = det_plane(a[0], a[1], w, h, s_deg_px, 0);
    let (ub, vb) = det_plane(b[0], b[1], w, h, s_deg_px, 0);
    let pa = unproject_about_pole(ua, va);
    let pb = unproject_about_pole(ub, vb);
    (dot3(pa, pb).clamp(-1.0, 1.0)).acos() / D2R
}

/// Solve sep_AB(s) = diam_deg for s over the scale window — the abscale-implied
/// hypothesis scale. Delegates to the M4a pair geometry (`PairGeom::solve_scale_for_sep`,
/// extremum-aware: sep(s) is NON-monotone for near-radial wide pairs — quadgen's measured
/// deviation from the plan's monotonicity claim), then verifies the root actually meets
/// the target (a clamped/unreachable solve returns None → AbscaleWindow reject).
///
/// BRANCH CONSISTENCY: when the pair has an interior separation peak and the candidate's
/// own sampled scale lies BEYOND it, the code was computed at falling-branch curvature, so
/// the matching root is sought on the falling branch (local bisection over the public
/// sep function); otherwise the rising-branch root (the ordinary regime) is used.
pub fn implied_scale(
    a: [f64; 2],
    b: [f64; 2],
    w: f64,
    h: f64,
    s_sample: f64,
    diam_deg: f64,
    s_lo: f64,
    s_hi: f64,
) -> Option<f64> {
    if !(diam_deg > 0.0) || !(s_lo > 0.0) || !(s_hi > s_lo) || !s_sample.is_finite() {
        return None;
    }
    let g = crate::quadgen::PairGeom::new(a[0], a[1], b[0], b[1], w, h);
    let met = |s: f64| -> bool {
        let sep = g.sep_deg(s);
        sep.is_finite() && (sep - diam_deg).abs() <= 1e-9 * diam_deg.max(1e-6)
    };

    // falling-branch case: peak inside the window AND the candidate sampled beyond it
    if let Some(tau_p) = g.tau_peak() {
        let s_peak = tau_p / D2R;
        if s_peak > s_lo && s_peak < s_hi && s_sample > s_peak {
            let (mut lo, mut hi) = (s_peak, s_hi);
            let (f_lo, f_hi) = (g.sep_deg(lo), g.sep_deg(hi));
            if diam_deg <= f_lo && diam_deg >= f_hi {
                for _ in 0..80 {
                    let mid = 0.5 * (lo + hi);
                    if g.sep_deg(mid) >= diam_deg {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                let s = 0.5 * (lo + hi);
                return if met(s) { Some(s) } else { None };
            }
            // target not reachable on the falling side — fall through to the rising solve
        }
    }

    let s = g.solve_scale_for_sep(diam_deg, s_lo, s_hi);
    if s.is_finite() && s > 0.0 && met(s) {
        Some(s)
    } else {
        None // clamped to a window edge / the peak: diam unreachable in-window
    }
}

// ───────────────────────────────────────────────────────────────────────────
// rotation fit (Wahba, mean-align + optimal spin — see module header citation)
// ───────────────────────────────────────────────────────────────────────────

/// Best-fit rotation R with R·det[i] ≈ cat[i] (unit vectors, equal weights).
/// Deterministic closed form; None only on degenerate input (zero-mean clusters).
pub fn fit_rotation(det: &[[f64; 3]; 4], cat: &[[f64; 3]; 4]) -> Option<Mat3> {
    let sum4 = |v: &[[f64; 3]; 4]| {
        [
            v[0][0] + v[1][0] + v[2][0] + v[3][0],
            v[0][1] + v[1][1] + v[2][1] + v[3][1],
            v[0][2] + v[1][2] + v[2][2] + v[3][2],
        ]
    };
    let m_d = normalize3(sum4(det))?;
    let m_c = normalize3(sum4(cat))?;

    // R0: rotate m_d onto m_c (Rodrigues; antipodal fallback via an explicit ⊥ axis).
    let k = cross3(m_d, m_c);
    let s = norm3(k);
    let c = dot3(m_d, m_c);
    let r0: Mat3 = if s < 1e-15 {
        if c > 0.0 {
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        } else {
            // antipodal: rotate by π about any axis ⊥ m_d (pick the coordinate axis least
            // aligned with m_d for conditioning; deterministic tie-break by index).
            let ax = m_d[0].abs();
            let ay = m_d[1].abs();
            let az = m_d[2].abs();
            let e = if ax <= ay && ax <= az {
                [1.0, 0.0, 0.0]
            } else if ay <= az {
                [0.0, 1.0, 0.0]
            } else {
                [0.0, 0.0, 1.0]
            };
            let axis = normalize3(cross3(m_d, e))?;
            rot_axis_sincos(axis, 0.0, -1.0)
        }
    } else {
        let axis = [k[0] / s, k[1] / s, k[2] / s];
        rot_axis_sincos(axis, s, c)
    };

    // Optimal spin about a = m_c: maximize Σ cat·R_φ(R0·det) = A cosφ + B sinφ + C(1−cosφ),
    // φ* = atan2(B, A−C). PRECISION: A−C computed literally cancels ~4-magnitude sums and
    // costs ~eps/ρ² of spin accuracy on narrow quads. Exact identities over the components
    // PERPENDICULAR to the axis avoid it entirely:
    //   c·d′ − (c·a)(a·d′) = c⊥·d′⊥      (decompose both along/perp to a)
    //   c·(a×d′)           = c⊥·(a×d′⊥)  (axis components vanish under a×)
    // — O(ρ²) results from O(ρ) factors, full relative precision.
    let a = m_c;
    let (mut ac, mut sb) = (0.0f64, 0.0f64);
    for i in 0..4 {
        let dp = mat_vec(&r0, det[i]);
        let ci = cat[i];
        let ca = dot3(ci, a);
        let da = dot3(dp, a);
        let cp = [ci[0] - ca * a[0], ci[1] - ca * a[1], ci[2] - ca * a[2]];
        let dpp = [dp[0] - da * a[0], dp[1] - da * a[1], dp[2] - da * a[2]];
        ac += dot3(cp, dpp);
        sb += dot3(cp, cross3(a, dpp));
    }
    let phi = sb.atan2(ac);
    let (sphi, cphi) = phi.sin_cos();
    let r_spin = rot_axis_sincos(a, sphi, cphi);
    Some(mat_mul(&r_spin, &r0))
}

// ───────────────────────────────────────────────────────────────────────────
// pose = rotation → TAN WCS
// ───────────────────────────────────────────────────────────────────────────

/// A fitted pose proposal (pre-verification).
#[derive(Debug, Clone, Copy)]
pub struct Pose {
    pub wcs: TanWcs,
    /// The hypothesis scale the pose was fit at (deg/px; abscale-implied).
    pub s_deg_px: f64,
    pub parity: u8,
    /// In-plane rotation angle of the tangent-basis map M, degrees in (−180, 180]
    /// (dedup-ring signature; convention: atan2(M10, M00)).
    pub rot_deg: f64,
    /// Max angular residual of the 4 fitted correspondences, degrees.
    pub max_resid_deg: f64,
    /// CRVAL as a unit vector (dedup-ring center proximity tests).
    pub center: UnitVec3,
}

/// Fit the pose for a candidate: 4 det pixels (canonical A,B,C,D order) ↔ 4 catalog sky
/// positions (same canonical order — `encodeBand` stores star0..3 post-fold, plan §ground
/// truth), at hypothesis scale `s_deg_px` and parity.
pub fn fit_pose(
    det_px: &[[f64; 2]; 4],
    cat_sky: &[SkyDeg; 4],
    w: f64,
    h: f64,
    s_deg_px: f64,
    parity: u8,
) -> Option<Pose> {
    let mut det_u = [[0.0f64; 3]; 4];
    let mut cat_u = [[0.0f64; 3]; 4];
    for i in 0..4 {
        let (u, v) = det_plane(det_px[i][0], det_px[i][1], w, h, s_deg_px, parity);
        det_u[i] = unproject_about_pole(u, v);
        // geom::unit_vec — the builder-convention unit vector (bit-faithful lane).
        let uv = geom::unit_vec(cat_sky[i].ra, cat_sky[i].dec);
        cat_u[i] = [uv.x, uv.y, uv.z];
    }
    let r = fit_rotation(&det_u, &cat_u)?;

    // CRVAL = R·pole = column 0 of R.
    let cvec = mat_vec(&r, [1.0, 0.0, 0.0]);
    let dec = cvec[2].clamp(-1.0, 1.0).asin() / D2R;
    let mut ra = cvec[1].atan2(cvec[0]) / D2R;
    ra %= 360.0;
    if ra < 0.0 {
        ra += 360.0;
    }
    let crval = SkyDeg { ra, dec };

    // Tangent bases: E,N at the pole map to R·E, R·N (columns 1,2 of R); E',N' at CRVAL.
    // E'/N' are derived from the EXACT direction vector (no deg→trig round-trip): with
    // cvec = (x,y,z) unit, cosδ = √(x²+y²), cosα = x/cosδ, sinα = y/cosδ, sinδ = z.
    let re = mat_vec(&r, [0.0, 1.0, 0.0]);
    let rn = mat_vec(&r, [0.0, 0.0, 1.0]);
    let cdc = (cvec[0] * cvec[0] + cvec[1] * cvec[1]).sqrt();
    let (sra, cra) = if cdc > 0.0 {
        (cvec[1] / cdc, cvec[0] / cdc)
    } else {
        (0.0, 1.0) // pole-on tangent point: RA degenerate, pick the α=0 basis
    };
    let sdc = cvec[2];
    let e_p = [-sra, cra, 0.0];
    let n_p = [-sdc * cra, -sdc * sra, cdc];
    let m00 = dot3(e_p, re);
    let m01 = dot3(e_p, rn);
    let m10 = dot3(n_p, re);
    let m11 = dot3(n_p, rn);
    let sigma = if parity == 1 { -1.0 } else { 1.0 };
    let cd = [
        [s_deg_px * m00, sigma * s_deg_px * m01],
        [s_deg_px * m10, sigma * s_deg_px * m11],
    ];
    let wcs = TanWcs {
        crval,
        crpix: PixelXY {
            x: w / 2.0,
            y: h / 2.0,
        },
        cd,
    };

    // Fit residual: max angular error of the 4 correspondences, CHORD form
    // (|a−b| = 2 sin(θ/2) ≈ θ): acos of a near-1 dot has a √ε ≈ 2e-8 rad noise
    // floor and cannot certify exactness; the chord keeps full relative precision
    // at zero and deviates from the true angle only at O(θ³) — immaterial against
    // the gate bound (< 1.5° even for the widest band).
    let mut max_resid = 0.0f64;
    for i in 0..4 {
        let rd = mat_vec(&r, det_u[i]);
        let dx = rd[0] - cat_u[i][0];
        let dy = rd[1] - cat_u[i][1];
        let dz = rd[2] - cat_u[i][2];
        let chord = (dx * dx + dy * dy + dz * dz).sqrt() / D2R;
        if chord > max_resid {
            max_resid = chord;
        }
    }

    Some(Pose {
        wcs,
        s_deg_px,
        parity,
        rot_deg: m10.atan2(m00) / D2R,
        max_resid_deg: max_resid,
        center: UnitVec3 {
            x: cvec[0],
            y: cvec[1],
            z: cvec[2],
        },
    })
}

// ───────────────────────────────────────────────────────────────────────────
// cheap gates (cost-ascending; every rejection lands on a NAMED counter)
// ───────────────────────────────────────────────────────────────────────────

/// Named gate rejections. `counter_name()` is the receipt key
/// (SearchCounters.cheap_gate_rejects); pre-inserted in prepare so the loop never
/// allocates a map key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateReject {
    /// Dedup ring: identical (cat_row, band, parity) already verified recently.
    RingIdentity,
    /// Degenerate abscale inputs (coincident AB, non-finite scale).
    AbscaleDegenerate,
    /// Implied scale outside the (code_tol-widened) blind scale window.
    AbscaleWindow,
    /// scale·diagonal ≥ 150° — implausible field of view.
    Fov,
    /// Rotation-fit degenerate (could not construct R).
    FitDegenerate,
    /// Max correspondence residual above the code-tolerance-derived bound.
    RotResid,
    /// Dedup ring: near-identical pose already verified recently.
    RingPose,
}

impl GateReject {
    pub const ALL: [GateReject; 7] = [
        GateReject::RingIdentity,
        GateReject::AbscaleDegenerate,
        GateReject::AbscaleWindow,
        GateReject::Fov,
        GateReject::FitDegenerate,
        GateReject::RotResid,
        GateReject::RingPose,
    ];

    pub fn counter_name(&self) -> &'static str {
        match self {
            GateReject::RingIdentity => "ring_identity",
            GateReject::AbscaleDegenerate => "abscale_degenerate",
            GateReject::AbscaleWindow => "abscale_window",
            GateReject::Fov => "fov",
            GateReject::FitDegenerate => "fit_degenerate",
            GateReject::RotResid => "rot_resid",
            GateReject::RingPose => "ring_pose",
        }
    }
}

/// Rotation-residual bound factor (PROVISIONAL, derivation — never tuned to pass):
/// the code basis is the AB pair (|AB| = diam), so unit code displacement = diam degrees;
/// a 4-D code distance ≤ tol bounds each interior point's 2-D displacement by tol·diam;
/// the LS rotation redistributes but cannot more than double the max input displacement
/// (mean-shift ≤ max); factor 2 additionally absorbs f32 storage rounding (~1e-7 rel),
/// re-tangent curvature residual (< tol at 2 samples/band, plan §sky-true targeting) and
/// the second-order abscale error. Bound = FACTOR · code_tol · diam_deg.
pub const ROT_RESID_FACTOR: f64 = 2.0;

/// FOV plausibility ceiling (deg): scale·diagonal must stay below this (a gnomonic frame
/// beyond ~150° naive extent is unphysical for any supported optic; audit control flow
/// "reject impossible ... FOV immediately").
pub const FOV_MAX_DEG: f64 = 150.0;

/// Frozen gate parameters (resolved once per solve from SearchPolicy; deg/px units).
#[derive(Debug, Clone, Copy)]
pub struct GateParams {
    pub scale_lo_deg_px: f64,
    pub scale_hi_deg_px: f64,
    pub code_tol: f64,
    pub frame_diag_px: f64,
}

impl GateParams {
    pub fn from_policy(p: &solver_contracts::config::SearchPolicy, w: f64, h: f64) -> Self {
        Self {
            scale_lo_deg_px: p.scale_lo_asec / 3600.0,
            scale_hi_deg_px: p.scale_hi_asec / 3600.0,
            code_tol: p.code_tol,
            frame_diag_px: (w * w + h * h).sqrt(),
        }
    }
}

/// One verified-pose signature in the dedup ring.
#[derive(Debug, Clone, Copy)]
struct RingEntry {
    cat_row: u64,
    band: u32,
    parity: u8,
    center: [f64; 3],
    log_s: f64,
    rot_deg: f64,
}

/// Bounded near-duplicate proposal window over the last `cap` VERIFIED poses
/// (plan: 64). Skips are COUNTED by the caller, never silent.
#[derive(Debug)]
pub struct DupRing {
    entries: Vec<RingEntry>,
    head: usize,
    cap: usize,
}

/// Pose-proximity thresholds (plan rev 2 §cheap gates; PROVISIONAL).
const RING_CENTER_MAX_DEG: f64 = 0.1;
const RING_DLOG_S_MAX: f64 = 0.01;
const RING_DROT_MAX_DEG: f64 = 0.5;

impl DupRing {
    pub fn new(cap: usize) -> Self {
        Self {
            entries: Vec::with_capacity(cap.max(1)),
            head: 0,
            cap: cap.max(1),
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.head = 0;
    }

    /// Pre-pose check: same (cat_row, band, parity) as a recently verified pose.
    #[inline]
    pub fn hit_identity(&self, cat_row: u64, band: u32, parity: u8) -> bool {
        self.entries
            .iter()
            .any(|e| e.cat_row == cat_row && e.band == band && e.parity == parity)
    }

    /// Post-pose check: center < 0.1° ∧ |Δlog s| < 0.01 ∧ |Δrot| < 0.5°.
    #[inline]
    pub fn hit_pose(&self, pose: &Pose) -> bool {
        let c = [pose.center.x, pose.center.y, pose.center.z];
        let log_s = pose.s_deg_px.ln();
        let cos_thresh = (RING_CENTER_MAX_DEG * D2R).cos();
        self.entries.iter().any(|e| {
            if (log_s - e.log_s).abs() >= RING_DLOG_S_MAX {
                return false;
            }
            let mut drot = (pose.rot_deg - e.rot_deg).abs() % 360.0;
            if drot > 180.0 {
                drot = 360.0 - drot;
            }
            if drot >= RING_DROT_MAX_DEG {
                return false;
            }
            dot3(c, e.center) > cos_thresh
        })
    }

    /// Record a pose that was actually sent to verification.
    pub fn push(&mut self, cat_row: u64, band: u32, pose: &Pose) {
        let entry = RingEntry {
            cat_row,
            band,
            parity: pose.parity,
            center: [pose.center.x, pose.center.y, pose.center.z],
            log_s: pose.s_deg_px.ln(),
            rot_deg: pose.rot_deg,
        };
        if self.entries.len() < self.cap {
            self.entries.push(entry);
        } else {
            self.entries[self.head] = entry;
            self.head = (self.head + 1) % self.cap;
        }
    }
}

/// PRE-FIT gates — everything decidable WITHOUT touching star coordinates (hit-density
/// finding, M4a desk check: chance in-tol hits run ~46/quad; the two-star abscale kills
/// most of them from the stored `diam_deg` + det A/B pixels alone, so the 4 catalog
/// coordinate fetches — random access into the mmapped star table — happen only for
/// survivors). Order: ring identity → abscale (computes s_impl) → FOV.
#[allow(clippy::too_many_arguments)]
pub fn gate_prefit(
    det_a: [f64; 2],
    det_b: [f64; 2],
    diam_deg: f64,
    cat_row: u64,
    band: u32,
    parity: u8,
    s_sample: f64,
    w: f64,
    h: f64,
    params: &GateParams,
    ring: &DupRing,
) -> Result<f64, GateReject> {
    // 1 — ring identity (cheapest: three integer compares over ≤64 entries).
    if ring.hit_identity(cat_row, band, parity) {
        return Err(GateReject::RingIdentity);
    }

    // 2 — two-star abscale, sky-true: implied scale from stored diam_deg vs the AB pair,
    //     solved over the (code_tol-widened) blind scale window — the a.net (1±codetol)
    //     scale-consistency analog expressed on the emergent scale. A diam unreachable
    //     inside the window (clamped solve) IS the window rejection.
    if !(diam_deg > 0.0) || !diam_deg.is_finite() || !(s_sample > 0.0) {
        return Err(GateReject::AbscaleDegenerate);
    }
    let lo = params.scale_lo_deg_px * (1.0 - params.code_tol);
    let hi = params.scale_hi_deg_px * (1.0 + params.code_tol);
    let s_impl = match implied_scale(det_a, det_b, w, h, s_sample, diam_deg, lo, hi) {
        Some(s) => s,
        None => return Err(GateReject::AbscaleWindow),
    };

    // 3 — FOV plausibility.
    if s_impl * params.frame_diag_px >= FOV_MAX_DEG {
        return Err(GateReject::Fov);
    }

    Ok(s_impl)
}

/// POST-FETCH gates — need the 4 catalog sky positions: rotation fit at the implied
/// scale → residual sanity → ring pose proximity.
#[allow(clippy::too_many_arguments)]
pub fn gate_fit(
    det_px: &[[f64; 2]; 4],
    cat_sky: &[SkyDeg; 4],
    diam_deg: f64,
    s_impl: f64,
    parity: u8,
    w: f64,
    h: f64,
    params: &GateParams,
    ring: &DupRing,
) -> Result<Pose, GateReject> {
    // 4 — rotation fit at the implied scale.
    let pose = match fit_pose(det_px, cat_sky, w, h, s_impl, parity) {
        Some(p) => p,
        None => return Err(GateReject::FitDegenerate),
    };

    // 5 — rotation-fit residual sanity (bound derivation at ROT_RESID_FACTOR).
    if pose.max_resid_deg > ROT_RESID_FACTOR * params.code_tol * diam_deg {
        return Err(GateReject::RotResid);
    }

    // 6 — ring pose proximity.
    if ring.hit_pose(&pose) {
        return Err(GateReject::RingPose);
    }

    Ok(pose)
}

/// Full cost-ascending gate + fit chain (gate_prefit → gate_fit) — unit-test surface;
/// the coordinator calls the two phases separately so the star-coordinate fetch sits
/// between them.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_candidate(
    det_px: &[[f64; 2]; 4],
    cat_sky: &[SkyDeg; 4],
    diam_deg: f64,
    cat_row: u64,
    band: u32,
    parity: u8,
    s_sample: f64,
    w: f64,
    h: f64,
    params: &GateParams,
    ring: &DupRing,
) -> Result<Pose, GateReject> {
    let s_impl = gate_prefit(
        det_px[0], det_px[1], diam_deg, cat_row, band, parity, s_sample, w, h, params, ring,
    )?;
    gate_fit(det_px, cat_sky, diam_deg, s_impl, parity, w, h, params, ring)
}
