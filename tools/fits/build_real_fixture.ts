/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REAL-ENGINE SIP/TPS CONFORMANCE FIXTURE — the sign-adjudicating acceptance case
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The synthetic fixtures (m66_linear / m66_sip, buildSipFixture) are BUILT with a
 * self-constructed FITS-conventional SIP, so they can prove the writer SERIALIZES
 * SIP but are BLIND to the engine's own fit-sign convention (they never touch the
 * engine's stored coefficients). This fixture closes that hole: it exports the
 * REAL engine SIP (order-3) + TPS (the live receipt.solution.astrometry blocks)
 * and a CATALOG-truth sidecar (the independent star-catalog cross-match ra/dec,
 * NOT engine-sky), so the Python conformance can measure the astropy-APPLIED
 * catalog residual and prove the distortion IMPROVES it vs a linear WCS — the only
 * check that adjudicates the SIP/TPS export SIGN (sip_convention.ts).
 *
 * PURE (no wasm): the truth is the catalog positions already on the receipt, so
 * this runs under plain `tsx` — no engine-sky reprojection needed.
 *
 *   npx tsx tools/fits/build_real_fixture.ts [<receipt.json>] [<out-dir>]
 *
 * Validate the outputs under WSL:
 *   python3 tools/fits/conformance_check.py  <dir>/m66_real.fits --catalog-truth <dir>/m66_real.stars.json
 *   python3 tools/asdf/conformance_check.py  <dir>/m66_real.asdf --catalog-truth <dir>/m66_real.stars.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeFits } from '../../src/engine/pipeline/export/fits_writer';
import { serializeAsdf } from '../../src/engine/pipeline/export/asdf_writer';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function libraryVersion(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
}

export const DEFAULT_RECEIPT = path.join(
    REPO_ROOT, 'test_results', 'api_runs',
    'DSO_Stacked_738_M 66_60.0s_20260516_064736.receipt.json',
);

export interface RealFixtureResult { fitsOut: string; asdfOut: string; truthOut: string; nStars: number; }

/** Deep-negate every finite number in a matrix/array (in place is avoided — pure). */
function negTree(m: any): any {
    return Array.isArray(m) ? m.map(negTree)
        : (typeof m === 'number' && Number.isFinite(m) ? -m : m);
}

/**
 * Export the REAL-engine SIP/TPS fixture (FITS + ASDF + catalog-truth sidecar) from
 * a solved receipt. `wrongSign` (negative control) pre-negates the stored SIP/TPS
 * coefficients so the export's correct negation re-emits the OLD pre-fix sign — the
 * conformance MUST then fail. Pure (no wasm): the truth is the catalog cross-match
 * already on the receipt.
 */
export function buildRealFixture(receiptPath: string, outDir: string, opts: { wrongSign?: boolean } = {}): RealFixtureResult {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt?.wcs?.SOURCE !== 'FITTED') throw new Error('receipt has no FITTED WCS — cannot export.');

    const W = receipt.metadata?.width | 0;
    const H = receipt.metadata?.height | 0;
    if (!(W > 0) || !(H > 0)) throw new Error(`bad frame dims ${W}x${H} in receipt.metadata.`);

    if (opts.wrongSign) {
        const s = receipt.solution?.astrometry?.sip;
        if (s) { s.a = negTree(s.a); s.b = negTree(s.b); }
        const t = receipt.solution?.astrometry?.tps;
        if (t) {
            t.weights_x = negTree(t.weights_x); t.weights_y = negTree(t.weights_y);
            if (t.affine) { t.affine.dx = negTree(t.affine.dx); t.affine.dy = negTree(t.affine.dy); }
        }
        console.log('[real-fixture] *** WRONG-SIGN negative control: conformance MUST fail ***');
    }

    const sip = receipt.solution?.astrometry?.sip;
    const tps = receipt.solution?.astrometry?.tps;
    const hasSip = !!(sip && Array.isArray(sip.a));
    const hasTps = !!(tps && Array.isArray(tps.control_points));

    // Catalog truth: matched stars carry ra_deg/dec_deg = the star-catalog cross-
    // match (INDEPENDENT of the WCS) + x/y = detected pixel + the solver's LINEAR
    // residual. Drop planet sentinels + residual>=999 flags.
    const stars = (receipt.solution?.matched_stars ?? []).filter((m: any) =>
        Number.isFinite(m.residual_arcsec) && m.residual_arcsec < 999 &&
        !((m.gaia_id ?? '') as string).startsWith('planet_'));

    const truth = {
        fixture_kind: 'real_catalog',
        width: W, height: H,
        expected_cd_det_sign: Math.sign(
            receipt.wcs.CD1_1 * receipt.wcs.CD2_2 - receipt.wcs.CD1_2 * receipt.wcs.CD2_1),
        solver_linear_rms_arcsec: receipt.solution?.astrometry?.rms_arcsec ?? null,
        matched_stars: stars.map((m: any) => ({
            x: m.x, y: m.y, ra_deg: m.ra_deg, dec_deg: m.dec_deg, residual_arcsec: m.residual_arcsec,
        })),
    };

    fs.mkdirSync(outDir, { recursive: true });
    // A zero frame at the REAL dims — pixels are irrelevant to the WCS, but the ASDF
    // TPS tabular grid spans [0,width]×[0,height], so the dims MUST be the real frame.
    const image = { data: new Float32Array(W * H), width: W, height: H, channels: 1 as const };
    const fitsBytes = serializeFits(receipt, image, { libraryVersion: libraryVersion() });
    const asdfBytes = serializeAsdf(receipt, image, { libraryVersion: libraryVersion() });

    const fitsOut = path.join(outDir, 'm66_real.fits');
    const asdfOut = path.join(outDir, 'm66_real.asdf');
    const truthOut = path.join(outDir, 'm66_real.stars.json');
    fs.writeFileSync(fitsOut, fitsBytes);
    fs.writeFileSync(asdfOut, asdfBytes);
    fs.writeFileSync(truthOut, JSON.stringify(truth));

    console.log(`[real-fixture] receipt: ${path.relative(REPO_ROOT, receiptPath)}`);
    console.log(`[real-fixture] frame ${W}x${H}, ${truth.matched_stars.length} catalog stars, ` +
        `SIP=${hasSip ? `order-${sip.a_order}` : 'absent'}, TPS=${hasTps ? `${tps.control_count}pt` : 'absent'}, ` +
        `solver linear rms=${truth.solver_linear_rms_arcsec?.toFixed(3)}"`);
    console.log(`[real-fixture] wrote:\n  ${path.relative(REPO_ROOT, fitsOut)}\n  ${path.relative(REPO_ROOT, asdfOut)}\n  ${path.relative(REPO_ROOT, truthOut)}`);
    return { fitsOut, asdfOut, truthOut, nStars: truth.matched_stars.length };
}

// ─── thin CLI ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const rawArgs = process.argv.slice(2);
    // --wrong-sign: NEGATIVE CONTROL (pre-negate → export re-emits the pre-fix bug).
    const wrongSign = rawArgs.includes('--wrong-sign');
    const args = rawArgs.filter(a => a !== '--wrong-sign');
    const receiptPath = args[0] ? path.resolve(args[0]) : DEFAULT_RECEIPT;
    const outDir = args[1] ? path.resolve(args[1])
        : path.join(REPO_ROOT, 'test_results', wrongSign ? 'conformance_real_wrong' : 'conformance_real');
    if (!fs.existsSync(receiptPath)) {
        console.error(`[real-fixture] receipt not found: ${receiptPath}`);
        console.error('  produce one:  node tools/api/run.mjs "Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit"');
        process.exit(2);
    }
    try { buildRealFixture(receiptPath, outDir, { wrongSign }); }
    catch (e: any) { console.error(`[real-fixture] ${e?.message ?? e}`); process.exit(2); }
}
