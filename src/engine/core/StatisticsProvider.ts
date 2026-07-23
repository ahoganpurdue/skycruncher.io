import * as wasm from '../wasm_compute/pkg/wasm_compute';

/**
 * STATISTICS PROVIDER â€” The "Sigma" Filter
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralizes scientific statistics for image analysis.
 * - Iterative Sigma-Clipping for background level estimation.
 * - Median/Mean/StdDev calculations.
 * - Percentiles and histogram sampling.
 */
export class StatisticsProvider {

    /**
     * Estimate the image background level and noise (Ïƒ) using
     * iterative sigma-clipping on a sampled grid.
     */
    public static estimateBackground(
        data: Float32Array,
        iterations: number = 3,
        sigma_clip: number = 3.0
    ): { median: number; sigma: number } {
        try {
            const stats = (wasm as any).estimate_background_wasm(data, iterations, sigma_clip);
            return {
                median: stats[0],
                sigma: stats[1]
            };
        } catch (e) {
            console.error('[PERFORMANCE CRITICAL] StatisticsProvider: WASM background estimation failed! Running SLOW iterative sigma-clipping on CPU.');
            // Simplified iterative sigma-clipping fallback
            let subset = Array.from(data);
            let median = 0;
            let sigma = 0;

            for (let i = 0; i < iterations; i++) {
                if (subset.length === 0) break;
                subset.sort((a, b) => a - b);
                median = subset[Math.floor(subset.length / 2)];
                
                // Approximate sigma via MAD (Median Absolute Deviation)
                const ad = subset.map(v => Math.abs(v - median));
                ad.sort((a, b) => a - b);
                sigma = ad[Math.floor(ad.length * 0.5)] * 1.4826 || 0.01;
                
                const lower = median - sigma_clip * sigma;
                const upper = median + sigma_clip * sigma;
                subset = subset.filter(v => v >= lower && v <= upper);
            }

            return { median, sigma };
        }
    }

    /**
     * Calculate basic statistics for a Float32Array.
     */
    public static calculateStats(data: Float32Array): { min: number; max: number; mean: number; median: number; stdDev: number } {
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        let sumSq = 0;

        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
            sumSq += v * v;
        }

        const mean = sum / data.length;
        const variance = (sumSq / data.length) - (mean * mean);
        const stdDev = Math.sqrt(Math.max(0, variance));

        const sorted = new Float32Array(data).sort();
        const median = sorted[Math.floor(sorted.length / 2)];

        return {
            min,
            max,
            mean,
            median,
            stdDev
        };
    }

    /**
     * CHANNEL HISTOGRAM ANALYSIS
     * Computes per-channel distributions to identify spectral shifts (Light Pollution).
     */
    public static calculateChannelHistograms(data: Float32Array): { r: Uint32Array, g: Uint32Array, b: Uint32Array } {
        const bins = 256;
        const histograms = {
            r: new Uint32Array(bins),
            g: new Uint32Array(bins),
            b: new Uint32Array(bins)
        };

        for (let i = 0; i < data.length; i += 3) {
            const r = Math.min(bins - 1, Math.floor(data[i] * (bins - 1)));
            const g = Math.min(bins - 1, Math.floor(data[i+1] * (bins - 1)));
            const b = Math.min(bins - 1, Math.floor(data[i+2] * (bins - 1)));
            histograms.r[r]++;
            histograms.g[g]++;
            histograms.b[b]++;
        }

        return histograms;
    }

    /**
     * ESTIMATE BLACK POINT
     * Finds the high-density floor of the histogram to define "True Black".
     */
    public static estimateBlackPoint(lum: Float32Array): number {
        const bins = 1024;
        const hist = new Uint32Array(bins);
        
        // Sampling for speed
        const step = Math.max(1, Math.floor(lum.length / 50000));
        for (let i = 0; i < lum.length; i += step) {
            const v = Math.min(bins - 1, Math.floor(lum[i] * (bins - 1)));
            hist[v]++;
        }

        // Find the peak near the low end (the background floor)
        let peakVal = 0;
        let peakIdx = 0;
        const searchRange = Math.floor(bins * 0.2); // Only lock to bottom 20%
        for (let i = 0; i < searchRange; i++) {
            if (hist[i] > peakVal) {
                peakVal = hist[i];
                peakIdx = i;
            }
        }

        return peakIdx / (bins - 1);
    }
}
