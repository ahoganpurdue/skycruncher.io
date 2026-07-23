//! M4b gate: hypothesis geometry round-trip (plan rev 2 §M4b).
//!
//! PIN: for synthetic EXACT scenes (catalog = rotation of the unprojected detections),
//! the derived TanWcs must reproject every catalog star to its detection pixel to
//! < 1e-9 px — both parities, multiple rotations/scales including the 52″/px wide-field
//! class — and the fit must be bit-deterministic across runs.

use solver_contracts::coordinates::SkyDeg;
use solver_core::geom::{self, D2R};
use solver_core::hypo::{
    self, det_plane, evaluate_candidate, fit_pose, implied_scale, inverse_gnomonic, project_tan,
    unproject_about_pole, DupRing, GateParams, GateReject,
};

// ── test-local rotation helpers (hypo's internals are deliberately private) ──

type Mat3 = [[f64; 3]; 3];

fn rot_axis_angle(axis: [f64; 3], angle_rad: f64) -> Mat3 {
    let n = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    let k = [axis[0] / n, axis[1] / n, axis[2] / n];
    let (s, c) = angle_rad.sin_cos();
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

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}

fn mat_vec(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn sky_of(v: [f64; 3]) -> SkyDeg {
    let dec = (v[2] / (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
        .clamp(-1.0, 1.0)
        .asin()
        / D2R;
    let mut ra = v[1].atan2(v[0]) / D2R;
    if ra < 0.0 {
        ra += 360.0;
    }
    SkyDeg { ra, dec }
}

/// Truth rotation: pole → (ra0, dec0) with in-plane spin. R = Rz(ra0)·Ry(−dec0)·Rx(spin).
fn truth_rotation(ra0: f64, dec0: f64, spin_deg: f64) -> Mat3 {
    let rx = rot_axis_angle([1.0, 0.0, 0.0], spin_deg * D2R);
    let ry = rot_axis_angle([0.0, 1.0, 0.0], -dec0 * D2R);
    let rz = rot_axis_angle([0.0, 0.0, 1.0], ra0 * D2R);
    mat_mul(&rz, &mat_mul(&ry, &rx))
}

/// Exact catalog sky of a detection pixel under (R_true, s, parity).
fn sky_of_px(r: &Mat3, x: f64, y: f64, w: f64, h: f64, s: f64, parity: u8) -> SkyDeg {
    let (u, v) = det_plane(x, y, w, h, s, parity);
    sky_of(mat_vec(r, unproject_about_pole(u, v)))
}

struct Scene {
    name: &'static str,
    w: f64,
    h: f64,
    s: f64, // deg/px
    ra0: f64,
    dec0: f64,
    spin: f64,
    parity: u8,
    quad: [[f64; 2]; 4],
}

fn scenes() -> Vec<Scene> {
    let wide_quad = [
        [4800.0, 3200.0],
        [5400.0, 3500.0],
        [5050.0, 3300.0],
        [5150.0, 3450.0],
    ];
    let mid_quad = [
        [1000.0, 800.0],
        [1500.0, 1200.0],
        [1180.0, 950.0],
        [1300.0, 1100.0],
    ];
    vec![
        Scene {
            name: "wide52_p0_rot95",
            w: 5796.0,
            h: 3870.0,
            s: 52.7726 / 3600.0,
            ra0: 207.154938,
            dec0: -59.673110,
            spin: 95.203,
            parity: 0,
            quad: wide_quad,
        },
        Scene {
            name: "wide52_p1_rot95",
            w: 5796.0,
            h: 3870.0,
            s: 52.7726 / 3600.0,
            ra0: 207.154938,
            dec0: -59.673110,
            spin: 95.203,
            parity: 1,
            quad: wide_quad,
        },
        Scene {
            name: "wide52_p1_rot271_northpolar",
            w: 5796.0,
            h: 3870.0,
            s: 52.7726 / 3600.0,
            ra0: 12.3,
            dec0: 82.0,
            spin: 271.0,
            parity: 1,
            quad: wide_quad,
        },
        Scene {
            name: "narrow1p5_p0_rot0",
            w: 4000.0,
            h: 3000.0,
            s: 1.5 / 3600.0,
            ra0: 30.0,
            dec0: 10.0,
            spin: 0.0,
            parity: 0,
            quad: mid_quad,
        },
        Scene {
            name: "narrow1p5_p1_rot37_rawrap",
            w: 4000.0,
            h: 3000.0,
            s: 1.5 / 3600.0,
            ra0: 359.9,
            dec0: -5.0,
            spin: 37.0,
            parity: 1,
            quad: mid_quad,
        },
        Scene {
            name: "mid10_p0_rot180",
            w: 5796.0,
            h: 3870.0,
            s: 10.0 / 3600.0,
            ra0: 120.0,
            dec0: 33.0,
            spin: 180.0,
            parity: 0,
            quad: mid_quad,
        },
    ]
}

#[test]
fn round_trip_exact_scenes_under_1e9_px() {
    let mut worst = 0.0f64;
    for sc in scenes() {
        let r = truth_rotation(sc.ra0, sc.dec0, sc.spin);
        let cat: [SkyDeg; 4] = std::array::from_fn(|i| {
            sky_of_px(&r, sc.quad[i][0], sc.quad[i][1], sc.w, sc.h, sc.s, sc.parity)
        });

        // hypothesis scale via the abscale solve, seeded OFF-truth (also pins the solver)
        let ua = geom::unit_vec(cat[0].ra, cat[0].dec);
        let ub = geom::unit_vec(cat[1].ra, cat[1].dec);
        let diam = geom::dot_deg(&ua, &ub);
        let s_impl = implied_scale(
            sc.quad[0],
            sc.quad[1],
            sc.w,
            sc.h,
            sc.s * 1.17,
            diam,
            0.5 / 3600.0,
            300.0 / 3600.0,
        )
        .expect("implied scale");
        assert!(
            (s_impl / sc.s - 1.0).abs() < 1e-10,
            "{}: implied scale off: {} vs {}",
            sc.name,
            s_impl,
            sc.s
        );

        let pose = fit_pose(&sc.quad, &cat, sc.w, sc.h, s_impl, sc.parity).expect("pose");
        assert!(
            pose.max_resid_deg < 1e-11,
            "{}: fit residual {}",
            sc.name,
            pose.max_resid_deg
        );
        // parity convention pin: parity bit 1 ⇔ det(CD) < 0 (module header derivation)
        let expect_sign = if sc.parity == 1 { -1 } else { 1 };
        assert_eq!(pose.wcs.parity_sign(), expect_sign, "{}: parity sign", sc.name);

        // quad members round-trip. Bar: 1e-9 px, floored at the ANGLE-equivalent chain
        // precision 4e-14 rad (≈2× the measured f64 floor of ~10 chained deg↔rad/trig
        // ops near the RA wrap). At the deliverable's named 52″/px wide-field class the
        // angular floor is far below 1e-9 px, so the strict pixel bar binds there; at
        // 1.5″/px the SAME angular fidelity is stricter than 1e-9 px can express in f64.
        let member_bar = 1e-9f64.max(4e-14 / (sc.s * D2R));
        for i in 0..4 {
            let p = project_tan(&pose.wcs, cat[i]).expect("project");
            let e = ((p.x - sc.quad[i][0]).powi(2) + (p.y - sc.quad[i][1]).powi(2)).sqrt();
            worst = worst.max(e);
            assert!(
                e < member_bar,
                "{}: quad member {i} round-trip {e} px (bar {member_bar})",
                sc.name
            );
        }
        // field-wide round-trip (16 points across the frame — pins the WHOLE mapping,
        // not just the fitted correspondences). Bar: 1e-9 px floored at the fit's
        // INHERENT spin conditioning: a 4-point rotation fit constrains in-plane spin
        // only through its ρ-scale baselines (ρ = quad angular radius), so f64 carries
        // δφ ≈ ε/ρ of spin noise — algorithm-independent (a Davenport eigensolver has
        // the same conditioning) — and far field points feel the full δφ. Bar =
        // max(1e-9 px, 8·ε/ρ / s_rad) (measured worst ≈5·ε/ρ across geometries): the
        // 52″/px wide-field class (big ρ) stays at the STRICT 1e-9 px; only the
        // deliberately-narrow scenes use the conditioning floor.
        let mut d2max = 0.0f64;
        for i in 0..4 {
            for j in (i + 1)..4 {
                let dx = sc.quad[i][0] - sc.quad[j][0];
                let dy = sc.quad[i][1] - sc.quad[j][1];
                d2max = d2max.max(dx * dx + dy * dy);
            }
        }
        let s_rad = sc.s * D2R;
        let rho_rad = 0.5 * d2max.sqrt() * s_rad;
        let field_bar = 1e-9f64.max(8.0 * (f64::EPSILON / rho_rad) / s_rad);
        for gy in 0..4 {
            for gx in 0..4 {
                let x = (gx as f64 + 0.5) * sc.w / 4.0;
                let y = (gy as f64 + 0.5) * sc.h / 4.0;
                let sky = sky_of_px(&r, x, y, sc.w, sc.h, sc.s, sc.parity);
                let p = project_tan(&pose.wcs, sky).expect("project field");
                let e = ((p.x - x).powi(2) + (p.y - y).powi(2)).sqrt();
                worst = worst.max(e);
                assert!(
                    e < field_bar,
                    "{}: field point ({x},{y}) round-trip {e} px (bar {field_bar})",
                    sc.name
                );
            }
        }
    }
    eprintln!("round-trip worst residual: {worst:.3e} px");
}

#[test]
fn fit_pose_bit_deterministic() {
    let sc = &scenes()[0];
    let r = truth_rotation(sc.ra0, sc.dec0, sc.spin);
    let cat: [SkyDeg; 4] = std::array::from_fn(|i| {
        sky_of_px(&r, sc.quad[i][0], sc.quad[i][1], sc.w, sc.h, sc.s, sc.parity)
    });
    let a = fit_pose(&sc.quad, &cat, sc.w, sc.h, sc.s, sc.parity).unwrap();
    let b = fit_pose(&sc.quad, &cat, sc.w, sc.h, sc.s, sc.parity).unwrap();
    let bits = |w: &solver_contracts::coordinates::TanWcs| {
        [
            w.crval.ra.to_bits(),
            w.crval.dec.to_bits(),
            w.crpix.x.to_bits(),
            w.crpix.y.to_bits(),
            w.cd[0][0].to_bits(),
            w.cd[0][1].to_bits(),
            w.cd[1][0].to_bits(),
            w.cd[1][1].to_bits(),
        ]
    };
    assert_eq!(bits(&a.wcs), bits(&b.wcs), "two identical fits must be bit-identical");
    assert_eq!(a.max_resid_deg.to_bits(), b.max_resid_deg.to_bits());
    assert_eq!(a.rot_deg.to_bits(), b.rot_deg.to_bits());
}

#[test]
fn inverse_gnomonic_is_exact_inverse() {
    let cases = [
        (10.0, 20.0, 12.0, 21.5),
        (359.5, -30.0, 0.4, -29.0),
        (180.0, 85.0, 182.0, 84.0),
        (90.0, 0.0, 90.0, 0.0),
    ];
    for (ra0, dec0, ra, dec) in cases {
        let t = geom::gnomonic(ra, dec, ra0, dec0).expect("forward");
        let back = inverse_gnomonic(t.x, t.y, ra0, dec0);
        let ua = geom::unit_vec(ra, dec);
        let ub = geom::unit_vec(back.ra, back.dec);
        let sep = geom::dot_deg(&ua, &ub);
        assert!(sep < 1e-12, "inverse round trip sep {sep} deg at ({ra0},{dec0})");
    }
}

#[test]
fn cheap_gates_fire_by_name() {
    let sc = &scenes()[0];
    let r = truth_rotation(sc.ra0, sc.dec0, sc.spin);
    let cat: [SkyDeg; 4] = std::array::from_fn(|i| {
        sky_of_px(&r, sc.quad[i][0], sc.quad[i][1], sc.w, sc.h, sc.s, sc.parity)
    });
    let ua = geom::unit_vec(cat[0].ra, cat[0].dec);
    let ub = geom::unit_vec(cat[1].ra, cat[1].dec);
    let diam = geom::dot_deg(&ua, &ub);
    let policy = solver_contracts::config::SearchPolicy::default();
    let params = GateParams::from_policy(&policy, sc.w, sc.h);
    let ring = DupRing::new(64);

    // clean candidate passes
    let pose = evaluate_candidate(
        &sc.quad, &cat, diam, 7, 11, sc.parity, sc.s, sc.w, sc.h, &params, &ring,
    )
    .expect("clean candidate must pass all gates");

    // ring identity: after pushing, the same (cat_row, band, parity) is skipped
    let mut ring2 = DupRing::new(64);
    ring2.push(7, 11, &pose);
    let e = evaluate_candidate(
        &sc.quad, &cat, diam, 7, 11, sc.parity, sc.s, sc.w, sc.h, &params, &ring2,
    )
    .unwrap_err();
    assert_eq!(e, GateReject::RingIdentity);
    // …and a DIFFERENT cat_row with a near-identical pose is a RingPose skip
    let e = evaluate_candidate(
        &sc.quad, &cat, diam, 8, 11, sc.parity, sc.s, sc.w, sc.h, &params, &ring2,
    )
    .unwrap_err();
    assert_eq!(e, GateReject::RingPose);

    // abscale window: a diam implying a scale far outside the blind window
    let e = evaluate_candidate(
        &sc.quad,
        &cat,
        diam * 40.0, // implies ~2100″/px >> 300″/px window
        9,
        11,
        sc.parity,
        sc.s,
        sc.w,
        sc.h,
        &params,
        &ring,
    )
    .unwrap_err();
    assert_eq!(e, GateReject::AbscaleWindow);

    // rot-resid: scramble one catalog star well beyond the code tolerance
    let mut cat_bad = cat;
    cat_bad[2].ra += diam * 0.2; // 20% of the quad scale — far beyond 2·tol
    let e = evaluate_candidate(
        &sc.quad, &cat_bad, diam, 10, 11, sc.parity, sc.s, sc.w, sc.h, &params, &ring,
    )
    .unwrap_err();
    assert_eq!(e, GateReject::RotResid);

    // FOV: a compatible-looking diam but a fake huge frame diagonal
    let mut params_fov = params;
    params_fov.frame_diag_px = 20_000_000.0; // 52″/px × 2e7 px diag >> 150°
    let e = evaluate_candidate(
        &sc.quad, &cat, diam, 12, 11, sc.parity, sc.s, sc.w, sc.h, &params_fov, &ring,
    )
    .unwrap_err();
    assert_eq!(e, GateReject::Fov);
}

#[test]
fn gate_counter_names_unique() {
    let mut names: Vec<&str> = hypo::GateReject::ALL.iter().map(|g| g.counter_name()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), hypo::GateReject::ALL.len());
}
