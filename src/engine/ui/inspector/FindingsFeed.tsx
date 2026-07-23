import React, { useState } from 'react';
import { FeedItem, ScalarFinding, SolveCandidateRow } from './inspector_model';
import { ScaleSource } from '../../events/pipeline_events';

/**
 * FINDINGS FEED — typed renderer per finding kind.
 *
 * Every kind in the event union gets a real renderer NOW (ROADMAP "DSLR
 * sockets" mandate): hint_applied / blind_search_progress /
 * artifact_classified / extinction_measured render properly the day their
 * emitters land — they are never faked and simply don't appear until the
 * engine emits them.
 */

const num = (v: number, digits: number) => (Number.isFinite(v) ? v.toFixed(digits) : '--');

/** Shared row shell: tiny tracked title, optional chip, mono content. */
const FindingRow: React.FC<{
    title: string;
    chip?: React.ReactNode;
    testid?: string;
    children: React.ReactNode;
}> = ({ title, chip, testid, children }) => (
    <div data-testid={testid} className="py-2 border-b border-line-subtle/60 last:border-0">
        <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] uppercase tracking-[0.18em] text-text-muted font-semibold">{title}</span>
            {chip}
        </div>
        <div className="mt-1 font-mono text-[11px] text-data leading-relaxed">{children}</div>
    </div>
);

const Chip: React.FC<{ tone: 'solve' | 'accent' | 'warn' | 'neutral'; children: React.ReactNode }> = ({ tone, children }) => {
    const tones: Record<string, string> = {
        solve: 'bg-solve-dim text-solve',
        accent: 'bg-accent-glow text-accent-300',
        warn: 'bg-warn-dim text-warn',
        neutral: 'bg-space-750 text-text-secondary',
    };
    return <span className={`px-1.5 py-px rounded text-[9px] font-semibold tracking-wide whitespace-nowrap ${tones[tone]}`}>{children}</span>;
};

const SCALE_SOURCE_META: Record<ScaleSource, { label: string; tone: 'solve' | 'accent' }> = {
    FITS_HEADER: { label: 'FITS HEADER', tone: 'solve' },
    EXIF_OPTICS: { label: 'EXIF OPTICS', tone: 'solve' },
    TRIANGULATED: { label: 'TRIANGULATED', tone: 'accent' },
};

/** Mono key/value cell for the solution grid. */
const KV: React.FC<{ k: string; v: string }> = ({ k, v }) => (
    <div className="flex justify-between gap-2">
        <span className="text-text-muted">{k}</span>
        <span className="text-data tabular-nums">{v}</span>
    </div>
);

// A solver candidate's status is a coarse string ('SUCCESS', 'UW_VERIFY_PASS',
// 'REJECTED_VERIFY_FAILED', 'REJECTED_SCALE_GATE', …). REJECTION must win: a
// naive /verif/ test counts REJECTED_VERIFY_FAILED as a pass and paints it green.
const isRejectedStatus = (status: string): boolean => /reject|fail/i.test(status);
const isAcceptedStatus = (status: string): boolean =>
    !isRejectedStatus(status) && /success|pass|verif|accept|lock/i.test(status);

const statusClass = (status: string): string => {
    if (isRejectedStatus(status)) return 'text-danger';
    if (isAcceptedStatus(status)) return 'text-solve';
    return 'text-text-secondary';
};

/** Candidate forensics: the "why was candidate 3 rejected" surface. */
const CANDIDATE_RENDER_CAP = 40;

const CandidateTable: React.FC<{ items: SolveCandidateRow[] }> = ({ items }) => {
    // Small tables open by default (the interesting case fits on screen);
    // long blind-search sweeps start collapsed behind the summary line.
    const [open, setOpen] = useState(items.length <= 12);
    // "accepted" = candidates whose status reached a success/pass marker WITHOUT
    // a rejection marker. Honest semantics: these are solver-quad candidates that
    // passed geometry/verify — NOT catalog-confirmed stars. (Old label said
    // "verified" and mis-counted REJECTED_VERIFY_FAILED as a pass.)
    const accepted = items.filter((c) => isAcceptedStatus(c.status)).length;
    const shown = items.slice(0, CANDIDATE_RENDER_CAP);

    return (
        <div className="py-2 border-b border-line-subtle/60 last:border-0">
            <button
                data-testid="inspector-candidates-toggle"
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-2 text-left group"
            >
                <span className="text-[9px] uppercase tracking-[0.18em] text-text-muted font-semibold group-hover:text-text-secondary transition-colors">
                    <span className="inline-block w-3 text-accent-400">{open ? '▾' : '▸'}</span>
                    Solve Candidates
                </span>
                <span className="font-mono text-[10px] text-text-secondary tabular-nums">
                    {items.length} tried{accepted > 0 ? <span className="text-solve"> · {accepted} accepted</span> : null}
                </span>
            </button>
            {open && (
                <div className="mt-1.5 overflow-x-auto">
                    <table className="w-full font-mono text-[10px] text-left border-collapse">
                        <thead>
                            <tr className="text-text-faint uppercase tracking-wider">
                                <th className="pr-2 pb-1 font-medium">#</th>
                                <th className="pr-2 pb-1 font-medium">Quad err</th>
                                <th className="pr-2 pb-1 font-medium">Scale</th>
                                <th className="pb-1 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((c) => (
                                <tr key={c.seq} className="border-t border-line-subtle/50">
                                    <td className="pr-2 py-0.5 text-text-muted tabular-nums">{c.idx >= 0 ? c.idx : '--'}</td>
                                    <td className="pr-2 py-0.5 text-data tabular-nums">
                                        {c.quadError != null ? c.quadError.toExponential(2) : '--'}
                                    </td>
                                    <td className="pr-2 py-0.5 text-data tabular-nums">
                                        {c.inferredScale != null ? `${num(c.inferredScale, 2)}″` : '--'}
                                    </td>
                                    <td className={`py-0.5 ${statusClass(c.status)}`}>{c.status}</td>
                                </tr>
                            ))}
                            {items.length > CANDIDATE_RENDER_CAP && (
                                <tr className="border-t border-line-subtle/50">
                                    <td colSpan={4} className="pt-1 text-text-muted italic">
                                        +{items.length - CANDIDATE_RENDER_CAP} more candidates
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

const ScalarFindingRow: React.FC<{ finding: ScalarFinding }> = ({ finding }) => {
    switch (finding.kind) {
        case 'stars_detected':
            return (
                <FindingRow title="Stars Detected" testid="inspector-finding-stars_detected">
                    <span className="tabular-nums">{finding.count}</span> clean
                    <span className="text-text-muted"> · </span>
                    <span className={finding.anomalies > 0 ? 'text-warn' : 'text-data'}>
                        <span className="tabular-nums">{finding.anomalies}</span> anomalies
                    </span>
                </FindingRow>
            );
        case 'scale_locked': {
            const meta = SCALE_SOURCE_META[finding.source] ?? { label: finding.source, tone: 'neutral' as const };
            return (
                <FindingRow
                    title="Scale Locked"
                    testid="inspector-finding-scale_locked"
                    chip={<Chip tone={meta.tone}>{meta.label}</Chip>}
                >
                    <span className="tabular-nums">{num(finding.arcsecPerPx, 3)}</span>″/px
                </FindingRow>
            );
        }
        case 'solution_locked':
            return (
                <FindingRow title="Solution Locked" testid="inspector-finding-solution_locked" chip={<Chip tone="solve">WCS</Chip>}>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                        <KV k="RA" v={`${num(finding.raHours, 4)}h`} />
                        <KV k="DEC" v={`${finding.decDeg >= 0 ? '+' : ''}${num(finding.decDeg, 4)}°`} />
                        <KV k="SCALE" v={`${num(finding.scale, 3)}″/px`} />
                        <KV k="ROT" v={`${num(finding.rotationDeg, 2)}°`} />
                        <KV k="MATCHED" v={String(finding.matched)} />
                        <KV k="CONF" v={`${num(finding.confidence * 100, 1)}%`} />
                    </div>
                </FindingRow>
            );
        case 'packet_built':
            return (
                <FindingRow title="Packet Built" testid="inspector-finding-packet_built">
                    AstroPacket assembled <span className="text-text-muted">·</span>{' '}
                    <span className="tabular-nums">{finding.stars}</span> stars
                </FindingRow>
            );
        // ── DSLR / science-workbench sockets (render-ready; no emitters yet) ──
        case 'hint_applied':
            return (
                <FindingRow
                    title="Hint Applied"
                    testid="inspector-finding-hint_applied"
                    chip={<Chip tone="accent">{finding.source.toUpperCase()}</Chip>}
                >
                    RA <span className="tabular-nums">{num(finding.raHours, 4)}</span>h
                    <span className="text-text-muted"> · </span>
                    DEC <span className="tabular-nums">{num(finding.decDeg, 4)}</span>°
                    {finding.radiusDeg != null && (
                        <>
                            <span className="text-text-muted"> · </span>r <span className="tabular-nums">{num(finding.radiusDeg, 1)}</span>°
                        </>
                    )}
                </FindingRow>
            );
        case 'blind_search_progress': {
            const pct = finding.centersTotal ? Math.min(100, (finding.centersTried / finding.centersTotal) * 100) : null;
            return (
                <FindingRow title="Blind Search" testid="inspector-finding-blind_search_progress">
                    <span className="tabular-nums">{finding.centersTried}</span>
                    {finding.centersTotal != null && (
                        <span className="text-text-muted">
                            {' / '}
                            <span className="tabular-nums">{finding.centersTotal}</span>
                        </span>
                    )}{' '}
                    sky centers tried
                    {finding.raHours != null && finding.decDeg != null && (
                        <span className="text-text-muted">
                            {' '}@ RA {num(finding.raHours, 2)}h DEC {num(finding.decDeg, 2)}°
                        </span>
                    )}
                    {pct != null && (
                        <div className="mt-1 h-0.5 rounded bg-space-700 overflow-hidden">
                            <div className="h-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                    )}
                </FindingRow>
            );
        }
        case 'artifact_classified':
            return (
                <FindingRow title="Artifact Classified" testid="inspector-finding-artifact_classified">
                    <span className="uppercase">{finding.artifactClass}</span>
                    <span className="text-text-muted"> × </span>
                    <span className="tabular-nums">{finding.count}</span>
                </FindingRow>
            );
        case 'extinction_measured':
            return (
                <FindingRow title="Extinction Measured" testid="inspector-finding-extinction_measured">
                    gradient <span className="tabular-nums">{num(finding.gradient, 4)}</span>
                    {finding.airMass != null && (
                        <>
                            <span className="text-text-muted"> · </span>airmass <span className="tabular-nums">{num(finding.airMass, 2)}</span>
                        </>
                    )}
                </FindingRow>
            );
        // ── M10 PSF diagnostics (optional post-solve stage) ──
        case 'psf_measured':
            return (
                <FindingRow title="PSF Measured" testid="inspector-finding-psf_measured">
                    <span className="tabular-nums">{finding.nStars}</span> stars
                    <span className="text-text-muted"> · </span>
                    median FWHM <span className="tabular-nums">{num(finding.fwhmMedianPx, 2)}</span>px
                </FindingRow>
            );
        case 'psf_deconvolved':
            return (
                <FindingRow title="PSF Deconvolved" testid="inspector-finding-psf_deconvolved" chip={<Chip tone="solve">RL</Chip>}>
                    FWHM <span className="tabular-nums">{num(finding.fwhmBeforePx, 2)}</span>
                    {finding.fwhmAfterPx != null && (
                        <>
                            <span className="text-text-muted"> → </span>
                            <span className="tabular-nums">{num(finding.fwhmAfterPx, 2)}</span>
                        </>
                    )}
                    px
                    <span className="text-text-muted"> · </span>
                    <span className="tabular-nums">{finding.itersRun}</span> iters
                    <span className="text-text-muted"> · </span>
                    <span className="tabular-nums">{finding.windows}</span> windows
                </FindingRow>
            );
        default:
            return null;
    }
};

export const FindingsFeed: React.FC<{ feed: FeedItem[] }> = ({ feed }) => {
    if (feed.length === 0) {
        return <div className="text-xs text-text-muted italic">No findings yet — run a stage.</div>;
    }
    return (
        <div>
            {feed.map((item) =>
                item.type === 'candidates' ? (
                    <CandidateTable key={`cand-${item.seq}`} items={item.items} />
                ) : (
                    <ScalarFindingRow key={item.seq} finding={item.finding} />
                )
            )}
        </div>
    );
};
