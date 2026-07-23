/**
 * WIDGET SHELF — receipt acceptance + identity strip, including the greenfield
 * solver-core dump path (so a raw desktop-solve artifact can be dropped/previewed).
 * Pure helpers, node-testable (no DOM).
 */

import { describe, it, expect } from 'vitest';
import { looksLikeReceipt, readIdentity } from '../ui/widgets/WidgetShelf';

const gfCore = (state = 'Solved') => ({
    decision: {
        frame_id: 'M66',
        result: { state, solved: { scale_arcsec_px: 3.679, band: 4, final_verify: { n_matched: 265 }, matches: [] } },
        search: { per_band: {} },
    },
    decision_digest: 'abcdef012345',
    telemetry: { wall_ms: 4159 },
});

describe('WidgetShelf.looksLikeReceipt', () => {
    it('accepts wizard receipts (version / solution / no_solve)', () => {
        expect(looksLikeReceipt({ version: '2.16.0' })).toBe(true);
        expect(looksLikeReceipt({ solution: {} })).toBe(true);
        expect(looksLikeReceipt({ kind: 'no_solve' })).toBe(true);
    });
    it('accepts a bare greenfield core dump', () => {
        expect(looksLikeReceipt(gfCore())).toBe(true);
    });
    it('rejects non-receipt shapes', () => {
        expect(looksLikeReceipt(null)).toBe(false);
        expect(looksLikeReceipt([])).toBe(false);
        expect(looksLikeReceipt({})).toBe(false);
        expect(looksLikeReceipt('x' as any)).toBe(false);
    });
});

describe('WidgetShelf.readIdentity', () => {
    it('a bare greenfield SOLVED dump reads SOLVED + greenfield engine label + frame id', () => {
        const id = readIdentity(gfCore('Solved'));
        expect(id.status).toBe('SOLVED');
        expect(id.solvedVia).toBe('greenfield · Rust core');
        expect(id.frame).toBe('M66');
    });
    it('a greenfield ABORTED dump reads REFUSED (honest, not NO SOLUTION)', () => {
        expect(readIdentity(gfCore('Aborted')).status).toBe('REFUSED');
    });
    it('a wizard solved receipt keeps its solve_provenance solved_via', () => {
        const id = readIdentity({ version: '2.16.0', solution: {}, solve_provenance: { solved_via: 'blind' } });
        expect(id.status).toBe('SOLVED');
        expect(id.solvedVia).toBe('blind');
    });
    it('a plain object with no solve evidence stays NO SOLUTION', () => {
        expect(readIdentity({ version: '2.16.0' }).status).toBe('NO SOLUTION');
    });
});
