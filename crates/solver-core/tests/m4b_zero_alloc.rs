//! M4b gate: allocation accounting over the solve loop (plan rev 2 §M4b zero-alloc gate).
//!
//! Counting global allocator (test-only, this binary). Two measured windows on the
//! mini-index positive case:
//!
//!   (1) VERIFY CHAIN (M4b-owned): repeated in-loop reference-gather + seed-excluded
//!       verify cycles after warmup — asserted EXACTLY ZERO allocations. This is the
//!       per-candidate hot path this lane owns (gather → tile round-robin → project →
//!       verify with workspace reuse).
//!
//!   (2) FULL `Engine::run` window — measured and REPORTED PRECISELY, not asserted zero:
//!       the M4a generator grows its pair/interior/hit arenas lazily inside `next_rung`
//!       (quadgen.rs: `pairs.push`, `interior.resize`, `quad_buf`/`hits_buf` growth),
//!       which is outside this lane's edit rights. Numbers are printed for the M4b
//!       report; the assertion is NOT weakened to cover them — it is scoped to the
//!       window this lane controls, and the generator-side residue is flagged to the
//!       M4a lane rather than silently accepted.
//!
//! Single #[test] so no concurrent test in this binary pollutes the counters.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use solver_contracts::config::{ReleaseVerifyMode, SolveConfig};
use solver_contracts::coordinates::{PixelXY, SkyDeg, TanWcs};
use solver_contracts::request::{Detection, SolveRequest};
use solver_contracts::result::TerminalState;
use solver_core::coordinator::{self, Engine};
use solver_core::index::QuadIndex;
use solver_core::runtime::SolveRuntime;

struct CountingAlloc;

static ARMED: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static DEALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if ARMED.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(l.size() as u64, Ordering::Relaxed);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if ARMED.load(Ordering::Relaxed) {
            DEALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if ARMED.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(new as u64, Ordering::Relaxed);
        }
        unsafe { System.realloc(p, l, new) }
    }
}

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

fn reset() {
    ALLOCS.store(0, Ordering::SeqCst);
    DEALLOCS.store(0, Ordering::SeqCst);
    BYTES.store(0, Ordering::SeqCst);
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mini_index")
}

fn load_request() -> (SolveRequest, TanWcs) {
    let t: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_dir().join("truth.json")).unwrap()).unwrap();
    let (w, h) = (t["w"].as_u64().unwrap() as u32, t["h"].as_u64().unwrap() as u32);
    let cd = &t["cd"];
    let truth_wcs = TanWcs {
        crval: SkyDeg {
            ra: t["crval_ra_deg"].as_f64().unwrap(),
            dec: t["crval_dec_deg"].as_f64().unwrap(),
        },
        crpix: PixelXY {
            x: w as f64 / 2.0,
            y: h as f64 / 2.0,
        },
        cd: [
            [cd[0][0].as_f64().unwrap(), cd[0][1].as_f64().unwrap()],
            [cd[1][0].as_f64().unwrap(), cd[1][1].as_f64().unwrap()],
        ],
    };
    let v: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture_dir().join("detections_positive.json")).unwrap(),
    )
    .unwrap();
    let dets = v["detections"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, d)| Detection {
            id: i as u32,
            x: d["x"].as_f64().unwrap(),
            y: d["y"].as_f64().unwrap(),
            flux: d["flux"].as_f64().unwrap(),
            peak_value: d["peak_value"].as_f64().unwrap_or(f64::NAN),
            fwhm: 3.1,
            snr: 25.0,
        })
        .collect();
    (
        SolveRequest {
            frame_id: "mini_pos".into(),
            width: w,
            height: h,
            detections: dets,
            priors: Default::default(),
        },
        truth_wcs,
    )
}

#[test]
fn alloc_windows_verify_chain_zero_full_window_reported() {
    let (request, truth_wcs) = load_request();
    let config = SolveConfig::default();
    let mut index = QuadIndex::open(
        &fixture_dir().join("mini-synth-g15u-1"),
        ReleaseVerifyMode::Full,
        None,
        false,
    )
    .expect("mini release");
    let prepared = coordinator::prepare(&request, &config, &mut index);
    let runtime = SolveRuntime::new(300_000, config.search.verify_reserve_frac);
    let mut engine = Engine::new(&prepared, &index, &config, &runtime);

    // ── window 1: the M4b verify chain, warmed then repeated — MUST be zero-alloc ──
    let _ = engine.debug_verify_cycle(&truth_wcs); // warm (first gather sizes buffers)
    reset();
    ARMED.store(true, Ordering::SeqCst);
    let mut odds_sum = 0.0;
    for _ in 0..50 {
        let stats = engine.debug_verify_cycle(&truth_wcs);
        odds_sum += stats.log_odds;
    }
    ARMED.store(false, Ordering::SeqCst);
    let (a1, d1, b1) = (
        ALLOCS.load(Ordering::SeqCst),
        DEALLOCS.load(Ordering::SeqCst),
        BYTES.load(Ordering::SeqCst),
    );
    eprintln!("verify-chain window (50 cycles): {a1} allocs / {d1} deallocs / {b1} bytes; odds_sum {odds_sum:.1}");
    assert_eq!(
        (a1, d1),
        (0, 0),
        "M4b verify chain must not allocate at steady state ({a1} allocs / {d1} deallocs / {b1} bytes over 50 cycles)"
    );

    // ── window 2: full Engine::run — measured + reported (M4a generator arenas grow
    //    in-loop; outside this lane's edit rights — see module header) ──
    reset();
    ARMED.store(true, Ordering::SeqCst);
    let run = engine.run();
    ARMED.store(false, Ordering::SeqCst);
    let (a2, d2, b2) = (
        ALLOCS.load(Ordering::SeqCst),
        DEALLOCS.load(Ordering::SeqCst),
        BYTES.load(Ordering::SeqCst),
    );
    eprintln!(
        "full run window: {a2} allocs / {d2} deallocs / {b2} bytes → state {:?} \
         (REPORTED: residue attributable to M4a generator arena growth — flagged, not asserted)",
        run.result.state
    );
    assert_eq!(run.result.state, TerminalState::Solved, "positive scene must still solve");
}
