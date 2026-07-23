import { describe, it, expect, vi } from 'vitest';
import { OrchestratorSession } from '../pipeline/orchestrator_session';

/**
 * OrchestratorSession.dispose() — session-replacement teardown (2026-07-22
 * ship-blocker fix). Releases the heavy retained image buffers + preview blob
 * URL BEFORE the next image decodes, so the two never coexist and blow a
 * constrained webview's memory budget (the measured cause of "can't run another
 * image"). Pure memory hygiene — never called mid-solve, so the sacred pins are
 * untouched (proven separately by the apispecs). This gates the teardown itself.
 */
describe('OrchestratorSession.dispose — memory-hygiene teardown', () => {
    it('nulls the heavy retained buffers and revokes the preview blob URL', () => {
        const session = new OrchestratorSession(new ArrayBuffer(16));
        // Simulate a COMPLETED run holding the dominant retained footprint.
        (session as any).scienceBuffer = new Float32Array(4);
        (session as any).previewFloat32 = new Float32Array(4);
        (session as any).scienceRgb = { data: new Float32Array(12), width: 2, height: 2 };
        session.previewUrl = 'blob:fake-preview';

        const revoke = vi.fn();
        const prev = (globalThis as any).URL.revokeObjectURL;
        (globalThis as any).URL.revokeObjectURL = revoke;
        try {
            session.dispose();
        } finally {
            (globalThis as any).URL.revokeObjectURL = prev;
        }

        expect((session as any).scienceBuffer).toBeNull();
        expect((session as any).previewFloat32).toBeNull();
        expect((session as any).scienceRgb).toBeNull();
        expect(session.previewUrl).toBeNull();
        expect(revoke).toHaveBeenCalledWith('blob:fake-preview');
    });

    it('is idempotent and never throws (double dispose, no preview)', () => {
        const session = new OrchestratorSession(new ArrayBuffer(16));
        expect(() => { session.dispose(); session.dispose(); }).not.toThrow();
        expect(session.previewUrl).toBeNull();
    });

    it('does not revoke a non-blob preview url (data: URIs need no revoke)', () => {
        const session = new OrchestratorSession(new ArrayBuffer(16));
        session.previewUrl = 'data:image/png;base64,AAAA';
        const revoke = vi.fn();
        const prev = (globalThis as any).URL.revokeObjectURL;
        (globalThis as any).URL.revokeObjectURL = revoke;
        try { session.dispose(); } finally { (globalThis as any).URL.revokeObjectURL = prev; }
        expect(revoke).not.toHaveBeenCalled();
        expect(session.previewUrl).toBeNull();
    });
});
