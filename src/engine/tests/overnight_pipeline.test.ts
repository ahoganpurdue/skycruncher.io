// Unit tests for the deterministic overnight pipeline driver's PURE core
// (tools/overnight/rotation.mjs). SYNTHETIC frame set only — ZERO calibrated /
// corpus / disk dependency, so these run in the standard `npx vitest run` gate.
//
// Covers the four non-negotiable properties (spec docs/OVERNIGHT_PIPELINE.md):
//   • idempotency-skip      — a current frame is not re-run
//   • resume-from-checkpoint — a kill+restart resumes only the incomplete frames
//   • OOM/megapixel-skip     — a frame over the ceiling is skipped, never crashes
//   • failure-taxonomy capture — no-dump / oom / no-truth / solve-fail classified
// plus config-hash determinism, rotation ordering, and the truth auto-switch.

import { describe, it, expect } from 'vitest';
import {
  FAILURE,
  DEFAULT_CONFIG,
  canonicalize,
  configHash,
  frameIdOf,
  classifyEligibility,
  frameStatus,
  orderForRotation,
  nextRunIndex,
  computePlan,
  decideTruthAction,
  classifySolve,
  isCr2SolveApplicable,
  decideIntakeAction,
  canClearRaw,
} from '../../../tools/overnight/rotation.mjs';
// The scale-hint knob lives in the truth adapter (its `main()` is import.meta-
// guarded, so importing the pure helper runs no CLI / solve-field).
import { scaleHintBand } from '../../../tools/overnight/astrometry_truth.mjs';

// ── synthetic corpus: 2 solvable CR2 + 1 OOM FITS + 1 no-dump FITS ────────────
const MANIFEST = [
  { path: 'challenge/DSLR/IMG_0001.CR2', megapixels: 18, image_type: 'CR2_DSLR' },
  { path: 'challenge/DSLR/IMG_0002.CR2', megapixels: 18, image_type: 'CR2_DSLR' },
  { path: 'archive/Huge_Cygnus.fits', megapixels: 374, image_type: 'FITS_SEESTAR' },
  { path: 'corpus/M51/no_dump.fit', megapixels: 8, image_type: 'FITS_SEESTAR' },
];
const CONFIG = { ...DEFAULT_CONFIG, mp_ceiling: 100 };
const HASH = configHash(CONFIG);

/** dump exists for the two CR2 frames only. */
const hasDump = (id: string) => id === 'IMG_0001' || id === 'IMG_0002';
/** injectable artifact-presence map (raw + render). */
const present = (set: Set<string>) => (id: string) => set.has(id);

// ── config-hash determinism ───────────────────────────────────────────────────
describe('config hash — deterministic, order-independent, knob-sensitive', () => {
  it('is stable across key ordering', () => {
    expect(configHash({ a: 1, b: 2 })).toBe(configHash({ b: 2, a: 1 }));
  });
  it('changes when a knob that affects artifacts changes', () => {
    expect(configHash({ ...CONFIG, arms: { off: 1, on: 3 } }))
      .not.toBe(configHash({ ...CONFIG, arms: { off: 1, on: 5 } }));
    expect(configHash({ ...CONFIG, budget_ms: 90000 }))
      .not.toBe(configHash({ ...CONFIG, budget_ms: 60000 }));
  });
  it('canonicalize sorts nested keys recursively', () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toEqual({ a: 3, b: { c: 2, d: 1 } });
  });
  it('frameIdOf strips path + extension (matches the sweep enumeration)', () => {
    expect(frameIdOf('challenge/DSLR/IMG_1653.CR2')).toBe('IMG_1653');
    expect(frameIdOf('a\\b\\CSM30803_5DMkIII_iso6400_15s.CR2')).toBe('CSM30803_5DMkIII_iso6400_15s');
  });
});

// ── OOM / megapixel gate + no-dump (eligibility → failure taxonomy) ───────────
describe('OOM/megapixel gate + no-dump classification', () => {
  it('skips a frame over the MP ceiling with the OOM taxonomy (never eligible)', () => {
    const c = classifyEligibility({ megapixels: 374 }, { mpCeiling: 100, hasDump: true });
    expect(c.eligible).toBe(false);
    expect(c.taxonomy).toBe(FAILURE.OOM);
    expect(c.skip_reason).toMatch(/374MP/);
  });
  it('OOM precedes no-dump (a huge frame is skipped before we ever ask for a dump)', () => {
    const c = classifyEligibility({ megapixels: 374 }, { mpCeiling: 100, hasDump: false });
    expect(c.taxonomy).toBe(FAILURE.OOM);
  });
  it('a dump-less frame under the ceiling is no-dump', () => {
    const c = classifyEligibility({ megapixels: 8 }, { mpCeiling: 100, hasDump: false });
    expect(c.eligible).toBe(false);
    expect(c.taxonomy).toBe(FAILURE.NO_DUMP);
  });
  it('a dumped frame under the ceiling is eligible', () => {
    const c = classifyEligibility({ megapixels: 18 }, { mpCeiling: 100, hasDump: true });
    expect(c.eligible).toBe(true);
    expect(c.taxonomy).toBe(FAILURE.OK);
  });
  it('computePlan puts OOM + no-dump into skipped[] and never into toRun (no crash on 374MP)', () => {
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: null, config: CONFIG,
      hasDump, artifactsPresent: present(new Set()), opts: {},
    });
    const tax = Object.fromEntries(plan.skipped.map((s) => [s.id, s.taxonomy]));
    expect(tax['Huge_Cygnus']).toBe(FAILURE.OOM);
    expect(tax['no_dump']).toBe(FAILURE.NO_DUMP);
    expect(plan.toRun).not.toContain('Huge_Cygnus');
    expect(plan.eligible.map((e) => e.id).sort()).toEqual(['IMG_0001', 'IMG_0002']);
  });
});

// ── idempotency: current frames are skipped ───────────────────────────────────
describe('idempotency — skip frames whose artifacts exist + are current', () => {
  it('frameStatus: artifacts present + no checkpoint ⇒ current (adopt pre-existing)', () => {
    expect(frameStatus(null, HASH, true)).toBe('current');
  });
  it('frameStatus: artifacts present + matching-hash checkpoint ⇒ current', () => {
    expect(frameStatus({ config_hash: HASH, status: 'complete' }, HASH, true)).toBe('current');
  });
  it('frameStatus: checkpoint hash differs ⇒ stale (config changed → re-run)', () => {
    expect(frameStatus({ config_hash: 'OTHER', status: 'complete' }, HASH, true)).toBe('stale');
  });
  it('frameStatus: no artifacts + no checkpoint ⇒ never', () => {
    expect(frameStatus(null, HASH, false)).toBe('never');
  });
  it('a fully-current corpus is a no-op: toRun empty', () => {
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: null, config: CONFIG,
      hasDump, artifactsPresent: present(new Set(['IMG_0001', 'IMG_0002'])), opts: {},
    });
    expect(plan.toRun).toEqual([]);
    expect(plan.eligible.every((e) => e.status === 'current')).toBe(true);
  });
  it('--force re-runs a current frame', () => {
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: null, config: CONFIG,
      hasDump, artifactsPresent: present(new Set(['IMG_0001', 'IMG_0002'])), opts: { force: true },
    });
    expect(plan.toRun.sort()).toEqual(['IMG_0001', 'IMG_0002']);
  });
  it('a config change makes every checkpointed frame stale → re-run', () => {
    const cp = {
      run_index: 3,
      frames: {
        IMG_0001: { config_hash: 'STALEHASH', status: 'complete', last_run_index: 3 },
        IMG_0002: { config_hash: 'STALEHASH', status: 'complete', last_run_index: 3 },
      },
    };
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: cp, config: CONFIG,
      hasDump, artifactsPresent: present(new Set(['IMG_0001', 'IMG_0002'])), opts: {},
    });
    expect(plan.eligible.every((e) => e.status === 'stale')).toBe(true);
    expect(plan.toRun.sort()).toEqual(['IMG_0001', 'IMG_0002']);
    expect(plan.runIndex).toBe(4); // monotonic, from the stored counter (no clock)
  });
});

// ── resume-from-checkpoint ────────────────────────────────────────────────────
describe('resume-from-checkpoint — a kill+restart resumes only the incomplete', () => {
  it('one frame complete, one interrupted ⇒ toRun is just the interrupted one', () => {
    // IMG_0001 finished (artifacts present, checkpoint current); IMG_0002 was
    // killed mid-run (no artifacts, no checkpoint entry).
    const cp = {
      run_index: 5,
      frames: { IMG_0001: { config_hash: HASH, status: 'complete', last_run_index: 5 } },
    };
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: cp, config: CONFIG,
      hasDump, artifactsPresent: present(new Set(['IMG_0001'])), opts: {},
    });
    expect(plan.toRun).toEqual(['IMG_0002']);        // resumes only the incomplete
    expect(plan.runIndex).toBe(6);
    const s = Object.fromEntries(plan.eligible.map((e) => [e.id, e.status]));
    expect(s['IMG_0001']).toBe('current');
    expect(s['IMG_0002']).toBe('never');
  });
  it('nextRunIndex is a pure function of prior state (deterministic, no wall clock)', () => {
    expect(nextRunIndex(null)).toBe(1);
    expect(nextRunIndex({ run_index: 41 })).toBe(42);
  });
});

// ── rotation ordering ─────────────────────────────────────────────────────────
describe('rotation ordering — never → stale → current, then least-recently-run', () => {
  it('buckets never before stale before current; ties by last_run then id', () => {
    const status: Record<string, string> = { a: 'current', b: 'never', c: 'stale', d: 'never' };
    const lastRun: Record<string, number> = { a: 9, b: -1, c: 2, d: -1 };
    const ordered = orderForRotation(['a', 'b', 'c', 'd'], (x) => status[x], (x) => lastRun[x]);
    expect(ordered).toEqual(['b', 'd', 'c', 'a']); // never(b,d by id) → stale(c) → current(a)
  });
  it('--limit takes the first N of the rotation order', () => {
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: null, config: CONFIG,
      hasDump, artifactsPresent: present(new Set()), opts: { limit: 1 },
    });
    expect(plan.toRun).toHaveLength(1);
    expect(plan.toRun[0]).toBe('IMG_0001'); // never-tested, id-sorted
  });
  it('--frames restricts to an explicit selection', () => {
    const plan = computePlan({
      manifestImages: MANIFEST, checkpoint: null, config: CONFIG,
      hasDump, artifactsPresent: present(new Set()), opts: { frames: ['IMG_0002'] },
    });
    expect(plan.toRun).toEqual(['IMG_0002']);
  });
});

// ── truth auto-switch (NO_TRUTH ⇄ astrometry.net) ────────────────────────────
describe('truth auto-switch — the one decision that flips ON when the install lands', () => {
  it('mode off ⇒ always NO_TRUTH (deterministic fast path)', () => {
    expect(decideTruthAction(true, 'off', null)).toBe('no-truth');
    expect(decideTruthAction(false, 'off', null)).toBe('no-truth');
  });
  it('mode auto ⇒ uses the oracle iff installed, else NO_TRUTH', () => {
    expect(decideTruthAction(false, 'auto', null)).toBe('no-truth'); // not installed yet
    expect(decideTruthAction(true, 'auto', null)).toBe('use');        // install landed → auto ON
  });
  it('a cached label wins in auto mode (idempotent, no re-solve)', () => {
    expect(decideTruthAction(true, 'auto', 'TRUE_POSITIVE')).toBe('cached');
  });
  it('mode on forces the oracle regardless of the probe', () => {
    expect(decideTruthAction(false, 'on', null)).toBe('use');
  });
});

// ── FITS eligibility + stage routing (the fits_dets-dump unblock) ─────────────
describe('FITS routing — a dumped FITS frame is ELIGIBLE (truth+render), solve-A/B is n/a', () => {
  // A CR2 (has dump), a FITS with a fits_dets dump (space in the id, like the real
  // M66 frame), and a 374MP OOM FITS. `hasDump` here models the manifest resolution
  // (dump_available/dump_path → cr2_dets OR fits_dets), NOT the old cr2-only convention.
  const FITS_MANIFEST = [
    { path: 'challenge/DSLR/IMG_0001.CR2', megapixels: 18, image_type: 'CR2_DSLR' },
    { path: 'corpus/M66/DSO_Stacked_738_M 66.fit', megapixels: 8, image_type: 'FITS_SEESTAR' },
    { path: 'archive/Huge_Cygnus.fits', megapixels: 374, image_type: 'FITS_SEESTAR' },
  ];
  const dumpFor = (id: string) => id === 'IMG_0001' || id === 'DSO_Stacked_738_M 66';

  it('a fits_dets-dumped FITS frame is eligible + selected — no longer no-dump', () => {
    const plan = computePlan({
      manifestImages: FITS_MANIFEST, checkpoint: null, config: CONFIG,
      hasDump: dumpFor, artifactsPresent: present(new Set()), opts: {},
    });
    expect(plan.eligible.map((e) => e.id)).toContain('DSO_Stacked_738_M 66');
    expect(plan.skipped.find((s) => s.id === 'DSO_Stacked_738_M 66')).toBeUndefined(); // NOT no-dump
    expect(plan.toRun).toContain('DSO_Stacked_738_M 66');                              // routes truth+render
    // OOM gate still fires for the 374MP FITS (never eligible, never decoded)
    expect(plan.skipped.find((s) => s.id === 'Huge_Cygnus')?.taxonomy).toBe(FAILURE.OOM);
  });

  it('isCr2SolveApplicable gates solve-A/B to the CR2 cohort (FITS solve is n/a)', () => {
    expect(isCr2SolveApplicable('CR2_DSLR')).toBe(true);
    expect(isCr2SolveApplicable('FITS_SEESTAR')).toBe(false);
    expect(isCr2SolveApplicable('FITS_OTHER')).toBe(false);
    expect(isCr2SolveApplicable('JPG_DERIVED')).toBe(false);
    expect(isCr2SolveApplicable(undefined)).toBe(false);
  });
});

// ── scale-hint knob — a bounded search PRIOR built from a known pixel scale ────
// The hint only ACCELERATES solve-field's blind search (its quad-hash verify stays
// the sole arbiter), so this asserts the BAND MATH, not any solve outcome.
describe('scale-hint band — bounded search prior from pixel_scale + tol', () => {
  it('expands pixel_scale into a symmetric ±tol arcsec/px band', () => {
    const b = scaleHintBand(0.7976, 0.25);
    expect(b).not.toBeNull();
    expect(b!.units).toBe('arcsecperpix');
    expect(b!.low).toBeCloseTo(0.7976 * 0.75, 10);   // 0.5982
    expect(b!.high).toBeCloseTo(0.7976 * 1.25, 10);  // 0.9970
    expect(b!.pixel_scale).toBe(0.7976);
    expect(b!.tol).toBe(0.25);
    // symmetric about the known scale
    expect((b!.low + b!.high) / 2).toBeCloseTo(0.7976, 10);
  });
  it('defaults tol to 0.25 when omitted', () => {
    const b = scaleHintBand(2.3927);
    expect(b!.low).toBeCloseTo(2.3927 * 0.75, 10);
    expect(b!.high).toBeCloseTo(2.3927 * 1.25, 10);
    expect(b!.tol).toBe(0.25);
  });
  it('honours a custom (tighter) tolerance', () => {
    const b = scaleHintBand(1.1963, 0.1);
    expect(b!.low).toBeCloseTo(1.1963 * 0.9, 10);
    expect(b!.high).toBeCloseTo(1.1963 * 1.1, 10);
    expect(b!.tol).toBe(0.1);
  });
  it('accepts a numeric-string pixel scale (CLI arg is a string)', () => {
    const b = scaleHintBand('0.7976', 0.25);
    expect(b!.low).toBeCloseTo(0.5982, 4);
    expect(b!.high).toBeCloseTo(0.997, 4);
  });
  it('returns null for a missing/invalid/non-positive scale → BLIND fallback', () => {
    expect(scaleHintBand(null)).toBeNull();
    expect(scaleHintBand(undefined)).toBeNull();
    expect(scaleHintBand(0)).toBeNull();
    expect(scaleHintBand(-1.2)).toBeNull();
    expect(scaleHintBand(NaN)).toBeNull();
    expect(scaleHintBand('not-a-number')).toBeNull();
  });
  it('falls back to the default tol on an invalid tol (never a bogus band)', () => {
    const b = scaleHintBand(2.0, NaN);
    expect(b!.tol).toBe(0.25);
    expect(b!.low).toBeCloseTo(1.5, 10);
    expect(b!.high).toBeCloseTo(2.5, 10);
  });
});

// ── solve-outcome classification (per-frame taxonomy) ─────────────────────────
describe('solve classification — no-lock is data, a thrown/missing arm is solve-fail', () => {
  it('both arms present, no lock ⇒ OK (a valid outcome, not a failure)', () => {
    const c = classifySolve({ locked: false, matched: 0, wall_ms: 100 }, { locked: false, matched: 0, wall_ms: 200 });
    expect(c.taxonomy).toBe(FAILURE.OK);
    expect(c.off?.locked).toBe(false);
    expect(c.on?.locked).toBe(false);
  });
  it('a locked ON arm carries matched + sigma through', () => {
    const c = classifySolve({ locked: false }, { locked: true, matched: 272, sigma: 8.3, wall_ms: 500 });
    expect(c.taxonomy).toBe(FAILURE.OK);
    expect(c.on?.locked).toBe(true);
    expect(c.on?.sigma).toBe(8.3);
  });
  it('a missing arm ⇒ solve-fail', () => {
    expect(classifySolve(null, { locked: false }).taxonomy).toBe(FAILURE.SOLVE_FAIL);
  });
  it('a thrown arm ⇒ solve-fail', () => {
    expect(classifySolve({ locked: false, threw: 'OOM in decode' }, { locked: false }).taxonomy)
      .toBe(FAILURE.SOLVE_FAIL);
  });
});

// ── P0.1 intake auto-invoke gate (opt-in + safe for unattended use) ────────────
describe('decideIntakeAction — a bare run never surprise-fetches; opt-in + config-gated', () => {
  it('not requested ⇒ no fetch (a dev/bare run is never a surprise-fetch, even with a config on disk)', () => {
    const d = decideIntakeAction({ enabled: false, configPath: '/x/intake_sources.json', configExists: true });
    expect(d.run).toBe(false);
    expect(d.reason).toBe('not-requested');
  });
  it('requested but NO config on disk ⇒ honest no-op (loop continues, never crashes)', () => {
    const d = decideIntakeAction({ enabled: true, configPath: '/x/missing.json', configExists: false });
    expect(d.run).toBe(false);
    expect(d.reason).toBe('no-config');
    expect(d.config).toBe('/x/missing.json');
  });
  it('requested AND config present ⇒ fetch (through the signed-provenance path)', () => {
    const d = decideIntakeAction({ enabled: true, configPath: '/x/intake_sources.json', configExists: true });
    expect(d.run).toBe(true);
    expect(d.reason).toBe('requested');
    expect(d.config).toBe('/x/intake_sources.json');
  });
});

// ── P0.2 harvest-before-clear gate (green light only; NEVER deletes) ───────────
describe('canClearRaw — safe-to-clear only when durable derived artifacts exist', () => {
  it('false when the detection dump is missing (scarce artifact not persisted)', () => {
    const g = canClearRaw('IMG_0001', { hasDetectionDump: false, hasLedgerEntry: true });
    expect(g.ok).toBe(false);
    expect(g.missing).toContain('detection_dump');
  });
  it('false when the run-report/ledger entry is missing', () => {
    const g = canClearRaw('IMG_0001', { hasDetectionDump: true, hasLedgerEntry: false });
    expect(g.ok).toBe(false);
    expect(g.missing).toContain('run_report_entry');
  });
  it('false (both missing) — honest-or-absent, never a fabricated pass', () => {
    const g = canClearRaw('IMG_0001', { hasDetectionDump: false, hasLedgerEntry: false });
    expect(g.ok).toBe(false);
    expect(g.missing.sort()).toEqual(['detection_dump', 'run_report_entry']);
  });
  it('true ONLY when BOTH durable artifacts are present (dossier stub NOT required)', () => {
    const g = canClearRaw('IMG_0001', { hasDetectionDump: true, hasLedgerEntry: true });
    expect(g.ok).toBe(true);
    expect(g.missing).toEqual([]);
  });
  it('defaults to false when the predicate object is absent (fail-closed)', () => {
    const g = canClearRaw('IMG_0001');
    expect(g.ok).toBe(false);
    expect(g.missing.sort()).toEqual(['detection_dump', 'run_report_entry']);
  });
});
