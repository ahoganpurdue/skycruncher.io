/**
 * -----------------------------------------------------------------
 * PSF DIAGNOSTICS PANEL — step-6 expansion (M10, optional stage)
 * -----------------------------------------------------------------
 * (a) deconvolution stage progression: the same crop at
 *     NATIVE -> BG-FLATTENED -> RL iteration snapshots, per-stage FWHM;
 * (b) before/after star tiles: N brightest unsaturated + N most smeared,
 *     labeled with measured FWHM before -> after and position/region;
 * (c) the 3x3 region FWHM map ("your lens's corner report card").
 *
 * Every number is measured by m10_psf on the science buffer's own pixel
 * grid. Approximations are labeled APPROXIMATE from the stage's own list.
 *
 * Performance contract (owner directive): nothing runs until the user asks;
 * in AUTO mode (without the full-diagnostics opt-in) the run is measurement-
 * only (cheap text stats) and the visual lane stays behind a second opt-in.
 */

import React, { useEffect, useRef, useState } from 'react';
import { OrchestratorSession } from '../../pipeline/orchestrator_session';
import { PsfReport, PsfCrop } from '../../pipeline/m10_psf/psf_stage';
import { REGION_NAMES } from '../../pipeline/m10_psf/psf_core';
import { diagnosticsVisualsEnabled } from '../diag_prefs';
import { AttributionLedger } from './AttributionLedger';

// ─── crop rendering ─────────────────────────────────────────────────────────

interface Stretch { lo: number; hi: number; }

/** Shared display stretch from the BEFORE crop (honest pair comparison). */
function stretchFrom(crop: PsfCrop): Stretch {
    const sorted = Float32Array.from(crop.data).sort();
    const lo = sorted[Math.floor(sorted.length * 0.35)]; // local background band
    const hi = sorted[sorted.length - 1];
    return { lo, hi: hi > lo ? hi : lo + 1e-6 };
}

const CropCanvas: React.FC<{ crop: PsfCrop; stretch: Stretch; sizePx?: number; title?: string }> = ({ crop, stretch, sizePx = 88, title }) => {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const img = ctx.createImageData(crop.w, crop.h);
        const span = stretch.hi - stretch.lo;
        for (let i = 0; i < crop.w * crop.h; i++) {
            let s = (crop.data[i] - stretch.lo) / span;
            if (s < 0) s = 0; else if (s > 1) s = 1;
            const v = Math.round(255 * Math.sqrt(s)); // sqrt stretch, same for the whole pair/strip
            img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    }, [crop, stretch]);
    return (
        <canvas
            ref={ref}
            width={crop.w}
            height={crop.h}
            title={title}
            className="border border-line rounded bg-space-950"
            style={{ width: sizePx, height: sizePx, imageRendering: 'pixelated' }}
        />
    );
};

// ─── region report card ─────────────────────────────────────────────────────

const RegionGrid: React.FC<{ report: PsfReport }> = ({ report }) => {
    const meds = report.regionFwhm.map(c => c.median).filter((m): m is number => m != null);
    const best = meds.length ? Math.min(...meds) : 0;
    const worst = meds.length ? Math.max(...meds) : 1;
    const span = Math.max(1e-6, worst - best);
    return (
        <div>
            <div className="grid grid-cols-3 gap-1 w-64">
                {report.regionFwhm.map((cell, i) => {
                    const t = cell.median != null ? (cell.median - best) / span : 0;
                    return (
                        <div
                            key={REGION_NAMES[i]}
                            title={`${REGION_NAMES[i]}: ${cell.n} stars`}
                            className="rounded border border-line p-2 text-center"
                            style={{ backgroundColor: cell.median != null ? `rgba(251, 191, 36, ${(0.05 + 0.4 * t).toFixed(3)})` : 'transparent' }}
                        >
                            <div className="font-mono text-data text-sm">{cell.median != null ? cell.median.toFixed(2) : '—'}</div>
                            <div className="text-[9px] text-text-muted font-mono">{cell.n > 0 ? `n=${cell.n}` : 'no stars'}</div>
                        </div>
                    );
                })}
            </div>
            <div className="text-[10px] text-text-muted font-mono mt-1">
                median FWHM(maj) px per region · amber = softer corner
            </div>
        </div>
    );
};

// ─── the panel ──────────────────────────────────────────────────────────────

export const PsfPanel: React.FC<{ session: OrchestratorSession; autoRun?: boolean }> = ({ session, autoRun }) => {
    const [open, setOpen] = useState(false);
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [report, setReport] = useState<PsfReport | null>(session.psfReport);
    const [visualsRequested, setVisualsRequested] = useState(false);

    const fullVisuals = diagnosticsVisualsEnabled(autoRun) || visualsRequested;

    const run = async (withVisuals: boolean) => {
        if (running) return;
        setRunning(true);
        setError(null);
        const interval = setInterval(() => setStatus(session.status), 80);
        const t0 = Date.now();
        try {
            const res = await session.runPsfDiagnostics({
                deconvolve: withVisuals,
                captureSnapshots: withVisuals
            });
            console.log(`[PsfPanel] diagnostics ${withVisuals ? 'FULL' : 'measure-only'} in ${Date.now() - t0}ms`, res.timings);
            setReport(res);
        } catch (err) {
            console.error('[PsfPanel] PSF diagnostics failed:', err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            clearInterval(interval);
            setRunning(false);
        }
    };

    const gridLabel = report?.grid === 'SCIENCE_BINNED2X' ? 'binned px (2×2)' : 'px';
    const strip = report?.deconv?.strip ?? null;
    const tiles = report?.deconv?.tiles ?? [];
    const bright = tiles.filter(t => t.kind === 'bright');
    const smeared = tiles.filter(t => t.kind === 'smeared');

    return (
        <div className="bg-space-900/70 border border-line rounded-xl" data-testid="step6-psf-panel">
            {/* collapsible header (manual users can skip the cost entirely) */}
            <button
                data-testid="step6-psf-toggle"
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
            >
                <span className="text-text-muted text-[10px] font-bold uppercase tracking-widest">
                    PSF / Deconvolution Diagnostics {report ? '· measured' : '· not run'}
                </span>
                <span className="text-text-muted text-xs font-mono">{open ? '−' : '+'}</span>
            </button>

            {open && (
                <div className="px-4 pb-4 flex flex-col gap-4">
                    {!report && !running && (
                        <div className="flex items-center justify-between gap-4">
                            <p className="text-[11px] text-text-secondary max-w-xl">
                                Measures the point-spread function of ~300 field stars on the untouched
                                science grid, stacks an empirical kernel, and runs damped Richardson-Lucy
                                deconvolution on local windows around the brightest and most smeared stars.
                                {!fullVisuals && ' AUTO mode: text stats only unless you opt in below.'}
                            </p>
                            <button
                                data-testid="step6-psf-run"
                                onClick={() => run(fullVisuals)}
                                className="shrink-0 px-5 py-2.5 bg-accent-600 hover:bg-accent-500 text-white rounded-lg text-xs font-bold uppercase tracking-widest"
                            >
                                Run PSF diagnostics
                            </button>
                        </div>
                    )}

                    {running && (
                        <div className="flex items-center gap-3 py-4">
                            <div className="w-6 h-6 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
                            <span className="text-accent-400 font-mono text-sm">{status || 'PSF: working...'}</span>
                        </div>
                    )}

                    {error && (
                        <div className="text-danger font-mono text-xs">{error}</div>
                    )}

                    {report && !running && (
                        <>
                            {/* ── measured stat row ── */}
                            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-text-muted" data-testid="step6-psf-stats">
                                <span>STARS <span className="text-data">{report.nMeasured}</span>/{report.nPeaks5Sigma} maxima</span>
                                <span>MEDIAN FWHM <span className="text-data">{report.fwhmMedianPx.toFixed(2)} {gridLabel}</span></span>
                                {report.ellipticityMedian != null && (
                                    <span>ELLIPTICITY <span className="text-data">{report.ellipticityMedian.toFixed(3)}</span></span>
                                )}
                                <span>NOISE σ <span className="text-data">{report.sigmaPixel.toExponential(2)}</span></span>
                                {report.kernel && (
                                    <span>KERNEL <span className="text-data">{report.kernel.size}×{report.kernel.size}</span> from {report.kernel.nStars} stars</span>
                                )}
                                {report.deconv?.fwhmMedianAfterPx != null && (
                                    <span>AFTER RL <span className="text-solve">{report.deconv.fwhmMedianAfterPx.toFixed(2)} {gridLabel}</span> ({report.deconv.improved}/{report.deconv.remeasured} windows improved)</span>
                                )}
                                <span className="text-text-faint">measure {report.timings.measure_ms ?? 0}ms{report.timings.deconv_ms != null ? ` · deconv ${report.timings.deconv_ms}ms` : ''}</span>
                            </div>

                            {/* ── W2.2 physics attribution ledger (receipt.psf_attribution;
                                  computed by the solve, read-only here — renders nothing when
                                  the attribution block is absent). Pure render: respects the
                                  panel's perf contract (nothing computes until expanded). ── */}
                            <AttributionLedger attribution={session.psfAttribution} />

                            {/* ── approximation labels (honesty contract) ── */}
                            {report.approximate.length > 0 && (
                                <div className="flex flex-col gap-1">
                                    {report.approximate.map((a, i) => (
                                        <div key={i} className="text-[10px] font-mono text-warn">APPROXIMATE — {a}</div>
                                    ))}
                                </div>
                            )}

                            {/* ── (c) corner report card ── */}
                            <div className="flex gap-8 flex-wrap">
                                <div>
                                    <h5 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">Corner report card — FWHM by region</h5>
                                    <RegionGrid report={report} />
                                </div>

                                {/* measurement-only run: offer the visual lane */}
                                {!report.deconv && report.nMeasured >= 20 && (
                                    <div className="flex flex-col justify-center gap-2">
                                        <div className="text-[11px] font-mono text-text-muted max-w-xs">
                                            {report.kernel
                                                ? 'Deconvolution visuals skipped (AUTO mode / measure-only run).'
                                                : 'Kernel unavailable — deconvolution not possible on this frame.'}
                                        </div>
                                        {report.kernel && (
                                            <button
                                                data-testid="step6-psf-run-full"
                                                onClick={() => { setVisualsRequested(true); run(true); }}
                                                className="px-4 py-2 bg-space-800 hover:bg-space-750 border border-line text-text-secondary hover:text-text-primary rounded text-xs font-bold uppercase tracking-widest w-fit"
                                            >
                                                Run deconvolution visuals
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* ── (a) stage progression strip ── */}
                            {strip && (
                                <div data-testid="step6-psf-strip">
                                    <h5 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">
                                        Deconvolution stages — brightest unsaturated star @ ({Math.round(strip.cx)}, {Math.round(strip.cy)}) · {strip.region}
                                    </h5>
                                    <div className="flex gap-3 overflow-x-auto pb-2">
                                        {(() => {
                                            const st = stretchFrom(strip.stages[0].crop);
                                            return strip.stages.map((stage, i) => (
                                                <div key={i} className="flex flex-col items-center gap-1 shrink-0">
                                                    <CropCanvas crop={stage.crop} stretch={st} sizePx={110} title={stage.label} />
                                                    <div className="text-[9px] font-mono text-text-secondary uppercase">{stage.label}</div>
                                                    <div className="text-[10px] font-mono text-data">
                                                        {stage.fwhm != null ? `FWHM ${stage.fwhm.toFixed(2)}` : 'FWHM —'}
                                                    </div>
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                    <div className="text-[10px] text-text-muted font-mono">
                                        identical sqrt display stretch across all stages (from the NATIVE crop)
                                    </div>
                                </div>
                            )}

                            {/* ── (b) star tiles ── */}
                            {tiles.length > 0 && (
                                <div className="grid grid-cols-2 gap-6" data-testid="step6-psf-tiles">
                                    {[{ label: 'Brightest unsaturated', list: bright }, { label: 'Most smeared (worst FWHM)', list: smeared }].map(group => (
                                        <div key={group.label}>
                                            <h5 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">{group.label} — before → after</h5>
                                            <div className="flex flex-col gap-2">
                                                {group.list.map((t, i) => {
                                                    const st = stretchFrom(t.before);
                                                    return (
                                                        <div key={i} className="flex items-center gap-3 bg-space-800/60 border border-line-subtle rounded p-2">
                                                            <CropCanvas crop={t.before} stretch={st} sizePx={64} title="native" />
                                                            <span className="text-text-muted text-xs">→</span>
                                                            {t.after
                                                                ? <CropCanvas crop={t.after} stretch={st} sizePx={64} title="deconvolved" />
                                                                : <div className="w-16 h-16 border border-line rounded flex items-center justify-center text-[9px] text-text-muted">n/a</div>}
                                                            <div className="font-mono text-[10px] leading-4">
                                                                <div className="text-data">
                                                                    FWHM {t.fwhmBefore.toFixed(2)} → {t.fwhmAfter != null ? <span className={t.fwhmAfter < t.fwhmBefore ? 'text-solve' : 'text-warn'}>{t.fwhmAfter.toFixed(2)}</span> : '—'} {gridLabel}
                                                                </div>
                                                                <div className="text-text-muted">({Math.round(t.cx)}, {Math.round(t.cy)}) · {t.region}</div>
                                                                <div className="text-text-faint">ellip {t.ellipticityBefore.toFixed(2)}</div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
