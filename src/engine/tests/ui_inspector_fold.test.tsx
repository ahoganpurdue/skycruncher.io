import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldPipelineEvents } from '../ui/inspector/inspector_model';
import { FindingsFeed } from '../ui/inspector/FindingsFeed';
import type { PipelineEvent, PipelineEventInput } from '../events/pipeline_events';

/**
 * WAVE-2A inspector truth fixes (server-render + pure-fold assertions).
 *
 *  ③a  duplicate "PSF MEASURED" — psf_field + psf_attribution re-emit the SAME
 *      measured PSF; the fold now collapses identical rows (distinct values kept).
 *  ③b  a stage that finishes ok:true with verdict 'SKIP' (SPCC on non-FITS) is
 *      rendered as 'skipped', not a green 0ms "ran".
 *  ③d  candidate count is "accepted" (rejection wins), never mislabeled "verified":
 *      REJECTED_VERIFY_FAILED must NOT count and must NOT paint green.
 */

let seq = 0;
const stamp = (e: PipelineEventInput): PipelineEvent =>
    ({ ...e, t: Date.now(), seq: ++seq } as PipelineEvent);
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('foldPipelineEvents — ③b skipped stages', () => {
    it('ok:true + verdict SKIP → state "skipped" (not "ok")', () => {
        const model = foldPipelineEvents([
            stamp({ kind: 'stage_started', stage: 'spcc', label: 'SPCC' }),
            stamp({ kind: 'stage_finished', stage: 'spcc', ok: true, ms: 0, verdict: 'SKIP' }),
        ]);
        const spcc = model.stages.find(s => s.id === 'spcc')!;
        expect(spcc.state).toBe('skipped');
    });

    it('ok:true with no SKIP verdict is still "ok"', () => {
        const model = foldPipelineEvents([
            stamp({ kind: 'stage_started', stage: 'solve', label: 'Plate Solve' }),
            stamp({ kind: 'stage_finished', stage: 'solve', ok: true, ms: 42, verdict: 'PASS' }),
        ]);
        expect(model.stages.find(s => s.id === 'solve')!.state).toBe('ok');
    });
});

describe('foldPipelineEvents — ③a PSF-measured dedup', () => {
    const psf = (nStars: number, fwhm: number): PipelineEventInput =>
        ({ kind: 'finding', finding: { kind: 'psf_measured', nStars, fwhmMedianPx: fwhm } });

    it('identical psf_measured from two stages collapses to ONE feed row', () => {
        const model = foldPipelineEvents([stamp(psf(56, 3.9)), stamp(psf(56, 3.9))]);
        const rows = model.feed.filter(f => f.type === 'finding' && f.finding.kind === 'psf_measured');
        expect(rows).toHaveLength(1);
    });

    it('a genuinely different psf_measured is still shown', () => {
        const model = foldPipelineEvents([stamp(psf(56, 3.9)), stamp(psf(40, 4.4))]);
        const rows = model.feed.filter(f => f.type === 'finding' && f.finding.kind === 'psf_measured');
        expect(rows).toHaveLength(2);
    });
});

describe('FindingsFeed — ③d honest candidate accounting', () => {
    const cand = (idx: number, status: string): PipelineEvent =>
        stamp({ kind: 'finding', finding: { kind: 'solve_candidate', idx, status } });

    it('REJECTED_VERIFY_FAILED does NOT count as accepted and is not green', () => {
        const model = foldPipelineEvents([
            cand(0, 'SUCCESS'),
            cand(1, 'REJECTED_VERIFY_FAILED'),
            cand(2, 'REJECTED_SCALE_GATE'),
            cand(3, 'UW_VERIFY_PASS'),
        ]);
        const out = html(<FindingsFeed feed={model.feed} />);
        // 4 tried, 2 accepted (SUCCESS + UW_VERIFY_PASS) — never "verified".
        expect(out).toContain('4 tried');
        expect(out).toContain('2 accepted');
        expect(out).not.toContain('verified');
        // The rejected-verify row is danger-colored, never solve-green.
        expect(out).toContain('REJECTED_VERIFY_FAILED');
    });
});
