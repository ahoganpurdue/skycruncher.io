//! M4b gate: MINI-INDEX end-to-end (plan rev 2 §M4b) — the full blind path over a tiny
//! synthetic release built by the REAL production writer (crates/conformance/mini_index/
//! gen_mini_index.mjs → buildQuadIndex + serializeIndex from rest-integration; the M1
//! reader's strict validation is the conformance net).
//!
//! (a) POSITIVE: solve() = SOLVED, pose within tight bounds of the synthetic truth,
//!     decision-digest identical across 3 consecutive runs;
//! (b) NEGATIVE: scrambled positions (seeded) → refusal, ZERO accepted hypotheses;
//! (c) CANCELLATION: cancel mid-solve from another thread → CANCELLED, bounded wall,
//!     no partial result;
//! (d) a verified rejection does NOT stop band/candidate progression (counter-asserted
//!     with a test-constructed log_accept = +∞ config — a scenario construction to prove
//!     the control-flow property, NOT a change to any owner-guarded default).

use std::path::PathBuf;
use std::time::Instant;

use solver_contracts::config::{ReleaseVerifyMode, SolveConfig};
use solver_contracts::request::{Detection, SolveRequest};
use solver_contracts::result::TerminalState;
use solver_core::coordinator::{self, Engine};
use solver_core::geom;
use solver_core::index::QuadIndex;
use solver_core::runtime::SolveRuntime;

const RELEASE: &str = "mini-synth-g15u-1";

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mini_index")
}

struct Truth {
    w: u32,
    h: u32,
    crval_ra: f64,
    crval_dec: f64,
    scale_asec: f64,
    parity_sign: i8,
}

fn load_truth() -> Truth {
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_dir().join("truth.json")).unwrap()).unwrap();
    Truth {
        w: v["w"].as_u64().unwrap() as u32,
        h: v["h"].as_u64().unwrap() as u32,
        crval_ra: v["crval_ra_deg"].as_f64().unwrap(),
        crval_dec: v["crval_dec_deg"].as_f64().unwrap(),
        scale_asec: v["scale_asec_px"].as_f64().unwrap(),
        parity_sign: v["parity_sign"].as_f64().unwrap() as i8,
    }
}

fn load_request(file: &str, truth: &Truth) -> SolveRequest {
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_dir().join(file)).unwrap()).unwrap();
    let dets = v["detections"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, d)| Detection {
            id: i as u32, // CONTRACT id = array index (prep.rs rank-semantics note)
            x: d["x"].as_f64().unwrap(),
            y: d["y"].as_f64().unwrap(),
            flux: d["flux"].as_f64().unwrap(),
            peak_value: d["peak_value"].as_f64().unwrap_or(f64::NAN),
            fwhm: d["fwhm"].as_f64().unwrap_or(f64::NAN),
            snr: d["snr"].as_f64().unwrap_or(f64::NAN),
        })
        .collect();
    SolveRequest {
        frame_id: file.to_string(),
        width: truth.w,
        height: truth.h,
        detections: dets,
        priors: Default::default(),
    }
}

fn open_mini() -> QuadIndex {
    // Full sha256 verification every open (the release is ~2 MB); no prefetch (SSD/warm).
    QuadIndex::open(&fixture_dir().join(RELEASE), ReleaseVerifyMode::Full, None, false)
        .expect("mini release must open + validate")
}

fn sep_deg(ra1: f64, dec1: f64, ra2: f64, dec2: f64) -> f64 {
    geom::dot_deg(&geom::unit_vec(ra1, dec1), &geom::unit_vec(ra2, dec2))
}

#[test]
fn positive_solves_and_digest_stable_over_3_runs() {
    let truth = load_truth();
    let config = SolveConfig::default();
    let mut digests = Vec::new();

    for run_i in 0..3 {
        let mut index = open_mini();
        let request = load_request("detections_positive.json", &truth);
        let prepared = coordinator::prepare(&request, &config, &mut index);
        let runtime = SolveRuntime::new(120_000, config.search.verify_reserve_frac);
        let mut engine = Engine::new(&prepared, &index, &config, &runtime);
        let t = Instant::now();
        let run = engine.run();
        let wall = t.elapsed().as_millis();

        assert_eq!(
            run.result.state,
            TerminalState::Solved,
            "run {run_i}: positive scene must SOLVE (wall {wall} ms; counters {:?})",
            run.search.per_band
        );
        let s = run.result.solved.as_ref().expect("solved payload");
        let center_err = sep_deg(s.wcs.crval.ra, s.wcs.crval.dec, truth.crval_ra, truth.crval_dec);
        let scale_err = (s.scale_arcsec_px / truth.scale_asec - 1.0).abs();
        eprintln!(
            "run {run_i}: SOLVED band {} rung {} seq {} | center_err {:.3e} deg, scale_err {:.3e}, \
             log_odds {:.2}, matches {}, wall {wall} ms",
            s.band,
            s.rung,
            s.hypothesis_seq,
            center_err,
            scale_err,
            s.final_verify.log_odds,
            s.matches.len()
        );
        assert!(center_err < 0.1, "center error {center_err} deg");
        assert!(scale_err < 0.01, "scale error {scale_err}");
        assert_eq!(s.parity_sign, truth.parity_sign, "parity sign vs truth convention");
        assert!(
            s.final_verify.log_odds >= config.evidence.log_accept,
            "final judge below accept: {}",
            s.final_verify.log_odds
        );
        assert!(s.matches.len() >= 6, "match set too small: {}", s.matches.len());
        // one-to-one both directions on the FINAL match set
        let mut d: Vec<u32> = s.matches.iter().map(|m| m.det_id).collect();
        let mut r: Vec<u32> = s.matches.iter().map(|m| m.star_row).collect();
        let n = d.len();
        d.sort_unstable();
        d.dedup();
        r.sort_unstable();
        r.dedup();
        assert_eq!(d.len(), n, "duplicate det in final matches");
        assert_eq!(r.len(), n, "duplicate star in final matches");

        // receipt with pinned-inputs → digest must be identical across runs
        let receipt = coordinator::assemble_receipt(
            "mini_pos",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            &request,
            &config,
            solver_core::build_info::build_info("TEST_COMMIT".into()),
            &index,
            &prepared,
            run,
            "unix:0".into(),
            1,
        );
        digests.push(receipt.decision_digest.clone());
    }
    assert_eq!(digests[0], digests[1], "digest run0 != run1");
    assert_eq!(digests[1], digests[2], "digest run1 != run2");
    eprintln!("decision digest (3 identical runs): {}", digests[0]);
}

#[test]
fn scrambled_negative_refuses_with_zero_accepts() {
    let truth = load_truth();
    let mut config = SolveConfig::default();
    config.search.budget_ms = 60_000;
    let mut index = open_mini();
    let request = load_request("detections_scrambled.json", &truth);
    let prepared = coordinator::prepare(&request, &config, &mut index);
    let runtime = SolveRuntime::new(config.search.budget_ms, config.search.verify_reserve_frac);
    let mut engine = Engine::new(&prepared, &index, &config, &runtime);
    let run = engine.run();

    eprintln!(
        "scrambled: state {:?}, truncated {}, rejected_after_refine {}",
        run.result.state, run.result.search_truncated, run.rejected_after_refine
    );
    assert_ne!(run.result.state, TerminalState::Solved, "scrambled scene must refuse");
    assert!(run.result.solved.is_none(), "no partial result on refusal");
    assert!(
        matches!(
            run.result.state,
            TerminalState::NoMatch | TerminalState::BudgetExhausted
        ),
        "refusal must be NO_MATCH or BUDGET_EXHAUSTED, got {:?}",
        run.result.state
    );
    // ZERO accepted hypotheses: nothing solved AND nothing even reached the accept chain.
    assert_eq!(run.rejected_after_refine, 0, "an accept fired on scrambled data");
}

#[test]
fn cancellation_mid_solve_is_bounded_with_no_partial_result() {
    let truth = load_truth();
    let mut config = SolveConfig::default();
    // Cancellation granularity (documented limitation, coordinator.rs header): verify
    // work stops per-candidate, but GENERATION of the in-flight rung runs to completion
    // (M4a's CandidateSink has no abort channel). The bound is therefore one rung's
    // generation; a smaller first rung keeps that bound tight for the test. This is
    // search-shape scenario construction, not an evidence-threshold change.
    config.search.rung_ladder = vec![40, 80, 160, 320, 640];
    // Try successively earlier cancels — the scene must land at least one mid-flight
    // CANCELLED (600-detection scramble = seconds of generation+verification work).
    let mut cancelled_seen = false;
    for delay_ms in [40u64, 10, 2] {
        let mut index = open_mini();
        let request = load_request("detections_scrambled_big.json", &truth);
        let prepared = coordinator::prepare(&request, &config, &mut index);
        let runtime = SolveRuntime::new(300_000, config.search.verify_reserve_frac);
        let mut engine = Engine::new(&prepared, &index, &config, &runtime);
        let t = Instant::now();
        let run = std::thread::scope(|scope| {
            let rt = &runtime;
            scope.spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                rt.cancel();
            });
            engine.run()
        });
        let wall = t.elapsed();
        eprintln!(
            "cancel@{delay_ms}ms: state {:?} after {} ms",
            run.result.state,
            wall.as_millis()
        );
        assert!(
            wall.as_secs() < 60,
            "cancellation must be bounded by one rung's generation (took {} ms)",
            wall.as_millis()
        );
        if run.result.state == TerminalState::Cancelled {
            cancelled_seen = true;
            assert!(run.result.solved.is_none(), "no partial result on cancel");
            assert!(run.result.search_truncated, "cancel leaves space unsearched");
            break;
        }
    }
    assert!(cancelled_seen, "no attempt produced a mid-flight CANCELLED");
}

#[test]
fn verified_rejection_does_not_stop_progression() {
    let truth = load_truth();
    let mut config = SolveConfig::default();
    // Test-constructed scenario: an unreachable accept bound turns EVERY verification
    // into a verified rejection; the search must keep probing bands/candidates to a
    // terminal state. This is a control-flow property proof, not a threshold change.
    config.evidence.log_accept = f64::INFINITY;
    config.search.budget_ms = 60_000;

    let mut index = open_mini();
    let request = load_request("detections_positive.json", &truth);
    let prepared = coordinator::prepare(&request, &config, &mut index);
    let runtime = SolveRuntime::new(config.search.budget_ms, config.search.verify_reserve_frac);
    let mut engine = Engine::new(&prepared, &index, &config, &runtime);
    let run = engine.run();

    assert_ne!(run.result.state, TerminalState::Solved);
    let total_verified: u64 = run.search.per_band.values().map(|c| c.verified).sum();
    let bands_probed = run
        .search
        .per_band
        .values()
        .filter(|c| c.probes > 0)
        .count();
    eprintln!(
        "rejection-progression: state {:?}, verified {total_verified}, bands probed {bands_probed}",
        run.result.state
    );
    assert!(
        total_verified >= 2,
        "search stopped after the first verified rejection (verified = {total_verified})"
    );
    assert!(
        bands_probed >= 2,
        "band progression stopped (only {bands_probed} band(s) probed)"
    );
    assert_eq!(run.rejected_after_refine, 0, "nothing may reach the accept chain at +inf");
}
