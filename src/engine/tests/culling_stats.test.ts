/**
 * Step-3 culling counters — owner-reported trust bug (2026-07).
 *
 * The per-reason counts rendered 0 even when stars were culled, because the
 * UI counted anomalies[] only:
 *   - PLANET-routed stars live in planet_candidates[],
 *   - hard-REJECTED candidates are dropped from every list (only the new
 *     m4 assignment-time culling_tally knows about them),
 *   - DEDUPLICATION (the dominant real-world bucket) was missing from the
 *     UI's hardcoded reason list entirely.
 * computeCullingCounts reconciles all three populations.
 */
import { describe, it, expect } from 'vitest';
import { computeCullingCounts } from '../pipeline/m4_signal_detect/culling_stats';
import type { SignalPacket, SignalPoint } from '../types/Main_types';

function pt(reason?: SignalPoint['culling_reason']): SignalPoint {
    return {
        id: 1, x: 0, y: 0, rawX: 0, rawY: 0, flux: 1, peak: 1, peak_value: 1,
        fwhm: 2, circularity: 0.9, ellipticity: 0.1, theta: 0, snr: 10,
        culling_reason: reason
    };
}

function packet(over: Partial<SignalPacket>): SignalPacket {
    return { clean_stars: [], anomalies: [], background_level: 0, noise_floor: 0, ...over };
}

describe('step-3 culling counts (computeCullingCounts)', () => {
    it('returns empty for a null/cull-free packet', () => {
        expect(computeCullingCounts(null)).toEqual([]);
        expect(computeCullingCounts(packet({}))).toEqual([]);
    });

    it('counts DEDUPLICATION anomalies (the bucket the old UI list omitted)', () => {
        const counts = computeCullingCounts(packet({
            anomalies: [pt('DEDUPLICATION'), pt('DEDUPLICATION'), pt('LOW_SNR')]
        }));
        const dedup = counts.find(c => c.reason === 'DEDUPLICATION');
        expect(dedup).toEqual({ reason: 'DEDUPLICATION', visible: 2, dropped: 0 });
        expect(counts.find(c => c.reason === 'LOW_SNR')!.visible).toBe(1);
    });

    it('counts PLANET-routed stars from planet_candidates (always read 0 before)', () => {
        const counts = computeCullingCounts(packet({
            planet_candidates: [pt('PLANET'), pt('PLANET')]
        }));
        expect(counts.find(c => c.reason === 'PLANET')).toEqual({ reason: 'PLANET', visible: 2, dropped: 0 });
    });

    it('reports hard-REJECTED candidates from the m4 tally as dropped', () => {
        const counts = computeCullingCounts(packet({
            anomalies: [pt('LOW_SNR')],
            culling_tally: { LOW_SNR: 41, CIRCULARITY: 7 }
        }));
        expect(counts.find(c => c.reason === 'LOW_SNR')).toEqual({ reason: 'LOW_SNR', visible: 1, dropped: 40 });
        // CIRCULARITY was ONLY rejected — still gets a row (visible 0, dropped 7)
        expect(counts.find(c => c.reason === 'CIRCULARITY')).toEqual({ reason: 'CIRCULARITY', visible: 0, dropped: 7 });
    });

    it('never invents dropped counts on pre-tally packets (honest-or-absent)', () => {
        const counts = computeCullingCounts(packet({
            anomalies: [pt('SATELLITE'), pt('SATELLITE')]
            // no culling_tally at all (legacy packet)
        }));
        expect(counts.find(c => c.reason === 'SATELLITE')).toEqual({ reason: 'SATELLITE', visible: 2, dropped: 0 });
    });

    it('keeps a stable display order and ignores NONE', () => {
        const counts = computeCullingCounts(packet({
            anomalies: [pt('DEDUPLICATION'), pt('NONE' as any), pt('TOPOGRAPHY')],
            culling_tally: { DEDUPLICATION: 1, TOPOGRAPHY: 1 }
        }));
        expect(counts.map(c => c.reason)).toEqual(['TOPOGRAPHY', 'DEDUPLICATION']);
    });
});
