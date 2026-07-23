/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RECEIPT-DRIVEN FLOWCHART — variant selection + the GREENFIELD DAG + per-node
 * receipt annotations
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The solve flowchart must draw the path THIS receipt's solve ACTUALLY took, not
 * one static map. Since the 2026-07-21 Rust cutover a desktop solve runs the
 * greenfield solver core, whose pipeline (detections → band iteration → quad
 * codes → verify → fine consensus → accept/abort → shared post-solve) is a
 * different shape from the legacy browser solver (quad match / UW anchored sweep /
 * deep-verify escalate). This module:
 *
 *   1. DETECTS which engine produced a receipt (`detectFlowVariant`) — greenfield
 *      iff the receipt carries a greenfield decision (bare or seam-attached),
 *      legacy otherwise. No receipt ⇒ legacy (the structural default map).
 *   2. Defines the GREENFIELD DAG (nodes + edges), laid out by the SAME
 *      `makeFlowLayout` engine the legacy graph uses (flowchart_model.ts) — the
 *      two graphs can never drift in geometry.
 *   3. Reads honest per-node annotations from THIS receipt — timings/counts where
 *      recorded, route stamps on the GPU-capable seams, the confirm outcome on the
 *      verify/confirm nodes. Honest-or-absent (LAW 3): a stage the receipt has no
 *      evidence for reads "NOT RUN" / "NOT RECORDED", never a guessed number.
 *
 * PURE: no React, no DOM, no I/O. Node-importable + unit-testable. Ledger: RENDER
 * plane only — every function is a pure read over an already-collected receipt.
 */

import {
    FLOW_NODES, FLOW_EDGES, NODE_BY_ID, makeFlowLayout,
    type FlowNodeSpec, type FlowEdgeSpec, type FlowLayout, type LiveStatus,
} from './flowchart_model';
import type { WidgetReceipt } from '../registry';
import { normalizeGreenfieldReceipt, type GreenfieldReceipt } from '../data/greenfield_receipt';

// ─── variant ────────────────────────────────────────────────────────────────

export type FlowVariant = 'greenfield' | 'legacy';

/**
 * Which engine produced this receipt. GREENFIELD iff a greenfield decision is
 * present (bare `{decision,…}` core dump OR seam-attached
 * `solution.greenfield_receipt`); LEGACY otherwise, including a null/absent
 * receipt (⇒ the legacy structural map with all-absent annotations — honest
 * AWAITING, never a fabricated greenfield path).
 */
export function detectFlowVariant(receipt: WidgetReceipt): FlowVariant {
    return normalizeGreenfieldReceipt(receipt) ? 'greenfield' : 'legacy';
}

// ─── the greenfield DAG ───────────────────────────────────────────────────────

/**
 * Greenfield solver-core pipeline as a DAG. Spine (col 0) = the solve backbone the
 * Rust core actually walks; col-1 umbrella = the SHARED post-solve stages (browser
 * TS, common to both engines) hanging beneath the `gf_post` root. Runtime colors
 * follow the same taxonomy as the legacy graph. `widgets` point at the greenfield
 * receipt readers + the shared post-solve widgets so a box hover offers real
 * enabled-widget thumbnails.
 */
export const GREENFIELD_FLOW_NODES: FlowNodeSpec[] = [
    { id: 'gf_load', label: 'Load / Decode', runtime: 'mixed', col: 0, row: 0, receiptBlock: 'compute_routes', widgets: [], note: 'EXIF · raw decode · GPU demosaic (compute-route stamped)' },
    { id: 'gf_prep', label: 'Detections', runtime: 'wasm', col: 0, row: 1, receiptBlock: null, widgets: ['greenfield_solve_stats'], note: 'greenfield prep: raw → valid → deduped → solve pool' },
    { id: 'gf_code', label: 'Band coding', runtime: 'wasm', col: 0, row: 2, receiptBlock: null, widgets: ['greenfield_solve_stats', 'greenfield_replay'], note: 'per-band quad coding (descending √2 bands · abort-on-accept)' },
    { id: 'gf_verify', label: 'Verify', runtime: 'wasm', col: 0, row: 3, receiptBlock: null, widgets: ['greenfield_solve_stats'], note: 'a.net-style verify: proposals → matched (log-odds gate)' },
    { id: 'gf_fine', label: 'Fine consensus', runtime: 'wasm', col: 0, row: 4, receiptBlock: null, widgets: ['greenfield_replay'], optional: true, note: '§8b corroborating quads (sane poses only; junk discarded)' },
    { id: 'gf_accept', label: 'Accept / Abort', runtime: 'typescript', col: 0, row: 5, receiptBlock: null, widgets: ['greenfield_sky_overlays'], note: 'terminal state: accept (band/rung) or honest budget/abort refusal' },
    { id: 'gf_post', label: 'Post-solve (step 5)', runtime: 'typescript', col: 0, row: 6, receiptBlock: null, widgets: [], note: 'shared post-solve umbrella (browser TS — same as legacy)' },
    { id: 'gf_integrate', label: 'Receipt', runtime: 'typescript', col: 0, row: 7, receiptBlock: null, widgets: [], note: 'buildReceipt — decision digest + index provenance carried' },

    // shared post-solve umbrella (group id === parent spine id 'gf_post').
    { id: 'gf.psf_field', label: 'PSF field', runtime: 'wasm', col: 1, row: 6, group: 'gf_post', receiptBlock: 'psf_field', widgets: ['psf_field'], optional: true, note: 'per-star LM FWHM / coma (wasm refine_stars_lm)' },
    { id: 'gf.spcc', label: 'SPCC colour-cal', runtime: 'typescript', col: 1, row: 7, group: 'gf_post', receiptBlock: 'spcc', widgets: ['color_color_planckian'], optional: true, note: 'FITS inputs only (honest-absent on DSLR)' },
    { id: 'gf.confirm', label: 'Forced confirm', runtime: 'typescript', col: 1, row: 8, group: 'gf_post', receiptBlock: 'confirm_status', widgets: ['forced_photometry_z', 'deep_confirm'], optional: true, note: 'set-level family-wise gate' },
    { id: 'gf.bc_rematch', label: 'BC two-pass rematch', runtime: 'typescript', col: 1, row: 9, group: 'gf_post', receiptBlock: 'bc_rematch', widgets: ['bc_edge_recovery'], optional: true, note: 'default-ON · never-worse guard' },
];

export const GREENFIELD_FLOW_EDGES: FlowEdgeSpec[] = [
    // solve backbone spine
    { from: 'gf_load', to: 'gf_prep', kind: 'spine' },
    { from: 'gf_prep', to: 'gf_code', kind: 'spine' },
    { from: 'gf_code', to: 'gf_verify', kind: 'spine' },
    { from: 'gf_verify', to: 'gf_fine', kind: 'spine' },
    { from: 'gf_fine', to: 'gf_accept', kind: 'spine' },
    { from: 'gf_accept', to: 'gf_post', kind: 'spine' },
    { from: 'gf_post', to: 'gf_integrate', kind: 'spine' },
    // shared post-solve umbrella
    { from: 'gf_post', to: 'gf.psf_field', kind: 'umbrella' },
    { from: 'gf_post', to: 'gf.spcc', kind: 'umbrella' },
    { from: 'gf_post', to: 'gf.confirm', kind: 'umbrella' },
    { from: 'gf_post', to: 'gf.bc_rematch', kind: 'umbrella' },
];

export const GREENFIELD_NODE_BY_ID: Record<string, FlowNodeSpec> =
    Object.fromEntries(GREENFIELD_FLOW_NODES.map(n => [n.id, n]));

const GREENFIELD_LAYOUT: FlowLayout = makeFlowLayout(GREENFIELD_FLOW_NODES);
const LEGACY_LAYOUT_FOR_GRAPH: FlowLayout = makeFlowLayout(FLOW_NODES);

// ─── graph selection ──────────────────────────────────────────────────────────

export interface FlowGraph {
    variant: FlowVariant;
    nodes: FlowNodeSpec[];
    edges: FlowEdgeSpec[];
    nodeById: Record<string, FlowNodeSpec>;
    layout: FlowLayout;
}

/**
 * Select the flow graph for a receipt: the greenfield DAG for a greenfield-produced
 * receipt, else the legacy DAG. Both graphs carry the SAME layout engine so the
 * renderer is graph-agnostic.
 */
export function selectFlowGraph(receipt: WidgetReceipt): FlowGraph {
    const variant = detectFlowVariant(receipt);
    return variant === 'greenfield'
        ? { variant, nodes: GREENFIELD_FLOW_NODES, edges: GREENFIELD_FLOW_EDGES, nodeById: GREENFIELD_NODE_BY_ID, layout: GREENFIELD_LAYOUT }
        : { variant, nodes: FLOW_NODES, edges: FLOW_EDGES, nodeById: NODE_BY_ID, layout: LEGACY_LAYOUT_FOR_GRAPH };
}

// ─── per-node receipt annotations (honest-or-absent) ──────────────────────────

/** One honest annotation line. `measured` distinguishes a real value from a NOT
 *  RUN / NOT RECORDED line so the renderer can style absence faintly. */
export interface AnnLine { text: string; measured: boolean }

export interface NodeAnnotation {
    /** Honest lines describing what THIS receipt records for the node. */
    lines: AnnLine[];
    /** Did this stage run in THIS receipt? true = evidence present · false = absent
     *  (NOT RUN) · null = structural node (no own measurement, e.g. an umbrella root). */
    ran: boolean | null;
    /** Terminal verdict override — only `gf_accept` sets 'failed' on a non-solved state. */
    failed?: boolean;
}

// value formatters — never fabricate; absent ⇒ an explicit NOT RECORDED string.
const NR = 'NOT RECORDED';
const n = (v: number | null | undefined): string => (v == null || !Number.isFinite(v)) ? NR : String(v);
const nf = (v: number | null | undefined, d: number): string => (v == null || !Number.isFinite(v)) ? NR : v.toFixed(d);
const msf = (v: number | null | undefined): string => (v == null || !Number.isFinite(v)) ? NR : `${Math.round(v)} ms`;
const line = (text: string, measured: boolean): AnnLine => ({ text, measured });
const sumOf = (vals: (number | null)[]): number | null => {
    const f = vals.filter((x): x is number => x != null && Number.isFinite(x));
    return f.length ? f.reduce((a, b) => a + b, 0) : null;
};
const absent = (why: string): NodeAnnotation => ({ lines: [line(`NOT RUN — ${why}`, false)], ran: false });
const structural = (label: string): NodeAnnotation => ({ lines: [line(label, false)], ran: null });

/** Compute-route stamps recorded for THIS receipt (GPU-capable seams), or null. */
export function readComputeRoutes(receipt: WidgetReceipt): { seam: string; route: string; reason: string }[] | null {
    const cr = receipt && (receipt as any).compute_routes;
    if (!Array.isArray(cr) || cr.length === 0) return null;
    return cr
        .filter(r => r && typeof r === 'object')
        .map(r => ({ seam: String(r.seam ?? '?'), route: String(r.route ?? '?'), reason: String(r.reason ?? '') }));
}

/** Resolve a receipt block by name, checking the top level then `solution`. */
function resolveBlock(receipt: WidgetReceipt, block: string | null): { present: boolean; value: any } {
    if (!receipt || !block) return { present: false, value: undefined };
    const r = receipt as any;
    const v = r[block] !== undefined ? r[block] : r.solution?.[block];
    return { present: v != null, value: v };
}

/** Defensive per-block summary lines (field-level honest-or-absent — a field only
 *  appears when it is actually present on the value). */
function summariseBlock(block: string, value: any): AnnLine[] {
    if (value == null || typeof value !== 'object') return [line(`recorded (receipt.${block})`, true)];
    const out: AnnLine[] = [];
    switch (block) {
        case 'confirm_status':
            if (typeof value.status === 'string') out.push(line(`status: ${value.status}`, true));
            if (value.setExcessZ != null) out.push(line(`set excess z: ${nf(value.setExcessZ, 1)} (${n(value.nTargets)} targets)`, true));
            break;
        case 'bc_rematch':
            if (typeof value.guard === 'string') out.push(line(`guard: ${value.guard}`, true));
            if (typeof value.applied === 'boolean') out.push(line(`applied: ${value.applied ? 'yes' : 'no'}`, true));
            break;
        case 'psf_field':
            if (Array.isArray(value.stars)) out.push(line(`${value.stars.length} PSF stars fit`, true));
            else out.push(line('PSF field recorded', true));
            break;
        case 'compute_routes':
            if (Array.isArray(value)) for (const r of value) out.push(line(`${r?.seam}: ${r?.route} (${r?.reason})`, true));
            break;
        default:
            out.push(line(`recorded (receipt.${block})`, true));
    }
    return out.length ? out : [line(`recorded (receipt.${block})`, true)];
}

/** Annotate a node whose evidence is a named receipt block (umbrella children +
 *  most legacy nodes). Present ⇒ measured summary; absent ⇒ NOT RUN. */
function annotateByBlock(spec: FlowNodeSpec, receipt: WidgetReceipt): NodeAnnotation {
    if (!spec.receiptBlock) return structural('(structural stage — no own receipt block)');
    const { present, value } = resolveBlock(receipt, spec.receiptBlock);
    if (!present) return absent(`absent from this receipt (receipt.${spec.receiptBlock})`);
    return { lines: summariseBlock(spec.receiptBlock, value), ran: true };
}

// ─── greenfield node annotations ──────────────────────────────────────────────

function annotateGreenfieldNode(spec: FlowNodeSpec, gf: GreenfieldReceipt, receipt: WidgetReceipt): NodeAnnotation {
    switch (spec.id) {
        case 'gf_load': {
            const routes = readComputeRoutes(receipt);
            if (!routes) return absent('compute route not recorded (bare core dump / pre-2.16 receipt)');
            return { lines: routes.map(r => line(`${r.seam}: ${r.route}${r.reason ? ` (${r.reason})` : ''}`, true)), ran: true };
        }
        case 'gf_prep': {
            const p = gf.prep;
            if (!p) return absent('prep counts not recorded');
            return {
                lines: [
                    line(`raw ${n(p.raw)} → valid ${n(p.valid)} → deduped ${n(p.deduped)}`, p.raw != null),
                    line(`solve pool: ${n(p.pool)} detections`, p.pool != null),
                ],
                ran: true,
            };
        }
        case 'gf_code': {
            const coded = gf.perBand.filter(b => b.coded);
            if (gf.perBand.length === 0) return absent('no per-band record');
            const dq = sumOf(coded.map(b => b.detQuads));
            const pr = sumOf(coded.map(b => b.probes));
            const bandList = coded.map(b => b.band).sort((a, b) => b - a);
            return {
                lines: [
                    line(`bands coded: ${coded.length} of ${gf.perBand.length}${bandList.length ? ` (${bandList.join(', ')})` : ''}`, coded.length > 0),
                    line(`det quads Σ ${n(dq)} · probes Σ ${n(pr)}`, dq != null),
                    line(gf.hitOrderPolicy ? `hit order: ${gf.hitOrderPolicy}` : `hit order: ${NR}`, !!gf.hitOrderPolicy),
                ],
                ran: true,
            };
        }
        case 'gf_verify': {
            const fv = gf.finalVerify;
            if (!fv) return absent('final verify not recorded');
            // stopped_at / bailed_at carry a negative sentinel when no early exit fired —
            // a real test index is >= 0. Never render the sentinel as a test index.
            const stop = fv.stoppedAt != null && fv.stoppedAt >= 0;
            const bail = fv.bailedAt != null && fv.bailedAt >= 0;
            const terminal = stop ? `stopped early @ test ${fv.stoppedAt}`
                : bail ? `bailed @ test ${fv.bailedAt}` : `no early exit (ran the verify set)`;
            return {
                lines: [
                    line(`matched ${n(fv.nMatched)} of ${n(fv.nRef)} ref · ${n(fv.nDistractor)} distractor`, fv.nMatched != null),
                    line(`log-odds ${nf(fv.logOdds, 2)} · eff-area ${n(fv.effArea != null ? Math.round(fv.effArea) : null)}`, fv.logOdds != null),
                    line(terminal, stop || bail || fv.stoppedAt != null || fv.bailedAt != null),
                ],
                ran: true,
            };
        }
        case 'gf_fine': {
            const fc = gf.fineConsensus;
            if (!fc) return absent('fine consensus not run for this solve');
            const sane = fc.corroborating.filter(c => c.sane).length;
            const junk = fc.corroborating.length - sane;
            return {
                lines: [
                    line(`bands tested: ${fc.bandsTested.join(', ') || '—'}`, fc.bandsTested.length > 0),
                    line(`sane corroborations: ${sane}${junk ? ` (${junk} junk discarded)` : ''}`, true),
                    line(`consensus wall: ${msf(fc.wallMs)}`, fc.wallMs != null),
                ],
                ran: true,
            };
        }
        case 'gf_accept': {
            const state = gf.state ?? null;
            const solved = (state ?? '').toLowerCase() === 'solved';
            return {
                lines: [
                    line(`state: ${state ?? NR}`, !!state),
                    line(`accept band ${n(gf.acceptBand)} · rung ${n(gf.acceptRung)}`, gf.acceptBand != null),
                    line(`wall ${msf(gf.wallMs)}${gf.abort?.onAccept ? ' · aborted on accept' : ''}`, gf.wallMs != null),
                    line(gf.searchTruncated == null ? `search truncated: ${NR}` : `search truncated: ${gf.searchTruncated ? 'yes' : 'no'}`, gf.searchTruncated != null),
                ],
                ran: true,
                failed: state != null && !solved,
            };
        }
        case 'gf_post':
            return structural('shared post-solve stages (below)');
        case 'gf_integrate':
            return {
                lines: [
                    line(gf.digest ? `digest: ${gf.digest.slice(0, 12)}…` : `digest: ${NR}`, !!gf.digest),
                    line(gf.index?.releaseId ? `index: ${gf.index.releaseId}` : `index: ${NR}`, !!gf.index?.releaseId),
                ],
                ran: true,
            };
        default:
            // shared post-solve umbrella children — read the wizard receipt block.
            return annotateByBlock(spec, receipt);
    }
}

// ─── legacy node annotations (receipt-driven, honest-or-absent) ───────────────

function annotateLegacyNode(spec: FlowNodeSpec, receipt: WidgetReceipt): NodeAnnotation {
    switch (spec.id) {
        case 'load': {
            const routes = readComputeRoutes(receipt);
            if (!routes) return absent('compute route not recorded (pre-2.16 receipt)');
            return { lines: routes.map(r => line(`${r.seam}: ${r.route}${r.reason ? ` (${r.reason})` : ''}`, true)), ran: true };
        }
        case 'solve': {
            if (!receipt || (receipt as any).solution == null) return absent('no solution in this receipt');
            const via = (receipt as any).solve_provenance?.solved_via;
            const nMatched = Array.isArray((receipt as any).solution?.matched_stars) ? (receipt as any).solution.matched_stars.length : null;
            const conf = (receipt as any).confirm_status?.status;
            return {
                lines: [
                    line(via ? `solved via: ${via}` : `solved via: ${NR}`, !!via),
                    line(`matched stars: ${n(nMatched)}`, nMatched != null),
                    line(conf ? `confirm: ${conf}` : `confirm: ${NR}`, !!conf),
                ],
                ran: true,
            };
        }
        default:
            return annotateByBlock(spec, receipt);
    }
}

/**
 * Honest per-node annotation for a receipt: greenfield nodes read the normalized
 * greenfield receipt; legacy nodes read the wizard receipt blocks. `gf` is the
 * pre-normalized greenfield receipt for the greenfield variant (null for legacy).
 */
export function annotateNode(
    spec: FlowNodeSpec,
    variant: FlowVariant,
    receipt: WidgetReceipt,
    gf: GreenfieldReceipt | null,
): NodeAnnotation {
    if (variant === 'greenfield' && gf) return annotateGreenfieldNode(spec, gf, receipt);
    return annotateLegacyNode(spec, receipt);
}

/**
 * Per-node live status map derived PURELY from THIS receipt's evidence (no event
 * bus): a stage with evidence is 'done', an absent stage is 'idle' (drawn dashed),
 * and the terminal accept node is 'failed' on a non-solved state. Structural nodes
 * (umbrella roots) light 'done' when any child ran, else 'idle'.
 */
export function receiptNodeStatus(graph: FlowGraph, receipt: WidgetReceipt): Record<string, LiveStatus> {
    const gf = graph.variant === 'greenfield' ? normalizeGreenfieldReceipt(receipt) : null;
    const status: Record<string, LiveStatus> = {};
    const anns: Record<string, NodeAnnotation> = {};
    for (const spec of graph.nodes) anns[spec.id] = annotateNode(spec, graph.variant, receipt, gf);
    for (const spec of graph.nodes) {
        const a = anns[spec.id];
        if (a.failed) { status[spec.id] = 'failed'; continue; }
        if (a.ran === true) { status[spec.id] = 'done'; continue; }
        if (a.ran === false) { status[spec.id] = 'idle'; continue; }
        // structural root: done iff any child (a node in this group) ran.
        const anyChild = graph.nodes.some(c => c.group === spec.id && anns[c.id]?.ran === true);
        status[spec.id] = anyChild ? 'done' : 'idle';
    }
    return status;
}
