import React from 'react';
import { Chip, Readout } from '../kit';
import type { ChipTone } from '../kit';
import type { PsfAttributionReport } from '../../pipeline/stages/psf_attribution';

/**
 * ─────────────────────────────────────────────────────────────────────────
 * PSF ATTRIBUTION LEDGER (gallery W2.2) — one row per physics tier from
 * receipt.psf_attribution: anisotropy (measured), drift, diffraction,
 * seeing, refraction, coma, field rotation.
 *
 * LAW 3 (honest-or-absent):
 *   - tier chips carry the PIPELINE-AUTHORED labels (psf_attribution.ts is
 *     the author); tone is MAPPED FROM the label, never asserted by the UI:
 *     MEASURED/CONFIRMED → solve (earned), CALCULATED/FITTED → accent,
 *     APPROXIMATE/NOT_CONFIRMED → warn, FIT REJECTED → danger,
 *     NEGLIGIBLE/NOT_MEASURED → neutral with the `--` sentinel.
 *   - a row renders ONLY when its tier section exists in the block; an
 *     absent block renders NOTHING (whole ledger absent).
 *   - every number is receipt-copied — nothing recomputed, nothing invented.
 *
 * Pure render: zero computation beyond formatting the props it is given —
 * safe inside PsfPanel's expand gate (perf contract intact).
 *
 * Accepts either the live PsfAttributionReport (camelCase `fieldRotation`)
 * or the parsed receipt block (serializePsfAttributionBlock re-keys it to
 * `field_rotation`); all other section keys are identical in both shapes.
 */

export interface PsfAttributionLike {
    grid?: PsfAttributionReport['grid'];
    measured?: PsfAttributionReport['measured'] | null;
    drift?: PsfAttributionReport['drift'] | null;
    diffraction?: PsfAttributionReport['diffraction'] | null;
    seeing?: PsfAttributionReport['seeing'] | null;
    refraction?: PsfAttributionReport['refraction'] | null;
    coma?: PsfAttributionReport['coma'] | null;
    /** Live-report key. */
    fieldRotation?: PsfAttributionReport['fieldRotation'] | null;
    /** Receipt-serialized key (serializePsfAttributionBlock re-keys it). */
    field_rotation?: PsfAttributionReport['fieldRotation'] | null;
    /** Top-level honest-absence reason (live / receipt spellings). */
    notMeasured?: string;
    not_measured?: string | null;
}

/**
 * Label → tone. Keys are the pipeline-authored tier + presence labels
 * (AttrTier / DriftPresence in stages/psf_attribution.ts) plus the one
 * UI-composed label `FIT REJECTED` (earned by the pipeline's own
 * fit.patternConsistent === false — no coefficient is claimed).
 */
export const ATTR_TIER_TONE: Record<string, ChipTone> = {
    MEASURED: 'solve',
    CONFIRMED: 'solve',
    CONFIRMED_PRESENT: 'solve',
    CALCULATED: 'accent',
    FITTED: 'accent',
    'FIT REJECTED': 'danger',
    APPROXIMATE: 'warn',
    NOT_CONFIRMED: 'warn',
    INFERRED: 'info',
    NEGLIGIBLE: 'neutral',
    NOT_MEASURED: 'neutral',
};

/** Tone for a pipeline-authored label; unknown labels stay neutral (never an unearned color). */
export const attrTierTone = (label: string): ChipTone => ATTR_TIER_TONE[label] ?? 'neutral';

/** Honest formatter: finite number → fixed string, anything else → null (Readout renders `--`). */
const fmt = (v: number | null | undefined, dp: number): string | null =>
    v != null && Number.isFinite(v) ? v.toFixed(dp) : null;

interface Row {
    key: string;
    name: string;
    /** Null → the `--` sentinel (LAW 3), no unit. */
    value: string | null;
    unit?: string;
    /** Pipeline-authored labels; tone derived via attrTierTone. */
    chips: string[];
    note: string;
}

export const AttributionLedger: React.FC<{
    attribution: PsfAttributionLike | null | undefined;
}> = ({ attribution }) => {
    if (!attribution) return null; // absent block ⇒ whole ledger absent

    const px = attribution.grid === 'SCIENCE_BINNED2X' ? 'binned px (2×2)' : 'px';
    const topReason = attribution.notMeasured ?? attribution.not_measured ?? null;
    const rows: Row[] = [];

    // ── ANISOTROPY (measured — psf_field is the arbiter) ──
    const m = attribution.measured;
    if (m) {
        const measured = m.anisotropyPx != null;
        rows.push({
            key: 'anisotropy',
            name: 'Anisotropy',
            value: fmt(m.anisotropyPx, 2),
            unit: px,
            chips: [measured ? 'MEASURED' : 'NOT_MEASURED'],
            note: measured
                ? `maj − min · ${m.source} · n=${m.nFit} stars`
                : topReason ?? 'major/minor FWHM unavailable — anisotropy NOT MEASURED.',
        });
    }

    // ── SIDEREAL DRIFT (CALCULATED → test-then-trust) ──
    const d = attribution.drift;
    if (d) {
        const chips = [d.tier as string];
        // Presence flag chip only when it ADDS information: CONFIRMED_PRESENT is
        // already carried by tier CONFIRMED; NOT_MEASURED by tier NOT_MEASURED.
        if (d.presence === 'NOT_CONFIRMED' || d.presence === 'NEGLIGIBLE') chips.push(d.presence);
        rows.push({
            key: 'drift',
            name: 'Drift',
            value: fmt(d.calculatedPx, 2),
            unit: px,
            chips,
            note: d.notMeasured ?? d.note,
        });
    }

    // ── DIFFRACTION (CALCULATED per-channel floor) ──
    const f = attribution.diffraction;
    if (f) {
        rows.push({
            key: 'diffraction',
            name: 'Diffraction',
            value: fmt(f.floorPx?.g, 2),
            unit: px,
            chips: [f.tier as string],
            note: f.notMeasured
                ?? `1.028·λ/D green floor · R ${fmt(f.floorPx?.r, 2) ?? '--'} / B ${fmt(f.floorPx?.b, 2) ?? '--'} px · ⌀ ${fmt(f.apertureDiameterMm, 1) ?? '--'} mm${f.limitedGreen === true ? ' · minor FWHM at green floor' : ''}`,
        });
    }

    // ── SEEING (APPROXIMATE — assumed zenith constant) ──
    const s = attribution.seeing;
    if (s) {
        rows.push({
            key: 'seeing',
            name: 'Seeing',
            value: fmt(s.px, 2),
            unit: px,
            chips: [s.tier as string],
            note: s.notMeasured
                ?? `θ_zenith ${s.thetaZenithAssumedArcsec ?? '--'}″ ASSUMED · ${s.airmass != null ? `airmass ${fmt(s.airmass, 2)}` : 'airmass 1 (no observing geometry)'}`,
        });
    }

    // ── DIFFERENTIAL REFRACTION (APPROXIMATE, gated on trusted clock + GPS) ──
    const r = attribution.refraction;
    if (r) {
        rows.push({
            key: 'refraction',
            name: 'Refraction',
            value: fmt(r.fieldDifferentialPx, 2),
            unit: px,
            chips: [r.tier as string],
            note: r.notMeasured
                ?? `plate stretch toward zenith (Bennett, plate-level) · alt ${fmt(r.targetAltitudeDeg, 1) ?? '--'}° · airmass ${fmt(r.airmass, 2) ?? '--'}`,
        });
    }

    // ── COMA (FORM immutable, magnitude fitted — or honestly rejected) ──
    const c = attribution.coma;
    if (c) {
        const fit = c.fit;
        const rejected = fit != null && !fit.patternConsistent;
        rows.push({
            key: 'coma',
            name: 'Coma',
            // A coefficient is CLAIMED only when the pipeline found the coma form
            // consistent — a rejected fit renders the `--` sentinel, never a number.
            value: fit != null && fit.patternConsistent ? fmt(fit.coeffPerPx, 3) : null,
            chips: [c.notMeasured != null || fit == null ? 'NOT_MEASURED' : rejected ? 'FIT REJECTED' : (c.tier as string)],
            note: c.notMeasured
                ?? (fit == null
                    ? c.note
                    : rejected
                        ? `pattern inconsistent, R²=${fmt(fit.rSquared, 2) ?? '--'} — no coefficient claimed`
                        : `R²=${fmt(fit.rSquared, 2) ?? '--'} · radial dev ${fmt(fit.medianRadialDeviationDeg, 1) ?? '--'}° · n=${fit.nRegions} regions — form-exact, magnitude-empirical`),
        });
    }

    // ── FIELD ROTATION (DEFERRED — needs a mount type absent from EXIF) ──
    const fr = attribution.fieldRotation ?? attribution.field_rotation;
    if (fr) {
        rows.push({
            key: 'field_rotation',
            name: 'Field rotation',
            value: null,
            chips: [fr.tier as string],
            note: fr.note,
        });
    }

    if (rows.length === 0) return null; // no tiers present ⇒ nothing to claim

    return (
        <div data-testid="psf-attribution-ledger">
            <h5 className="text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2">
                PSF attribution — physics ledger
            </h5>
            <div className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
                {rows.map(row => (
                    <div
                        key={row.key}
                        data-testid={`psf-attr-row-${row.key}`}
                        className="grid grid-cols-[6.5rem_7.5rem_auto_1fr] items-baseline gap-x-3 py-1.5"
                    >
                        <span className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold">
                            {row.name}
                        </span>
                        <Readout value={row.value} unit={row.unit} className="text-[11px]" />
                        <span className="flex gap-1">
                            {row.chips.map(label => (
                                <Chip key={label} tone={attrTierTone(label)}>{label}</Chip>
                            ))}
                        </span>
                        {/* Notes embed receipt-copied measurements (R², n, airmass, °, mm) —
                            mono + tabular figures per the measured-number rule (A.3/B.1). */}
                        <span className="font-mono tabular-nums text-[10px] text-text-muted leading-4 min-w-0">{row.note}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
