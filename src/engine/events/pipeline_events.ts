/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PIPELINE EVENTS — Typed event bus (Phase U "the Glass Pipeline")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The typed event stream both orchestrators emit (stage begin/end/progress,
 * findings, warnings, solver candidate forensics). This is the UI contract
 * that will replace the 50–100 ms status-string polling — for now it is
 * ADDITIVE ONLY: `session.status` strings and existing polling remain intact
 * until the UI migration lands.
 *
 * DESIGN CONSTRAINTS (ROADMAP Phase U):
 *   - HEADLESS-SAFE: no DOM/window usage. The UI subscriber and the future
 *     API progress stream (Toolchest API) consume the exact same interface.
 *   - Schema is designed against the FULL roadmap: DSLR + science-workbench
 *     event kinds are reserved in the union NOW (see FindingPayload) so the
 *     UI capability surface never needs a retrofit.
 *   - Late subscribers can replay: the bus keeps a ring-buffer history.
 */

export type RunMode = 'wizard' | 'auto';

/** Where the locked pixel scale came from (provenance for the scale-source UI socket). */
export type ScaleSource = 'FITS_HEADER' | 'EXIF_OPTICS' | 'TRIANGULATED';

/**
 * Typed payloads for `finding` events — the "what the engine discovered"
 * channel, as opposed to the mechanical stage begin/end channel.
 */
export type FindingPayload =
    /** Signal extraction finished: clean star + anomaly counts. */
    | { kind: 'stars_detected'; count: number; anomalies: number }
    /** Pixel scale locked (arcsec/px) with its provenance source. */
    | { kind: 'scale_locked'; arcsecPerPx: number; source: ScaleSource }
    /** An untrusted focal length was seeded from a labelled optics ASSUMPTION
     *  (the untrusted-FL hint-provider seam) — `assumed` is always true, never a
     *  measurement (LAW 3). Distinct from `hint_applied` (position hints). */
    | { kind: 'optics_hint'; source: string; valueMm: number; assumed: true; reason: string }
    /** One solver candidate attempt from the forensics table (accepted or rejected, with reason status). */
    | { kind: 'solve_candidate'; idx: number; quadError?: number; inferredScale?: number; status: string }
    /** Plate solve succeeded: the WCS lock summary. */
    | { kind: 'solution_locked'; raHours: number; decDeg: number; scale: number; rotationDeg: number; matched: number; confidence: number }
    /** Export packet assembled (star count included in the packet). */
    | { kind: 'packet_built'; stars: number }
    // ── RESERVED KINDS — defined now per the ROADMAP "DSLR sockets" principle,
    //    emitted by the DSLR / science-workbench phases (never retrofit). ──
    /** A target hint was resolved and applied (hint cascade: config > FITS header > soft > zenith) — DSLR phase B3. */
    | { kind: 'hint_applied'; source: string; raHours: number; decDeg: number; radiusDeg?: number }
    /** Center-by-center blind-search narration (tried N of M sky centers) — DSLR phase B4 / FOV-keyed blind policy. */
    | { kind: 'blind_search_progress'; centersTried: number; centersTotal?: number; raHours?: number; decDeg?: number }
    /** An anomaly was classified into an artifact class (satellite / hot_pixel / terrestrial …) — per-class culling toggles. */
    | { kind: 'artifact_classified'; artifactClass: string; count: number }
    /** Atmospheric extinction gradient measured across the frame — science-workbench photometry. */
    | { kind: 'extinction_measured'; gradient: number; airMass?: number }
    // ── M10 PSF diagnostics (optional post-solve stage — "nerd data" wave) ──
    /** Full-frame PSF measurement pass completed (moment-based FWHM on the native grid). */
    | { kind: 'psf_measured'; nStars: number; fwhmMedianPx: number }
    /** Windowed damped-RL deconvolution finished (median FWHM over processed windows). */
    | { kind: 'psf_deconvolved'; fwhmBeforePx: number; fwhmAfterPx: number | null; itersRun: number; windows: number };

/**
 * Honest verdict enum for a stage/branch envelope (the capture record's per-
 * stage outcome channel). null / `NOT_MEASURED` = LAW-3 honest-absent — never a
 * placeholder. `APPLIED`/`KEPT_ORIGINAL` mirror the two-pass rail vocabulary.
 */
export type StageVerdict =
    | 'PASS'
    | 'FAIL'
    | 'SKIP'
    | 'APPLIED'
    | 'KEPT_ORIGINAL'
    | 'NOT_MEASURED';

/** Stamp added by the bus on emission: wall-clock time + monotonic sequence. */
export interface EventStamp {
    /** Epoch milliseconds at emission. */
    t: number;
    /** Strictly monotonic sequence number for the lifetime of the bus (never reset, even by clear()). */
    seq: number;
    /**
     * Per-run identity, promoted from the session id and stamped on EVERY event
     * via `setRunContext` (the capture record's grouping key). Undefined until
     * the producer calls `setRunContext` — additive, so late-stamping a run does
     * not break existing consumers.
     */
    runId?: string;
    /**
     * Content SHA-256 of the source frame — the flowchart's cross-run dedup key
     * (multiple runs of one frame must not skew pass/fail stats). Computed off
     * the ingest hot path, so early events may carry `undefined`/`null` until it
     * resolves; `null` = honestly unhashed (unavailable env). Events + capture
     * record ONLY — never the receipt (receipts stay byte-identical).
     */
    frameSha?: string | null;
}

/** Event bodies as produced by emitters — the bus stamps `t`/`seq` itself. */
export type PipelineEventInput =
    /** A pipeline run began (wizard click-through or auto "Run All"). */
    | { kind: 'run_started'; mode: RunMode; sourceFormat?: string }
    /** The run ended (ok = reached the success path). */
    | { kind: 'run_finished'; ok: boolean }
    /** A stage began. `label` is human copy; `stage` is the stable id. */
    | { kind: 'stage_started'; stage: string; label: string }
    /** Intra-stage progress (pct 0–100 when known, or a free-text note). */
    | { kind: 'stage_progress'; stage: string; pct?: number; note?: string }
    /**
     * A stage ended, with wall-clock duration and the error message on failure.
     * ADDITIVE capture-record fields (all optional — omitted ⇒ honest-absent):
     *   - `verdict`  honest stage outcome enum (see StageVerdict); omitted ⇒ null.
     *   - `counts`   integer counts surfaced for the flowchart (matched / n_used …).
     *   - `payloadRef` NAME of the receipt block this stage's data lands in (widgets
     *     already key by block name), or null when it produces no receipt block.
     */
    | { kind: 'stage_finished'; stage: string; ok: boolean; ms: number; error?: string;
        verdict?: StageVerdict | null; counts?: Record<string, number>; payloadRef?: string | null }
    /** The engine discovered something (typed payload — see FindingPayload). */
    | { kind: 'finding'; finding: FindingPayload }
    /** Honest degradation notice (mirrors session.warnings pushes). */
    | { kind: 'warning'; message: string; stage?: string }
    /** A manifest fact earned a new state (ManifestTransaction commit) — feeds the Provenance FSM panel. */
    | { kind: 'provenance_changed'; key: string; from?: string; to: string; stage: string };

/**
 * A stamped pipeline event. The conditional forces distribution so each
 * union member carries the stamp and discriminant narrowing on `kind`
 * keeps working.
 */
export type PipelineEvent = PipelineEventInput extends unknown
    ? PipelineEventInput & EventStamp
    : never;

export type PipelineEventSubscriber = (e: PipelineEvent) => void;

/** Default ring-buffer capacity: enough to replay a full run for late subscribers. */
export const EVENT_HISTORY_CAP = 2000;

/**
 * The pipeline event bus.
 *
 * - `emit()` stamps t/seq, appends to the ring buffer, and fans out to
 *   subscribers. A throwing subscriber can NEVER break emission or starve
 *   other subscribers (per-subscriber try/catch).
 * - `getHistory()` lets late subscribers (UI mounted mid-run, API stream
 *   reconnect) replay everything still in the buffer.
 * - Headless-safe: no DOM/window usage anywhere in this module.
 */
export class PipelineEventBus {
    private history: PipelineEvent[] = [];
    private subscribers = new Set<PipelineEventSubscriber>();
    private seqCounter = 0;
    /** Per-run context stamped onto every emitted event (see setRunContext). */
    private runId?: string;
    private frameSha?: string | null;

    constructor(private readonly capacity: number = EVENT_HISTORY_CAP) {}

    /**
     * Set (or update) the per-run context stamped onto every subsequent event.
     * ADDITIVE + idempotent per field: pass only the fields you know. The frame
     * sha is computed off the ingest hot path, so producers stamp `runId`
     * immediately and back-fill `frameSha` when the digest resolves.
     */
    setRunContext(ctx: { runId?: string; frameSha?: string | null }): void {
        if (ctx.runId !== undefined) this.runId = ctx.runId;
        if (ctx.frameSha !== undefined) this.frameSha = ctx.frameSha;
    }

    /** Current run context (for consumers back-filling the capture record). */
    getRunContext(): { runId?: string; frameSha?: string | null } {
        return { runId: this.runId, frameSha: this.frameSha };
    }

    /** Stamp and broadcast an event. Returns the stamped event. */
    emit(e: PipelineEventInput): PipelineEvent {
        const stamped = {
            ...e,
            t: Date.now(),
            seq: ++this.seqCounter,
            runId: this.runId,
            frameSha: this.frameSha,
        } as PipelineEvent;

        this.history.push(stamped);
        if (this.history.length > this.capacity) {
            this.history.splice(0, this.history.length - this.capacity);
        }

        for (const fn of this.subscribers) {
            try {
                fn(stamped);
            } catch (err) {
                // Subscriber errors must not break emission (or other subscribers).
                console.error('[PipelineEventBus] Subscriber threw during emit:', err);
            }
        }
        return stamped;
    }

    /** Register a subscriber. Returns the unsubscribe function. */
    subscribe(fn: PipelineEventSubscriber): () => void {
        this.subscribers.add(fn);
        return () => {
            this.subscribers.delete(fn);
        };
    }

    /** Ring-buffer history (most recent `capacity` events) for late-subscriber replay. */
    getHistory(): readonly PipelineEvent[] {
        return this.history;
    }

    /** Drop the history. Sequence numbers keep counting (monotonic for the bus lifetime). */
    clear(): void {
        this.history = [];
    }
}
