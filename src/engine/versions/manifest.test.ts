import { describe, it, expect } from 'vitest';
import {
    VERSION_MANIFEST,
    buildVersionManifest,
    getSurfaceVersion,
    RECEIPT_SCHEMA_VERSION,
    REQUIRED_SURFACES,
} from './manifest';
import pkg from '../../../package.json';

describe('unified version manifest (TS view)', () => {
    it('declares every required surface', () => {
        const names = VERSION_MANIFEST.surfaces.map((s) => s.surface);
        for (const r of REQUIRED_SURFACES) expect(names).toContain(r);
    });

    it('every surface has a non-empty version + changelogAnchor', () => {
        expect(VERSION_MANIFEST.surfaces.length).toBeGreaterThanOrEqual(REQUIRED_SURFACES.length);
        for (const s of VERSION_MANIFEST.surfaces) {
            expect(typeof s.version).toBe('string');
            expect(s.version.length).toBeGreaterThan(0);
            expect(s.version).not.toBe('UNRESOLVED');
            expect(typeof s.changelogAnchor).toBe('string');
            expect(s.changelogAnchor.length).toBeGreaterThan(0);
        }
    });

    it('receipt_schema resolves from RECEIPT_SCHEMA_VERSION (single source, no duplication)', () => {
        expect(getSurfaceVersion('receipt_schema')).toBe(RECEIPT_SCHEMA_VERSION);
    });

    it('desktop_app resolves from package.json version (single source)', () => {
        expect(getSurfaceVersion('desktop_app')).toBe((pkg as { version: string }).version);
    });

    it('binary_layouts surface is declared (LAW 7) at 0.5.0 (g15u_stars_arrow entry born, additive)', () => {
        expect(getSurfaceVersion('binary_layouts')).toBe('0.5.0');
    });

    it('lists all six MCP tools with versions', () => {
        for (const t of ['solve_fits', 'inspect_receipt', 'rig_profiles', 'instrument_status', 'list_widgets', 'render_widget']) {
            expect(VERSION_MANIFEST.mcpTools[t]).toBeTruthy();
        }
    });

    it('carries the verbatim schema tags for tagged surfaces', () => {
        const intake = VERSION_MANIFEST.surfaces.find((s) => s.surface === 'intake_provenance');
        const dossier = VERSION_MANIFEST.surfaces.find((s) => s.surface === 'dossier_schema');
        expect(intake?.schemaTag).toBe('skycruncher.intake.provenance/1');
        expect(dossier?.schemaTag).toBe('community-dump/1');
    });

    it('buildVersionManifest is deterministic', () => {
        expect(buildVersionManifest()).toEqual(VERSION_MANIFEST);
    });
});
