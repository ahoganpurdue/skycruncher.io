import React from 'react';
import { Chip, KV, Panel, EmptyState } from '../kit';
import type { WidgetManifest } from '../widgets/registry';

/**
 * STAR-PLATE LIBRARY SYNC CARD (gallery W2.4)
 *
 * Renders the native star-plate store status from the Tauri command
 * `starplates_status` (docs/STARPLATES_SPEC.md §5.1 — same shape as
 * `starplates_init`'s result, serialized by
 * src-tauri/src/starplates/store.rs::StarplatesStatus).
 *
 * LAW 3 (honest-or-absent) contract of this card:
 *  - The native provider MAY NOT EXIST in this build. Any invoke failure
 *    (command unregistered, not running under Tauri, malformed payload)
 *    renders the absent voice — never an error banner, never fabricated
 *    data. E_NOT_INITIALIZED is the one recoverable case: the card performs
 *    the idempotent `starplates_init` bring-up itself (nothing else in src/
 *    calls it), and only failure of THAT resolves absent.
 *  - Fields the command does NOT report render the `--` sentinel or an
 *    explicit NOT MEASURED with the reason:
 *      · blob bytes — not in the §5.1 status payload;
 *      · parity v1↔v2 — the §9.2 gate runs offline
 *        (tools/repro/starplates_parity.mjs), never at app runtime.
 *  - Earned color only: the integrity chip is solve-green because a
 *    successful `starplates_status` response PROVES the pinned manifest's
 *    SHA-256 matched (`starplates_init` refuses to build the store on
 *    mismatch — E_MANIFEST_INVALID — and `starplates_status` errors
 *    E_NOT_INITIALIZED without a store). It claims MANIFEST integrity only;
 *    per-blob SHAs verify lazily on first open (§6.3) and are not asserted.
 *  - Coverage < 100% is a degradation and reads as one: WARN chip
 *    "PARTIAL SKY — NN.N%".
 */

// ── Status shape (spec §5.1, field names are the serde JSON contract) ─────

export interface StarplatesStatus {
    release: string;
    format_version: number;
    /** "t0" | "t1" | "t2" | "none" — deepest tier with locally-present blobs. */
    tier_depth_available: string;
    cells_total: number;
    cells_populated: number;
    cells_local: number;
    /** 0 when the T0 bootstrap blob is not locally present (store.rs). */
    t0_rows: number;
    /** cells_populated / cells_total; 0 when cells_total is 0. */
    coverage_t1: number;
}

export type StarplateCardState =
    | { kind: 'pending' }
    | { kind: 'absent'; reason: string }
    | { kind: 'present'; status: StarplatesStatus };

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// ── Parsing (reject anything malformed — absent beats fake) ───────────────

const finiteNonNeg = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Validate the raw invoke payload against the §5.1 shape; null = not usable. */
export function parseStarplatesStatus(raw: unknown): StarplatesStatus | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.release !== 'string' || r.release.length === 0) return null;
    if (typeof r.tier_depth_available !== 'string') return null;
    if (
        !finiteNonNeg(r.format_version) ||
        !finiteNonNeg(r.cells_total) ||
        !finiteNonNeg(r.cells_populated) ||
        !finiteNonNeg(r.cells_local) ||
        !finiteNonNeg(r.t0_rows) ||
        !finiteNonNeg(r.coverage_t1)
    ) {
        return null;
    }
    return {
        release: r.release,
        format_version: r.format_version,
        tier_depth_available: r.tier_depth_available,
        cells_total: r.cells_total,
        cells_populated: r.cells_populated,
        cells_local: r.cells_local,
        t0_rows: r.t0_rows,
        coverage_t1: r.coverage_t1,
    };
}

/**
 * Invoke `starplates_status`. Resolves to present/absent — NEVER rejects.
 * `invokeFn` is injectable for tests; the default path dynamically imports
 * the Tauri API (same seam as m6_plate_solve/starplates_provider.ts) so a
 * plain-browser build never pays for it and any failure is just "absent".
 *
 * Bring-up: AppState seeds the store as None and NOTHING else in src/ calls
 * `starplates_init` (query_catalog_v2 is flag-gated default-OFF), so a cold
 * app always answers E_NOT_INITIALIZED. On that specific error we invoke the
 * idempotent `starplates_init` (spec §5.1) — it returns the same
 * StarplatesStatus shape — and use its result. Any failure there (no Tauri,
 * no bundled store, manifest mismatch) still resolves absent.
 */
export async function fetchStarplatesStatus(invokeFn?: InvokeFn): Promise<StarplateCardState> {
    let inv: InvokeFn;
    try {
        inv = invokeFn ?? (await import('@tauri-apps/api/core')).invoke;
    } catch (e) {
        return { kind: 'absent', reason: e instanceof Error ? e.message : String(e) };
    }
    let raw: unknown;
    try {
        raw = await inv('starplates_status');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('E_NOT_INITIALIZED')) return { kind: 'absent', reason: msg };
        // Store exists but was never brought up — idempotent init, once.
        try {
            raw = await inv('starplates_init');
        } catch (e2) {
            return { kind: 'absent', reason: e2 instanceof Error ? e2.message : String(e2) };
        }
    }
    const status = parseStarplatesStatus(raw);
    if (status == null) return { kind: 'absent', reason: 'malformed status payload' };
    return { kind: 'present', status };
}

// ── Display derivations (each earned by an explicit predicate) ────────────

const fmtInt = (n: number): string => Math.trunc(n).toLocaleString('en-US');

/** Release naming is normative (§2.1: starplates-<YYYY.MM>[.<rev>]-<source>) —
 *  the trailing token IS the source tag; anything else parses to null. */
export function releaseSourceTag(release: string): string | null {
    const m = /^starplates-.+-([a-z0-9]+)$/i.exec(release);
    return m ? m[1].toUpperCase() : null;
}

/** format_version 1 is the FROZEN §3.2 byte contract: cells store J2016.0
 *  truth. Any other version — epoch unknown to this build, render `--`. */
export function releaseEpoch(formatVersion: number): string | null {
    return formatVersion === 1 ? 'J2016.0' : null;
}

const coverageChip = (s: StarplatesStatus): React.ReactElement => {
    if (s.cells_total <= 0) {
        // No T1 tier in the manifest — the denominator is absent, so
        // coverage is not a measurable number here.
        return (
            <Chip tone="neutral" testid="starplate-coverage-chip">
                T1 COVERAGE --
            </Chip>
        );
    }
    const pct = (s.coverage_t1 * 100).toFixed(1);
    return s.coverage_t1 < 1 ? (
        <Chip tone="warn" testid="starplate-coverage-chip">
            PARTIAL SKY — {pct}%
        </Chip>
    ) : (
        <Chip tone="solve" testid="starplate-coverage-chip">
            FULL SKY — {pct}%
        </Chip>
    );
};

const depthChip = (tier: string): React.ReactElement => {
    if (tier === 'none') {
        return (
            <Chip tone="warn" testid="starplate-depth-chip">
                NO LOCAL BLOBS
            </Chip>
        );
    }
    if (tier === 't0') {
        return (
            <Chip tone="warn" testid="starplate-depth-chip">
                DEPTH T0 — BOOTSTRAP ONLY
            </Chip>
        );
    }
    return (
        <Chip tone="info" testid="starplate-depth-chip">
            DEPTH {tier.toUpperCase()}
        </Chip>
    );
};

// ── Pure view (state in, markup out — unit-testable without effects) ──────

export const StarplateLibraryCardView: React.FC<{ state: StarplateCardState }> = ({ state }) => (
    <Panel caption="STAR-PLATE LIBRARY SYNC" testid="starplate-library-card">
        {state.kind === 'pending' && (
            <EmptyState testid="starplate-pending">querying native provider…</EmptyState>
        )}
        {state.kind === 'absent' && (
            <EmptyState testid="starplate-empty">
                LIBRARY NOT SYNCED — native provider unavailable
            </EmptyState>
        )}
        {state.kind === 'present' && <PresentBody status={state.status} />}
    </Panel>
);

const PresentBody: React.FC<{ status: StarplatesStatus }> = ({ status: s }) => {
    // status() sets t0_rows to 0 whenever the T0 blob is not locally
    // present — 0 here is a "not local" sentinel, not a measured row count.
    const t0Local = s.t0_rows > 0;
    const localBlobs = s.cells_local + (t0Local ? 1 : 0);
    const source = releaseSourceTag(s.release);
    const epoch = releaseEpoch(s.format_version);

    return (
        <div>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
                {/* Earned: a live status response implies the pinned manifest
                    SHA matched at init (see header comment). Manifest-level only. */}
                <Chip tone="solve" testid="starplate-integrity-chip">
                    MANIFEST SHA-VERIFIED
                </Chip>
                {coverageChip(s)}
                {depthChip(s.tier_depth_available)}
            </div>
            <div className="font-mono text-[11px] space-y-1">
                <KV k="RELEASE" v={s.release} testid="starplate-release" />
                {/* Sentinels pass null / muted — never the measured-number voice (A.6). */}
                <KV k="SOURCE" v={source} testid="starplate-source" />
                <KV k="EPOCH" v={epoch} testid="starplate-epoch" />
                <KV k="T0 ROWS" v={t0Local ? fmtInt(s.t0_rows) : null} testid="starplate-t0-rows" />
                <KV
                    k="T1 CELLS LOCAL"
                    v={`${fmtInt(s.cells_local)} / ${fmtInt(s.cells_populated)}`}
                    testid="starplate-t1-cells"
                />
                <KV k="T1 CELLS TOTAL" v={fmtInt(s.cells_total)} testid="starplate-t1-total" />
                <KV k="BLOBS LOCAL" v={fmtInt(localBlobs)} testid="starplate-blobs" />
                <KV k="BLOB BYTES" v={null} testid="starplate-bytes" />
                <KV k="PARITY V1↔V2" v="NOT MEASURED" muted testid="starplate-parity" />
            </div>
            <p className="text-[10px] text-text-muted mt-2">
                blob bytes not reported by starplates_status; parity gate runs offline
                (tools/repro/starplates_parity.mjs)
            </p>
        </div>
    );
};

// ── Container (invoke on mount; injectable for tests) ─────────────────────

export const StarplateLibraryCard: React.FC<{ invokeFn?: InvokeFn }> = ({ invokeFn }) => {
    const [state, setState] = React.useState<StarplateCardState>({ kind: 'pending' });

    React.useEffect(() => {
        let alive = true;
        fetchStarplatesStatus(invokeFn).then(next => {
            if (alive) setState(next);
        });
        return () => {
            alive = false;
        };
    }, [invokeFn]);

    return <StarplateLibraryCardView state={state} />;
};

// ── Dock manifest (re-homed from a direct MainApp mount at the K: merge) ───
//
// CONTRACT DEVIATION (documented): this card's data source is the NATIVE
// starplates store (`starplates_status` via Tauri invoke on mount), not the
// pipeline receipt — there is nothing about the library in the receipt to
// select over. The selector therefore returns a constant marker so the dock
// always renders the card, and ABSENCE is decided inside the card by its own
// LAW-3 contract (see header): any invoke failure renders the absent voice.
// The "selector never collects" rule is preserved for PIPELINE data; the
// store-status query is an environment probe, not measurement collection.

const StarplateLibraryDockRender: React.FC = () => <StarplateLibraryCard />;

export const starplateLibraryWidget: WidgetManifest<Record<string, never>> = {
    id: 'starplate_library',
    title: 'Star-Plate Library',
    intent: 'Local star-plate store sync status (release, tier depth, T1 sky coverage) — is the native catalog present, and how much sky does it cover?',
    dataSelector: () => ({}),
    weightTier: 'stats',
    render: StarplateLibraryDockRender,
};
