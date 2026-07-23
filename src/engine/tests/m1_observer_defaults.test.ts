import { describe, it, expect } from 'vitest';
import { createDefaultHard } from '../pipeline/m1_ingestion/metadata_reaper';

// ─────────────────────────────────────────────────────────────────────────────
// Honest-or-absent observer location (LAW 3): the pipeline no longer fabricates
// a default observer coordinate pair. Absent GPS must propagate as null with
// gps_source 'DEFAULT' — never a hardcoded "Pasadena"/"Malibu" fallback.
// ─────────────────────────────────────────────────────────────────────────────

describe('M1 observer-location defaults (no fabricated coordinates)', () => {
    it('createDefaultHard yields null coordinates with a DEFAULT source', () => {
        const hard = createDefaultHard();
        expect(hard.gps_lat).toBeNull();
        expect(hard.gps_lon).toBeNull();
        expect(hard.gps_source).toBe('DEFAULT');
    });

    it('carries no residual hardcoded default-observer coordinates', () => {
        const hard = createDefaultHard();
        // The retired defaults were 34.0380426 / -118.874663 (Malibu) and
        // 34.1478 / -118.1445 (Pasadena). Neither may resurface.
        expect(hard.gps_lat).not.toBeCloseTo(34.0380426, 3);
        expect(hard.gps_lat).not.toBeCloseTo(34.1478, 3);
        expect(hard.gps_lon).not.toBeCloseTo(-118.874663, 3);
        expect(hard.gps_lon).not.toBeCloseTo(-118.1445, 3);
    });
});
