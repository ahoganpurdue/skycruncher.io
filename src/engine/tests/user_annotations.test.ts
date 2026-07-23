/**
 * USER ANNOTATIONS (schema 2.12.0) — observer-testimony normalizer + receipt block.
 *
 * Pins: (1) the buildUserAnnotations normalizer — honest-absent on empty/whitespace,
 * full string-typed block on content, string coercion, provenance default/override,
 * deterministic captured_at injection; (2) the additive `user_annotations` receipt
 * block — null-on-absence (byte-identical sacred path), non-null passthrough,
 * serializer survival; (3) the DOCTRINE guard: annotations NEVER leak into the solve
 * (the solution block is untouched whether or not annotations are present).
 */
import { describe, it, expect } from 'vitest';
import {
    buildUserAnnotations,
    type UserAnnotations,
} from '../pipeline/stages/user_annotations';
import { buildReceipt, type ReceiptInputs } from '../pipeline/stages/package';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import type { PlateSolution } from '../types/Main_types';

const AT = '2026-07-11T00:00:00.000Z';

// ── (1) normalizer ──────────────────────────────────────────────────────────

describe('buildUserAnnotations — honest-or-absent normalizer', () => {
    it('returns null when nothing is supplied (null / undefined / {})', () => {
        expect(buildUserAnnotations(null)).toBeNull();
        expect(buildUserAnnotations(undefined)).toBeNull();
        expect(buildUserAnnotations({})).toBeNull();
    });

    it('returns null when every field is empty or whitespace-only (no empty skeleton)', () => {
        expect(buildUserAnnotations({
            description: '', location_text: '   ', sky_bortle_text: '\t',
            rig_notes: null, session_issues: undefined,
        })).toBeNull();
    });

    it('returns a fully string-typed block with the SAME key set when any field has content', () => {
        const a = buildUserAnnotations({ description: 'M31, 20x300s' }, { capturedAt: AT });
        expect(a).not.toBeNull();
        const block = a as UserAnnotations;
        // uniform shape — every field present, trimmed, string-typed
        expect(block.description).toBe('M31, 20x300s');
        expect(block.location_text).toBe('');
        expect(block.sky_bortle_text).toBe('');
        expect(block.rig_notes).toBe('');
        expect(block.session_issues).toBe('');
        expect(Object.keys(block).sort()).toEqual([
            'captured_at', 'description', 'location_text', 'provenance',
            'rig_notes', 'session_issues', 'sky_bortle_text',
        ]);
    });

    it('trims whitespace and coerces non-string values to strings (testimony is never parsed)', () => {
        const a = buildUserAnnotations({
            description: '  windy  ',
            sky_bortle_text: 4 as unknown as string, // a stray number stays TEXT, never a parsed bortle_class
        }, { capturedAt: AT }) as UserAnnotations;
        expect(a.description).toBe('windy');
        expect(a.sky_bortle_text).toBe('4');
        expect(typeof a.sky_bortle_text).toBe('string');
    });

    it('defaults provenance to "user" and honors an explicit "mcp_assisted"', () => {
        expect((buildUserAnnotations({ rig_notes: 'x' }, { capturedAt: AT }) as UserAnnotations).provenance).toBe('user');
        expect((buildUserAnnotations({ rig_notes: 'x' }, { provenance: 'mcp_assisted', capturedAt: AT }) as UserAnnotations).provenance).toBe('mcp_assisted');
        // an unknown provenance falls back to 'user' (never fabricated)
        expect((buildUserAnnotations({ rig_notes: 'x' }, { provenance: 'bogus' as any, capturedAt: AT }) as UserAnnotations).provenance).toBe('user');
    });

    it('captured_at is deterministic when injected; otherwise a valid ISO stamp', () => {
        expect((buildUserAnnotations({ description: 'x' }, { capturedAt: AT }) as UserAnnotations).captured_at).toBe(AT);
        const now = (buildUserAnnotations({ description: 'x' }) as UserAnnotations).captured_at;
        expect(Number.isNaN(Date.parse(now))).toBe(false);
    });
});

// ── (2)-(3) receipt inclusion + doctrine ─────────────────────────────────────

function solution(extra: Partial<PlateSolution> = {}): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20, pixel_scale: 3.6,
        rotation: 0, fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x',
        odds: 1, confidence: 0.9, num_stars: 0, matched_stars: [],
        wcs: { crpix: [500, 500], crval: [10, 20], cd: [[-1e-3, 0], [0, 1e-3]] },
        ...extra,
    } as PlateSolution;
}

function receiptFor(annotations: UserAnnotations | null, sol: PlateSolution | null = solution()): any {
    const i: ReceiptInputs = {
        metadata: null, signal: null, solution: sol, planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, userAnnotations: annotations, imageWidth: 1000, imageHeight: 1000,
    };
    return buildReceipt(i);
}

describe('buildReceipt — user_annotations inclusion', () => {
    it('null-on-absence: an unset/absent annotations input yields user_annotations: null', () => {
        expect(receiptFor(null).user_annotations).toBeNull();
        // omitting the field entirely is equivalent (byte-identical sacred path)
        const i: ReceiptInputs = {
            metadata: null, signal: null, solution: solution(), planets: [], hardware: null,
            forensics: null, scales: null, warnings: [], timestampTrusted: false,
            spcc: undefined, imageWidth: 1000, imageHeight: 1000,
        };
        expect(buildReceipt(i).user_annotations).toBeNull();
    });

    it('surfaces a supplied block verbatim (provenance + captured_at carried)', () => {
        const a = buildUserAnnotations(
            { description: 'test', session_issues: 'clouds rolled in' },
            { provenance: 'mcp_assisted', capturedAt: AT },
        ) as UserAnnotations;
        const r = receiptFor(a);
        expect(r.user_annotations).not.toBeNull();
        expect(r.user_annotations.description).toBe('test');
        expect(r.user_annotations.session_issues).toBe('clouds rolled in');
        expect(r.user_annotations.provenance).toBe('mcp_assisted');
        expect(r.user_annotations.captured_at).toBe(AT);
    });

    it('survives the receipt serializer as plain string data', () => {
        const a = buildUserAnnotations({ rig_notes: 'RASA 8 + ASI2600' }, { capturedAt: AT }) as UserAnnotations;
        const round = JSON.parse(serializeReceipt(receiptFor(a)));
        expect(round.user_annotations.rig_notes).toBe('RASA 8 + ASI2600');
        expect(round.user_annotations.provenance).toBe('user');
    });

    it('DOCTRINE: annotations never leak into the solve — the solution block is identical with or without them', () => {
        const a = buildUserAnnotations({ sky_bortle_text: 'Bortle 9, terrible' }, { capturedAt: AT }) as UserAnnotations;
        const withNotes = receiptFor(a);
        const without = receiptFor(null);
        expect(JSON.stringify(withNotes.solution)).toBe(JSON.stringify(without.solution));
    });

    it('present block does not appear when there is no solve, but is still an honest top-level key', () => {
        const a = buildUserAnnotations({ description: 'unsolved frame notes' }, { capturedAt: AT }) as UserAnnotations;
        const r = receiptFor(a, null);
        expect(r.solution).toBeNull();
        // testimony is independent of the solve — it rides even a no-solve receipt
        expect(r.user_annotations.description).toBe('unsolved frame notes');
    });
});
