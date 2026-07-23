/**
 * RECEIPT-DRIVEN FLOWCHART — variant selection, the greenfield DAG, and the
 * honest-or-absent per-node annotation logic (flowchart_receipt.ts).
 *
 * Pure module (no React / DOM), pinned in the node env exactly like flowchart_model.
 * Fixtures are inline + minimal so the test never depends on a local artifact.
 */

import { describe, it, expect } from 'vitest';
import {
    detectFlowVariant, selectFlowGraph, annotateNode, receiptNodeStatus, readComputeRoutes,
    GREENFIELD_FLOW_NODES, GREENFIELD_FLOW_EDGES, GREENFIELD_NODE_BY_ID,
} from '../ui/widgets/widgets/flowchart_receipt';
import { FLOW_NODES } from '../ui/widgets/widgets/flowchart_model';
import { normalizeGreenfieldReceipt } from '../ui/widgets/data/greenfield_receipt';

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** A bare greenfield core dump `{decision, decision_digest, telemetry}` (Solved). */
function gfCore(state = 'Solved') {
    return {
        decision: {
            frame_id: 'M66', classification: 'wide',
            result: {
                state,
                solved: {
                    scale_arcsec_px: 3.679, parity_sign: -1, band: 4, rung: 0, hypothesis_seq: 12,
                    wcs: { crval: { ra: 170, dec: 12 }, crpix: { x: 1000, y: 1500 }, cd: [[1e-3, 0], [0, 1e-3]] },
                    matches: [{ det_id: 0, star_row: 5, residual_x: 0.1, residual_y: -0.1, log_lr: 3, test_order: 1 }],
                    final_verify: { log_odds: 42.1, n_matched: 265, n_ref: 900, n_distractor: 3, eff_area: 1.2, stopped_at: 46 },
                },
            },
            search: { per_band: { '4': { det_quads: 120, probes: 900, raw_hits: 30, proposals: 10, verified: 265, bailed: 2 }, '5': {} } },
            search_truncated: false,
            prep: { raw: 500, valid: 480, deduped: 470, pool: 150, peak_arm_promoted: 20 },
            index: { release_id: 'starplates-2026.07-quadidx-g15u', total_quads: 20962625 },
        },
        decision_digest: 'abcdef0123456789',
        telemetry: {
            wall_ms: 64000, cache_state: { hit_order_policy: 'descending' },
            fine_consensus: {
                bands_tested: [4, 5], candidates_coded: 126, hits: 18, wall_ms: 1200, capped: false,
                corroborating: [{ band: 4, center_offset_arcsec: 100, pose_scale_ratio: 1.0, matched_rows: [{ det_id: 0, residual_x: 0.1, residual_y: 0.1 }] }],
            },
        },
    };
}

/** A realistic seam-attached greenfield WIZARD receipt (post-solve blocks present). */
function gfSeamReceipt() {
    return {
        version: '2.16.0', source_format: 'fits',
        solution: { greenfield_receipt: gfCore('Solved') },
        compute_routes: [{ seam: 'demosaic', route: 'native_wgpu', reason: 'ok' }],
        confirm_status: { status: 'CONFIRMED', setExcessZ: 35.6, nTargets: 46 },
        psf_field: { stars: [{}, {}] },
        bc_rematch: { guard: 'KEPT_ORIGINAL', applied: false, matched: 56 },
    };
}

/** A legacy browser-solver wizard receipt (no greenfield decision). */
function legacyReceipt() {
    return {
        version: '2.16.0', source_format: 'fits',
        solution: { matched_stars: [{}, {}, {}] },
        solve_provenance: { solved_via: 'assisted:metadata' },
        confirm_status: { status: 'CONFIRMED', setExcessZ: 35.6, nTargets: 46 },
        compute_routes: [
            { seam: 'demosaic', route: 'skipped', reason: 'pre_demosaiced_stacked' },
            { seam: 'preview', route: 'skipped', reason: 'previews_disabled' },
        ],
        bc_rematch: { guard: 'KEPT_ORIGINAL', applied: false },
    };
}

// ─── variant detection ────────────────────────────────────────────────────────

describe('detectFlowVariant', () => {
    it('greenfield for a bare core dump AND a seam-attached wizard receipt', () => {
        expect(detectFlowVariant(gfCore())).toBe('greenfield');
        expect(detectFlowVariant(gfSeamReceipt())).toBe('greenfield');
    });
    it('legacy for a legacy wizard receipt, null, and a non-receipt object', () => {
        expect(detectFlowVariant(legacyReceipt())).toBe('legacy');
        expect(detectFlowVariant(null)).toBe('legacy');
        expect(detectFlowVariant({} as any)).toBe('legacy');
    });
});

// ─── graph selection ──────────────────────────────────────────────────────────

describe('selectFlowGraph', () => {
    it('selects the greenfield DAG for a greenfield receipt', () => {
        const g = selectFlowGraph(gfCore());
        expect(g.variant).toBe('greenfield');
        expect(g.nodes).toBe(GREENFIELD_FLOW_NODES);
        expect(g.edges).toBe(GREENFIELD_FLOW_EDGES);
    });
    it('selects the legacy DAG for a legacy / absent receipt', () => {
        expect(selectFlowGraph(legacyReceipt()).nodes).toBe(FLOW_NODES);
        expect(selectFlowGraph(null).variant).toBe('legacy');
        expect(selectFlowGraph(null).nodes).toBe(FLOW_NODES);
    });
    it('greenfield DAG is structurally sound (edge endpoints + group parents exist) and lays out', () => {
        for (const e of GREENFIELD_FLOW_EDGES) {
            expect(GREENFIELD_NODE_BY_ID[e.from], `edge from ${e.from}`).toBeDefined();
            expect(GREENFIELD_NODE_BY_ID[e.to], `edge to ${e.to}`).toBeDefined();
        }
        // every umbrella group names an existing spine parent (makeFlowLayout convention).
        for (const nspec of GREENFIELD_FLOW_NODES) {
            if (nspec.group) expect(GREENFIELD_NODE_BY_ID[nspec.group], `group parent ${nspec.group}`).toBeDefined();
        }
        const g = selectFlowGraph(gfCore());
        const dims = g.layout.layoutDims('horizontal');
        expect(dims.width).toBeGreaterThan(0);
        expect(dims.height).toBeGreaterThan(0);
        // distinct boxes for a spine node vs an umbrella child.
        const load = g.layout.nodeBox(GREENFIELD_NODE_BY_ID['gf_load'], 'horizontal');
        const psf = g.layout.nodeBox(GREENFIELD_NODE_BY_ID['gf.psf_field'], 'horizontal');
        expect(load.y).not.toBe(psf.y);
    });
});

// ─── greenfield annotations ───────────────────────────────────────────────────

describe('annotateNode — greenfield (honest-or-absent)', () => {
    const gf = normalizeGreenfieldReceipt(gfCore())!;

    it('verify node surfaces the real matched/ref counts + log-odds (measured)', () => {
        const a = annotateNode(GREENFIELD_NODE_BY_ID['gf_verify'], 'greenfield', gfCore(), gf);
        expect(a.ran).toBe(true);
        expect(a.lines.some(l => l.measured && l.text.includes('265'))).toBe(true);
        expect(a.lines.some(l => l.text.includes('42.10'))).toBe(true);
    });

    it('band coding reports coded-of-total (band 5 skipped is honest, not a zero)', () => {
        const a = annotateNode(GREENFIELD_NODE_BY_ID['gf_code'], 'greenfield', gfCore(), gf);
        expect(a.ran).toBe(true);
        expect(a.lines.some(l => l.text.includes('bands coded: 1 of 2'))).toBe(true);
    });

    it('accept node is not-failed on a Solved state, failed on Aborted', () => {
        const solved = annotateNode(GREENFIELD_NODE_BY_ID['gf_accept'], 'greenfield', gfCore('Solved'), normalizeGreenfieldReceipt(gfCore('Solved'))!);
        expect(solved.ran).toBe(true);
        expect(solved.failed).toBeFalsy();
        const aborted = annotateNode(GREENFIELD_NODE_BY_ID['gf_accept'], 'greenfield', gfCore('Aborted'), normalizeGreenfieldReceipt(gfCore('Aborted'))!);
        expect(aborted.failed).toBe(true);
    });

    it('gf_load reads NOT RUN on a bare core dump (no compute_routes)…', () => {
        const a = annotateNode(GREENFIELD_NODE_BY_ID['gf_load'], 'greenfield', gfCore(), gf);
        expect(a.ran).toBe(false);
        expect(a.lines[0].measured).toBe(false);
        expect(a.lines[0].text).toContain('NOT RUN');
    });

    it('…but reads the route stamps when a seam-attached receipt carries compute_routes', () => {
        const seam = gfSeamReceipt();
        const a = annotateNode(GREENFIELD_NODE_BY_ID['gf_load'], 'greenfield', seam, normalizeGreenfieldReceipt(seam)!);
        expect(a.ran).toBe(true);
        expect(a.lines.some(l => l.measured && l.text.includes('native_wgpu'))).toBe(true);
    });

    it('absent post-solve umbrella node reads NOT RUN on a bare dump, real block on a seam receipt', () => {
        const bare = annotateNode(GREENFIELD_NODE_BY_ID['gf.confirm'], 'greenfield', gfCore(), gf);
        expect(bare.ran).toBe(false);
        expect(bare.lines[0].text).toContain('NOT RUN');
        const seam = gfSeamReceipt();
        const attached = annotateNode(GREENFIELD_NODE_BY_ID['gf.confirm'], 'greenfield', seam, normalizeGreenfieldReceipt(seam)!);
        expect(attached.ran).toBe(true);
        expect(attached.lines.some(l => l.text.includes('CONFIRMED'))).toBe(true);
    });
});

// ─── legacy annotations ───────────────────────────────────────────────────────

describe('annotateNode — legacy (receipt-driven)', () => {
    it('solve node surfaces solved_via + matched stars + confirm', () => {
        const a = annotateNode({ id: 'solve' } as any, 'legacy', legacyReceipt(), null);
        expect(a.ran).toBe(true);
        expect(a.lines.some(l => l.text.includes('assisted:metadata'))).toBe(true);
        expect(a.lines.some(l => l.text.includes('matched stars: 3'))).toBe(true);
        expect(a.lines.some(l => l.text.includes('CONFIRMED'))).toBe(true);
    });
    it('load node surfaces compute-route stamps', () => {
        const a = annotateNode({ id: 'load' } as any, 'legacy', legacyReceipt(), null);
        expect(a.lines.some(l => l.text.includes('pre_demosaiced_stacked'))).toBe(true);
    });
    it('a node whose receipt block is absent reads NOT RUN (honest-or-absent)', () => {
        // legacy receipt carries no psf_field block.
        const a = annotateNode({ id: 'psf_field', receiptBlock: 'psf_field' } as any, 'legacy', legacyReceipt(), null);
        expect(a.ran).toBe(false);
        expect(a.lines[0].text).toContain('NOT RUN');
    });
    it('bc_rematch block summarises its guard + applied fields', () => {
        const a = annotateNode({ id: 'bc_rematch', receiptBlock: 'bc_rematch' } as any, 'legacy', legacyReceipt(), null);
        expect(a.ran).toBe(true);
        expect(a.lines.some(l => l.text.includes('KEPT_ORIGINAL'))).toBe(true);
    });
});

// ─── per-node status (lighting) ───────────────────────────────────────────────

describe('receiptNodeStatus — receipt-driven lighting', () => {
    it('greenfield: evidence→done, absent→idle, Aborted accept→failed', () => {
        const g = selectFlowGraph(gfCore('Solved'));
        const s = receiptNodeStatus(g, gfCore('Solved'));
        expect(s['gf_verify']).toBe('done');
        expect(s['gf_load']).toBe('idle');        // absent compute_routes on bare dump
        expect(s['gf.confirm']).toBe('idle');      // absent post-solve block
        expect(s['gf_accept']).toBe('done');

        const aborted = receiptNodeStatus(selectFlowGraph(gfCore('Aborted')), gfCore('Aborted'));
        expect(aborted['gf_accept']).toBe('failed');
    });

    it('structural umbrella root lights done only when a child ran', () => {
        const bare = receiptNodeStatus(selectFlowGraph(gfCore()), gfCore());
        expect(bare['gf_post']).toBe('idle'); // no post-solve child ran on a bare dump
        const seam = gfSeamReceipt();
        const attached = receiptNodeStatus(selectFlowGraph(seam), seam);
        expect(attached['gf_post']).toBe('done'); // psf_field / confirm / bc_rematch present
    });
});

// ─── compute-route reader ─────────────────────────────────────────────────────

describe('readComputeRoutes', () => {
    it('returns the stamp array, or null when absent', () => {
        expect(readComputeRoutes(legacyReceipt())).toHaveLength(2);
        expect(readComputeRoutes({ compute_routes: [] } as any)).toBeNull();
        expect(readComputeRoutes(null)).toBeNull();
    });
});
