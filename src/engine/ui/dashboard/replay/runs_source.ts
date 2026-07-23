/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RUNS SOURCE — enumerate + load capture records for the ★ Replay Dashboard
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three sources feed the run picker, unified behind `RunHandle`:
 *   1. LIVE   — the current session's event bus (streamed, still filling).
 *   2. PAST   — completed runs retained in-memory (`completedRuns` / the
 *               `window.__SKYCRUNCHER_CAPTURE__` mirror, wave-1 substrate).
 *   3. LOADED — a `test_results/runs/*.jsonl` artifact dropped into the UI.
 *
 * `parseRunJsonl` is PURE + defensive (a hostile/partial file yields the valid
 * rows + honest errors, never a throw) so it is unit-testable without a DOM and
 * safe on a file-drop. The browser-store readers are thin and guarded.
 */

import type { CaptureEnvelope } from '../../../events/capture_record';
import { exportAllRuns } from '../../../events/capture_record';

export type RunSourceKind = 'live' | 'past' | 'loaded';

/** A selectable run in the picker. `envelopes` is null for a live run until derived. */
export interface RunHandle {
    id: string;
    kind: RunSourceKind;
    /** Human label for the picker. */
    label: string;
    /** The capture record. For live runs this is derived from the bus each tick. */
    envelopes: CaptureEnvelope[] | null;
}

/** The minimal envelope key set — a row missing any of these is rejected. */
const REQUIRED_KEYS: readonly (keyof CaptureEnvelope)[] = [
    'run_id', 'frame_sha', 'stage_id', 'seq', 't_start', 't_end', 'ms', 'ok',
    'verdict', 'counts', 'warnings', 'payload_ref',
];

/** Is a parsed object a structurally-valid CaptureEnvelope? (defensive) */
export function isCaptureEnvelope(x: unknown): x is CaptureEnvelope {
    if (x == null || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    for (const k of REQUIRED_KEYS) {
        if (!(k in o)) return false;
    }
    return (
        typeof o.stage_id === 'string' &&
        typeof o.seq === 'number' &&
        typeof o.t_start === 'number' &&
        typeof o.t_end === 'number' &&
        typeof o.ms === 'number' &&
        typeof o.ok === 'boolean' &&
        typeof o.counts === 'object' && o.counts != null &&
        Array.isArray(o.warnings)
    );
}

export interface ParsedRun {
    envelopes: CaptureEnvelope[];
    /** 1-based line numbers that failed to parse or validate (honest, not silent). */
    errors: { line: number; reason: string }[];
}

/**
 * Parse a JSONL capture record (one envelope per line). PURE + total: blank
 * lines are skipped; malformed / invalid lines are collected into `errors`
 * instead of throwing, so a dropped file always yields its good rows.
 */
export function parseRunJsonl(text: string): ParsedRun {
    const envelopes: CaptureEnvelope[] = [];
    const errors: { line: number; reason: string }[] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (line === '') return;
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            errors.push({ line: i + 1, reason: 'invalid JSON' });
            return;
        }
        if (!isCaptureEnvelope(obj)) {
            errors.push({ line: i + 1, reason: 'not a capture envelope' });
            return;
        }
        envelopes.push(obj);
    });
    return { envelopes, errors };
}

/** Derive the run id for a loaded record (first stamped run_id, else a fallback). */
export function runIdOf(envelopes: readonly CaptureEnvelope[], fallback: string): string {
    for (const e of envelopes) if (e.run_id) return e.run_id;
    return fallback;
}

/**
 * Enumerate PAST runs retained in the browser (in-memory store + the window
 * mirror). Guarded — returns [] in a headless/Node context. Newest last (the
 * store insertion order).
 */
export function listPastRuns(): RunHandle[] {
    const out: RunHandle[] = [];
    const seen = new Set<string>();

    try {
        const all = exportAllRuns();
        for (const [id, envelopes] of Object.entries(all)) {
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, kind: 'past', label: labelFor(id, envelopes), envelopes });
        }
    } catch {
        /* store unavailable */
    }

    // The window mirror can carry runs from a prior lazy-mount before this
    // module loaded; merge any not already present.
    try {
        const g = globalThis as { window?: { __SKYCRUNCHER_CAPTURE__?: Record<string, CaptureEnvelope[]> } };
        const mirror = g.window?.__SKYCRUNCHER_CAPTURE__;
        if (mirror) {
            for (const [id, envelopes] of Object.entries(mirror)) {
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ id, kind: 'past', label: labelFor(id, envelopes), envelopes });
            }
        }
    } catch {
        /* no window */
    }

    return out;
}

/** A compact, honest label: run id + stage count + duration when derivable. */
export function labelFor(id: string, envelopes: readonly CaptureEnvelope[]): string {
    if (envelopes.length === 0) return id;
    let tStart = Infinity;
    let tEnd = -Infinity;
    for (const e of envelopes) {
        if (e.t_start < tStart) tStart = e.t_start;
        if (e.t_end > tEnd) tEnd = e.t_end;
    }
    const ms = Math.max(0, tEnd - tStart);
    return `${id} · ${envelopes.length} stages · ${(ms / 1000).toFixed(2)}s`;
}
