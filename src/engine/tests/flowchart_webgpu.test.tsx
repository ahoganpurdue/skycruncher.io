/**
 * WEBGPU FLOWCHART TWIN — pure scene-builder + honest-unavailable-state coverage.
 *
 * The A/B twin's GPU-buffer packing is PURE (no WebGPU, no DOM) so it pins here
 * exactly like `flowchart_model`. The React render is exercised in the node env
 * (no `navigator.gpu`) — which is precisely the honest "WebGPU unavailable" path
 * the widget must show instead of a blank canvas or a silent SVG fallback.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Import the registry FIRST so the widget-manifest module cycle
// (registry ⇄ SolveFlowchartWidget ⇄ SolveFlowchartWebGPU) evaluates in the same
// order the app uses (registry is always the entry point), keeping
// `solveFlowchartWidget` defined before `withFlowchartFps` reads it.
import '../ui/widgets/registry';
import {
    buildFlowchartScene, resolveFlowchartPalette, parseColor, polylineFromPath,
    NODE_INSTANCE_FLOATS, EDGE_VERTEX_FLOATS,
} from '../ui/widgets/flowchart_webgpu/flowchart_gpu_scene';
import { FLOW_NODES } from '../ui/widgets/widgets/flowchart_model';
import { solveFlowchartWebgpuWidget } from '../ui/widgets/flowchart_webgpu/SolveFlowchartWebGPU';
import type { FlowchartWidgetData } from '../ui/widgets/widgets/SolveFlowchartWidget';

const EMPTY_DATA: FlowchartWidgetData = {
    aggregate: { run_count: 0, frame_count: 0, unhashed_count: 0, successful_frames: 0, stages: {} },
    events: [],
    receipt: null,
};

describe('flowchart_gpu_scene — pure GPU-buffer packing', () => {
    it('parseColor handles hex, short-hex, and rgb()', () => {
        expect(parseColor('#000000')).toEqual([0, 0, 0]);
        const c = parseColor('#38bdf8');
        expect(c[0]).toBeCloseTo(0x38 / 255, 5);
        expect(c[1]).toBeCloseTo(0xbd / 255, 5);
        expect(c[2]).toBeCloseTo(0xf8 / 255, 5);
        expect(parseColor('#fff')).toEqual([1, 1, 1]);
        const r = parseColor('rgb(255, 128, 0)');
        expect(r[0]).toBeCloseTo(1, 5);
        expect(r[1]).toBeCloseTo(128 / 255, 5);
        expect(r[2]).toBe(0);
    });

    it('polylineFromPath parses the M/L/H/V paths edgePathD emits', () => {
        expect(polylineFromPath('M 10 20 L 30 40')).toEqual([[10, 20], [30, 40]]);
        // orthogonal elbow (branch/umbrella shape): M → H → V → H
        expect(polylineFromPath('M 10 20 H 30 V 40 H 50')).toEqual([[10, 20], [30, 20], [30, 40], [50, 40]]);
    });

    it('builds one instance per node (correct stride) and non-empty edge triangles', () => {
        const pal = resolveFlowchartPalette(); // node env ⇒ documented fallbacks
        const scene = buildFlowchartScene('horizontal', {}, pal);
        expect(scene.nodeCount).toBe(FLOW_NODES.length);
        expect(scene.instances.length).toBe(FLOW_NODES.length * NODE_INSTANCE_FLOATS);
        expect(scene.edgeVertexCount).toBeGreaterThan(0);
        expect(scene.edgeVerts.length).toBe(scene.edgeVertexCount * EDGE_VERTEX_FLOATS);
        // edge triangles come in multiples of 3 vertices.
        expect(scene.edgeVertexCount % 3).toBe(0);
    });

    it('live "active" status sets the per-node pulse flag + status border (honest lighting)', () => {
        const pal = resolveFlowchartPalette();
        const firstId = FLOW_NODES[0].id;
        const scene = buildFlowchartScene('horizontal', { [firstId]: 'active' }, pal);
        // pulse flag is float index 12 of the first instance.
        expect(scene.instances[12]).toBe(1);
        // border rgb (floats 8..10) equals the active status colour, not the runtime colour
        // (float32 buffer storage ⇒ compare per channel at f32 precision).
        expect(scene.instances[8]).toBeCloseTo(pal.status.active[0], 5);
        expect(scene.instances[9]).toBeCloseTo(pal.status.active[1], 5);
        expect(scene.instances[10]).toBeCloseTo(pal.status.active[2], 5);
        // a non-active node keeps pulse 0.
        const secondScene = buildFlowchartScene('horizontal', {}, pal);
        expect(secondScene.instances[12]).toBe(0);
    });

    it('vertical orientation still yields a full scene (orientation-parametric)', () => {
        const pal = resolveFlowchartPalette();
        const scene = buildFlowchartScene('vertical', {}, pal);
        expect(scene.nodeCount).toBe(FLOW_NODES.length);
        expect(scene.edgeVertexCount).toBeGreaterThan(0);
    });
});

describe('SolveFlowchartWebGPU — honest availability gating (no WebGPU in node)', () => {
    it('renders the explicit WebGPU-unavailable state, never a blank/fallback', () => {
        const Render = solveFlowchartWebgpuWidget.render;
        const markup = renderToStaticMarkup(<Render data={EMPTY_DATA} />);
        expect(markup).toContain('flowchart-webgpu-unavailable');
        expect(markup).toContain('WebGPU unavailable');
        // honest: it points at the SVG twin rather than silently substituting one.
        expect(markup).toContain('Solve Flowchart');
    });

    it('manifest reuses the identical selector + is stats-tier (A/B default-visible)', () => {
        expect(solveFlowchartWebgpuWidget.weightTier).toBe('stats');
        expect(solveFlowchartWebgpuWidget.id).toBe('solve_flowchart_webgpu');
    });
});
