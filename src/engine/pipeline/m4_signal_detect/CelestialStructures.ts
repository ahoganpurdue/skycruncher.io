/**
 * CELESTIAL STRUCTURES â€” M4 Scientific Metrology
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Role: Domain II [Astro Localization] â€” State: {INITIAL_QUAD_MATCHED}
 * 
 * Implements detection and modeling of diffuse astronomical structures:
 * - Milky Way Backbone: Centerline of galactic brilliance.
 * - Galactic Ellipses: Grouped diffuse emission regions.
 */

import { Point } from '../../types/Main_types';

export class CelestialStructures {

    /**
     * TRACE MILKY WAY CENTERLINE (Polyline)
     * Fits a smooth path through the most brilliant galactic points.
     * 
     * @phase Identification - Helps prioritize search zones for plate solving anchors.
     */
    public static traceMilkyWayCenterline(stars: {x: number, y: number, brilliance: number}[], horizon: Point[]): Point[] {
        if (stars.length < 5) return [];

        const filtered = stars.filter(p => {
            const gx = Math.floor(p.x / (stars[stars.length-1]?.x / horizon.length || 1));
            const hzY = horizon[Math.min(horizon.length - 1, Math.max(0, gx))]?.y || 4000;
            return p.y < hzY - 10;
        });

        if (filtered.length < 5) return [];
        
        filtered.sort((a, b) => a.x - b.x);
        const buckets = 20;
        const bucketW = (filtered[filtered.length-1].x - filtered[0].x) / buckets;
        const path: Point[] = [];

        for (let i = 0; i < buckets; i++) {
            const bx = filtered[0].x + i * bucketW;
            const inBucket = filtered.filter(p => p.x >= bx && p.x < bx + bucketW);
            
            if (inBucket.length > 0) {
                let sx = 0, sy = 0, sw = 0;
                inBucket.forEach(p => {
                    const weight = Math.pow(p.brilliance, 2);
                    sx += p.x * weight;
                    sy += p.y * weight;
                    sw += weight;
                });
                path.push({ x: sx / sw, y: sy / sw });
            }
        }

        return path;
    }

    /**
     * TRACE MULTI-WAY BOUNDARIES (Stacked Ovals)
     * Groups diffuse brilliance points into a series of overlapping ellipses.
     */
    public static generateMilkyWayEllipses(points: { x: number, y: number, brilliance: number }[], horizon: Point[]): { x: number, y: number, rx: number, ry: number, theta: number }[] {
        const filtered = points.filter(p => {
            const gx = Math.floor(p.x / (points[points.length-1]?.x / horizon.length || 1));
            const hzY = horizon[Math.min(horizon.length - 1, Math.max(0, gx))]?.y || 0;
            return p.y < hzY - 30; // 30px buffer to avoid land contamination
        });

        if (filtered.length < 2) return [];

        const ellipses: { x: number, y: number, rx: number, ry: number, theta: number }[] = [];
        const numEllipses = 5;
        const ptsPerEllipse = Math.ceil(filtered.length / numEllipses);

        for (let i = 0; i < numEllipses; i++) {
            const slice = filtered.slice(i * ptsPerEllipse, (i + 1) * ptsPerEllipse);
            if (slice.length < 3) continue;

            let mx = 0, my = 0;
            slice.forEach(p => { mx += p.x; my += p.y; });
            mx /= slice.length; my /= slice.length;

            let vxx = 0, vyy = 0, vxy = 0;
            slice.forEach(p => {
                const dx = p.x - mx;
                const dy = p.y - my;
                vxx += dx * dx; vyy += dy * dy; vxy += dx * dy;
            });

            const common = Math.sqrt(Math.pow(vxx - vyy, 2) + 4 * vxy * vxy);
            const l1 = (vxx + vyy + common) / 2;
            const l2 = (vxx + vyy - common) / 2;

            ellipses.push({
                x: mx,
                y: my,
                rx: Math.sqrt(l1 / slice.length) * 2.5,
                ry: Math.sqrt(l2 / slice.length) * 2.5,
                theta: 0.5 * Math.atan2(2 * vxy, vxx - vyy)
            });
        }

        return ellipses;
    }
}
