// ═══════════════════════════════════════════════════════════════════════════
// STACK LANE — v1 solve-first stacker/drizzler (headless, tools-lane only)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/stack/stack.mjs
//     [--dir "Sample Files/corpus/M51"]  input collection (FITS)
//     [--out test_results/stack]         output directory
//     [--ref <substring>]                force reference frame (default: finest
//                                        pixel scale, tie-break most matches)
//     [--scale <arcsec/px>]              output grid scale (default: reference)
//     [--drizzle <factor> --pixfrac <f>] Fruchter-Hook forward drizzle mode:
//                                        output scale = base scale / factor
//                                        ("turbo" kernel: axis-aligned square
//                                        footprint — the STScI fast path)
//     [--allow-correlated]               keep frames flagged as same-photon
//                                        products (breaks SNR independence)
//     [--untracked]                      grow cluster hint radius by 15 deg/h
//                                        of DATE-OBS delta (untracked series)
//     [--tile <rows>]                    accumulator row-band height (256)
//     [--verbose]
//
// PIPELINE (owner laws: coordinate/pixel ledger separation — no pixel is
// touched until the single resample; registration is pure coordinate math):
//   1. inventory: walk, classify artifact maps, hash-dedupe, flag correlated
//   2. prep: decode luminance, detect stars, linear centroids + moment-FWHM
//   3. solve: solvability-ordered, HINT PROPAGATION + solve-driven clustering
//      (cluster-center hints first, header/WCS hints second, bounded blind
//      last); N-point catalog WCS refinement on every lock
//   4. registration: reference choice, cross-frame WCS re-fit against the
//      reference frame's star sky-positions (kills catalog error terms),
//      output tangent grid covering all footprints
//   5. stack: per-channel — per-frame background subtraction, star-photometry
//      flux normalization to reference (intensity units: flux ratio x pixel-
//      area ratio), inverse-map bilinear resample, per-pixel sigma-clip
//      (k=3, >=3 contributors), inverse-variance weighted mean
//      drizzle: forward-map shrunken pixel footprints, weight accumulation
//   6. validation: background SNR vs expectation, stack FWHM vs best frame,
//      solve-the-stack, Siril side-by-side crop, rejection sanity crop
//   7. report.json + PNG renders + float32 FITS with output-grid WCS
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openFits, readPlaneRaw, readLuminanceNormalized, writeFitsPlanar, wcsCards } from './fits_io.mjs';
import {
    initWasm, loadAtlas, angSep, gnomonic, inverseGnomonic, pixToSky, skyToPix,
    scaleOf, extractStars, refineCentroids, medianFwhm, solveAtHint, refineWCS, blindHintGrid,
} from './solve_lib.mjs';
import { writePNG } from '../psf/imaging.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = path.resolve(ROOT, argVal('--dir', 'Sample Files/corpus/M51'));
const OUT = path.resolve(ROOT, argVal('--out', 'test_results/stack'));
const REF_PICK = argVal('--ref', null);
const SCALE_ARG = parseFloat(argVal('--scale', 'NaN'));
const DRIZZLE = parseFloat(argVal('--drizzle', 'NaN'));
const PIXFRAC = parseFloat(argVal('--pixfrac', '0.7'));
const ALLOW_CORR = args.includes('--allow-correlated');
const UNTRACKED = args.includes('--untracked');
const TILE_ROWS = parseInt(argVal('--tile', '256'), 10);
const VERBOSE = args.includes('--verbose');
const MODE = Number.isFinite(DRIZZLE) ? 'drizzle' : 'stack';
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const CLIP_K = 3;             // sigma-clip threshold
const CLIP_MIN_FRAMES = 3;    // rejection needs >= 3 contributors
const CLIP_SB_FLOOR = 0.05;   // fractional tolerance on bright signal: PSF /
                              // kernel mismatch between stacks makes star
                              // edges disagree by construction; without this
                              // floor the clipper eats every stellar limb
const BLIND_BUDGET_MS = 5 * 60 * 1000;
const M51_CORE = { raH: 202.4696 / 15, dec: 47.1953 };
const NODE_STEP = 32;         // mapping node lattice pitch (see buildNodes)
// DEEP-VERIFY GATE: a quad lock is only accepted once N-point catalog
// refinement corroborates it — a TRUE solution refines to dozens of catalog
// matches at sub-px rms, a coincidence lock cannot even find 8 anchors
// (observed: Top65% blind "lock" at 0.273"/px, dec -78, refine n=0).
const REFINE_MIN_N = 12, REFINE_MAX_RMS_PX = 2.5;

const phases = {};
let tPhase = Date.now();
function phase(name) {
    const now = Date.now();
    if (phase.current) phases[phase.current] = (phases[phase.current] || 0) + (now - tPhase);
    phase.current = name; tPhase = now;
    if (name) console.log(`\n━━ ${name} ${'━'.repeat(Math.max(1, 60 - name.length))}`);
}

const w = await initWasm(ROOT);
const atlas = loadAtlas(ROOT);

// ═══ 1. INVENTORY ═══════════════════════════════════════════════════════════
phase('inventory');
const excluded = [];   // { file, reason }
const frames = [];     // frame records
{
    const found = [];
    (function walk(d) {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.fits?$/i.test(e.name)) found.push(p);
        }
    })(DIR);
    const seenHash = new Map();
    for (const file of found) {
        const rel = path.relative(DIR, file);
        if (/_rejmap\.\w+$/i.test(file) || /_rej(ection)?_?map/i.test(file)) {
            excluded.push({ file: rel, reason: 'ARTIFACT_MAP: Siril per-pixel rejection statistics sidecar, not sky data' });
            continue;
        }
        const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
        if (seenHash.has(hash)) {
            excluded.push({ file: rel, reason: `EXACT_DUPLICATE of ${seenHash.get(hash)} (sha1 ${hash.slice(0, 10)})` });
            continue;
        }
        seenHash.set(hash, rel);
        frames.push({ file, rel, hash });
    }
    console.log(`${found.length} FITS found, ${frames.length} candidates, ${excluded.length} excluded so far`);
}

// ═══ 2. PREP: decode + detect + measure ═════════════════════════════════════
phase('prep');
for (const f of frames) {
    const t0 = Date.now();
    try {
        f.fits = openFits(f.file);
        const { cards, W, H, NP } = f.fits;
        f.cards = cards; f.W = W; f.H = H; f.NP = NP;
        f.telescop = cards.TELESCOP ?? cards.INSTRUME ?? '?';
        f.dateObs = cards['DATE-OBS'] ?? null;
        f.stackCnt = +(cards.STACKCNT ?? 0);
        // header pointing hint (RA/DEC cards are DEGREES; 0/0 means "none")
        const ra = +cards.RA, dec = +cards.DEC;
        f.hintHeader = (Number.isFinite(ra) && Number.isFinite(dec) && !(ra === 0 && dec === 0))
            ? { raH: ra / 15, dec } : null;
        // fallback: embedded WCS CRVAL (e.g. mosaic tools write WCS, no RA/DEC)
        const cv1 = +cards.CRVAL1, cv2 = +cards.CRVAL2;
        f.hintWCS = (Number.isFinite(cv1) && Number.isFinite(cv2) && !(cv1 === 0 && cv2 === 0))
            ? { raH: cv1 / 15, dec: cv2 } : null;
        // header scale: FOCALLEN/XPIXSZ first, |CDELT| second
        const focal = +cards.FOCALLEN, pixsz = +cards.XPIXSZ;
        let hs = (focal > 0 && pixsz > 0) ? 206.265 * pixsz / focal : NaN;
        if (!Number.isFinite(hs) && Number.isFinite(+cards.CDELT2)) hs = Math.abs(+cards.CDELT2) * 3600;
        f.headerScale = hs;

        const { lum } = readLuminanceNormalized(f.fits);
        const det = extractStars(w, lum, W, H);
        refineCentroids(lum, W, H, det.slice(0, 1200));
        f.det = det.slice(0, 1200).filter(s => Number.isFinite(s.cx));
        f.nStars = det.length;
        f.fwhmPx = medianFwhm(f.det);
        f.prepMs = Date.now() - t0;
        console.log(`  ${f.rel.slice(0, 58).padEnd(60)} ${String(W + 'x' + H + 'x' + NP).padEnd(12)} stars=${String(f.nStars).padEnd(5)} fwhm=${f.fwhmPx?.toFixed(2)}px hdrScale=${Number.isFinite(hs) ? hs.toFixed(3) : '-'} ${f.prepMs}ms`);
    } catch (e) {
        excluded.push({ file: f.rel, reason: `DECODE_FAILED: ${e.message}` });
        f.dead = true;
    }
}
for (let i = frames.length - 1; i >= 0; i--) if (frames[i].dead) frames.splice(i, 1);

// correlated-data detection: distinct files carrying the identical
// (TELESCOP, STACKCNT>0, DATE-OBS) triple are the same lights re-resampled
// (observed: Siril square-kernel vs lanczos-kernel exports of one 27728-light
// run); DATE-OBS within 60 s of another frame is a SUSPECTED same-session
// product (a live-stack export vs a restack of the same night's subs).
// Correlated frames still get SOLVED (per-frame table + visual comparisons)
// but are kept out of the stack: duplicated photons void every sqrt(N)
// independence claim this tool is supposed to validate honestly.
{
    const parseT = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
    const keyOf = f => `${f.telescop}|${f.stackCnt}|${f.dateObs}`;
    const groups = new Map();
    for (const f of frames) {
        const k = f.stackCnt > 0 && f.dateObs ? keyOf(f) : `solo|${f.rel}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f);
    }
    for (const [k, g] of groups) {
        if (g.length < 2) continue;
        g.sort((a, b) => b.nStars - a.nStars);
        for (const f of g.slice(1)) {
            f.noStack = `CORRELATED_DATA: identical TELESCOP/STACKCNT/DATE-OBS as ${g[0].rel} — same lights, different resample kernel`;
        }
    }
    const active = frames.filter(f => !f.noStack).sort((a, b) => (parseT(a.dateObs) ?? 0) - (parseT(b.dateObs) ?? 0));
    for (let i = 1; i < active.length; i++) {
        const a = active[i - 1], b = active[i];
        const ta = parseT(a.dateObs), tb = parseT(b.dateObs);
        if (ta === null || tb === null) continue;
        if (Math.abs(tb - ta) <= 60_000) {
            const drop = a.nStars >= b.nStars ? b : a;
            const keep = drop === a ? b : a;
            drop.noStack = `SUSPECTED_CORRELATED: DATE-OBS within ${Math.round(Math.abs(tb - ta) / 1000)}s of ${keep.rel} — same session start, almost certainly the same lights`;
        }
    }
    if (ALLOW_CORR) for (const f of frames) { if (f.noStack) { f.corrNote = f.noStack; delete f.noStack; } }
    for (const f of frames) if (f.noStack) console.log(`  [correlated, solve-only] ${f.rel}: ${f.noStack.split(':')[0]}`);
}

// ═══ 3. SOLVE: hint propagation + solve-driven clustering ═══════════════════
phase('solve');
// order by solvability (star count); ties don't matter
const solveOrder = [...frames].sort((a, b) => b.nStars - a.nStars);
const clusters = []; // { members:[frame], centroid:{raH,dec}, joinR }
const joinRadiusOf = f => {
    // NB: Number.isFinite chain, not ?? — headerScale is NaN (not null) when
    // absent, and a NaN radius silently disabled the cluster pointing gate
    // (observed: Top65% degraded to the doubled headerless bar and "solved"
    // blind at dec -78 before the deep-verify gate existed)
    const s = Number.isFinite(f.solve?.scale) ? f.solve.scale
        : (Number.isFinite(f.headerScale) ? f.headerScale : 2.4);
    return Math.hypot(f.W, f.H) / 2 * s / 3600 * 1.25 + 0.15;
};

function clusterCentroid(c) {
    let x = 0, y = 0, z = 0;
    for (const m of c.members) {
        const a = m.solve.wcs.crval[0] * 15 * Math.PI / 180, d = m.solve.wcs.crval[1] * Math.PI / 180;
        x += Math.cos(d) * Math.cos(a); y += Math.cos(d) * Math.sin(a); z += Math.sin(d);
    }
    const r = Math.hypot(x, y, z);
    return { raH: ((Math.atan2(y, x) * 180 / Math.PI / 15) % 24 + 24) % 24, dec: Math.asin(z / r) * 180 / Math.PI };
}

let solveWall = 0;
for (const f of solveOrder) {
    const t0 = Date.now();
    f.attempts = [];
    const halfDiagDeg = ws => Math.hypot(f.W, f.H) / 2 * ws / 3600;
    const wsCandidates = Number.isFinite(f.headerScale)
        ? [f.headerScale]
        : [...new Set(clusters.flatMap(c => c.members.map(m => +m.solve.scale.toFixed(2))))].concat([2.4, 3.74, 1.2]).slice(0, 5);

    const tryHint = (mode, raH, dec, gateRadius) => {
        for (const ws of wsCandidates) {
            const tA = Date.now();
            const gate = gateRadius ? { raH, dec, radiusDeg: gateRadius } : null;
            const r = solveAtHint(w, atlas, f.det, f.W, f.H, raH, dec, ws, f.headerScale, gate);
            let refined = null, status = r.status;
            if (r.status === 'LOCK') {
                // deep-verify: catalog refinement must corroborate the quad lock
                const regionR = Math.max(1.5, Math.hypot(f.W, f.H) / 2 * r.scale / 3600 * 1.3);
                const anchorsCat = atlas.regionStars(r.wcs.crval[0], r.wcs.crval[1], regionR);
                refined = refineWCS(w, f.det, anchorsCat, r.wcs, [10, 5, 3]);
                if (!refined || refined.n < REFINE_MIN_N || refined.rmsPx > REFINE_MAX_RMS_PX) {
                    status = `REFINE_REJECTED(n=${refined?.n ?? 0},rms=${refined?.rmsPx ?? '-'})`;
                    refined = null;
                }
            }
            f.attempts.push({ mode, ws: +ws.toFixed(3), status, ms: Date.now() - tA });
            vlog(`    [attempt] ${mode} @(${raH.toFixed(3)}h,${dec.toFixed(2)}) ws=${ws.toFixed(2)} -> ${status}`);
            if (refined) return { ...r, refined };
        }
        return null;
    };

    let lock = null, mode = null;
    // (a) cluster hints FIRST (directive) — pre-sorted by same-rig / adjacent-
    //     timestamp prior, then size (ordering optimization only)
    const parseT = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
    const tF = parseT(f.dateObs);
    const rankedClusters = [...clusters].sort((a, b) => {
        const prio = c => {
            const sameRig = c.members.some(m => m.telescop === f.telescop && f.telescop !== '?') ? 2 : 0;
            const nearT = tF !== null && c.members.some(m => { const t = parseT(m.dateObs); return t !== null && Math.abs(t - tF) < 12 * 3600e3; }) ? 1 : 0;
            return sameRig + nearT;
        };
        return (prio(b) - prio(a)) || (b.members.length - a.members.length);
    });
    for (const c of rankedClusters) {
        let radius = Math.max(joinRadiusOf(f), c.joinR);
        if (UNTRACKED && tF !== null) {
            const dts = c.members.map(m => parseT(m.dateObs)).filter(t => t !== null).map(t => Math.abs(tF - t) / 3600e3);
            if (dts.length) radius = Math.min(90, radius + 15 * Math.min(...dts));
        }
        lock = tryHint('cluster', c.centroid.raH, c.centroid.dec, radius);
        if (lock) { mode = 'cluster'; break; }
    }
    // (b) header pointing / embedded WCS
    if (!lock && f.hintHeader) { lock = tryHint('header', f.hintHeader.raH, f.hintHeader.dec, null); if (lock) mode = 'header'; }
    if (!lock && f.hintWCS) { lock = tryHint('header-wcs', f.hintWCS.raH, f.hintWCS.dec, null); if (lock) mode = 'header-wcs'; }
    // (c) bounded blind sweep (last resort)
    if (!lock) {
        const ws0 = Number.isFinite(f.headerScale) ? f.headerScale : 2.4;
        const hints = blindHintGrid(halfDiagDeg(ws0));
        const tB = Date.now();
        for (let hi = 0; hi < hints.length; hi++) {
            if (Date.now() - tB > BLIND_BUDGET_MS) { f.blindTruncated = `${hi}/${hints.length}`; break; }
            lock = tryHint('blind', hints[hi][0], hints[hi][1], null);
            if (lock) { mode = 'blind'; break; }
        }
    }
    f.solveMs = Date.now() - t0;
    solveWall += f.solveMs;
    if (!lock) {
        f.noStack = f.noStack ?? `SOLVE_FAILED: ${f.attempts[f.attempts.length - 1]?.status ?? 'no hints available'} after ${f.attempts.length} attempts`;
        f.unsolved = true;
        console.log(`  ✗ ${f.rel.slice(0, 52).padEnd(54)} UNSOLVED after ${f.attempts.length} attempts (${f.solveMs}ms)`);
        continue;
    }
    // catalog-refined WCS was produced inside the deep-verify gate
    const refined = lock.refined;
    f.solve = {
        mode, scale: scaleOf(refined.wcs.cd),
        wcs: refined.wcs,
        quadMatches: lock.matches, quadResid: lock.resid, consensus: lock.consensus,
        catN: refined.n, catRmsPx: refined.rmsPx, catRmsArcsec: refined.rmsArcsec,
        ms: f.solveMs, attempts: f.attempts.length,
    };
    // cluster join: solves are the truth
    let joined = null;
    for (const c of clusters) {
        const d = angSep(f.solve.wcs.crval[0], f.solve.wcs.crval[1], c.centroid.raH, c.centroid.dec);
        if (d < Math.max(joinRadiusOf(f), c.joinR)) { joined = c; break; }
    }
    if (joined) {
        joined.members.push(f);
        joined.centroid = clusterCentroid(joined);
        joined.joinR = Math.max(joined.joinR, joinRadiusOf(f));
    } else {
        clusters.push({ members: [f], centroid: { raH: f.solve.wcs.crval[0], dec: f.solve.wcs.crval[1] }, joinR: joinRadiusOf(f) });
        joined = clusters[clusters.length - 1];
    }
    f.cluster = clusters.indexOf(joined);
    console.log(`  ✓ ${f.rel.slice(0, 52).padEnd(54)} mode=${mode.padEnd(10)} scale=${f.solve.scale.toFixed(3)} quad=${lock.matches} cat=${f.solve.catN}@${f.solve.catRmsPx}px cluster=${f.cluster} ${f.solveMs}ms`);
}

// solve-perf accounting (directive): propagation wall vs N independent solves
const solvedFrames = frames.filter(f => f.solve);
const perfNote = (() => {
    const lockAttempts = solvedFrames.flatMap(f => f.attempts.filter(a => a.status === 'LOCK'));
    const headerLocks = solvedFrames.filter(f => f.solve.mode === 'header' || f.solve.mode === 'header-wcs');
    const avgHeaderMs = headerLocks.length ? headerLocks.reduce((s, f) => s + f.solveMs, 0) / headerLocks.length : (lockAttempts.reduce((s, a) => s + a.ms, 0) / Math.max(1, lockAttempts.length));
    const avgAttemptMs = (() => { const all = frames.flatMap(f => f.attempts ?? []); return all.length ? all.reduce((s, a) => s + a.ms, 0) / all.length : 1500; })();
    let independent = 0;
    for (const f of frames) {
        if (!f.attempts) continue;
        if (f.hintHeader || f.hintWCS) independent += avgHeaderMs;
        else independent += (blindHintGrid(Math.hypot(f.W, f.H) / 2 * 2.4 / 3600).length / 2) * avgAttemptMs;
    }
    return {
        propagationWallMs: solveWall,
        independentEstimateMs: Math.round(independent),
        estimateBasis: `header-hinted solve ~${Math.round(avgHeaderMs)}ms measured; blind = nHints/2 x ${Math.round(avgAttemptMs)}ms/attempt measured; frames without any header hint costed as blind`,
        clusterHintSuccessRate: (() => {
            const tries = frames.flatMap(f => (f.attempts ?? []).filter(a => a.mode === 'cluster'));
            const ok = frames.filter(f => f.solve?.mode === 'cluster').length;
            return `${ok} frames solved via cluster hint / ${tries.length} cluster-hint attempts`;
        })(),
    };
})();
console.log(`\n  clusters: ${clusters.length} ${clusters.map((c, i) => `[#${i}: ${c.members.length} frames @ ${c.centroid.raH.toFixed(3)}h ${c.centroid.dec.toFixed(2)}]`).join(' ')}`);
console.log(`  solve wall ${solveWall}ms with propagation vs ~${perfNote.independentEstimateMs}ms independent (${perfNote.clusterHintSuccessRate})`);

// ═══ 4. REGISTRATION (per cluster) ══════════════════════════════════════════
phase('registration');
const stackable = c => c.members.filter(m => !m.noStack);
const workClusters = clusters.map((c, ci) => ({ ...c, index: ci })).filter(c => stackable(c).length >= 2);
for (const c of clusters) {
    const s = stackable(c);
    if (s.length === 1) console.log(`  cluster #${clusters.indexOf(c)} is a SINGLETON (${s[0].rel}) — reported solo, not stacked`);
    if (s.length === 0) console.log(`  cluster #${clusters.indexOf(c)} has no stackable members (all correlated/excluded)`);
}
if (!workClusters.length) { console.error('No cluster with >=2 stackable frames — nothing to stack.'); }

const results = [];
for (const cluster of workClusters) {
    const members = stackable(cluster);
    // reference: finest pixel scale (within 2%), tie-break most catalog matches
    let ref;
    if (REF_PICK) ref = members.find(m => m.rel.includes(REF_PICK));
    if (!ref) {
        // finest pixel scale; tie-break by DETECTION COUNT (catalog matches
        // saturate at the atlas depth, ~28 for this FOV — useless as a tie-
        // break; anchor-richness is what rel-registration and photometry eat)
        const finest = Math.min(...members.map(m => m.solve.scale));
        ref = members.filter(m => m.solve.scale <= finest * 1.02).sort((a, b) => b.nStars - a.nStars)[0];
    }
    console.log(`  cluster #${cluster.index}: ${members.length} frames, reference = ${ref.rel} (${ref.solve.scale.toFixed(3)}"/px)`);

    // registration anchors: reference detections -> sky through ref WCS.
    // Cross-frame refinement against these kills the shared-catalog error
    // term — relative registration is then limited only by centroid noise.
    const anchorStars = ref.det
        .filter(s => Number.isFinite(s.fwhmPx) && s.fwhmPx > 0.5)
        .slice(0, 800);
    const anchors = anchorStars.map(s => {
        const sky = pixToSky(ref.solve.wcs, s.cx, s.cy);
        return { raH: sky.raH, dec: sky.dec, refFlux: s.flux, refDet: s };
    });
    // every frame (ref included) gets final WCS + matched-anchor set
    for (const m of members.concat(frames.filter(f => f.solve && f.noStack && f.cluster === cluster.index))) {
        if (m === ref) {
            m.wcsFinal = ref.solve.wcs;
            m.rel_ = { n: anchors.length, rmsPx: 0, rmsArcsec: 0 };
            m.anchorIdx = anchors.map((_, i) => i);
            continue;
        }
        const r = refineWCS(w, m.det, anchors, m.solve.wcs, [8, 4, 2.5]);
        if (r && r.n >= 20) {
            m.wcsFinal = r.wcs;
            m.rel_ = { n: r.n, rmsPx: r.rmsPx, rmsArcsec: r.rmsArcsec };
            m.anchorIdx = r.pairs.map(p => p.ai);
        } else {
            m.wcsFinal = m.solve.wcs; // catalog WCS only — flagged
            m.rel_ = { n: r?.n ?? 0, rmsPx: null, rmsArcsec: null, weak: true };
            m.anchorIdx = [];
        }
        vlog(`    rel-reg ${m.rel.slice(0, 44)}: n=${m.rel_.n} rms=${m.rel_.rmsPx}px (${m.rel_.rmsArcsec}")`);
    }

    // output grid: tangent plane at the cluster centroid
    const baseScale = Number.isFinite(SCALE_ARG) ? SCALE_ARG : ref.solve.scale;
    const outScale = MODE === 'drizzle' ? baseScale / DRIZZLE : baseScale;
    const sdeg = outScale / 3600;
    const crval = [cluster.centroid.raH, cluster.centroid.dec];
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const m of members) {
        const pts = [];
        const step = 8;
        for (let i = 0; i <= step; i++) {
            pts.push([m.W - 1, (m.H - 1) * i / step], [0, (m.H - 1) * i / step], [(m.W - 1) * i / step, 0], [(m.W - 1) * i / step, m.H - 1]);
        }
        for (const [px, py] of pts) {
            const sky = pixToSky(m.wcsFinal, px, py);
            const g = gnomonic(sky.raH, sky.dec, crval[0], crval[1]);
            const xr = -g.xi / sdeg, yr = g.eta / sdeg;
            if (xr < xMin) xMin = xr; if (xr > xMax) xMax = xr;
            if (yr < yMin) yMin = yr; if (yr > yMax) yMax = yr;
        }
    }
    const PAD = 4;
    const gridW = Math.ceil(xMax - xMin) + 2 * PAD + 1;
    const gridH = Math.ceil(yMax - yMin) + 2 * PAD + 1;
    const grid = {
        crval, sdeg, W: gridW, H: gridH,
        crpix: [PAD - xMin, PAD - yMin],
        cd: [-sdeg, 0, 0, sdeg],
    };
    const outMP = gridW * gridH / 1e6;
    console.log(`  output grid: ${gridW}x${gridH} (${outMP.toFixed(1)} MP) @ ${outScale.toFixed(3)}"/px, tangent ${crval[0].toFixed(4)}h ${crval[1].toFixed(3)}`);
    if (gridW * gridH > 220e6) throw new Error(`output grid ${outMP.toFixed(0)} MP exceeds the 220 MP guard — pass a coarser --scale`);

    // per-frame output-space bbox (footprint prefilter for tiles)
    for (const m of members) {
        let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
        const step = 8;
        for (let i = 0; i <= step; i++) {
            for (const [px, py] of [[m.W - 1, (m.H - 1) * i / step], [0, (m.H - 1) * i / step], [(m.W - 1) * i / step, 0], [(m.W - 1) * i / step, m.H - 1]]) {
                const sky = pixToSky(m.wcsFinal, px, py);
                const g = gnomonic(sky.raH, sky.dec, crval[0], crval[1]);
                const x = grid.crpix[0] - g.xi / sdeg, y = grid.crpix[1] + g.eta / sdeg;
                if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
                if (y < by0) by0 = y; if (y > by1) by1 = y;
            }
        }
        m.outBbox = [Math.max(0, Math.floor(bx0) - 2), Math.max(0, Math.floor(by0) - 2), Math.min(gridW - 1, Math.ceil(bx1) + 2), Math.min(gridH - 1, Math.ceil(by1) + 2)];
    }

    results.push(await processCluster(cluster, members, ref, anchors, grid, outScale));
}

// ═══ shared mapping / resampling machinery ══════════════════════════════════

function outPixToSky(grid, x, y) {
    const xi = -(x - grid.crpix[0]) * grid.sdeg, eta = (y - grid.crpix[1]) * grid.sdeg;
    return inverseGnomonic(xi, eta, grid.crval[0], grid.crval[1]);
}
function skyToOut(grid, raH, dec) {
    const g = gnomonic(raH, dec, grid.crval[0], grid.crval[1]);
    return { x: grid.crpix[0] - g.xi / grid.sdeg, y: grid.crpix[1] + g.eta / grid.sdeg };
}

/**
 * Node lattice for the composite mapping output-window -> frame pixels.
 * The tangent-to-tangent composite is glass-smooth over degree fields; exact
 * trig on a 32 px lattice + bilinear interpolation is sub-0.01 px everywhere
 * while cutting the trig count three orders of magnitude.
 */
function buildNodes(mapFn, x0, y0, wpx, hpx) {
    const nx = Math.floor(wpx / NODE_STEP) + 2, ny = Math.floor(hpx / NODE_STEP) + 2;
    const fx = new Float64Array(nx * ny), fy = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const p = mapFn(x0 + i * NODE_STEP, y0 + j * NODE_STEP);
            fx[j * nx + i] = p.x; fy[j * nx + i] = p.y;
        }
    }
    return { nx, ny, fx, fy, x0, y0 };
}
function nodeInterp(nodes, x, y, out) {
    const u = (x - nodes.x0) / NODE_STEP, v = (y - nodes.y0) / NODE_STEP;
    const i = Math.min(nodes.nx - 2, Math.max(0, Math.floor(u))), j = Math.min(nodes.ny - 2, Math.max(0, Math.floor(v)));
    const du = u - i, dv = v - j;
    const o = j * nodes.nx + i;
    const w00 = (1 - du) * (1 - dv), w10 = du * (1 - dv), w01 = (1 - du) * dv, w11 = du * dv;
    out.x = nodes.fx[o] * w00 + nodes.fx[o + 1] * w10 + nodes.fx[o + nodes.nx] * w01 + nodes.fx[o + nodes.nx + 1] * w11;
    out.y = nodes.fy[o] * w00 + nodes.fy[o + 1] * w10 + nodes.fy[o + nodes.nx] * w01 + nodes.fy[o + nodes.nx + 1] * w11;
}

/**
 * Inverse-map resample of one frame into an output window (bilinear).
 * outBuf gets NORMALIZED values ratio*(raw-bg); invalid -> NaN.
 */
function resampleWindow(plane, m, grid, x0, y0, wpx, hpx, bg, ratio, outBuf) {
    outBuf.fill(NaN, 0, wpx * hpx);
    const [bx0, by0, bx1, by1] = m.outBbox;
    const yA = Math.max(y0, by0), yB = Math.min(y0 + hpx - 1, by1);
    const xA = Math.max(x0, bx0), xB = Math.min(x0 + wpx - 1, bx1);
    if (yA > yB || xA > xB) return;
    const nodes = buildNodes((ox, oy) => {
        const sky = outPixToSky(grid, ox, oy);
        return skyToPix(m.wcsFinal, sky.raH, sky.dec);
    }, xA, yA, xB - xA + 1, yB - yA + 1);
    const fw = m.W, fh = m.H;
    const p = { x: 0, y: 0 };
    for (let y = yA; y <= yB; y++) {
        const rowOff = (y - y0) * wpx - x0;
        for (let x = xA; x <= xB; x++) {
            nodeInterp(nodes, x, y, p);
            const fx = p.x, fy = p.y;
            if (!(fx >= 0 && fx <= fw - 1.001 && fy >= 0 && fy <= fh - 1.001)) continue;
            const ix = Math.floor(fx), iy = Math.floor(fy);
            const dx = fx - ix, dy = fy - iy;
            const i0 = iy * fw + ix;
            const v = plane[i0] * (1 - dx) * (1 - dy) + plane[i0 + 1] * dx * (1 - dy)
                + plane[i0 + fw] * (1 - dx) * dy + plane[i0 + fw + 1] * dx * dy;
            if (Number.isFinite(v)) outBuf[rowOff + x] = ratio * (v - bg);
        }
    }
}

/** robust {med, sigma(MAD)} over finite samples; max is EXACT (full scan —
 *  it gates saturation-star skipping in photometry, a sampled max would
 *  land on the noise tail and veto every usable star) */
function planeStats(plane, stride = 499) {
    const s = [];
    for (let i = 0; i < plane.length; i += stride) { const v = plane[i]; if (Number.isFinite(v)) s.push(v); }
    s.sort((a, b) => a - b);
    const med = s[s.length >> 1] ?? NaN;
    const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    let max = -Infinity;
    for (let i = 0; i < plane.length; i++) { const v = plane[i]; if (v > max) max = v; }
    return { med, sigma: 1.4826 * (dev[dev.length >> 1] ?? NaN), max };
}

/** aperture photometry at (x,y): sum(v - annulusMedian) inside rAp. */
function apPhot(plane, W, H, x, y, rAp, satLevel) {
    const rIn = rAp * 1.8, rOut = rAp * 2.8;
    const R = Math.ceil(rOut);
    const cx = Math.round(x), cy = Math.round(y);
    if (cx - R < 0 || cy - R < 0 || cx + R >= W || cy + R >= H) return null;
    const ann = [];
    let flux = 0, peak = -Infinity, nAp = 0;
    for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            const r = Math.hypot(dx + cx - x, dy + cy - y);
            const v = plane[(cy + dy) * W + cx + dx];
            if (r <= rAp) {
                if (!Number.isFinite(v)) return null;
                flux += v; nAp++;
                if (v > peak) peak = v;
            } else if (r >= rIn && r <= rOut && Number.isFinite(v)) ann.push(v);
        }
    }
    if (ann.length < 8) return null;
    ann.sort((a, b) => a - b);
    const bg = ann[ann.length >> 1];
    if (Number.isFinite(satLevel) && peak >= satLevel) return null;
    return { flux: flux - bg * nAp, peak };
}

// ═══ 5+6. per-cluster stacking + validation ═════════════════════════════════

async function processCluster(cluster, members, ref, anchors, grid, outScale) {
    const nF = members.length;
    const gridW = grid.W, gridH = grid.H, gridN = gridW * gridH;
    const chanNames = ['R', 'G', 'B'];
    const outPlanes = [null, null, null];
    const coverage = new Uint8Array(gridN);
    const rejMap = new Uint8Array(gridN);
    const photTable = members.map(() => ({}));
    const rejStats = members.map(() => ({ contrib: 0, rejected: 0 }));
    const refIdx = members.indexOf(ref);
    let greenPlanes = null; // retained for post-pass SNR / rejection analysis
    let drizzleWeightMap = null; // green-channel Fruchter-Hook weight map

    // photometry anchor subset: bright but not the very brightest (saturation),
    // circular, matched in the frame being measured
    const photAnchorOrder = anchors
        .map((a, i) => ({ i, flux: a.refFlux }))
        .sort((a, b) => b.flux - a.flux)
        .slice(3, 120)
        .map(o => o.i);

    phase(`resample+combine cluster#${cluster.index} [${MODE}]`);
    const chanOrder = [0, 2, 1]; // green LAST — its planes stay loaded for the post-pass analyses
    for (const c of chanOrder) {
        const tC = Date.now();
        // load raw planes (original units)
        const planes = members.map(m => readPlaneRaw(m.fits, Math.min(c, m.NP - 1)));
        // per-frame stats + photometric normalization to reference
        const stats = planes.map(p => planeStats(p));
        const refStats = stats[refIdx];
        const ratios = new Float64Array(nF).fill(NaN);
        const scatters = new Float64Array(nF).fill(NaN);
        for (let fi = 0; fi < nF; fi++) {
            const m = members[fi];
            if (fi === refIdx) { ratios[fi] = 1; scatters[fi] = 0; continue; }
            const matched = new Set(m.anchorIdx);
            const perStar = [];
            for (const ai of photAnchorOrder) {
                if (!matched.has(ai)) continue;
                const aFr = skyToPix(m.wcsFinal, anchors[ai].raH, anchors[ai].dec);
                const aRe = skyToPix(ref.wcsFinal, anchors[ai].raH, anchors[ai].dec);
                const rApF = Math.max(3, 1.6 * (m.fwhmPx || 3));
                const rApR = Math.max(3, 1.6 * (ref.fwhmPx || 3));
                const pf = apPhot(planes[fi], m.W, m.H, aFr.x, aFr.y, rApF, 0.95 * stats[fi].max);
                const pr = apPhot(planes[refIdx], ref.W, ref.H, aRe.x, aRe.y, rApR, 0.95 * refStats.max);
                if (!pf || !pr || pf.flux <= 0 || pr.flux <= 0) continue;
                // intensity normalization: flux ratio x pixel-area ratio
                perStar.push((pr.flux / pf.flux) * (ref.solve.scale ** 2 / m.solve.scale ** 2));
                if (perStar.length >= 60) break;
            }
            if (perStar.length >= 8) {
                perStar.sort((a, b) => a - b);
                ratios[fi] = perStar[perStar.length >> 1];
                const lg = perStar.map(v => Math.abs(Math.log10(v / ratios[fi]))).sort((a, b) => a - b);
                scatters[fi] = +(1.4826 * lg[lg.length >> 1]).toFixed(4);
            } else {
                ratios[fi] = NaN; // frame drops out of this channel — reported
            }
            vlog(`    [${chanNames[c]}] ${m.rel.slice(0, 40)}: bg=${stats[fi].med.toExponential(3)} sig=${stats[fi].sigma.toExponential(3)} ratio=${ratios[fi]?.toFixed(4)} (n=${perStar.length}, scatter=${scatters[fi]}dex)`);
        }
        const sigmasN = members.map((_, fi) => ratios[fi] * stats[fi].sigma);          // normalized units
        const weights = sigmasN.map(s => Number.isFinite(s) && s > 0 ? 1 / (s * s) : 0);
        for (let fi = 0; fi < nF; fi++) {
            photTable[fi][chanNames[c]] = {
                bg: stats[fi].med, sigmaRaw: stats[fi].sigma, ratio: Number.isFinite(ratios[fi]) ? +ratios[fi].toPrecision(6) : null,
                ratioScatterDex: Number.isFinite(scatters[fi]) ? scatters[fi] : null,
                sigmaNorm: Number.isFinite(sigmasN[fi]) ? +sigmasN[fi].toPrecision(5) : null,
                weight: +weights[fi].toPrecision(5),
            };
        }

        const out = new Float32Array(gridN);
        if (MODE === 'stack') {
            stackChannel(out, planes, members, grid, ratios, stats, sigmasN, weights,
                c === 1 ? coverage : null, rejMap, rejStats);
        } else {
            const wm = drizzleChannel(out, planes, members, grid, ratios, stats, weights, outScale,
                c === 1 ? coverage : null);
            if (wm) drizzleWeightMap = wm;
        }
        outPlanes[c] = out;
        if (c === 1) greenPlanes = { planes, stats, ratios, sigmasN, weights };
        console.log(`  channel ${chanNames[c]}: ${Date.now() - tC}ms`);
    }

    // ── validation on the green channel (planes still loaded) ───────────────
    phase(`validation cluster#${cluster.index}`);
    let maxCov = 0;
    for (let i = 0; i < coverage.length; i++) if (coverage[i] > maxCov) maxCov = coverage[i];
    const validation = { mode: MODE, outScale: +outScale.toFixed(4), grid: { W: gridW, H: gridH, crvalHours: grid.crval[0], crvalDec: grid.crval[1] } };

    // (a) background SNR: pick a low-structure full-coverage test window,
    // measure per-frame RESAMPLED sigma there (apples-to-apples: bilinear
    // resampling correlates neighbours and shrinks per-pixel noise, so
    // native-grid sigmas would overstate the gain), then stack sigma.
    const WIN = 256;
    // full coverage = every stacked frame contributed (coverage is a
    // contributor-count map in BOTH modes; drizzle's weight map is separate)
    const covFloor = maxCov;
    let win = null;
    {
        let best = null;
        for (let y0 = 0; y0 + WIN < gridH; y0 += 128) {
            for (let x0 = 0; x0 + WIN < gridW; x0 += 128) {
                let covOk = 0, n = 0;
                for (let y = y0; y < y0 + WIN; y += 16) for (let x = x0; x < x0 + WIN; x += 16) { n++; if (coverage[y * gridW + x] >= covFloor) covOk++; }
                if (covOk < n) continue;
                const s = [];
                for (let y = y0; y < y0 + WIN; y += 4) for (let x = x0; x < x0 + WIN; x += 4) s.push(outPlanes[1][y * gridW + x]);
                s.sort((a, b) => a - b);
                const spread = s[Math.floor(s.length * 0.95)] - s[Math.floor(s.length * 0.5)];
                if (!best || spread < best.spread) best = { x0, y0, spread };
            }
        }
        win = best;
    }
    if (win && greenPlanes) {
        const buf = new Float32Array(WIN * WIN);
        const frameSigmaRes = [];
        for (let fi = 0; fi < members.length; fi++) {
            const m = members[fi];
            if (!Number.isFinite(greenPlanes.ratios[fi])) { frameSigmaRes.push(NaN); continue; }
            resampleWindow(greenPlanes.planes[fi], m, grid, win.x0, win.y0, WIN, WIN, greenPlanes.stats[fi].med, greenPlanes.ratios[fi], buf);
            const s = [];
            for (let i = 0; i < buf.length; i += 3) if (Number.isFinite(buf[i])) s.push(buf[i]);
            s.sort((a, b) => a - b);
            const med = s[s.length >> 1];
            const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
            frameSigmaRes.push(1.4826 * dev[dev.length >> 1]);
        }
        const sStack = [];
        for (let y = win.y0; y < win.y0 + WIN; y++) for (let x = win.x0; x < win.x0 + WIN; x++) sStack.push(outPlanes[1][y * gridW + x]);
        sStack.sort((a, b) => a - b);
        const medS = sStack[sStack.length >> 1];
        const devS = sStack.map(v => Math.abs(v - medS)).sort((a, b) => a - b);
        const sigmaStack = 1.4826 * devS[devS.length >> 1];
        const wRes = frameSigmaRes.map(s => Number.isFinite(s) && s > 0 ? 1 / (s * s) : 0);
        const sumW = wRes.reduce((a, b) => a + b, 0);
        const nEff = sumW * sumW / wRes.reduce((a, b) => a + b * b, 0);
        const sigmaRefRes = frameSigmaRes[refIdx];
        validation.snr = {
            testWindow: { x0: win.x0, y0: win.y0, size: WIN },
            frameSigmaResampled: frameSigmaRes.map(v => Number.isFinite(v) ? +v.toPrecision(4) : null),
            sigmaRefResampled: +sigmaRefRes.toPrecision(4),
            sigmaStackMeasured: +sigmaStack.toPrecision(4),
            gainMeasured: +(sigmaRefRes / sigmaStack).toFixed(3),
            gainExpected: +(sigmaRefRes * Math.sqrt(sumW)).toFixed(3),
            nEffective: +nEff.toFixed(2),
            sqrtNEffective: +Math.sqrt(nEff).toFixed(3),
            note: 'sigmas are MAD-robust on background-selected full-coverage window, per-frame values RESAMPLED onto the output grid (bilinear noise correlation affects stack and baseline equally); gainExpected assumes independent frames — see correlated-frames exclusions',
        };
        console.log(`  SNR: stack sigma ${sigmaStack.toExponential(3)} vs ref ${sigmaRefRes.toExponential(3)} -> gain ${validation.snr.gainMeasured}x (ideal ${validation.snr.gainExpected}x, sqrt(N_eff)=${validation.snr.sqrtNEffective})`);
    }

    // (b) FWHM: stack vs frames (arcsec — scales differ)
    {
        const lum = new Float32Array(gridN);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < gridN; i++) {
            const v = 0.2126 * outPlanes[0][i] + 0.7152 * outPlanes[1][i] + 0.0722 * outPlanes[2][i];
            lum[i] = v;
            if (v < lo) lo = v; if (v > hi) hi = v;
        }
        const inv = 1 / (hi - lo);
        for (let i = 0; i < gridN; i++) lum[i] = (lum[i] - lo) * inv;
        const det = extractStars(w, lum, gridW, gridH);
        refineCentroids(lum, gridW, gridH, det.slice(0, 400));
        const fwhmStackPx = medianFwhm(det.slice(0, 400).filter(s => Number.isFinite(s.cx)));
        validation.fwhm = {
            stackPx: +fwhmStackPx.toFixed(3), stackArcsec: +(fwhmStackPx * outScale).toFixed(3),
            frames: members.map(m => ({ file: m.rel, px: +m.fwhmPx.toFixed(3), arcsec: +(m.fwhmPx * m.solve.scale).toFixed(3) })),
            bestFrameArcsec: +Math.min(...members.map(m => m.fwhmPx * m.solve.scale).filter(Number.isFinite)).toFixed(3),
            refArcsec: +(ref.fwhmPx * ref.solve.scale).toFixed(3),
            note: 'moment-FWHM (2.3548*sqrt(second moment)), same measure everywhere; mixed-resolution stacking blends coarse-frame PSFs by weight — v2 wants PSF-aware weighting',
        };
        console.log(`  FWHM: stack ${validation.fwhm.stackArcsec}" vs best frame ${validation.fwhm.bestFrameArcsec}" (ref ${validation.fwhm.refArcsec}")`);

        // (c) solve the stack with the same machinery
        const nDetStack = det.length;
        const lock = solveAtHint(w, atlas, det, gridW, gridH, grid.crval[0], grid.crval[1], outScale, outScale, null);
        if (lock.status === 'LOCK') {
            const anchorsCat = atlas.regionStars(grid.crval[0], grid.crval[1], Math.max(1.5, Math.hypot(gridW, gridH) / 2 * outScale / 3600 * 1.3));
            refineCentroids(lum, gridW, gridH, det.slice(0, 1200).filter(s => !Number.isFinite(s.cx)));
            const detR = det.slice(0, 1200).filter(s => Number.isFinite(s.cx));
            const refined = refineWCS(w, detR, anchorsCat, lock.wcs, [10, 5, 3]);
            // WCS self-consistency: sky position of the SAME pixel (grid
            // center) under the solved WCS vs the constructed grid WCS —
            // comparing raw crvals would compare different reference pixels
            const cx = gridW / 2, cy = gridH / 2;
            const skySolved = pixToSky(refined ? refined.wcs : lock.wcs, cx, cy);
            const skyGrid = outPixToSky(grid, cx, cy);
            const offArcsec = angSep(skySolved.raH, skySolved.dec, skyGrid.raH, skyGrid.dec) * 3600;
            validation.solveStack = {
                status: 'LOCK', stars: nDetStack, quadMatches: lock.matches,
                scale: +(refined ? scaleOf(refined.wcs.cd) : lock.scale).toFixed(4),
                catN: refined?.n ?? null, catRmsPx: refined?.rmsPx ?? null,
                crvalOffsetArcsecVsGrid: +offArcsec.toFixed(2),
                bestInputCatN: Math.max(...members.map(m => m.solve.catN ?? 0)),
                bestInputQuadMatches: Math.max(...members.map(m => m.solve.quadMatches)),
            };
            console.log(`  solve-the-stack: LOCK stars=${nDetStack} quad=${lock.matches} cat=${refined?.n}@${refined?.rmsPx}px scale=${validation.solveStack.scale} offset=${offArcsec.toFixed(1)}" (best input cat=${validation.solveStack.bestInputCatN})`);
        } else {
            validation.solveStack = { status: lock.status, stars: nDetStack };
            console.log(`  solve-the-stack: ${lock.status}`);
        }
        var stackLum = lum; // for renders below
    }

    // ── rejection sanity + Siril side-by-side (stack mode) ──────────────────
    const outputs = {};
    const outName = (s) => path.join(OUT, `${MODE}_cluster${cluster.index}_${s}`);
    if (MODE === 'stack' && greenPlanes) {
        let totalRej = 0; for (let i = 0; i < gridN; i++) totalRej += rejMap[i];
        const totalContrib = rejStats.reduce((s, r) => s + r.contrib, 0);
        validation.rejection = {
            totalRejectedSamples: totalRej,
            totalContributingSamples: totalContrib,
            rejectedFraction: +(totalRej / Math.max(1, totalContrib)).toExponential(3),
            perFrame: members.map((m, fi) => ({ file: m.rel, contrib: rejStats[fi].contrib, rejected: rejStats[fi].rejected, frac: +(rejStats[fi].rejected / Math.max(1, rejStats[fi].contrib)).toExponential(2) })),
        };
        if (totalRej > 200) {
            // densest rejection window -> before/after crop (green, same stretch)
            const CW = 200;
            let best = { s: -1, x0: 0, y0: 0 };
            for (let y0 = 0; y0 + CW < gridH; y0 += 100) {
                for (let x0 = 0; x0 + CW < gridW; x0 += 100) {
                    let s = 0;
                    for (let y = y0; y < y0 + CW; y += 2) for (let x = x0; x < x0 + CW; x += 2) s += rejMap[y * gridW + x];
                    if (s > best.s) best = { s, x0, y0 };
                }
            }
            const bufs = members.map(() => new Float32Array(CW * CW));
            members.forEach((m, fi) => {
                if (Number.isFinite(greenPlanes.ratios[fi]))
                    resampleWindow(greenPlanes.planes[fi], m, grid, best.x0, best.y0, CW, CW, greenPlanes.stats[fi].med, greenPlanes.ratios[fi], bufs[fi]);
                else bufs[fi].fill(NaN);
            });
            const naive = new Float32Array(CW * CW);
            for (let i = 0; i < CW * CW; i++) {
                let sw = 0, sv = 0;
                for (let fi = 0; fi < members.length; fi++) {
                    const v = bufs[fi][i];
                    if (Number.isFinite(v)) { sv += greenPlanes.weights[fi] * v; sw += greenPlanes.weights[fi]; }
                }
                naive[i] = sw > 0 ? sv / sw : 0;
            }
            const clipped = new Float32Array(CW * CW);
            for (let y = 0; y < CW; y++) for (let x = 0; x < CW; x++) clipped[y * CW + x] = outPlanes[1][(best.y0 + y) * gridW + best.x0 + x];
            writeGrayPair(outName('reject_before_after.png'), naive, clipped, CW, CW);
            validation.rejection.crop = { x0: best.x0, y0: best.y0, size: CW, rejSamplesInCrop: best.s, png: path.relative(ROOT, outName('reject_before_after.png')) };
            console.log(`  rejection sanity: ${totalRej} samples rejected (${validation.rejection.rejectedFraction} of contributions); crop at (${best.x0},${best.y0})`);
        } else {
            validation.rejection.note = 'nothing (or almost nothing) needed rejection — these inputs are already sigma-clipped stacks; stated honestly rather than manufacturing a demo';
            console.log(`  rejection sanity: only ${totalRej} samples rejected — honest: pre-cleaned stacks barely need it`);
        }

        // Siril side-by-side: prefer a solved-but-excluded correlated Siril
        // product (independent of our stack), else the Siril frame we stacked
        const siril = frames.find(f => f.solve && f.noStack && /r_cc|siril|drizzle/i.test(f.rel) && f.cluster === cluster.index)
            ?? members.find(m => /r_cc/i.test(m.rel));
        if (siril) {
            const CS = 512;
            const center = skyToOut(grid, M51_CORE.raH, M51_CORE.dec);
            const x0 = Math.round(center.x - CS / 2), y0 = Math.round(center.y - CS / 2);
            const ours = [0, 1, 2].map(c => {
                const cr = new Float32Array(CS * CS);
                for (let y = 0; y < CS; y++) for (let x = 0; x < CS; x++) {
                    const gx = x0 + x, gy = y0 + y;
                    cr[y * CS + x] = (gx >= 0 && gy >= 0 && gx < gridW && gy < gridH) ? outPlanes[c][gy * gridW + gx] : 0;
                }
                return cr;
            });
            const sirilWcs = siril.wcsFinal ?? siril.solve.wcs;
            if (!siril.outBbox) siril.outBbox = [0, 0, grid.W - 1, grid.H - 1];
            const theirs = [0, 1, 2].map(c => {
                const plane = readPlaneRaw(siril.fits, Math.min(c, siril.NP - 1));
                const st = planeStats(plane);
                const cr = new Float32Array(CS * CS);
                const buf = new Float32Array(CS * CS);
                const mm = { ...siril, wcsFinal: sirilWcs };
                resampleWindow(plane, mm, grid, x0, y0, CS, CS, st.med, 1, buf);
                for (let i = 0; i < CS * CS; i++) cr[i] = Number.isFinite(buf[i]) ? buf[i] : 0;
                return cr;
            });
            writeRGBPair(outName('siril_side_by_side.png'), ours, theirs, CS);
            validation.sirilCompare = {
                comparedTo: siril.rel, centeredOn: 'M51 core (13h29m52.7s +47d11m43s)',
                png: path.relative(ROOT, outName('siril_side_by_side.png')),
                note: 'left: this stack; right: Siril product resampled to the same grid; independent percentile stretch per panel (same percentiles/gamma) since photometric units differ',
            };
            console.log(`  side-by-side vs ${siril.rel}`);
        }
    }

    // ── outputs ──────────────────────────────────────────────────────────────
    phase(`outputs cluster#${cluster.index}`);
    const gridWcs = { crval: grid.crval, crpix: grid.crpix, cd: grid.cd };
    const fitsPath = outName('rgb.fits');
    writeFitsPlanar(fitsPath, outPlanes, gridW, gridH, [
        ...wcsCards(gridWcs),
        ['CREATOR', 'skycruncher tools/stack v1'],
        ['NCOMBINE', members.length, 'frames stacked'],
        ['STAKMODE', MODE],
        ['REFFRAME', path.basename(ref.rel).slice(0, 60)],
    ]);
    outputs.fits = path.relative(ROOT, fitsPath);
    console.log(`  FITS -> ${outputs.fits} (${(fs.statSync(fitsPath).size / 1e6).toFixed(0)} MB)`);

    outputs.render = path.relative(ROOT, outName('render.png'));
    renderRGB(outName('render.png'), outPlanes, gridW, gridH, 1600);
    outputs.coverage = path.relative(ROOT, outName('coverage.png'));
    renderCoverage(outName('coverage.png'), coverage, gridW, gridH, 1200, Math.max(1, maxCov));
    if (MODE === 'drizzle' && drizzleWeightMap) {
        // Fruchter-Hook weight map (green channel), normalized to its peak
        let wm = 0;
        for (let i = 0; i < drizzleWeightMap.length; i++) if (drizzleWeightMap[i] > wm) wm = drizzleWeightMap[i];
        const wbytes = new Uint8Array(drizzleWeightMap.length);
        for (let i = 0; i < drizzleWeightMap.length; i++) wbytes[i] = Math.min(255, Math.round(255 * drizzleWeightMap[i] / (wm || 1)));
        outputs.weightMap = path.relative(ROOT, outName('weightmap.png'));
        renderCoverage(outName('weightmap.png'), wbytes, gridW, gridH, 1200, 255);
    }
    console.log(`  renders -> ${outputs.render}, ${outputs.coverage}${outputs.weightMap ? ', ' + outputs.weightMap : ''}`);

    return {
        cluster: cluster.index,
        centroid: { raHours: +grid.crval[0].toFixed(5), decDeg: +grid.crval[1].toFixed(4) },
        reference: ref.rel,
        members: members.map((m, fi) => ({
            file: m.rel,
            dims: `${m.W}x${m.H}x${m.NP}`,
            solveMode: m.solve.mode,
            solveMs: m.solve.ms,
            scale: +m.solve.scale.toFixed(4),
            quadMatches: m.solve.quadMatches,
            catalogMatches: m.solve.catN,
            catalogRmsPx: m.solve.catRmsPx,
            catalogRmsArcsec: m.solve.catRmsArcsec,
            relRegMatches: m.rel_.n,
            relRegRmsPx: m.rel_.rmsPx,
            relRegRmsArcsec: m.rel_.rmsArcsec,
            weakRegistration: m.rel_.weak ?? false,
            fwhmPx: +m.fwhmPx.toFixed(3),
            fwhmArcsec: +(m.fwhmPx * m.solve.scale).toFixed(3),
            phot: photTable[fi],
            rejectedFrac: MODE === 'stack' ? +(rejStats[fi].rejected / Math.max(1, rejStats[fi].contrib)).toExponential(2) : null,
            corrNote: m.corrNote ?? null,
        })),
        validation,
        outputs,
    };
}

// ── stack-mode channel combine ──────────────────────────────────────────────
function stackChannel(out, planes, members, grid, ratios, stats, sigmasN, weights, coverage, rejMap, rejStats) {
    const nF = members.length;
    const gridW = grid.W, gridH = grid.H;
    const tileBufs = members.map(() => new Float32Array(gridW * TILE_ROWS));
    const vals = new Float64Array(nF), wts = new Float64Array(nF), sgs = new Float64Array(nF);
    const fidx = new Int32Array(nF), keep = new Uint8Array(nF), tmp = new Float64Array(nF);
    for (let ty = 0; ty < gridH; ty += TILE_ROWS) {
        const th = Math.min(TILE_ROWS, gridH - ty);
        for (let fi = 0; fi < nF; fi++) {
            if (Number.isFinite(ratios[fi]))
                resampleWindow(planes[fi], members[fi], grid, 0, ty, gridW, th, stats[fi].med, ratios[fi], tileBufs[fi]);
            else tileBufs[fi].fill(NaN, 0, gridW * th);
        }
        for (let i = 0; i < gridW * th; i++) {
            let n = 0;
            for (let fi = 0; fi < nF; fi++) {
                const v = tileBufs[fi][i];
                if (Number.isFinite(v)) { vals[n] = v; wts[n] = weights[fi]; sgs[n] = sigmasN[fi]; fidx[n] = fi; n++; }
            }
            const gi = (ty) * gridW + i;
            if (coverage) coverage[gi] = n;
            if (n === 0) { out[gi] = 0; continue; }
            for (let k = 0; k < n; k++) { keep[k] = 1; rejStats[fidx[k]].contrib++; }
            let nKeep = n;
            if (n >= CLIP_MIN_FRAMES) {
                // two clip rounds: median+MAD of survivors, per-frame threshold
                for (let round = 0; round < 2; round++) {
                    let kn = 0;
                    for (let k = 0; k < n; k++) if (keep[k]) tmp[kn++] = vals[k];
                    if (kn < CLIP_MIN_FRAMES) break;
                    const med = medianInPlace(tmp, kn);
                    for (let k = 0; k < kn; k++) tmp[k] = Math.abs(tmp[k] - med);
                    const mad = medianInPlace(tmp, kn) * 1.4826;
                    let changed = false;
                    for (let k = 0; k < n; k++) {
                        if (!keep[k]) continue;
                        const thr = CLIP_K * Math.max(mad, sgs[k], CLIP_SB_FLOOR * Math.abs(med));
                        if (Math.abs(vals[k] - med) > thr && nKeep > CLIP_MIN_FRAMES - 1) {
                            keep[k] = 0; nKeep--; changed = true;
                            rejStats[fidx[k]].rejected++;
                            if (rejMap[gi] < 255) rejMap[gi]++;
                        }
                    }
                    if (!changed) break;
                }
            }
            let sw = 0, sv = 0;
            for (let k = 0; k < n; k++) if (keep[k]) { sv += wts[k] * vals[k]; sw += wts[k]; }
            out[gi] = sw > 0 ? sv / sw : 0;
        }
        // shift: pixels of this band were written with gi = ty*gridW + i where i
        // spans the whole band — correct because buffers are band-relative
        if (ty === 0 && VERBOSE) vlog(`    band 0 done`);
    }
}

function medianInPlace(a, n) {
    // insertion sort — n <= frame count
    for (let i = 1; i < n; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
    return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

// ── drizzle-mode channel accumulate (Fruchter-Hook, turbo kernel) ───────────
// Returns the weight map when `coverage` is supplied (green pass); coverage
// itself receives CONTRIBUTOR COUNTS (frames whose footprint deposited here).
function drizzleChannel(out, planes, members, grid, ratios, stats, weights, outScale, coverage) {
    const gridW = grid.W, gridH = grid.H;
    const acc = new Float64Array(out.length), wgt = new Float64Array(out.length);
    const seen = coverage ? new Uint8Array(out.length) : null;
    for (let fi = 0; fi < members.length; fi++) {
        if (!Number.isFinite(ratios[fi]) || weights[fi] <= 0) continue;
        if (seen) seen.fill(0);
        const m = members[fi], plane = planes[fi];
        const bg = stats[fi].med, ratio = ratios[fi], wf = weights[fi];
        // forward mapping node lattice over the INPUT grid
        const nodes = buildNodes((px, py) => {
            const sky = pixToSky(m.wcsFinal, px, py);
            return skyToOut(grid, sky.raH, sky.dec);
        }, 0, 0, m.W, m.H);
        const side = PIXFRAC * m.solve.scale / outScale; // shrunken footprint, output px
        const half = side / 2, area = side * side;
        const p = { x: 0, y: 0 };
        for (let y = 0; y < m.H; y++) {
            for (let x = 0; x < m.W; x++) {
                const v = plane[y * m.W + x];
                if (!Number.isFinite(v)) continue;
                nodeInterp(nodes, x, y, p);
                const x0 = p.x - half, x1 = p.x + half, y0 = p.y - half, y1 = p.y + half;
                if (x1 < -0.5 || y1 < -0.5 || x0 > gridW - 0.5 || y0 > gridH - 0.5) continue;
                const vn = ratio * (v - bg);
                const cxA = Math.max(0, Math.round(x0)), cxB = Math.min(gridW - 1, Math.round(x1));
                const cyA = Math.max(0, Math.round(y0)), cyB = Math.min(gridH - 1, Math.round(y1));
                for (let cy = cyA; cy <= cyB; cy++) {
                    const oy0 = Math.max(y0, cy - 0.5), oy1 = Math.min(y1, cy + 0.5);
                    if (oy1 <= oy0) continue;
                    for (let cx = cxA; cx <= cxB; cx++) {
                        const ox0 = Math.max(x0, cx - 0.5), ox1 = Math.min(x1, cx + 0.5);
                        if (ox1 <= ox0) continue;
                        const a = (ox1 - ox0) * (oy1 - oy0) / area * wf;
                        const o = cy * gridW + cx;
                        acc[o] += vn * a; wgt[o] += a;
                        if (seen) seen[o] = 1;
                    }
                }
            }
        }
        if (seen) for (let i = 0; i < out.length; i++) if (seen[i]) coverage[i]++;
    }
    let wMax = 0;
    for (let i = 0; i < out.length; i++) if (wgt[i] > wMax) wMax = wgt[i];
    const wEps = wMax * 1e-6;
    for (let i = 0; i < out.length; i++) out[i] = wgt[i] > wEps ? acc[i] / wgt[i] : 0;
    return coverage ? wgt : null;
}

// ── renders (PNG rows flipped: north up, east left for cd=[-s,0,0,s]) ───────
function stretchBytes(v, lo, hi) {
    const s = (v - lo) / (hi - lo);
    return s <= 0 ? 0 : s >= 1 ? 255 : Math.round(255 * Math.pow(s, 1 / 2.2));
}
function percentiles(arr, stride, loP = 0.005, hiP = 0.999) {
    const s = [];
    for (let i = 0; i < arr.length; i += stride) if (Number.isFinite(arr[i])) s.push(arr[i]);
    s.sort((a, b) => a - b);
    const lo = s[Math.floor(s.length * loP)] ?? 0;
    const hi = Math.max(s[Math.floor(s.length * hiP)] ?? 1, lo + 1e-9);
    return { lo, hi };
}
function renderRGB(outPath, planesRGB, W, H, outW) {
    const k = Math.max(1, Math.ceil(W / outW));
    const ow = Math.floor(W / k), oh = Math.floor(H / k);
    const small = [0, 1, 2].map(() => new Float64Array(ow * oh));
    for (let c = 0; c < 3; c++) {
        const p = planesRGB[c];
        for (let y = 0; y < oh; y++) {
            for (let x = 0; x < ow; x++) {
                let s = 0;
                for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) s += p[(y * k + yy) * W + x * k + xx];
                small[c][y * ow + x] = s / (k * k);
            }
        }
    }
    const st = small.map(p => percentiles(p, 7));
    const bytes = new Uint8Array(ow * oh * 3);
    for (let y = 0; y < oh; y++) {
        const sy = oh - 1 - y; // flip: north up
        for (let x = 0; x < ow; x++) {
            const o = (y * ow + x) * 3, i = sy * ow + x;
            bytes[o] = stretchBytes(small[0][i], st[0].lo, st[0].hi);
            bytes[o + 1] = stretchBytes(small[1][i], st[1].lo, st[1].hi);
            bytes[o + 2] = stretchBytes(small[2][i], st[2].lo, st[2].hi);
        }
    }
    writePNG(outPath, bytes, ow, oh);
}
function renderCoverage(outPath, coverage, W, H, outW, maxCov) {
    const k = Math.max(1, Math.ceil(W / outW));
    const ow = Math.floor(W / k), oh = Math.floor(H / k);
    const bytes = new Uint8Array(ow * oh * 3);
    for (let y = 0; y < oh; y++) {
        const sy = oh - 1 - y;
        for (let x = 0; x < ow; x++) {
            let s = 0;
            for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) s += coverage[(sy * k + yy) * W + x * k + xx];
            const v = Math.round(255 * (s / (k * k)) / maxCov);
            const o = (y * ow + x) * 3;
            bytes[o] = v; bytes[o + 1] = v; bytes[o + 2] = v;
        }
    }
    writePNG(outPath, bytes, ow, oh);
}
function writeGrayPair(outPath, left, right, W, H) {
    const st = percentiles(Float64Array.from([...left, ...right].filter(Number.isFinite)), 1, 0.01, 0.998);
    const GAP = 8, ow = W * 2 + GAP;
    const bytes = new Uint8Array(ow * H * 3);
    for (let y = 0; y < H; y++) {
        const sy = H - 1 - y;
        for (let x = 0; x < W; x++) {
            const vL = stretchBytes(left[sy * W + x], st.lo, st.hi);
            const vR = stretchBytes(right[sy * W + x], st.lo, st.hi);
            let o = (y * ow + x) * 3;
            bytes[o] = vL; bytes[o + 1] = vL; bytes[o + 2] = vL;
            o = (y * ow + W + GAP + x) * 3;
            bytes[o] = vR; bytes[o + 1] = vR; bytes[o + 2] = vR;
        }
    }
    writePNG(outPath, bytes, ow, H);
}
function writeRGBPair(outPath, leftRGB, rightRGB, S) {
    const GAP = 8, ow = S * 2 + GAP;
    const bytes = new Uint8Array(ow * S * 3);
    const stL = leftRGB.map(p => percentiles(p, 3));
    const stR = rightRGB.map(p => percentiles(p, 3));
    for (let y = 0; y < S; y++) {
        const sy = S - 1 - y;
        for (let x = 0; x < S; x++) {
            let o = (y * ow + x) * 3;
            for (let c = 0; c < 3; c++) bytes[o + c] = stretchBytes(leftRGB[c][sy * S + x], stL[c].lo, stL[c].hi);
            o = (y * ow + S + GAP + x) * 3;
            for (let c = 0; c < 3; c++) bytes[o + c] = stretchBytes(rightRGB[c][sy * S + x], stR[c].lo, stR[c].hi);
        }
    }
    writePNG(outPath, bytes, ow, S);
}

// ═══ 7. REPORT ═══════════════════════════════════════════════════════════════
phase('report');
const report = {
    when: new Date().toISOString(),
    mode: MODE,
    args: { dir: path.relative(ROOT, DIR), scale: Number.isFinite(SCALE_ARG) ? SCALE_ARG : null, drizzle: Number.isFinite(DRIZZLE) ? DRIZZLE : null, pixfrac: Number.isFinite(DRIZZLE) ? PIXFRAC : null, allowCorrelated: ALLOW_CORR, untracked: UNTRACKED },
    excluded: [
        ...excluded,
        ...frames.filter(f => f.noStack).map(f => ({ file: f.rel, reason: f.noStack, solved: !!f.solve })),
    ],
    correlationCaveat: 'This collection is a distributed community project — several products are provably or probably derived from overlapping light pools. Exact duplicates and same-lights kernel variants are excluded by default; deeper cross-contamination between distinct shooters cannot be ruled out, so sqrt(N) expectations are upper bounds.',
    clusters: clusters.map((c, i) => ({
        index: i,
        frames: c.members.length,
        stackable: c.members.filter(m => !m.noStack).length,
        centroid: { raHours: +c.centroid.raH.toFixed(5), decDeg: +c.centroid.dec.toFixed(4) },
        outputProduced: workClusters.some(wc => wc.index === i),
    })),
    clusterFinding: clusters.length === 1
        ? 'The M51 corpus collapsed to ONE cluster, as expected for a same-target collection.'
        : `Collection formed ${clusters.length} clusters — mixed pointings detected; one output per cluster with >=2 stackable frames.`,
    solvePerf: perfNote,
    solveModes: Object.fromEntries(frames.filter(f => f.solve).map(f => [f.rel, f.solve.mode])),
    unsolved: frames.filter(f => f.unsolved).map(f => ({ file: f.rel, attempts: f.attempts?.length ?? 0, blindTruncated: f.blindTruncated ?? null })),
    results,
    phaseMs: phases,
};
phase(null); report.phaseMs = phases;
fs.mkdirSync(OUT, { recursive: true });
const reportPath = path.join(OUT, `report_${MODE}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nreport -> ${path.relative(ROOT, reportPath)}`);
console.log(`phases: ${Object.entries(phases).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join('  ')}`);
for (const f of frames) f.fits?.close?.();
