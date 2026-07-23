/**
 * SPCC CHANNEL-GAINS — N=5 CALIBRATION SWEEP (owner ruling 2026-07-10).
 *
 * Drives real OSC/RGB FITS frames through the REAL headless wizard pipeline in
 * Node (runWizardPipeline) and records the channel-gain fit metrics (nStars, r²,
 * TLS slopes, gains, uncertainty, gate verdict) recorded in each receipt's
 * spcc.gains block. From the observed distribution we set the SPCC_GAINS_*
 * render-lane thresholds. MONO frames are OUT of scope (no per-channel WB) — the
 * fit self-identifies them ('degenerate') and they are recorded as such, not
 * shoehorned. Writes test_results/overnight_run_2026-07-10/spcc_gains_n5.json.
 *
 * Run: npx vitest run -c tools/color/spcc_gains_n5.config.ts
 * NOT a gate — it is a one-shot measurement (asserts only that we reached N≥3
 * solved color frames, the ruling's honest floor).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES = path.join(REPO_ROOT, 'Sample Files');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'overnight_run_2026-07-10');

// Candidate OSC/RGB FITS (SeeStar-class stacks + a Bayer DSLR), superset of 5 so
// non-solvers / mono can drop out and still leave N≥5 color solves.
const CANDIDATES: { label: string; rel: string }[] = [
    { label: 'SeeStar M66 (pinned)', rel: 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit' },
    { label: 'SeeStar M81',          rel: "rotating/Bode's Galaxy M81_180s-235.fit" },
    { label: 'SeeStar M100',         rel: 'rotating/Blowdryer Galaxy M100 120s-51.fit' },
    { label: 'SeeStar M1 (Crab)',    rel: 'rotating/Crab Nebula M1_120s-92.fit' },
    { label: 'SeeStar Arp-316',      rel: 'rotating/Arp-316 120s-84.fit' },
    { label: 'SeeStar M31',          rel: 'rotating/Andromeda Galaxy M31 90s-431_ISO100.fit' },
    { label: 'Carina 60Da (Bayer)',  rel: 'rotating/carina60Da_180s_iso800_001.fit' },
    { label: 'SeeStar Crescent C27', rel: 'rotating/Crescent C27_30s-568.fit' },
];

interface FrameResult {
    label: string;
    file: string;
    solved: boolean;
    matched: number | null;
    spcc_source: string | null;
    gains: unknown | null;
    error: string | null;
}

describe('SPCC channel-gains N=5 sweep (measurement, not a gate)', () => {
    it('drives candidate OSC FITS headless and records gain metrics', async () => {
        const results: FrameResult[] = [];

        for (const c of CANDIDATES) {
            const file = path.join(SAMPLES, c.rel);
            if (!fs.existsSync(file)) {
                results.push({ label: c.label, file: c.rel, solved: false, matched: null, spcc_source: null, gains: null, error: 'missing' });
                continue;
            }
            try {
                const buf = fs.readFileSync(file);
                const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
                const { receipt } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
                const sol = receipt?.solution;
                const spcc: any = (receipt as any)?.spcc ?? null;
                results.push({
                    label: c.label,
                    file: c.rel,
                    solved: !!sol && Number.isFinite(sol.ra_hours),
                    matched: sol?.stars_matched ?? null,
                    spcc_source: spcc?.source ?? null,
                    gains: spcc?.gains ?? null,
                    error: null,
                });
            } catch (err) {
                results.push({ label: c.label, file: c.rel, solved: false, matched: null, spcc_source: null, gains: null, error: err instanceof Error ? err.message : String(err) });
            }
        }

        // A frame contributes to the calibration when it SOLVED, ran SPCC, and the
        // gain fit produced a non-degenerate (genuinely color) result.
        const colorFits = results.filter(r =>
            r.solved && r.gains && (r.gains as any).gate?.reason !== 'degenerate' && ((r.gains as any).nStars ?? 0) >= 3);

        // Distribution over the color fits (drives the thresholds).
        const num = (xs: number[]) => xs.filter(Number.isFinite);
        const r2s = num(colorFits.map(r => (r.gains as any).r2));
        const slopeBr = num(colorFits.map(r => (r.gains as any).slope_br));
        const slopeGr = num(colorFits.map(r => (r.gains as any).slope_gr));
        const gR = num(colorFits.map(r => (r.gains as any).gains[0]));
        const gB = num(colorFits.map(r => (r.gains as any).gains[2]));
        const nStars = num(colorFits.map(r => (r.gains as any).nStars));
        const mm = (xs: number[]) => xs.length ? { min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length } : null;

        const summary = {
            generated: new Date().toISOString(),
            note: 'SPCC channel-gains N=5 calibration sweep — sets SPCC_GAINS_* render-lane thresholds from the observed distribution. MONO/degenerate frames excluded (recorded honestly).',
            n_candidates: CANDIDATES.length,
            n_solved: results.filter(r => r.solved).length,
            n_color_fits: colorFits.length,
            distribution: {
                r2: mm(r2s), slope_br: mm(slopeBr), slope_gr: mm(slopeGr),
                gain_r: mm(gR), gain_b: mm(gB), nStars: mm(nStars),
            },
            frames: results,
        };

        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, 'spcc_gains_n5.json'), JSON.stringify(summary, null, 2));
        // Console table for the handoff.
        for (const r of results) {
            const g: any = r.gains;
            console.log(`[N5] ${r.label.padEnd(24)} solved=${r.solved} matched=${r.matched ?? '-'} src=${r.spcc_source ?? '-'} ` +
                (g ? `nStars=${g.nStars} r2=${Number.isFinite(g.r2) ? g.r2.toFixed(3) : 'NA'} slopeBR=${Number.isFinite(g.slope_br) ? g.slope_br.toFixed(3) : 'NA'} gains=[${g.gains.map((v: number) => v.toFixed(3)).join(',')}] gate=${g.gate?.reason}` : `err=${r.error ?? '-'}`));
        }
        console.log('[N5] distribution:', JSON.stringify(summary.distribution));

        // Honest floor: the ruling accepts N≥3 color solves.
        expect(colorFits.length).toBeGreaterThanOrEqual(3);
    });
});
