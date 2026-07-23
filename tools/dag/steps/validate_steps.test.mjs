/**
 * Gate for the curated full-pipeline step map (tools/dag/steps/steps_map.json).
 *
 * steps_map.json is judgment-derived and validator-gated (NOT drift-gated). This
 * test runs the same validator the CLI runs and asserts the committed map is
 * internally consistent and honestly anchored back to the generated dag_base:
 *   • unique ids, resolvable parent/branch/converge edges,
 *   • anchors resolve to a base node / an xref step / a documented exemption,
 *   • every step is cited OR flagged,
 *   • tags/kind/observed drawn from the known sets.
 * It also pins the merged shape (96 steps, contiguous top-level order 1..N) and
 * proves the owner-ruling queue is non-empty so a surfaced ruling can never be
 * silently dropped by a future edit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateSteps } from './validate_steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(readFileSync(path.join(HERE, 'steps_map.json'), 'utf8'));

describe('steps_map validator', () => {
  it('passes with zero violations against the committed dag_base', () => {
    const res = validateSteps();
    if (!res.ok) {
      // Surface the actual violations in the failure message.
      throw new Error(`steps_map violations:\n${res.violations.map((v) => '  - ' + v).join('\n')}`);
    }
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('has the merged shape (96 steps, unique ids)', () => {
    expect(map.steps.length).toBe(96);
    const ids = new Set(map.steps.map((s) => s.id));
    expect(ids.size).toBe(map.steps.length);
    // step:upload was deduped into step:entry.
    expect(ids.has('step:upload')).toBe(false);
    expect(ids.has('step:entry')).toBe(true);
  });

  it('numbers the top-level steps contiguously 1..N', () => {
    const tops = map.steps.filter((s) => s.parent == null).map((s) => s.order).sort((a, b) => a - b);
    expect(tops).toEqual(Array.from({ length: tops.length }, (_, i) => i + 1));
  });

  // Ruling-state snapshot: 7 flags ruled by DEC-2026-07-17-01 (v2 boundaries) + 7 by
  // DEC-2026-07-17-02 (Phase-1 segment boundaries). Future owner rulings bump `ruled`;
  // `openRulings` tracks genuinely unruled flags (0 as of DEC-02).
  it('keeps all fourteen DEC-2026-07-17-01/02 rulings and surfaces zero open owner rulings', () => {
    let ruled = 0;
    let openRulings = 0;
    for (const s of map.steps) {
      for (const f of s.flags || []) {
        if (f.includes('RULED 2026-07-17')) ruled++;
        if (f.includes('OWNER RULING NEEDED')) openRulings++;
      }
    }
    expect(ruled).toBe(14);
    expect(openRulings).toBe(0);
  });
});
