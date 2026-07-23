/**
 * MESH DETECTOR sanity tests (THESIS-2026-07-11-mesh-recall-m4, tools/ incubator).
 * Pure-synthetic, deterministic, no frame files, no solve. Boots the REAL wasm.
 *
 * Three checks:
 *   ① FLAT FRAME EQUIVALENCE   — no gradient ⇒ mesh accepts the same sources as
 *      the incumbent global gate (the variant reduces to the incumbent).
 *   ② GRADIENT RECOVERY        — on a linear-gradient frame the mesh recovers
 *      dim dark-half sources the whole-frame global gate rejects.
 *   ③ P9 FLAT-SURFACE IDENTITY — a FLAT-surface mesh run reproduces
 *      runDetection BIT-FOR-BIT (gates the pre-mask against corruption).
 */
import { describe, it, expect } from 'vitest';
import { bootWasm, runDetection, baselineKnobs, type KnobConfig } from './detect_harness';
import { runMeshDetection, DEFAULT_MESH, type MeshParams } from './mesh_detector';

// ── synthetic frame builders (deterministic, no RNG) ──────────────────────────

/** Flat constant background + Gaussian sources. No noise ⇒ no spurious blobs,
 *  so both detectors see exactly the injected sources. */
function flatFrame(w: number, h: number, bg: number, sources: Src[]): Float32Array {
    const lum = new Float32Array(w * h).fill(bg);
    addSources(lum, w, h, () => bg, sources);
    return lum;
}

/** Linear background ramp bg(x) = lo + (hi-lo)·x/(w-1) + tiny deterministic
 *  texture, plus Gaussian sources. The ramp inflates the GLOBAL mean+σ so the
 *  whole-frame deep floor sits high; the local mesh tracks the ramp. */
function gradientFrame(w: number, h: number, lo: number, hi: number, sources: Src[]): Float32Array {
    const lum = new Float32Array(w * h);
    const bgAt = (x: number) => lo + (hi - lo) * (x / (w - 1));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            lum[y * w + x] = bgAt(x) + 0.001 * Math.sin((x + y) * 0.017); // sub-σ texture
        }
    }
    addSources(lum, w, h, bgAt, sources);
    return lum;
}

interface Src { x: number; y: number; amp: number; fwhm: number }

function addSources(lum: Float32Array, w: number, h: number, _bgAt: (x: number) => number, sources: Src[]): void {
    for (const s of sources) {
        const sigma = s.fwhm / 2.355;
        const r = Math.ceil(sigma * 4);
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const x = Math.round(s.x) + dx, y = Math.round(s.y) + dy;
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                lum[y * w + x] += s.amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
            }
        }
    }
}

/** true if any detection lands within `tol` px of (x,y). */
function detectedNear<T extends { x: number; y: number }>(dets: T[], x: number, y: number, tol = 3): boolean {
    return dets.some(d => Math.hypot(d.x - x, d.y - y) < tol);
}

// isolate the shape/hot-pixel knobs so the test probes the THRESHOLD only.
function looseKnobs(fl?: number): KnobConfig {
    return { ...baselineKnobs(fl), hotpixMinDensityPerMP: Number.POSITIVE_INFINITY, fwhmFloorPx: 0, sharpnessMax: Infinity, ellipticityMax: 1 };
}

describe('mesh_detector — local-background thresholding variant', () => {
    // ①  FLAT FRAME: mesh reduces to the incumbent (same source set) ────────────
    it('① flat frame: mesh and global accept the SAME sources (reduces to incumbent)', () => {
        bootWasm();
        const W = 256, H = 256, BG = 0.10;
        // well-separated bright sources; no two footprints touch above bg
        const sources: Src[] = [
            { x: 40, y: 40, amp: 0.6, fwhm: 3.0 },
            { x: 200, y: 60, amp: 0.5, fwhm: 3.2 },
            { x: 120, y: 128, amp: 0.7, fwhm: 2.8 },
            { x: 60, y: 200, amp: 0.55, fwhm: 3.0 },
            { x: 210, y: 210, amp: 0.65, fwhm: 3.1 },
        ];
        const knobs = looseKnobs();
        const params: MeshParams = { ...DEFAULT_MESH, m: 64 };
        const global = runDetection(flatFrame(W, H, BG, sources), W, H, knobs);
        const mesh = runMeshDetection(flatFrame(W, H, BG, sources), W, H, knobs, params);

        // every injected source found by BOTH
        for (const s of sources) {
            expect(detectedNear(global.detections, s.x, s.y), `global finds (${s.x},${s.y})`).toBe(true);
            expect(detectedNear(mesh.detections, s.x, s.y), `mesh finds (${s.x},${s.y})`).toBe(true);
        }
        // identical count on a flat frame: no spurious mesh blobs, no merges
        expect(mesh.detections.length).toBe(global.detections.length);
        expect(mesh.detections.length).toBe(sources.length);
        // on a flat frame the bright sources clear the GLOBAL vanguard floor, so
        // the deep pass adds nothing new (all deduped) — the local surface admits
        // NOTHING the global gate wouldn't. Honest result: no deep survivors ⇒
        // binding fraction is null (absent), or 0 if any survive but none bind.
        expect(mesh.tLocalBindingFraction === null || mesh.tLocalBindingFraction === 0).toBe(true);
        expect(mesh.deepLocalBindingCount).toBe(0);

        // measured evidence line
        console.log(`[MESH ①] global=${global.detections.length} mesh=${mesh.detections.length} ` +
            `sources=${sources.length} bindingFrac=${mesh.tLocalBindingFraction}`);
    });

    // ②  GRADIENT: mesh recovers dark-half sources the global gate buries ───────
    it('② gradient frame: mesh recovers dim dark-half sources global rejects', () => {
        bootWasm();
        const W = 256, H = 256;
        const LO = 0.05, HI = 0.35; // ramp along +x: dark left, bright right
        // dim sources in the DARK half (x < 64): peak ≈ localBg + amp sits BELOW
        // the globally-inflated deep floor but ABOVE the local floor.
        const darkSources: Src[] = [
            { x: 30, y: 60, amp: 0.11, fwhm: 3.0 },
            { x: 45, y: 140, amp: 0.12, fwhm: 3.0 },
            { x: 25, y: 200, amp: 0.11, fwhm: 3.2 },
        ];
        // bright control sources in the BRIGHT half: both detectors must find them.
        const brightSources: Src[] = [
            { x: 210, y: 70, amp: 0.6, fwhm: 3.0 },
            { x: 190, y: 190, amp: 0.55, fwhm: 3.1 },
        ];
        const all = [...darkSources, ...brightSources];
        const knobs = looseKnobs();
        const params: MeshParams = { ...DEFAULT_MESH, m: 32 }; // fine mesh tracks the ramp

        const global = runDetection(gradientFrame(W, H, LO, HI, all), W, H, knobs);
        const mesh = runMeshDetection(gradientFrame(W, H, LO, HI, all), W, H, knobs, params);

        // control: BOTH find the bright sources
        for (const s of brightSources) {
            expect(detectedNear(global.detections, s.x, s.y), `global finds bright (${s.x},${s.y})`).toBe(true);
            expect(detectedNear(mesh.detections, s.x, s.y), `mesh finds bright (${s.x},${s.y})`).toBe(true);
        }
        // mechanism: each dark source is MISSED by global but RECOVERED by mesh
        let recovered = 0;
        for (const s of darkSources) {
            const g = detectedNear(global.detections, s.x, s.y);
            const m = detectedNear(mesh.detections, s.x, s.y);
            expect(g, `global should MISS dark (${s.x},${s.y})`).toBe(false);
            expect(m, `mesh should RECOVER dark (${s.x},${s.y})`).toBe(true);
            if (m && !g) recovered++;
        }
        expect(recovered).toBe(darkSources.length);
        // the recovered dark sources are admitted ONLY by the local surface
        expect((mesh.tLocalBindingFraction ?? 0)).toBeGreaterThan(0);

        console.log(`[MESH ②] global=${global.detections.length} mesh=${mesh.detections.length} ` +
            `darkRecovered=${recovered}/${darkSources.length} ` +
            `deepBinding=${mesh.deepLocalBindingCount}/${mesh.deepSurvivorCount} ` +
            `bindingFrac=${(mesh.tLocalBindingFraction ?? 0).toFixed(3)}`);
    });

    // ③  P9: FLAT-SURFACE mesh reproduces runDetection BIT-FOR-BIT ──────────────
    it('③ P9 flat-surface identity: flat mesh == runDetection bit-for-bit', () => {
        bootWasm();
        const W = 256, H = 256;
        // a genuinely gradient-bearing frame so the control is non-trivial
        const sources: Src[] = [
            { x: 30, y: 60, amp: 0.4, fwhm: 3.0 },
            { x: 128, y: 128, amp: 0.6, fwhm: 3.0 },
            { x: 210, y: 200, amp: 0.5, fwhm: 3.1 },
        ];
        const knobs = looseKnobs();
        const buildLum = () => gradientFrame(W, H, 0.05, 0.35, sources);
        const base = runDetection(buildLum(), W, H, knobs);
        const flat = runMeshDetection(buildLum(), W, H, knobs, DEFAULT_MESH, { flat: true });

        expect(flat.rawVanguard).toBe(base.rawVanguard);
        expect(flat.rawDeep).toBe(base.rawDeep);
        expect(flat.detections.length).toBe(base.detections.length);
        // element-wise IEEE bit equality (toBe): count, position, flux, peak, snr, shape
        for (let i = 0; i < base.detections.length; i++) {
            const b = base.detections[i], m = flat.detections[i];
            expect(m.x).toBe(b.x);
            expect(m.y).toBe(b.y);
            expect(m.flux).toBe(b.flux);
            expect(m.peak).toBe(b.peak);
            expect(m.snr).toBe(b.snr);
            expect(m.fwhm).toBe(b.fwhm);
            expect(m.circularity).toBe(b.circularity);
        }
        console.log(`[MESH ③] bit-identical detections=${flat.detections.length} ` +
            `(rawV=${flat.rawVanguard} rawD=${flat.rawDeep})`);
    });
});
