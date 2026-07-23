/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UNIFIED VERSION MANIFEST — one declaration of the semver per SURFACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A single place that answers "what schema/version should this artifact be?"
 * for every versioned SURFACE the instrument ships: the wizard receipt, the
 * capture record, the MCP server + its tools, the headless API driver, the
 * intake provenance record, the community dossier, the desktop app, and the
 * binary-layout contracts (LAW 7 seed).
 *
 * SINGLE SOURCE PER NUMBER (the whole point):
 *   - The STRUCTURE + the manifest-OWNED numbers live in ./surfaces.json (the
 *     one seam both this TS view and the dep-free MCP server read).
 *   - A number that already has a real home is NEVER restated here — it carries
 *     a `ref` in surfaces.json and is resolved from that home:
 *       • receipt_schema  ← RECEIPT_SCHEMA_VERSION (schema_versions.ts)
 *       • desktop_app     ← package.json "version"
 *     so bumping the receipt or the app version in its own home flows through
 *     automatically; nothing here can drift out of sync.
 *
 * SEAM-CLEAN: this module is import-only (no node:fs, browser-safe) so the
 * engine/UI could consume it directly. The Node/MCP world reads the SAME
 * surfaces.json via tools/mcp/instrument_manifest.mjs (a plain .mjs cannot
 * import this .ts), and both resolve receipt/desktop from the identical homes —
 * so the TS manifest and the MCP-returned manifest are the same object by
 * construction (asserted in the test suites).
 */

import surfacesJson from './surfaces.json';
import pkg from '../../../package.json';
import { RECEIPT_SCHEMA_VERSION } from '../pipeline/stages/schema_versions';

export { RECEIPT_SCHEMA_VERSION };

/** One declared surface. `version` is always resolved (literal or ref). */
export interface VersionEntry {
    /** Stable surface id (the manifest key). */
    surface: string;
    /** Resolved semver / schema-generation string. */
    version: string;
    /** Authoritative file/doc section where this surface's version + changes live. */
    changelogAnchor: string;
    /** Verbatim on-disk schema tag when the surface stamps one (e.g. "community-dump/1"). */
    schemaTag?: string;
}

export interface VersionManifest {
    surfaces: VersionEntry[];
    /** Per-tool versions for the MCP server surface. */
    mcpTools: Record<string, string>;
}

/** Raw surfaces.json shape (literal-or-ref). */
interface RawSurface {
    surface: string;
    version?: string;
    ref?: string;
    changelogAnchor: string;
    schemaTag?: string;
}
interface SurfacesFile {
    surfaces: RawSurface[];
    mcpTools: Record<string, string>;
}

const data = surfacesJson as unknown as SurfacesFile;

/** Resolve an externally-homed version ref to its authoritative value. */
function resolveRef(ref: string): string {
    switch (ref) {
        case 'schema_versions:RECEIPT_SCHEMA_VERSION':
            return RECEIPT_SCHEMA_VERSION;
        case 'package.json:version':
            return (pkg as { version: string }).version;
        default:
            throw new Error(`version manifest: unknown ref "${ref}" in surfaces.json`);
    }
}

/** Build the resolved manifest (deterministic; no side effects). */
export function buildVersionManifest(): VersionManifest {
    const surfaces: VersionEntry[] = data.surfaces.map((s) => {
        const version = s.version ?? resolveRef(s.ref ?? '');
        const entry: VersionEntry = { surface: s.surface, version, changelogAnchor: s.changelogAnchor };
        if (s.schemaTag) entry.schemaTag = s.schemaTag;
        return entry;
    });
    return { surfaces, mcpTools: { ...data.mcpTools } };
}

/** The resolved manifest (built once at module load). */
export const VERSION_MANIFEST: VersionManifest = buildVersionManifest();

/** Look up one surface's resolved version, or null if the surface is unknown. */
export function getSurfaceVersion(name: string): string | null {
    return VERSION_MANIFEST.surfaces.find((s) => s.surface === name)?.version ?? null;
}

/** The surface ids this manifest is expected to declare (completeness contract). */
export const REQUIRED_SURFACES = [
    'receipt_schema',
    'capture_record_schema',
    'mcp_server',
    'headless_api_driver',
    'intake_provenance',
    'dossier_schema',
    'desktop_app',
    'binary_layouts',
] as const;
