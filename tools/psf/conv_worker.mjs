// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — row-band 2D convolution worker (Richardson-Lucy inner loop)
// ═══════════════════════════════════════════════════════════════════════════
// Receives SharedArrayBuffers for src/dst plus a small kernel; convolves rows
// [y0, y1) with clamp-to-edge boundaries. Interior pixels take an unclamped
// fast path. Pure worker_threads — no browser-Worker shim involvement.

import { parentPort } from 'node:worker_threads';

parentPort.on('message', (m) => {
    const { jobId, sabIn, sabOut, w, h, y0, y1, kw, kh, k } = m;
    const src = new Float32Array(sabIn);
    const dst = new Float32Array(sabOut);
    const hw = (kw - 1) >> 1;
    const hh = (kh - 1) >> 1;
    const xInEnd = w - hw;

    const clampedPixel = (x, y) => {
        let acc = 0, ki = 0;
        for (let j = 0; j < kh; j++) {
            let yy = y + j - hh;
            if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
            const row = yy * w;
            for (let i = 0; i < kw; i++, ki++) {
                let xx = x + i - hw;
                if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
                acc += src[row + xx] * k[ki];
            }
        }
        return acc;
    };

    for (let y = y0; y < y1; y++) {
        const orow = y * w;
        if (y < hh || y >= h - hh) {
            for (let x = 0; x < w; x++) dst[orow + x] = clampedPixel(x, y);
            continue;
        }
        for (let x = 0; x < hw; x++) dst[orow + x] = clampedPixel(x, y);
        const base00 = (y - hh) * w - hw;
        for (let x = hw; x < xInEnd; x++) {
            let acc = 0, ki = 0;
            const base0 = base00 + x;
            for (let j = 0; j < kh; j++) {
                const base = base0 + j * w;
                for (let i = 0; i < kw; i++) acc += src[base + i] * k[ki++];
            }
            dst[orow + x] = acc;
        }
        for (let x = xInEnd; x < w; x++) dst[orow + x] = clampedPixel(x, y);
    }

    parentPort.postMessage({ jobId });
});
