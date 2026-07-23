import { describe, it, expect } from 'vitest';
import {
    resolveColorTransform,
    resolveMatrix,
    buildTransforms,
    describeColorMode,
    matmul3,
    inv3,
    CAMERA_MATRICES,
} from '../core/camera_color_matrix';

describe('camera_color_matrix — resolution', () => {
    it('resolves the 60Da body to a render-ready DERIVED transform', () => {
        const t = resolveColorTransform('Canon EOS 60Da');
        expect(t).not.toBeNull();
        expect(t!.body).toBe('Canon EOS 60Da');
        expect(t!.tag).toBe('DERIVED_CAMERA_MATRIX');
        expect(t!.verified).toBe(true);
        expect(t!.label).toContain('COLOR: matrix sRGB');
        expect(t!.matrix.length).toBe(3);
        expect(t!.matrix.every(r => r.length === 3)).toBe(true);
        expect(t!.preMul.length).toBe(3);
        expect(t!.preMul.every(v => v > 0 && Number.isFinite(v))).toBe(true);
    });

    it('keeps 60Da DISTINCT from 60D (not a fallback — Ha-mod red response)', () => {
        expect(CAMERA_MATRICES['Canon EOS 60Da'].colorMatrix2)
            .not.toEqual(CAMERA_MATRICES['Canon EOS 60D'].colorMatrix2);
        const da = resolveColorTransform('Canon EOS 60Da')!;
        const d = resolveColorTransform('Canon EOS 60D')!;
        expect(da.matrix).not.toEqual(d.matrix);
    });

    it('resolves market rebadge aliases (Rebel T6 → 1300D, T7 → 1500D)', () => {
        expect(resolveMatrix('', 'Canon EOS Rebel T6')!.key).toBe('Canon EOS 1300D');
        expect(resolveMatrix('', 'Canon EOS Rebel T7')!.key).toBe('Canon EOS 1500D');
    });

    it('returns null (honest fallback) for bodies with NO published matrix', () => {
        expect(resolveColorTransform('ZWO Seestar S50')).toBeNull();
        expect(resolveColorTransform('ZWO Seestar S30 Pro')).toBeNull();
        expect(resolveColorTransform('FITS imx462')).toBeNull();
        expect(resolveColorTransform('')).toBeNull();
        expect(resolveColorTransform(null)).toBeNull();
        expect(resolveColorTransform(undefined)).toBeNull();
    });

    it('describeColorMode carries a tag in BOTH modes (never a silent claim)', () => {
        expect(describeColorMode('Canon EOS 60Da').mode).toBe('MATRIX');
        expect(describeColorMode('Canon EOS 60Da').label).toContain('60Da');
        const lum = describeColorMode('ZWO Seestar S50');
        expect(lum.mode).toBe('LUMINANCE');
        expect(lum.label).toContain('empirical WB');
        expect(lum.body).toBeNull();
    });
});

describe('camera_color_matrix — algebra', () => {
    it('inv3 is a true inverse (M·inv(M) ≈ I)', () => {
        const M = buildTransforms(CAMERA_MATRICES['Canon EOS 5D Mark III'].colorMatrix2).camRgbN;
        const I = matmul3(M, inv3(M));
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            expect(I[i][j]).toBeCloseTo(i === j ? 1 : 0, 9);
        }
    });

    it('a WB-neutral camera white maps to sRGB white (1,1,1)', () => {
        // folded matrix · (1/preMul) == cam2srgb · (1,1,1) == (1,1,1)
        const t = resolveColorTransform('Canon EOS 1300D')!;
        const raw = [1 / t.preMul[0], 1 / t.preMul[1], 1 / t.preMul[2]];
        const out = t.matrix.map(r => r[0] * raw[0] + r[1] * raw[1] + r[2] * raw[2]);
        for (const c of out) expect(c).toBeCloseTo(1, 9);
    });
});
