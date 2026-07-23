import { describe, it, expect } from 'vitest';
import {
    MAIN_WINDOW_LABEL,
    POPOUT_LABEL_PREFIX,
    POPOUT_EVENT,
    popoutLabel,
    isPopoutLabel,
    isPopoutRoute,
    popoutUrl,
    parsePopoutParams,
    serializeBridgePayload,
    parseBridgePayload,
    DEFAULT_POPOUT_BOUNDS,
    isValidBounds,
    boundsOrDefault,
    isOutsideWindow,
    tearOffBounds,
    addPopoutRecord,
    removePopoutRecord,
    hasPopoutLabel,
    poppedWidgetIds,
    type PopoutRecord,
} from '../ui/widgets/docking/popout_bridge';

/**
 * POPOUT BRIDGE — pure transport contract (DASHBOARD_DOCKING_SPEC §5, Phase C).
 * The WebviewWindow/emit_to/listen glue can't run headless; everything that CAN
 * be proven off-box (labels, URL, params, serialisation, bounds, records) lives
 * here and is proven here.
 */

describe('popout_bridge — window labels', () => {
    it('main window label + popout prefix are the brand-neutral constants', () => {
        expect(MAIN_WINDOW_LABEL).toBe('main');
        expect(POPOUT_LABEL_PREFIX).toBe('popout-');
    });

    it('popoutLabel derives a glob-matching, sanitised label', () => {
        const label = popoutLabel('solve_summary__abc123');
        expect(label).toBe('popout-solve_summary__abc123');
        expect(isPopoutLabel(label)).toBe(true);
        expect(label.startsWith(POPOUT_LABEL_PREFIX)).toBe(true);
    });

    it('popoutLabel sanitises illegal characters so the label always matches popout-*', () => {
        const label = popoutLabel('weird id/with:stuff!');
        expect(label.startsWith('popout-')).toBe(true);
        expect(/^popout-[a-zA-Z0-9_-]+$/.test(label)).toBe(true);
        expect(isPopoutLabel(label)).toBe(true);
    });

    it('isPopoutLabel is false for the main window', () => {
        expect(isPopoutLabel(MAIN_WINDOW_LABEL)).toBe(false);
    });
});

describe('popout_bridge — event names', () => {
    it('are the four brand-neutral skycruncher:// events', () => {
        expect(POPOUT_EVENT.READY).toBe('skycruncher://popout-ready');
        expect(POPOUT_EVENT.RECEIPT).toBe('skycruncher://popout-receipt');
        expect(POPOUT_EVENT.CLOSED).toBe('skycruncher://popout-closed');
        expect(POPOUT_EVENT.BOUNDS).toBe('skycruncher://popout-bounds');
    });
});

describe('popout_bridge — hash route', () => {
    it('recognises the popout route with and without a query', () => {
        expect(isPopoutRoute('#/popout')).toBe(true);
        expect(isPopoutRoute('#/popout?panel=solve_summary&window=popout-1')).toBe(true);
        expect(isPopoutRoute('#/widgets')).toBe(false);
        expect(isPopoutRoute('')).toBe(false);
        // must not false-match a different route that merely starts similarly
        expect(isPopoutRoute('#/popouts')).toBe(false);
    });

    it('popoutUrl strips the base hash and encodes params', () => {
        const url = popoutUrl('http://localhost:3005/index.html#/something', 'solve_summary', 'popout-solve_summary__x');
        expect(url).toBe('http://localhost:3005/index.html#/popout?panel=solve_summary&window=popout-solve_summary__x');
    });

    it('parsePopoutParams round-trips popoutUrl', () => {
        const label = popoutLabel('solve_flowchart__z9');
        const url = popoutUrl('http://localhost/index.html', 'solve_flowchart', label);
        const hash = '#' + url.split('#')[1];
        const parsed = parsePopoutParams(hash);
        expect(parsed.widgetId).toBe('solve_flowchart');
        expect(parsed.windowLabel).toBe(label);
    });

    it('parsePopoutParams tolerates a missing query / missing params', () => {
        expect(parsePopoutParams('#/popout')).toEqual({ widgetId: '', windowLabel: '' });
        expect(parsePopoutParams('#/popout?panel=x')).toEqual({ widgetId: 'x', windowLabel: '' });
    });
});

describe('popout_bridge — serialised payload (opaque transport)', () => {
    it('round-trips a receipt + events + replayFrame byte-perfect', () => {
        const receipt = { version: '2.12.0', solution: { ra_h: 11.34, nested: [1, 2, { a: 'b' }] } };
        const events = [{ t: 0, type: 'solve_start' }, { t: 5, type: 'solve_done' }];
        const replayFrame = { stages: { solve: { phase: 'done', verdict: 'ok' } } };
        const payload = serializeBridgePayload(receipt, events, replayFrame);
        const back = parseBridgePayload(payload);
        expect(back.receipt).toEqual(receipt);
        expect(back.events).toEqual(events);
        expect(back.replayFrame).toEqual(replayFrame);
    });

    it('encodes an absent receipt as the string "null" (distinct from transport failure)', () => {
        const payload = serializeBridgePayload(null, undefined, undefined);
        expect(payload.receiptJson).toBe('null');
        expect(payload.eventsJson).toBeNull();
        expect(payload.replayFrameJson).toBeNull();
        const back = parseBridgePayload(payload);
        expect(back.receipt).toBeNull();
        expect(back.events).toBeNull();
        expect(back.replayFrame).toBeNull();
    });

    it('parseBridgePayload never throws on missing / malformed payload', () => {
        expect(() => parseBridgePayload(null)).not.toThrow();
        expect(parseBridgePayload(null)).toEqual({ receipt: null, events: null, replayFrame: null });
        expect(parseBridgePayload({ receiptJson: '{bad', eventsJson: null, replayFrameJson: null }).receipt).toBeNull();
    });
});

describe('popout_bridge — bounds geometry', () => {
    it('validates sane bounds and rejects garbage / degenerate windows', () => {
        expect(isValidBounds({ x: 10, y: 20, width: 760, height: 620 })).toBe(true);
        expect(isValidBounds({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);       // 0×0
        expect(isValidBounds({ x: 0, y: 0, width: 10, height: 10 })).toBe(false);     // below min
        expect(isValidBounds({ x: NaN, y: 0, width: 760, height: 620 })).toBe(false); // non-finite
        expect(isValidBounds(null)).toBe(false);
        expect(isValidBounds('nope')).toBe(false);
        expect(isValidBounds({ width: 760, height: 620 })).toBe(false);               // missing x/y
    });

    it('boundsOrDefault falls back to the default on an invalid blob', () => {
        expect(boundsOrDefault(undefined)).toEqual(DEFAULT_POPOUT_BOUNDS);
        expect(boundsOrDefault({ x: 0, y: 0, width: 5, height: 5 })).toEqual(DEFAULT_POPOUT_BOUNDS);
        const good = { x: 300, y: 200, width: 800, height: 640 };
        expect(boundsOrDefault(good)).toEqual(good);
    });
});

describe('popout_bridge — tear-off geometry (SPEC §5b)', () => {
    // App window occupying screen 100..900 (x), 100..700 (y), logical px.
    const win = { x: 100, y: 100, width: 800, height: 600 };

    it('a release INSIDE the window is not a tear-off (boundary = inside)', () => {
        expect(isOutsideWindow(500, 400, win)).toBe(false);   // dead centre
        expect(isOutsideWindow(100, 100, win)).toBe(false);   // top-left corner (strict <)
        expect(isOutsideWindow(900, 700, win)).toBe(false);   // bottom-right corner (strict >)
    });

    it('a release PAST any edge is a tear-off', () => {
        expect(isOutsideWindow(50, 400, win)).toBe(true);     // left
        expect(isOutsideWindow(950, 400, win)).toBe(true);    // right
        expect(isOutsideWindow(500, 50, win)).toBe(true);     // above
        expect(isOutsideWindow(500, 750, win)).toBe(true);    // below
        expect(isOutsideWindow(-200, 400, win)).toBe(true);   // onto a monitor to the left
    });

    it('never tears off when it cannot decide (non-finite point / degenerate window)', () => {
        expect(isOutsideWindow(NaN, 400, win)).toBe(false);
        expect(isOutsideWindow(500, Infinity, win)).toBe(false);
        expect(isOutsideWindow(500, 400, { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
        expect(isOutsideWindow(500, 400, { x: 0, y: 0, width: -1, height: 600 })).toBe(false);
    });

    it('tearOffBounds takes POSITION from the drop point, SIZE from persisted bounds', () => {
        const persisted = { x: 10, y: 20, width: 900, height: 700 };
        expect(tearOffBounds({ x: 1500, y: 300 }, persisted)).toEqual({ x: 1500, y: 300, width: 900, height: 700 });
    });

    it('tearOffBounds falls back to the default SIZE when no valid persisted bounds', () => {
        const b = tearOffBounds({ x: -50, y: 42 }, undefined);
        expect(b.x).toBe(-50);
        expect(b.y).toBe(42);
        expect(b.width).toBe(DEFAULT_POPOUT_BOUNDS.width);
        expect(b.height).toBe(DEFAULT_POPOUT_BOUNDS.height);
    });
});

describe('popout_bridge — popped-out records reducer', () => {
    const a: PopoutRecord = { panelId: 'solve_summary__1', widgetId: 'solve_summary', label: 'popout-solve_summary__1' };
    const b: PopoutRecord = { panelId: 'solve_flowchart__2', widgetId: 'solve_flowchart', label: 'popout-solve_flowchart__2' };

    it('adds records and replaces idempotently by label', () => {
        let list = addPopoutRecord([], a);
        list = addPopoutRecord(list, b);
        expect(list).toHaveLength(2);
        // re-adding the same label replaces, never duplicates
        const aPrime = { ...a, widgetId: 'solve_summary' };
        list = addPopoutRecord(list, aPrime);
        expect(list).toHaveLength(2);
        expect(hasPopoutLabel(list, a.label)).toBe(true);
    });

    it('removes by label', () => {
        const list = removePopoutRecord([a, b], a.label);
        expect(list).toEqual([b]);
        expect(hasPopoutLabel(list, a.label)).toBe(false);
    });

    it('poppedWidgetIds gives the set for ghost-chip rendering', () => {
        const ids = poppedWidgetIds([a, b]);
        expect(ids.has('solve_summary')).toBe(true);
        expect(ids.has('solve_flowchart')).toBe(true);
        expect(ids.size).toBe(2);
    });

    it('reducer functions are pure (do not mutate the input list)', () => {
        const input = [a];
        addPopoutRecord(input, b);
        removePopoutRecord(input, a.label);
        expect(input).toEqual([a]);
    });
});
