import { UnitConverter } from '../../core/UnitConverter';

export interface AstrometryPoint {
    x: number;
    y: number;
    id?: number | string;
}

export interface GeometricQuad {
    indices: (number | string)[];
    hashKey: string;
}

export interface QuadDescriptor {
    indices: number[];
    code: [number, number, number, number];
}

/**
 * ASTROMETRY ENGINE â€” The Geometric "Brain" of the Engine
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralizes pattern recognition and geometric hashing.
 * - Quad Hashing (Scale/Rotation invariant)
 * - Triangle Pattern Matching (Tri-Lock)
 * - Spherical distance logic
 */
export class AstrometryEngine {

    /**
     * Build a geometric quad hash key from 4 points.
     * Scale-invariant normalization.
     */
    public static buildQuad(pts: AstrometryPoint[], indices: (number | string)[]): GeometricQuad | null {
        if (pts.length !== 4) return null;

        let maxDistSq = -1;
        let ai = 0, bi = 1;

        for (let i = 0; i < 4; i++) {
            for (let j = i + 1; j < 4; j++) {
                const d2 = Math.pow(pts[i].x - pts[j].x, 2) + Math.pow(pts[i].y - pts[j].y, 2);
                if (d2 > maxDistSq) {
                    maxDistSq = d2;
                    ai = i; bi = j;
                }
            }
        }

        const A = pts[ai];
        const B = pts[bi];
        const others = pts.filter((_, idx) => idx !== ai && idx !== bi);
        const C = others[0];
        const D = others[1];

        const ux = B.x - A.x;
        const uy = B.y - A.y;
        const det = ux * ux + uy * uy;
        if (det < 1e-9) return null;

        const transform = (p: AstrometryPoint) => {
            const dx = p.x - A.x;
            const dy = p.y - A.y;
            return {
                x: (dx * ux + dy * uy) / det,
                y: (-dx * uy + dy * ux) / det
            };
        };

        let tC = transform(C);
        let tD = transform(D);

        // Canonize A/B
        if (tC.x + tD.x > 1) {
            tC = { x: 1 - tC.x, y: -tC.y };
            tD = { x: 1 - tD.x, y: -tD.y };
        }

        // Canonize C/D
        let c_final = tC, d_final = tD;
        if (tC.x > tD.x || (tC.x === tD.x && tC.y > tD.y)) {
            c_final = tD;
            d_final = tC;
        }

        const bin = 0.05; 
        const h = (v: number) => Math.floor(v / bin);
        const key = `${h(c_final.x)},${h(c_final.y)},${h(d_final.x)},${h(d_final.y)}`;

        return { indices, hashKey: key };
    }

    /**
     * Compute scale-invariant triangle descriptors [r1, r2].
     * r1 = side_medium / side_long
     * r2 = side_short / side_long
     */
    public static getTriangleDescriptor(p0: AstrometryPoint, p1: AstrometryPoint, p2: AstrometryPoint): { r1: number, r2: number, longest: number } {
        const d01 = Math.sqrt(Math.pow(p0.x - p1.x, 2) + Math.pow(p0.y - p1.y, 2));
        const d12 = Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
        const d20 = Math.sqrt(Math.pow(p2.x - p0.x, 2) + Math.pow(p2.y - p0.y, 2));

        const sides = [d01, d12, d20].sort((a, b) => b - a);
        return {
            r1: sides[1] / sides[0],
            r2: sides[2] / sides[0],
            longest: sides[0]
        };
    }

    /**
     * Angular distance on a sphere between two RA/Dec points.
     * @param ra1 - Point 1 RA in DEGREES
     * @param dec1 - Point 1 Dec in DEGREES
     * @param ra2 - Point 2 RA in DEGREES
     * @param dec2 - Point 2 Dec in DEGREES
     * @returns Separation in DEGREES.
     */
    public static calculateAngulardistance(ra1: number, dec1: number, ra2: number, dec2: number): number {
        const dLat = UnitConverter.degToRad(dec2 - dec1);
        const dLon = UnitConverter.degToRad(ra2 - ra1);
        const lat1 = UnitConverter.degToRad(dec1);
        const lat2 = UnitConverter.degToRad(dec2);

        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        
        const cRad = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return UnitConverter.radToDeg(cRad);
    }

    /**
     * Generate quads from a set of points (brightest first).
     */
    public static generateQuads(stars: { x: number; y: number }[], maxStars: number = 80): QuadDescriptor[] {
        const descriptors: QuadDescriptor[] = [];
        const limit = Math.min(stars.length, maxStars);
        
        for (let i = 0; i < limit - 3; i++) {
            for (let j = i + 1; j < limit - 2; j++) {
                for (let k = j + 1; k < limit - 1; k++) {
                    for (let l = k + 1; l < limit; l++) {
                        const code = this.buildQuadDescriptor(stars, i, j, k, l);
                        if (code) descriptors.push(code);
                    }
                }
            }
        }
        return descriptors;
    }

    private static buildQuadDescriptor(stars: { x: number; y: number }[], i: number, j: number, k: number, l: number): QuadDescriptor | null {
        const originalIndices = [i, j, k, l];
        const p = [stars[i], stars[j], stars[k], stars[l]];
        
        // 1. Find diagonal (furthest pair for baseline)
        let maxD2 = -1;
        let ai = 0, bi = 1;
        for (let m = 0; m < 4; m++) {
            for (let n = m + 1; n < 4; n++) {
                const d2 = (p[m].x - p[n].x)**2 + (p[m].y - p[n].y)**2;
                if (d2 > maxD2) { maxD2 = d2; ai = m; bi = n; }
            }
        }

        // Map local indices to track their geometric roles
        let idxA = ai, idxB = bi;
        const others = [0, 1, 2, 3].filter(idx => idx !== ai && idx !== bi);
        let idxC = others[0], idxD = others[1];

        const A = p[idxA], B = p[idxB];
        const C = p[idxC], D = p[idxD];

        const ux = B.x - A.x, uy = B.y - A.y;
        const det = ux * ux + uy * uy;
        if (det < 1e-9) return null;

        const transform = (pt: {x: number, y: number}) => ({
            x: ((pt.x - A.x) * ux + (pt.y - A.y) * uy) / det,
            y: (-(pt.x - A.x) * uy + (pt.y - A.y) * ux) / det
        });

        let tC = transform(C);
        let tD = transform(D);

        // 2. Canonize A and B (Ensure C+D center of mass is in the right hemisphere)
        if (tC.x + tD.x > 1) {
            tC = { x: 1 - tC.x, y: -tC.y };
            tD = { x: 1 - tD.x, y: -tD.y };
            // Swap A and B geometric roles
            const tempIdx = idxA; idxA = idxB; idxB = tempIdx;
        }

        // 3. Canonize C and D (Sort logically so codes match consistently)
        if (tC.x > tD.x || (tC.x === tD.x && tC.y > tD.y)) {
            const tempT = tC; tC = tD; tD = tempT;
            // Swap C and D geometric roles
            const tempIdx = idxC; idxC = idxD; idxD = tempIdx;
        }

        // 4. Return the code AND the indices mapped to their strict canonical [A, B, C, D] roles
        return {
            indices: [originalIndices[idxA], originalIndices[idxB], originalIndices[idxC], originalIndices[idxD]],
            code: [tC.x, tC.y, tD.x, tD.y]
        };
    }

    /**
     * Weighted Minkowski distance between quad codes.
     * Supports mirror reflections.
     */
    public static calculateQuaddistanceSq(a: number[], b: number[]): number {
        const d1 = (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2 + (a[3]-b[3])**2;
        // Mirror: y -> -y
        const d2 = (a[0]-b[0])**2 + (a[1]-(-b[1]))**2 + (a[2]-b[2])**2 + (a[3]-(-b[3]))**2;
        return Math.min(d1, d2);
    }
}

