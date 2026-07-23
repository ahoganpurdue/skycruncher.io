import { DetectedStar, SegmentationMasks } from '../../types/Main_types';
import { StatisticsProvider } from '../../core/StatisticsProvider';
import { PhotometryManager } from '../m8_photometry/photometry_manager';
import { TelemetryLogger } from '../../diagnostics/telemetry_logger';
import { SensorCalibrationManager } from '../../core/SensorCalibrationManager';
import { computeBlobShapeStats, cullThermalBlobs, logShapeDistributions } from './detection_cuts';
import { removeThermalArtifacts, measureHotPixelCandidates } from './hot_pixel_map';
import * as wasm from '../../wasm_compute/pkg/wasm_compute';

// The wasm-pack *web-target* glue does not re-export `memory`, so
// `(wasm as any).memory` is always undefined and every zero-copy call used to
// fall back to the slow (and centroid-less) JS path. The init function's
// resolved value IS the instance exports object, which includes `memory`.
let wasmExports: any = null;
let wasmInitPromise: Promise<void> | null = null;

async function ensureWasmInitialized(): Promise<void> {
    if (wasmExports) return;
    if (!wasmInitPromise) {
        wasmInitPromise = Promise.resolve()
            .then(() => (typeof (wasm as any).default === 'function' ? (wasm as any).default() : null))
            .then((exp: any) => { wasmExports = exp; })
            .catch(() => { wasmExports = null; });
    }
    await wasmInitPromise;
}

function wasmMemory(): WebAssembly.Memory {
    const mem = wasmExports?.memory ?? (wasm as any).memory;
    if (!mem?.buffer) throw new Error('WASM memory unavailable (module not initialized)');
    return mem;
}

/**
 * SOURCE EXTRACTOR â€” The Photometric Engine
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralizes star detection and luminance processing logic.
 * Ensures consistent normalization and thresholding across all pipeline paths.
 */
export class SourceExtractor {

    /**
     * Estimate the image background level and noise (Ïƒ) using
     * iterative sigma-clipping on a sampled grid.
     */
    public static estimateBackground(
        data: Float32Array
    ): { median: number; sigma: number } {
        try {
            // BUGFIX: this previously forwarded (width, height) into the
            // (iterations, sigma_clip) parameter slots of
            // StatisticsProvider.estimateBackground(data, iterations=3, sigma_clip=3.0).
            // sigma_clip ≈ image-height (~2000σ) disabled outlier rejection, so the
            // returned σ was inflated by star/hot-pixel flux and the detection
            // threshold was silently desensitized. The estimator only needs `data`;
            // use the calibrated 3-pass / 3.0σ defaults.
            return StatisticsProvider.estimateBackground(data, 3, 3.0);
        } catch (e) {
            console.warn('[SourceExtractor] WASM Stats failed, using basic CPU fallback');
            // Simplified median/sigma for fallback
            const sorted = [...data].sort((a,b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            return { median, sigma: 0.01 };
        }
    }

    /**
     * Convert RGBA ImageData to a single-channel luminance Float32Array.
     * FIX: Normalizes output to 0.0 - 1.0 range.
     */
    public static imageDataToluminance(imageData: ImageData): Float32Array {
        const { data, width, height } = imageData;
        const size = width * height;
        
        try {
            // Use WASM for zero-copy RGB -> Luma conversion
            const ptr = (wasm as any).get_input_buffer_ptr(data.length);
            if (ptr === undefined) throw new Error("WASM not initialized");

            const buffer = new Uint8Array(wasmMemory().buffer, ptr as number, data.length);
            buffer.set(data);

            const outPtr = (wasm as any).convert_rgba_to_luma(ptr, width, height);
            const outData = new Float32Array(wasmMemory().buffer, outPtr as number, size);

            console.log(`[SourceExtractor] WASM luma conversion OK (${width}x${height}).`);
            return outData.slice(); // Copy to JS heap for the pipeline
        } catch (e) {
            console.error('[PERFORMANCE CRITICAL] SourceExtractor: WASM Luma conversion failed! Falling back to SLOW Javascript implementation. Check WASM initialization.');
            const luma = new Float32Array(size);
            for (let i = 0; i < size; i++) {
                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];
                // Standard luma weights
                luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
            }
            return luma;
        }
    }

    /**
     * Detect point sources in a luminance image using threshold detection
     * with connected-component labeling and centroid refinement.
     */
    public static detectSources(
        lum: Float32Array,
        width: number,
        height: number,
        threshold: number,
        horizonVector?: Uint16Array,
        segmentationMasks?: SegmentationMasks, // [NEW] Multi-class masks
        focusRegions?: { x: number; y: number; radius: number }[],
        logger?: TelemetryLogger,
        focalLengthMm?: number
    ): { stars: DetectedStar[], planets?: DetectedStar[], anomalies?: DetectedStar[] } {
        const start = performance.now();

        const { median: bg, sigma } = this.estimateBackground(lum);
        const detectionThreshold = bg + threshold * sigma;

        // --- THERMAL-ARTIFACT PRE-PASS (NEXT_MOVES §7) ---
        // Detection-support buffer only: master-dark subtraction when a dark
        // exists, statistical hot-pixel masking otherwise (copy-on-flag: zero
        // flags => detLum === lum, byte-identical by construction). The input
        // luminance is never mutated.
        const hotPix = removeThermalArtifacts(
            lum, width, height, bg, sigma, SensorCalibrationManager.getMasterDark()
        );
        const detLum = hotPix.data;
        if (hotPix.method === 'MASTER_DARK') {
            console.log('[HotPixelMap] Master dark applied to the detection buffer.');
        } else if (hotPix.applied) {
            console.log(`[HotPixelMap] THERMAL-DOMINATED frame: ${hotPix.flagged} hot pixels masked before extraction.`);
        } else if (hotPix.flagged > 0) {
            console.log(`[HotPixelMap] ${hotPix.flagged} spike pixels measured but below the thermal-density gate — buffer untouched.`);
        }
        // Calibration instrument: pixels that WOULD be flagged at an N ladder.
        console.log(`[HotPixelMap] candidate ladder ${JSON.stringify(measureHotPixelCandidates(lum, width, height, bg, sigma))}`);

        let flatResults: number[] | Float64Array = [];
        try {
            // Ensure WASM buffer is large enough
            const ptr = (wasm as any).get_input_buffer_ptr(detLum.length);
            if (ptr === undefined) throw new Error("WASM not initialized");

            const buffer = new Float32Array(wasmMemory().buffer, ptr as number, detLum.length);
            buffer.set(detLum);

            // Offload connected component labeling and centroiding to WASM
            flatResults = (wasm as any).extract_blobs_shared(ptr, width, height, detectionThreshold, bg);
            console.log(`[SourceExtractor] WASM blob extraction (zero-copy): ${flatResults.length / 10} blobs (bg=${bg.toFixed(4)}, thresh=${detectionThreshold.toFixed(4)}).`);
        } catch (e) {
            // Zero-copy path unavailable: try the slice-based WASM API (a copy,
            // but keeps proper connected-component centroiding) before the
            // crude per-pixel JS fallback.
            try {
                flatResults = (wasm as any).extract_blobs(detLum, width, height, detectionThreshold, bg);
                console.log(`[SourceExtractor] WASM blob extraction (slice API): ${flatResults.length / 10} blobs.`);
            } catch (e2) {
            console.error('[PERFORMANCE CRITICAL] SourceExtractor: WASM Blob extraction failed! Falling back to SLOW Javascript implementation.');
            // Basic threshold detector for verification environments
            const fallbacks: number[] = [];
            for (let y = 1; y < height - 1; y++) {
                for (let x = 1; x < width - 1; x++) {
                    const idx = y * width + x;
                    if (detLum[idx] > detectionThreshold) {
                        // Very basic: just return the pixel center as a star
                        // [x, y, rawX, rawY, flux, peak, fwhm, snr...] (needs 10 elements per star)
                        fallbacks.push(x, y, x, y, detLum[idx], detLum[idx], 1.5, 0, 0, 10);
                        // Skip neighbors to avoid multi-detection of same star in this simple fallback
                        x += 2;
                    }
                }
            }
            flatResults = fallbacks;
            }
        }
        
        const stars: DetectedStar[] = [];
        for (let i = 0; i < (flatResults as any).length; i += 10) {
            const x = flatResults[i];
            const y = flatResults[i+1];
            const snr = flatResults[i+9];
            
            // 1. HORIZON CULLING
            if (horizonVector) {
                const hVal = horizonVector[Math.floor(x)];
                if (y > hVal) continue;
            }

            // 2. SEMANTIC SEGMENTATION CULLING [NEW]
            if (segmentationMasks) {
                const mx = Math.floor((x / width) * segmentationMasks.dim);
                const my = Math.floor((y / height) * segmentationMasks.dim);
                const mIdx = my * segmentationMasks.dim + mx;

                // Zero-tolerance for Man-Made structures (buildings, lighthouses)
                if (segmentationMasks.manMade[mIdx] > 0.5) {
                    continue; 
                }

                // High-tolerance for Arboreal (Trees). Allow if SNR is high (stars shining through)
                if (segmentationMasks.arboreal[mIdx] > 0.5 && snr < 20) {
                    continue;
                }
            }

            // Thermal-noise shape statistics, measured TS-side on the same
            // detection buffer the blob was extracted from (detection_cuts.ts).
            const shape = computeBlobShapeStats(
                detLum, width, height, x as number, y as number, bg,
                flatResults[i+5] as number, flatResults[i+4] as number
            );

            stars.push({
                x,
                y,
                rawX: flatResults[i+2],
                rawY: flatResults[i+3],
                flux: flatResults[i+4],
                peak_adu: flatResults[i+5],
                fwhm: flatResults[i+6],
                snr,
                sharpness: shape.sharpness ?? undefined,
                moment_fwhm_px: shape.momentFwhmPx ?? undefined,
                moment_ellipticity: shape.momentEllipticity ?? undefined,
            });
        }

        // Calibration instrument: measured shape distributions for this lane.
        logShapeDistributions(
            'SourceExtractor.detectSources',
            stars.map(s => ({
                sharpness: s.sharpness ?? null,
                momentFwhmPx: s.moment_fwhm_px ?? null,
                momentEllipticity: s.moment_ellipticity ?? null,
            })),
            stars.map(s => s.fwhm)
        );

        // Per-blob thermal cuts (assignment-time measured counts; inert
        // thresholds => pass-through, byte-identical).
        const cutTally: Record<string, number> = {};
        const keptStars = cullThermalBlobs(stars, (reason) => {
            cutTally[reason] = (cutTally[reason] || 0) + 1;
        });
        if (keptStars.length !== stars.length) {
            console.log(`[DetectionCuts] SourceExtractor: ${stars.length - keptStars.length} thermal blobs cut ${JSON.stringify(cutTally)} (${keptStars.length} kept).`);
        }

        const { finalStars, anomalies, planets } = this.cullAnomalies(keptStars, lum, width, height, focalLengthMm);
        console.log(`[SourceExtractor] ${(flatResults as any).length / 10} blobs -> ${stars.length} after masks -> ${keptStars.length} after thermal cuts -> ${finalStars.length} stars (+${anomalies.length} anomalies, ${planets.length} planet candidates).`);

        return {
            stars: finalStars.slice(0, 500),
            planets,
            anomalies
        };
    }

    /**
     * CULL ANOMALIES â€” The "Sanity Check"
     * Identifies satellites (linearity), light pollution (clustering), and planets.
     */
    private static cullAnomalies(
        stars: DetectedStar[], 
        lum: Float32Array, 
        w: number, 
        h: number,
        focalLength?: number
    ): { finalStars: DetectedStar[], anomalies: DetectedStar[], planets: DetectedStar[] } {
        const anomalies: DetectedStar[] = [];
        const planets: DetectedStar[] = [];
        const linearAnomalies = this.detectLinearAnomalies(stars);
        
        // Intensity/FWHM ratio for planets (Planets are bright but often have larger "Physical" FWHM due to brightness/optics)
        const isPlanet = (s: DetectedStar) => {
            // Bright but potentially slightly bloated or extremely sharp compared to neighbors
            return (s.magnitude || 10) < 1.0 && (s.peak_adu ?? 0) > 0.95;
        };

        const finalStars = stars.filter(s => {
            // 1. Check Linearity (Satellites/Planes)
            if (linearAnomalies.has(s)) {
                anomalies.push(s);
                return false;
            }

            // 2. Check Planet Candidates
            if (isPlanet(s)) {
                planets.push(s);
                // Keep in stars but flag? Actually user said "detect likely planets"
                // Usually we keep them for plate solving unless they are too bright and clip
                return true;
            }

            return true;
        });

        // 3. Cluster/Light Pollution Detection (Density based)
        const cellSize = 64;
        const gridW = Math.ceil(w / cellSize);
        const gridH = Math.ceil(h / cellSize);
        const densityGrid = new Uint32Array(gridW * gridH);
        
        stars.forEach(s => {
            const gx = Math.floor(s.x / cellSize);
            const gy = Math.floor(s.y / cellSize);
            if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) densityGrid[gy * gridW + gx]++;
        });

        // Cull stars in extreme density regions (Light pollution/Clusters)
        // [ADAPTIVE] Increased to 150 to allow dense star fields in wide-angle shots.
        const cullingThreshold = 150; 
        return {
            finalStars: finalStars.filter(s => {
                const gx = Math.floor(s.x / cellSize);
                const gy = Math.floor(s.y / cellSize);
                if (densityGrid[gy * gridW + gx] > cullingThreshold) {
                    anomalies.push(s);
                    return false;
                }
                return true;
            }),
            anomalies,
            planets
        };
    }

    /**
     * RANSAC-like Linear Detection for Satellites/Planes
     */
    private static detectLinearAnomalies(stars: DetectedStar[]): Set<DetectedStar> {
        const result = new Set<DetectedStar>();
        if (stars.length < 5) return result;

        // Group stars by proximity to avoid O(N^2) over the whole image
        // Satellite trails are locally linear.
        const candidates = stars.filter(s => s.flux > 0.01); // Only check meaningful signal
        
        // Simple 1-pass line fitting for nearby groups
        // [FUTURE: Full RANSAC if trails are broken]
        for (let i = 0; i < candidates.length; i++) {
            if (result.has(candidates[i])) continue;
            
            const line: DetectedStar[] = [candidates[i]];
            for (let j = i + 1; j < candidates.length; j++) {
                if (result.has(candidates[j])) continue;
                
                // If within search radius, check linearity
                const dist = Math.sqrt(Math.pow(candidates[i].x - candidates[j].x, 2) + Math.pow(candidates[i].y - candidates[j].y, 2));
                if (dist < 300) { // Local search
                    line.push(candidates[j]);
                }
            }

            if (line.length >= 6) {
                // Check if they form a line
                if (this.isLinear(line)) {
                    line.forEach(s => result.add(s));
                }
            }
        }

        return result;
    }

    private static isLinear(points: DetectedStar[]): boolean {
        if (points.length < 4) return false;
        
        // Simple Mean Squared Error fit
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        const n = points.length;
        for (const p of points) {
            sumX += p.x; sumY += p.y;
            sumXY += p.x * p.y; sumX2 += p.x * p.x;
        }
        
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        
        let maxError = 0;
        for (const p of points) {
            const expectedY = slope * p.x + intercept;
            const err = Math.abs(p.y - expectedY);
            if (err > maxError) maxError = err;
        }

        return maxError < 15.0; // Tolerance for plane lights/satellite trails
    }

    /**
     * MILKY WAY DETECTION (Diffuse Luminance Scan)
     */
    public static detectMilkyWay(lum: Float32Array, w: number, h: number, bgMean: number, sigma: number): { x: number, y: number, brilliance: number }[] {
        const points: { x: number, y: number, brilliance: number }[] = [];
        const step = 64;
        
        for (let y = step; y < h - step; y += step) {
            for (let x = step; x < w - step; x += step) {
                // Sample 5x5 average
                let sum = 0;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        sum += lum[(y + dy) * w + (x + dx)];
                    }
                }
                const avg = sum / 25;
                if (avg > bgMean + (sigma * 3.5)) { // 3.5-sigma diffuse threshold (More sensitive)
                     points.push({ x, y, brilliance: avg });
                }
            }
        }
        return points;
    }

    /**
     * Convenience method to extract stars directly from ImageData.
     */
    public static async extractStars(
        imageData: ImageData,
        thresholdSigma: number = 3.0,
        horizonVector?: Uint16Array,
        segmentationMasks?: SegmentationMasks, // [NEW]
        options?: {
            focusRegions?: { x: number; y: number; radius: number }[],
            logger?: TelemetryLogger,
            focalLengthMm?: number
        }
    ): Promise<{ stars: DetectedStar[], planets?: DetectedStar[], anomalies?: DetectedStar[] }> {
        await ensureWasmInitialized();
        const lum = this.imageDataToluminance(imageData);
        return this.detectSources(
            lum,
            imageData.width,
            imageData.height,
            thresholdSigma,
            horizonVector,
            segmentationMasks,
            options?.focusRegions,
            options?.logger,
            options?.focalLengthMm
        );
    }
}

