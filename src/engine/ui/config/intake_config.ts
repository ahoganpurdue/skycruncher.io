/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTAKE HANDOFF CONFIG (brand-neutral, LAW 6 · honest-or-absent, LAW 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The community-intake drop location surfaced by the UnsupportedHandoffCard when
 * an unsupported format (JPEG/TIFF/…) is refused: "leave it in the shared folder
 * with your name and we will process it when support lands."
 *
 * LAW 6 (brand-neutral): the URL/label are CONFIG, never a hard-coded brand
 * endpoint literal. Overridable at build/runtime via Vite env
 * (`VITE_INTAKE_UPLOAD_URL`, `VITE_INTAKE_UPLOAD_LABEL`) so wiring the owner's
 * real Drive folder is a config change, not a code edit.
 *
 * LAW 3 (honest-or-absent applies to LINKS too): the DEFAULT `uploadUrl` is
 * `null`. When null, the card renders the handoff TEXT with NO dead link — an
 * honest "leave it in the shared folder" instruction without a broken hyperlink —
 * until the owner's Drive setup lands and the env value is set. A placeholder
 * link is exactly the LAW-3 violation this avoids.
 */

export interface IntakeConfig {
    /**
     * Public drop-location URL for unsupported-format contributions. `null` until
     * the owner's shared-folder / Drive setup lands (honest-or-absent — no dead
     * link is rendered while this is null).
     */
    uploadUrl: string | null;
    /** Human label for the drop location (brand-neutral default). */
    uploadLabel: string;
}

/** The honest default: no link yet, neutral label. */
export const DEFAULT_INTAKE_CONFIG: IntakeConfig = {
    uploadUrl: null,
    uploadLabel: 'shared community folder',
};

/** Trimmed non-empty string, or null. Keeps blank/whitespace env values honest-absent. */
function nonEmpty(v: unknown): string | null {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * PURE resolver — node-testable without `import.meta`. Reads an env-like bag and
 * returns the intake config, falling back to the honest defaults. An absent or
 * blank `VITE_INTAKE_UPLOAD_URL` yields `uploadUrl: null` (no dead link).
 */
export function resolveIntakeConfig(env?: Record<string, unknown>): IntakeConfig {
    const e = env ?? {};
    return {
        uploadUrl: nonEmpty(e.VITE_INTAKE_UPLOAD_URL),
        uploadLabel: nonEmpty(e.VITE_INTAKE_UPLOAD_LABEL) ?? DEFAULT_INTAKE_CONFIG.uploadLabel,
    };
}

/** Resolve against the live Vite env (browser/build). Safe outside Vite (falls back). */
export function getIntakeConfig(): IntakeConfig {
    let env: Record<string, unknown> = {};
    try {
        env = ((import.meta as unknown as { env?: Record<string, unknown> }).env) ?? {};
    } catch {
        /* non-Vite runtime (node smoke) — honest defaults */
    }
    return resolveIntakeConfig(env);
}
