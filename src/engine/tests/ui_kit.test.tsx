import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    Chip,
    Badge,
    KV,
    Readout,
    Section,
    Card,
    Panel,
    StatusDot,
    HonestyBadge,
    EmptyState,
    CoefValue,
} from '../ui/kit';
import type { ChipTone, StatusDotState, HonestySource } from '../ui/kit';

/**
 * UI KIT SMOKE — server-render (node env, no DOM) assertions that the kit
 * primitives (1) render, (2) map tones/states to the exact token-bound
 * classes hoisted from the inline originals, and (3) implement the A.6
 * honesty-badge state machine with its load-bearing label strings.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// ── Chip / Badge ──────────────────────────────────────────────────────────

describe('kit/Chip', () => {
    const TONE_CLASSES: Record<ChipTone, string> = {
        solve: 'bg-solve-dim text-solve',
        warn: 'bg-warn-dim text-warn',
        danger: 'bg-danger-dim text-danger',
        accent: 'bg-accent-glow text-accent-300',
        info: 'bg-info-dim text-info',
        neutral: 'bg-space-750 text-text-secondary',
    };

    it('renders children inside the tinted-well shell', () => {
        const out = html(<Chip tone="solve">WCS</Chip>);
        expect(out).toContain('WCS');
        // Shell hoisted verbatim from FindingsFeed.tsx Chip.
        expect(out).toContain('px-1.5 py-px rounded text-[9px] font-semibold tracking-wide whitespace-nowrap');
    });

    it.each(Object.entries(TONE_CLASSES))('maps tone %s to its token classes', (tone, cls) => {
        expect(html(<Chip tone={tone as ChipTone}>x</Chip>)).toContain(cls);
    });

    it('never leaks another tone\'s color class', () => {
        const out = html(<Chip tone="warn">x</Chip>);
        expect(out).not.toContain('text-solve');
        expect(out).not.toContain('text-danger');
    });

    it('Badge is an alias of Chip (identical output)', () => {
        expect(html(<Badge tone="danger">RUN FAILED</Badge>)).toBe(html(<Chip tone="danger">RUN FAILED</Chip>));
    });

    it('forwards testid', () => {
        expect(html(<Chip tone="neutral" testid="my-chip">x</Chip>)).toContain('data-testid="my-chip"');
    });
});

// ── Chip status glyphs (restyle 2026-07-21 — hue-independent redundancy) ─────

describe('kit/Chip status glyphs', () => {
    it('earned tones carry their glyph key (● solve ▲ warn ✕ danger) as data-sc-glyph', () => {
        expect(html(<Chip tone="solve">WCS</Chip>)).toContain('data-sc-glyph="solve"');
        expect(html(<Chip tone="warn">x</Chip>)).toContain('data-sc-glyph="warn"');
        expect(html(<Chip tone="danger">x</Chip>)).toContain('data-sc-glyph="danger"');
    });

    it('informational tones carry NO glyph (accent/info/neutral)', () => {
        for (const t of ['accent', 'info', 'neutral'] as const) {
            expect(html(<Chip tone={t}>x</Chip>)).not.toContain('data-sc-glyph');
        }
    });

    it('caller can request the ◌ absent glyph, and suppress with "none"', () => {
        expect(html(<Chip tone="neutral" glyph="absent">NOT MEASURED</Chip>)).toContain('data-sc-glyph="absent"');
        expect(html(<Chip tone="solve" glyph="none">x</Chip>)).not.toContain('data-sc-glyph');
    });

    it('the glyph is CSS-only: it never enters the DOM text (status strings stay verbatim)', () => {
        const out = html(<Chip tone="danger">RUN FAILED</Chip>);
        expect(out).toContain('RUN FAILED');
        // The literal glyph chars live in index.css ::before, never the markup.
        for (const ch of ['●', '▲', '✕', '◌']) expect(out).not.toContain(ch);
        // className shell + tone class remain byte-intact (additive attribute only).
        expect(out).toContain('px-1.5 py-px rounded text-[9px] font-semibold tracking-wide whitespace-nowrap');
        expect(out).toContain('bg-danger-dim text-danger');
    });
});

// ── KV / Readout ──────────────────────────────────────────────────────────

describe('kit/KV + Readout', () => {
    it('KV renders key muted and value in data color with tabular figures', () => {
        const out = html(<KV k="RA" v="10.6847h" />);
        expect(out).toContain('RA');
        expect(out).toContain('10.6847h');
        expect(out).toContain('text-text-muted');
        expect(out).toContain('text-data tabular-nums');
        expect(out).toContain('flex justify-between gap-2');
    });

    it('Readout sets value mono+tabular with the unit dimmed at 0.7em', () => {
        const out = html(<Readout value="2.394" unit="″/px" />);
        expect(out).toContain('font-mono text-data tabular-nums');
        expect(out).toContain('2.394');
        expect(out).toContain('text-text-muted text-[0.7em]');
        expect(out).toContain('″/px');
    });

    it('Readout renders the -- sentinel (no unit) for absent values — LAW 3', () => {
        for (const v of [null, undefined]) {
            const out = html(<Readout value={v} unit="px" />);
            expect(out).toContain('--');
            expect(out).not.toContain('px</span>'); // unit suppressed with the value absent
            expect(out).not.toContain('>0<'); // never a fabricated zero
        }
    });
});

// ── Section / Card / Panel ────────────────────────────────────────────────

describe('kit/Section + Card + Panel', () => {
    it('Section renders the tracked uppercase eyebrow with divider', () => {
        const out = html(<Section title="Stage Timeline"><div>body</div></Section>);
        expect(out).toContain('Stage Timeline');
        expect(out).toContain('body');
        // Hoisted verbatim from PipelineInspector.tsx Section.
        expect(out).toContain(
            'text-[10px] uppercase tracking-[0.2em] text-text-muted font-semibold border-b border-line-subtle pb-1.5 mb-2'
        );
    });

    it('Card renders the metric-card surface with uppercase caption', () => {
        const out = html(<Card caption="Fit Quality">stats</Card>);
        expect(out).toContain('bg-space-800 border border-line p-4 rounded-lg');
        expect(out).toContain('text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2');
        expect(out).toContain('Fit Quality');
        expect(out).toContain('stats');
    });

    it('Panel renders the chart-panel surface; caption omitted → no header', () => {
        const withCaption = html(<Panel caption="Vignette">chart</Panel>);
        expect(withCaption).toContain('bg-space-900/70 border border-line rounded-xl p-4');
        expect(withCaption).toContain('<h4');
        const headerless = html(<Panel>chart</Panel>);
        expect(headerless).not.toContain('<h4');
    });
});

// ── StatusDot ─────────────────────────────────────────────────────────────

describe('kit/StatusDot', () => {
    const STATE_CLASSES: Record<StatusDotState, string> = {
        pending: 'bg-pending/50',
        running: 'bg-accent-400 animate-pulse',
        ok: 'bg-solve',
        failed: 'bg-danger',
    };

    it.each(Object.entries(STATE_CLASSES))('maps state %s to its token classes', (state, cls) => {
        const out = html(<StatusDot state={state as StatusDotState} />);
        expect(out).toContain(cls);
        expect(out).toContain('w-2 h-2 rounded-full shrink-0');
        expect(out).toContain(`data-state="${state}"`);
    });

    it('pulses ONLY while running (motion is live, not success)', () => {
        expect(html(<StatusDot state="running" />)).toContain('animate-pulse');
        for (const s of ['pending', 'ok', 'failed'] as const) {
            expect(html(<StatusDot state={s} />)).not.toContain('animate-pulse');
        }
    });

    it('earned color: ok is solve green, pending is not', () => {
        expect(html(<StatusDot state="ok" />)).toContain('bg-solve');
        expect(html(<StatusDot state="pending" />)).not.toContain('bg-solve');
    });
});

// ── HonestyBadge state machine (A.6/B.4) ──────────────────────────────────

describe('kit/HonestyBadge', () => {
    // Load-bearing strings — the polled e2e contract asserts on these exact
    // labels (PipelineWizard time/GPS badges). Do not reword.
    const MACHINE: Record<HonestySource, { label: string; cls: string }> = {
        FITS: { label: 'FITS HEADER', cls: 'bg-solve-dim text-solve' },
        EXIF: { label: 'EXIF', cls: 'bg-solve-dim text-solve' },
        USER: { label: 'USER', cls: 'bg-warn-dim text-warn' },
        DEFAULT: { label: 'DEFAULT — VERIFY', cls: 'bg-warn-dim text-warn' },
        APPROXIMATE: { label: 'APPROX', cls: 'bg-warn-dim text-warn' },
    };

    it.each(Object.entries(MACHINE))('%s → exact label + tone', (source, expected) => {
        const out = html(<HonestyBadge source={source as HonestySource} />);
        expect(out).toContain(expected.label);
        expect(out).toContain(expected.cls);
        expect(out).toContain('text-[10px] px-1.5 rounded'); // shell hoisted from PipelineWizard badges
    });

    it('only file-derived provenance earns solve green — LAW 3', () => {
        for (const s of ['USER', 'DEFAULT', 'APPROXIMATE'] as const) {
            expect(html(<HonestyBadge source={s} />)).not.toContain('text-solve');
        }
        for (const s of ['FITS', 'EXIF'] as const) {
            expect(html(<HonestyBadge source={s} />)).not.toContain('text-warn');
        }
    });

    it('forwards testid for the polled badge contract', () => {
        expect(html(<HonestyBadge source="FITS" testid="time-source-badge" />)).toContain(
            'data-testid="time-source-badge"'
        );
    });
});

// ── EmptyState ────────────────────────────────────────────────────────────

describe('kit/EmptyState', () => {
    it('speaks in the italic absence voice', () => {
        const out = html(<EmptyState>No findings yet — run a stage.</EmptyState>);
        expect(out).toContain('text-xs text-text-muted italic');
        expect(out).toContain('No findings yet — run a stage.');
    });
});

// ── CoefValue ─────────────────────────────────────────────────────────────

describe('kit/CoefValue', () => {
    it('renders value ±1σ with the σ dimmed at 0.7em', () => {
        const out = html(<CoefValue value={-0.0123} se={0.0045} />);
        expect(out).toContain('font-mono text-data');
        expect(out).toContain('±');
        expect(out).toContain('text-text-muted text-[0.7em]');
    });

    it('omits ±σ when no standard error was measured — LAW 3', () => {
        expect(html(<CoefValue value={-0.0123} />)).not.toContain('±');
        expect(html(<CoefValue value={-0.0123} se={NaN} />)).not.toContain('±');
    });

    it('renders honest absence (em dash from fmtCoef) for a missing value', () => {
        const out = html(<CoefValue value={null} />);
        expect(out).toContain('—');
        expect(out).not.toContain('±');
    });

    it('appends the caller className (size overrides like text-lg)', () => {
        expect(html(<CoefValue value={1.5} className="text-lg" />)).toContain('font-mono text-data text-lg');
    });
});
