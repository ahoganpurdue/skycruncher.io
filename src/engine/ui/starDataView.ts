/**
 * STAR-DATA VIEW — pure, Tauri-free logic for the in-app star-data download.
 *
 * Everything the StarDataSection UI decides or formats lives here as a pure
 * function so it is unit-testable without a DOM or a Tauri runtime (the app has
 * no jsdom/@testing-library — same split as StarplateLibraryCard's `parse*` +
 * `fetchStarplatesStatus`). The React container in StarDataSection.tsx is a thin
 * shell over these.
 *
 * LAW 3 (honest-or-absent): a file is "verified" ONLY after a real sha match;
 * present-by-size is reported as its own state and NEVER as done; "done" means
 * `verified_count === file_count` against the manifest's own file count.
 */

// ── IPC payload shapes (mirror src-tauri/src/star_data_fetch.rs serde structs) ──

export interface StarDataFileStatus {
    file: string;
    bytes: number;
    /** "missing" | "present" | "size_mismatch" */
    state: string;
}

export interface StarDataStatus {
    index_root: string;
    manifest_source: string | null;
    release: string | null;
    file_count: number;
    total_bytes: number;
    present_count: number;
    present_bytes: number;
    files: StarDataFileStatus[];
}

export interface StarDataFileResult {
    file: string;
    bytes: number;
    /** "verified" | "missing" | "mismatch" | "error" | "skipped" */
    state: string;
    fetched_bytes: number;
    reason: string | null;
}

export interface StarDataReport {
    phase: string;
    index_root: string;
    manifest_source: string | null;
    release: string | null;
    file_count: number;
    total_bytes: number;
    verified_count: number;
    downloaded_count: number;
    bytes_fetched: number;
    cancelled: boolean;
    complete: boolean;
    files: StarDataFileResult[];
}

export interface StarDataProgress {
    phase: string;
    file: string;
    file_index: number;
    file_count: number;
    file_done_bytes: number;
    file_total_bytes: number;
    overall_done_bytes: number;
    overall_total_bytes: number;
}

// ── formatting ──────────────────────────────────────────────────────────────────

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Base-1024 byte formatting, matching tools/setup/fetch_index.mjs's `fmtBytes`. */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
    if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
    if (n >= KB) return `${(n / KB).toFixed(1)} KB`;
    return `${Math.trunc(n)} B`;
}

/** Clamp a done/total ratio to an integer 0–100 percent (0 when total is 0). */
export function progressPercent(done: number, total: number): number {
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
    const pct = Math.round((done / total) * 100);
    return Math.max(0, Math.min(100, pct));
}

/** Honest per-file label for the STATUS probe (presence + size only, no sha). */
export function statusFileLabel(state: string): string {
    switch (state) {
        case 'present':
            return 'present (not verified)';
        case 'size_mismatch':
            return 'SIZE MISMATCH';
        case 'missing':
            return 'MISSING';
        default:
            return state;
    }
}

/** Honest per-file label for a download/verify RESULT (sha-checked). */
export function resultFileLabel(state: string): string {
    switch (state) {
        case 'verified':
            return 'verified';
        case 'mismatch':
            return 'SHA MISMATCH';
        case 'missing':
            return 'MISSING';
        case 'error':
            return 'ERROR';
        case 'skipped':
            return 'skipped';
        default:
            return state;
    }
}

// ── validation (reject malformed — absent beats fake) ───────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseFileStatus(raw: unknown): StarDataFileStatus | null {
    if (!isObj(raw)) return null;
    if (typeof raw.file !== 'string' || !num(raw.bytes) || typeof raw.state !== 'string') return null;
    return { file: raw.file, bytes: raw.bytes, state: raw.state };
}

/** Validate a `star_data_status` payload; null when unusable. */
export function parseStarDataStatus(raw: unknown): StarDataStatus | null {
    if (!isObj(raw)) return null;
    if (
        typeof raw.index_root !== 'string' ||
        !strOrNull(raw.manifest_source) ||
        !strOrNull(raw.release) ||
        !num(raw.file_count) ||
        !num(raw.total_bytes) ||
        !num(raw.present_count) ||
        !num(raw.present_bytes) ||
        !Array.isArray(raw.files)
    ) {
        return null;
    }
    const files: StarDataFileStatus[] = [];
    for (const f of raw.files) {
        const pf = parseFileStatus(f);
        if (pf == null) return null;
        files.push(pf);
    }
    return {
        index_root: raw.index_root,
        manifest_source: raw.manifest_source,
        release: raw.release,
        file_count: raw.file_count,
        total_bytes: raw.total_bytes,
        present_count: raw.present_count,
        present_bytes: raw.present_bytes,
        files,
    };
}

function parseFileResult(raw: unknown): StarDataFileResult | null {
    if (!isObj(raw)) return null;
    if (
        typeof raw.file !== 'string' ||
        !num(raw.bytes) ||
        typeof raw.state !== 'string' ||
        !num(raw.fetched_bytes) ||
        !strOrNull(raw.reason)
    ) {
        return null;
    }
    return {
        file: raw.file,
        bytes: raw.bytes,
        state: raw.state,
        fetched_bytes: raw.fetched_bytes,
        reason: raw.reason,
    };
}

/** Validate a `star_data_download`/`star_data_verify` report; null when unusable. */
export function parseStarDataReport(raw: unknown): StarDataReport | null {
    if (!isObj(raw)) return null;
    if (
        typeof raw.phase !== 'string' ||
        typeof raw.index_root !== 'string' ||
        !strOrNull(raw.manifest_source) ||
        !strOrNull(raw.release) ||
        !num(raw.file_count) ||
        !num(raw.total_bytes) ||
        !num(raw.verified_count) ||
        !num(raw.downloaded_count) ||
        !num(raw.bytes_fetched) ||
        typeof raw.cancelled !== 'boolean' ||
        typeof raw.complete !== 'boolean' ||
        !Array.isArray(raw.files)
    ) {
        return null;
    }
    const files: StarDataFileResult[] = [];
    for (const f of raw.files) {
        const pf = parseFileResult(f);
        if (pf == null) return null;
        files.push(pf);
    }
    return {
        phase: raw.phase,
        index_root: raw.index_root,
        manifest_source: raw.manifest_source,
        release: raw.release,
        file_count: raw.file_count,
        total_bytes: raw.total_bytes,
        verified_count: raw.verified_count,
        downloaded_count: raw.downloaded_count,
        bytes_fetched: raw.bytes_fetched,
        cancelled: raw.cancelled,
        complete: raw.complete,
        files,
    };
}

function parseProgressField(raw: unknown): StarDataProgress | null {
    if (!isObj(raw)) return null;
    if (
        typeof raw.phase !== 'string' ||
        typeof raw.file !== 'string' ||
        !num(raw.file_index) ||
        !num(raw.file_count) ||
        !num(raw.file_done_bytes) ||
        !num(raw.file_total_bytes) ||
        !num(raw.overall_done_bytes) ||
        !num(raw.overall_total_bytes)
    ) {
        return null;
    }
    return {
        phase: raw.phase,
        file: raw.file,
        file_index: raw.file_index,
        file_count: raw.file_count,
        file_done_bytes: raw.file_done_bytes,
        file_total_bytes: raw.file_total_bytes,
        overall_done_bytes: raw.overall_done_bytes,
        overall_total_bytes: raw.overall_total_bytes,
    };
}

/** Tauri event `{ payload }` wrapper or a bare payload → validated progress. */
export function parseProgressEvent(evt: unknown): StarDataProgress | null {
    if (isObj(evt) && 'payload' in evt) return parseProgressField((evt as { payload: unknown }).payload);
    return parseProgressField(evt);
}

// ── derived display (honest) ────────────────────────────────────────────────────

/** One-line status summary; honest — present-by-size is NOT "verified". */
export function summarizeStatus(status: StarDataStatus): string {
    if (status.file_count === 0) {
        return status.manifest_source == null
            ? 'index not provisioned — no manifest available (offline or empty index folder)'
            : 'manifest lists no data files';
    }
    return `${status.present_count} / ${status.file_count} files present by size · ${formatBytes(status.present_bytes)} of ${formatBytes(status.total_bytes)} · not yet sha-verified`;
}

/** Whether every manifest file is present by size (download still worthwhile to verify). */
export function statusAllPresent(status: StarDataStatus): boolean {
    return status.file_count > 0 && status.present_count === status.file_count;
}

/**
 * First-run banner gate (honest): show the "star data not yet downloaded" nudge
 * whenever the solver's index is NOT fully present locally — i.e. absent /
 * unprovisioned (`file_count === 0`, no manifest reachable) OR partially present
 * (`present_count < file_count`). Hidden only when every manifest file is on disk
 * by size (`statusAllPresent`). This is presence-by-size, never a verified claim —
 * it drives a nudge, not a "done" state.
 */
export function shouldShowStarDataBanner(status: StarDataStatus): boolean {
    return !statusAllPresent(status);
}

/** Honest "done" for a report: complete ONLY when every file sha-verified. */
export function reportIsComplete(report: StarDataReport): boolean {
    return report.file_count > 0 && report.complete && report.verified_count === report.file_count;
}

/** One-line honest summary of a download/verify report. */
export function summarizeReport(report: StarDataReport): string {
    if (report.cancelled) {
        return `CANCELLED — ${report.verified_count} / ${report.file_count} sha-verified so far`;
    }
    if (reportIsComplete(report)) {
        const dl =
            report.downloaded_count > 0
                ? ` (${report.downloaded_count} downloaded, ${formatBytes(report.bytes_fetched)} over the wire)`
                : '';
        return `DONE — ${report.verified_count} / ${report.file_count} files sha-verified${dl}`;
    }
    const bad = report.files.filter((f) => f.state !== 'verified').length;
    return `INCOMPLETE — ${report.verified_count} / ${report.file_count} sha-verified, ${bad} not verified (see per-file below)`;
}

/** Live one-line progress caption for the active transfer. */
export function progressCaption(p: StarDataProgress): string {
    const verb = p.phase === 'verify' ? 'Verifying' : p.phase === 'reassemble' ? 'Reassembling' : 'Downloading';
    return `${verb} ${p.file} (${p.file_index}/${p.file_count}) — ${formatBytes(p.overall_done_bytes)} / ${formatBytes(p.overall_total_bytes)}`;
}

// ── data fetch (injectable invoke; resolves present/absent, never rejects) ──────

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Which R2 star-data release a pass targets — selects the destination root on the
 * Rust side (`index_root` vs `atlas_root`). Mirrors the `kind` command arg in
 * src-tauri/src/star_data_fetch.rs. `'index'` is the default; the index call omits
 * the arg entirely so it stays byte-identical to the pre-atlas invocation.
 */
export type StarDataKind = 'index' | 'atlas';

/** IPC args for a star-data command; `kind` is added ONLY for the atlas release. */
export function starDataArgs(
    baseUrl: string,
    prefix: string,
    kind: StarDataKind = 'index',
): Record<string, unknown> {
    return kind === 'atlas' ? { baseUrl, prefix, kind } : { baseUrl, prefix };
}

export type StarDataStatusOutcome =
    | { kind: 'status'; status: StarDataStatus }
    | { kind: 'error'; reason: string };

/**
 * Invoke `star_data_status`. Resolves to status/error — never rejects.
 * `invokeFn` is injectable for tests; the default path dynamically imports the
 * Tauri core API (browser build never eager-loads it; the caller gates on Tauri).
 * `kind` selects the release/destination (`'index'` default → args unchanged).
 */
export async function fetchStarDataStatus(
    baseUrl: string,
    prefix: string,
    invokeFn?: InvokeFn,
    kind: StarDataKind = 'index',
): Promise<StarDataStatusOutcome> {
    let inv: InvokeFn;
    try {
        inv = invokeFn ?? (await import('@tauri-apps/api/core')).invoke;
    } catch (e) {
        return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
    let raw: unknown;
    try {
        raw = await inv('star_data_status', starDataArgs(baseUrl, prefix, kind));
    } catch (e) {
        return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
    const status = parseStarDataStatus(raw);
    if (status == null) return { kind: 'error', reason: 'malformed star_data_status payload' };
    return { kind: 'status', status };
}
