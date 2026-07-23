import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersionManifest, getSurfaceVersion } from './instrument_manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const REQUIRED_SURFACES = [
    'receipt_schema',
    'capture_record_schema',
    'mcp_server',
    'headless_api_driver',
    'intake_provenance',
    'dossier_schema',
    'desktop_app',
    'binary_layouts',
];

describe('instrument_manifest (Node view of the version manifest)', () => {
    const m = buildVersionManifest();

    it('declares every required surface with a resolved version + anchor', () => {
        const names = m.surfaces.map((s) => s.surface);
        for (const r of REQUIRED_SURFACES) expect(names).toContain(r);
        for (const s of m.surfaces) {
            expect(typeof s.version).toBe('string');
            expect(s.version.length).toBeGreaterThan(0);
            expect(s.version).not.toBe('UNRESOLVED');
            expect(s.changelogAnchor.length).toBeGreaterThan(0);
        }
    });

    it('receipt_schema is read from schema_versions.ts (the real home, not duplicated)', () => {
        const txt = fs.readFileSync(path.join(ROOT, 'src', 'engine', 'pipeline', 'stages', 'schema_versions.ts'), 'utf8');
        const v = txt.match(/RECEIPT_SCHEMA_VERSION\s*=\s*'([^']+)'/)[1];
        expect(getSurfaceVersion('receipt_schema')).toBe(v);
    });

    it('desktop_app is read from package.json version', () => {
        const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
        expect(getSurfaceVersion('desktop_app')).toBe(v);
    });

    it('tauri.conf.json version is reconciled to package.json (drift guard)', () => {
        const pv = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
        const tv = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
        expect(tv).toBe(pv);
    });

    it('every changelogAnchor points at a real file', () => {
        for (const s of m.surfaces) {
            const rel = s.changelogAnchor.split(/\s/)[0];
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
    });

    it('lists all six MCP tools', () => {
        for (const t of ['solve_fits', 'inspect_receipt', 'rig_profiles', 'instrument_status', 'list_widgets', 'render_widget']) {
            expect(m.mcpTools[t]).toBeTruthy();
        }
    });

    it('is byte-for-byte the same manifest the TS view produces (unified truth)', async () => {
        const ts = await import('@/engine/versions/manifest');
        expect(m).toEqual(ts.VERSION_MANIFEST);
    });
});
