import React from 'react';
import { fmtCoef } from '../calibration/chart_math';

/**
 * COEF VALUE — a fitted coefficient with its measured 1-sigma standard
 * error, or honest absence (fmtCoef renders '—' for non-finite values).
 *
 * Hoisted verbatim from the inline `CoefValue` in
 * ForensicCalibrationStep.tsx (value in `font-mono text-data`, ±σ dimmed at
 * 0.7em) so a later refactor onto the kit is a visual no-op.
 *
 * LAW 3: the ±σ appears only when a standard error was actually measured
 * (finite) — never a fabricated uncertainty.
 */
export const CoefValue: React.FC<{
    value: number | undefined | null;
    se?: number;
    className?: string;
}> = ({ value, se, className }) => (
    <span className={`font-mono text-data ${className ?? ''}`}>
        {fmtCoef(value)}
        {se != null && Number.isFinite(se) && (
            <span className="text-text-muted text-[0.7em]"> ±{fmtCoef(se, 2)}</span>
        )}
    </span>
);
