/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WIDGET SHELF — read-only registry-driven receipt-drop viewer (owner-requested)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A DELIBERATELY LEAN page (owner: "just slapping the widgets on the page is good
 * enough"). Drop a solve RECEIPT JSON (the buildReceipt / buildFailureReceipt
 * product, schema `RECEIPT_SCHEMA_VERSION`) and every registered widget renders
 * from it in a dumb CSS grid — no wizard, no pipeline, no session state.
 *
 * READ-ONLY / NO WIZARD CONTACT: this module imports NOTHING from the stateful
 * wizard flow (orchestrator_session / PipelineWizard / stages). It reads the
 * already-serialized receipt exactly the way the WidgetDock does — through each
 * widget manifest's PURE `dataSelector`. Rendering it can never change pipeline
 * behavior or the load-bearing status strings.
 *
 * HONEST-OR-ABSENT (LAW 3): the per-widget empty state is the dock's ONE
 * enforcement point — `WidgetFrame` (imported, not re-implemented). A widget whose
 * selector returns null shows the dock's honest taxonomy (NOT MEASURED / AWAITING
 * SOLVE / PLANNED) — never a fabricated number, never a crash. A malformed / non-
 * receipt JSON collapses to a single clear error line.
 *
 * The SHOWCASE section iframes report-class self-contained pages (baked, fixed
 * data — NOT registry widgets, NOT payload-driven; labelled as such). They are
 * LOCAL demo artifacts declared by `public/showcase/manifest.json`; on a box
 * without them the section renders an honest "not present" state.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WIDGETS } from './registry';
import { WidgetFrame } from './WidgetDock';
import { RECEIPT_SCHEMA_VERSION } from '../../pipeline/stages/schema_versions';
import { normalizeGreenfieldReceipt } from './data/greenfield_receipt';

// ─── receipt identity (defensive — every field honest-or-absent) ────────────

type ReceiptStatus = 'SOLVED' | 'REFUSED' | 'NO SOLUTION';

interface ReceiptIdentity {
    frame: string | null;
    sourceFormat: string | null;
    version: string | null;
    versionMatchesViewer: boolean;
    status: ReceiptStatus;
    refusalReason: string | null;
    solvedVia: string | null;
    camera: string | null;
    lens: string | null;
}

const asString = (v: unknown): string | null =>
    (typeof v === 'string' && v.trim().length > 0 ? v : null);

/** Does this parsed JSON plausibly look like a solve receipt? Pure structural check.
 *  Accepts a wizard receipt (version / solution / kind) AND a bare greenfield solver-
 *  core dump (`{decision,…}`) so a raw desktop-solve artifact can be previewed too. */
export function looksLikeReceipt(obj: unknown): obj is Record<string, any> {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const o = obj as Record<string, any>;
    // A wizard receipt carries the contract `version` string; solved carry `solution`,
    // no-solve carry `kind:'no_solve'`. A bare greenfield core dump carries `decision`.
    return typeof o.version === 'string' || 'solution' in o || o.kind === 'no_solve'
        || (o.decision != null && typeof o.decision === 'object');
}

/** Read the identity strip fields defensively. Never fabricates — absent ⇒ null. */
export function readIdentity(r: Record<string, any>): ReceiptIdentity {
    const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
    const version = asString(r.version);
    const sha = asString(r.frame_sha256);
    // A bare greenfield core dump has no wizard `solution` — derive its identity from
    // the greenfield decision instead (honest status + engine label), never 'NO SOLUTION'.
    const gf = (r.solution == null && r.kind !== 'no_solve') ? normalizeGreenfieldReceipt(r) : null;
    const gfState = (gf?.state ?? '').toLowerCase();
    const status: ReceiptStatus =
        r.solution != null ? 'SOLVED'
        : r.kind === 'no_solve' ? 'REFUSED'
        : gf ? (gfState === 'solved' ? 'SOLVED' : gfState ? 'REFUSED' : 'NO SOLUTION')
        : 'NO SOLUTION';
    const solvedVia = asString(r.solve_provenance?.solved_via) ?? (gf ? 'greenfield · Rust core' : null);
    return {
        // No receipt carries a filename today (privacy/portability). Fall back to the
        // content SHA (short) — honest identity — then the greenfield frame id, then null.
        frame: asString(meta.file_name) ?? (sha ? `sha256:${sha.slice(0, 12)}…` : null) ?? (gf ? asString(gf.frameId) : null),
        sourceFormat: asString(r.source_format),
        version,
        versionMatchesViewer: version === RECEIPT_SCHEMA_VERSION,
        status,
        refusalReason: asString(r.failure?.reason),
        solvedVia,
        camera: asString(meta.camera_model),
        lens: asString(meta.lens_model),
    };
}

const STATUS_STYLE: Record<ReceiptStatus, React.CSSProperties> = {
    SOLVED: { background: 'rgba(52,211,153,0.15)', color: '#34d399', borderColor: 'rgba(52,211,153,0.4)' },
    REFUSED: { background: 'rgba(251,191,36,0.15)', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.4)' },
    'NO SOLUTION': { background: 'rgba(148,165,189,0.12)', color: '#9aa5bd', borderColor: 'rgba(148,165,189,0.35)' },
};

const IdentityChip: React.FC<{ label: string; value: string | null; mono?: boolean; style?: React.CSSProperties }> =
({ label, value, mono, style }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }} data-testid={`shelf-identity-${label.toLowerCase().replace(/\s+/g, '-')}`}>
        <span style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#5d6880' }}>{label}</span>
        <span style={{ fontSize: 12, color: value ? '#c7d5f0' : '#5d6880',
                       fontFamily: mono ? 'var(--font-mono, monospace)' : 'inherit',
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style }}>
            {value ?? '—'}
        </span>
    </div>
);

// ─── showcase (local report-class artifacts; NOT registry widgets) ──────────

// ─── inventory: viewers FOUND but not yet payload-driven (consolidation delta) ──
// Honest surfacing (not fabricated widgets): components that exist in the app but
// whose registry wiring is blocked on inputs the receipt does not carry today.
const NOT_YET_PAYLOAD_DRIVEN: { name: string; reason: string }[] = [
    { name: 'DataFlowDiagram', reason: 'consumes the LIVE pipeline manifest / stage results, not a serialized receipt block.' },
    { name: 'StarIntegrityList', reason: 'expects nested MatchedStar{catalog,detected}; the receipt flattens matched_stars — needs an adapter.' },
    { name: 'TelemetryBar', reason: 'feedable from receipt.forensics + signal counts — deferred (multi-block adapter, low priority).' },
    { name: 'ConfirmTierBadge', reason: 'redundant with deep_confirm + the confirm_status line in solve_summary.' },
    { name: 'PsfPanel crops / before-after tiles', reason: 'need image pixel buffers; the receipt carries PSF stats only (psf_field), no pixels.' },
];

interface ShowcaseAsset { id: string; src: string; title: string; note: string; }

const ShowcaseSection: React.FC = () => {
    // null = still checking · [] = manifest absent/unreadable · [...] = present assets.
    const [assets, setAssets] = useState<ShowcaseAsset[] | null>(null);
    useEffect(() => {
        let alive = true;
        // The manifest is the source of truth for what's LOCALLY present. A box without
        // the (gitignored, heavy) demo artifacts has no manifest — the SPA fallback
        // returns index.html, JSON.parse throws, and we honestly render "not present"
        // (never a recursive index.html iframe).
        fetch('/showcase/manifest.json', { cache: 'no-store' })
            .then(res => res.text())
            .then(text => {
                const parsed = JSON.parse(text);
                const list = Array.isArray(parsed?.assets) ? parsed.assets as ShowcaseAsset[] : [];
                if (alive) setAssets(list);
            })
            .catch(() => { if (alive) setAssets([]); });
        return () => { alive = false; };
    }, []);

    return (
        <section style={{ marginTop: 36 }} data-testid="shelf-showcase">
            <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: '#9aa5bd', margin: '0 0 4px' }}>
                Showcase — fixed-data report pages
            </h2>
            <p style={{ fontSize: 11, color: '#5d6880', margin: '0 0 14px', maxWidth: 720, lineHeight: 1.5 }}>
                Self-contained report pages with data baked inline. These are NOT registry widgets and are NOT
                payload-driven — they will not adapt to the dropped receipt. A separate task will properly
                widgetize the layer-stack (parameterized from the payload).
            </p>
            {assets == null ? (
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: '#5d6880' }}>Checking for local showcase assets…</div>
            ) : assets.length === 0 ? (
                <div data-testid="shelf-showcase-absent"
                     style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: '#5d6880',
                              border: '1px dashed rgba(148,165,189,0.3)', borderRadius: 8, padding: 16 }}>
                    NOT PRESENT ON THIS BOX — showcase pages are local demo artifacts (public/showcase/, gitignored).
                </div>
            ) : (
                <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
                    {assets.map(a => (
                        <section key={a.id} data-testid={`shelf-showcase-${a.id}`}
                                 style={{ border: '1px solid rgba(148,165,189,0.18)', borderRadius: 12, padding: 12, background: 'rgba(5,6,10,0.5)' }}>
                            <header style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#9aa5bd' }}>{a.title}</span>
                                <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono, monospace)', color: '#fbbf24' }}>{a.note}</span>
                            </header>
                            <iframe src={a.src} title={a.title} loading="lazy"
                                    style={{ width: '100%', height: 340, border: 'none', borderRadius: 8, background: '#05060a' }} />
                        </section>
                    ))}
                </div>
            )}
        </section>
    );
};

// ─── page ───────────────────────────────────────────────────────────────────

export const WidgetShelf: React.FC = () => {
    const [receipt, setReceipt] = useState<Record<string, any> | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const ingest = useCallback((file: File) => {
        setFileName(file.name);
        setError(null);
        const reader = new FileReader();
        reader.onerror = () => { setReceipt(null); setError('Could not read the file.'); };
        reader.onload = () => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(String(reader.result));
            } catch {
                setReceipt(null);
                setError('Not valid JSON — could not parse the dropped file.');
                return;
            }
            if (!looksLikeReceipt(parsed)) {
                setReceipt(null);
                setError('This JSON does not look like a solve receipt (no version / solution / kind field).');
                return;
            }
            setReceipt(parsed);
        };
        reader.readAsText(file);
    }, []);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) ingest(file);
    }, [ingest]);

    /** Parse + validate a fetched JSON string exactly like a dropped file. */
    const ingestText = useCallback((label: string, text: string) => {
        setFileName(label);
        setError(null);
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { setReceipt(null); setError(`Not valid JSON at ${label}.`); return; }
        if (!looksLikeReceipt(parsed)) {
            setReceipt(null);
            setError('This JSON does not look like a solve receipt (no version / solution / kind field).');
            return;
        }
        setReceipt(parsed);
    }, []);

    // Optional convenience loader: `?receipt=<url>` (same-origin) fetches + renders a
    // banked receipt so a view can be linked/bookmarked. Read-only — identical
    // validation path as a dropped file; a bad URL/JSON collapses to the error line.
    useEffect(() => {
        const url = new URLSearchParams(window.location.search).get('receipt');
        if (!url) return;
        let alive = true;
        fetch(url, { cache: 'no-store' })
            .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.text(); })
            .then(text => { if (alive) ingestText(url, text); })
            .catch(err => { if (alive) { setReceipt(null); setError(`Could not load ?receipt=${url} (${String(err)}).`); } });
        return () => { alive = false; };
    }, [ingestText]);

    const identity = useMemo(() => (receipt ? readIdentity(receipt) : null), [receipt]);

    return (
        <div style={{ minHeight: '100vh', background: 'radial-gradient(circle at 50% 0%, #12141c 0%, #05060a 60%)',
                      color: '#e8ecf4', fontFamily: "'Inter', system-ui, sans-serif", padding: '24px 28px 64px' }}
             data-testid="widget-shelf">
            <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <h1 style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1, margin: 0 }}>Widget Shelf</h1>
                <span style={{ fontSize: 11, color: '#5d6880' }}>
                    Drop a solve receipt JSON — every registered widget renders from it (read-only). Viewer schema {RECEIPT_SCHEMA_VERSION}.
                </span>
            </header>

            {/* Drop zone + picker */}
            <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => inputRef.current?.click()}
                data-testid="shelf-dropzone"
                style={{
                    border: `2px dashed ${dragging ? '#38bdf8' : 'rgba(148,165,189,0.35)'}`,
                    borderRadius: 12, padding: '22px 20px', textAlign: 'center', cursor: 'pointer',
                    background: dragging ? 'rgba(56,189,248,0.06)' : 'rgba(5,6,10,0.4)', transition: 'all .15s',
                }}
            >
                <div style={{ fontSize: 13, color: '#9aa5bd' }}>
                    {fileName ? <>Loaded <span style={{ color: '#c7d5f0', fontFamily: 'var(--font-mono, monospace)' }}>{fileName}</span> — drop another to replace</>
                              : <>Drop a <code>.receipt.json</code> here, or click to pick a file</>}
                </div>
                <input ref={inputRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                       data-testid="shelf-file-input"
                       onChange={(e) => { const f = e.target.files?.[0]; if (f) ingest(f); e.target.value = ''; }} />
            </div>

            {error && (
                <div data-testid="shelf-error"
                     style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
                              background: 'rgba(220,50,50,0.14)', color: '#fca5a5', border: '1px solid rgba(220,50,50,0.4)' }}>
                    {error}
                </div>
            )}

            {/* Identity strip */}
            {identity && (
                <div data-testid="shelf-identity"
                     style={{ marginTop: 16, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-end',
                              padding: '12px 16px', borderRadius: 10, background: 'rgba(5,6,10,0.55)', border: '1px solid rgba(148,165,189,0.15)' }}>
                    <IdentityChip label="Frame" value={identity.frame} mono />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#5d6880' }}>Status</span>
                        <span data-testid="shelf-status"
                              style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, padding: '2px 8px', borderRadius: 5,
                                       border: '1px solid', ...STATUS_STYLE[identity.status] }}>
                            {identity.status}
                        </span>
                    </div>
                    <IdentityChip label="Solved via" value={identity.solvedVia} mono />
                    <IdentityChip label="Source format" value={identity.sourceFormat} mono />
                    <IdentityChip label="Camera" value={identity.camera} />
                    <IdentityChip label="Lens" value={identity.lens} />
                    <IdentityChip label="Schema"
                                  value={identity.version ? `${identity.version}${identity.versionMatchesViewer ? '' : ` (viewer ${RECEIPT_SCHEMA_VERSION})`}` : null}
                                  mono
                                  style={identity.version && !identity.versionMatchesViewer ? { color: '#fbbf24' } : undefined} />
                    {identity.status === 'REFUSED' && identity.refusalReason && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexBasis: '100%' }}>
                            <span style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#5d6880' }}>Refusal reason</span>
                            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: '#fbbf24' }}>{identity.refusalReason}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Widget grid — EVERY registered widget, honest-or-absent per cell (WidgetFrame). */}
            <div style={{ marginTop: 22 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                    <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: '#9aa5bd', margin: 0 }}>
                        Registered widgets
                    </h2>
                    <span data-testid="shelf-widget-count" style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: '#5d6880' }}>
                        {WIDGETS.length} in registry{receipt ? '' : ' — awaiting a receipt'}
                    </span>
                </div>
                <div className="grid gap-4" data-testid="shelf-grid"
                     style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                    {WIDGETS.map(w => (
                        <WidgetFrame key={w.id} manifest={w} receipt={receipt} events={undefined} />
                    ))}
                </div>
            </div>

            {/* Found-but-not-yet-payload-driven inventory (consolidation delta) — honest
                surfacing of viewers that exist but aren't registry-wired yet. */}
            <section style={{ marginTop: 32 }} data-testid="shelf-not-yet-payload-driven">
                <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: '#9aa5bd', margin: '0 0 4px' }}>
                    Found — not yet payload-driven
                </h2>
                <p style={{ fontSize: 11, color: '#5d6880', margin: '0 0 12px', maxWidth: 720, lineHeight: 1.5 }}>
                    These viewers exist in the app but are not registry-wired yet — their inputs are not carried by
                    the receipt (or need an adapter). Listed for the follow-up consolidation task, not rendered.
                </p>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {NOT_YET_PAYLOAD_DRIVEN.map(x => (
                        <li key={x.name} style={{ fontSize: 11, color: '#9aa5bd', fontFamily: 'var(--font-mono, monospace)' }}>
                            <span style={{ color: '#c7d5f0' }}>{x.name}</span> <span style={{ color: '#5d6880' }}>— {x.reason}</span>
                        </li>
                    ))}
                </ul>
            </section>

            <ShowcaseSection />
        </div>
    );
};

export default WidgetShelf;
