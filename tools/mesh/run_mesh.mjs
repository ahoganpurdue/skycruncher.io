// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — driver: run the quad-mesh cascade on ONE banked frame + measure
// ═══════════════════════════════════════════════════════════════════════════
// Banked-data-first (standing law): NO live solves. Inputs are a banked capture
// (f32 luminance buffer + fitted WCS + anchor matches) and, optionally, an
// independent banked reference of real star positions for false-completion
// scoring (iterbc densified harvest). Writes a JSON measurement + overlay PNG.
//
// M66 example (defaults):
//   node tools/mesh/run_mesh.mjs \
//     --buffer D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_buffer.f32 \
//     --meta   D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json \
//     --reference D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_loop_render.json \
//     --frame M66

import fs from 'node:fs';
import path from 'node:path';
import { regionStars } from '../psf/g15u_stars.mjs';
import { tanForward, projectStars, forcedMeasure } from '../psf/forced_detect.mjs';
import { makeBrownConrady } from '../psf/corrections.mjs';
import { makeStretch, downscaleRGB, plotPoint, writePNG } from '../psf/imaging.mjs';
import { attachTangent, runCascade, scoreAgainstReference } from './mesh_finder.mjs';

const D2R = Math.PI / 180;
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const argNum = (k, d) => { const v = argVal(k, null); return v == null ? d : parseFloat(v); };
const hasFlag = (k) => args.includes(k);

const STARS_ARROW = argVal('--stars', 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow');
const OUT_DIR = argVal('--out-dir', 'D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22');

function frameConeRadiusDeg(cd, w, h) {
    const hd = Math.hypot((w - 1) / 2, (h - 1) / 2);
    const scaleDeg = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]));
    return Math.min(89, Math.atan(hd * scaleDeg * D2R) / D2R + 2);
}
function loadF32(bufPath, w, h) {
    const b = fs.readFileSync(bufPath);
    const n = w * h;
    if (b.byteLength < n * 4) throw new Error(`buffer ${b.byteLength}B < ${n * 4}B for ${w}x${h}`);
    return new Float32Array(b.buffer, b.byteOffset, n);
}
// pick the seed subset: --seed-mode all (default) | brightest:N | frac:F |
//   central:R (anchors with r_norm<R — tests BFS crawl outward) | corner:R
function pickSeed(anchors, mode, rNorm) {
    if (!mode || mode === 'all') return anchors;
    const m = /^brightest:(\d+)$/.exec(mode); if (m) return [...anchors].sort((a, b) => a.mag - b.mag).slice(0, +m[1]);
    const f = /^frac:([\d.]+)$/.exec(mode); if (f) { const s = [...anchors].sort((a, b) => a.mag - b.mag); return s.slice(0, Math.max(3, Math.round(s.length * +f[1]))); }
    const cen = /^central:([\d.]+)$/.exec(mode); if (cen) return anchors.filter((a) => rNorm(a.x, a.y) < +cen[1]);
    const cor = /^corner:([\d.]+)$/.exec(mode); if (cor) return anchors.filter((a) => rNorm(a.x, a.y) > +cor[1]);
    return anchors;
}

function markCross(bytes, ow, oh, x, y, rgb, r = 2) {
    for (let d = -r; d <= r; d++) { plotPoint(bytes, ow, oh, x + d, y, rgb, 0.95); plotPoint(bytes, ow, oh, x, y + d, rgb, 0.95); }
}

async function main() {
    const t0 = Date.now();
    const FRAME = argVal('--frame', 'M66');
    const META = argVal('--meta', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json');
    const BUFFER = argVal('--buffer', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_buffer.f32');
    const REFERENCE = argVal('--reference', 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_loop_render.json');
    const MAG_LIMIT = argNum('--mag-limit', 15);
    const SEED_MODE = argVal('--seed-mode', 'all');
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    const W = meta.width, H = meta.height;
    const wcs = meta.wcs;
    const crval = [wcs.CRVAL1, wcs.CRVAL2], crpix = [wcs.CRPIX1, wcs.CRPIX2];
    const cd = [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]];
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    const anchors = meta.matched_stars; // {gaia_id, ra_deg, dec_deg, mag, x, y}
    const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
    const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

    console.log(`[${FRAME}] ${W}x${H} scale ${(Math.sqrt(Math.abs(det)) * 3600).toFixed(2)}"/px, ${anchors.length} anchors`);

    // ── catalog: g15u in-frame cone, tangent-plane, unioned with anchors ──
    const coneR = frameConeRadiusDeg(cd, W, H);
    const g15 = regionStars({ starsArrowPath: STARS_ARROW, raDeg: crval[0], decDeg: crval[1], radiusDeg: coneR, magLimit: MAG_LIMIT });
    // keep only stars that project inside the frame (linear WCS, generous margin)
    const inFrame = [];
    for (const s of g15) {
        const p = tanForward(s.ra_deg, s.dec_deg, crval[0], crval[1]); if (!p) continue;
        const x = crpix[0] + (cd[1][1] * p.xi - cd[0][1] * p.eta) / det;
        const y = crpix[1] + (-cd[1][0] * p.xi + cd[0][0] * p.eta) / det;
        if (x < -40 || y < -40 || x >= W + 40 || y >= H + 40) continue;
        inFrame.push({ id: s.gaia_id, ra_deg: s.ra_deg, dec_deg: s.dec_deg, mag: s.mag });
    }
    let catalog = attachTangent(inFrame, crval[0], crval[1]);
    // union anchors: match each anchor to nearest catalog star (tangent-plane);
    // reuse its id if within ~1.5px, else append the anchor as its own entry.
    const anchTan = attachTangent(anchors.map((a) => ({ id: a.gaia_id, ra_deg: a.ra_deg, dec_deg: a.dec_deg, mag: a.mag, _x: a.x, _y: a.y })), crval[0], crval[1]);
    const pxTolDeg = 1.5 * Math.sqrt(Math.abs(det)); // ~1.5px in deg
    const seed = [];
    let appended = 0;
    for (const a of anchTan) {
        let best = null, bd = Infinity;
        for (const c of catalog) { const d2 = (c.xi - a.xi) ** 2 + (c.eta - a.eta) ** 2; if (d2 < bd) { bd = d2; best = c; } }
        if (best && Math.sqrt(bd) < pxTolDeg) { seed.push({ id: best.id, x: a._x, y: a._y, mag: a.mag }); }
        else { catalog.push({ id: a.id, ra_deg: a.ra_deg, dec_deg: a.dec_deg, mag: a.mag, xi: a.xi, eta: a.eta }); seed.push({ id: a.id, x: a._x, y: a._y, mag: a.mag }); appended++; }
    }
    // dedupe seed ids (two anchors could map to same catalog star)
    const seenSeed = new Set(); const seedU = [];
    for (const s of seed) { if (seenSeed.has(s.id)) continue; seenSeed.add(s.id); seedU.push(s); }
    console.log(`[${FRAME}] catalog: ${catalog.length} (g15u in-frame ${inFrame.length} + ${appended} appended anchors), seed ${seedU.length}, cone ${coneR.toFixed(2)}deg`);

    // ── buffer + cascade ──
    const L = loadF32(BUFFER, W, H);
    const params = { snrThreshold: argNum('--snr', 5), kNear: argNum('--knear', 8), kMin: argNum('--kmin', 3), maxIters: argNum('--max-iters', 12), centTol: argNum('--cent-tol', 4), maxReanchor: argNum('--max-reanchor', 6) };
    // seed-mode filters operate directly on the resolved seed (has x,y,mag)
    const finalSeed = pickSeed(seedU, SEED_MODE, rNorm);
    const tCasc = Date.now();
    const { matches, iterations, params: usedP, sigmaPix } = runCascade({ catalog, seed: finalSeed, L, w: W, h: H, cx, cy, params });
    const cascadeMs = Date.now() - tCasc;

    const all = [...matches.values()];
    const meshOnly = all.filter((m) => m.source === 'mesh');
    const multiplication = +(all.length / finalSeed.length).toFixed(2);
    console.log(`[${FRAME}] cascade: seed ${finalSeed.length} -> ${all.length} matched (+${meshOnly.length} mesh) = ${multiplication}x in ${(cascadeMs / 1000).toFixed(1)}s, ${iterations.length} rounds`);
    for (const it of iterations) console.log(`   iter${it.iter}: considered ${it.considered} predicted ${it.predicted} +${it.added} (total ${it.matched_after}) [rejgate ${it.rej_gate} rejcent ${it.rej_centroid}]`);

    // ── score vs independent banked reference (iterbc densified accepted) ──
    let scoring = null, refN = 0, refPts = [], refRmax = 0;
    if (REFERENCE && fs.existsSync(REFERENCE)) {
        const ref = JSON.parse(fs.readFileSync(REFERENCE, 'utf8'));
        // iterbc loop_render: iterations[last].test_stars filtered accepted
        if (ref.iterations) { const last = ref.iterations[ref.iterations.length - 1]; refPts = (last.test_stars || []).filter((t) => t.accepted).map((t) => ({ x: t.x, y: t.y })); }
        else if (Array.isArray(ref)) refPts = ref.map((t) => ({ x: t.x, y: t.y }));
        refN = refPts.length;
        scoring = scoreAgainstReference(meshOnly, refPts, { tol: argNum('--ref-tol', 3) });
        // reference radial coverage (so we don't call "outside coverage" false)
        refRmax = refPts.length ? Math.max(...refPts.map((p) => rNorm(p.x, p.y))) : 0;
        scoring.reference_n = refN;
        scoring.reference_r_norm_max = +refRmax.toFixed(3);
        // split uncorroborated by whether they lie within reference coverage
        const inCov = scoring.rows.filter((r) => r.r_norm <= refRmax);
        const outCov = scoring.rows.filter((r) => r.r_norm > refRmax);
        scoring.in_coverage = { n: inCov.length, corroborated: inCov.filter((r) => r.corroborated).length };
        scoring.out_of_coverage = { n: outCov.length, note: 'beyond the reference radius — forced-photometry-verified here but no independent reference to check against (the mesh reaches where the center-cropped global harvest did not)' };
        console.log(`[${FRAME}] vs iterbc ref (${refN} pts, r_norm<=${refRmax.toFixed(2)}): mesh corroborated ${scoring.corroborated}/${scoring.total} (${((scoring.corrob_frac || 0) * 100).toFixed(0)}%); in-coverage ${scoring.in_coverage.corroborated}/${scoring.in_coverage.n}, out-of-coverage ${scoring.out_of_coverage.n}`);
    }

    // ── FULL-FIELD independent truth: WCS + measured Brown-Conrady, forced ──
    // Resolves the corner question the center-cropped iterbc reference cannot: an
    // INDEPENDENT predictor (global WCS + measured distortion, NOT the mesh's local
    // affine) forced-measures every catalog star across the WHOLE field. A mesh
    // completion is BC-corroborated (by catalog ID) if this independent path also
    // finds accepted flux there AND the two positions agree. This is a different
    // prediction path, so agreement is real cross-validation, not self-consistency.
    let bcTruth = null;
    const bcLedgerPath = argVal('--bc-ledger', REFERENCE.replace('loop_render', 'loop_ledger'));
    let k1 = meta.bc_measured?.k1 ?? 0, k2 = meta.bc_measured?.k2 ?? 0, bcSrc = 'meta.bc_measured';
    if (fs.existsSync(bcLedgerPath)) { try { const led = JSON.parse(fs.readFileSync(bcLedgerPath, 'utf8')); if (led.final_bc) { k1 = led.final_bc.k1; k2 = led.final_bc.k2; bcSrc = 'loop_ledger.final_bc'; } } catch { /* keep meta */ } }
    {
        const coordFn = makeBrownConrady(k1, k2, W, H);
        // validate the BC model on the anchors (trust gauge)
        const anchStars = anchors.map((a) => ({ ra_deg: a.ra_deg, dec_deg: a.dec_deg, _mx: a.x, _my: a.y }));
        const anchProj = projectStars({ stars: anchStars, wcs: { crpix, crval, cd }, coordFn, w: W, h: H, margin: -50 });
        let se = 0, nn = 0; for (const s of anchProj) { se += (s.x - s._mx) ** 2 + (s.y - s._my) ** 2; nn++; }
        const anchRms = nn ? Math.sqrt(se / nn) : null;
        // project + force the full catalog
        const catStars = catalog.map((c) => ({ id: c.id, ra_deg: c.ra_deg, dec_deg: c.dec_deg, mag: c.mag }));
        const proj = projectStars({ stars: catStars, wcs: { crpix, crval, cd }, coordFn, w: W, h: H, margin: 6 });
        const fwhm = meta.mean_fwhm_px || 3;
        const fm = forcedMeasure({ L, w: W, h: H, positions: proj.map((p) => ({ x: p.x, y: p.y, mag: p.mag, gaia_id: p.id })), fwhmPx: fwhm, posRmsPx: Math.max(2, anchRms || 2), snrThreshold: argNum('--snr', 5), sigmaPix });
        const truthMap = new Map();
        fm.results.forEach((r) => { if (r.accepted) truthMap.set(r.gaia_id, { x: r.x, y: r.y, snr: r.snr }); });
        // cross-check mesh completions by ID
        const posTol = argNum('--bc-tol', 4);
        const rows = meshOnly.map((m) => { const t = truthMap.get(m.id); const agree = t ? Math.hypot(t.x - m.x, t.y - m.y) : null; return { id: m.id, r_norm: m.r_norm, bc_accepted: !!t, pos_agree_px: agree == null ? null : +agree.toFixed(2), corroborated: !!t && agree <= posTol }; });
        const byRad = {};
        for (const r of rows) { const b = Math.min(9, Math.floor(r.r_norm * 10)); const key = `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`; if (!byRad[key]) byRad[key] = { n: 0, corrob: 0 }; byRad[key].n++; if (r.corroborated) byRad[key].corrob++; }
        const radial = Object.entries(byRad).sort().map(([kk, v]) => ({ r_norm: kk, n: v.n, corroborated: v.corrob, frac: +(v.corrob / v.n).toFixed(3) }));
        const corr = rows.filter((r) => r.corroborated).length;
        bcTruth = { k1, k2, bc_source: bcSrc, anchor_validation_rms_px: anchRms != null ? +anchRms.toFixed(2) : null, full_field_truth_accepted: truthMap.size, mesh_corroborated: corr, mesh_total: meshOnly.length, corrob_frac: meshOnly.length ? +(corr / meshOnly.length).toFixed(4) : null, by_radius: radial };
        console.log(`[${FRAME}] BC full-field truth (${bcSrc} k1=${k1} anchRMS ${bcTruth.anchor_validation_rms_px}px, ${truthMap.size} accepted): mesh corroborated ${corr}/${meshOnly.length} (${((bcTruth.corrob_frac || 0) * 100).toFixed(0)}%)`);
        for (const r of radial) console.log(`   r ${r.r_norm}: ${r.corroborated}/${r.n} (${(r.frac * 100).toFixed(0)}%)`);
    }

    // ── diagnostic: PREDICTION accuracy — local-affine vs GLOBAL LINEAR WCS ──
    // Both predictors are scored against the INDEPENDENT iterbc reference (nearest
    // accepted real-star position), so neither is tied to the mesh's own re-anchor.
    // Only computed within reference coverage (r_norm <= refRmax); beyond that
    // there is no independent truth and we make NO prediction-accuracy claim.
    // If affine < linear here, the local geometry is absorbing the distortion the
    // global linear WCS leaves behind — the concept's core claim, honestly tested.
    const refGrid = (() => {
        const CELL = 40, map = new Map();
        refPts.forEach((r, i) => { const k = Math.floor(r.x / CELL) * 100003 + Math.floor(r.y / CELL); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); });
        return (x, y) => { const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL); let best = Infinity; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const d = Math.hypot(refPts[i].x - x, refPts[i].y - y); if (d < best) best = d; } } return best; };
    })();
    const buckets = {};
    for (const m of meshOnly) {
        if (!refPts.length || m.r_norm > refRmax) continue; // truth only inside coverage
        const c = catalog.find((z) => z.id === m.id);
        const p = tanForward(c.ra_deg, c.dec_deg, crval[0], crval[1]);
        const lx = crpix[0] + (cd[1][1] * p.xi - cd[0][1] * p.eta) / det;
        const ly = crpix[1] + (-cd[1][0] * p.xi + cd[0][0] * p.eta) / det;
        const linErr = refGrid(lx, ly);          // linear-WCS prediction -> nearest true star
        const affErr = refGrid(m.pred_x, m.pred_y); // affine prediction   -> nearest true star
        if (!Number.isFinite(linErr) || !Number.isFinite(affErr)) continue;
        const b = Math.min(9, Math.floor(m.r_norm * 10));
        const key = `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`;
        if (!buckets[key]) buckets[key] = { n: 0, sumLin: 0, sumAff: 0 };
        buckets[key].n++; buckets[key].sumLin += linErr; buckets[key].sumAff += affErr;
    }
    const radialDiag = Object.entries(buckets).sort().map(([k, v]) => ({ r_norm: k, n: v.n, mean_linear_pred_err_px: +(v.sumLin / v.n).toFixed(2), mean_affine_pred_err_px: +(v.sumAff / v.n).toFixed(2) }));
    console.log(`[${FRAME}] PREDICTION error vs independent reference, by radius (in-coverage only):`);
    for (const r of radialDiag) console.log(`   r ${r.r_norm}: n=${r.n} linear-pred ${r.mean_linear_pred_err_px}px  affine-pred ${r.mean_affine_pred_err_px}px`);

    // ── overlay PNG ──
    const outW = 1080; const stretch = makeStretch([L]); stretch.lo = [stretch.lo[0], stretch.lo[0], stretch.lo[0]]; stretch.hi = [stretch.hi[0], stretch.hi[0], stretch.hi[0]];
    const ds = downscaleRGB(L, L, L, W, H, outW, stretch);
    const sc = ds.scale;
    const corrobIds = scoring ? new Set(scoring.rows.filter((r) => r.corroborated).map((r) => r.id)) : new Set();
    for (const m of all) {
        if (m.source === 'seed') markCross(ds.bytes, ds.ow, ds.oh, m.x * sc, m.y * sc, [80, 160, 255], 2); // seed = blue
    }
    for (const m of meshOnly) {
        const rgb = scoring ? (corrobIds.has(m.id) ? [60, 230, 90] : [255, 60, 200]) : [60, 230, 90]; // green corroborated / magenta not
        markCross(ds.bytes, ds.ow, ds.oh, m.x * sc, m.y * sc, rgb, 2);
    }
    const pngPath = path.join(OUT_DIR, `${FRAME}_mesh_overlay.png`);
    writePNG(pngPath, ds.bytes, ds.ow, ds.oh);
    console.log(`[${FRAME}] overlay -> ${pngPath} (blue=seed green=mesh-corroborated magenta=mesh-uncorroborated)`);

    // ── write measurement JSON ──
    const summary = {
        frame: FRAME, generated: new Date().toISOString(), lane: 'tools/mesh (research incubator, LAW-4)',
        inputs: { meta: META, buffer: BUFFER, reference: REFERENCE, stars_arrow: STARS_ARROW },
        image: { w: W, h: H, scale_arcsec_px: +(Math.sqrt(Math.abs(det)) * 3600).toFixed(3), sigma_pix: +sigmaPix.toFixed(4) },
        catalog: { g15u_in_frame: inFrame.length, appended_anchors: appended, total: catalog.length, cone_radius_deg: +coneR.toFixed(2), mag_limit: MAG_LIMIT },
        seed: { mode: SEED_MODE, n: finalSeed.length },
        cascade: { params: usedP, wall_ms: cascadeMs, rounds: iterations.length, iterations, matched_total: all.length, mesh_added: meshOnly.length, multiplication_x: multiplication },
        scoring_vs_reference: scoring ? { ...scoring, rows: undefined } : null,
        full_field_bc_truth: bcTruth,
        prediction_error_vs_reference_by_radius: radialDiag,
        prediction_error_note: 'affine-pred and linear-pred errors are BOTH distances to the nearest independent reference star; in-coverage only. affine < linear = local geometry absorbing distortion.',
        mesh_reach_r_norm_max: meshOnly.length ? +Math.max(...meshOnly.map((m) => m.r_norm)).toFixed(3) : null,
        seed_reach_r_norm_max: finalSeed.length ? +Math.max(...all.filter((m) => m.source === 'seed').map((m) => m.r_norm)).toFixed(3) : null,
        overlay_png: pngPath,
        wall_total_ms: Date.now() - t0,
        provenance_notes: [
            'All mesh matches are CATALOG_FORCED forced-photometry verifications at LOCAL-AFFINE-predicted positions; NEVER blind discoveries and NEVER used to feed a solve.',
            'The cascade NEVER consults the global WCS for prediction — only the seed anchors tie it to image space; the WCS appears only as the affine-vs-linear diagnostic baseline.',
            'The iterbc reference is itself forced-harvest (no shape gate) and center-cropped (r_norm<~0.5); uncorroborated matches beyond that radius are unchecked, not false.',
        ],
    };
    const jsonPath = path.join(OUT_DIR, `${FRAME}_mesh_summary.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    // full per-match rows (for eyes-on / follow-up), separate file
    fs.writeFileSync(path.join(OUT_DIR, `${FRAME}_mesh_matches.json`), JSON.stringify({ frame: FRAME, matches: all }, null, 2));
    console.log(`[${FRAME}] summary -> ${jsonPath}  (total ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return 0;
}
main().then((c) => setTimeout(() => process.exit(c), 100)).catch((e) => { console.error('FATAL:', (e && e.stack) || e); process.exit(1); });
