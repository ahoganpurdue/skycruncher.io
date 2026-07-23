// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — RESUSCITATED SOLVER: TRI-LOCK SCALE SOLVER
// ═══════════════════════════════════════════════════════════════════════════
// Headless port of MetrologyService.solveScale
// (src/engine/pipeline/m7_astrometry/metrology.ts:23) — the LIVE "Tri-Lock":
// scale/rotation/translation-invariant triangle SIDE-RATIO match against the
// bright Vanguard catalog via the Rust kernel `solve_blind`.
//
// HONEST SCOPE (this is the whole point of relocating it correctly):
//   Tri-Lock returns a SCALE ("/px) + a triangle match_count. It does NOT
//   return a pointing (crval) or orientation — it is a metrology RULER, not a
//   plate solver. In the app it is rung 3 of the scale trust ladder (last
//   resort, only when FITS/EXIF scale is absent). Relocated here it is a
//   composable SCALE GENERATOR: its output seeds the anchored-sweep / RANSAC
//   pipeline (which needs scale pinned), NOT a standalone solve.
//   -> refinedWcs is therefore null by construction, reported "NOT MEASURED",
//      never faked.
//
// LAZARUS_REVIVAL Candidate 5a: judged LIVE + correctly gated in the app — no
// root bug to fix here. This relocation makes it runnable headless and documents
// its true (scale-only) contract so callers don't mistake it for a solver.
//
// Supersedes (for headless use): nothing live is removed; this is a thin CLI
// over the same kernel the app calls.

import { loadWasm, loadDetections, loadBrightAtlas, isMain, fmt } from './common.mjs';
import { notMeasured } from './contract.mjs';

/**
 * @param det  detections [{x,y,flux}]
 * @param opts {focalLengthHint, pixelPitchHint, magLimit, atlas?}
 * @returns {scale, matchCount, provenance, refinedWcs:null} | notMeasured(...)
 */
export async function solveScale(det, opts = {}) {
    if (!det || det.length < 3) return notMeasured('trilock', 'need >=3 detections');
    const wasm = await loadWasm();

    // scale hint seeds the matcher's combinatorial prune (metrology.ts:29-30).
    const fl = opts.focalLengthHint ?? 14;         // mm
    const pitch = opts.pixelPitchHint ?? 4.3;      // um (Canon APS-C fallback)
    const targetScale = (pitch / (fl * 1000)) * 206265;

    const anchors = [...det].sort((a, b) => (b.flux ?? 0) - (a.flux ?? 0)).slice(0, 8);
    const atlas = opts.atlas ?? loadBrightAtlas({ magLimit: opts.magLimit ?? 3.5 });
    if (atlas.length < 3) return notMeasured('trilock', 'bright atlas unavailable');

    const aX = Float64Array.from(anchors, (a) => a.x);
    const aY = Float64Array.from(anchors, (a) => a.y);
    const aB = Float64Array.from(anchors, (a) => a.flux ?? 0);
    const cR = Float64Array.from(atlas, (s) => s.ra_deg);   // DEGREES (matches metrology.ts:60)
    const cD = Float64Array.from(atlas, (s) => s.dec_deg);
    const cM = Float64Array.from(atlas, (s) => s.mag);

    const t0 = Date.now();
    const res = wasm.solve_blind(aX, aY, aB, cR, cD, cM, targetScale || 0);
    const ms = Date.now() - t0;
    const scale = res?.scale, mc = res?.match_count;
    if (typeof res?.free === 'function') res.free();

    if (mc > 0 && scale > 0) {
        return {
            scale, matchCount: mc, scaleHint: targetScale, ms,
            refinedWcs: null,               // NOT MEASURED — Tri-Lock yields no pointing
            provenance: 'trilock:scale-only',
        };
    }
    return notMeasured('trilock', `no triangle lock in ${ms}ms`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
    const name = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'sample_observation';
    const f = loadDetections(name);
    const fl = f.metadata?.focal_length ?? undefined;
    const r = await solveScale(f.det, { focalLengthHint: fl });
    console.log(`[trilock] ${f.name}: ${f.det.length} dets, true scale (app)=${fmt(f.scaleArcsecPerPx, 2)}"/px`);
    if (r.scale) {
        console.log(`  SCALE LOCK: ${fmt(r.scale, 3)}"/px  (triangle matches=${r.matchCount}, hint=${fmt(r.scaleHint, 2)}"/px, ${r.ms}ms)`);
        console.log('  pointing/orientation: NOT MEASURED (Tri-Lock is scale-only by design)');
    } else {
        console.log(`  NOT MEASURED: ${r.reason}`);
    }
}
if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
