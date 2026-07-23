/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASDF LANE — pure headless sink + conformance fixture (LAW 4: tools/ lane)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The byte production lives in the SHARED serializer
 * `src/engine/pipeline/export/asdf_writer.ts` (desktop + browser use the exact
 * same function). This module is the thin fs.writeFileSync sink + the
 * asset-free conformance fixture the Python gate validates
 * (tools/asdf/conformance_check.py).
 *
 * IMPORTANT: this file imports ONLY the pure serializer (no engine/wasm), so it
 * runs under plain `tsx` for the conformance gate. The REAL wizard-pipeline
 * driver (which pulls in the engine + wasm and must run under the vitest
 * harness) lives in the sibling `run_pipeline_export.ts`.
 *
 * CLI: tsx tools/asdf/export_asdf.ts --fixture <out.asdf>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeAsdf, type AsdfImage } from '../../src/engine/pipeline/export/asdf_writer';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read the shipped library version (asdf_library.version) from package.json. */
export function libraryVersion(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
}

/** Thin sink: serialize `receipt` + `image` and write the ASDF bytes to disk. */
export function writeAsdfFile(receipt: any, image: AsdfImage, outPath: string): void {
    const bytes = serializeAsdf(receipt, image, { libraryVersion: libraryVersion() });
    fs.writeFileSync(outPath, bytes);
}

// ─── conformance fixture (asset-free) ─────────────────────────────────────────

export const FIXTURE_WIDTH = 8;
export const FIXTURE_HEIGHT = 6;

// A deliberately non-trivial CD: scale × rotation(20°) × x-reflection (negative
// determinant → a parity flip). Off-diagonal terms + a mirror mean an axis
// swap, a CD transpose, or a sign error in the GWCS chain would all surface as
// a large fidelity residual (a pure diagonal CD would hide a transpose bug).
const FIX_SCALE = 1.021e-3;              // deg/px
const FIX_THETA = 20 * Math.PI / 180;    // rotation
const FIX_CD11 = -FIX_SCALE * Math.cos(FIX_THETA);
const FIX_CD12 = FIX_SCALE * Math.sin(FIX_THETA);
const FIX_CD21 = FIX_SCALE * Math.sin(FIX_THETA);
const FIX_CD22 = FIX_SCALE * Math.cos(FIX_THETA);

/**
 * A deterministic, asset-free receipt + image mirroring the real receipt's
 * shape (solution/wcs/matched_stars/warnings/timestamp_trusted…). The image is
 * a known uint16 ramp (value = i*257 & 0xffff) so the Python gate can assert
 * exact pixel round-trip. `withSip` appends a live-shaped fitted SIP A/B so the
 * fidelity gate can exercise the polynomial node (phase 2); absent by default
 * (a well-corrected optic → honest-absent, linear-only).
 */
export function buildFixtureAsdf(opts: { withSip?: boolean; withTps?: boolean } = {}): { receipt: any; image: AsdfImage } {
    const data = new Uint16Array(FIXTURE_WIDTH * FIXTURE_HEIGHT);
    for (let i = 0; i < data.length; i++) data[i] = (i * 257) & 0xffff;

    // A small but non-degenerate SIP (order 2) — mirrors the fitted-A/B shape
    // (coeff[p][q] = coefficient of u^p v^q). Values chosen small so the
    // distortion stays within the frame yet is far above the sub-arcsec gate.
    const sip = opts.withSip ? {
        a_order: 2, b_order: 2,
        a: [[0, 0, 3.0e-5], [0, 1.5e-5, 0], [-2.0e-5, 0, 0]],
        b: [[0, 0, -2.5e-5], [1.2e-5, 0, 0], [4.0e-6, 0, 0]],
    } : undefined;

    // A small but non-degenerate synthetic TPS (a NON-polynomial spline the ASDF
    // writer carries as a tabular lookup). Control coords are NORMALIZED (ũ,ṽ =
    // (pixel−crpix)/scale); weights_x sum to 0 (a well-formed spline term) and are
    // paired with a non-trivial affine plane so the fidelity gate exercises BOTH
    // the kernel path AND the affine part. The gate re-evaluates this identical f
    // analytically and compares to the baked tabular at the grid nodes — physical
    // fit quality is proven separately by the fitter unit tests + the CR2 evidence.
    const tps = opts.withTps ? {
        lambda: 1e-3,
        scale: 4.0,
        crpix: [4, 3],
        control_points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.0, 0.0]],
        weights_x: [0.010, -0.020, 0.015, -0.005, 0.0],   // Σ = 0
        weights_y: [-0.010, 0.005, 0.010, -0.005, 0.0],   // Σ = 0
        affine: { dx: [0.30, 0.10, -0.05], dy: [-0.20, 0.04, 0.08] },
        rms_before_arcsec: 3.0,
        rms_after_arcsec: 0.2,
        control_count: 5,
    } : undefined;

    const receipt = {
        version: '2.2.0',
        solution: {
            ra_hours: 11.341253475172621,
            dec_degrees: -22.4,
            pixel_scale: 3.6776147325019153,
            spatial_hash: opts.withTps ? 'fixtureTPS1' : opts.withSip ? 'fixtureSIP1' : 'fixture0001',
            stars_matched: 2,
            matched_stars: [
                { gaia_id: 'G1', ra_deg: 170.1, dec_deg: -22.4, mag: 8.2, x: 1.5, y: 2.5, flux: 1000, fwhm: 2.1, residual_arcsec: 0.4 },
                { gaia_id: 'G2', ra_deg: 170.2, dec_deg: -22.3, mag: 9.1, x: 5.5, y: 3.5, flux: 800, fwhm: 2.0, residual_arcsec: 0.5 },
            ],
            astrometry: {
                rms_arcsec: 0.45,
                distortion_detected: !!(opts.withSip || opts.withTps),
                ...(sip ? { sip } : {}),
                ...(tps ? { tps } : {}),
            },
        },
        wcs: {
            CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
            CRPIX1: 4, CRPIX2: 3,
            CRVAL1: 170.1188, CRVAL2: -22.4,
            CD1_1: FIX_CD11, CD1_2: FIX_CD12, CD2_1: FIX_CD21, CD2_2: FIX_CD22,
            EQUINOX: 2000.0, RADESYS: 'ICRS', SOURCE: 'FITTED',
        },
        planets: [],
        psf_field: null,
        deep_confirmed: null,
        warnings: ['fixture: synthetic — no real capture'],
        timestamp_trusted: false,
        export_date: '2026-07-07T00:00:00.000Z',
    };
    return { receipt, image: { data, width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, channels: 1 } };
}

/** Write the conformance fixture; returns the metadata the Python gate asserts. */
export function writeFixture(outPath: string, opts: { withSip?: boolean; withTps?: boolean } = {}): { shape: number[]; datatype: string } {
    const { receipt, image } = buildFixtureAsdf(opts);
    writeAsdfFile(receipt, image, outPath);
    return { shape: [FIXTURE_HEIGHT, FIXTURE_WIDTH], datatype: 'uint16' };
}

// ─── thin CLI ─────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const args = process.argv.slice(2);
    if (args[0] === '--fixture') {
        const out = args[1] ?? path.join(REPO_ROOT, 'test_results', 'asdf_fixture.asdf');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const meta = writeFixture(out);
        console.log(`[asdf] wrote conformance fixture ${out} shape=[${meta.shape.join(',')}] datatype=${meta.datatype}`);
    } else {
        console.error('usage: export_asdf.ts --fixture <out.asdf>');
        console.error('(real FITS-pipeline export lives in run_pipeline_export.ts — runs under the vitest harness)');
        process.exit(2);
    }
}
