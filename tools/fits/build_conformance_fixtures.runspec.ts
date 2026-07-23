/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FITS LANE — build the M66 conformance fixtures with the ENGINE forward as truth
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The FITS conformance gate proves that astropy reading our exported `.fits`
 * reproduces the engine's OWN pixel→sky mapping (two independent implementations
 * of the SAME fitted WCS agree — the ASDF-fidelity approach, ported to FITS).
 * The engine forward is `SkyTransform.pixelToSky` (→ wasm inverse-gnomonic), so
 * this generator MUST run under the vitest harness (real wasm), NOT plain tsx —
 * mirrors tools/asdf/run_pipeline_export.ts.
 *
 * It reads a REAL solved receipt (default: the bundled M66 headless dump), builds
 * the engine WCS from receipt.wcs (CRVAL1/15 → hours; crpix 0-based verbatim; CD
 * verbatim), computes the engine sky at every matched-star pixel, and writes:
 *   test_results/fits_fixtures/m66_linear.fits + .stars.json   (plain TAN)
 *   test_results/fits_fixtures/m66_sip.fits    + .stars.json   (synthetic SIP)
 *
 * Run: npx vitest run -c tools/fits/fits_export.config.ts
 * (validate the outputs with tools/fits/conformance_check.py under WSL.)
 *
 * SCOPE NOTE — these synthetic fixtures prove the writer SERIALIZES SIP, but the
 * SIP here is self-constructed (FITS-convention by hand), so they cannot adjudicate
 * the engine's fit-SIGN convention. The companion `tools/fits/run_real_conformance.ts`
 * exports the REAL engine SIP/TPS + a catalog-truth sidecar and proves the applied
 * distortion IMPROVES the catalog residual — that is the standing SIGN gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { SkyTransform } from '@/engine/core/SkyTransform';
import type { WCSTransform } from '@/engine/types/Main_types';
import { bootRealWasm } from '../api/headless_driver';
import { writeFitsFile, buildLinearFixture, buildSipFixture, type SkyOf } from './export_fits';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECEIPT = process.env.FITS_RECEIPT
    ?? path.join(REPO_ROOT, 'test_results', 'api_runs', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.receipt.json');
const OUT_DIR = process.env.FITS_FIXTURE_DIR
    ?? path.join(REPO_ROOT, 'test_results', 'fits_fixtures');

/** Reconstruct the engine-convention WCS from the FITS-convention receipt.wcs.
 * receipt.wcs: CRVAL1 = deg (= hours×15), CRPIX = engine 0-based, CD = deg/px. */
function engineWcs(wcs: any): WCSTransform {
    return {
        crpix: [wcs.CRPIX1, wcs.CRPIX2],
        crval: [wcs.CRVAL1 / 15, wcs.CRVAL2],           // deg → hours for the engine
        cd: [[wcs.CD1_1, wcs.CD1_2], [wcs.CD2_1, wcs.CD2_2]],
    } as WCSTransform;
}

describe('FITS conformance fixtures (engine-forward truth)', () => {
    it('writes m66_linear + m66_sip fixtures from the real receipt', () => {
        bootRealWasm();   // real compiled wasm (inverse-gnomonic); idempotent
        expect(fs.existsSync(RECEIPT)).toBe(true);
        const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
        expect(receipt?.wcs?.SOURCE).toBe('FITTED');

        const W = receipt.metadata?.width | 0;
        const H = receipt.metadata?.height | 0;
        expect(W).toBeGreaterThan(0);
        expect(H).toBeGreaterThan(0);

        const wcs = engineWcs(receipt.wcs);
        // The authoritative engine pixel→sky (wasm inverse-gnomonic), degrees out.
        const skyOf: SkyOf = (x, y) => {
            const s = SkyTransform.pixelToSky(x, y, wcs);
            return { ra_deg: s.ra_hours * 15, dec_deg: s.dec_degrees };
        };

        fs.mkdirSync(OUT_DIR, { recursive: true });
        const lin = buildLinearFixture(receipt, W, H, skyOf);
        const sip = buildSipFixture(receipt, W, H, skyOf);

        writeFitsFile(lin.receipt, lin.image, path.join(OUT_DIR, 'm66_linear.fits'));
        writeFitsFile(sip.receipt, sip.image, path.join(OUT_DIR, 'm66_sip.fits'));
        fs.writeFileSync(path.join(OUT_DIR, 'm66_linear.stars.json'), JSON.stringify(lin.truth));
        fs.writeFileSync(path.join(OUT_DIR, 'm66_sip.stars.json'), JSON.stringify(sip.truth));

        expect(lin.truth.matched_stars.length).toBeGreaterThan(50);
        expect(sip.truth.matched_stars.length).toBe(lin.truth.matched_stars.length);
        // eslint-disable-next-line no-console
        console.log(`[fits-fixtures] wrote ${lin.truth.matched_stars.length}-star linear + SIP fixtures to ${OUT_DIR}`);
    });
});
