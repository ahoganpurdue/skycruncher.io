//! solver-cli — the only executable frontend (v0) and the ONLY layer that reads the
//! environment (flags, cwd, git, wall clock). Everything below consumes one immutable
//! resolved `SolveConfig` (audit P0-5).
//!
//! Subcommands:
//!   solve            — blind/hinted solve of one frame from a banked detections JSON
//!   inspect-release  — open + validate an index release, print a JSON summary
//!   desk-check       — reserved (M4.5 lane)
//!   golden-extract   — reserved (Node-side tooling covers M2 extraction)
//!   version          — build/config stamp
//!
//! Banked detections schema (measured, corpus_grad_2026-07-18): top-level `detections[]`
//! rows with id/x/y/flux/peak_value/fwhm/snr (+ extra fields, ignored). The CONTRACT
//! detection id is the ARRAY INDEX (prep.rs: the raw file `id` field is NON-unique in
//! banked CSM30799 — never used as identity).

mod solve_cmd;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "solver-cli", version, about = "SkyCruncher greenfield solver core (native CLI)")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Validate + summarize an index release (manifest, checksums, counts). (M1)
    InspectRelease {
        /// Release directory (contains manifest.json, stars.arrow, band_*.arrow)
        dir: String,
        /// Force full sha256 verification
        #[arg(long)]
        verify_full: bool,
        /// Stamp directory (default: <release parent>/solver_stamps)
        #[arg(long)]
        stamp_dir: Option<String>,
    },
    /// Extract coder golden vectors from a release. (Node tooling owns this — see
    /// crates/conformance/golden_extract.mjs.)
    GoldenExtract {
        dir: String,
        #[arg(long, default_value_t = 112)]
        count: u32,
        #[arg(long)]
        out: String,
    },
    /// Blind/hinted solve of one frame from a banked detections JSON. (M4b)
    Solve {
        #[arg(long)]
        detections: String,
        #[arg(long)]
        width: u32,
        #[arg(long)]
        height: u32,
        #[arg(long)]
        index: String,
        #[arg(long)]
        receipt_out: Option<String>,
        /// Narrowed scale window (arcsec/px). Passing the blind default (0.5, 300)
        /// keeps the request BLIND; anything narrower classifies HINTED.
        #[arg(long)]
        scale_lo: Option<f64>,
        #[arg(long)]
        scale_hi: Option<f64>,
        /// Wall-clock budget in ms (default: SearchPolicy default 90000)
        #[arg(long)]
        budget_ms: Option<u64>,
        /// Force full sha256 release verification
        #[arg(long)]
        verify_full: bool,
        /// Skip release verification (receipt marked SKIPPED_UNVERIFIED)
        #[arg(long)]
        verify_none: bool,
        /// Stamp directory (default: <release parent>/solver_stamps)
        #[arg(long)]
        stamp_dir: Option<String>,
        /// Git commit stamp override (else resolved via `git rev-parse HEAD`, else UNVERIFIED)
        #[arg(long)]
        git_commit: Option<String>,
        /// Frame id for the receipt (default: detections file stem)
        #[arg(long)]
        frame_id: Option<String>,
        /// Band sweep order within each det-quad: ascending (default) | descending |
        /// cheapest-first. SEARCH POLICY (not a calibrated gate); default = current behavior.
        #[arg(long, value_enum, default_value = "ascending")]
        band_order: solve_cmd::BandOrderArg,
        /// Optional per-(rung, band) in-tolerance hit budget (default: uncapped).
        #[arg(long)]
        band_hit_budget: Option<u64>,
        /// Abort the search the instant an accept is CONFIRMED — skip the accepting rung's
        /// remaining coding/probing/drain work. SEARCH POLICY (not a calibrated gate);
        /// default off = current drain-all behavior.
        #[arg(long)]
        abort_on_accept: bool,
        /// Band-MAJOR search: within each rung, code+probe+verify bands coarse→fine, a whole
        /// band before any finer band is coded (composes with --abort-on-accept). SEARCH
        /// POLICY (not a calibrated gate); default off = det-quad-major (band-inner).
        #[arg(long)]
        band_major: bool,
    },
    /// ORACLE_ASSISTED truth-family desk-check (diagnostic; NEVER the blind path). Walks the
    /// banked detections through the shared `solver_core::deskcheck` layers 1-5 against the
    /// oracle-derived truth fixture. Frame dims come from the fixture (no width/height flags). (M4.5)
    DeskCheck {
        #[arg(long)]
        detections: String,
        #[arg(long)]
        index: String,
        /// Truth fixture JSON (crates/solver-core/tests/fixtures/truth_csm30799.json).
        #[arg(long)]
        truth_fixture: String,
        /// Report JSON output path (a human-readable summary always prints to stdout).
        #[arg(long)]
        report_out: Option<String>,
    },
    /// Print build/config stamp.
    Version,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Version => {
            println!(
                "solver-core {} coder {} verify {} | target {} opt {} profile {} rustflags '{}'",
                solver_contracts::SOLVER_CORE_VERSION,
                solver_contracts::QUAD_CODER_VERSION,
                solver_contracts::VERIFY_POLICY_VERSION,
                solver_core::build_info::TARGET,
                solver_core::build_info::OPT_LEVEL,
                solver_core::build_info::PROFILE,
                solver_core::build_info::RUSTFLAGS,
            );
            Ok(())
        }
        Cmd::InspectRelease {
            dir,
            verify_full,
            stamp_dir,
        } => solve_cmd::inspect_release(&dir, verify_full, stamp_dir.as_deref()),
        Cmd::Solve {
            detections,
            width,
            height,
            index,
            receipt_out,
            scale_lo,
            scale_hi,
            budget_ms,
            verify_full,
            verify_none,
            stamp_dir,
            git_commit,
            frame_id,
            band_order,
            band_hit_budget,
            abort_on_accept,
            band_major,
        } => solve_cmd::solve(solve_cmd::SolveArgs {
            detections,
            width,
            height,
            index,
            receipt_out,
            scale_lo,
            scale_hi,
            budget_ms,
            verify_full,
            verify_none,
            stamp_dir,
            git_commit,
            frame_id,
            band_order: band_order.into(),
            band_hit_budget,
            abort_on_accept,
            band_major,
        }),
        Cmd::GoldenExtract { .. } => {
            anyhow::bail!("golden-extract is Node tooling: crates/conformance/golden_extract.mjs")
        }
        Cmd::DeskCheck {
            detections,
            index,
            truth_fixture,
            report_out,
        } => solve_cmd::desk_check(&detections, &index, &truth_fixture, report_out.as_deref()),
    }
}
