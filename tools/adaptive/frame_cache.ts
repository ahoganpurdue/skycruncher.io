/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FRAME CACHE — solve a frame ONCE, cache what the optimizer needs (SANDBOX)
 * ═══════════════════════════════════════════════════════════════════════════
 * The per-image knob optimizer needs, per SOLVED frame: (1) the exact science
 * luminance buffer detection ran on, (2) the fitted WCS (ground-truth projector),
 * (3) metadata (optics/observer), (4) the in-field catalog. The solve is the
 * slow part (large FITS decode + wasm + plate solve, minutes); the knob sweep
 * that follows is seconds. So we solve ONCE and cache to test_results/adaptive/
 * (gitignored), then every sweep loads the cache — no re-solve.
 *
 * Reuses the real pipeline (OrchestratorSession steps 1→4) + the tools/api fs
 * atlas loader; captures the science buffer straight after step2 (only rawBuffer
 * is discarded there, never scienceBuffer) and the WCS after step4.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import { findSensorByCamera } from '@/engine/pipeline/m2_hardware/sensor_db';
import type { WCSTransform } from '@/engine/types/Main_types';
import { bootRealWasm, makeFsAtlasLoader } from '../api/headless_driver';

export interface CatalogCacheStar { ra_hours: number; dec_degrees: number; magnitude_V?: number; gaia_id?: string; }

export interface FrameCacheMeta {
    frame: string;
    width: number;
    height: number;
    wcs: WCSTransform;
    ra_hours: number;
    dec_degrees: number;
    pixel_scale: number;
    confidence: number;
    matched: number;
    // optics / observer (may be partial)
    camera_model?: string;
    focal_length?: number;
    aperture?: number;
    pixel_pitch_um?: number;
    gps_lat?: number;
    gps_lon?: number;
    gps_source?: string;
    timestamp?: string;
    timestamp_source?: string;
    catalog: CatalogCacheStar[];
    solvedAt: string;
}

/** Pixel pitch (µm) for a camera model, via the canonical findSensorByCamera.
 *  Was an inline re-implementation of the PRE-fix matcher (bidirectional
 *  substring, first-hit, no exact-priority) — flags #6/#10, LAW-4 code-in-two-
 *  places that bypassed the fixed matcher entirely ('5D Mark II' -> 6.25µm Mk III,
 *  'Seestar S30' -> S30 Pro IMX585). Now delegates, inheriting exact-first +
 *  overlap-scoring + ambiguity->null + the rule-3 residual guard. */
export function pitchForCamera(model?: string): number | null {
    if (!model) return null;
    return findSensorByCamera(model)?.pixel_size_um ?? null;
}

function f32Path(dir: string, frame: string) { return path.join(dir, `${frame}.f32`); }
function metaPath(dir: string, frame: string) { return path.join(dir, `${frame}.meta.json`); }

export function cacheExists(dir: string, frame: string): boolean {
    return fs.existsSync(f32Path(dir, frame)) && fs.existsSync(metaPath(dir, frame));
}

export function loadCache(dir: string, frame: string): { lum: Float32Array; meta: FrameCacheMeta } {
    const meta: FrameCacheMeta = JSON.parse(fs.readFileSync(metaPath(dir, frame), 'utf8'));
    const buf = fs.readFileSync(f32Path(dir, frame));
    const lum = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return { lum, meta };
}

/**
 * Solve a frame headless and cache (science buffer + WCS + metadata + in-field
 * catalog). Returns null if the frame does not solve (honest — no fake WCS).
 */
export async function solveAndCache(args: {
    filePath: string;
    frame: string;
    atlasRoot: string;      // dir the browser's /atlas/... URLs resolve against (has sectors)
    cacheDir: string;
    catalogRadiusMarginDeg?: number;
}): Promise<FrameCacheMeta | null> {
    bootRealWasm();
    StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(args.atlasRoot));
    try {
        const bytes = fs.readFileSync(args.filePath);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const session = new OrchestratorSession(buffer, { generatePreviews: false });

        await session.step1_Load();
        await session.step2_Extract();
        // Capture the EXACT science buffer detection ran on (survives step2).
        const sci = (session as any).scienceBuffer as Float32Array | null;
        const width = (session as any).imageWidth as number;
        const height = (session as any).imageHeight as number;
        if (!sci || !(sci instanceof Float32Array)) throw new Error(`${args.frame}: no science buffer after step2`);

        await session.step3_Metrology();
        await session.step4_Solve();
        const sol = session.solution;
        if (!sol || !sol.wcs || sol.ra_hours == null) {
            console.warn(`[frame_cache] ${args.frame}: DID NOT SOLVE — no ground truth (honest skip).`);
            return null;
        }
        const meta = (session as any).metadata ?? {};
        const wcs = sol.wcs as WCSTransform;

        // In-field catalog around the solved centre (generous radius).
        const fovDeg = (sol.pixel_scale / 3600) * Math.sqrt(width * width + height * height);
        const radiusDeg = fovDeg * 0.5 + (args.catalogRadiusMarginDeg ?? 0.3);
        const adapter = StarCatalogAdapter.getinstance();
        await adapter.ensureSectorLoaded(sol.ra_hours, sol.dec_degrees, radiusDeg).catch(() => {});
        const obsJd = meta?.timestamp ? new Date(meta.timestamp).getTime() / 86400000 + 2440587.5 : 2451545.0;
        const catStars = await adapter.findStarsInField(sol.ra_hours, sol.dec_degrees, radiusDeg, obsJd);
        const catalog: CatalogCacheStar[] = catStars.map(s => ({
            ra_hours: s.ra_hours, dec_degrees: s.dec_degrees, magnitude_V: s.magnitude_V, gaia_id: s.gaia_id,
        }));

        const cacheMeta: FrameCacheMeta = {
            frame: args.frame, width, height, wcs,
            ra_hours: sol.ra_hours, dec_degrees: sol.dec_degrees, pixel_scale: sol.pixel_scale,
            confidence: sol.confidence, matched: (sol.matched_stars?.length ?? (sol as any).matched ?? 0),
            camera_model: meta.camera_model,
            focal_length: meta.focal_length,
            aperture: meta.aperture,
            pixel_pitch_um: meta.pixel_pitch_um ?? pitchForCamera(meta.camera_model) ?? undefined,
            gps_lat: meta.gps_lat, gps_lon: meta.gps_lon, gps_source: meta.gps_source,
            timestamp: meta.timestamp, timestamp_source: meta.timestamp_source,
            catalog, solvedAt: new Date().toISOString(),
        };

        fs.mkdirSync(args.cacheDir, { recursive: true });
        fs.writeFileSync(f32Path(args.cacheDir, args.frame), Buffer.from(sci.buffer, sci.byteOffset, sci.byteLength));
        fs.writeFileSync(metaPath(args.cacheDir, args.frame), JSON.stringify(cacheMeta, null, 1));
        console.log(`[frame_cache] ${args.frame}: SOLVED ra=${sol.ra_hours.toFixed(4)}h dec=${sol.dec_degrees.toFixed(3)}° scale=${sol.pixel_scale.toFixed(3)}"/px conf=${sol.confidence.toFixed(3)} ${width}x${height} catalog=${catalog.length} cached.`);
        return cacheMeta;
    } finally {
        StarCatalogAdapter.setAtlasLoader(null);
    }
}
