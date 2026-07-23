import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResidualQuiver } from '../ui/calibration/CalibrationCharts';
import type { QuiverModel, QuiverArrow } from '../ui/calibration/quiver_model';

/**
 * WAVE-2A ③c regression — the residual vector field must draw ONE arrow per
 * matched star (the reported bug was "1 arrow for 56 stars"). The model side is
 * pinned in step6_charts.test.ts (arrows.length === matches); this guards the
 * RENDER path — that ResidualQuiver emits N arrow marks for N arrows, not one.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

function modelWith(n: number): QuiverModel {
    const arrows: QuiverArrow[] = [];
    for (let i = 0; i < n; i++) {
        arrows.push({ px: 100 + i * 5, py: 200 + (i % 7) * 4, dx: 1.2, dy: -0.8, mag: Math.hypot(1.2, 0.8), id: `g${i}`, gmag: 9 });
    }
    return {
        arrows,
        rmsPx: 1.4, medianPx: 1.4, magnification: 10,
        bbox: { minX: 100, minY: 200, maxX: 100 + n * 5, maxY: 240 },
        outlierCount: 0, outlierLimitPx: 100, // high → no arrow is clipped as outlier
    };
}

describe('ResidualQuiver — one arrow per matched star (render)', () => {
    it('renders 56 arrow marks for a 56-star model', () => {
        const out = html(<ResidualQuiver model={modelWith(56)} pixelScale={3.68} />);
        // Each arrow group carries exactly one <title>; the two <marker> defs do not.
        const titles = out.match(/<title>/g)?.length ?? 0;
        expect(titles).toBe(56);
        // And 56 non-outlier arrow lines reference the standard arrowhead marker.
        const heads = out.match(/url\(#quiver-head\)/g)?.length ?? 0;
        expect(heads).toBe(56);
        // The header count agrees with the arrow count.
        expect(out).toContain('>56</span> MATCHED STARS');
    });
});
