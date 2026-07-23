/**
 * G4 — planet-candidate native restore + ephemeris pixel-scale wiring (m4).
 *
 * COORDINATE ledger. Two owner-ruled fixes in signal_processor.ts:
 *
 * 1. restorePacketToNative (science→native un-binning) used to run on
 *    clean_stars/anomalies but never planet_candidates — on 2x2-binned frames
 *    (e.g. CR2) planets rendered at ~half-scale positions in the UI overlay
 *    (SignalGraphStep draws them via nativeToCanvas, i.e. assumes NATIVE
 *    coords). The restore must also be IDEMPOTENT per object: an
 *    ephemeris-confirmed planet can be the SAME SignalPoint in both
 *    clean_stars and planet_candidates (dual-membership — open owner design
 *    item, not changed here), and a naive second pass would double-scale it.
 *
 * 2. The ephemeris planet-match pixel scale was hardcoded to 4µm pitch for
 *    every sensor (SeeStar is 2.9µm, a 5D3 6.25µm) while the measured
 *    metadata.pixel_pitch_um went unused. Owner ruling 2026-07-10: wire the
 *    real value; when pitch is genuinely absent, skip the positional match
 *    with a recorded reason — NEVER a silent fabricated default.
 */
import { describe, it, expect } from 'vitest';
import { SignalProcessor } from '../pipeline/m4_signal_detect/signal_processor';
import { ScaleManager } from '../pipeline/m2_hardware/scale_manager';
import { EphemerisEngine } from '../core/EphemerisEngine';
import type { SignalPacket, SignalPoint } from '../types/Main_types';

/** Minimal valid SignalPoint on the (binned) detection grid. */
function pt(x: number, y: number, fwhm = 4): SignalPoint {
    return {
        id: 0, x, y, rawX: 0, rawY: 0,
        flux: 1, peak: 1, peak_value: 1,
        fwhm, circularity: 1, ellipticity: 0, theta: 0, snr: 100,
    } as SignalPoint;
}

function makePacket(overrides: Partial<SignalPacket>): SignalPacket {
    return {
        clean_stars: [],
        anomalies: [],
        background_level: 0,
        noise_floor: 0,
        ...overrides,
    } as SignalPacket;
}

describe('G4: restorePacketToNative un-bins planet_candidates', () => {
    // 24MP-class frame: native 6000x4000, science (2x2 bin) 3000x2000 —
    // the scienceToNative factor is exactly 2 on each axis.
    const sm = () => new ScaleManager(6000, 4000, 1920);

    it('restores planet_candidates to NATIVE coords exactly like clean_stars/anomalies', () => {
        const clean = pt(1500, 1000, 3);
        const anomaly = pt(10, 20, 4);
        const planet = pt(750, 500, 5);
        const packet = makePacket({
            clean_stars: [clean],
            anomalies: [anomaly],
            planet_candidates: [planet],
        });

        SignalProcessor.restorePacketToNative(packet, sm());

        // clean/anomaly behavior unchanged (regression guard on the refactor)
        expect(clean.x).toBeCloseTo(3000, 9);
        expect(clean.y).toBeCloseTo(2000, 9);
        expect(clean.fwhm).toBeCloseTo(6, 9);
        expect(anomaly.x).toBeCloseTo(20, 9);
        expect(anomaly.y).toBeCloseTo(40, 9);

        // THE G4 FIX: planets are un-binned too (were left at half-scale)
        expect(planet.x).toBeCloseTo(1500, 9);
        expect(planet.y).toBeCloseTo(1000, 9);
        expect(planet.fwhm).toBeCloseTo(10, 9);
        // science-space position archived for forensic traceability
        expect(planet.rawX).toBeCloseTo(750, 9);
        expect(planet.rawY).toBeCloseTo(500, 9);
    });

    it('is idempotent for dual-membership: a shared clean_stars/planet_candidates object is restored ONCE', () => {
        // Held dual-membership design item: an ephemeris-confirmed planet can
        // be the same object in both lists. Restoring it twice would send
        // (1000, 600) -> (4000, 2400) instead of (2000, 1200).
        const shared = pt(1000, 600, 4);
        const packet = makePacket({
            clean_stars: [shared],
            planet_candidates: [shared],
        });

        SignalProcessor.restorePacketToNative(packet, sm());

        expect(shared.x).toBeCloseTo(2000, 9);
        expect(shared.y).toBeCloseTo(1200, 9);
        expect(shared.fwhm).toBeCloseTo(8, 9);
        // rawX archives the ORIGINAL science coordinate, not a half-restored one
        expect(shared.rawX).toBeCloseTo(1000, 9);
        expect(shared.rawY).toBeCloseTo(600, 9);
    });

    it('applies the 2x2 fallback to planets when no ScaleManager is supplied', () => {
        const planet = pt(400, 300, 2);
        const packet = makePacket({ planet_candidates: [planet] });

        SignalProcessor.restorePacketToNative(packet, undefined);

        expect(planet.x).toBe(800);
        expect(planet.y).toBe(600);
        expect(planet.fwhm).toBe(4);
    });

    it('tolerates an absent planet_candidates list (unbinned/FITS-style packets)', () => {
        const clean = pt(100, 100);
        const packet = makePacket({ clean_stars: [clean] });
        expect(() => SignalProcessor.restorePacketToNative(packet, sm())).not.toThrow();
        expect(clean.x).toBeCloseTo(200, 9);
    });
});

describe('rider: ephemerisMatchPixelScale uses the MEASURED pitch (owner-ruled, no fabricated 4µm)', () => {
    it('derives arcsec/px from metadata.pixel_pitch_um, not the retired 4µm literal', () => {
        // SeeStar-class: 2.9µm pitch, unbinned detection grid (width == detectionW)
        const meta = { pixel_pitch_um: 2.9, width: 1080 };
        const scale = SignalProcessor.ephemerisMatchPixelScale(meta, 1080, 250);
        expect(scale).toBeCloseTo(206265 * (0.0029 / 250), 9);
        // and it is NOT the old fabricated value
        expect(scale).not.toBeCloseTo(206265 * (0.004 / 250), 4);
    });

    it('scales the native pitch by the native→detection bin factor on 2x2-binned grids', () => {
        // 60Da-class: 4.3µm native pitch, detection on the 2x2-binned science
        // grid (detectionW = width/2) — effective pitch doubles.
        const meta = { pixel_pitch_um: 4.3, width: 5184 };
        const scale = SignalProcessor.ephemerisMatchPixelScale(meta, 2592, 50);
        expect(scale).toBeCloseTo(206265 * ((4.3 * 2) / 1000 / 50), 9);
    });

    it('returns null (honest skip) when the pitch is absent or unmeasurable — never a default', () => {
        expect(SignalProcessor.ephemerisMatchPixelScale({}, 1000, 250)).toBeNull();
        expect(SignalProcessor.ephemerisMatchPixelScale({ pixel_pitch_um: 0, width: 1000 }, 1000, 250)).toBeNull();
        expect(SignalProcessor.ephemerisMatchPixelScale({ pixel_pitch_um: NaN, width: 1000 }, 1000, 250)).toBeNull();
        expect(SignalProcessor.ephemerisMatchPixelScale({ pixel_pitch_um: '2.9', width: 1000 }, 1000, 250)).toBeNull();
        expect(SignalProcessor.ephemerisMatchPixelScale({ pixel_pitch_um: 2.9, width: 1000 }, 1000, 0)).toBeNull();
    });
});

describe('rider: identifySolarBodies wiring (both paths through the real code)', () => {
    // Fixed observer + epoch; the vitest wasm mock provides a deterministic
    // (crude but stable) ephemeris — the tests below only rely on the code
    // and the test computing positions through the SAME engine + formula.
    const lat = 34.0522;
    const lon = -118.2437;
    const timestamp = '2024-03-20T20:00:00Z';
    const MAJOR_BODIES = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'luna'];
    const w = 3000, h = 2000, fl = 250;

    function visibleBodies() {
        const all = EphemerisEngine.calculateSolarSystem(new Date(timestamp), lat, lon);
        // mirror of identifySolarBodies' visibility filter
        return all.filter((b: any) =>
            MAJOR_BODIES.includes(b.id) && (b.altitude ?? -90) > 0 && b.mag < 6);
    }

    it('has at least one visible major body under the deterministic test ephemeris (precondition)', () => {
        expect(visibleBodies().length).toBeGreaterThan(0);
    });

    it('MEASURED-pitch path: flags a star placed at the pitch-correct predicted offset (the 4µm literal would have missed it)', async () => {
        const body: any = visibleBodies()[0];
        const pitchUm = 2.9;
        const meta: any = {
            timestamp, gps_lat: lat, gps_lon: lon, gps_source: 'FITS',
            pixel_pitch_um: pitchUm, width: w, // unbinned detection grid
            dec_hint: body.dec, // dDec = 0 by construction
        };
        const scaleNew = 206265 * (pitchUm / 1000 / fl);   // measured pitch
        const scaleOld = 206265 * (0.004 / fl);            // retired literal

        // Choose the RA hint so the predicted offset is 120 px at the MEASURED
        // scale. Under the old fabricated 4µm scale the same arcsec offset
        // projects to 120·(2.9/4) = 87 px — 33 px away, OUTSIDE the 15 px gate.
        const offsetArcsec = 120 * scaleNew;
        meta.ra_hint = body.ra - offsetArcsec / (15 * 3600);
        const dRAOldPx = offsetArcsec / scaleOld;
        expect(Math.abs(120 - dRAOldPx)).toBeGreaterThan(15); // discriminating geometry

        const star = pt(w / 2 + 120, h / 2);
        const matches = await (SignalProcessor as any).identifySolarBodies([star], [], w, h, fl, meta);

        expect(matches).toContain(star);
        expect((star as any).isPlanet).toBe(true);
        expect((star as any).label).toBeDefined();
    });

    it('ABSENT-pitch path: skips the positional match (honest degradation) instead of fabricating a scale', async () => {
        const body: any = visibleBodies()[0];
        const meta: any = {
            timestamp, gps_lat: lat, gps_lon: lon, gps_source: 'FITS',
            width: w, // NO pixel_pitch_um
            dec_hint: body.dec,
        };
        // Place the star exactly where the RETIRED 4µm fabrication would have
        // predicted it — under the old code this star WOULD have been flagged.
        const scaleOld = 206265 * (0.004 / fl);
        const offsetArcsec = 100 * scaleOld;
        meta.ra_hint = body.ra - offsetArcsec / (15 * 3600);
        const star = pt(w / 2 + 100, h / 2);

        const matches = await (SignalProcessor as any).identifySolarBodies([star], [], w, h, fl, meta);

        expect(matches).toEqual([]);
        expect((star as any).isPlanet).toBeUndefined();
        expect((star as any).label).toBeUndefined();
    });
});
