/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOWCHART GPU SCENE — pure model → GPU vertex/instance buffers (UI ledger).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The WebGPU twin of the ★ Solve Flowchart renders the SAME DAG the SVG widget
 * draws — identical geometry, straight from the shared `flowchart_model` (LAW 4:
 * one source of truth for node boxes + edge paths). This module is the PURE
 * bridge: it folds `FLOW_NODES` / `FLOW_EDGES` + a per-stage live-status map into
 * flat Float32 buffers the WGSL render pipeline consumes. No React, no WebGPU, no
 * DOM — so the buffer packing is unit-testable in the node vitest env, exactly
 * like `flowchart_model` itself.
 *
 * Honest-or-absent (LAW 3): this module only lays out geometry + status colours.
 * It fabricates no measurement — the "data captured / timing" numbers stay in the
 * DOM tooltip (built from the same `flowchart_model` builders the SVG uses).
 */

import {
    FLOW_NODES, FLOW_EDGES, NODE_BY_ID, nodeBox, edgePathD,
    type Runtime, type LiveStatus, type Orientation,
} from '../widgets/flowchart_model';

// ─── resolved colour palette (numbers, so the builder stays pure) ─────────────

export type RGB = [number, number, number];

export interface FlowchartGpuPalette {
    /** Per-runtime box fill/idle-border colour. */
    runtime: Record<Runtime, RGB>;
    /** Live-status border colours (active pulses; failed = red; done = green). */
    status: Record<LiveStatus, RGB>;
    /** Default edge stroke (line-strong). */
    edge: RGB;
    /** Canvas clear colour (app well). */
    background: RGB;
    /** DOM label colour (used by the overlay, carried here for one source). */
    label: RGB;
}

/** Documented dark-theme fallbacks (src/index.css @theme) — used when no DOM. */
const FALLBACK_HEX: Record<string, string> = {
    '--chart-cat-1': '#38bdf8',
    '--chart-cat-2': '#fbbf24',
    '--chart-cat-4': '#a78bfa',
    '--chart-cat-5': '#f472b6',
    '--color-accent-400': '#38bdf8',
    '--color-danger': '#f87171',
    '--color-solve': '#34d399',
    '--color-text-faint': '#3d4763',
    '--color-line-strong': '#3d4763',
    '--color-space-900': '#0a0c12',
    '--color-text-primary': '#e8ecf4',
};

/** Parse a #rgb / #rrggbb / rgb(...) / "r g b" colour to a 0..1 RGB triple. */
export function parseColor(raw: string): RGB {
    const s = (raw || '').trim();
    if (s.startsWith('#')) {
        let h = s.slice(1);
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const n = parseInt(h.slice(0, 6) || '000000', 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    // rgb()/rgba()/space-separated numeric
    const nums = s.replace(/rgba?\(/i, '').replace(/[),]/g, ' ').trim().split(/[\s]+/).map(Number);
    if (nums.length >= 3 && nums.every((v) => Number.isFinite(v))) {
        return [nums[0] / 255, nums[1] / 255, nums[2] / 255];
    }
    return [0.5, 0.5, 0.5];
}

/** Read one CSS custom property live (with documented fallback). */
function readVar(name: string): string {
    try {
        if (typeof document !== 'undefined' && document.documentElement) {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            if (v) return v;
        }
    } catch { /* no DOM */ }
    return FALLBACK_HEX[name] ?? '#888888';
}

/** Resolve the flowchart palette from live CSS vars (theme-aware; fallbacks in tests). */
export function resolveFlowchartPalette(): FlowchartGpuPalette {
    const c = (v: string) => parseColor(readVar(v));
    return {
        runtime: {
            typescript: c('--chart-cat-1'),
            wasm: c('--chart-cat-2'),
            webgpu: c('--chart-cat-4'),
            mixed: c('--chart-cat-5'),
        },
        status: {
            active: c('--color-accent-400'),
            failed: c('--color-danger'),
            done: c('--color-solve'),
            idle: c('--color-text-faint'),
        },
        edge: c('--color-line-strong'),
        background: c('--color-space-900'),
        label: c('--color-text-primary'),
    };
}

// ─── instance packing ─────────────────────────────────────────────────────────

/** Float32 stride per node instance: rect(4) fill(4) border(4) params(4). */
export const NODE_INSTANCE_FLOATS = 16;
/** Float32 stride per edge vertex: pos(2) colour(4). */
export const EDGE_VERTEX_FLOATS = 6;

const NODE_FILL_ALPHA = 0.16;
const NODE_BORDER_PX = 1.4;
const NODE_RADIUS_PX = 5;
const EDGE_HALF_PX = 0.85; // ≈ 1.7 px stroke, matching the SVG's 1.3–2.4 px range

/** Border colour for a node given its live status (idle ⇒ its runtime colour). */
function borderColor(runtime: Runtime, st: LiveStatus, pal: FlowchartGpuPalette): RGB {
    if (st === 'active') return pal.status.active;
    if (st === 'failed') return pal.status.failed;
    if (st === 'done') return pal.status.done;
    return pal.runtime[runtime];
}

export interface FlowchartScene {
    /** Packed per-node instance data (length = nodeCount × NODE_INSTANCE_FLOATS). */
    instances: Float32Array<ArrayBuffer>;
    nodeCount: number;
    /** Packed edge-segment triangle vertices (thick-line quads). */
    edgeVerts: Float32Array<ArrayBuffer>;
    edgeVertexCount: number;
}

/**
 * Build the full GPU scene (node instances + edge triangles) for one orientation
 * + live-status map. Pure: identical geometry to the SVG widget (same `nodeBox` /
 * `edgePathD`), so the two renders line up node-for-node.
 */
export function buildFlowchartScene(
    orientation: Orientation,
    live: Record<string, LiveStatus>,
    pal: FlowchartGpuPalette,
): FlowchartScene {
    // Nodes.
    const nodeCount = FLOW_NODES.length;
    const instances = new Float32Array(nodeCount * NODE_INSTANCE_FLOATS);
    FLOW_NODES.forEach((spec, i) => {
        const b = nodeBox(spec, orientation);
        const st = live[spec.id] ?? 'idle';
        const fill = pal.runtime[spec.runtime];
        const bord = borderColor(spec.runtime, st, pal);
        const o = i * NODE_INSTANCE_FLOATS;
        instances[o + 0] = b.x; instances[o + 1] = b.y; instances[o + 2] = b.w; instances[o + 3] = b.h;
        instances[o + 4] = fill[0]; instances[o + 5] = fill[1]; instances[o + 6] = fill[2]; instances[o + 7] = NODE_FILL_ALPHA;
        instances[o + 8] = bord[0]; instances[o + 9] = bord[1]; instances[o + 10] = bord[2]; instances[o + 11] = 1;
        instances[o + 12] = st === 'active' ? 1 : 0; // pulse flag
        instances[o + 13] = NODE_BORDER_PX;
        instances[o + 14] = NODE_RADIUS_PX;
        instances[o + 15] = 0;
    });

    // Edges — expand each polyline segment to a thick-line quad (2 triangles).
    const verts: number[] = [];
    for (const edge of FLOW_EDGES) {
        const dest = NODE_BY_ID[edge.to];
        const st = dest ? (live[edge.to] ?? 'idle') : 'idle';
        const col: RGB = st === 'active' ? pal.status.active : st === 'failed' ? pal.status.failed : pal.edge;
        const pts = polylineFromPath(edgePathD(edge, orientation));
        for (let s = 0; s < pts.length - 1; s++) {
            pushSegment(verts, pts[s], pts[s + 1], EDGE_HALF_PX, col);
        }
    }
    const edgeVerts = new Float32Array(verts);
    return { instances, nodeCount, edgeVerts, edgeVertexCount: verts.length / EDGE_VERTEX_FLOATS };
}

type Pt = [number, number];

/** Emit a thick-line quad (a→b, half-width h) as two triangles with a flat colour. */
function pushSegment(out: number[], a: Pt, b: Pt, h: number, col: RGB): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * h;
    const ny = (dx / len) * h;
    const [r, g, bl] = col;
    const p = (x: number, y: number) => out.push(x, y, r, g, bl, 1);
    // triangle 1: a+n, b+n, b-n
    p(a[0] + nx, a[1] + ny); p(b[0] + nx, b[1] + ny); p(b[0] - nx, b[1] - ny);
    // triangle 2: a+n, b-n, a-n
    p(a[0] + nx, a[1] + ny); p(b[0] - nx, b[1] - ny); p(a[0] - nx, a[1] - ny);
}

/**
 * Parse the SVG path string `edgePathD` emits (only absolute M / L / H / V) into
 * a polyline. Reusing the SAME path builder the SVG widget uses guarantees the
 * WebGPU edges trace the identical route (zero geometry divergence, LAW 4).
 */
export function polylineFromPath(d: string): Pt[] {
    const pts: Pt[] = [];
    const tokens = d.trim().split(/\s+/);
    let x = 0, y = 0;
    let i = 0;
    while (i < tokens.length) {
        const cmd = tokens[i++];
        switch (cmd) {
            case 'M':
            case 'L':
                x = Number(tokens[i++]); y = Number(tokens[i++]);
                pts.push([x, y]);
                break;
            case 'H':
                x = Number(tokens[i++]);
                pts.push([x, y]);
                break;
            case 'V':
                y = Number(tokens[i++]);
                pts.push([x, y]);
                break;
            default:
                // Unrecognized token (shouldn't occur) — skip.
                break;
        }
    }
    return pts;
}
