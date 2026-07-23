/**
 * TOPOGRAPHY SEGMENTATION â€” M4 Scientific Metrology
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Role: Domain II [Segmentation] â€” State: {HORIZON_MASKED}
 * 
 * Implements the globally optimal ridgeline tracker (Dynamic Programming)
 * to separate the terrestrial horizon from the astronomical sky.
 */

import { Point } from '../../types/Main_types';
import { SensorCalibrationManager } from '../../core/SensorCalibrationManager';

export class TopographySegmentation {

    /**
     * HORIZON DETECTION (High-Fidelity Spectral-Aware Tracker)
     * Fits a guide path using DP based on intensity gradients + Rayleigh chromaticity.
     * 
     * @phase Identification - Locates the boundary to guide star culling.
     */
    public static detectHorizon(lum: Float32Array, previewRGB: Float32Array | null, w: number, h: number, stars: Point[] = []): Point[] {
        // Stage 1: Grid Sampling for Guide Path
        const gridW = 160; 
        const gridH = 100;
        const cellW = w / gridW;
        
        // [EXPANDED] Scan window to handle high horizons (mountains/buildings)
        const scanHeight = h * 0.95;
        const scanOffset = h * 0.05; 
        const cellH = scanHeight / gridH;

        const energyMap = new Float32Array(gridW * gridH);
        const starMap = new Uint8Array(gridW * gridH);
        
        // [AGGRESSIVE STAR ERASURE]
        // Mark star locations in the grid to prevent path contamination
        // Increased radius to 10 (21x21 grid) as requested by user
        for (const s of stars) {
            if (s.y < scanOffset) continue;
            const gx = Math.floor(s.x / cellW);
            const gy = Math.floor((s.y - scanOffset) / cellH);
            for (let dy = -10; dy <= 10; dy++) {
                for (let dx = -10; dx <= 10; dx++) {
                    const tx = gx + dx, ty = gy + dy;
                    if (tx >= 0 && tx < gridW && ty >= 0 && ty < gridH) starMap[ty * gridW + tx] = 1;
                }
            }
        }

        // Stage 1.1: Pre-Detection Edge Pass (Sobel + Coherence)
        const edgeMap = this.detectStructuralEdges(lum, w, h, scanOffset, scanHeight, gridW, gridH);

        // 1. Calculate Energy Map (Vertical Transition Focus + Structural Guide)
        for (let gx = 0; gx < gridW; gx++) {
            let colMax = 1e-6;
            for (let gy = 0; gy < gridH; gy++) {
                const x = Math.floor(gx * cellW + cellW / 2);
                const y = Math.floor(scanOffset + gy * cellH + cellH / 2);
                
                // [REJECTION] Area-Averaged Sampling (Radius 2 = 5x5 block)
                // This "dilutes" stars into the background, making them invisible to the DP.
                const y1 = Math.max(0, y - 8); 
                const y2 = Math.min(h - 1, y + 8);
                const avgAbove = this.getAreaAverage(lum, x, y1, w, h, 2);
                const avgBelow = this.getAreaAverage(lum, x, y2, w, h, 2);
                const avgCenter = this.getAreaAverage(lum, x, y, w, h, 2);

                const blackLevel = SensorCalibrationManager.getBlackLevel() / 65535;
                const blackSigma = SensorCalibrationManager.getBlackStdDev() / 65535;
                const isGroundFloor = avgBelow < (blackLevel + blackSigma * 3.0);

                // [STRICT] Polarity Awareness: Reward Sky (Light) above Ground (Dark)
                // If avgBelow > avgAbove, it's either noise or a star under the mask.
                const gradI = Math.max(0, avgAbove - avgBelow);
                
                let colorEdge = 0;
                let polarityMult = 1.0;

                if (previewRGB) {
                    const c1 = this.sampleColorRaw(previewRGB, x, y1, w, h);
                    const c2 = this.sampleColorRaw(previewRGB, x, y2, w, h);
                    const l1 = SensorCalibrationManager.getSkyLikelihood(c1[0], c1[1], c1[2]);
                    const l2 = SensorCalibrationManager.getSkyLikelihood(c2[0], c2[1], c2[2]);
                    
                    if (l2 > l1 + 0.1) {
                        polarityMult = 0.05; // Aggressive rejection of ground-above-sky
                    } else if (l1 > 0.6) {
                        colorEdge = (l1 - l2) * 60;
                    }
                }

                // [PENALTY] Point Source Rejection
                // If the center point is brighter than the average, it's a point source.
                const pointRejection = avgCenter > (avgAbove + 0.05) ? (avgCenter * 100) : 0;

                // [BOOST] High reward for transitions that look like Sky -> True Black Floor
                const floorBonus = isGroundFloor ? 2.5 : 1.0;

                // Structural Bonus: Lock onto pre-detected edges
                // Increased to 250 to forcefully hug physical buildings (lighthouse)
                const structuralBonus = edgeMap[gy * gridW + gx] * 250;

                let energy = ((gradI * 200) + colorEdge + structuralBonus - pointRejection) * polarityMult * floorBonus;
                
                // [IMPENETRABLE VOID]
                if (starMap[gy * gridW + gx]) energy = -5000;

                energyMap[gy * gridW + gx] = energy;
                if (energy > colMax) colMax = energy;
            }

            // [ADAPTIVE] Per-Column Normalization
            // Ensures even weak terrain signals are numerically dominant over DP penalties (0.15)
            // This eradicates the "Flat Line" bug by making locally-best candidates always 1.0.
            if (colMax > 0.05) {
                for (let gy = 0; gy < gridH; gy++) {
                    const idx = gy * gridW + gx;
                    if (energyMap[idx] > -1000) { // Don't normalize voids
                        energyMap[idx] /= colMax;
                    }
                }
            }
        }

        // Stage 1.2: Estimate Nominal Horizon (Peak-Biased search)
        let sumNominalY = 0;
        let countNominal = 0;
        for (let gx = 0; gx < gridW; gx++) {
            let columnBestY = -1, maxE = -1;
            // Find the highest energy peak in each column (regardless of threshold)
            for (let gy = 0; gy < gridH; gy++) {
                const e = energyMap[gy * gridW + gx];
                if (e > maxE) {
                    maxE = e;
                    columnBestY = gy;
                }
            }
            if (columnBestY !== -1 && maxE > 0.5) {
                sumNominalY += columnBestY; countNominal++;
            }
        }
        // [ADAPTIVE] Default to 85% depth if no strong edges found
        const nominalGY = countNominal > 0 ? (sumNominalY / countNominal) : (gridH * 0.85);

        // 2. DP Guide Path (Stiffest Seam Tracker)
        const dp = new Float32Array(gridW * gridH).fill(-Infinity);
        const parent = new Int32Array(gridW * gridH);

        for (let gy = 0; gy < gridH; gy++) {
            dp[gy * gridW] = energyMap[gy * gridW];
        }

        for (let gx = 1; gx < gridW; gx++) {
            for (let gy = 0; gy < gridH; gy++) {
                let maxE = -Infinity;
                let bestY = gy;

                // [EXPANDED] Constraint: Max +/- 8 cells vertical deviation per column
                const win = 8; 
                const startY = Math.max(0, gy - win);
                const endY = Math.min(gridH - 1, gy + win);

                for (let prevY = startY; prevY <= endY; prevY++) {
                    const dy = Math.abs(gy - prevY);
                    
                    // [ADAPTIVE] BASELINE ATTRACTION: Penalty for wandering
                    const distFromBaseline = Math.abs(gy - nominalGY);
                    const baselinePenalty = distFromBaseline * 0.002; // Reduced to allow steep descent

                    // [FLEXIBLE] Vertical transition penalty
                    // Stayed at 0.15 - Per-column normalization now makes this the perfect weight
                    const penalty = (dy * dy) * 0.15 + baselinePenalty; 
                    const score = dp[prevY * gridW + (gx - 1)] - penalty;
                    
                    if (score > maxE) {
                        maxE = score;
                        bestY = prevY;
                    }
                }
                dp[gy * gridW + gx] = energyMap[gy * gridW + gx] + maxE;
                parent[gy * gridW + gx] = bestY;
            }
        }

        const guidePath: Point[] = [];
        let curY = 0;
        let maxLastE = -Infinity;
        for (let gy = 0; gy < gridH; gy++) {
            const e = dp[gy * gridW + (gridW - 1)];
            if (e > maxLastE) {
                maxLastE = e;
                curY = gy;
            }
        }

        for (let gx = gridW - 1; gx >= 0; gx--) {
            guidePath.unshift({ x: gx * cellW, y: scanOffset + curY * cellH });
            if (gx > 0) curY = parent[curY * gridW + gx];
        }

        // Smoothing Pass (Moving Average to remove discretization noise)
        // Increased window to 5 for smoother trajectory
        const smoothedPath: Point[] = [];
        for (let i = 0; i < guidePath.length; i++) {
            let sy = 0, count = 0;
            for (let j = -5; j <= 5; j++) {
                const idx = i + j;
                if (idx >= 0 && idx < guidePath.length) {
                    sy += guidePath[idx].y; count++;
                }
            }
            smoothedPath.push({ x: guidePath[i].x, y: sy / count });
        }

        // Stage 2: High-Resolution Local Snap
        const finalPath: Point[] = [];
        const window = 22; 

        for (const p of smoothedPath) {
            const rx = Math.floor(p.x);
            const ry = Math.floor(p.y);
            let bestSnapY = p.y;
            let maxGrad = -1;

            // Constrained local search in full-res buffer
            for (let dy = -window; dy <= window; dy++) {
                const ty = ry + dy;
                if (ty < 1 || ty >= h - 1) continue;
                
                const g = Math.abs(lum[(ty + 1) * w + rx] - lum[(ty - 1) * w + rx]);
                if (g > maxGrad) {
                    maxGrad = g;
                    bestSnapY = ty;
                }
            }
            finalPath.push({ x: p.x, y: bestSnapY });
        }

        return finalPath;
    }

    /**
     * STRUCTURAL EDGE PRE-PASS
     * Detects high-confidence boundaries (lighthouses, coastlines) to guide the DP.
     */
    private static detectStructuralEdges(lum: Float32Array, w: number, h: number, offset: number, scanH: number, gridW: number, gridH: number): Float32Array {
        const edges = new Float32Array(gridW * gridH);
        const cellW = w / gridW;
        const cellH = scanH / gridH;

        for (let gx = 1; gx < gridW - 1; gx++) {
            for (let gy = 1; gy < gridH - 1; gy++) {
                const x = Math.floor(gx * cellW + cellW/2);
                const y = Math.floor(offset + gy * cellH + cellH/2);

                // [SHARP] Structural Sampler (2x2 Minimum)
                // We use the minimum of a 2x2 block to preserve sharp silhouette edges
                // while still ignoring single-pixel spikes (stars).
                const sample = (tx: number, ty: number) => {
                    const p1 = lum[ty * w + tx];
                    const p2 = lum[ty * w + (tx + 1)];
                    const p3 = lum[(ty + 1) * w + tx];
                    const p4 = lum[(ty + 1) * w + (tx + 1)];
                    return Math.min(p1, p2, p3, p4);
                };

                const gX = 
                    (sample(x+1, y-1) + 2*sample(x+1, y) + sample(x+1, y+1)) -
                    (sample(x-1, y-1) + 2*sample(x-1, y) + sample(x-1, y+1));
                
                const gY = 
                    (sample(x-1, y+1) + 2*sample(x, y+1) + sample(x+1, y+1)) -
                    (sample(x-1, y-1) + 2*sample(x, y-1) + sample(x+1, y-1));

                const mag = Math.sqrt(gX*gX + gY*gY);

                // Coherence check: Structural edges (lighthouses) usually have vertical consistency
                // and coastlines have horizontal consistency.
                const isVerticalEdge = Math.abs(gX) > Math.abs(gY) * 2;
                const isHorizontalEdge = Math.abs(gY) > Math.abs(gX) * 2;

                if (mag > 0.05) {
                    edges[gy * gridW + gx] = mag * (isVerticalEdge || isHorizontalEdge ? 1.5 : 1.0);
                }
            }
        }
        return edges;
    }

    /**
     * HELPER: Kernel-Averaged Sampling (Radius R)
     * Dilutes point sources to reveal broad silhouettes.
     */
    private static getAreaAverage(lum: Float32Array, x: number, y: number, w: number, h: number, r: number): number {
        let sum = 0, count = 0;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const tx = x + dx, ty = y + dy;
                if (tx >= 0 && tx < w && ty >= 0 && ty < h) {
                    sum += lum[ty * w + tx];
                    count++;
                }
            }
        }
        return count > 0 ? sum / count : 0;
    }

    /**
     * HELPER: Sample color from interleaved preview buffer
     */
    private static sampleColorRaw(preview: Float32Array, x: number, y: number, fullW: number, fullH: number): [number, number, number] {
        const pPixelCount = preview.length / 3;
        const aspect = fullW / fullH;
        const pW = Math.sqrt(pPixelCount * aspect);
        const scale = pW / fullW;
        const ix = Math.floor(x * scale);
        const iy = Math.floor(y * scale);
        const pWidth = Math.floor(pW);
        const idx = (iy * pWidth + ix) * 3;
        if (idx < 0 || idx >= preview.length - 2) return [0, 0, 0];
        return [preview[idx], preview[idx+1], preview[idx+2]];
    }
    /**
     * Converts a 1D horizon vector into a closed sky polygon.
     */
    public static convertVectorToPolygon(vector: Uint16Array, w: number, h: number): Point[] {
        const poly: Point[] = [{ x: 0, y: 0 }, { x: w, y: 0 }];
        const step = Math.max(1, Math.floor(w / 160));
        
        for (let x = w - 1; x >= 0; x -= step) {
            poly.push({ x, y: vector[x] });
        }
        
        poly.push({ x: 0, y: vector[0] });
        poly.push({ x: 0, y: 0 });
        return poly;
    }
}
