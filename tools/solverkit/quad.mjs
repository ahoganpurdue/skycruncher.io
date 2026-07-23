// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — GENERATOR: WASM GEOMETRIC QUAD-HASH MATCHER
// ═══════════════════════════════════════════════════════════════════════════
// Scale/rotation-invariant 4-star quad-hash correspondence via the LIVE Rust
// kernel `solve_planar_local` (same call as tools/repro/find_true_wcs.mjs and
// the app's quad path). Given detections + a catalog region about a center, it
// returns det<->catalog quad correspondences; we fit a WCS from the best quad's
// inliers (reusing common.fitAffine) and hand it on as a CandidateWCS.
//
// SCOPE (honest): quad hashing needs the SAME stars to appear in both the
// detection quad pool and the catalog quad pool. On ultra-wide DSLR frames the
// bright catalog (mag<6) and the faint compact detections barely overlap, so
// the quad path is "structurally starved" there (solver_entry.ts:707-712) — it
// is the generator for NARROW / FITS fields with a roughly-known center, where
// the anchored sweep has no single bright anchor to pin. Different tool, different
// regime; the driver picks per frame.
//
// Contract: GENERATOR (contract.mjs).

import {
    loadWasm, loadDetections, loadCatalog, tanForward, fitAffine, affineToWcs,
    cdMetrics, isMain, fmt,
} from './common.mjs';

/**
 * @param frame {det, width, height}
 * @param opts  {centers:[{raDeg,decDeg,name}], radiusDeg, magLimit, maxDet,
 *               maxCat, tolerances, inlierArcsec}
 * Returns ranked CandidateWCS[] (one best per center that produced a fit).
 */
export async function generateQuad(frame, opts = {}) {
    const w = await loadWasm();
    const det = [...frame.det].sort((a, b) => b.flux - a.flux).slice(0, opts.maxDet ?? 60);
    const centers = opts.centers ?? [];
    const radiusDeg = opts.radiusDeg ?? 5;
    const magLimit = opts.magLimit ?? 11;
    const tolerances = new Float64Array(opts.tolerances ?? [0.003, 0.006, 0.01, 0.02]);
    const inlierArcsec = opts.inlierArcsec ?? 15;
    const out = [];

    for (const c of centers) {
        const { stars } = loadCatalog({ raDeg: c.raDeg, decDeg: c.decDeg, radiusDeg, magLimit });
        // project catalog into the tangent plane about the center; arcsec plane
        // (x=xi*3600, y=-eta*3600) — y flipped to match the solver convention.
        const cat = [];
        for (const s of stars) {
            const t = tanForward(s.ra_deg, s.dec_deg, c.raDeg, c.decDeg);
            if (!t) continue;
            cat.push({ x: t.xi * 3600, y: -t.eta * 3600, ra_deg: s.ra_deg, dec_deg: s.dec_deg, mag: s.mag });
        }
        cat.sort((a, b) => a.mag - b.mag);
        const catN = cat.slice(0, opts.maxCat ?? 80);
        if (catN.length < 8 || det.length < 8) continue;

        const F = (arr) => new Float64Array(arr);
        const res = w.solve_planar_local(
            F(det.map((p) => p.x)), F(det.map((p) => p.y)), F(det.map((_, i) => i)),
            F(catN.map((p) => p.x)), F(catN.map((p) => p.y)), F(catN.map((_, i) => i)),
            tolerances, 80, undefined,
        );
        if (!res || res.length === 0) continue;

        // pick the quad whose affine fit yields the most inliers over all dets
        let best = null;
        for (let i = 0; i < res.length; i += 9) {
            const dIdx = [res[i], res[i + 1], res[i + 2], res[i + 3]].map(Number);
            const cIdx = [res[i + 4], res[i + 5], res[i + 6], res[i + 7]].map(Number);
            const corr = dIdx.map((k, q) => {
                const dp = det[k], cs = catN[cIdx[q]];
                const t = tanForward(cs.ra_deg, cs.dec_deg, c.raDeg, c.decDeg);
                return t ? { x: dp.x, y: dp.y, xi: t.xi, eta: t.eta } : null;
            }).filter(Boolean);
            if (corr.length < 3) continue;
            const fit = fitAffine(corr);
            if (!fit) continue;
            const wcs = affineToWcs(fit, [c.raDeg, c.decDeg]);
            if (!wcs) continue;
            const { scale } = cdMetrics(wcs.cd);
            const degPerPx = scale / 3600;
            const tolDeg = inlierArcsec / 3600;
            // count inliers over all detections via the fitted affine
            let inl = 0;
            for (const dp of det) {
                const pxi = fit.a[0] * dp.x + fit.a[1] * dp.y + fit.a[2];
                const peta = fit.b[0] * dp.x + fit.b[1] * dp.y + fit.b[2];
                let md = Infinity;
                for (const cs of catN) {
                    const dd = Math.hypot(pxi - cs.x / 3600, peta - (-cs.y / 3600));
                    if (dd < md) md = dd;
                }
                if (md < tolDeg) inl++;
            }
            if (!best || inl > best.inl) best = { wcs, inl, quadErr: res[i + 8], scale };
        }
        if (best && best.inl >= 4) {
            out.push({
                wcs: best.wcs, source: 'quad',
                evidence: {
                    inliers: best.inl, quadError: +best.quadErr.toExponential(2), scale: +best.scale.toFixed(3),
                    candidates: res.length / 9, center: c.name, centerRaDeg: c.raDeg, centerDecDeg: c.decDeg,
                },
            });
        }
    }
    out.sort((a, b) => b.evidence.inliers - a.evidence.inliers);
    return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
    const name = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'sample_observation';
    const f = loadDetections(name);
    const centers = (f.planets || []).map((p) => ({ raDeg: p.ra_hours * 15, decDeg: p.dec_degrees, name: p.name }));
    console.log(`[quad] ${f.name} ${f.width}x${f.height}  centers=${centers.length}`);
    const cands = await generateQuad(f, { centers, radiusDeg: 50, magLimit: 6 });
    if (!cands.length) { console.log('[quad] NO quad correspondence found — honest empty result (expected on starved UW fields).'); return; }
    for (const c of cands.slice(0, 6)) {
        const { scale, rotation } = cdMetrics(c.wcs.cd);
        console.log(`  inliers=${c.evidence.inliers} quadErr=${c.evidence.quadError} center=${c.evidence.center} ` +
            `crval=[${fmt(c.wcs.crval[0], 2)},${fmt(c.wcs.crval[1], 2)}] scale=${fmt(scale, 2)}"/px rot=${fmt(rotation, 1)}`);
    }
}
if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
