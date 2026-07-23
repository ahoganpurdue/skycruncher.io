/**
 * PIPELINE PROVENANCE (schema 2.13.0) — DDIA population-gate provenance block.
 *
 * Pins the additive receipt block that makes a populated DB record interpretable
 * across (a) RAW decoder-arm flips (rawler ↔ libraw) and (b) atlas rebaselines:
 *   • decoder_arm — the arm that ACTUALLY decoded the frame, honest-or-absent
 *     (null when no raw decode ran: FITS-native / demo-tier), NEVER a flag guess.
 *   • atlas_id — the committed LAW-7 golden fingerprint of the shipped catalog,
 *     read from the SINGLE engine-side source of truth (binary_layouts#atlas_rows
 *     goldenVector.md5), with an atlas_version_source that is explicit it is a
 *     BUILD-TIME manifest md5, not a runtime hash of the loaded sectors.
 *
 * No gate math, no calibrated constant — pure provenance surfacing; the SOLVE is
 * byte-identical (proven on both sacred paths by the *.apispec headless smokes).
 */
import { describe, it, expect } from 'vitest';
import {
    buildPipelineProvenance,
    buildReceipt,
    type ReceiptInputs,
} from '../pipeline/stages/package';
import { RECEIPT_SCHEMA_VERSION } from '../pipeline/stages/schema_versions';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import { BINARY_LAYOUTS } from '../contracts/binary_layouts';
import type { PlateSolution } from '../types/Main_types';

// The single source of truth for atlas identity (the block must NOT duplicate it).
const ATLAS_GOLDEN = BINARY_LAYOUTS.find(b => b.name === 'atlas_rows')?.goldenVector ?? null;

describe('buildPipelineProvenance — decoder_arm honesty', () => {
    it('carries the rawler arm verbatim', () => {
        expect(buildPipelineProvenance('rawler').decoder_arm).toBe('rawler');
    });
    it('carries the libraw (cold-path) arm verbatim', () => {
        expect(buildPipelineProvenance('libraw').decoder_arm).toBe('libraw');
    });
    it('null in ⇒ null out (no raw decode ran — FITS / demo-tier)', () => {
        expect(buildPipelineProvenance(null).decoder_arm).toBeNull();
    });
    it('undefined ⇒ null (honest-or-absent, LAW 3 — never a fabricated arm)', () => {
        expect(buildPipelineProvenance(undefined).decoder_arm).toBeNull();
    });
});

describe('buildPipelineProvenance — atlas identity', () => {
    it('atlas_id is the committed binary_layouts#atlas_rows golden md5 (single source, no duplication)', () => {
        expect(ATLAS_GOLDEN).not.toBeNull(); // on-box precondition: the golden vector exists
        expect(buildPipelineProvenance('rawler').atlas_id).toBe(ATLAS_GOLDEN!.md5);
    });
    it('atlas_version_source names the source and flags it as a build-time manifest md5', () => {
        const src = buildPipelineProvenance('rawler').atlas_version_source;
        expect(typeof src).toBe('string');
        expect(src.length).toBeGreaterThan(0);
        expect(src).toContain('atlas_rows');
        expect(src).toContain('NOT a runtime hash');
        expect(src).toContain(ATLAS_GOLDEN!.manifestPath);
    });
    it('atlas identity does NOT depend on the decoder arm', () => {
        expect(buildPipelineProvenance(null).atlas_id).toBe(buildPipelineProvenance('rawler').atlas_id);
    });
});

// ── receipt inclusion + serializer survival ──────────────────────────────────

function solution(extra: Partial<PlateSolution> = {}): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20, pixel_scale: 3.6,
        rotation: 0, fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x',
        odds: 1, confidence: 0.9, num_stars: 0, matched_stars: [],
        wcs: { crpix: [500, 500], crval: [10, 20], cd: [[-1e-3, 0], [0, 1e-3]] },
        ...extra,
    } as PlateSolution;
}

function receiptFor(decoderArm: 'rawler' | 'libraw' | null | undefined): any {
    const i: ReceiptInputs = {
        metadata: null, signal: null, solution: solution(), planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, decoderArm, imageWidth: 1000, imageHeight: 1000,
    };
    return buildReceipt(i);
}

describe('buildReceipt — pipeline_provenance inclusion', () => {
    it('emits the block (added at schema 2.14.0) with the threaded rawler arm', () => {
        const r = receiptFor('rawler');
        expect(r.version).toBe('2.20.0');
        expect(RECEIPT_SCHEMA_VERSION).toBe('2.20.0');
        expect(r.pipeline_provenance).toEqual({
            decoder_arm: 'rawler',
            atlas_id: ATLAS_GOLDEN!.md5,
            atlas_version_source: expect.stringContaining('atlas_rows'),
        });
    });
    it('a FITS/absent-decode receipt carries decoder_arm null (never omitted)', () => {
        const r = receiptFor(null);
        expect(r.pipeline_provenance.decoder_arm).toBeNull();
        expect(r.pipeline_provenance.atlas_id).toBe(ATLAS_GOLDEN!.md5);
    });
    it('caller that omits decoderArm ⇒ decoder_arm null (optional input, honest-absent)', () => {
        const r = receiptFor(undefined);
        expect(r.pipeline_provenance.decoder_arm).toBeNull();
    });
    it('survives the Float32-stripping serializer round-trip', () => {
        const r = receiptFor('libraw');
        const round = JSON.parse(serializeReceipt(r));
        expect(round.pipeline_provenance.decoder_arm).toBe('libraw');
        expect(round.pipeline_provenance.atlas_id).toBe(ATLAS_GOLDEN!.md5);
    });
});
