// ═══════════════════════════════════════════════════════════════════════════
// MEASURED EVIDENCE — TPS distortion fit on the REAL bundled CR2 pairs
// ═══════════════════════════════════════════════════════════════════════════
//
//   CR2_ASTROMETRY_DIR="<...>/test_results/psf" \
//     npx vitest run -c tools/dslr/uw_harness.config.ts tools/dslr/tps_ab.uwspec.ts
//
// Drives the PORTED engine fit-core (m6_plate_solve/tps_fitter.fitTpsCore) with the
// REAL measured pair data of the bundled beach CR2 (RA 17.5858h / 63.211"/px / 55
// matched — the sacred blind solve) — the SAME fixture the BC-refit A/B rig uses.
//
//   FIXTURE (astrometry_beach_cr2_cubic_only.json): the receipt's 55 SOLVER-
//   VERIFIED pairs — controlPoints {x,y = undistorted rectilinear projection,
//   dx,dy = measured displacement}. Build the TPS input directly: the detected
//   pixel is (x+dx, y+dy); the pixel-offset is (detected − crpix); dx/dy are the
//   residuals the spline models. Fixtures are LOCAL-ONLY (test_results/ is
//   gitignored) — this spec SKIPS honestly when absent.
//
// Reports TPS rms_before → rms_after AND, on the SAME pairs, an order-2/3
// polynomial (SIP-analog) rms_after as the apples-to-apples yardstick. This is a
// COORDINATE-ledger OBSERVATION — nothing here touches solve/verify/acceptance.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fitTpsCore, type TpsPair } from '../../src/engine/pipeline/m6_plate_solve/tps_fitter';

const FIXTURE_DIR = process.env.CR2_ASTROMETRY_DIR
    ?? path.resolve(process.cwd(), 'test_results', 'psf');
// The sacred 55 SOLVER-VERIFIED pairs (clustered center-selection) …
const CUBIC_PATH = path.join(FIXTURE_DIR, 'astrometry_beach_cr2_cubic_only.json');
// … and the research lane's 237 densified pairs (forced re-detection — the
// frame-wide coverage the sacred selection lacks).
const REFIT_PATH = path.join(FIXTURE_DIR, 'astrometry_beach_cr2.json');
const HAVE = fs.existsSync(CUBIC_PATH) && fs.existsSync(REFIT_PATH);

interface ControlPoint { x: number; y: number; dx: number; dy: number; }

function loadPairs(file: string): { pairs: TpsPair[]; cx: number; cy: number; pxScale: number } {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [w, h] = doc.provenance.image_dims as [number, number];
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const pxScale = doc.provenance.solution.pixel_scale as number;
    const cps = doc.distortion.controlPoints as ControlPoint[];
    const pairs: TpsPair[] = cps.map((c) => ({ u: (c.x + c.dx) - cx, v: (c.y + c.dy) - cy, dx: c.dx, dy: c.dy }));
    return { pairs, cx, cy, pxScale };
}

/** Solve A·x = b (partial pivoting); null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
    const n = b.length;
    for (let c = 0; c < n; c++) {
        let piv = c, max = Math.abs(A[c][c]);
        for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r][c]); if (v > max) { max = v; piv = r; } }
        if (max < 1e-12) return null;
        if (piv !== c) { [A[piv], A[c]] = [A[c], A[piv]]; [b[piv], b[c]] = [b[c], b[piv]]; }
        for (let r = c + 1; r < n; r++) {
            const f = A[r][c] / A[c][c];
            for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
    return x;
}

/** Per-point residuals of a full 2-D polynomial (all p+q ≤ order) LS fit of `d`
 *  over normalized (un,vn) — the SIP-analog yardstick (constant+linear+higher,
 *  matching what TPS's affine+spline together span). */
function polyResiduals(un: number[], vn: number[], d: number[], order: number): number[] {
    const terms: Array<[number, number]> = [];
    for (let p = 0; p <= order; p++) for (let q = 0; q <= order - p; q++) terms.push([p, q]);
    const m = terms.length, n = un.length;
    const basis = (i: number, t: number) => Math.pow(un[i], terms[t][0]) * Math.pow(vn[i], terms[t][1]);
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    for (let a = 0; a < m; a++) {
        for (let c = 0; c < m; c++) { let s = 0; for (let i = 0; i < n; i++) s += basis(i, a) * basis(i, c); A[a][c] = s; }
        let s = 0; for (let i = 0; i < n; i++) s += basis(i, a) * d[i]; b[a] = s;
    }
    const coef = solve(A, b) ?? new Array(m).fill(0);
    return un.map((_, i) => { let f = 0; for (let t = 0; t < m; t++) f += coef[t] * basis(i, t); return d[i] - f; });
}

function combinedRmsPx(resX: number[], resY: number[]): number {
    let s = 0; for (let i = 0; i < resX.length; i++) s += resX[i] * resX[i] + resY[i] * resY[i];
    return Math.sqrt(s / resX.length);
}

describe.skipIf(!HAVE)('TPS on the REAL bundled CR2 pairs (measured evidence)', () => {
    it('HONESTLY REFUSES the clustered sacred-55 selection (octant coverage gate)', () => {
        // The sacred 55-star match is a center-selection: 31 of 55 fall in ONE
        // octant, only 4/8 octants hold ≥3 — too lopsided for a 2-D spline. The
        // coverage gate returns null (honest-absent), NOT a wild extrapolation.
        const { pairs, cx, cy, pxScale } = loadPairs(CUBIC_PATH);
        expect(pairs.length).toBe(55);
        const tps = fitTpsCore(pairs, pxScale, [cx, cy]);
        expect(tps, 'clustered 55-star selection must be refused (octant gate)').toBeNull();
        console.log('[tps-cr2] sacred-55 selection → HONEST-ABSENT (octant coverage 4/8 < 5)');
    });

    it('FITS the densified 237-pair CR2 set, reduces RMS, reports vs SIP-analog', () => {
        const { pairs, cx, cy, pxScale } = loadPairs(REFIT_PATH);
        const tps = fitTpsCore(pairs, pxScale, [cx, cy]);
        expect(tps, 'densified 237-pair set has the frame-wide coverage TPS needs').toBeTruthy();
        if (!tps) return;

        // SIP-analog yardstick on the SAME pairs (normalized by tps.scale so the
        // polynomial and the spline see identical coordinates).
        const un = pairs.map((p) => p.u / tps.scale);
        const vn = pairs.map((p) => p.v / tps.scale);
        const dx = pairs.map((p) => p.dx), dy = pairs.map((p) => p.dy);
        const sip2 = combinedRmsPx(polyResiduals(un, vn, dx, 2), polyResiduals(un, vn, dy, 2)) * pxScale;
        const sip3 = combinedRmsPx(polyResiduals(un, vn, dx, 3), polyResiduals(un, vn, dy, 3)) * pxScale;

        console.log('╔══ TPS on the REAL bundled CR2 (densified 237-pair set) ════');
        console.log(`║ λ=${tps.lambda}  control_count=${tps.control_count}  scale=${tps.scale.toFixed(1)}px`);
        console.log(`║ rms_before        = ${tps.rms_before_arcsec.toFixed(3)}"`);
        console.log(`║ rms_after  (TPS)  = ${tps.rms_after_arcsec.toFixed(3)}"`);
        console.log(`║ rms_after  (SIP order-2 analog) = ${sip2.toFixed(3)}"`);
        console.log(`║ rms_after  (SIP order-3 analog) = ${sip3.toFixed(3)}"`);
        console.log('╚═══════════════════════════════════════════════════════════');

        // The spline explains the residual field (never worse than raw).
        expect(tps.rms_after_arcsec).toBeLessThan(tps.rms_before_arcsec);
        expect(tps.rms_before_arcsec).toBeGreaterThan(0);
    });
});
