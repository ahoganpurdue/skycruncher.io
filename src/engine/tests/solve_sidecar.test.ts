// Solve Queue → live-stack SIDECAR: pure builder + CHAIN PROOF through the real
// follower consumer (tools/stack/live_stack.mjs `acceptedSolve`).
//
//   npx vitest run src/engine/tests/solve_sidecar.test.ts
//
// The Solve Queue emits `<frameBasename>.solve.json` next to a solved frame; the
// live-stack follower re-stacks a frame only when that sidecar reports
// `accepted === true`. This suite proves (a) the builder emits exactly the fields
// the follower reads, and (b) the follower's REAL acceptance gate accepts a
// sidecar our builder produced — the end-to-end contract, no invented shape.
//
// Self-contained: the "real receipt" is the pinned SeeStar reference solution
// (byte-identical, docs/GATES.md — a genuine banked solve), so the test is
// deterministic and green in a clean clone (no gitignored test_results needed).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildSolveSidecar,
    resultFromSolution,
    type SolutionLike,
    type QueueSolveResult,
} from '../ui/dashboard/solve_queue/queue_state';
// The REAL live-stack follower consumer (same module the demo chain runs).
import { acceptedSolve } from '../../../tools/stack/live_stack.mjs';

// Pinned SeeStar reference solve (docs/GATES.md — byte-identical banked values).
const SEESTAR_SOLUTION: SolutionLike = {
    ra_hours: 11.341253475172621,
    dec_degrees: 13.0,
    pixel_scale: 3.6776147325019153,
    confidence: 0.8310893541573466,
    matched_stars: { length: 272 },
};

describe('buildSolveSidecar (pure builder — follower contract fields)', () => {
    const result: QueueSolveResult = {
        raHours: 11.341253475172621,
        decDeg: 13.0,
        scaleArcsecPerPx: 3.6776147325019153,
        matched: 272,
        confidence: 0.8310893541573466,
    };

    it('emits exactly the fields the follower reads, with accepted:true + provenance', () => {
        const s = buildSolveSidecar('frame_0000.fits', result);
        // The five bound-contract fields (live_stack.mjs:126-129) — verbatim.
        expect(s.raHours).toBe(11.341253475172621);
        expect(s.decDeg).toBe(13.0);
        expect(s.scaleArcsecPerPx).toBe(3.6776147325019153);
        expect(s.matched).toBe(272);
        expect(s.confidence).toBe(0.8310893541573466);
        // Acceptance flag is a literal true (never a fabricated pass).
        expect(s.accepted).toBe(true);
        // Provenance basename (mirrors the mockproof sidecar shape).
        expect(s.frame).toBe('frame_0000.fits');
        // No extra/invented keys leak into the on-disk contract.
        expect(Object.keys(s).sort()).toEqual(
            ['accepted', 'confidence', 'decDeg', 'frame', 'matched', 'raHours', 'scaleArcsecPerPx'],
        );
    });

    it('carries MEASURED PlateSolution numbers straight through resultFromSolution', () => {
        const s = buildSolveSidecar('x.fits', resultFromSolution(SEESTAR_SOLUTION));
        expect(s.matched).toBe(272); // matched_stars.length, no placeholder
        expect(s.raHours).toBe(SEESTAR_SOLUTION.ra_hours);
    });
});

// ── CHAIN PROOF: our sidecar → the follower's REAL acceptance gate ─────────────
describe('CHAIN PROOF — live-stack follower accepts a Solve-Queue sidecar', () => {
    let TMP: string;
    beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-chain-')); });
    afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

    it('writes <frame>.solve.json next to the frame → acceptedSolve() accepts it', () => {
        const frameFile = 'frame_0000.fits';
        // Emit exactly as the desktop pane does: `${framePath}.solve.json` (the
        // `<file>.solve.json` form the follower checks first), MEASURED values.
        const sidecar = buildSolveSidecar(frameFile, resultFromSolution(SEESTAR_SOLUTION));
        fs.writeFileSync(
            path.join(TMP, `${frameFile}.solve.json`),
            JSON.stringify(sidecar, null, 2),
        );

        // Drive the REAL follower consumer (live_stack --solve-dir <TMP>).
        const accepted = acceptedSolve(TMP, frameFile);
        expect(accepted).not.toBeNull();
        expect(accepted!.accepted).toBe(true);
        expect(accepted!.matched).toBe(272);
        expect(accepted!.raHours).toBe(11.341253475172621);
        expect(accepted!.scaleArcsecPerPx).toBe(3.6776147325019153);
    });

    it('the follower rejects an absent sidecar (frame not yet solved → not stacked)', () => {
        expect(acceptedSolve(TMP, 'never_solved.fits')).toBeNull();
    });

    it('the follower rejects a non-accepted sidecar (honest failure never deepens the stack)', () => {
        fs.writeFileSync(
            path.join(TMP, 'failed.fits.solve.json'),
            JSON.stringify({ accepted: false, error: 'no geometric lock' }),
        );
        expect(acceptedSolve(TMP, 'failed.fits')).toBeNull();
    });
});
