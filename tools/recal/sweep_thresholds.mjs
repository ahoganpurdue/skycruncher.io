#!/usr/bin/env node
// tools/recal/sweep_thresholds.mjs
// ═══════════════════════════════════════════════════════════════════════════
// PAIRED THRESHOLD-RECAL SWEEP — RECOMMENDER-ONLY scaffold (decoder cutover #14)
// ═══════════════════════════════════════════════════════════════════════════
//
// Loads N frames' detection dumps (+ optional truth labels) and emits recall/
// precision per m4 constant-set candidate, so the cutover session can re-derive
// the detection thresholds against RAWLER output (never libraw — RECAL_DESIGN.md).
//
//   node tools/recal/sweep_thresholds.mjs                                  # baseline banner (NOT MEASURED without inputs)
//   node tools/recal/sweep_thresholds.mjs --dump=<det.json>                # INGEST (survivor counts; NO truth ⇒ recall/precision NOT MEASURED)
//   node tools/recal/sweep_thresholds.mjs --dump=a.json --dump=b.json ...  # N frames (aggregation seam)
//   node tools/recal/sweep_thresholds.mjs --dump=... --truth=... [--sigmas=2.0,2.5,3.0] [--json]
//   node tools/recal/sweep_thresholds.mjs --decode=<raw> [--arm=rawler] [--sigmas=...]   # DECODE→DUMP end-to-end
//
// ── HARD BOUNDARY: RECOMMENDER-ONLY ──────────────────────────────────────────
// This tool NEVER edits a constant. It reads current values (live where leaf-
// loadable, mirrored-with-citation otherwise) and reports candidate → metrics.
// Any change to pipeline_config.ts / signal_processor.ts is applied BY THE OWNER
// under calibrated-gate discipline. Same posture as tools/adaptive.
//
// ── HONEST-OR-ABSENT ─────────────────────────────────────────────────────────
// No recall/precision without truth labels. Missing truth, or a candidate
// dimension the dump cannot support, report NOT MEASURED — never a fabricated
// number. With a dump but no truth, the tool still INGESTS (survivor counts per
// candidate) so the DECODE→DUMP pipe is provable end-to-end, but emits NO
// RECOMMENDATION. Candidate sigmas above the engine's native sigma are realized
// as per-detection SNR floors (POST-HOC), not true pixel-level sigma re-runs.

import { PIPELINE_CONSTANTS as PC }
    from '../../src/engine/pipeline/constants/pipeline_config.ts';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── literals mirrored from a NON-leaf module (signal_processor.ts) ────────────
// signal_processor.ts imports the photometry stack ⇒ not Node-loadable under
// native type-stripping, so these two live values are MIRRORED with a citation
// (same pattern as tools/solverkit/contract.mjs VERIFY_NET). Keep in sync by hand;
// recal RECOMMENDS a change to them, the owner EDITS the literal.
const MIRROR = Object.freeze({
    sigFactor: 2.0,          // signal_processor.ts:51  — analyze() primary threshold
    sigmaCurrentBase: 3.0,   // signal_processor.ts:314 — vanguard base, FL-scaled [0.6,2.0]
});

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const argVal = (flag, dflt = null) => {
    const hit = argv.find((a) => a.startsWith(flag + '='));
    return hit ? hit.slice(flag.length + 1) : dflt;
};
// multi-valued: every `--dump=`/`--truth=` occurrence + comma-list forms.
const argAll = (flag) => argv.filter((a) => a.startsWith(flag + '='))
    .map((a) => a.slice(flag.length + 1))
    .flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const MATCH_RADIUS_PX = Number(argVal('--radius', '3'));
const SIGMAS = (argVal('--sigmas', '') || '').split(',')
    .map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const DECODE_PATH = argVal('--decode');
const DECODE_ARM = argVal('--arm', 'rawler');

const NM = 'NOT MEASURED';

// ── DECODE seam: rawler frames drop in here (was STUBBED; now REAL) ───────────
// DECODE mode is realized by tools/recal/dump_detections.mjs (the SINGLE decode
// implementation — no fork): it runs the REAL m4 on the rawler-decoded grid and
// writes a dump. `fromRawler` spawns it and hands the dump to `fromDump`, so a
// raw file can be swept end-to-end. DUMP mode reads an existing dump directly.
const DecodeSource = {
    /** Cutover seam, NOW WIRED: spawn dump_detections.mjs → dump path. */
    fromRawler(rawPath, { arm = 'rawler', sigmas = '' } = {}) {
        const outDir = mkdtempSync(path.join(tmpdir(), 'recal_decode_'));
        const outPath = path.join(outDir, `${path.basename(rawPath).replace(/\W+/g, '_')}.dump.json`);
        const args = [path.join(ROOT, 'tools', 'recal', 'dump_detections.mjs'),
            rawPath, `--arm=${arm}`, `--out=${outPath}`];
        if (sigmas) args.push(`--sigmas=${sigmas}`);
        const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 1_200_000 });
        if (!existsSync(outPath)) {
            throw new Error(`DecodeSource.fromRawler: dump_detections produced no dump (exit ${r.status}). Tail:\n${(r.stdout ?? '').split('\n').slice(-8).join('\n')}`);
        }
        return { mode: 'DECODE', dumpPath: outPath, ...loadDump(outPath) };
    },
    /** Today's path: a static detection dump from disk. */
    fromDump(dumpPath) {
        return { mode: 'DUMP', dumpPath, ...loadDump(dumpPath) };
    },
};

function loadDump(dumpPath) {
    const raw = JSON.parse(readFileSync(dumpPath, 'utf8'));
    const detections = Array.isArray(raw) ? raw : (raw.detections ?? []);
    const meta = Array.isArray(raw) ? null : (raw.meta ?? null);
    return { detections, meta };
}
function loadTruth(truthPath) {
    if (!truthPath || !existsSync(truthPath)) return null;
    return JSON.parse(readFileSync(truthPath, 'utf8'));
}

// ── the current (baseline) constant-set, read LIVE where possible ─────────────
function baselineConstantSet() {
    return {
        name: 'baseline (current constants)',
        // pixel-level (DECODE mode only — mirrored literals):
        sigFactor: MIRROR.sigFactor,
        sigmaCurrentBase: MIRROR.sigmaCurrentBase,
        // dump-applicable per-blob shape gates (LIVE from PIPELINE_CONSTANTS):
        fwhmFloorPx: PC.DETECT_FWHM_FLOOR_PX,
        sharpnessMax: PC.DETECT_SHARPNESS_MAX,
        ellipticityMax: PC.DETECT_ELLIPTICITY_MAX,
        // optional per-detection SNR floor (dump-applicable if dump carries snr):
        snrFloor: null,
        // frame-level guards (NOT per-detection re-appliable to a dump — carried for record):
        hotpixelNsigma: PC.DETECT_HOTPIXEL_NSIGMA,
        maxDensityPerMp: PC.DETECT_MAX_CANDIDATE_DENSITY_PER_MP,
    };
}

// ── apply a candidate's DUMP-mode filters to a detection list ─────────────────
// Returns { survivors, notMeasuredDims } — a dimension whose field is absent on the
// dump is NOT applied and reported NOT MEASURED (never silently treated as a pass).
function applyDumpCandidate(dets, cand) {
    const nm = new Set();
    const has = (key) => dets.some((d) => d[key] !== undefined && d[key] !== null);
    const shapeFwhm = has('fwhm');
    const shapeSharp = has('sharpness');
    const shapeEll = has('ellipticity');
    const hasSnr = has('snr');
    if (!shapeFwhm) nm.add('fwhmFloorPx (dump has no fwhm)');
    if (!shapeSharp) nm.add('sharpnessMax (dump has no sharpness)');
    if (!shapeEll) nm.add('ellipticityMax (dump has no ellipticity)');
    if (cand.snrFloor != null && !hasSnr) nm.add('snrFloor (dump has no snr)');

    const survivors = dets.filter((d) => {
        if (shapeFwhm && cand.fwhmFloorPx > 0 && d.fwhm < cand.fwhmFloorPx) return false;
        if (shapeSharp && Number.isFinite(cand.sharpnessMax) && d.sharpness > cand.sharpnessMax) return false;
        if (shapeEll && cand.ellipticityMax < 1 && d.ellipticity > cand.ellipticityMax) return false;
        if (cand.snrFloor != null && hasSnr && d.snr < cand.snrFloor) return false;
        return true;
    });
    return { survivors, notMeasuredDims: [...nm] };
}

// ── honest recall/precision against truth (AMBIGUOUS band excluded from precision) ─
function scoreAgainstTruth(survivors, truth, radiusPx) {
    const r2 = radiusPx * radiusPx;
    const stars = truth.stars ?? [];
    const limitingMag = truth.limitingMag ?? null;

    // recall: a truth star is matched if ANY survivor lands within radius.
    let matchedTruth = 0;
    const detMatched = new Array(survivors.length).fill(false);
    for (const s of stars) {
        let hit = false;
        for (let i = 0; i < survivors.length; i++) {
            const dx = survivors[i].x - s.x, dy = survivors[i].y - s.y;
            if (dx * dx + dy * dy <= r2) { hit = true; detMatched[i] = true; }
        }
        if (hit) matchedTruth++;
    }
    // precision: unmatched survivors split into confident-FP vs AMBIGUOUS.
    let confidentFP = 0, ambiguous = 0;
    for (let i = 0; i < survivors.length; i++) {
        if (detMatched[i]) continue;
        const mag = survivors[i].mag;
        if (limitingMag != null && mag != null && mag < limitingMag) confidentFP++;   // brighter than catalog reach
        else if (limitingMag != null && mag != null) ambiguous++;                      // fainter — catalog may miss it
        else ambiguous++;                                                              // unknown mag / no limit ⇒ ambiguous, never a confident FP
    }
    const recall = stars.length > 0 ? matchedTruth / stars.length : null;
    const precDenom = matchedTruth + confidentFP;
    const precision = precDenom > 0 ? matchedTruth / precDenom : null;
    return {
        recall, precision, matchedTruth, truthCount: stars.length,
        confidentFP, ambiguous, missed: stars.length - matchedTruth,
        precisionNote: 'AMBIGUOUS (fainter-than-limit / unknown-mag) survivors excluded from precision denominator',
    };
}

// ── candidate grid: baseline + shape variants + one SNR-floor candidate / sigma ─
// The REAL grid is frozen by the cutover session per RECAL_DESIGN §3; these
// illustrate the table shape. Sigma candidates are SNR floors (POST-HOC — the
// engine's native pixel-level sigma is a compiled literal, NOT re-run here).
//
// The dump is POST-CULL (m4 clean_stars), so the dump's shape fields ARE the
// engine-gate quantities (fwhm=moment_fwhm_px, ellipticity=moment_ellipticity)
// and the baseline candidate reproduces the native cut → keeps 100%. Candidates
// can only TIGHTEN (cull more); a truly LOOSER gate cannot recover already-culled
// blobs from a post-cull dump — that needs a pre-cull tap (engine-side), so the
// "gates OFF" row is labeled a post-cull SANITY (not a true recall ceiling).
function candidateGrid(base) {
    const grid = [
        base,
        { ...base, name: 'cand: gates OFF (post-cull sanity, NOT true recall ceiling)', fwhmFloorPx: 0, sharpnessMax: Infinity, ellipticityMax: 1 },
        { ...base, name: 'cand: ellipticity 0.60 (tighter streak guard)', ellipticityMax: 0.60 },
    ];
    // --sigmas realize as per-detection SNR floors in the DUMP's blob-SNR metric
    // (SignalPoint.snr). MEASURED CAVEAT: that metric is NOT on the engine's
    // pixel-sigma scale (measured median blob-SNR ~0.1–0.4 vs sigFactor=2 /
    // vanguard base=3), so a numeric "sigma" applied here is NOT the pixel-level
    // sigma sweep — it is a blob-SNR-units floor. A TRUE pixel-sigma re-run needs
    // an engine-side sigma injection (out of the tools/ lane) → NOT MEASURED.
    for (const s of SIGMAS) {
        grid.push({ ...base, name: `cand: SNR floor ${s.toFixed(2)} (blob-SNR units, NOT pixel sigma)`, snrFloor: s });
    }
    return grid;
}

// ── per-frame evaluation (ingest always; score only if truth present) ─────────
function evaluateFrame(frame, base) {
    const { detections, truth, dumpPath, meta } = frame;
    const rows = candidateGrid(base).map((cand) => {
        const { survivors, notMeasuredDims } = applyDumpCandidate(detections, cand);
        const score = truth ? scoreAgainstTruth(survivors, truth, MATCH_RADIUS_PX) : null;
        return {
            name: cand.name, kept: survivors.length, of: detections.length,
            recall: score?.recall ?? null, precision: score?.precision ?? null,
            matchedTruth: score?.matchedTruth ?? null, confidentFP: score?.confidentFP ?? null,
            ambiguous: score?.ambiguous ?? null, missed: score?.missed ?? null,
            notMeasuredDims,
        };
    });
    return {
        dump: path.relative(ROOT, dumpPath),
        decoder: meta?.decoder ?? 'UNKNOWN',
        detections: detections.length,
        truthSource: truth?.source ?? null,
        truthStars: truth?.stars?.length ?? null,
        scored: !!truth,
        candidates: rows,
    };
}

// ── run ───────────────────────────────────────────────────────────────────────
function run() {
    const base = baselineConstantSet();
    const banner = {
        tool: 'sweep_thresholds',
        posture: 'RECOMMENDER-ONLY — never edits a constant',
        singleSpend: 'runs ONCE at cutover #14, against rawler output, never libraw (see RECAL_DESIGN.md)',
        matchRadiusPx: MATCH_RADIUS_PX,
        sigmaCandidates: SIGMAS,
        sigmaNote: SIGMAS.length
            ? 'PIXEL-SIGMA SWEEP = NOT MEASURED. --sigmas are realized as per-detection SNR floors in the blob-SNR metric (SignalPoint.snr, median ~0.1–0.4), which is NOT the engine pixel-sigma scale (sigFactor=2 / vanguard base=3). A true pixel-level sigma re-run needs an engine-side sigma injection (out of the tools/ lane).'
            : null,
        baseline: base,
    };

    // Assemble frames from --decode (spawn dump_detections) and/or --dump list.
    const dumpPaths = argAll('--dump');
    const truthPaths = argAll('--truth');
    const frames = [];
    try {
        if (DECODE_PATH) {
            const src = DecodeSource.fromRawler(path.resolve(DECODE_PATH), { arm: DECODE_ARM, sigmas: SIGMAS.join(',') });
            frames.push({ ...src, truth: loadTruth(truthPaths[0] ?? null) });
        }
    } catch (err) {
        return { ...banner, status: NM, reason: `DECODE seam failed: ${String(err.message ?? err)}`, recommendation: null, frames: [] };
    }
    dumpPaths.forEach((dp, i) => {
        const abs = path.resolve(dp);
        if (!existsSync(abs)) { frames.push({ dumpPath: abs, missing: true }); return; }
        const src = DecodeSource.fromDump(abs);
        // pair a truth by index; the --decode frame (if any) consumed truthPaths[0].
        const ti = DECODE_PATH ? i + 1 : i;
        frames.push({ ...src, truth: loadTruth(truthPaths[ti] ?? null) });
    });

    if (frames.length === 0) {
        return {
            ...banner,
            status: NM,
            reason: 'no --dump/--decode supplied — DECODE mode needs a raw frame (via dump_detections.mjs) or a pre-made detection dump (land at cutover #14)',
            recommendation: null,
            frames: [],
        };
    }

    const missing = frames.filter((f) => f.missing);
    const usable = frames.filter((f) => !f.missing);
    const evaluated = usable.map((f) => evaluateFrame(f, base));
    const scoredCount = evaluated.filter((e) => e.scored).length;

    // recommender-only: NEVER auto-pick a winner. A recommendation requires the
    // §3 frozen criteria + N≥5 truth-labeled frames — neither is satisfiable from
    // the scaffold alone, so recommendation stays NULL (honest). Without truth the
    // status is INGESTED (survivor counts proven), not MEASURED.
    let status, note, recommendationNote;
    if (scoredCount === 0) {
        status = 'INGESTED (DUMP mode, survivor counts only — NO truth ⇒ recall/precision NOT MEASURED)';
        note = 'The DECODE→DUMP→sweep pipe is proven: dumps ingested and re-thresholded per candidate. recall/precision require truth labels (RECAL_DESIGN §1); none supplied.';
        recommendationNote = 'NO RECOMMENDATION — honest null: truth labels absent, so no recall/precision can be scored (RECAL_DESIGN §0 honest-or-absent).';
    } else if (scoredCount < 5) {
        status = `MEASURED (DUMP mode, ${scoredCount} truth-labeled frame(s) — below N≥5)`;
        note = 'Per-frame recall/precision scored where truth present; pixel-level sigma sweep is a POST-HOC SNR proxy (needs an engine-side sigma injection for a true re-run — out of the tools/ lane).';
        recommendationNote = `NO RECOMMENDATION — RECAL_DESIGN §3 requires N≥5 truth-labeled frames + frozen criteria; only ${scoredCount} present.`;
    } else {
        status = `MEASURED (DUMP mode, ${scoredCount} truth-labeled frames)`;
        note = 'N≥5 reached — the cutover session applies the §3 frozen criteria (pre-registered metric + distribution-grounded floors + never-worse guard + KILL BAR) across these frames to accept ONE candidate or emit NULL. The scaffold does NOT auto-accept.';
        recommendationNote = 'NO RECOMMENDATION from the scaffold — the frozen §3 acceptance criteria are a pre-registration the cutover session fills in; the scaffold never auto-promotes.';
    }

    return {
        ...banner,
        status,
        framesRequested: frames.length,
        framesUsable: usable.length,
        framesMissing: missing.map((f) => path.relative(ROOT, f.dumpPath)),
        framesScored: scoredCount,
        note,
        recommendation: null,
        recommendationNote,
        frames: evaluated,
    };
}

const result = run();

if (asJson) {
    console.log(JSON.stringify(result, null, 2));
} else {
    const line = '═'.repeat(75);
    console.log(line);
    console.log('THRESHOLD-RECAL SWEEP (RECOMMENDER-ONLY) — never edits a constant');
    console.log(`single spend: ${result.singleSpend}`);
    console.log(line);
    const b = result.baseline;
    console.log('\nbaseline constant-set (live where leaf-loadable; * = mirrored literal):');
    console.log(`  sigFactor*=${b.sigFactor}  sigmaCurrentBase*=${b.sigmaCurrentBase}  `
        + `fwhmFloorPx=${b.fwhmFloorPx}  sharpnessMax=${b.sharpnessMax}  ellipticityMax=${b.ellipticityMax}`);
    console.log(`  hotpixelNsigma=${b.hotpixelNsigma}  maxDensityPerMp=${b.maxDensityPerMp}  (frame-level guards, recorded)`);
    if (result.sigmaCandidates?.length) console.log(`  sigma candidates (blob-SNR-units SNR floors): ${result.sigmaCandidates.join(', ')}`);
    if (result.sigmaNote) console.log(`  ⚠ ${result.sigmaNote}`);

    console.log(`\nstatus: ${result.status}`);
    if (result.reason) console.log(`reason: ${result.reason}`);
    if (result.framesMissing?.length) console.log(`MISSING dumps: ${result.framesMissing.join(', ')}`);

    for (const fr of (result.frames ?? [])) {
        console.log(`\n── frame: ${fr.dump}  [${fr.decoder}]  detections=${fr.detections}  `
            + `${fr.scored ? `truth=${fr.truthSource} (${fr.truthStars} stars)` : 'NO TRUTH → survivor counts only'}`);
        console.log('  candidate                                     kept/of   recall  precision  matched  cFP  ambig  missed');
        for (const r of fr.candidates) {
            const f = (v) => (v == null ? ` ${NM}` : v.toFixed(3).padStart(7));
            const g = (v) => (v == null ? '  —' : String(v).padStart(4));
            console.log(`    ${r.name.padEnd(44)} ${String(r.kept + '/' + r.of).padStart(8)} ${f(r.recall)} ${f(r.precision)} `
                + `${g(r.matchedTruth)} ${g(r.confidentFP)} ${g(r.ambiguous)} ${g(r.missed)}`);
        }
        const nmDims = new Set(fr.candidates.flatMap((r) => r.notMeasuredDims));
        if (nmDims.size) console.log(`    NOT MEASURED dims: ${[...nmDims].join('; ')}`);
    }
    if (result.note) console.log(`\n${result.note}`);
    console.log(`\nframes: requested=${result.framesRequested ?? 0} usable=${result.framesUsable ?? 0} scored=${result.framesScored ?? 0}`);
    console.log(`RECOMMENDATION: ${result.recommendation ?? 'NONE'}`);
    if (result.recommendationNote) console.log(`  → ${result.recommendationNote}`);
    console.log('─'.repeat(75));
}

// Scaffold is non-failing: honest absence / recommender output is exit 0. A real
// gate is never wired here (LAW 7 / recommender-only).
process.exit(0);
