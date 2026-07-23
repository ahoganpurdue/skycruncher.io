// Type declarations for the live-stack follower (live_stack.mjs). Mirrors the
// runtime exports 1:1 so the .ts chain-proof test (solve_sidecar.test.ts)
// typechecks and the tsc gate stays clean — the .mjs remains the single source
// of behavior. Same proven pattern as tools/stack/fits_io.d.mts.

export interface JournalFrame {
  file: string;
  path: string;
  seq: number;
  frameId: string | null;
  exposureS: number | null;
}

export interface Journal {
  sessionId: string;
  frames: JournalFrame[];
  ended: boolean;
}

/** Read the append-only watcher journal (<sessionDir>/session.jsonl). */
export function readJournal(sessionDir: string): Journal;

/**
 * The Solve-Queue acceptance sidecar as the follower's gate reads it back. The
 * follower requires `accepted === true`; the remaining fields are the measured
 * solve values (see buildSolveSidecar in the Solve Queue).
 */
export interface AcceptedSolve {
  accepted: true;
  frame?: string;
  raHours?: number;
  decDeg?: number;
  scaleArcsecPerPx?: number;
  matched?: number;
  confidence?: number;
  [key: string]: unknown;
}

/**
 * Acceptance gate: returns the parsed sidecar (only when `accepted === true`)
 * for `<solveDir>/<file>.solve.json` or `<solveDir>/<base>.solve.json`, else null.
 */
export function acceptedSolve(solveDir: string, file: string): AcceptedSolve | null;

/** Pick the produced stacker-report cluster with the most members (or null). */
export function primaryResult(report: unknown): unknown;

/** Follow a live session, re-stacking on each new accepted frame. */
export function follow(opts: Record<string, unknown>): Promise<{ passes: number; out: string }>;
