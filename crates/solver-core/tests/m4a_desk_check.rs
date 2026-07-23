//! M4a desk-check layers 1-4 — the headline gate of the wide-field candidate stream.
//!
//! FACTORED (M4.5): the desk-check walk now lives in ONE shared implementation,
//! `solver_core::deskcheck` (ORACLE_ASSISTED, off the blind path), called by BOTH this test
//! and the `desk-check` CLI subcommand. This test asserts the SAME gates on the shared
//! report; the CLI reproduces the same numbers on the same inputs (refactor-neutrality proof).
//!
//! The shared walk runs the REAL BLIND pipeline (prep → quadgen → probe against the g15u
//! release; NO oracle input enters the pipeline) through rung ≤ 400 on the banked CSM30799
//! detections, then cross-references the ORACLE-ASSISTED truth fixture
//! (tests/fixtures/truth_csm30799.json, built by crates/conformance/truth_fixture_extract.mjs
//! at the exact a.net pose):
//!
//!   IN-POOL     all 4 members' matched det ids (through the dedup survivor map) have
//!               uni_rank ≤ 400
//!   ENUMERATED  some emitted quad's det-id set equals the set's matched-det-id set
//!   KEY-HIT     a CandidateHit's det-id set matches AND its cat_row's star set equals the
//!               truth star set (cat_row resolved through the index)
//!
//! GATES:
//!  (a) prep cross-check — DEVIATION, DIAGNOSED AND PROVEN (2026-07-20): the M-1 table
//!      (bands≥10: 8/20/56 in-pool @100/200/400) was produced by a policy SIMULATOR that
//!      keyed its rank maps by the source file's NON-unique raw `id` (3,669 collisions;
//!      map overwrite gives both twins the worse rank). Re-running that simulator
//!      reproduces 8/20/56 exactly; the frozen POLICY itself, implemented per-detection as
//!      specified, measures 13/64/168 on identical inputs (favorable 3×). This test
//!      asserts the Rust prep against the CLEAN reference (±2, implementation-detail
//!      ties) and REPORTS the M-1 comparison — the frozen constants were not tuned.
//!  (b) HEADLINE: ≥ 10 truth 4-sets in bands ≥ 10 reach KEY-HIT.
//!  (c) report key-hit rate among enumerated truth sets vs the 34.1% legacy whole-frame
//!      ceiling.
//!
//! Env-gated: needs the release (SOLVER_TEST_RELEASE_DIR or the D: default) and the banked
//! detections (SOLVER_TEST_DETECTIONS or the D: default); skips with a message otherwise.

use std::path::PathBuf;
use std::time::Instant;

use solver_contracts::config::ReleaseVerifyMode;
use solver_contracts::request::Detection;
use solver_core::deskcheck::{self, TruthFixture};
use solver_core::index::{IndexError, QuadIndex};

const DEFAULT_RELEASE: &str =
    "D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u";
const DEFAULT_DETECTIONS: &str =
    "D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/detections_CSM30799.CR2_16792.json";
const RUNG_MAX: u32 = 400;
/// Clean per-detection UNION reference, bands≥10 in-pool totals (truth_fixture_extract.mjs
/// clean-policy diagnostic, 2026-07-20): (rung, expected).
const CLEAN_EXPECT: [(u32, u32); 3] = [(100, 13), (200, 64), (400, 168)];
/// The M-1 frozen table (raw-id-keyed simulator; see module docs) — REPORTED, not asserted.
const M1_TABLE: [(u32, u32); 3] = [(100, 8), (200, 20), (400, 56)];
/// Legacy whole-frame coding in-tol ceiling (§0 conformance) — the baseline to beat.
const LEGACY_BASELINE: f64 = 0.341;

fn release_dir() -> Option<PathBuf> {
    let d = std::env::var("SOLVER_TEST_RELEASE_DIR").unwrap_or_else(|_| DEFAULT_RELEASE.into());
    let p = PathBuf::from(d);
    p.join("manifest.json").exists().then_some(p)
}

fn detections_path() -> Option<PathBuf> {
    let d = std::env::var("SOLVER_TEST_DETECTIONS").unwrap_or_else(|_| DEFAULT_DETECTIONS.into());
    let p = PathBuf::from(d);
    p.exists().then_some(p)
}

#[test]
#[ignore = "~16-25 min exhaustive real-data run (rung-400, no early exit); run explicitly at gate \
checkpoints: cargo test -p solver-core --test m4a_desk_check -- --ignored. Superseded as the \
standing diagnostic by the M4.5 desk-check CLI subcommand (same shared solver_core::deskcheck \
walk); re-run when the candidate stream changes."]
fn m4a_desk_check_layers_1_to_4() {
    let Some(rel) = release_dir() else {
        eprintln!("SKIP m4a_desk_check: release not found (set SOLVER_TEST_RELEASE_DIR)");
        return;
    };
    let Some(det_path) = detections_path() else {
        eprintln!("SKIP m4a_desk_check: detections not found (set SOLVER_TEST_DETECTIONS)");
        return;
    };

    // ── fixture (parsed by the shared module) ──
    let fx_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/truth_csm30799.json");
    let fixture = TruthFixture::parse(&std::fs::read_to_string(fx_path).expect("fixture present"))
        .expect("fixture parses");
    assert_eq!((fixture.width, fixture.height), (5796, 3870));

    // ── detections (id = ARRAY INDEX; the raw `id` field is non-unique) ──
    let dj: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&det_path).expect("detections read"))
            .expect("detections parse");
    let arr = dj["detections"].as_array().expect("detections[]");
    assert_eq!(arr.len() as u64, fixture.det_count_raw, "detections drifted");
    let f = |v: &serde_json::Value| v.as_f64().unwrap_or(f64::NAN);
    let dets: Vec<Detection> = arr
        .iter()
        .enumerate()
        .map(|(i, d)| Detection {
            id: i as u32,
            x: f(&d["x"]),
            y: f(&d["y"]),
            flux: f(&d["flux"]),
            peak_value: f(&d["peak_value"]),
            fwhm: f(&d["fwhm"]),
            snr: f(&d["snr"]),
        })
        .collect();

    // ── open the release (Stamp; first contact falls back to Full which writes the stamp) ──
    let stamp_dir = std::env::temp_dir().join("skycruncher_m1_release_stamps");
    let t = Instant::now();
    let mut index = match QuadIndex::open(&rel, ReleaseVerifyMode::Stamp, Some(&stamp_dir), true) {
        Ok(ix) => ix,
        Err(IndexError::StampMissing(_)) => {
            QuadIndex::open(&rel, ReleaseVerifyMode::Full, Some(&stamp_dir), true)
                .expect("Full-verified open")
        }
        Err(e) => panic!("index open failed: {e}"),
    };
    eprintln!("[desk] index open: {} ms", t.elapsed().as_millis());

    // ── the ONE shared walk (layers 1-5; layers 1-4 gated here, layer 5 is telemetry) ──
    let report = deskcheck::run(&dets, &mut index, &fixture, RUNG_MAX);
    eprintln!(
        "[desk] prep: raw {} valid {} deduped {} pool {} peak_arm_promoted {} ({} ms) | walk {} ms | layer5 {} ms",
        report.prep.raw, report.prep.valid, report.prep.deduped, report.prep.pool,
        report.prep.peak_arm_promoted, report.prep_ms, report.walk_ms, report.layer5_ms
    );

    // ── gate (a): in-pool counts vs the clean reference (M-1 table reported) ──
    for (rung, expect) in CLEAN_EXPECT {
        let got = report.in_pool_ge10_at(rung) as i64;
        let m1 = M1_TABLE.iter().find(|(r, _)| *r == rung).unwrap().1;
        eprintln!(
            "[desk] gate(a) in-pool bands>=10 @<={rung}: rust {got} | clean-ref {expect} | M-1 table {m1}"
        );
        assert!(
            (got - expect as i64).abs() <= 2,
            "prep drifted from the clean per-detection reference @{rung}: {got} vs {expect} (±2)"
        );
    }
    eprintln!(
        "[desk] gate(a) NOTE: M-1 table (8/20/56) reproduced ONLY by re-introducing the \
         raw-id-keyed rank maps (non-unique ids, overwrite) — measurement artifact, policy unchanged"
    );

    // ── attrition table ──
    eprintln!("[desk] band | sets in-pool(<=400) enumerated code-in-tol key-hit would-verify");
    for b in report.band_ids() {
        let a = report.band_agg(b);
        eprintln!(
            "[desk] {:>4} | {:>5} {:>7} {:>10} {:>11} {:>7} {:>12}",
            a.band, a.total, a.in_pool, a.enumerated, a.code_in_tol, a.key_hit, a.would_verify_accept
        );
    }
    let (ip, en, kh, wv) = report.ge10_totals();
    eprintln!(
        "[desk] bands>=10: in-pool {ip} -> enumerated {en} -> KEY-HIT {kh} -> would-verify-accept {wv} \
         | parity hits p0={} p1={}",
        report.parity_hits[0], report.parity_hits[1]
    );
    let (enum_total, hit_total, rate) = report.enumerated_keyhit_rate();
    eprintln!(
        "[desk] gate(c): key-hit rate among enumerated truth sets = {rate:.3} ({hit_total}/{enum_total}) \
         vs legacy whole-frame baseline {LEGACY_BASELINE:.3}"
    );

    // ── gate (b) HEADLINE ──
    assert!(
        kh >= 10,
        "HEADLINE gate failed: {kh} truth 4-sets (bands>=10) reached KEY-HIT (need >=10)"
    );
}
