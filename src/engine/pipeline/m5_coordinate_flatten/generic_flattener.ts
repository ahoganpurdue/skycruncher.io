
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * GENERIC FLATTENER â€” The "First Pass" Geometric Corrector
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Applies the INVERSE of the retrieved Lensfun distortion profile.
 * Converts raw sensor coordinates (distorted) to rectilinear coordinates (ideal).
 * 
 * MODEL: Brown-Conrady (Radial Only for Initial Pass)
 * Rd = Ru * (1 + k1*Ru^2 + k2*Ru^4 + k3*Ru^6)
 * 
 * We have Rd (distorted, measured). We need Ru (undistorted, ideal).
 * Solved via Newton-Raphson iteration.
 */

import { DetectedStar } from '../../types/Main_types';
import { OpticsManager, DistortionProfile } from '../../core/optics_manager';

export type DistortionCoefficients = DistortionProfile;

export class GenericFlattener {

    private static readonly MAX_ITERATIONS = 10;
    private static readonly convergence_THRESHOLD = 1e-6;

    /**
     * Flattens a single point from raw sensor space to ideal rectilinear space.
     * 
     * @param x Raw X coordinate (pixels)
     * @param y Raw Y coordinate (pixels)
     * @param width Image width
     * @param height Image height
     * @param coeffs Distortion coefficients
     * @returns { x: number, y: number } Flattened coordinates
     */
    public static flatten(
        x: number, 
        y: number, 
        width: number, 
        height: number, 
        coeffs: DistortionCoefficients
    ): { x: number, y: number } {
        return OpticsManager.removeDistortion(x, y, width, height, coeffs);
    }
    
    /**
     * Unflattens a single point (rectilinear -> distorted).
     * This is the "easy" direction: Rd = Ru * (1 + k1*Ru^2 + k2*Ru^4 + k3*Ru^6)
     */
    public static unflatten(
        x: number,
        y: number,
        width: number,
        height: number,
        coeffs: DistortionCoefficients
    ): { x: number, y: number } {
        return OpticsManager.applyDistortion(x, y, width, height, coeffs);
    }
    
    /**
     * Batch flattening for DetectedStar objects.
     * Preserves all star metadata (flux, fwhm, etc.) while transforming coordinates.
     */
    public static async flattenPoints<T extends { x: number, y: number }>(
        points: T[],
        width: number,
        height: number,
        coeffs: DistortionCoefficients
    ): Promise<T[]> {
        // Prepare arrays for WASM iteration
        const xCoords = new Float64Array(points.length);
        const yCoords = new Float64Array(points.length);
        for (let i = 0; i < points.length; i++) {
            xCoords[i] = points[i].x;
            yCoords[i] = points[i].y;
        }

        const wasm = await import('@/engine/wasm_compute/pkg/wasm_compute');
        const cx = width / 2;
        const cy = height / 2;
        const r_ref = coeffs.r_ref || Math.sqrt(cx * cx + cy * cy);
        
        const idealCoords = wasm.flatten_coordinates(
            xCoords, 
            yCoords, 
            width, 
            height,
            coeffs.k1, coeffs.k2, coeffs.k3 || 0, coeffs.p1, coeffs.p2, r_ref
        );

        return points.map((p, i) => {
            return {
                ...p,
                x: idealCoords[i * 2],
                y: idealCoords[i * 2 + 1]
            };
        });
    }
}

