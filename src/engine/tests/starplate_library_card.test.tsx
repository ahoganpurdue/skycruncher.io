import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    StarplateLibraryCard,
    StarplateLibraryCardView,
    fetchStarplatesStatus,
    parseStarplatesStatus,
    releaseSourceTag,
    releaseEpoch,
} from '../ui/dashboard/StarplateLibraryCard';
import type { StarplatesStatus } from '../ui/dashboard/StarplateLibraryCard';

/**
 * STAR-PLATE LIBRARY SYNC CARD (gallery W2.4) — server-render (node env,
 * no DOM) + mocked-invoke tests.
 *
 * The native provider (`starplates_status` Tauri command) may not exist in
 * a given build: the invoke-rejection path MUST render the honest absent
 * state, never an error and never fabricated numbers (LAW 3).
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

/** A full §5.1-shaped payload (spec docs/STARPLATES_SPEC.md, store.rs). */
const FULL: StarplatesStatus = {
    release: 'starplates-2026.07-gdr3',
    format_version: 1,
    tier_depth_available: 't1',
    cells_total: 12288,
    cells_populated: 12288,
    cells_local: 12288,
    t0_rows: 119306,
    coverage_t1: 1,
};

/** The real first release: ~79% sky (ESA TAP 3M-row cap, spec §0/§4). */
const PARTIAL: StarplatesStatus = {
    ...FULL,
    cells_populated: 10612,
    cells_local: 10612,
    coverage_t1: 10612 / 12288, // 0.8636…
};

// ── parseStarplatesStatus ─────────────────────────────────────────────────

describe('StarplateLibraryCard/parseStarplatesStatus', () => {
    it('accepts a full §5.1 payload', () => {
        expect(parseStarplatesStatus({ ...FULL })).toEqual(FULL);
    });

    it('rejects null / non-objects', () => {
        expect(parseStarplatesStatus(null)).toBeNull();
        expect(parseStarplatesStatus(undefined)).toBeNull();
        expect(parseStarplatesStatus('starplates-2026.07-gdr3')).toBeNull();
        expect(parseStarplatesStatus(42)).toBeNull();
    });

    it('rejects a payload missing a numeric field', () => {
        const { coverage_t1: _drop, ...rest } = FULL;
        expect(parseStarplatesStatus(rest)).toBeNull();
    });

    it('rejects non-finite and negative numbers (never renders fake data)', () => {
        expect(parseStarplatesStatus({ ...FULL, coverage_t1: NaN })).toBeNull();
        expect(parseStarplatesStatus({ ...FULL, cells_local: Infinity })).toBeNull();
        expect(parseStarplatesStatus({ ...FULL, t0_rows: -1 })).toBeNull();
    });

    it('rejects an empty release id', () => {
        expect(parseStarplatesStatus({ ...FULL, release: '' })).toBeNull();
    });
});

// ── release-id derivations ────────────────────────────────────────────────

describe('StarplateLibraryCard/derivations', () => {
    it('parses the §2.1 source tag from the release id', () => {
        expect(releaseSourceTag('starplates-2026.07-gdr3')).toBe('GDR3');
        expect(releaseSourceTag('starplates-2026.11.2-gdr3')).toBe('GDR3');
    });

    it('returns null (renders --) for a non-conforming release id', () => {
        expect(releaseSourceTag('atlas-2026.07')).toBeNull();
        expect(releaseSourceTag('starplates-')).toBeNull();
    });

    it('epoch J2016.0 is earned by format_version 1 only (frozen §3.2 contract)', () => {
        expect(releaseEpoch(1)).toBe('J2016.0');
        expect(releaseEpoch(2)).toBeNull();
    });
});

// ── fetchStarplatesStatus (mocked invoke) ─────────────────────────────────

describe('StarplateLibraryCard/fetchStarplatesStatus', () => {
    it('present: resolves the parsed status and invokes starplates_status', async () => {
        const invoke = vi.fn().mockResolvedValue({ ...FULL });
        const out = await fetchStarplatesStatus(invoke);
        expect(invoke).toHaveBeenCalledWith('starplates_status');
        expect(out).toEqual({ kind: 'present', status: FULL });
    });

    it('absent: invoke rejection (command not registered) never throws', async () => {
        const invoke = vi
            .fn()
            .mockRejectedValue(new Error('Command starplates_status not found'));
        const out = await fetchStarplatesStatus(invoke);
        expect(out.kind).toBe('absent');
    });

    it('E_NOT_INITIALIZED triggers the idempotent starplates_init bring-up (present path)', async () => {
        // Nothing else in src/ calls starplates_init — a cold app always
        // answers E_NOT_INITIALIZED, so the card owns the bring-up.
        const invoke = vi.fn(async (cmd: string) => {
            if (cmd === 'starplates_status') throw 'E_NOT_INITIALIZED: call starplates_init first';
            if (cmd === 'starplates_init') return { ...FULL };
            throw new Error(`unexpected command ${cmd}`);
        });
        const out = await fetchStarplatesStatus(invoke);
        expect(invoke).toHaveBeenNthCalledWith(1, 'starplates_status');
        expect(invoke).toHaveBeenNthCalledWith(2, 'starplates_init');
        expect(out).toEqual({ kind: 'present', status: FULL });
    });

    it('absent: E_NOT_INITIALIZED with init also failing (no bundled store) never throws', async () => {
        const invoke = vi.fn().mockRejectedValue('E_NOT_INITIALIZED: call starplates_init first');
        const out = await fetchStarplatesStatus(invoke);
        expect(out.kind).toBe('absent');
        // status, then the one init retry — never a loop.
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('absent: non-init errors do NOT trigger the init bring-up', async () => {
        const invoke = vi
            .fn()
            .mockRejectedValue(new Error('Command starplates_status not found'));
        const out = await fetchStarplatesStatus(invoke);
        expect(out.kind).toBe('absent');
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('absent: malformed payload is refused, not rendered', async () => {
        const invoke = vi.fn().mockResolvedValue({ release: 'x', coverage_t1: 'lots' });
        const out = await fetchStarplatesStatus(invoke);
        expect(out).toEqual({ kind: 'absent', reason: 'malformed status payload' });
    });

    it('absent: default path outside a Tauri runtime resolves absent', async () => {
        // No injected invoke — in node the real @tauri-apps/api invoke has no
        // Tauri internals to talk to; the card must degrade to absent.
        const out = await fetchStarplatesStatus();
        expect(out.kind).toBe('absent');
    });
});

// ── View: absent / pending ────────────────────────────────────────────────

describe('StarplateLibraryCardView/absent + pending', () => {
    it('absent renders the exact honest-absent line in the EmptyState voice', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'absent', reason: 'nope' }} />);
        expect(out).toContain('LIBRARY NOT SYNCED — native provider unavailable');
        // EmptyState voice: italic muted (kit/EmptyState.tsx).
        expect(out).toContain('text-xs text-text-muted italic');
        // No fake numbers, no earned chips, in the absent state.
        expect(out).not.toContain('%');
        expect(out).not.toContain('SHA-VERIFIED');
        expect(out).not.toContain('bg-solve-dim');
    });

    it('pending renders no data and no earned color', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'pending' }} />);
        expect(out).toContain('querying native provider');
        expect(out).not.toContain('%');
        expect(out).not.toContain('bg-solve-dim');
        expect(out).not.toContain('bg-warn-dim');
    });

    it('the card shell + caption render in every state (stable testid)', () => {
        for (const state of [
            { kind: 'pending' } as const,
            { kind: 'absent', reason: 'x' } as const,
            { kind: 'present', status: FULL } as const,
        ]) {
            const out = html(<StarplateLibraryCardView state={state} />);
            expect(out).toContain('data-testid="starplate-library-card"');
            expect(out).toContain('STAR-PLATE LIBRARY SYNC');
        }
    });
});

// ── View: present ─────────────────────────────────────────────────────────

describe('StarplateLibraryCardView/present', () => {
    it('full coverage earns the solve-green FULL SKY chip', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: FULL }} />);
        expect(out).toContain('FULL SKY — 100.0%');
        expect(out).toContain('bg-solve-dim text-solve');
        expect(out).not.toContain('PARTIAL SKY');
    });

    it('partial coverage is a degradation: WARN chip "PARTIAL SKY — NN.N%"', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: PARTIAL }} />);
        expect(out).toContain('PARTIAL SKY — 86.4%');
        expect(out).not.toContain('FULL SKY');
        // The coverage chip itself carries the warn tone.
        expect(out).toMatch(
            /data-testid="starplate-coverage-chip"[^>]*>[^<]*PARTIAL SKY/,
        );
        expect(out).toMatch(/bg-warn-dim text-warn[^>]*>PARTIAL SKY — 86\.4%/);
    });

    it('coverage with no T1 tier (cells_total 0) renders -- , not a fake 0%', () => {
        const s: StarplatesStatus = {
            ...FULL,
            cells_total: 0,
            cells_populated: 0,
            cells_local: 0,
            coverage_t1: 0,
            tier_depth_available: 't0',
        };
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: s }} />);
        expect(out).toContain('T1 COVERAGE --');
        expect(out).not.toContain('PARTIAL SKY');
        expect(out).not.toContain('FULL SKY');
    });

    it('renders release id, source tag, and epoch', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: FULL }} />);
        expect(out).toContain('starplates-2026.07-gdr3');
        expect(out).toContain('GDR3');
        expect(out).toContain('J2016.0');
    });

    it('unknown format_version renders epoch as the -- sentinel', () => {
        const out = html(
            <StarplateLibraryCardView
                state={{ kind: 'present', status: { ...FULL, format_version: 2 } }}
            />,
        );
        expect(out).toMatch(/data-testid="starplate-epoch"[\s\S]*?--/);
        expect(out).not.toContain('J2016.0');
    });

    it('tier rows: T0 rows and T1 local/populated counts in tabular mono', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: PARTIAL }} />);
        expect(out).toContain('119,306');
        expect(out).toContain('10,612 / 10,612');
        expect(out).toContain('12,288');
        expect(out).toContain('font-mono text-[11px]');
        expect(out).toContain('tabular-nums');
    });

    it('t0_rows 0 means "not local" — renders --, never a measured 0', () => {
        const s = { ...FULL, t0_rows: 0, tier_depth_available: 't1' };
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: s }} />);
        expect(out).toMatch(/T0 ROWS[\s\S]*?--/);
    });

    it('blob count includes the local T0 blob; bytes are honest-absent', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: PARTIAL }} />);
        // 10,612 T1 cells + 1 local T0 blob
        expect(out).toContain('10,613');
        expect(out).toMatch(/BLOB BYTES[\s\S]*?--/);
        expect(out).toContain('blob bytes not reported by starplates_status');
    });

    it('parity line is NOT MEASURED with the offline-gate reason', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: FULL }} />);
        expect(out).toContain('PARITY V1↔V2');
        expect(out).toContain('NOT MEASURED');
        expect(out).toContain('tools/repro/starplates_parity.mjs');
    });

    it('integrity chip is manifest-scoped and solve-toned (earned by a live status)', () => {
        const out = html(<StarplateLibraryCardView state={{ kind: 'present', status: FULL }} />);
        expect(out).toContain('MANIFEST SHA-VERIFIED');
        expect(out).toMatch(/bg-solve-dim text-solve[^>]*>MANIFEST SHA-VERIFIED/);
    });

    it('depth chip: t1 info / t0 warn / none warn', () => {
        const t1 = html(<StarplateLibraryCardView state={{ kind: 'present', status: FULL }} />);
        expect(t1).toContain('DEPTH T1');
        expect(t1).toMatch(/bg-info-dim text-info[^>]*>DEPTH T1/);

        const t0 = html(
            <StarplateLibraryCardView
                state={{ kind: 'present', status: { ...FULL, tier_depth_available: 't0' } }}
            />,
        );
        expect(t0).toContain('DEPTH T0 — BOOTSTRAP ONLY');
        expect(t0).toMatch(/bg-warn-dim text-warn[^>]*>DEPTH T0/);

        const none = html(
            <StarplateLibraryCardView
                state={{ kind: 'present', status: { ...FULL, tier_depth_available: 'none' } }}
            />,
        );
        expect(none).toContain('NO LOCAL BLOBS');
        expect(none).toMatch(/bg-warn-dim text-warn[^>]*>NO LOCAL BLOBS/);
    });
});

// ── Container ─────────────────────────────────────────────────────────────

describe('StarplateLibraryCard container', () => {
    it('initial (static) render is the pending state — no invoke result yet', () => {
        // renderToStaticMarkup never runs effects, so this pins the
        // pre-invoke frame: card shell + honest pending voice, no data.
        const out = html(<StarplateLibraryCard invokeFn={vi.fn()} />);
        expect(out).toContain('data-testid="starplate-library-card"');
        expect(out).toContain('querying native provider');
        expect(out).not.toContain('%');
    });
});
