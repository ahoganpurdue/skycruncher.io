//! solve/inspect command implementations. The CLI is the ONLY env-reading layer:
//! flags → one immutable resolved SolveConfig; git/clock/file-system stay up here.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use anyhow::{Context, Result};

use solver_contracts::config::{BandOrder, ReleaseVerifyMode, SolveConfig};
use solver_contracts::request::{Detection, Priors, SolveRequest};
use solver_contracts::result::TerminalState;
use solver_core::coordinator;
use solver_core::deskcheck::{self, DeskReport, Layer5, TruthFixture};
use solver_core::index::{IndexError, QuadIndex};
use solver_core::runtime::SolveRuntime;

/// Parse the banked detections file (measured schema: top-level `detections[]` with
/// x/y/flux/peak_value/fwhm/snr + extra fields, ignored). Value-based parsing keeps the
/// CLI free of a serde-derive dependency; the CONTRACT id is the ARRAY INDEX (the raw
/// file `id` field is NON-unique in banked data — prep.rs rank-semantics note).
fn parse_banked(raw: &[u8]) -> Result<(Option<String>, Vec<Detection>)> {
    let v: serde_json::Value = serde_json::from_slice(raw).context("detections JSON parse")?;
    let frame = v.get("frame").and_then(|f| f.as_str()).map(|s| s.to_string());
    let arr = v
        .get("detections")
        .and_then(|d| d.as_array())
        .context("missing top-level detections[] array")?;
    let f = |row: &serde_json::Value, key: &str| -> Option<f64> {
        row.get(key).and_then(|x| x.as_f64())
    };
    let mut out = Vec::with_capacity(arr.len());
    for (i, row) in arr.iter().enumerate() {
        let (Some(x), Some(y), Some(flux)) = (f(row, "x"), f(row, "y"), f(row, "flux")) else {
            anyhow::bail!("detections[{i}] missing x/y/flux");
        };
        out.push(Detection {
            id: i as u32,
            x,
            y,
            flux,
            peak_value: f(row, "peak_value").unwrap_or(f64::NAN),
            fwhm: f(row, "fwhm").unwrap_or(f64::NAN),
            snr: f(row, "snr").unwrap_or(f64::NAN),
        });
    }
    Ok((frame, out))
}

/// CLI-side mirror of `BandOrder` (keeps clap out of solver-contracts). kebab-case value
/// names: `ascending` | `descending` | `cheapest-first`.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum BandOrderArg {
    Ascending,
    Descending,
    CheapestFirst,
}

impl From<BandOrderArg> for BandOrder {
    fn from(a: BandOrderArg) -> Self {
        match a {
            BandOrderArg::Ascending => BandOrder::Ascending,
            BandOrderArg::Descending => BandOrder::Descending,
            BandOrderArg::CheapestFirst => BandOrder::CheapestFirst,
        }
    }
}

pub struct SolveArgs {
    pub detections: String,
    pub width: u32,
    pub height: u32,
    pub index: String,
    pub receipt_out: Option<String>,
    pub scale_lo: Option<f64>,
    pub scale_hi: Option<f64>,
    pub budget_ms: Option<u64>,
    pub verify_full: bool,
    pub verify_none: bool,
    pub stamp_dir: Option<String>,
    pub git_commit: Option<String>,
    pub frame_id: Option<String>,
    /// Band sweep order (SearchPolicy.band_order). Default Ascending = current behavior.
    pub band_order: BandOrder,
    /// Optional per-(rung, band) in-tol hit budget (SearchPolicy). None = uncapped.
    pub band_hit_budget: Option<u64>,
    /// Abort the search at the confirmed freeze (SearchPolicy.abort_on_accept). Default false
    /// = current drain-all behavior.
    pub abort_on_accept: bool,
    /// Band-MAJOR search structure (SearchPolicy.band_major): code+verify bands coarse→fine,
    /// one band before any finer band is coded. Default false = det-quad-major (band-inner).
    pub band_major: bool,
}

fn default_stamp_dir(index_dir: &Path) -> PathBuf {
    index_dir
        .parent()
        .map(|p| p.join("solver_stamps"))
        .unwrap_or_else(|| PathBuf::from("solver_stamps"))
}

/// Open the release under the configured policy. Stamp mode on first contact (no stamp
/// yet) upgrades to a Full pass automatically (plan: "first contact / --verify-full =
/// full"), which also writes the stamp for next time.
fn open_index(
    dir: &Path,
    mode: ReleaseVerifyMode,
    stamp_dir: &Path,
    prefetch: bool,
) -> Result<QuadIndex> {
    match QuadIndex::open(dir, mode, Some(stamp_dir), prefetch) {
        Ok(ix) => Ok(ix),
        Err(IndexError::StampMissing(_)) if mode == ReleaseVerifyMode::Stamp => {
            eprintln!("no verification stamp — first contact, running a FULL sha256 pass");
            Ok(QuadIndex::open(dir, ReleaseVerifyMode::Full, Some(stamp_dir), prefetch)?)
        }
        Err(e) => Err(e.into()),
    }
}

fn utc_now_string() -> String {
    // Seconds-precision UTC without a chrono dependency.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

fn resolve_git_commit(explicit: Option<String>) -> String {
    if let Some(c) = explicit {
        return c;
    }
    let out = Command::new("git").args(["rev-parse", "HEAD"]).output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => "UNVERIFIED".to_string(),
    }
}

pub fn inspect_release(dir: &str, verify_full: bool, stamp_dir: Option<&str>) -> Result<()> {
    let dir = Path::new(dir);
    let stamp = stamp_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| default_stamp_dir(dir));
    let mode = if verify_full {
        ReleaseVerifyMode::Full
    } else {
        ReleaseVerifyMode::Stamp
    };
    let t = Instant::now();
    let ix = open_index(dir, mode, &stamp, true)?;
    let open_ms = t.elapsed().as_millis() as u64;

    let bands: Vec<serde_json::Value> = ix
        .manifest
        .bands
        .iter()
        .map(|b| {
            serde_json::json!({
                "index": b.index,
                "lo_deg": b.lo_deg,
                "hi_deg": b.hi_deg,
                "mag_limit": b.mag_limit,
                "n_quads": b.n_quads,
                "batches": b.batches.len(),
                "bytes": b.bytes,
            })
        })
        .collect();
    let summary = serde_json::json!({
        "release": ix.manifest.release,
        "dir": ix.dir.display().to_string(),
        "format_version": ix.manifest.format_version,
        "verify_mode": ix.verify.receipt_marker(),
        "aggregate_md5": ix.manifest.aggregate_md5,
        "stars": { "rows": ix.stars.n_rows, "bytes": ix.manifest.stars.bytes },
        "totals": { "quads": ix.manifest.totals.quads, "stars": ix.manifest.totals.stars,
                     "bytes": ix.manifest.totals.bytes },
        "bands": bands,
        "timings_ms": {
            "open_total": open_ms,
            "verify": ix.open_stats.verify_ms,
            "prefetch": ix.open_stats.prefetch_ms,
            "parse": ix.open_stats.parse_ms,
        },
    });
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

pub fn solve(args: SolveArgs) -> Result<()> {
    // ── input: banked detections (contract id = array index; see prep.rs rank note) ──
    let det_path = Path::new(&args.detections);
    let raw = std::fs::read(det_path)
        .with_context(|| format!("reading detections {}", det_path.display()))?;
    let input_digest = coordinator::sha256_hex(&raw);
    let (banked_frame, detections) =
        parse_banked(&raw).with_context(|| format!("parsing detections {}", det_path.display()))?;
    let frame_id = args
        .frame_id
        .clone()
        .or(banked_frame)
        .unwrap_or_else(|| {
            det_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "frame".into())
        });

    // ── resolved config + request classification (derived, never asserted) ──
    let mut config = SolveConfig::default();
    let default_lo = config.search.scale_lo_asec;
    let default_hi = config.search.scale_hi_asec;
    let mut priors = Priors::default();
    if let (Some(lo), Some(hi)) = (args.scale_lo, args.scale_hi) {
        anyhow::ensure!(lo > 0.0 && hi > lo, "invalid scale window [{lo}, {hi}]");
        config.search.scale_lo_asec = lo;
        config.search.scale_hi_asec = hi;
        // The blind default window stays BLIND; anything narrower is a hint.
        if lo != default_lo || hi != default_hi {
            priors.scale_window = Some((lo, hi));
        }
    } else if args.scale_lo.is_some() || args.scale_hi.is_some() {
        anyhow::bail!("--scale-lo and --scale-hi must be passed together");
    }
    if let Some(b) = args.budget_ms {
        config.search.budget_ms = b;
    }
    // Search-policy band sweep order + optional per-band hit budget (absent flags = default
    // = current behavior; ascending + None keep the receipt byte-identical).
    config.search.band_order = args.band_order;
    config.search.per_rung_band_hit_budget = args.band_hit_budget;
    config.search.abort_on_accept = args.abort_on_accept;
    config.search.band_major = args.band_major;
    anyhow::ensure!(
        !(args.verify_full && args.verify_none),
        "--verify-full and --verify-none are mutually exclusive"
    );
    config.execution.release_verify = if args.verify_full {
        ReleaseVerifyMode::Full
    } else if args.verify_none {
        ReleaseVerifyMode::None
    } else {
        ReleaseVerifyMode::Stamp
    };

    let request = SolveRequest {
        frame_id: frame_id.clone(),
        width: args.width,
        height: args.height,
        detections,
        priors,
    };

    // ── index open under the configured checksum policy ──
    let index_dir = Path::new(&args.index);
    let stamp = args
        .stamp_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| default_stamp_dir(index_dir));
    let started_utc = utc_now_string();
    let t_total = Instant::now();
    let mut index = open_index(
        index_dir,
        config.execution.release_verify,
        &stamp,
        config.execution.prefetch,
    )
    .map_err(|e| {
        eprintln!("terminal_state: INDEX_UNAVAILABLE");
        e
    })?;

    // ── prepare → engine → run ──
    let prepared = coordinator::prepare(&request, &config, &mut index);
    let runtime = SolveRuntime::from_policy(&config.search);
    let mut engine = coordinator::Engine::new(&prepared, &index, &config, &runtime);
    let run = engine.run();
    let total_ms = t_total.elapsed().as_millis() as u64;

    // ── receipt ──
    let build = solver_core::build_info::build_info(resolve_git_commit(args.git_commit));
    let state = run.result.state;
    let headline = run.result.solved.as_ref().map(|s| {
        (
            s.wcs.crval.ra,
            s.wcs.crval.dec,
            s.scale_arcsec_px,
            s.parity_sign,
            s.final_verify.log_odds,
            s.matches.len(),
            s.band,
            s.rung,
        )
    });
    let receipt = coordinator::assemble_receipt(
        &frame_id,
        &input_digest,
        &request,
        &config,
        build,
        &index,
        &prepared,
        run,
        started_utc,
        config.execution.threads,
    );
    if let Some(out) = &args.receipt_out {
        let json = serde_json::to_string_pretty(&receipt)?;
        std::fs::write(out, json).with_context(|| format!("writing receipt {out}"))?;
    }

    // ── headline to stdout ──
    let state_str = match state {
        TerminalState::Solved => "SOLVED",
        TerminalState::NoMatch => "NO_MATCH",
        TerminalState::BudgetExhausted => "BUDGET_EXHAUSTED",
        TerminalState::Cancelled => "CANCELLED",
        TerminalState::IndexUnavailable => "INDEX_UNAVAILABLE",
        TerminalState::BackendFailed => "BACKEND_FAILED",
    };
    println!("terminal_state: {state_str}");
    println!("classification: {:?}", receipt.decision.classification);
    println!("decision_digest: {}", receipt.decision_digest);
    println!("wall_ms: {total_ms}");
    if let Some((ra, dec, scale, parity, odds, matches, band, rung)) = headline {
        println!("crval: RA {ra:.6} deg, Dec {dec:.6} deg");
        println!("scale: {scale:.6} arcsec/px  parity_sign: {parity}");
        println!("final_log_odds: {odds:.3}  matches: {matches}  band: {band}  rung: {rung}");
    }
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────
// desk-check (M4.5) — ORACLE_ASSISTED truth-family diagnostic, NEVER the blind path
// ───────────────────────────────────────────────────────────────────────────

/// Ladder cap for the desk-check (M4a/M4.5): bands ≥ 10 truth is fully in-pool @ 400; the
/// full ladder adds ~nothing to the gate and blows the budget.
const DESK_RUNG_MAX: u32 = 400;
/// Legacy whole-frame coding in-tol ceiling (§0 conformance) — the key-hit-rate baseline.
const DESK_LEGACY_BASELINE: f64 = 0.341;
/// Field-angle histogram bin upper edges (deg); the last bin is the overflow.
const FA_BINS: [f64; 4] = [10.0, 20.0, 30.0, 40.0];

pub fn desk_check(
    detections: &str,
    index: &str,
    truth_fixture: &str,
    report_out: Option<&str>,
) -> Result<()> {
    // ── detections (contract id = array index; raw `id` field is non-unique) ──
    let det_path = Path::new(detections);
    let det_raw = std::fs::read(det_path)
        .with_context(|| format!("reading detections {}", det_path.display()))?;
    let (_frame, dets) = parse_banked(&det_raw)
        .with_context(|| format!("parsing detections {}", det_path.display()))?;

    // ── truth fixture ──
    let fx_raw = std::fs::read_to_string(truth_fixture)
        .with_context(|| format!("reading truth fixture {truth_fixture}"))?;
    let fixture =
        TruthFixture::parse(&fx_raw).map_err(|e| anyhow::anyhow!("truth fixture parse: {e}"))?;
    anyhow::ensure!(
        dets.len() as u64 == fixture.det_count_raw,
        "detections drifted: {} rows vs fixture det_count_raw {}",
        dets.len(),
        fixture.det_count_raw
    );

    // ── index open (Stamp; first contact upgrades to a Full sha256 pass) ──
    let index_dir = Path::new(index);
    let stamp = default_stamp_dir(index_dir);
    let mut ix = open_index(index_dir, ReleaseVerifyMode::Stamp, &stamp, true)?;
    let provenance = coordinator::index_provenance(&ix);

    eprintln!(
        "desk-check [{}] frame {} ({}x{}) release {} — running the shared solver_core::deskcheck walk (rung<={DESK_RUNG_MAX})",
        deskcheck::CLASSIFICATION, fixture.frame, fixture.width, fixture.height, fixture.release
    );
    let t = Instant::now();
    let report = deskcheck::run(&dets, &mut ix, &fixture, DESK_RUNG_MAX);
    eprintln!("desk-check walk complete in {} ms", t.elapsed().as_millis());

    print_desk_summary(&report, &fixture, index);

    if let Some(out) = report_out {
        let json = desk_report_json(&report, &fixture, index, &provenance);
        std::fs::write(out, serde_json::to_string_pretty(&json)?)
            .with_context(|| format!("writing report {out}"))?;
        eprintln!("wrote report JSON {out}");
    }
    Ok(())
}

/// Class of a layer-5 outcome ("accept" / "bail" / "undecided" / "pose_rejected:<reason>").
fn layer5_class(l5: &Layer5) -> String {
    match l5 {
        Layer5::PoseRejected(r) => format!("pose_rejected:{r}"),
        Layer5::Verified(w) => {
            if w.accept {
                "accept".into()
            } else if w.bailed {
                "bail".into()
            } else {
                "undecided".into()
            }
        }
    }
}

fn fa_bin(deg: f64) -> usize {
    for (i, &e) in FA_BINS.iter().enumerate() {
        if deg < e {
            return i;
        }
    }
    FA_BINS.len()
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Human-readable summary → stdout (captured into the run log; every MD number sources here).
fn print_desk_summary(report: &DeskReport, fixture: &TruthFixture, index_dir: &str) {
    println!("=== M4.5 desk-check [{}] ===", report.classification);
    println!(
        "frame {} ({}x{})  release {}  index {}",
        fixture.frame, fixture.width, fixture.height, fixture.release, index_dir
    );
    println!(
        "rung_max {}  code_tol {}  log_accept {:.6}",
        report.rung_max, report.code_tol, report.log_accept
    );
    println!(
        "prep: raw {} valid {} deduped {} pool {} peak_arm_promoted {}",
        report.prep.raw, report.prep.valid, report.prep.deduped, report.prep.pool,
        report.prep.peak_arm_promoted
    );
    println!(
        "timings_ms: prep {}  walk {}  layer5 {}",
        report.prep_ms, report.walk_ms, report.layer5_ms
    );
    let walls: Vec<String> = report
        .rung_walls
        .iter()
        .map(|(end, ms)| format!("<= {end}: {ms}ms"))
        .collect();
    println!("rung walls: {}", walls.join(" | "));

    // ── attrition table ──
    println!();
    println!("--- per-band attrition (in-pool/enum/... measured among in-pool sets) ---");
    println!(
        "{:>4} | {:>5} {:>7} {:>7} {:>10} {:>11} {:>7} {:>13}",
        "band", "total", "present", "inpool", "enumerated", "code_in_tol", "key_hit", "wverify_acc"
    );
    for b in report.band_ids() {
        let a = report.band_agg(b);
        println!(
            "{:>4} | {:>5} {:>7} {:>7} {:>10} {:>11} {:>7} {:>13}",
            a.band, a.total, a.present, a.in_pool, a.enumerated, a.code_in_tol, a.key_hit,
            a.would_verify_accept
        );
    }
    let (ip, en, kh, wv) = report.ge10_totals();
    println!(
        "bands>=10 totals: in-pool {ip} -> enumerated {en} -> KEY-HIT {kh} -> would-verify-accept {wv}"
    );
    for r in [100u32, 200, 400] {
        println!("gate(a) in-pool bands>=10 @<={r}: {}", report.in_pool_ge10_at(r));
    }
    let (enum_total, hit_total, rate) = report.enumerated_keyhit_rate();
    println!(
        "gate(c) key-hit rate among enumerated (all fixture bands): {rate:.4} ({hit_total}/{enum_total}) vs legacy {DESK_LEGACY_BASELINE:.3}"
    );
    println!("parity hits: p0={} p1={}", report.parity_hits[0], report.parity_hits[1]);

    // ── layer 2b: code-in-tol vs field angle ──
    println!();
    println!("--- layer 2b: code error vs field angle (ENUMERATED sets with a stored truth code) ---");
    let mut fa_counts = [0u32; FA_BINS.len() + 1];
    let mut fa_intol = [0u32; FA_BINS.len() + 1];
    let mut fa_dists: Vec<Vec<f64>> = (0..=FA_BINS.len()).map(|_| Vec::new()).collect();
    let (mut n_enum_coded, mut n_intol, mut n_intol_not_keyhit) = (0u32, 0u32, 0u32);
    for s in &report.sets {
        if !(s.enumerated && s.in_pool(report.rung_max)) {
            continue;
        }
        let (Some(d), Some(fa)) = (s.min_code_dist, s.field_angle_deg) else { continue };
        n_enum_coded += 1;
        let bin = fa_bin(fa);
        fa_counts[bin] += 1;
        fa_dists[bin].push(d);
        if d <= report.code_tol {
            n_intol += 1;
            fa_intol[bin] += 1;
            if !s.key_hit {
                n_intol_not_keyhit += 1;
            }
        }
    }
    println!(
        "enumerated-with-stored-code {n_enum_coded}: code_in_tol {n_intol} (in-tol-but-NOT-key-hit {n_intol_not_keyhit} = bin-edge/collision loss)"
    );
    println!(
        "{:>12} | {:>6} {:>8} {:>12} {:>12}",
        "field_angle", "n", "in_tol", "median_dist", "min_dist"
    );
    for bin in 0..=FA_BINS.len() {
        if fa_counts[bin] == 0 {
            continue;
        }
        let label = if bin < FA_BINS.len() {
            let lo = if bin == 0 { 0.0 } else { FA_BINS[bin - 1] };
            format!("[{lo:.0},{:.0})", FA_BINS[bin])
        } else {
            format!("[{:.0},inf)", FA_BINS[FA_BINS.len() - 1])
        };
        let dists = &fa_dists[bin];
        let med = median(dists.clone());
        let mn = dists.iter().cloned().fold(f64::INFINITY, f64::min);
        println!(
            "{label:>12} | {:>6} {:>8} {:>12.5} {:>12.5}",
            fa_counts[bin], fa_intol[bin], med, mn
        );
    }

    // ── layer 5: would-verify log-odds distribution ──
    println!();
    println!("--- layer 5: would-verify at key-hit poses ({}) ---", report.classification);
    let mut n_keyhit = 0u32;
    let mut classes: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    let mut odds: Vec<f64> = Vec::new();
    let mut n_matched: Vec<u32> = Vec::new();
    for s in &report.sets {
        let Some(l5) = &s.layer5 else { continue };
        n_keyhit += 1;
        *classes.entry(layer5_class(l5)).or_insert(0) += 1;
        if let Layer5::Verified(w) = l5 {
            odds.push(w.log_odds);
            n_matched.push(w.n_matched);
        }
    }
    println!("key-hit sets probed: {n_keyhit}");
    for (cls, n) in &classes {
        println!("  {cls}: {n}");
    }
    if !odds.is_empty() {
        let mn = odds.iter().cloned().fold(f64::INFINITY, f64::min);
        let mx = odds.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let mean = odds.iter().sum::<f64>() / odds.len() as f64;
        let mm = n_matched.iter().sum::<u32>() as f64 / n_matched.len() as f64;
        println!(
            "verified probes {}: log_odds min {mn:.3} / median {:.3} / mean {mean:.3} / max {mx:.3} (opts_scan early-stops accepts at log_accept={:.3}); mean n_matched {mm:.1}",
            odds.len(), median(odds.clone()), report.log_accept
        );
        println!(
            "ref gather (last probe): {} rows / {} nonempty tiles",
            report.last_gather, report.last_gather_tiles
        );
    }
}

/// Build the machine-readable report JSON.
fn desk_report_json(
    report: &DeskReport,
    fixture: &TruthFixture,
    index_dir: &str,
    provenance: &solver_contracts::receipt::IndexProvenance,
) -> serde_json::Value {
    let bands: Vec<serde_json::Value> = report
        .band_ids()
        .into_iter()
        .map(|b| {
            let a = report.band_agg(b);
            serde_json::json!({
                "band": a.band, "total": a.total, "present": a.present, "in_pool": a.in_pool,
                "enumerated": a.enumerated, "code_in_tol": a.code_in_tol, "key_hit": a.key_hit,
                "would_verify_accept": a.would_verify_accept,
            })
        })
        .collect();

    let (ip, en, kh, wv) = report.ge10_totals();
    let (enum_total, hit_total, rate) = report.enumerated_keyhit_rate();

    // layer 2b per-set samples (enumerated, in-pool, coded)
    let layer2: Vec<serde_json::Value> = report
        .sets
        .iter()
        .filter(|s| s.enumerated && s.in_pool(report.rung_max) && s.min_code_dist.is_some())
        .map(|s| {
            serde_json::json!({
                "band": s.band, "stars": s.stars,
                "field_angle_deg": s.field_angle_deg,
                "min_code_dist": s.min_code_dist,
                "min_code_sample_s": s.min_code_sample_s,
                "in_tol": s.code_in_tol(report.code_tol),
                "key_hit": s.key_hit,
            })
        })
        .collect();

    // layer 5 per-key-hit samples
    let layer5: Vec<serde_json::Value> = report
        .sets
        .iter()
        .filter(|s| s.layer5.is_some())
        .map(|s| {
            let l5 = s.layer5.as_ref().unwrap();
            let mut o = serde_json::json!({
                "band": s.band, "stars": s.stars, "class": layer5_class(l5),
            });
            if let Layer5::Verified(w) = l5 {
                o["log_odds"] = serde_json::json!(w.log_odds);
                o["accept"] = serde_json::json!(w.accept);
                o["bailed"] = serde_json::json!(w.bailed);
                o["n_matched"] = serde_json::json!(w.n_matched);
                o["n_ref"] = serde_json::json!(w.n_ref);
                o["n_test"] = serde_json::json!(w.n_test);
                o["gather"] = serde_json::json!(w.gather);
                o["tiles"] = serde_json::json!(w.tiles);
            }
            o
        })
        .collect();

    let mut l5_classes: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    let mut odds: Vec<f64> = Vec::new();
    for s in &report.sets {
        if let Some(l5) = &s.layer5 {
            *l5_classes.entry(layer5_class(l5)).or_insert(0) += 1;
            if let Layer5::Verified(w) = l5 {
                odds.push(w.log_odds);
            }
        }
    }
    let odds_summary = if odds.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::json!({
            "n": odds.len(),
            "min": odds.iter().cloned().fold(f64::INFINITY, f64::min),
            "median": median(odds.clone()),
            "mean": odds.iter().sum::<f64>() / odds.len() as f64,
            "max": odds.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            "note": "opts_scan (blind proposal opts): accepts early-stop at log_accept",
        })
    };

    serde_json::json!({
        "classification": report.classification,
        "frame": fixture.frame,
        "release": fixture.release,
        "fixture_schema": fixture.schema,
        "index_dir": index_dir,
        "width": fixture.width,
        "height": fixture.height,
        "rung_max": report.rung_max,
        "code_tol": report.code_tol,
        "log_accept": report.log_accept,
        "index_provenance": {
            "release_id": provenance.release_id,
            "aggregate_md5": provenance.aggregate_md5,
            "verify_mode": provenance.verify_mode,
            "total_quads": provenance.total_quads,
            "total_stars": provenance.total_stars,
            "bands_present": provenance.bands_present,
        },
        "prep": {
            "raw": report.prep.raw, "valid": report.prep.valid, "deduped": report.prep.deduped,
            "pool": report.prep.pool, "peak_arm_promoted": report.prep.peak_arm_promoted,
        },
        "timings_ms": { "prep": report.prep_ms, "walk": report.walk_ms, "layer5": report.layer5_ms },
        "rung_walls": report.rung_walls.iter().map(|(e, m)| serde_json::json!([e, m])).collect::<Vec<_>>(),
        "parity_hits": report.parity_hits,
        "bands": bands,
        "gate_a_in_pool_ge10": {
            "100": report.in_pool_ge10_at(100),
            "200": report.in_pool_ge10_at(200),
            "400": report.in_pool_ge10_at(400),
        },
        "ge10_totals": { "in_pool": ip, "enumerated": en, "key_hit": kh, "would_verify_accept": wv },
        "gate_c": {
            "enumerated": enum_total, "key_hit": hit_total, "rate": rate,
            "legacy_baseline": DESK_LEGACY_BASELINE,
        },
        "layer5_classes": l5_classes,
        "layer5_log_odds": odds_summary,
        "last_ref_gather": { "rows": report.last_gather, "tiles": report.last_gather_tiles },
        "layer2_samples": layer2,
        "layer5_samples": layer5,
    })
}
