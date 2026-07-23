/**
 * SOLVE FLOWCHART WIDGET — receipt-driven graph SELECTION at the render level.
 *
 * Screenshot-free DOM assertion (react-dom/server, node env — the same harness the
 * WebGPU-twin test uses): the widget must draw the GREENFIELD graph for a
 * greenfield receipt and the LEGACY graph for a legacy / absent receipt, honest-
 * or-absent. The per-node annotation logic itself is unit-pinned in
 * flowchart_receipt.test.ts; here we assert the widget wires the right graph.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Import the registry FIRST so the widget-manifest module cycle evaluates in app order.
import '../ui/widgets/registry';
import { solveFlowchartWidget, type FlowchartWidgetData } from '../ui/widgets/widgets/SolveFlowchartWidget';

const EMPTY_AGG = { run_count: 0, frame_count: 0, unhashed_count: 0, successful_frames: 0, stages: {} };
const mk = (receipt: any): FlowchartWidgetData => ({ aggregate: EMPTY_AGG, events: [], receipt });

/** Minimal bare greenfield core dump (Solved). */
const gfReceipt = {
    decision: {
        result: { state: 'Solved', solved: { scale_arcsec_px: 3.6, band: 4, rung: 0, final_verify: { log_odds: 42, n_matched: 265, n_ref: 900 }, matches: [] } },
        search: { per_band: { '4': { det_quads: 120, probes: 900 }, '5': {} } },
        prep: { raw: 500, valid: 480, deduped: 470, pool: 150 },
        index: { release_id: 'g15u' },
    },
    decision_digest: 'abcdef012345',
    telemetry: { wall_ms: 64000 },
};

/** Minimal legacy browser-solver wizard receipt. */
const legacyReceipt = {
    version: '2.16.0',
    solution: { matched_stars: [{}, {}, {}] },
    solve_provenance: { solved_via: 'assisted:metadata' },
    confirm_status: { status: 'CONFIRMED' },
};

describe('SolveFlowchartWidget — receipt-driven graph selection (DOM)', () => {
    const Render = solveFlowchartWidget.render;

    it('draws the GREENFIELD graph for a greenfield receipt', () => {
        const html = renderToStaticMarkup(<Render data={mk(gfReceipt)} />);
        expect(html).toContain('data-variant="greenfield"');
        expect(html).toContain('GREENFIELD');
        // greenfield spine + shared post-solve umbrella nodes render…
        expect(html).toContain('flowchart-node-gf_verify');
        expect(html).toContain('flowchart-node-gf_accept');
        expect(html).toContain('flowchart-node-gf.psf_field');
        // …and the legacy-only branch nodes do NOT.
        expect(html).not.toContain('flowchart-node-solve.uw_sweep');
        expect(html).not.toContain('flowchart-node-bc_measure');
        expect(html).toContain('greenfield Rust core');
    });

    it('draws the LEGACY graph for a legacy receipt', () => {
        const html = renderToStaticMarkup(<Render data={mk(legacyReceipt)} />);
        expect(html).toContain('data-variant="legacy"');
        expect(html).toContain('LEGACY');
        expect(html).toContain('flowchart-node-solve.uw_sweep');
        expect(html).toContain('flowchart-node-calibrate');
        expect(html).not.toContain('flowchart-node-gf_verify');
    });

    it('defaults to the legacy structural map for a null receipt (honest AWAITING, never a fake greenfield path)', () => {
        const html = renderToStaticMarkup(<Render data={mk(null)} />);
        expect(html).toContain('data-variant="legacy"');
        expect(html).toContain('flowchart-node-load');
        expect(html).not.toContain('flowchart-node-gf_verify');
    });
});
