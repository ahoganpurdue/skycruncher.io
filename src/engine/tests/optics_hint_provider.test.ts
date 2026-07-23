/**
 * Untrusted-FL HINT-PROVIDER SEAM (core/optics_hint_provider.ts) — the silent
 * wide-field 14mm focal-length substitution converted into a labelled, gated,
 * receipt-visible ASSUMPTION.
 *
 * Pins: (a) resolveFocalLengthWithHint returns the SAME scalar as the historical
 * getEffectiveFocalLength (byte-identical decision) AND the labelled hint; (b) the
 * hint is assumed:true, never a measurement (LAW 3); (c) the OPTICS_WIDE_FIELD_PRIOR
 * flag gates the provider (OFF ⇒ honest-absent fallthrough to the nominal FL);
 * (d) user evidence + trusted FL never produce a hint; (e) buildReceipt surfaces
 * the assumption in the additive `optics_hints` block (null-on-absence).
 */
import { describe, it, expect } from 'vitest';
import { OpticsManager } from '../core/optics_manager';
import {
    queryFocalLengthHintProviders,
    WIDE_FIELD_FL_PRIOR_MM,
} from '../core/optics_hint_provider';
import { buildReceipt, type ReceiptInputs } from '../pipeline/stages/package';
import {
    PIPELINE_CONSTANTS,
    applyConfigOverrides,
    snapshotConfig,
    restoreConfig,
} from '../pipeline/constants/pipeline_config';

// The bundled CR2 EXIF signature: 50mm / no lens / f0 (electronics-less manual lens).
const cr2Empty = { camera_model: 'Canon EOS Rebel T6', lens_model: '', focal_length: 50 };
const cr2Unknown = { camera_model: 'Canon EOS Rebel T6', lens_model: 'Unknown Lens', focal_length: 50 };

function receiptWith(opticsHints?: ReceiptInputs['opticsHints']): any {
    const i: ReceiptInputs = {
        metadata: null, signal: null, solution: null, planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, opticsHints, imageWidth: 1000, imageHeight: 1000,
    };
    return buildReceipt(i);
}

describe('OpticsManager.resolveFocalLengthWithHint — seam + labelled assumption', () => {
    it('CR2 signature (flag ON default) → value 14mm + labelled wide-field hint', () => {
        for (const md of [cr2Empty, cr2Unknown]) {
            const r = OpticsManager.resolveFocalLengthWithHint(md);
            expect(r.value_mm).toBe(WIDE_FIELD_FL_PRIOR_MM); // 14
            expect(r.hint).not.toBeNull();
            expect(r.hint!.source).toBe('WIDE_FIELD_FL_PRIOR');
            expect(r.hint!.value_mm).toBe(14);
            expect(r.hint!.assumed).toBe(true); // LAW 3 — never a measurement
            expect(typeof r.hint!.reason).toBe('string');
        }
    });

    it('byte-identical scalar: getEffectiveFocalLength === resolveFocalLengthWithHint.value_mm', () => {
        const cases: any[] = [
            cr2Empty, cr2Unknown, null,
            { ...cr2Empty, focal_length_hint_mm: 24 },
            { ...cr2Empty, focal_length_hint_mm: 0 },
            { camera_model: 'Canon EOS R5', lens_model: 'Canon RF 50mm F1.8 STM', focal_length: 50 },
            { camera_model: 'x', lens_model: '', focal_length: 200 },
        ];
        for (const md of cases) {
            expect(OpticsManager.getEffectiveFocalLength(md))
                .toBe(OpticsManager.resolveFocalLengthWithHint(md).value_mm);
        }
    });

    it('trusted FL / user evidence → NO assumption recorded (hint null)', () => {
        // User hint is evidence, not an assumption.
        expect(OpticsManager.resolveFocalLengthWithHint({ ...cr2Empty, focal_length_hint_mm: 24 }).hint).toBeNull();
        // A genuinely reported 50mm lens (misfire class avoided).
        expect(OpticsManager.resolveFocalLengthWithHint(
            { camera_model: 'Canon EOS R5', lens_model: 'Canon RF 50mm F1.8 STM', focal_length: 50 }
        ).hint).toBeNull();
        // A non-default FL is trusted as-is.
        expect(OpticsManager.resolveFocalLengthWithHint({ camera_model: 'x', lens_model: '', focal_length: 200 }).hint).toBeNull();
    });
});

describe('queryFocalLengthHintProviders — flag gate (OPTICS_WIDE_FIELD_PRIOR)', () => {
    it('flag OFF ⇒ provider declines ⇒ honest-absent fallthrough to nominal FL', () => {
        const snap = snapshotConfig(['OPTICS_WIDE_FIELD_PRIOR']);
        try {
            applyConfigOverrides({ OPTICS_WIDE_FIELD_PRIOR: false });
            expect(PIPELINE_CONSTANTS.OPTICS_WIDE_FIELD_PRIOR).toBe(false);
            // Seam declines.
            expect(queryFocalLengthHintProviders({
                exif_focal_length: 50, lens_string: '', explicit_hint_mm: undefined,
            })).toBeNull();
            // Resolver falls through to the untrusted nominal 50 (no hint) — documented degraded outcome.
            const r = OpticsManager.resolveFocalLengthWithHint(cr2Empty);
            expect(r.value_mm).toBe(50);
            expect(r.hint).toBeNull();
        } finally {
            restoreConfig(snap);
        }
        // Restored: flag ON again, CR2 → 14 with hint.
        expect(PIPELINE_CONSTANTS.OPTICS_WIDE_FIELD_PRIOR).toBe(true);
        expect(OpticsManager.resolveFocalLengthWithHint(cr2Empty).value_mm).toBe(14);
    });
});

describe('buildReceipt — additive optics_hints block (receipt-visible assumption)', () => {
    it('surfaces the labelled assumption when a hint fired', () => {
        const hint = { value_mm: 14, source: 'WIDE_FIELD_FL_PRIOR', assumed: true as const, reason: 'test reason' };
        const r = receiptWith([hint]);
        expect(Array.isArray(r.optics_hints)).toBe(true);
        expect(r.optics_hints).toHaveLength(1);
        expect(r.optics_hints[0]).toEqual({
            value_mm: 14, source: 'WIDE_FIELD_FL_PRIOR', assumed: true, reason: 'test reason',
        });
    });

    it('null-on-absence: empty or absent opticsHints ⇒ optics_hints null', () => {
        expect(receiptWith([]).optics_hints).toBeNull();
        expect(receiptWith(undefined).optics_hints).toBeNull();
    });
});
