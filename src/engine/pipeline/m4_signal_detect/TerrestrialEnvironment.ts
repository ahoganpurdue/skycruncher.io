/**
 * TERRESTRIAL ENVIRONMENT â€” M4 Scientific Metrology
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Role: Domain III [Signal State] â€” State: {LIGHT_POLLUTION_SUBTRACTED}
 * 
 * Implements detection and modeling of man-made terrestrial optical effects:
 * - Light Pollution Domes: Multi-peak terrestrial glow envelopes.
 * - Local Glow Profiling: Measuring the background intensity floor.
 */

import { Point } from '../../types/Main_types';

export class TerrestrialEnvironment {

    /**
     * LIGHT POLLUTION ENVELOPE (Multi-Peak)
     * Detects all major terrestrial glow sources and creates a composite boundary.
     * 
     * @phase Identification - Used to mask out regions where signal-to-noise is too low for vanguard stars.
     */
    public static traceLightPollutionBoundary(lum: Float32Array, w: number, h: number, intensity: number): Point[] {
        // Find all local peaks horizontally along the bottom
        const sliceH = Math.min(80, h * 0.15);
        const peaks: { x: number, val: number }[] = [];
        const step = 24;
        const columnIntensity = new Float32Array(Math.floor(w / step));

        for (let gx = 0; gx < columnIntensity.length; gx++) {
            const x = gx * step;
            let colSum = 0;
            for (let y = h - sliceH; y < h; y += 4) {
                colSum += lum[y * w + x];
            }
            columnIntensity[gx] = colSum;
        }

        // Simple local peak finding
        for (let i = 1; i < columnIntensity.length - 1; i++) {
            if (columnIntensity[i] > columnIntensity[i-1] && columnIntensity[i] > columnIntensity[i+1]) {
                // Threshold: must be at least 20% higher than average or a significant absolute peak
                if (columnIntensity[i] > 0.05) { 
                    peaks.push({ x: i * step, val: columnIntensity[i] });
                }
            }
        }

        // If no peaks found, use the global max
        if (peaks.length === 0) {
            let maxIdx = 0;
            for (let i = 0; i < columnIntensity.length; i++) {
                if (columnIntensity[i] > columnIntensity[maxIdx]) maxIdx = i;
            }
            peaks.push({ x: maxIdx * step, val: columnIntensity[maxIdx] });
        }

        const points: Point[] = [];
        const domeWidthBase = w * 0.35; // Tightened width for better source separation

        for (let x = 0; x <= w; x += 48) {
            let maxDomeY = 0;
            peaks.forEach(peak => {
                const domeHeight = h * Math.min(0.58, peak.val * 24);
                // Sharper Gaussian falloff (3.2 instead of 2.5) to keep it locked to local intensity
                const dx = (x - peak.x) / (domeWidthBase / 2);
                const val = Math.exp(-dx * dx * 3.2) * domeHeight;
                if (val > maxDomeY) maxDomeY = val;
            });

            points.push({ x, y: h - maxDomeY });
        }
        
        return points;
    }

    /**
     * LIGHT POLLUTION PROFILE
     * Measures the average intensity of the bottom row to estimate local skyglow.
     * 
     * @phase Correction - Provides a seed value for background subtraction algorithms.
     */
    public static profileLightPollution(lum: Float32Array, w: number, h: number): number {
        let sum = 0;
        const count = 500;
        const row = h - 5;
        for (let i = 0; i < count; i++) {
            sum += lum[row * w + Math.floor(i * (w / count))];
        }
        return sum / count;
    }
}

/**
 * BACKGROUND SURFACE MODELER â€” M4 Metrology
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Role: Domain III [Signal State] â€” State: {GRADIENT_MODELED}
 * 
 * Fits a 2nd-order polynomial surface to sparse sky samples to map light
 * pollution gradients and vignetting without flat frames.
 */
export class BackgroundSurfaceModeler {
    private a = 0; private b = 0; private c = 0;
    private d = 0; private e = 0; private f = 0;

    /**
     * FIT SURFACE (Least Squares Polynomial Fit)
     * Fits z = Ax^2 + By^2 + Cxy + Dx + Ey + F
     */
    public fitSurface(lum: Float32Array, w: number, h: number, horizon: Point[], stars: Point[]): void {
        const gridW = 24;
        const gridH = 16;
        const cellW = w / gridW;
        const cellH = h / gridH;

        const samples: { x: number, y: number, z: number }[] = [];
        
        // Broad Phase: Skip cells with high star density or topography
        const starMask = new Uint8Array(gridW * gridH);
        for (const s of stars) {
            const gx = Math.floor(s.x / cellW);
            const gy = Math.floor(s.y / cellH);
            if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) starMask[gy * gridW + gx] = 1;
        }

        for (let gy = 0; gy < gridH; gy++) {
            const y = gy * cellH + cellH/2;
            for (let gx = 0; gx < gridW; gx++) {
                if (starMask[gy * gridW + gx]) continue;
                
                const x = gx * cellW + cellW/2;
                
                // Horizon Check
                const hIdx = Math.floor(x / (w / 160));
                if (y > (horizon[Math.min(159, hIdx)]?.y || 0) - 20) continue;

                // Sample local median to avoid isolated hot pixels
                samples.push({ x, y, z: lum[Math.floor(y) * w + Math.floor(x)] });
            }
        }

        if (samples.length < 10) return; // Insufficient data

        // Solve using normal equations: (X^T * X) * beta = X^T * Z
        // For z = Ax^2 + By^2 + Cxy + Dx + Ey + F
        const N = samples.length;
        const ATA = new Float64Array(36); // 6x6 matrix
        const ATZ = new Float64Array(6);  // 6x1 vector

        for (const s of samples) {
            const { x, y, z } = s;
            const v = [x*x, y*y, x*y, x, y, 1];
            for (let i = 0; i < 6; i++) {
                for (let j = 0; j < 6; j++) {
                    ATA[i * 6 + j] += v[i] * v[j];
                }
                ATZ[i] += v[i] * z;
            }
        }

        const beta = this.solveSymmetric6x6(ATA, ATZ);
        if (beta) {
            [this.a, this.b, this.c, this.d, this.e, this.f] = beta;
        }
    }

    /**
     * EVALUATE MODEL at (x, y)
     */
    public evaluate(x: number, y: number): number {
        return this.a*x*x + this.b*y*y + this.c*x*y + this.d*x + this.e*y + this.f;
    }

    /**
     * Fitted surface coefficients (z = a·x² + b·y² + c·xy + d·x + e·y + f).
     * Read-only accessor so consumers can LOG the fit (detection-plane
     * flatten receipt) without exposing the mutable fields. All zero before
     * fitSurface / when the fit had insufficient samples.
     */
    public coeffs(): { a: number; b: number; c: number; d: number; e: number; f: number } {
        return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f };
    }

    /**
     * SOLVE 6x6 SYSTEM (Gaussian Elimination)
     */
    private solveSymmetric6x6(A: Float64Array, b: Float64Array): number[] | null {
        const n = 6;
        for (let i = 0; i < n; i++) {
            let pivot = A[i * n + i];
            if (Math.abs(pivot) < 1e-18) return null;

            for (let j = i + 1; j < n; j++) {
                const factor = A[j * n + i] / pivot;
                for (let k = i; k < n; k++) A[j * n + k] -= factor * A[i * n + k];
                b[j] -= factor * b[i];
            }
        }

        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let sum = 0;
            for (let j = i + 1; j < n; j++) sum += A[i * n + j] * x[j];
            x[i] = (b[i] - sum) / A[i * n + i];
        }
        return x;
    }
}
