/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVE-FLOWCHART MODEL — the pure DAG spec + geometry + tooltip builders
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ★ interactive solve-flowchart's single source of truth (LAW 4 — layout,
 * runtime colors, live-status derivation and tooltip text live HERE, once). The
 * React widget (`SolveFlowchartWidget.tsx`) renders SVG/DOM from this model; the
 * headless preview generator (`tools/capture/render_flowchart_preview.mjs`)
 * stringifies the SAME geometry — so the on-screen widget and the static owner
 * preview can never drift.
 *
 * PURE: no React, no DOM, no I/O. Node-importable + unit-testable.
 *
 * The DAG mirrors the REAL pipeline (recon `test_results/dashboard_recon…`,
 * §1 STAGE DAG): the linear backbone, the FOV-branched solve fan, and the
 * calibrate umbrella. Runtime = the recon's per-stage runtime map. Widget-
 * enablement = the recon §5 WIDGET→STAGE map. Every annotation is documented,
 * never guessed.
 */

import type { PipelineEvent } from '../../../events/pipeline_events';
import type { FlowchartAggregate, StageStat } from '../../../events/capture_aggregate';

// ─── runtime taxonomy (color-coded by language/runtime — owner spec) ────────

export type Runtime = 'typescript' | 'wasm' | 'webgpu' | 'mixed';

export const RUNTIME_META: Record<Runtime, { label: string; colorVar: string }> = {
    typescript: { label: 'TypeScript', colorVar: '--chart-cat-1' },   // accent cyan
    wasm: { label: 'Rust → WASM', colorVar: '--chart-cat-2' },        // warn amber
    webgpu: { label: 'WebGPU / WGSL', colorVar: '--chart-cat-4' },    // violet
    mixed: { label: 'Mixed runtime', colorVar: '--chart-cat-5' },     // rose
};

// ─── node + edge spec ───────────────────────────────────────────────────────

export interface FlowNodeSpec {
    /** Stable id — matches the capture-record `stage_id`. */
    id: string;
    label: string;
    runtime: Runtime;
    /** Layout column (0 = spine, 1 = branch / umbrella child). */
    col: number;
    row: number;
    /** Membership: an umbrella/fan child. Value is the PARENT spine node's id (the
     *  makeFlowLayout convention) — legacy uses 'solve' / 'calibrate'; the greenfield
     *  graph uses its own post-solve umbrella id. Widened to string so alternate
     *  graphs (flowchart_receipt.ts) can define their own groups. */
    group?: string;
    /** Canonical receipt block this stage's data lands in (widget key), or null. */
    receiptBlock: string | null;
    /** Widget ids this stage enables (recon §5), for the box-hover "enables" list. */
    widgets: string[];
    /** Conditional path (branch not always taken, flag-gated, or fail-soft). */
    optional?: boolean;
    /** One-line honest note surfaced in the tooltip. */
    note: string;
}

export interface FlowEdgeSpec {
    from: string;
    to: string;
    kind: 'spine' | 'branch' | 'umbrella';
}

/**
 * The canonical DAG. Column 0 = the backbone spine; column 1 = the solve-branch
 * fan (rows 3–5) and the calibrate-umbrella children (rows 6–13).
 */
export const FLOW_NODES: FlowNodeSpec[] = [
    { id: 'load', label: 'Load / Decode', runtime: 'mixed', col: 0, row: 0, receiptBlock: null, widgets: [], note: 'EXIF parse · libraw-wasm decode · WebGPU preview' },
    { id: 'extract', label: 'Detect / Extract', runtime: 'typescript', col: 0, row: 1, receiptBlock: 'signal', widgets: ['culling_waterfall', 'detection_density'], note: 'm4 signal_processor (+opt GPU mask)' },
    { id: 'metrology', label: 'Metrology / Scale', runtime: 'typescript', col: 0, row: 2, receiptBlock: null, widgets: [], note: 'scale-lock + guest list' },
    { id: 'solve', label: 'Plate Solve', runtime: 'typescript', col: 0, row: 3, receiptBlock: 'solution', widgets: ['solve_summary', 'culling_waterfall', 'detection_density', 'color_color_planckian', 'star_labels'], note: 'FOV-branched dispatcher' },

    { id: 'solve.quad_wasm', label: 'Quad match', runtime: 'wasm', col: 1, row: 3, group: 'solve', receiptBlock: 'solution', widgets: ['solve_summary'], note: 'narrow / FITS WASM quad matcher' },
    { id: 'solve.uw_sweep', label: 'UW anchored sweep', runtime: 'typescript', col: 1, row: 4, group: 'solve', receiptBlock: 'solution', widgets: ['solve_summary'], optional: true, note: 'ultra-wide / DSLR blind sweep' },
    { id: 'solve.uw_escalation', label: 'Deep-verify escalate', runtime: 'typescript', col: 1, row: 5, group: 'solve', receiptBlock: 'solution', widgets: [], optional: true, note: '[3.0,4.5)σ forced-photometry rung' },

    { id: 'calibrate', label: 'Calibrate (step 5)', runtime: 'typescript', col: 0, row: 6, receiptBlock: null, widgets: ['distortion_curves', 'distortion_cascade_2d', 'flattening_cascade', 'lens_profile_3d'], note: 'post-solve umbrella' },

    { id: 'm7_refine', label: 'SIP refine (M7)', runtime: 'typescript', col: 1, row: 6, group: 'calibrate', receiptBlock: 'astrometry', widgets: ['distortion_cascade_2d'], note: '>20 matches → SIP fit' },
    { id: 'render_apply_sip', label: 'Apply SIP (render)', runtime: 'webgpu', col: 1, row: 7, group: 'calibrate', receiptBlock: null, widgets: [], optional: true, note: 'PIXEL ledger · default OFF' },
    { id: 'spcc', label: 'SPCC colour-cal', runtime: 'typescript', col: 1, row: 8, group: 'calibrate', receiptBlock: 'spcc', widgets: ['color_color_planckian'], note: 'FITS inputs only' },
    { id: 'psf_field', label: 'PSF field', runtime: 'wasm', col: 1, row: 9, group: 'calibrate', receiptBlock: 'psf_field', widgets: ['psf_field'], note: 'per-star LM FWHM / coma (wasm refine_stars_lm)' },
    { id: 'psf_attribution', label: 'Refraction (Bennett)', runtime: 'typescript', col: 1, row: 10, group: 'calibrate', receiptBlock: 'psf_attribution', widgets: [], note: 'APPROXIMATE atmospheric predictor' },
    { id: 'bc_measure', label: 'Brown-Conrady fit', runtime: 'typescript', col: 1, row: 11, group: 'calibrate', receiptBlock: 'lens_distortion_measured', widgets: ['bc_edge_recovery'], note: 'always-record measured BC' },
    { id: 'bc_rematch', label: 'BC two-pass rematch', runtime: 'typescript', col: 1, row: 12, group: 'calibrate', receiptBlock: 'bc_rematch', widgets: ['bc_edge_recovery'], note: 'default-ON · never-worse guard' },
    { id: 'forced_confirm', label: 'Forced confirm', runtime: 'typescript', col: 1, row: 13, group: 'calibrate', receiptBlock: 'deep_confirmed', widgets: ['forced_photometry_z'], note: 'set-level family-wise gate' },

    { id: 'psf', label: 'RL deconv', runtime: 'mixed', col: 0, row: 14, receiptBlock: null, widgets: [], optional: true, note: 'windowed Richardson-Lucy · default OFF' },
    { id: 'integrate', label: 'Integrate / Receipt', runtime: 'typescript', col: 0, row: 15, receiptBlock: null, widgets: [], note: 'buildReceipt' },
];

export const FLOW_EDGES: FlowEdgeSpec[] = [
    // backbone spine
    { from: 'load', to: 'extract', kind: 'spine' },
    { from: 'extract', to: 'metrology', kind: 'spine' },
    { from: 'metrology', to: 'solve', kind: 'spine' },
    { from: 'solve', to: 'calibrate', kind: 'spine' },
    { from: 'calibrate', to: 'psf', kind: 'spine' },
    { from: 'psf', to: 'integrate', kind: 'spine' },
    // solve branch fan
    { from: 'solve', to: 'solve.quad_wasm', kind: 'branch' },
    { from: 'solve', to: 'solve.uw_sweep', kind: 'branch' },
    { from: 'solve', to: 'solve.uw_escalation', kind: 'branch' },
    // calibrate umbrella
    { from: 'calibrate', to: 'm7_refine', kind: 'umbrella' },
    { from: 'calibrate', to: 'render_apply_sip', kind: 'umbrella' },
    { from: 'calibrate', to: 'spcc', kind: 'umbrella' },
    { from: 'calibrate', to: 'psf_field', kind: 'umbrella' },
    { from: 'calibrate', to: 'psf_attribution', kind: 'umbrella' },
    { from: 'calibrate', to: 'bc_measure', kind: 'umbrella' },
    { from: 'calibrate', to: 'bc_rematch', kind: 'umbrella' },
    { from: 'calibrate', to: 'forced_confirm', kind: 'umbrella' },
];

export const NODE_BY_ID: Record<string, FlowNodeSpec> = Object.fromEntries(FLOW_NODES.map(n => [n.id, n]));

/** Runtimes actually used by the DAG (drives an honest legend — no dead swatches). */
export function usedRuntimes(): Runtime[] {
    const order: Runtime[] = ['typescript', 'wasm', 'webgpu', 'mixed'];
    const present = new Set(FLOW_NODES.map(n => n.runtime));
    return order.filter(r => present.has(r));
}

// ─── geometry (orientation-aware) ─────────────────────────────────────────────

/**
 * Two layouts of the SAME DAG:
 *   HORIZONTAL (default, landscape / dashboard pane) — the backbone spine runs
 *     left→right along the top; each parent's solve-branch fan and calibrate
 *     umbrella STACK VERTICALLY in a column beneath it, joined by a left-hugging
 *     trunk (owner spec-review: "horizontal, integrated into the dashboard").
 *   VERTICAL (portrait / phones) — the original layout: spine down the left,
 *     branch / umbrella children to the right. Unchanged, selected on narrow
 *     containers.
 * Orientation is a pure function of the container aspect (`orientationForAspect`).
 */
export type Orientation = 'horizontal' | 'vertical';

/**
 * Pure orientation selector from a container's pixel box: HORIZONTAL (the
 * dashboard default) when the container is landscape or square, VERTICAL when it
 * is portrait (phones). Non-finite / degenerate sizes fall back to horizontal.
 */
export function orientationForAspect(width: number, height: number): Orientation {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'horizontal';
    return width >= height ? 'horizontal' : 'vertical';
}

// shared box size (identical in both orientations)
const NODE_W = 152;
const NODE_H = 28;

// vertical (portrait) grid — the original phone layout, preserved verbatim
const V_COL_X = [12, 214] as const;   // [spine col, branch/umbrella col]
const V_ROW_H = 40;
const V_TOP = 12;

// horizontal (landscape) grid — spine along X; branch/umbrella stacks hang below
const H_MARGIN = 12;
const H_TOP = 12;
const H_COL_STEP = 176;   // spine column pitch (NODE_W 152 + 24 gap)
const H_ROW_STEP = 40;    // stacked-child pitch (NODE_H 28 + 12 gap)
const H_TRUNK_GAP = 10;   // trunk offset to the left of a child column

/** Shared box dims (per-orientation extents come from `layoutDims`). */
export const LAYOUT = { NODE_W, NODE_H } as const;

export interface NodeBox { x: number; y: number; w: number; h: number; cx: number; cy: number; }

function boxAt(x: number, y: number): NodeBox {
    return { x, y, w: NODE_W, h: NODE_H, cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
}

/**
 * A resolved geometry engine for ONE graph: the spine/umbrella layout math bound
 * to a specific node set. `makeFlowLayout` derives the spine order, per-group child
 * indices and extents ONCE from the nodes (no hand-tuned duplication), then returns
 * the three geometry closures the renderer needs. This is graph-agnostic so the
 * receipt-driven greenfield DAG (flowchart_receipt.ts) reuses the SAME layout
 * engine — the two graphs can never drift in how a box or edge is placed.
 *
 * LAYOUT CONVENTION (both graphs must satisfy): a group's parent spine node has id
 * === the group name, so the umbrella hangs beneath its root column (legacy:
 * group 'solve'→node 'solve', 'calibrate'→'calibrate'). If that node is missing the
 * first spine node is used as a safe fallback.
 */
export interface FlowLayout {
    nodeBox(spec: FlowNodeSpec, orientation?: Orientation): NodeBox;
    layoutDims(orientation?: Orientation): { width: number; height: number };
    edgePathD(edge: FlowEdgeSpec, orientation?: Orientation): string;
}

export function makeFlowLayout(nodes: readonly FlowNodeSpec[]): FlowLayout {
    const byId: Record<string, FlowNodeSpec> = Object.fromEntries(nodes.map(n => [n.id, n]));
    const spineOrder = nodes.filter(n => n.col === 0).slice().sort((a, b) => a.row - b.row);
    const spineIndex: Record<string, number> = Object.fromEntries(spineOrder.map((n, i) => [n.id, i]));

    const childIndex: Record<string, number> = (() => {
        const groups = new Map<string, FlowNodeSpec[]>();
        for (const n of nodes) if (n.group) {
            const arr = groups.get(n.group) ?? [];
            arr.push(n);
            groups.set(n.group, arr);
        }
        const out: Record<string, number> = {};
        for (const arr of groups.values()) {
            arr.slice().sort((a, b) => a.row - b.row).forEach((n, i) => { out[n.id] = i; });
        }
        return out;
    })();

    // group name → its parent spine node id (convention: parent id === group name).
    const groupParent: Record<string, string> = {};
    for (const n of nodes) if (n.group && !(n.group in groupParent)) {
        groupParent[n.group] = byId[n.group] ? n.group : (spineOrder[0]?.id ?? n.group);
    }

    const maxChildRows = Object.values(childIndex).reduce((m, k) => Math.max(m, k + 1), 0);
    const maxRow = nodes.length ? Math.max(...nodes.map(n => n.row)) : 0;

    function nodeBoxImpl(spec: FlowNodeSpec, orientation: Orientation = 'horizontal'): NodeBox {
        if (orientation === 'vertical') {
            const x = V_COL_X[spec.col] ?? V_COL_X[0];
            return boxAt(x, V_TOP + spec.row * V_ROW_H);
        }
        // horizontal: spine along the top row; children stack below their parent column.
        if (spec.col === 0) {
            const si = spineIndex[spec.id] ?? 0;
            return boxAt(H_MARGIN + si * H_COL_STEP, H_TOP);
        }
        const parentId = spec.group ? groupParent[spec.group] : undefined;
        const si = (parentId != null ? spineIndex[parentId] : undefined) ?? 0;
        const k = childIndex[spec.id] ?? 0;
        return boxAt(H_MARGIN + si * H_COL_STEP, H_TOP + (k + 1) * H_ROW_STEP);
    }

    function layoutDimsImpl(orientation: Orientation = 'horizontal'): { width: number; height: number } {
        if (orientation === 'vertical') {
            return { width: V_COL_X[1] + NODE_W + 12, height: V_TOP + (maxRow + 1) * V_ROW_H };
        }
        const maxSpine = Math.max(0, spineOrder.length - 1);
        return {
            width: H_MARGIN + maxSpine * H_COL_STEP + NODE_W + H_MARGIN,
            height: H_TOP + maxChildRows * H_ROW_STEP + NODE_H + 12,
        };
    }

    function edgePathDImpl(edge: FlowEdgeSpec, orientation: Orientation = 'horizontal'): string {
        const from = byId[edge.from];
        const to = byId[edge.to];
        if (!from || !to) return '';
        const a = nodeBoxImpl(from, orientation);
        const b = nodeBoxImpl(to, orientation);
        if (orientation === 'vertical') {
            if (edge.kind === 'spine') {
                // down the spine: source bottom-center → dest top-center (same column x)
                return `M ${a.cx} ${a.y + a.h} L ${b.cx} ${b.y}`;
            }
            // branch / umbrella: right-center → elbow → left-center of the child
            const sx = a.x + a.w, sy = a.cy;
            const dx = b.x, dy = b.cy;
            const midX = sx + (dx - sx) / 2;
            return `M ${sx} ${sy} H ${midX} V ${dy} H ${dx}`;
        }
        // horizontal
        if (edge.kind === 'spine') {
            // along the spine: source right-center → dest left-center (same top row)
            return `M ${a.x + a.w} ${a.cy} L ${b.x} ${b.cy}`;
        }
        // branch / umbrella: parent left-center → left trunk → down → into child left
        const trunkX = b.x - H_TRUNK_GAP;
        return `M ${a.x} ${a.cy} H ${trunkX} V ${b.cy} H ${b.x}`;
    }

    return { nodeBox: nodeBoxImpl, layoutDims: layoutDimsImpl, edgePathD: edgePathDImpl };
}

/** The LEGACY graph's geometry engine — the module-level exports below bind to it
 *  so every existing importer (WebGPU twin, preview generator, tests) is unchanged. */
const LEGACY_LAYOUT: FlowLayout = makeFlowLayout(FLOW_NODES);

/** Box geometry for a LEGACY-graph node (unchanged signature; delegates to the layout engine). */
export function nodeBox(spec: FlowNodeSpec, orientation: Orientation = 'horizontal'): NodeBox {
    return LEGACY_LAYOUT.nodeBox(spec, orientation);
}

/** Overall SVG extents for the LEGACY graph in an orientation (viewBox width/height). */
export function layoutDims(orientation: Orientation = 'horizontal'): { width: number; height: number } {
    return LEGACY_LAYOUT.layoutDims(orientation);
}

/** SVG path 'd' for a LEGACY-graph edge (straight spine, or orthogonal trunk-elbow for a branch). */
export function edgePathD(edge: FlowEdgeSpec, orientation: Orientation = 'horizontal'): string {
    return LEGACY_LAYOUT.edgePathD(edge, orientation);
}

// ─── live status (current-run highlight) ────────────────────────────────────

export type LiveStatus = 'active' | 'failed' | 'done' | 'idle';

/**
 * Derive a per-stage live status from the event stream, scoped to the CURRENT
 * run (everything after the last `run_started`). A stage whose last event is
 * `stage_started` is ACTIVE (lit up); a `stage_finished{ok:false}` is FAILED
 * (painted red); `stage_finished{ok:true}` is DONE; unseen stages are IDLE.
 */
export function computeLiveStatus(events: readonly PipelineEvent[] | undefined): Record<string, LiveStatus> {
    const status: Record<string, LiveStatus> = {};
    if (!events || events.length === 0) return status;
    // Scope to the current run.
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].kind === 'run_started') { start = i; break; }
    }
    for (let i = start; i < events.length; i++) {
        const e = events[i];
        if (e.kind === 'stage_started') status[e.stage] = 'active';
        else if (e.kind === 'stage_finished') status[e.stage] = e.ok === false ? 'failed' : 'done';
    }
    return status;
}

export const STATUS_COLOR_VAR: Record<LiveStatus, string> = {
    active: '--color-accent-400',
    failed: '--color-danger',
    done: '--color-solve',
    idle: '--color-text-faint',
};

/**
 * Map a ★ Replay Dashboard frame's per-stage phases onto the flowchart live-
 * status map (pure). A widget rendered in a dashboard pane lights its boxes from
 * THIS (the scrub frame) instead of the live bus:
 *   pending → idle (grey) · active → active (pulse) · complete → done | failed
 *   (verdict colour, by `ok`).
 * Structural param (no replay-module import) so the model stays Node-pure and
 * unit-testable without the dashboard.
 */
export function liveStatusFromReplay(
    stages: ReadonlyArray<{ stageId: string; phase: 'pending' | 'active' | 'complete'; ok: boolean | null }>,
): Record<string, LiveStatus> {
    const out: Record<string, LiveStatus> = {};
    for (const s of stages) {
        out[s.stageId] = s.phase === 'active' ? 'active'
            : s.phase === 'complete' ? (s.ok === false ? 'failed' : 'done')
            : 'idle';
    }
    return out;
}

// ─── tooltip builders (plain data — rendered by React or the Node preview) ──

/** Format a millisecond duration honestly (1 dp under 10 ms, else integer). */
export function fmtMs(ms: number | null): string {
    if (ms == null || !Number.isFinite(ms)) return '—';
    return ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
}

export interface NodeTooltip {
    title: string;
    runtimeLabel: string;
    optional: boolean;
    /** ABOVE — snippet of data captured (verdict / counts / receipt block / timing). */
    captured: string[];
    /** BELOW — widgets this box enables (or an honest "(no widget)" line). */
    enables: string[];
    measured: boolean;
}

export function buildNodeTooltip(spec: FlowNodeSpec, stat: StageStat | undefined): NodeTooltip {
    const runtimeLabel = RUNTIME_META[spec.runtime].label;
    const measured = !!stat && stat.reached > 0;
    const captured: string[] = [];
    if (measured && stat) {
        captured.push(`verdict: ${stat.verdict ?? '—'}`);
        for (const [k, v] of Object.entries(stat.counts)) captured.push(`${k}: ${v}`);
        captured.push(`receipt → ${stat.payload_ref ?? spec.receiptBlock ?? '—'}`);
        captured.push(`frames: reached ${stat.reached} · pass ${stat.passed} · fail ${stat.failed}`);
        if (stat.timing_samples > 0) {
            captured.push(`time: ${fmtMs(stat.min_ms)}–${fmtMs(stat.max_ms)} ms (avg ${fmtMs(stat.avg_ms)}, N=${stat.timing_samples})`);
        } else {
            captured.push('time: NOT MEASURED');
        }
    } else {
        captured.push('NOT MEASURED');
        if (spec.receiptBlock) captured.push(`(would land in receipt → ${spec.receiptBlock})`);
    }
    const enables = spec.widgets.length ? spec.widgets.slice() : ['(enables no widget yet)'];
    return { title: spec.label, runtimeLabel, optional: !!spec.optional, captured, enables, measured };
}

export interface EdgeTooltip {
    title: string;
    /** ABOVE — timing range fastest → average → slowest successful solve. */
    timing: string;
    /** BELOW — [% and count] failing AT this stage vs passing through. */
    flow: string;
    measured: boolean;
}

export function buildEdgeTooltip(destSpec: FlowNodeSpec, stat: StageStat | undefined): EdgeTooltip {
    const title = `→ ${destSpec.label}`;
    if (!stat || stat.reached === 0) {
        return { title, timing: 'timing: NOT MEASURED', flow: 'flow: NOT MEASURED', measured: false };
    }
    const timing = stat.timing_samples > 0
        ? `${fmtMs(stat.min_ms)} → ${fmtMs(stat.avg_ms)} → ${fmtMs(stat.max_ms)} ms  (fast→avg→slow, N=${stat.timing_samples})`
        : 'timing: NOT MEASURED (no successful-solve sample)';
    const pct = (n: number) => `${Math.round((n / stat.reached) * 100)}%`;
    const flow = `pass-through ${stat.passed} (${pct(stat.passed)}) · fail-here ${stat.failed} (${pct(stat.failed)})  [of ${stat.reached} reaching]`;
    return { title, timing, flow, measured: true };
}

/** Convenience: look up a stage stat from the aggregate (undefined ⇒ NOT MEASURED). */
export function statFor(agg: FlowchartAggregate | null | undefined, id: string): StageStat | undefined {
    return agg?.stages[id];
}
