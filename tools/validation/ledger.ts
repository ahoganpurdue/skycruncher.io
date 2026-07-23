// Append-only JSONL ledger, one file per candidate at
// `test_results/validation/<candidate>.jsonl` (gitignored — a clone has the
// machinery, not the accumulated evidence). Keyed by input_id: append-only on
// disk, last-write-wins on read (idempotent — re-running an input never
// double-counts it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Trial } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root = tools/validation/../.. */
export const REPO_ROOT = path.resolve(HERE, '..', '..');
/** Default ledger root (gitignored). */
export const DEFAULT_LEDGER_DIR = path.join(REPO_ROOT, 'test_results', 'validation');

export class Ledger {
  readonly candidateId: string;
  readonly dir: string;
  readonly file: string;

  constructor(candidateId: string, dir: string = DEFAULT_LEDGER_DIR) {
    this.candidateId = candidateId;
    this.dir = dir;
    this.file = path.join(dir, `${candidateId}.jsonl`);
  }

  /** Append one trial as a JSONL line (creates the dir on first write). */
  append(trial: Trial): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(trial) + '\n', 'utf8');
  }

  /** Every line as written, in order (no dedup) — the full audit history. */
  readRaw(): Trial[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Trial);
  }

  /**
   * Deduped by input_id, last-write-wins — one trial per distinct input, the
   * view the policy/grade engines consume. Deterministic order = first
   * appearance of each input_id.
   */
  read(): Trial[] {
    const byId = new Map<string, Trial>();
    for (const t of this.readRaw()) byId.set(t.input_id, t);
    return [...byId.values()];
  }

  /** Whether a trial for this input_id already exists (idempotency check). */
  has(inputId: string): boolean {
    return this.read().some((t) => t.input_id === inputId);
  }
}
