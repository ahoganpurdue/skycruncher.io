import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';

export type SolverStrategy = 'spherical_global' | 'planar_local' | 'ridge_directed';

export interface OpticalBucket {
    name: string;
    minScale: number;
    maxScale: number;
    quadtolerance: number;
    searchRadiusMult: number;
}

export const OPTICAL_BUCKETS: OpticalBucket[] = [
    { name: 'Ultra-Wide (Fisheye)', minScale: 30, maxScale: 9999, quadtolerance: 0.12, searchRadiusMult: 2.0 },
    { name: 'Wide Field', minScale: 5, maxScale: 30, quadtolerance: 0.05, searchRadiusMult: 1.5 },
    { name: 'Telephoto/Telescope', minScale: 1, maxScale: 5, quadtolerance: 0.03, searchRadiusMult: 1.2 },
    { name: 'Deep Space', minScale: 0, maxScale: 1, quadtolerance: 0.02, searchRadiusMult: 1.1 }
];

export function getOpticalBucket(scale: number): OpticalBucket {
    return OPTICAL_BUCKETS.find(b => scale >= b.minScale && scale < b.maxScale) || OPTICAL_BUCKETS[1];
}

export function getSolverChain(focalLength: number): SolverStrategy[] {
    if (focalLength <= 35) return ['spherical_global', 'planar_local'];
    if (focalLength <= 200) return ['planar_local', 'spherical_global'];
    return ['ridge_directed', 'planar_local'];
}
