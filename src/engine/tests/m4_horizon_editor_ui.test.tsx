/**
 * HORIZON EDITOR panel — honest-or-absent UI states (renderToStaticMarkup).
 *
 * Three states the walkthrough cares about:
 *  - no-envelope / no terrain evidence → the affordance is ABSENT (renders '').
 *  - auto-only (an estimate, nothing corrected) → AUTO state + Edit toggle, no Reset.
 *  - user-corrected (deltas recorded) → USER CORRECTED badge + edit count + Reset.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HorizonEditorPanel } from '../ui/HorizonEditorPanel';
import type { HorizonEnvelope } from '../pipeline/m4_signal_detect/horizon_envelope';
import {
    initHorizonEdit,
    moveHorizonNode,
    buildHorizonCorrection,
    type HorizonCorrectionRecord,
} from '../pipeline/m4_signal_detect/horizon_editor';

const noop = () => {};

function envelope(hasTerrainEvidence = true): HorizonEnvelope {
    return {
        points: [
            { x: 0, y: 100, measured: true },
            { x: 100, y: 100, measured: true },
            { x: 200, y: 100, measured: true },
        ],
        coverage: 0.8,
        hasTerrainEvidence,
    };
}

function correction(): HorizonCorrectionRecord {
    const env = envelope();
    const s = moveHorizonNode(initHorizonEdit(env), 1, 100, 160);
    return buildHorizonCorrection(env, s, { width: 300, height: 200 }, '2026-07-11T00:00:00.000Z')!;
}

describe('HorizonEditorPanel — honest-or-absent UI states', () => {
    it('no-envelope: renders nothing (no affordance without an estimate)', () => {
        const html = renderToStaticMarkup(
            <HorizonEditorPanel envelope={null} correction={null} editing={false} onToggleEdit={noop} onReset={noop} />,
        );
        expect(html).toBe('');
    });

    it('no terrain evidence: renders nothing (honest-or-absent)', () => {
        const html = renderToStaticMarkup(
            <HorizonEditorPanel envelope={envelope(false)} correction={null} editing={false} onToggleEdit={noop} onReset={noop} />,
        );
        expect(html).toBe('');
    });

    it('auto-only: AUTO state, an Edit toggle, node count, and no Reset', () => {
        const html = renderToStaticMarkup(
            <HorizonEditorPanel envelope={envelope()} correction={null} editing={false} onToggleEdit={noop} onReset={noop} />,
        );
        expect(html).toContain('horizon-editor-panel');
        expect(html).toContain('data-corrected="false"');
        expect(html).toContain('AUTO');
        expect(html).not.toContain('USER CORRECTED');
        expect(html).toContain('horizon-editor-toggle');
        expect(html).toContain('3 nodes');
        expect(html).not.toContain('horizon-editor-reset');
    });

    it('user-corrected: USER CORRECTED badge, edit count, node count, and a Reset', () => {
        const html = renderToStaticMarkup(
            <HorizonEditorPanel envelope={envelope()} correction={correction()} editing={true} onToggleEdit={noop} onReset={noop} />,
        );
        expect(html).toContain('horizon-editor-panel');
        expect(html).toContain('data-corrected="true"');
        expect(html).toContain('USER CORRECTED');
        expect(html).toContain('horizon-editor-edits');
        expect(html).toContain('horizon-editor-reset');
        expect(html).toContain('3 nodes');
    });
});
