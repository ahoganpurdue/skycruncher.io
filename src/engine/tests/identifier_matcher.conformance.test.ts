/**
 * CONFORMANCE PIN — mechanically fail when a NEW ad-hoc identifier matcher
 * appears in the engine outside the shared module (ultracode 2026-07-10, §3b).
 *
 * Modeled on the extraction-fidelity pin in receipt_serializer.test.ts:42-91
 * (the "superset-plus-exact-additions" allowlist, asserted with set-equality):
 * the set of loose-matcher call sites must EQUAL a reviewed ALLOWLIST — nothing
 * sneaks in unreviewed, nothing sanctioned silently disappears (bidirectional).
 *
 * SIGNATURE SCANNED = the actual bug class the sweep found: BIDIRECTIONAL
 * substring matching (`a.includes(b) || b.includes(a)`) and `.some(x =>
 * … .includes …)` over an identifier collection. Every real misroute
 * (sensor_db, lens_profiles, frame_cache) used exactly this shape; the migration
 * (M1–M5) removed them all, so the only surviving hit is the shared module.
 *
 * NOT SCANNED (deliberately): single-direction `.includes('LITERAL')` on a
 * DISJOINT brand-token set (`metadata_reaper.detectFormatFromMake`:
 * CANON/NIKON/SONY) and exact composite-key lookups (`workbench_store`). These
 * were adversarially REFUTED as non-defects (§1 #2/#3) — they cannot produce a
 * cross-identity misroute, so pinning them here would only add churn/false
 * tripwires. The bidirectional signature is the precise, low-false-positive
 * fingerprint of the class this sweep closed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** a.includes(b) || c.includes(d) — the loose bidirectional substring matcher. */
const BIDIRECTIONAL_INCLUDES = /\.includes\([^)]*\)\s*\|\|\s*[\w.$]+\.includes\(/;
/** foo.some(x => …bar.includes(…)) — a substring scan over a collection. */
const SOME_OVER_INCLUDES = /\.some\(.*?\.includes\(/;

function walk(dir: string, out: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
}

/** Return the set of engine files (relative to src/engine, forward-slashed) that
 *  contain a loose ad-hoc identifier-matcher signature. */
function scanForAdHocMatchers(engineRoot: string): Set<string> {
  const files: string[] = [];
  walk(engineRoot, files);
  const hits = new Set<string>();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      if (BIDIRECTIONAL_INCLUDES.test(line) || SOME_OVER_INCLUDES.test(line)) {
        hits.add(path.relative(engineRoot, file).replace(/\\/g, '/'));
        break;
      }
    }
  }
  return hits;
}

// The ONLY sanctioned home for identifier→registry substring logic. A new entry
// here means someone added an ad-hoc matcher: route it through
// `identifier_matcher` (matchByBody / matchLens / hasWholeToken), or — if it is
// a verified non-defect — add the file to this allowlist WITH a justification.
const ALLOWLIST = new Set<string>([
  'pipeline/m2_hardware/identifier_matcher.ts', // the shared module itself
]);

describe('identifier-matcher conformance — no ad-hoc matchers outside the module', () => {
  it('the loose-matcher call sites equal the reviewed ALLOWLIST (bidirectional pin)', () => {
    expect(scanForAdHocMatchers(ENGINE_ROOT)).toEqual(ALLOWLIST);
  });
});
