import { describe, it, expect } from 'vitest';
import {
    formatRaSexagesimal,
    formatDecSexagesimal,
    coordHoverTitle,
} from '../ui/format/sexagesimal';

// Glyph reference (must match sexagesimal.ts byte-for-byte):
//   RA:  ʰ U+02B0 · ᵐ U+1D50 · ˢ U+02E2
//   Dec: ° U+00B0 · ′ U+2032 · ″ U+2033
//   sign − U+2212 (negative) / + ASCII (positive) · hover dot · U+00B7

describe('formatRaSexagesimal (RA in HOURS)', () => {
    it('formats compact H/M by default', () => {
        expect(formatRaSexagesimal(12.5)).toBe('12ʰ30ᵐ');
        expect(formatRaSexagesimal(17 + 35 / 60)).toBe('17ʰ35ᵐ');
        expect(formatRaSexagesimal(0)).toBe('0ʰ00ᵐ');
    });

    it('pads minutes to two digits', () => {
        expect(formatRaSexagesimal(5 + 3 / 60)).toBe('5ʰ03ᵐ');
    });

    it('includes seconds when requested', () => {
        expect(formatRaSexagesimal(12.5, { seconds: true })).toBe('12ʰ30ᵐ00ˢ');
        expect(formatRaSexagesimal(17 + 35 / 60 + 42 / 3600, { seconds: true })).toBe('17ʰ35ᵐ42ˢ');
    });

    it('rounds at the smallest displayed unit and carries minutes → hours', () => {
        // 12h59.7m rounds up to 13h00m (carry at 59.x minutes).
        expect(formatRaSexagesimal(12 + 59.7 / 60)).toBe('13ʰ00ᵐ');
    });

    it('carries seconds → minutes at 59.9s', () => {
        // 12h30m59.9s → 12h31m00s
        expect(formatRaSexagesimal(12 + 30 / 60 + 59.9 / 3600, { seconds: true })).toBe('12ʰ31ᵐ00ˢ');
    });

    it('wraps 23.999h up to 0ʰ00ᵐ (24h carry → 0)', () => {
        expect(formatRaSexagesimal(23.999)).toBe('0ʰ00ᵐ');
        // 23h59.7m → rounds to 24h00m → wraps to 0h00m
        expect(formatRaSexagesimal(23 + 59.7 / 60)).toBe('0ʰ00ᵐ');
        // with seconds: 23h59m59.9s → 24h00m00s → wraps to 0h00m00s
        expect(formatRaSexagesimal(23 + 59 / 60 + 59.9 / 3600, { seconds: true })).toBe('0ʰ00ᵐ00ˢ');
    });

    it('normalizes out-of-range hours (negative and >24)', () => {
        expect(formatRaSexagesimal(25.5)).toBe('1ʰ30ᵐ');
        expect(formatRaSexagesimal(-0.001)).toBe('0ʰ00ᵐ'); // -0.001h → 23.999h → wraps to 0
        expect(formatRaSexagesimal(-1.5)).toBe('22ʰ30ᵐ'); // -1.5h → 22.5h
    });

    it('returns NOT MEASURED for non-finite input', () => {
        expect(formatRaSexagesimal(NaN)).toBe('NOT MEASURED');
        expect(formatRaSexagesimal(Infinity)).toBe('NOT MEASURED');
        expect(formatRaSexagesimal(-Infinity)).toBe('NOT MEASURED');
    });
});

describe('formatDecSexagesimal (Dec in DEGREES)', () => {
    it('formats compact D/M by default with a sign', () => {
        expect(formatDecSexagesimal(45.5)).toBe('+45°30′');
        expect(formatDecSexagesimal(-(33 + 46 / 60))).toBe('−33°46′');
    });

    it('uses the Unicode minus (U+2212) for negatives and + for positives incl. zero', () => {
        expect(formatDecSexagesimal(-33 - 46 / 60).startsWith('−')).toBe(true);
        expect(formatDecSexagesimal(0)).toBe('+0°00′');
        expect(formatDecSexagesimal(-0)).toBe('+0°00′'); // -0 is not < 0
        expect(formatDecSexagesimal(-0.5)).toBe('−0°30′'); // small negative keeps the sign
    });

    it('includes arcseconds when requested', () => {
        expect(formatDecSexagesimal(-(33 + 46 / 60), { seconds: true })).toBe('−33°46′00″');
        expect(formatDecSexagesimal(45 + 12 / 60 + 7 / 3600, { seconds: true })).toBe('+45°12′07″');
    });

    it('rounds at the smallest displayed unit and carries arcmin → deg at 59.9′', () => {
        expect(formatDecSexagesimal(45 + 59.9 / 60)).toBe('+46°00′');
        expect(formatDecSexagesimal(-(45 + 59.9 / 60))).toBe('−46°00′');
    });

    it('carries arcsec → arcmin at 59.9″', () => {
        expect(formatDecSexagesimal(45 + 45 / 60 + 59.9 / 3600, { seconds: true })).toBe('+45°46′00″');
    });

    it('pads arcmin to two digits', () => {
        expect(formatDecSexagesimal(45 + 3 / 60)).toBe('+45°03′');
    });

    it('returns NOT MEASURED for non-finite input', () => {
        expect(formatDecSexagesimal(NaN)).toBe('NOT MEASURED');
        expect(formatDecSexagesimal(Infinity)).toBe('NOT MEASURED');
    });
});

describe('coordHoverTitle', () => {
    it('renders the decimal originals with fixed 6-dp precision', () => {
        expect(coordHoverTitle(12.5, -30.25)).toBe('RA 12.500000h · Dec -30.250000°');
        expect(coordHoverTitle(17.595604, 33.5)).toBe('RA 17.595604h · Dec 33.500000°');
    });

    it('returns NOT MEASURED when either coordinate is non-finite', () => {
        expect(coordHoverTitle(NaN, 5)).toBe('NOT MEASURED');
        expect(coordHoverTitle(5, Infinity)).toBe('NOT MEASURED');
        expect(coordHoverTitle(NaN, NaN)).toBe('NOT MEASURED');
    });
});
