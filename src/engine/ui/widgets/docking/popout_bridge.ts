/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POPOUT BRIDGE — pure transport contract for the Tauri multi-window popout
 * (DASHBOARD_DOCKING_SPEC §5, Phase C)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is DELIBERATELY PURE — it imports NOTHING from `@tauri-apps/*`
 * and touches no DOM, so it is headless/Node-safe and fully unit-testable. The
 * actual `WebviewWindow` / `emit_to` / `listen` calls live in the thin glue
 * (`usePopoutManager.ts` on the main side, `PopoutHost.tsx` on the popout side);
 * everything they need that CAN be tested — event names, the window-label
 * grammar, the popout URL, the hash-route params, the serialized payload, the
 * bounds geometry, and the popped-out records reducer — is here and proven by
 * `popout_bridge.test.ts`.
 *
 * State-bridge model (SPEC §5, PROVEN in Phase A): the MAIN window is the SINGLE
 * producer. It serialises `{ receipt, events, replayFrame }` and `emit_to`s it to
 * each popout; popouts are SUBSCRIBERS ONLY. The transport is opaque JSON strings
 * (this module never imports the receipt/event/frame domain types) so it stays a
 * pure carrier — Phase A measured a 1.05 MB receipt survive this round-trip
 * byte-perfect.
 *
 * Ledger: RENDER PLANE — display transport only; no COORDINATE/PIXEL math.
 */

// ─── window labels ──────────────────────────────────────────────────────────

/** The Tauri label of the main (producer) window (tauri.conf.json single window). */
export const MAIN_WINDOW_LABEL = 'main';

/**
 * Popout window labels are `popout-<panelId>`. This prefix MUST match the
 * capability glob `["main","popout-*"]` in `src-tauri/capabilities/popout.json`
 * — a popout whose label does not match that glob gets ZERO permissions (Phase A
 * finding). Keep the two in lockstep.
 */
export const POPOUT_LABEL_PREFIX = 'popout-';

/**
 * Derive a Tauri window label for a popped-out dock panel. Tauri labels admit
 * only `[a-zA-Z0-9-/:_]`; the dock's `makePanelId` uses only `[a-z0-9_]` plus a
 * `__` separator, but we sanitise defensively so any panel id yields a legal,
 * glob-matching label.
 */
export function popoutLabel(panelId: string): string {
    const safe = panelId.replace(/[^a-zA-Z0-9_-]/g, '-');
    return `${POPOUT_LABEL_PREFIX}${safe}`;
}

/** True iff a window label denotes a popout (matches the capability glob). */
export function isPopoutLabel(label: string): boolean {
    return label.startsWith(POPOUT_LABEL_PREFIX);
}

// ─── event names (brand-neutral, mirror the Phase A spike) ──────────────────

/**
 * The four cross-window event names. All `skycruncher://` per LAW 6 (brand-
 * neutral). Directionality:
 *   • READY   popout → main : "my listener is armed, send me the state".
 *   • RECEIPT main → popout : the serialised {receipt, events, replayFrame}.
 *   • CLOSED  popout → main : "I am unloading" → main returns the panel.
 *   • BOUNDS  popout → main : my new position/size → main persists it.
 */
export const POPOUT_EVENT = {
    READY: 'skycruncher://popout-ready',
    RECEIPT: 'skycruncher://popout-receipt',
    CLOSED: 'skycruncher://popout-closed',
    BOUNDS: 'skycruncher://popout-bounds',
} as const;

// ─── hash route (the popout SPA page) ───────────────────────────────────────

/** True iff a `window.location.hash` string targets the popout page. */
export function isPopoutRoute(hash: string): boolean {
    return hash === '#/popout' || hash.startsWith('#/popout?');
}

/**
 * Build the popout window URL: the SAME SPA at the `#/popout` hash route,
 * carrying the widget id + the window label. `base` is any full URL; its hash is
 * stripped. The widget id + label are URL-encoded.
 */
export function popoutUrl(base: string, widgetId: string, label: string): string {
    const b = base.split('#')[0];
    return `${b}#/popout?panel=${encodeURIComponent(widgetId)}&window=${encodeURIComponent(label)}`;
}

export interface PopoutParams {
    /** The registry widget id this popout renders (may be '' if absent). */
    widgetId: string;
    /** This popout's own window label (may be '' if absent). */
    windowLabel: string;
}

/**
 * Parse `#/popout?panel=<widgetId>&window=<label>` out of a hash string.
 * Missing params yield ''. Never throws.
 */
export function parsePopoutParams(hash: string): PopoutParams {
    let query = '';
    const q = hash.indexOf('?');
    if (q >= 0) query = hash.slice(q + 1);
    let params: URLSearchParams;
    try { params = new URLSearchParams(query); } catch { params = new URLSearchParams(); }
    return {
        widgetId: params.get('panel') ?? '',
        windowLabel: params.get('window') ?? '',
    };
}

// ─── serialised bridge payload (opaque transport) ───────────────────────────

/**
 * The wire payload for `POPOUT_EVENT.RECEIPT`. Each field is an already-
 * serialised JSON string (or null) so this module needs none of the domain
 * types and the popout re-parses on the far side. `receiptJson` is the string
 * `"null"` when there is no receipt yet (landing / pre-first-solve) — distinct
 * from a transport failure.
 */
export interface BridgePayload {
    receiptJson: string;
    eventsJson: string | null;
    replayFrameJson: string | null;
}

/** Serialise the producer's current state into the wire payload. Pure. */
export function serializeBridgePayload(
    receipt: unknown,
    events: unknown,
    replayFrame: unknown,
): BridgePayload {
    const safe = (v: unknown): string | null => {
        if (v === undefined || v === null) return null;
        try { return JSON.stringify(v); } catch { return null; }
    };
    return {
        // receipt is intentionally the string "null" (not null) when absent so
        // the popout can tell "no receipt yet" from "bridge sent nothing".
        receiptJson: (() => { try { return JSON.stringify(receipt ?? null); } catch { return 'null'; } })(),
        eventsJson: safe(events),
        replayFrameJson: safe(replayFrame),
    };
}

export interface BridgedState {
    receipt: unknown;
    events: unknown;
    replayFrame: unknown;
}

/** Re-parse a wire payload on the popout side. Never throws — bad JSON ⇒ null. */
export function parseBridgePayload(payload: BridgePayload | null | undefined): BridgedState {
    const parse = (s: string | null | undefined): unknown => {
        if (s == null) return null;
        try { return JSON.parse(s); } catch { return null; }
    };
    return {
        receipt: parse(payload?.receiptJson),
        events: parse(payload?.eventsJson),
        replayFrame: parse(payload?.replayFrameJson),
    };
}

// ─── window bounds (position + size, physical px) ───────────────────────────

export interface PopoutBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Where a popout opens when nothing is persisted for its widget. */
export const DEFAULT_POPOUT_BOUNDS: PopoutBounds = { x: 120, y: 120, width: 760, height: 620 };

/** Smallest sane popout window (guards a persisted 0×0 / off-screen blob). */
const MIN_POPOUT_DIM = 240;

/** True iff `b` is a structurally-valid, sane bounds object. */
export function isValidBounds(b: unknown): b is PopoutBounds {
    if (!b || typeof b !== 'object') return false;
    const o = b as Record<string, unknown>;
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    return finite(o.x) && finite(o.y)
        && finite(o.width) && finite(o.height)
        && (o.width as number) >= MIN_POPOUT_DIM
        && (o.height as number) >= MIN_POPOUT_DIM;
}

/** A persisted bounds if valid, else the default. Pure. */
export function boundsOrDefault(b: unknown): PopoutBounds {
    return isValidBounds(b) ? b : DEFAULT_POPOUT_BOUNDS;
}

// ─── tear-off geometry (Phase C second half, SPEC §5b) ──────────────────────

/**
 * Is a release point OUTSIDE the app window rect? The tear-off predicate (SPEC
 * §5b): a header/tab drag whose `dragend` lands past any window edge becomes an
 * OS window. Point coords are `DragEvent.screenX/screenY`; the window rect is
 * `window.screenX/screenY/outerWidth/outerHeight` — BOTH logical px (the Phase C
 * multi-monitor DPI limitation is kept). PURE (no DOM) so it is unit-testable.
 *
 * Boundary = INSIDE (strict `<`/`>`) so a drop just on the edge is a normal
 * dockview drop, never an accidental tear-off. A non-finite point or a
 * degenerate/unmeasurable window (width/height ≤ 0) ⇒ `false`: never tear off
 * when we cannot decide (honest — falls back to dockview's own drop handling).
 */
export function isOutsideWindow(pointX: number, pointY: number, win: PopoutBounds): boolean {
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return false;
    if (!(win.width > 0) || !(win.height > 0)) return false;   // unmeasurable ⇒ never tear off
    return pointX < win.x
        || pointX > win.x + win.width
        || pointY < win.y
        || pointY > win.y + win.height;
}

/**
 * The bounds a torn-off window opens with: POSITION from the drop point, SIZE
 * from the widget's persisted bounds (or the default when none/invalid). PURE.
 */
export function tearOffBounds(origin: { x: number; y: number }, persisted: unknown): PopoutBounds {
    const size = boundsOrDefault(persisted);
    return { x: origin.x, y: origin.y, width: size.width, height: size.height };
}

// ─── popped-out records (main-window ledger of live popouts) ────────────────

/**
 * One live popout, tracked by the main window so it can (a) render a ghost chip
 * where the panel used to be, (b) broadcast state to it, and (c) return it on
 * close. The dock panel is REMOVED while popped out — never live in both windows
 * at once (SPEC §5).
 */
export interface PopoutRecord {
    /** The dock panel id that was popped out (needed to re-add on return). */
    panelId: string;
    /** The registry widget id the popout renders. */
    widgetId: string;
    /** The popout window label (`popout-<panelId>`). */
    label: string;
}

/** Add/replace a record keyed by window label (idempotent). Pure. */
export function addPopoutRecord(list: readonly PopoutRecord[], rec: PopoutRecord): PopoutRecord[] {
    return [...list.filter(r => r.label !== rec.label), rec];
}

/** Remove the record with the given label. Pure. */
export function removePopoutRecord(list: readonly PopoutRecord[], label: string): PopoutRecord[] {
    return list.filter(r => r.label !== label);
}

/** True iff a popout with this label is tracked. Pure. */
export function hasPopoutLabel(list: readonly PopoutRecord[], label: string): boolean {
    return list.some(r => r.label === label);
}

/** The set of widget ids currently popped out (for ghost-chip rendering). Pure. */
export function poppedWidgetIds(list: readonly PopoutRecord[]): Set<string> {
    return new Set(list.map(r => r.widgetId));
}
