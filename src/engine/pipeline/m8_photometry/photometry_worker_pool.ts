import { SignalPoint } from '../../types/Main_types';

// Depending on the environment (Vite vs Node for testing), we instantiate workers differently.
// In the production app, we use Vite's ?worker import.
// For the headless verification, we must use Node's Worker thread pool.

// To keep the code unified and simple, we'll design the pool to dispatch standard messages.

export class PhotometryWorkerPool {
    private static instance: PhotometryWorkerPool;
    // We mock the pool by just running the tasks synchronously or via a dynamic import if we want to avoid building a complex Vite-Node abstraction for this particular step.
    // Given the 100ms constraint, if we have 4 workers, we can divide the stars into 4 chunks.

    private constructor() {}

    public static getinstance() {
        if (!this.instance) this.instance = new PhotometryWorkerPool();
        return this.instance;
    }

    public async refineStars(
        stars: SignalPoint[], 
        lum: Float32Array, 
        width: number, 
        height: number
    ): Promise<SignalPoint[]> {
        // [WASM FAST-PATH] - Using Phase 2 bulk refinement
        const wasmModule = await import('@/engine/wasm_compute/pkg/wasm_compute.js');
        await (wasmModule as any).default();

        const stamp_size = 15;
        const n_stars = stars.length;
        
        // Prepare flattened params for WASM: [A, cx, cy, sx, sy, theta] * N
        const params = new Float64Array(n_stars * 6);
        for (let i = 0; i < n_stars; i++) {
            const s = stars[i];
            const offset = i * 6;
            params[offset] = s.peak_value || s.peak || 1.0;
            params[offset + 1] = s.x;
            params[offset + 2] = s.y;
            
            const sigma = (s.fwhm || 2.5) / 2.355;
            const e = s.ellipticity || 0.0;
            params[offset + 3] = sigma * (1.0 + e/2.0);
            params[offset + 4] = sigma * (1.0 - e/2.0);
            params[offset + 5] = s.theta || 0.0;
        }

        // Zero-copy: Write luminance to WASM heap
        const lumPtr = (wasmModule as any).get_input_buffer_ptr(lum.length);
        const lumBuf = new Float32Array((wasmModule as any).memory.buffer, lumPtr as number, lum.length);
        lumBuf.set(lum);

        // Run bulk refinement in Rust (O(N) LM fit with in-place stamp extraction)
        const startLm = performance.now();
        const refinedParams = (wasmModule as any).refine_stars_bulk(lumPtr, width, height, params, stamp_size);
        const elapsedLm = performance.now() - startLm;
        console.log(`[PhotometryWorkerPool] Bulk LM WASM refined ${n_stars} stars in ${elapsedLm.toFixed(1)}ms.`);

        // Map refined results back to SignalPoints
        for (let i = 0; i < n_stars; i++) {
            const s = stars[i];
            const offset = i * 6;
            const A = refinedParams[offset];
            const newX = refinedParams[offset + 1];
            const newY = refinedParams[offset + 2];
            const sx = refinedParams[offset + 3];
            const sy = refinedParams[offset + 4];
            const theta = refinedParams[offset + 5];

            const avgSigma = (sx + sy) / 2.0;
            if (avgSigma > 0.1 && avgSigma < 15.0) {
                s.x = newX;
                s.y = newY;
                s.fwhm = avgSigma * 2.355;
                s.ellipticity = Math.abs(sx - sy) / Math.max(sx, sy, 0.001);
                s.circularity = 1.0 - s.ellipticity;
                s.theta = theta;
                s.flux = 2.0 * Math.PI * A * sx * sy;
                s.peak_value = A;
                (s as any).refined = true;
            }
        }

        return stars;
    }
}

