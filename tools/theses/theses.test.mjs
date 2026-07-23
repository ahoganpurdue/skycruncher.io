// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/theses.test.mjs — CSL thesis framework v0 unit gate
// ═══════════════════════════════════════════════════════════════════════════
// Deterministic coverage of the mechanical grader (thesis_lint.mjs) and the
// append-only registry (registry.mjs). Hermetic: every registry test uses a
// throwaway temp dir, so the run never touches the real test_results/theses/.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    lintThesis, THESIS_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS,
    SUBMITTER_CLASSES, TIME_BUDGET_LANES, STAMP_STATUSES,
    assertSubmitterBucketPurity,
} from './thesis_lint.mjs';
import { register, stamp, annotate, get, list } from './registry.mjs';
import { annotateFounding } from './annotate_founding.mjs';

/** A minimal, well-formed thesis that lints ACCEPT (current schema, 0.2.0). */
function goodThesis(overrides = {}) {
    return {
        schema_version: THESIS_SCHEMA_VERSION,
        id: 'T-UNIT-001',
        title: 'unit fixture',
        submitter: 'vitest',
        stage: 'speculative',
        submitter_class: 'HUMAN',
        time_budget: { est_wall_minutes: 30, lane: 'inline' },
        hypothesis: 'x lowers the null so the true peak rises',
        reasoning_mechanism: 'smaller pool => fewer accidental coincidences',
        equations_variables: [{ name: 'K', definition: 'top-K by flux', units: 'count', frozen: false }],
        prior_art: [{ source: 'file', ref: 'docs/GATES.md', claim: 'baselines' }],
        base_rates_domain: { strata: ['rawler-UW'], domain_of_validity: 'rawler-UW only', cross_stratum_reconciliation: '' },
        pass_criteria: [{ id: 'P1', description: 'peak', measurable: 'peakZ >= 4.5', frozen: true }],
        derivative_predictions: ['null decreases'],
        predictions_on_record: 'PASS',
        kill_clause: 'any fail => FAIL',
        deviations_log: [],
        status: 'PRE-REGISTERED',
        verdict_stamps: [],
        links: { arxiv: [], researchgate: [], orcid: [], institutions: [] },
        ...overrides,
    };
}

/** A legacy 0.1.0 thesis: no submitter_class / time_budget (absent-by-design). */
function legacyThesis(overrides = {}) {
    const t = goodThesis({ schema_version: '0.1.0', ...overrides });
    delete t.submitter_class;
    delete t.time_budget;
    return t;
}

describe('thesis_lint — the declarative schema IS the gate', () => {
    it('resolves the schema version from thesis_schema.ts (single source)', () => {
        expect(THESIS_SCHEMA_VERSION).toBe('0.2.0');
    });

    it('exposes the DDIA read-compat window (accepts 0.1.0 AND 0.2.0)', () => {
        expect(SUPPORTED_SCHEMA_VERSIONS).toContain('0.1.0');
        expect(SUPPORTED_SCHEMA_VERSIONS).toContain('0.2.0');
    });

    it('ACCEPTs a well-formed thesis', () => {
        const r = lintThesis(goodThesis());
        expect(r.verdict).toBe('ACCEPT');
        expect(r.reasons).toHaveLength(0);
    });

    it('REJECTs unfrozen criteria', () => {
        const r = lintThesis(goodThesis({ pass_criteria: [{ id: 'P1', description: 'p', measurable: 'z >= 4.5', frozen: false }] }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /frozen/.test(x))).toBe(true);
    });

    it('REJECTs a non-measurable criterion (no number/comparator)', () => {
        const r = lintThesis(goodThesis({ pass_criteria: [{ id: 'P1', description: 'it works', measurable: 'the solve succeeds', frozen: true }] }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /not measurable/.test(x))).toBe(true);
    });

    it('ACCEPTs measurable expressed via keyword (byte-identical)', () => {
        const r = lintThesis(goodThesis({ pass_criteria: [{ id: 'P1', description: 'arm unchanged', measurable: 'libraw arm byte-identical', frozen: true }] }));
        expect(r.verdict).toBe('ACCEPT');
    });

    it('REJECTs a missing kill clause', () => {
        expect(lintThesis(goodThesis({ kill_clause: '' })).verdict).toBe('REJECT');
    });

    it('REJECTs zero derivative predictions', () => {
        const r = lintThesis(goodThesis({ derivative_predictions: [] }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /derivative_predictions/.test(x))).toBe(true);
    });

    it('REJECTs missing domain of validity / strata', () => {
        const r = lintThesis(goodThesis({ base_rates_domain: { strata: [], domain_of_validity: '', cross_stratum_reconciliation: '' } }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /strata/.test(x))).toBe(true);
        expect(r.reasons.some((x) => /domain_of_validity/.test(x))).toBe(true);
    });

    it('REJECTs absent predictions_on_record', () => {
        expect(lintThesis(goodThesis({ predictions_on_record: '' })).verdict).toBe('REJECT');
    });

    it('REJECTs empty prior_art', () => {
        const r = lintThesis(goodThesis({ prior_art: [] }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /prior_art/.test(x))).toBe(true);
    });

    it('ACCEPTs an explicit CARD-ABSENT prior_art entry', () => {
        const r = lintThesis(goodThesis({ prior_art: [{ source: 'card-absent', ref: 'no card covers this', claim: 'honest disclosure' }] }));
        expect(r.verdict).toBe('ACCEPT');
    });

    it('REQUIRES cross-stratum reconciliation for a multi-stratum claim', () => {
        const r = lintThesis(goodThesis({ base_rates_domain: { strata: ['A', 'B'], domain_of_validity: 'both', cross_stratum_reconciliation: '' } }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /cross_stratum_reconciliation/.test(x))).toBe(true);
    });

    it('REJECTs an unknown future schema_version', () => {
        expect(lintThesis(goodThesis({ schema_version: '9.9.9' })).verdict).toBe('REJECT');
    });

    it('warns (not rejects) on a non-PRE-REGISTERED submission status', () => {
        const r = lintThesis(goodThesis({ status: 'PASS' }));
        expect(r.verdict).toBe('ACCEPT');
        expect(r.warnings.some((x) => /status/.test(x))).toBe(true);
    });

    it('REJECTs a non-object', () => {
        expect(lintThesis(null).verdict).toBe('REJECT');
        expect(lintThesis([]).verdict).toBe('REJECT');
    });
});

describe('registry — append-only pre-registration integrity ledger', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-reg-')); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('registers a thesis with a content hash + writes the JSON companion', () => {
        const e = register(goodThesis(), { dir });
        expect(e.id).toBe('T-UNIT-001');
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(e.status).toBe('PRE-REGISTERED');
        expect(e.stamps).toHaveLength(0);
        expect(e.integrity.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'T-UNIT-001.json'))).toBe(true);
    });

    it('refuses a duplicate id (ids are never re-minted)', () => {
        register(goodThesis(), { dir });
        expect(() => register(goodThesis(), { dir })).toThrow(/already registered/);
    });

    it('appends stamps without editing prior records', () => {
        register(goodThesis(), { dir });
        const e1 = stamp({ id: 'T-UNIT-001', status: 'RUNNING', by: 'runner' }, { dir });
        expect(e1.status).toBe('RUNNING');
        const e2 = stamp({ id: 'T-UNIT-001', status: 'PASS', by: 'runner', evidence_pointer: 'commit-abc' }, { dir });
        expect(e2.status).toBe('PASS');
        expect(e2.stamps).toHaveLength(2);
        // the log has 3 physical lines: 1 register + 2 stamps
        const lines = fs.readFileSync(path.join(dir, 'registry.jsonl'), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(3);
    });

    it('rejects an illegal stamp status (PRE-REGISTERED cannot be re-stamped)', () => {
        register(goodThesis(), { dir });
        expect(() => stamp({ id: 'T-UNIT-001', status: 'PRE-REGISTERED' }, { dir })).toThrow();
        for (const s of STAMP_STATUSES) {
            expect(() => stamp({ id: `T-${s}`, status: s }, { dir })).toThrow(/not registered/);
        }
    });

    it('detects a post-registration edit (frozen-content violation)', () => {
        register(goodThesis(), { dir });
        expect(get('T-UNIT-001', { dir }).integrity.ok).toBe(true);
        // tamper with the frozen thesis
        fs.writeFileSync(path.join(dir, 'T-UNIT-001.json'), '{"edited":true}');
        const g = get('T-UNIT-001', { dir });
        expect(g.integrity.ok).toBe(false);
        expect(g.integrity.note).toMatch(/MODIFIED/);
        // a stamp taken after the edit chains the mismatch
        const s = stamp({ id: 'T-UNIT-001', status: 'FAIL' }, { dir });
        expect(s.stamps[s.stamps.length - 1].integrity_ok).toBe(false);
    });

    it('get returns null for an unregistered id; list folds registration order', () => {
        expect(get('NOPE', { dir })).toBeNull();
        register(goodThesis({ id: 'A' }), { dir });
        register(goodThesis({ id: 'B' }), { dir });
        const all = list({ dir });
        expect(all.map((e) => e.id)).toEqual(['A', 'B']);
    });

    it('registers a backfilled thesis at its honest current status', () => {
        const e = register(goodThesis({ id: 'BACKFILL', status: 'PASS' }), { dir, status: 'PASS' });
        expect(e.status).toBe('PASS');
    });
});

// ═══ schema 0.2.0 — submitter_class + time_budget (additive, version-gated) ═══
describe('thesis_lint — schema 0.2.0 additive fields', () => {
    it('ACCEPTs a current-schema (0.2.0) thesis carrying the new fields', () => {
        const r = lintThesis(goodThesis());
        expect(r.verdict).toBe('ACCEPT');
        expect(r.reasons).toHaveLength(0);
    });

    it('ACCEPTs a legacy 0.1.0 thesis with NO submitter_class/time_budget (DDIA read-compat)', () => {
        const t = legacyThesis();
        expect(t.submitter_class).toBeUndefined();
        expect(t.time_budget).toBeUndefined();
        const r = lintThesis(t);
        expect(r.verdict).toBe('ACCEPT');
        expect(r.reasons).toHaveLength(0);
    });

    it('accepts every submitter_class enum value at 0.2.0', () => {
        for (const sc of SUBMITTER_CLASSES) {
            expect(lintThesis(goodThesis({ submitter_class: sc })).verdict).toBe('ACCEPT');
        }
    });

    it('REJECTs a 0.2.0 thesis missing submitter_class', () => {
        const t = goodThesis(); delete t.submitter_class;
        const r = lintThesis(t);
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /submitter_class: missing/.test(x))).toBe(true);
    });

    it('REJECTs a 0.2.0 thesis missing time_budget', () => {
        const t = goodThesis(); delete t.time_budget;
        const r = lintThesis(t);
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /time_budget: missing/.test(x))).toBe(true);
    });

    it('REJECTs a bad submitter_class enum value at 0.2.0', () => {
        const r = lintThesis(goodThesis({ submitter_class: 'ROBOT' }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /submitter_class/.test(x))).toBe(true);
    });

    it('REJECTs a bad time_budget.lane at 0.2.0', () => {
        const r = lintThesis(goodThesis({ time_budget: { est_wall_minutes: 10, lane: 'yesterday' } }));
        expect(r.verdict).toBe('REJECT');
        expect(r.reasons.some((x) => /time_budget\.lane/.test(x))).toBe(true);
    });

    it('REJECTs a non-positive time_budget.est_wall_minutes at 0.2.0', () => {
        expect(lintThesis(goodThesis({ time_budget: { est_wall_minutes: 0, lane: 'inline' } })).verdict).toBe('REJECT');
        expect(lintThesis(goodThesis({ time_budget: { est_wall_minutes: -5, lane: 'overnight' } })).verdict).toBe('REJECT');
    });

    it('accepts both time_budget lanes', () => {
        for (const lane of TIME_BUDGET_LANES) {
            expect(lintThesis(goodThesis({ time_budget: { est_wall_minutes: 5, lane } })).verdict).toBe('ACCEPT');
        }
    });

    it('WARNS (never rejects) on additive-pending fields carried by a legacy 0.1.0 entry', () => {
        // A banked draft at 0.1.0 that already carries the new fields with a bad value.
        const t = legacyThesis();
        t.submitter_class = 'ROBOT';
        t.time_budget = { est_wall_minutes: 0, lane: 'nope' };
        const r = lintThesis(t);
        expect(r.verdict).toBe('ACCEPT');
        expect(r.warnings.some((x) => /submitter_class/.test(x))).toBe(true);
        expect(r.warnings.some((x) => /time_budget/.test(x))).toBe(true);
    });

    it('still REJECTs an unknown/future schema generation (outside the compat window)', () => {
        expect(lintThesis(goodThesis({ schema_version: '9.9.9' })).verdict).toBe('REJECT');
    });
});

// ═══ base-rate-integrity guard: AI-RESEARCHER never pools with HUMAN ═════════
describe('assertSubmitterBucketPurity — the no-pooling invariant', () => {
    it('a pure AI-RESEARCHER bucket is OK', () => {
        const r = assertSubmitterBucketPurity([{ submitter_class: 'AI-RESEARCHER' }, { submitter_class: 'AI-RESEARCHER' }]);
        expect(r.ok).toBe(true);
        expect(r.violations).toHaveLength(0);
    });

    it('a pure HUMAN bucket is OK', () => {
        expect(assertSubmitterBucketPurity([{ submitter_class: 'HUMAN' }, { submitter_class: 'HUMAN' }]).ok).toBe(true);
    });

    it('mixing AI-RESEARCHER with HUMAN is a VIOLATION', () => {
        const r = assertSubmitterBucketPurity([{ submitter_class: 'AI-RESEARCHER' }, { submitter_class: 'HUMAN' }]);
        expect(r.ok).toBe(false);
        expect(r.violations.some((v) => /AI-RESEARCHER pooled with/.test(v))).toBe(true);
    });

    it('mixing AI-RESEARCHER with legacy-unclassed entries is a VIOLATION', () => {
        const r = assertSubmitterBucketPurity([{ submitter_class: 'AI-RESEARCHER' }, { /* no class */ }]);
        expect(r.ok).toBe(false);
    });

    it('an empty/non-array input is handled honestly', () => {
        expect(assertSubmitterBucketPurity([]).ok).toBe(true);
        expect(assertSubmitterBucketPurity(null).ok).toBe(false);
    });
});

// ═══ registry annotation record kind (0.2.0, additive) + chain integrity ═════
describe('registry — append-only annotation record (0.2.0)', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-anno-')); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('appends an annotation without editing prior records; folds annotations[]', () => {
        register(goodThesis(), { dir });
        const e = annotate({ id: 'T-UNIT-001', annotation_type: 'provenance', fields: { submitter_class: 'AI-RESEARCHER' }, by: 'test', authorized_by: 'owner' }, { dir });
        expect(e.annotations).toHaveLength(1);
        expect(e.annotations[0].fields.submitter_class).toBe('AI-RESEARCHER');
        expect(e.annotations[0].authorized_by).toBe('owner');
        // physical log: 1 register + 1 annotate, no prior line rewritten
        const lines = fs.readFileSync(path.join(dir, 'registry.jsonl'), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).kind).toBe('register');
        expect(JSON.parse(lines[1]).kind).toBe('annotate');
    });

    it('chain integrity is PRESERVED across an annotation (integrity_ok true, unmodified)', () => {
        register(goodThesis(), { dir });
        const e = annotate({ id: 'T-UNIT-001', annotation_type: 'provenance', fields: { submitter_class: 'AI-RESEARCHER' } }, { dir });
        expect(e.annotations[0].integrity_ok).toBe(true);
        expect(e.integrity.ok).toBe(true);
        // stamps taken AFTER an annotation still chain cleanly (the frozen file is untouched)
        const s = stamp({ id: 'T-UNIT-001', status: 'RUNNING' }, { dir });
        expect(s.stamps[s.stamps.length - 1].integrity_ok).toBe(true);
        expect(s.annotations).toHaveLength(1);
    });

    it('an annotation NEVER mutates the frozen thesis file (hash unchanged)', () => {
        const r0 = register(goodThesis(), { dir });
        annotate({ id: 'T-UNIT-001', annotation_type: 'provenance', fields: { submitter_class: 'AI-RESEARCHER' } }, { dir });
        expect(get('T-UNIT-001', { dir }).sha256).toBe(r0.sha256);
        expect(get('T-UNIT-001', { dir }).integrity.ok).toBe(true);
    });

    it('an annotation after a post-registration edit chains the mismatch (integrity_ok false)', () => {
        register(goodThesis(), { dir });
        fs.writeFileSync(path.join(dir, 'T-UNIT-001.json'), '{"edited":true}');
        const e = annotate({ id: 'T-UNIT-001', annotation_type: 'provenance' }, { dir });
        expect(e.annotations[e.annotations.length - 1].integrity_ok).toBe(false);
    });

    it('rejects annotating an unregistered id and a missing annotation_type', () => {
        expect(() => annotate({ id: 'NOPE', annotation_type: 'provenance' }, { dir })).toThrow(/not registered/);
        register(goodThesis(), { dir });
        expect(() => annotate({ id: 'T-UNIT-001' }, { dir })).toThrow(/annotation_type/);
    });

    it('annotateFounding is idempotent and honest-absent', () => {
        // honest-absent when the founding id is not registered
        expect(annotateFounding({ dir }).applied).toBe(false);
        // register the founding id, then apply → applied once, no-op on re-run
        register(goodThesis({ id: 'THESIS-2026-07-10-001' }), { dir });
        const first = annotateFounding({ dir });
        expect(first.applied).toBe(true);
        expect(first.entry.annotations[0].fields.submitter_class).toBe('AI-RESEARCHER');
        const second = annotateFounding({ dir });
        expect(second.applied).toBe(false);
        expect(/already-annotated/.test(second.reason)).toBe(true);
    });
});
