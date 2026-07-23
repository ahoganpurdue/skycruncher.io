
import { Stamp } from '../../types/schema';

/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * MORPHOLOGICAL bounceR â€” The "Stamping" Engine
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Responsible for the initial "Stamping" phase (Phase 0).
 * It scans the raw linear buffer for significant signal, extracts 
 * sub-frame "stamps" of star candidates, and stores them in RAM 
 * for later scientific analysis (Photometry/PSF).
 */
export class MorphologicalBouncer {

    private static readonly PADDING = 2; // Pixels
    private static readonly MIN_BLOB_SIZE = 4; // Pixels
    private static readonly MAX_BLOB_SIZE = 20000; // Increased to handle Venus/Jupiter bloom
    
    /**
     * Extracts raw pixel stamps from the luminance buffer.
     * Uses a local background subtraction (64x64 grid) and shape filtering.
     * 
     * @param buffer The full-frame normalized luminance data (0.0 - 1.0)
     * @param width Image width
     * @param height Image height
     * @param thresholdSigma Sigma threshold for detection (default 3.0)
     * @returns Array of Stamp objects
     */
    public static extractStamps(
        buffer: Float32Array, 
        width: number, 
        height: number, 
        thresholdSigma: number = 3.0
    ): Stamp[] {
        const stamps: Stamp[] = [];
        const visited = new Uint8Array(width * height);
        
        // 1. Compute local background map (64x64 Grid) to kill gradients (Light Pollution)
        const bgMap = this.computeBackgroundMap(buffer, width, height, 64);
        
        // 2. Calculate global sigma for thresholding relative to local background
        // We use a sample of the background-subtracted data
        let sumSq = 0;
        let count = 0;
        for (let i = 0; i < buffer.length; i += 25) {
            const val = buffer[i] - bgMap[i];
            sumSq += val * val;
            count++;
        }
        const sigma = Math.sqrt(sumSq / count);
        const threshold = 3.5 * sigma; // Slightly higher threshold for "stamping"

        console.log(`[Morphologicalbouncer] Local Background Stats: Sigma=${sigma.toFixed(6)}, Threshold=${threshold.toFixed(6)}`);

        // 3. Scan and Extract
        let stampCounter = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const signal = buffer[idx] - bgMap[idx];
                
                if (signal > threshold && visited[idx] === 0) {
                    // Use background-subtracted logic for flood fill
                    const blob = this.floodFill(buffer, bgMap, width, height, x, y, threshold, visited);
                    
                    if (blob && blob.pixels.length >= this.MIN_BLOB_SIZE) {
                        // Shape Filter: Circularity (Aspect Ratio)
                        // Planets are round. Gradients/Glares/Clouds are often elongated or jagged.
                        const blobWidth = blob.maxX - blob.minX + 1;
                        const blobHeight = blob.maxY - blob.minY + 1;
                        const aspect = Math.max(blobWidth, blobHeight) / Math.min(blobWidth, blobHeight);
                        
                        // Reject "widely off" shapes (e.g. streaks, cloud edges)
                        if (aspect > 2.2) continue;

                        // Create Stamp
                        const stamp = this.createStamp(buffer, width, height, blob, `STAMP_${stampCounter++}`);
                        stamps.push(stamp);
                    }
                }
            }
        }
        
        console.log(`[Morphologicalbouncer] Extracted ${stamps.length} stamps.`);
        return stamps;
    }

    /**
     * Compute a coarse background map using a grid-median approach (Gap 1).
     */
    private static computeBackgroundMap(buffer: Float32Array, width: number, height: number, gridSize: number): Float32Array {
        const bgMap = new Float32Array(width * height);
        const cols = Math.ceil(width / gridSize);
        const rows = Math.ceil(height / gridSize);
        const grid = new Float32Array(cols * rows);

        // 1. Calculate median for each grid cell
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x0 = c * gridSize;
                const y0 = r * gridSize;
                const samples: number[] = [];
                
                // Sample pixels in this block
                for (let sy = 0; sy < gridSize && (y0 + sy) < height; sy += 4) {
                    for (let sx = 0; sx < gridSize && (x0 + sx) < width; sx += 4) {
                        samples.push(buffer[(y0 + sy) * width + (x0 + sx)]);
                    }
                }
                
                if (samples.length > 0) {
                    samples.sort((a, b) => a - b);
                    grid[r * cols + c] = samples[Math.floor(samples.length / 2)];
                }
            }
        }

        // 2. Map grid medians back to full resolution (simple block logic for speed)
        // Optimization: In a more complex engine, we'd use bilinear interpolation here.
        // For Newton, we'll use block assignment as it's the "Gradient Killer" enough for residuals.
        for (let y = 0; y < height; y++) {
            const r = Math.floor(y / gridSize);
            const rIdx = r * cols;
            for (let x = 0; x < width; x++) {
                const c = Math.floor(x / gridSize);
                bgMap[y * width + x] = grid[rIdx + c];
            }
        }

        return bgMap;
    }

    /**
     * Internal Flood Fill
     */
    private static floodFill(
        buffer: Float32Array,
        bgMap: Float32Array,
        width: number,
        height: number,
        startX: number,
        startY: number,
        threshold: number,
        visited: Uint8Array
    ): { minX: number, maxX: number, minY: number, maxY: number, pixels: number[] } | null {
        
        const stack: [number, number][] = [[startX, startY]];
        const pixels: number[] = [];
        
        let minX = startX, maxX = startX;
        let minY = startY, maxY = startY;
        
        // Mark start as visited immediately
        visited[startY * width + startX] = 1;

        while (stack.length > 0) {
            const [cx, cy] = stack.pop()!;
            pixels.push(cy * width + cx); // Store global index
            
            // Update BBox
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            
            // Limit: Increased to handle Venus/Jupiter bloom (20,000 pixels max)
            // The Shape Filter in extractStamps() will handle broad noise.
            if (pixels.length > 20000) return null;

            // Neighbors (4-connected)
            const neighbors = [
                [cx, cy - 1], [cx, cy + 1],
                [cx - 1, cy], [cx + 1, cy]
            ];

            for (const [nx, ny] of neighbors) {
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const nIdx = ny * width + nx;
                    const signal = buffer[nIdx] - bgMap[nIdx];
                    if (visited[nIdx] === 0 && signal > threshold) {
                        visited[nIdx] = 1;
                        stack.push([nx, ny]);
                    }
                }
            }
        }
        
        return { minX, maxX, minY, maxY, pixels };
    }

    /**
     * Slices the stamp from the buffer and creates the proper object
     */
    private static createStamp(
        buffer: Float32Array,
        width: number,
        height: number,
        blob: { minX: number, maxX: number, minY: number, maxY: number, pixels: number[] },
        id: string
    ): Stamp {
        // Add Padding
        const pad = this.PADDING;
        const x1 = Math.max(0, blob.minX - pad);
        const y1 = Math.max(0, blob.minY - pad);
        const x2 = Math.min(width - 1, blob.maxX + pad);
        const y2 = Math.min(height - 1, blob.maxY + pad);
        
        const w = x2 - x1 + 1;
        const h = y2 - y1 + 1;
        
        const stampData = new Float32Array(w * h);
        let peakVal = 0;
        let peakX = 0;
        let peakY = 0;

        // Copy Data
        for (let sy = 0; sy < h; sy++) {
            for (let sx = 0; sx < w; sx++) {
                const gx = x1 + sx;
                const gy = y1 + sy;
                const srcIdx = gy * width + gx;
                const val = buffer[srcIdx];
                
                stampData[sy * w + sx] = val;
                
                if (val > peakVal) {
                    peakVal = val;
                    peakX = gx;
                    peakY = gy;
                }
            }
        }

        return {
            id,
            x: peakX, // Use Peak as rough centroid for now
            y: peakY,
            bbox: [x1, x2, y1, y2],
            data: stampData,
            width: w,
            height: h,
            peak: peakVal
        };
    }
}

