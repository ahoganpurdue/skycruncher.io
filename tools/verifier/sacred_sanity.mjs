// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRIC VERIFIER — SACRED-SOLVE SANITY ARM (offline, banked artifacts only)
// ═══════════════════════════════════════════════════════════════════════════
// The verifier must score the two PINNED REFERENCE SOLVES' known-good WCS as
// strong accepts, from banked receipts alone (no live solves):
//   SeeStar: RA=11.341253475172621h, 3.6776147325019153"/px — receipt.json
//            carries the fitted WCS (engine convention, 0-based y-down) and
//            signal.clean_stars as an independent detection list.
//   CR2:     RA=17.595604137818327h, 63.439401949684004"/px — scored IF a
//            banked artifact carries the full fitted WCS + detections;
//            otherwise DEFERRED with the reason printed (per task contract:
//            note it, don't burn an hour).
// Decoys: same deterministic perturbation family as the X-Trans gauntlet,
// scaled to each field's FOV.

import fs from 'node:fs';
import path from 'node:path';
import { scoreWcs, footprint, perturbWcs, DEFAULTS } from './score_wcs.mjs';
import { makeProvider } from './catalog_provider.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'test_results', 'geometric_verifier_2026-07-13');
// catalog seam (owner directive 2026-07-13): 'auto' = full-set extracts when
// READY, else atlas (SUPERSEDED-SHALLOW, labeled in provenance)
const catMode = process.argv.includes('--catalog') ? process.argv[process.argv.indexOf('--catalog') + 1] : 'auto';
const provider = makeProvider({ mode: catMode, magLimit: DEFAULTS.magLimit });

async function scoreFamily(label, frame, truthWcs, dRaNear, dRaFar, out) {
    const cands = [
        { name: 'TRUTH', kind: 'truth', wcs: truthWcs },
        { name: 'rot25', kind: 'decoy', wcs: perturbWcs(truthWcs, { rotDeg: 25 }) },
        { name: 'rot180', kind: 'decoy', wcs: perturbWcs(truthWcs, { rotDeg: 180 }) },
        { name: 'parityflip', kind: 'decoy', wcs: perturbWcs(truthWcs, { parityFlip: true }) },
        { name: 'scale1.25', kind: 'decoy', wcs: perturbWcs(truthWcs, { scaleF: 1.25 }) },
        { name: 'scale0.80', kind: 'decoy', wcs: perturbWcs(truthWcs, { scaleF: 0.80 }) },
        { name: `ra+${dRaFar}deg`, kind: 'decoy', wcs: perturbWcs(truthWcs, { dRaDeg: dRaFar }) },
        { name: `ra+${dRaNear}deg`, kind: 'near_truth_diag', wcs: perturbWcs(truthWcs, { dRaDeg: dRaNear }) },
    ];
    const rows = [];
    for (const c of cands) {
        const fp = footprint(c.wcs, frame.width, frame.height);
        // narrow fields need catalog depth; scale magLimit with field size (atlas mode only)
        const magLimit = fp.radiusDeg < 6 ? 13 : DEFAULTS.magLimit;
        const cat = await provider.get(fp, { frameId: label, magLimit });
        if (!cat.ok) {
            rows.push({ name: c.name, kind: c.kind, unscored: cat.reason, fp: { ra: +fp.raDeg.toFixed(3), dec: +fp.decDeg.toFixed(3) } });
            console.log(`  [${label}] ${c.name.padEnd(14)} UNSCORED — ${cat.reason}`);
            continue;
        }
        const r = scoreWcs(frame, c.wcs, cat.stars, { magLimit, nullReps: c.kind === 'truth' ? 24 : 12 });
        rows.push({ name: c.name, kind: c.kind, provenance: cat.provenance, fp: { ra: +fp.raDeg.toFixed(3), dec: +fp.decDeg.toFixed(3), scale: +fp.scaleArcsecPx.toFixed(3) }, ...r });
        console.log(`  [${label}] ${c.name.padEnd(14)} anchored=${String(r.anchored).padStart(3)} passQuads=${String(r.passQuads).padStart(4)} ` +
            `null=${r.null.mean}±${r.null.sd} z=${r.z} inFrameCat=${r.inFrameCat} [${r.wallMs} ms]`);
    }
    const truth = rows.find((r) => r.kind === 'truth' && !r.unscored);
    const spurious = rows.filter((r) => r.kind === 'decoy' && !r.unscored);
    const bestSp = spurious.slice().sort((a, b) => b.anchored - a.anchored)[0];
    if (!truth || !bestSp) {
        out[label] = { rows, verdict: { separated: null, reason: 'truth or all decoys UNSCORED (no catalog coverage)' } };
        console.log(`  [${label}] VERDICT — NOT MEASURED (insufficient catalog coverage)`);
        return;
    }
    const verdict = {
        truthAnchored: truth.anchored, truthZ: truth.z,
        bestSpurious: { name: bestSp.name, anchored: bestSp.anchored, z: bestSp.z },
        separated: truth.anchored > bestSp.anchored && truth.z > (bestSp.z ?? -1),
    };
    console.log(`  [${label}] separated=${verdict.separated} truth ${truth.anchored}/${truth.z}σ vs ${bestSp.name} ${bestSp.anchored}/${bestSp.z}σ`);
    out[label] = { rows, verdict };
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const out = { ts: new Date().toISOString(), catalog_provenance: { mode: provider.mode, label: provider.label } };
    console.log(`[catalog] provider = ${provider.label}`);

    // ── SeeStar (pinned: RA=11.341253475172621h, 3.6776147325019153"/px) ────
    const seestarReceipts = fs.readdirSync(path.join(ROOT, 'test_results', 'e2e'))
        .filter((d) => d.startsWith('seestar_'))
        .map((d) => path.join(ROOT, 'test_results', 'e2e', d, 'receipt.json'))
        .filter((p) => fs.existsSync(p))
        .sort();
    const sp = seestarReceipts[seestarReceipts.length - 1];
    if (!sp) {
        out.seestar = { deferred: 'no banked seestar receipt.json found under test_results/e2e/' };
        console.log('[seestar] DEFERRED — no banked receipt');
    } else {
        const r = JSON.parse(fs.readFileSync(sp, 'utf8'));
        console.log(`[seestar] receipt ${sp}  ra_hours=${r.solution.ra_hours} scale=${r.solution.pixel_scale}`);
        const W = r.metadata.width, H = r.metadata.height;
        const w = r.wcs; // engine convention: 0-based, y-down (receipt COMMENT)
        const truthWcs = {
            crval: [w.CRVAL1, w.CRVAL2],
            crpix: [w.CRPIX1, w.CRPIX2],
            cd: [[w.CD1_1, w.CD1_2], [w.CD2_1, w.CD2_2]],
        };
        const det = r.signal.clean_stars
            .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y))
            .map((s) => ({ x: s.x, y: s.y, flux: s.flux ?? 0 }))
            .sort((a, b) => b.flux - a.flux);
        out.seestar_source = { receipt: sp, ra_hours: r.solution.ra_hours, pixel_scale: r.solution.pixel_scale, dets: det.length, dims: [W, H] };
        await scoreFamily('seestar', { det, width: W, height: H }, truthWcs, 0.2, 5, out);
    }

    // ── CR2 (pinned: RA=17.595604137818327h, 63.439401949684004"/px) ────────
    // Try banked artifacts for a FULL fitted WCS (crval/crpix/cd) + detections.
    let cr2Done = false;
    const cr2Dirs = fs.readdirSync(path.join(ROOT, 'test_results', 'e2e'))
        .filter((d) => d.startsWith('cr2_')).sort().reverse();
    for (const d of cr2Dirs.slice(0, 6)) {
        const rp = path.join(ROOT, 'test_results', 'e2e', d, 'receipt.json');
        if (!fs.existsSync(rp)) continue;
        const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
        if (!r.wcs || !r.signal?.clean_stars || !r.metadata?.width) continue;
        console.log(`[cr2] receipt ${rp}  ra_hours=${r.solution?.ra_hours}`);
        const truthWcs = {
            crval: [r.wcs.CRVAL1, r.wcs.CRVAL2],
            crpix: [r.wcs.CRPIX1, r.wcs.CRPIX2],
            cd: [[r.wcs.CD1_1, r.wcs.CD1_2], [r.wcs.CD2_1, r.wcs.CD2_2]],
        };
        const det = r.signal.clean_stars.map((s) => ({ x: s.x, y: s.y, flux: s.flux ?? 0 })).sort((a, b) => b.flux - a.flux);
        out.cr2_source = { receipt: rp, ra_hours: r.solution?.ra_hours, dets: det.length, dims: [r.metadata.width, r.metadata.height] };
        await scoreFamily('cr2', { det, width: r.metadata.width, height: r.metadata.height }, truthWcs, 0.5, 15, out);
        cr2Done = true;
        break;
    }
    if (!cr2Done) {
        out.cr2 = {
            deferred: 'no banked CR2 receipt.json with full fitted WCS under test_results/e2e/ ' +
                '(recent cr2_<ts> dirs bank summary.json + screenshots only); recovering the full ' +
                'crval/crpix/cd offline would require a live headless run — deferred per task contract.',
        };
        console.log('[cr2] DEFERRED — ' + out.cr2.deferred);
    }

    fs.writeFileSync(path.join(OUT, 'sacred_sanity.json'), JSON.stringify(out, null, 1));
    console.log(`[done] -> ${path.join(OUT, 'sacred_sanity.json')}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
