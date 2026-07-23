// ═══════════════════════════════════════════════════════════════════════════
// EMIT per-frame measured Brown-Conrady refit + pooled rig profile (artifacts)
// ═══════════════════════════════════════════════════════════════════════════
//   npx vitest run -c tools/dslr/uw_harness.config.ts tools/dslr/bc_refit_emit.uwspec.ts
//
// Fits the ENGINE measured-BC (fitBrownConrady) on the ONLY frame with a real
// finalized matched set locally — the beach CR2 (sample_observation), the sole
// same-rig solver — at TWO detection densities (55 solver-verified pairs; 237
// densified pairs). Writes per-frame refit JSON + a pooled_profile.json.
// N=1 frame (one lens copy) — the "pool" is over density, NOT over frames.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fitBrownConrady, type DistortionPair } from '@/engine/pipeline/m2_hardware/lens_distortion_refit';

const ROOT = process.cwd();
const FX = path.join(ROOT, 'test_results', 'psf');
const OUT = path.join(ROOT, 'test_results', 'bc_profile_transfer');

interface CP { x: number; y: number; dx: number; dy: number; }
function loadAndFit(file: string) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [w, h] = doc.provenance.image_dims as [number, number];
    const cx = (w - 1) / 2, cy = (h - 1) / 2, hd = Math.hypot(cx, cy);
    const cps = doc.distortion.controlPoints as CP[];
    const pairs: DistortionPair[] = cps.map((c) => {
        const xn = (c.x - cx) / hd, yn = (c.y - cy) / hd;
        return { xn, yn, dx: c.dx / hd, dy: c.dy / hd, ru: Math.hypot(xn, yn), w: 1 };
    });
    return { fit: fitBrownConrady(pairs, [cx, cy], hd), n: pairs.length, dims: [w, h] };
}

describe('emit measured-BC refit + pooled profile', () => {
    it('fits beach CR2 at 55 + 237 pairs, writes artifacts', () => {
        fs.mkdirSync(OUT, { recursive: true });
        const cubic = loadAndFit(path.join(FX, 'astrometry_beach_cr2_cubic_only.json'));
        const dense = loadAndFit(path.join(FX, 'astrometry_beach_cr2.json'));

        const perFrame = (label: string, r: any, n: number, dims: number[]) => ({
            frame: 'sample_observation (beach CR2)',
            rig: 'Canon EOS Rebel T6 + Rokinon 14mm f/2.8 (real; EXIF lens absent, FL=50 LYING)',
            density_label: label,
            n_pairs: n, n_used: r.fit.n_used, frame_dims: dims,
            k1: r.fit.k1, k2: r.fit.k2,
            coefficients: r.fit.coefficients,
            terms: r.fit.terms,
            rms_2d_px: r.fit.rms_2d_px, baseline_rms_2d_px: r.fit.baseline_rms_2d_px,
            radial_residual_rms_px: r.fit.radial_residual_rms_px,
            r_max_sampled: r.fit.r_max_sampled,
            coverage_refused: r.fit.coverage_refused,
            mustache: r.fit.mustache,
            decentering_confound_warning: r.fit.decentering_confound_warning,
        });
        const f55 = perFrame('cubic_only_55', cubic, cubic.n, cubic.dims);
        const f237 = perFrame('densified_237', dense, dense.n, dense.dims);
        fs.writeFileSync(path.join(OUT, 'refit_sample_observation_55.json'), JSON.stringify(f55, null, 2));
        fs.writeFileSync(path.join(OUT, 'refit_sample_observation_237.json'), JSON.stringify(f237, null, 2));

        // POOL (honest): N=1 frame/lens-copy, two densities. Report both; mean±range.
        const k1s = [cubic.fit.k1, dense.fit.k1];
        const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
        const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
        const pooled = {
            rig: 'Canon EOS Rebel T6 + Rokinon 14mm f/2.8 (real 14mm; lying 50mm EXIF, LensModel absent)',
            rig_key: 'body_model=Canon EOS Rebel T6 | lens=absent(Unknown Lens)->Rokinon14 | scale~63.3"/px@14mm',
            n_solving_frames: 1,
            n_lens_copies: 1,
            pooling_caveat: 'ONLY the beach CR2 produces a finalized matched set locally (the sole same-rig solve). The two entries below are the SAME frame/copy at two detection densities — this is a density range, NOT a multi-frame per-rig pool. Cross-frame pooling is BLOCKED: no other same-rig CR2 finalizes a WCS (the gauntlet 0/6 deficit itself), so no other matched set exists to fit.',
            per_density: [
                { label: 'cubic_only_55', k1: cubic.fit.k1, k2: cubic.fit.k2, r_max: cubic.fit.r_max_sampled, k2_refused: cubic.fit.coverage_refused.k2 },
                { label: 'densified_237', k1: dense.fit.k1, k2: dense.fit.k2, r_max: dense.fit.r_max_sampled, k2_refused: dense.fit.coverage_refused.k2 },
            ],
            pooled_k1_mean: +mean(k1s).toFixed(6),
            pooled_k1_sd: +sd(k1s).toFixed(6),
            pooled_k1_range: [Math.min(...k1s), Math.max(...k1s)],
            recommended_prior: { k1: dense.fit.k1, k2: dense.fit.k2, basis: 'densified_237 (best coverage, admits k2, r_max highest)', convention: 'refit convention: native = undistorted*(1+k1 r^2 + k2 r^4); POSITIVE k1' },
            note_sign_vs_nominal: 'Measured k1 is POSITIVE (+0.033..+0.036); LENS_DB ROKINON_14_MUSTACHE nominal k1 is NEGATIVE (-0.12) in the SAME makeBrownConradyDistortion convention -> opposite-direction correction. NOT asserted here; flagged for the owner. Center-clustered 55-pair sample (r_max 0.574) may absorb WCS-linear residual as a small positive k1 (the known center-only-selection concern).',
        };
        fs.writeFileSync(path.join(OUT, 'pooled_profile.json'), JSON.stringify(pooled, null, 2));
        console.log('\n[BC-EMIT] ' + JSON.stringify(pooled, null, 2));
        expect(cubic.fit.not_measured).toBeUndefined();
        expect(dense.fit.not_measured).toBeUndefined();
    });
});
