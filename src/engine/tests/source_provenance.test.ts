/**
 * Source-provenance (frame-byte ORIGIN) — the intake content-sha ledger match, the
 * injectable resolver default, and the additive receipt/ASDF/FITS carry.
 *
 * The ledger rows here are INLINE (a faithful copy of the real
 * test_results/overnight/intake_ledger.jsonl row shape, schema
 * `skycruncher.intake.provenance/1`), so the test is fully deterministic and portable
 * — it does NOT depend on the gitignored local-only ledger (no skip on a clean clone).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
    matchIntakeProvenance,
    resolveSourceProvenance,
    setSourceProvenanceResolver,
    type IntakeLedgerRow,
} from '../pipeline/m1_ingestion/source_provenance';
import { serializeFits, type FitsImage } from '../pipeline/export/fits_writer';
import { serializeAsdf, type AsdfImage } from '../pipeline/export/asdf_writer';

// A real gdrive ledger row (M31 Andromeda, shape verbatim from intake_ledger.jsonl).
const GDRIVE_ROW: IntakeLedgerRow = {
    schema: 'skycruncher.intake.provenance/1',
    label: 'gdrive_shared_folder/Andromeda Galaxy M31 90s-431_ISO100.fit',
    source: { type: 'gdrive_file', id: '1suP_58wVySkmNGBLKw-Eu66JiUvRiGd-' },
    resolved_url: 'https://drive.usercontent.google.com/download?id=1suP_58wVySkmNGBLKw-Eu66JiUvRiGd-&export=download&confirm=t',
    sha256: 'e4946d529ef1ebb9a2fe139edc702ef248aea234015c45e6bd5ee71f1f3c425b',
    fetched_at: '2026-07-08T03:00:23.407Z',
};
const HTTP_ROW: IntakeLedgerRow = {
    source: { type: 'http', url: 'https://archive.org/download/item/frame.fits' },
    resolved_url: 'https://archive.org/download/item/frame.fits',
    sha256: 'a'.repeat(64),
    fetched_at: '2026-07-08T04:00:00.000Z',
};
const UNKNOWN_TYPE_ROW: IntakeLedgerRow = {
    source: { type: 'ftp', url: 'ftp://example/x.fits' },
    resolved_url: 'ftp://example/x.fits',
    sha256: 'b'.repeat(64),
    fetched_at: '2026-07-08T05:00:00.000Z',
};
const LEDGER = [GDRIVE_ROW, HTTP_ROW, UNKNOWN_TYPE_ROW];

describe('matchIntakeProvenance — pure content-sha → origin mapping', () => {
    it('maps a gdrive_file row → origin "gdrive" with the resolved download URL', () => {
        const p = matchIntakeProvenance(GDRIVE_ROW.sha256!, LEDGER);
        expect(p).not.toBeNull();
        expect(p!.origin).toBe('gdrive');
        expect(p!.uri).toBe(GDRIVE_ROW.resolved_url);
        expect(p!.fetched_at).toBe('2026-07-08T03:00:23.407Z');
        expect(p!.intake_sha256).toBe(GDRIVE_ROW.sha256);
    });

    it('maps an http row → origin "url"', () => {
        const p = matchIntakeProvenance(HTTP_ROW.sha256!, LEDGER);
        expect(p!.origin).toBe('url');
        expect(p!.uri).toBe(HTTP_ROW.resolved_url);
    });

    it('maps an unknown source.type → origin null but still carries the URI/sha (honest, not dropped)', () => {
        const p = matchIntakeProvenance(UNKNOWN_TYPE_ROW.sha256!, LEDGER);
        expect(p).not.toBeNull();
        expect(p!.origin).toBeNull();
        expect(p!.uri).toBe('ftp://example/x.fits');
        expect(p!.intake_sha256).toBe(UNKNOWN_TYPE_ROW.sha256);
    });

    it('falls back to gdrive:<id> when a matched gdrive row has no resolved_url', () => {
        const row: IntakeLedgerRow = { source: { type: 'gdrive_file', id: 'ABC123' }, sha256: 'c'.repeat(64) };
        const p = matchIntakeProvenance('c'.repeat(64), [row]);
        expect(p!.origin).toBe('gdrive');
        expect(p!.uri).toBe('gdrive:ABC123');
    });

    it('returns null (honest-absent) when no ledger row matches the sha — NEVER fabricated', () => {
        expect(matchIntakeProvenance('f'.repeat(64), LEDGER)).toBeNull();
    });

    it('returns null on an empty sha or a non-array ledger', () => {
        expect(matchIntakeProvenance('', LEDGER)).toBeNull();
        expect(matchIntakeProvenance(GDRIVE_ROW.sha256!, undefined as any)).toBeNull();
    });
});

describe('resolveSourceProvenance — injectable resolver (default null)', () => {
    afterEach(() => setSourceProvenanceResolver(null)); // never leak module state to sibling tests

    it('returns null when NO resolver is installed (browser + sacred paths — zero I/O)', async () => {
        expect(await resolveSourceProvenance(new ArrayBuffer(8))).toBeNull();
    });

    it('returns the injected resolver\'s result once installed', async () => {
        setSourceProvenanceResolver(() => matchIntakeProvenance(GDRIVE_ROW.sha256!, LEDGER));
        const p = await resolveSourceProvenance(new ArrayBuffer(8));
        expect(p!.origin).toBe('gdrive');
    });

    it('degrades a throwing resolver to null (a lookup hiccup never breaks ingest)', async () => {
        setSourceProvenanceResolver(() => { throw new Error('ledger read failed'); });
        expect(await resolveSourceProvenance(new ArrayBuffer(8))).toBeNull();
    });
});

// ── exporter carry (additive, honest-absent) ──────────────────────────────────

function makeReceipt(extra: any = {}) {
    return {
        version: '2.6.0',
        solution: { spatial_hash: 'cafebabe', ra_hours: 11.34, astrometry: { rms_arcsec: 0.5 } },
        wcs: {
            CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
            CRPIX1: 100, CRPIX2: 50, CRVAL1: 170.1188, CRVAL2: -22.4,
            CD1_1: -1.021e-3, CD1_2: 3.5e-4, CD2_1: 3.5e-4, CD2_2: 1.021e-3,
            EQUINOX: 2000.0, RADESYS: 'ICRS', SOURCE: 'FITTED',
        },
        ...extra,
    };
}
const SP = {
    origin: 'gdrive',
    uri: GDRIVE_ROW.resolved_url,
    fetched_at: GDRIVE_ROW.fetched_at,
    intake_sha256: GDRIVE_ROW.sha256,
};
const monoFits = (w: number, h: number): FitsImage => ({ data: new Float32Array(w * h), width: w, height: h, channels: 1 });
const monoAsdf = (w: number, h: number): AsdfImage => ({ data: new Float32Array(w * h), width: w, height: h, channels: 1 });

/** Collect HISTORY card text from a FITS byte stream (up to END). Each returned
 *  string keeps its intra-field indent (only the `HISTORY ` keyword is stripped),
 *  so continuation pieces reassemble without losing leading URL/sha characters. */
function historyCards(buf: Uint8Array): string[] {
    const text = new TextDecoder('latin1').decode(buf);
    const out: string[] = [];
    for (let i = 0; i + 80 <= text.length; i += 80) {
        const card = text.slice(i, i + 80);
        if (card.startsWith('END') && card.slice(3).trim() === '') break;
        // Every card must be exactly 80 bytes (the writer pads; overflow would corrupt).
        expect(card.length).toBe(80);
        if (card.startsWith('HISTORY')) out.push(card.slice(8).replace(/\s+$/, '')); // drop 'HISTORY ' + trailing pad
    }
    return out;
}

/** Reassemble a chunked provenance field: `  <key>= …` + `  <key>(cont)= …`. */
function reassembleField(cards: string[], key: string): string {
    const head = `  ${key}= `;
    const cont = `  ${key}(cont)= `;
    return cards
        .filter((c) => c.startsWith(head) || c.startsWith(cont))
        .map((c) => (c.startsWith(cont) ? c.slice(cont.length) : c.slice(head.length)))
        .join('');
}

describe('FITS export — source-provenance HISTORY cards', () => {
    it('emits origin/uri/fetched_at/sha HISTORY cards, round-tripping long values without truncation', () => {
        const out = serializeFits(makeReceipt({ source_provenance: SP }), monoFits(8, 6));
        const cards = historyCards(out);
        expect(cards.join('\n')).toContain('SkyCruncher source provenance');
        expect(reassembleField(cards, 'origin')).toBe('gdrive');
        expect(reassembleField(cards, 'fetched_at')).toBe(SP.fetched_at);
        // The 64-char sha and 100+ char Drive URL are chunked across cards; each
        // reassembles EXACTLY (silent truncation of provenance is a bug — see the
        // writer's emitProvenanceField).
        expect(reassembleField(cards, 'intake_sha256')).toBe(SP.intake_sha256);
        expect(reassembleField(cards, 'uri')).toBe(SP.uri);
        // Whole FITS stream stays 2880-block-aligned.
        expect(out.length % 2880).toBe(0);
    });

    it('emits NO provenance HISTORY cards when the origin is unknown (honest-absent)', () => {
        const out = serializeFits(makeReceipt(), monoFits(8, 6));
        expect(historyCards(out).some((c) => c.includes('source provenance'))).toBe(false);
    });
});

describe('ASDF export — source-provenance node', () => {
    it('emits com.skycruncher.source_provenance with origin + uri when present', () => {
        const out = serializeAsdf(makeReceipt({ source_provenance: SP }), monoAsdf(8, 6), { libraryVersion: '0.0.0-test' });
        const yaml = new TextDecoder('latin1').decode(out).split('\xd3BLK')[0];
        expect(yaml).toContain('com.skycruncher.source_provenance');
        expect(yaml).toContain('origin: "gdrive"');
        expect(yaml).toContain(SP.uri);
    });

    it('emits no labeled provenance node when the origin is unknown (honest-absent)', () => {
        const out = serializeAsdf(makeReceipt(), monoAsdf(8, 6), { libraryVersion: '0.0.0-test' });
        const yaml = new TextDecoder('latin1').decode(out).split('\xd3BLK')[0];
        expect(yaml).not.toContain('com.skycruncher.source_provenance');
    });
});
