/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FITS LANE — pure headless sink + conformance-fixture helpers (LAW 4: tools/)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The byte production lives in the SHARED serializer
 * `src/engine/pipeline/export/fits_writer.ts` (desktop + browser use the exact
 * same function). This module is the thin fs.writeFileSync sink + the PURE
 * fixture helpers. Imports ONLY the pure serializer (no engine/wasm) so it runs
 * under plain `tsx`. Mirrors tools/asdf/export_asdf.ts.
 *
 * The REAL-DATA conformance fixtures (M66) need the engine's authoritative
 * pixel→sky (SkyTransform.pixelToSky → wasm) as the truth reference, so they are
 * built by the sibling `build_conformance_fixtures.runspec.ts` under the vitest
 * harness (mirrors tools/asdf/run_pipeline_export.ts) — that driver imports these
 * pure helpers and injects the wasm-backed sky function.
 *
 * CLI:  tsx tools/fits/export_fits.ts --ramp <out.fits>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeFits, type FitsImage } from '../../src/engine/pipeline/export/fits_writer';
import { toFitsSip } from '../../src/engine/pipeline/export/sip_convention';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read the shipped library version (package.json) for the ORIGIN provenance card. */
export function libraryVersion(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
}

/** Thin sink: serialize `receipt` + `image` and write the FITS bytes to disk. */
export function writeFitsFile(receipt: any, image: FitsImage, outPath: string): void {
    const bytes = serializeFits(receipt, image, { libraryVersion: libraryVersion() });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, bytes);
}

// ─── ramp fixture (asset-free) ────────────────────────────────────────────────

export const RAMP_W = 8;
export const RAMP_H = 6;

// A non-trivial CD: scale × rotation(20°) × x-reflection (negative determinant →
// a parity flip). Off-diagonal + mirror mean a CD transpose or a sign error would
// surface as a large residual (a pure diagonal CD would hide a transpose bug).
const R_SCALE = 1.021e-3;               // deg/px
const R_THETA = 20 * Math.PI / 180;
const RAMP_CD11 = -R_SCALE * Math.cos(R_THETA);
const RAMP_CD12 = R_SCALE * Math.sin(R_THETA);
const RAMP_CD21 = R_SCALE * Math.sin(R_THETA);
const RAMP_CD22 = R_SCALE * Math.cos(R_THETA);

/** A deterministic asset-free receipt + float32 ramp image (value = i). The
 * Python gate asserts the pixel bytes round-trip exactly and the CD parity sign. */
export function buildRampFixture(): { receipt: any; image: FitsImage } {
    const data = new Float32Array(RAMP_W * RAMP_H);
    for (let i = 0; i < data.length; i++) data[i] = i;    // exact-representable ramp
    const receipt = {
        version: '2.3.0',
        solution: { spatial_hash: 'ramp0001' },
        wcs: {
            CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
            CRPIX1: 4, CRPIX2: 3,               // engine 0-based
            CRVAL1: 170.1188, CRVAL2: -22.4,    // ALREADY degrees
            CD1_1: RAMP_CD11, CD1_2: RAMP_CD12, CD2_1: RAMP_CD21, CD2_2: RAMP_CD22,
            EQUINOX: 2000.0, RADESYS: 'ICRS', SOURCE: 'FITTED',
        },
    };
    return { receipt, image: { data, width: RAMP_W, height: RAMP_H, channels: 1 } };
}

// ─── M66-derived conformance-fixture helpers (pure; truth injected) ───────────

/** A synthetic, FITS-conventional order-2 SIP. coeff[p][q] = coefficient of
 * u^p v^q (raw pixel offsets). Magnitudes tuned so the max displacement over a
 * ~2000×3800 frame is a few pixels (≈10-15" at SeeStar scale) — clearly above the
 * gate tolerance, so a reader that IGNORES the SIP keywords fails loudly. This is
 * a KNOWN, self-constructed SIP (NOT the engine's fit): the gate proves the
 * writer SERIALIZES SIP correctly, not the engine's SIP-fit convention.
 *
 * These are the coefficients we want to SEE IN THE FILE (FITS convention, applied
 * as u' = u + A(u,v)). The writer negates receipt.sip to FITS convention
 * (sip_convention.ts), so buildSipFixture stores toFitsSip(SYNTH_SIP) =
 * −SYNTH_SIP as the receipt's (internal-convention) sip and the writer re-emits
 * exactly SYNTH_SIP — the displacement math below assumes the file carries
 * SYNTH_SIP. */
export const SYNTH_SIP = {
    a_order: 2, b_order: 2,
    a: [[0, 0, 6.0e-7], [0, 3.0e-7, 0], [1.0e-6, 0, 0]],
    b: [[0, 0, -8.0e-7], [4.0e-7, 0, 0], [-7.0e-7, 0, 0]],
};

/** Evaluate a SIP polynomial f(u,v) = Σ coeff[p][q] u^p v^q. */
export function evalSip(coeff: number[][], u: number, v: number): number {
    let s = 0;
    for (let p = 0; p < coeff.length; p++) {
        const row = coeff[p];
        if (!Array.isArray(row)) continue;
        for (let q = 0; q < row.length; q++) {
            const c = row[q];
            if (c) s += c * Math.pow(u, p) * Math.pow(v, q);
        }
    }
    return s;
}

export interface TruthStar { x: number; y: number; ra_deg: number; dec_deg: number; residual_arcsec: number; }
export interface TruthDoc {
    fixture_kind: 'linear' | 'sip';
    tol_arcsec: number;
    rms_arcsec: number | null;
    expected_cd_det_sign: number;
    matched_stars: TruthStar[];
}

/** Clean matched stars (drop planet sentinels + residual ≥ 999). */
export function cleanStars(receipt: any): any[] {
    return (receipt?.solution?.matched_stars ?? []).filter((m: any) =>
        Number.isFinite(m.residual_arcsec) && m.residual_arcsec < 999 &&
        !(m.gaia_id || '').startsWith('planet_'));
}

export function cdDetSign(wcs: any): number {
    return Math.sign(wcs.CD1_1 * wcs.CD2_2 - wcs.CD1_2 * wcs.CD2_1);
}

export function zeroImage(W: number, H: number): FitsImage {
    return { data: new Float32Array(W * H), width: W, height: H, channels: 1 };
}

/** `skyOf(x,y)` = the ENGINE's authoritative sky (deg) for a detected pixel
 * (SkyTransform.pixelToSky, injected by the wasm-backed runspec). */
export type SkyOf = (x: number, y: number) => { ra_deg: number; dec_deg: number };

/**
 * LINEAR fixture: strip SIP/TPS so the writer emits a plain-TAN linear WCS. Truth
 * ra/dec = the engine's OWN pixel→sky at each detected pixel (residual 0 by
 * construction) — astropy reading our FITS must reproduce it to sub-arcsec, which
 * proves two independent implementations of the SAME fitted WCS agree. */
export function buildLinearFixture(receipt: any, W: number, H: number, skyOf: SkyOf): { receipt: any; image: FitsImage; truth: TruthDoc } {
    const stars = cleanStars(receipt);
    const linReceipt = {
        ...receipt,
        solution: {
            ...receipt.solution,
            astrometry: receipt.solution?.astrometry
                ? { rms_arcsec: receipt.solution.astrometry.rms_arcsec, distortion_detected: false }
                : null,
        },
    };
    const truth: TruthDoc = {
        fixture_kind: 'linear',
        tol_arcsec: 0.05,
        rms_arcsec: receipt.solution?.astrometry?.rms_arcsec ?? null,
        expected_cd_det_sign: cdDetSign(receipt.wcs),
        matched_stars: stars.map(m => ({ x: m.x, y: m.y, ...skyOf(m.x, m.y), residual_arcsec: 0 })),
    };
    return { receipt: linReceipt, image: zeroImage(W, H), truth };
}

/**
 * SIP fixture: layer SYNTH_SIP on the real WCS and displace each star's detected
 * pixel by −f(u,v) so astropy, applying the SIP forward, recovers the ORIGINAL
 * linear mapping (= the engine's pixel→sky at the ORIGINAL pixel). A reader that
 * ignores the SIP keywords lands ~10-15" off → the gate fails loudly, proving the
 * writer's SIP cards are actually applied. Truth = displaced pixel + engine sky of
 * the ORIGINAL pixel. */
export function buildSipFixture(receipt: any, W: number, H: number, skyOf: SkyOf): { receipt: any; image: FitsImage; truth: TruthDoc } {
    const stars = cleanStars(receipt);
    const cx = receipt.wcs.CRPIX1, cy = receipt.wcs.CRPIX2;   // engine 0-based
    const sipReceipt = {
        ...receipt,
        solution: {
            ...receipt.solution,
            astrometry: {
                rms_arcsec: receipt.solution?.astrometry?.rms_arcsec ?? 3.0,
                distortion_detected: true,
                // Store the INTERNAL-convention form (−SYNTH_SIP) so the writer's
                // toFitsSip negation re-emits exactly SYNTH_SIP into the file — the
                // convention the displacement fixed-point below assumes.
                sip: toFitsSip(SYNTH_SIP),
            },
        },
    };
    const truth: TruthDoc = {
        fixture_kind: 'sip',
        tol_arcsec: 0.05,
        rms_arcsec: receipt.solution?.astrometry?.rms_arcsec ?? null,
        expected_cd_det_sign: cdDetSign(receipt.wcs),
        matched_stars: stars.map(m => {
            const u0 = m.x - cx, v0 = m.y - cy;
            // Solve for the detected offset (u,v) such that astropy's SIP forward
            // u + A(u,v) = u0 (v likewise) EXACTLY — a fixed-point inversion, so
            // astropy recovers the original linear pixel to machine precision
            // (removes the O(f²) error of a plain −f displacement). f is small →
            // converges in a few iterations.
            let u = u0, v = v0;
            for (let k = 0; k < 6; k++) {
                const un = u0 - evalSip(SYNTH_SIP.a, u, v);
                const vn = v0 - evalSip(SYNTH_SIP.b, u, v);
                u = un; v = vn;
            }
            return { x: u + cx, y: v + cy, ...skyOf(m.x, m.y), residual_arcsec: 0 };
        }),
    };
    return { receipt: sipReceipt, image: zeroImage(W, H), truth };
}

// ─── thin CLI (ramp only; M66 fixtures via the runspec) ───────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    const args = process.argv.slice(2);
    if (args[0] === '--ramp') {
        const out = args[1] ?? path.join(REPO_ROOT, 'test_results', 'fits_ramp.fits');
        const { receipt, image } = buildRampFixture();
        writeFitsFile(receipt, image, out);
        console.log(`[fits] wrote ramp fixture ${out} shape=[${RAMP_H},${RAMP_W}] datatype=float32`);
    } else {
        console.error('usage: export_fits.ts --ramp <out.fits>');
        console.error('(M66 conformance fixtures need the engine forward — see build_conformance_fixtures.runspec.ts)');
        process.exit(2);
    }
}
