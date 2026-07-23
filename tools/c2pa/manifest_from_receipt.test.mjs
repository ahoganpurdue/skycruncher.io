// tools/c2pa/manifest_from_receipt.test.mjs
// Gate coverage for the intellectual core: the pure receipt→manifest mapping.
// No c2patool binary, no certs — deterministic against a committed fixture, so it
// runs in the standard `npx vitest run` battery even where bin/ is unfetched.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifestDefinition,
  receiptSha256,
  measuredFamilies,
  MANIFEST_MAP_SCHEMA_VERSION,
} from './manifest_from_receipt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'm66_min.receipt.json');
const bytes = fs.readFileSync(FIXTURE);
const receipt = JSON.parse(bytes.toString('utf8'));
const sha = receiptSha256(bytes);

describe('c2pa manifest_from_receipt', () => {
  it('receipt_sha256 is a stable 64-hex hash of the exact bytes', () => {
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    // recomputing over identical bytes is deterministic
    expect(receiptSha256(bytes)).toBe(sha);
    // one flipped byte ⇒ different hash (tamper sensitivity of the binding)
    const flipped = Buffer.from(bytes);
    flipped[10] = flipped[10] ^ 0xff;
    expect(receiptSha256(flipped)).not.toBe(sha);
  });

  it('maps the sacred M66 solve summary faithfully', () => {
    const def = buildManifestDefinition(receipt, { assetTitle: 'M66', receiptSha256: sha });
    const receiptAssertion = def.assertions.find((a) => a.label === 'org.skycruncher.receipt');
    expect(receiptAssertion.data.solve).toEqual({
      ra_hours: 11.341253475172621,
      dec_degrees: 13.048392248246461,
      scale_arcsec_px: 3.6776147325019153,
      matched: 272,
      confidence: 0.8310893541573466,
    });
    expect(receiptAssertion.data.receipt_sha256).toBe(sha);
    expect(receiptAssertion.data.receipt_schema_version).toBe('2.4.0');
    expect(receiptAssertion.data.schema_version).toBe(MANIFEST_MAP_SCHEMA_VERSION);
  });

  it('claim generator + standard c2pa.created action carry the tool identity', () => {
    const def = buildManifestDefinition(receipt, { assetTitle: 'M66', receiptSha256: sha });
    expect(def.claim_generator).toBe('SkyCruncher/2.4.0');
    const actions = def.assertions.find((a) => a.label === 'c2pa.actions');
    expect(actions.data.actions[0].action).toBe('c2pa.created');
    expect(actions.data.actions[0].softwareAgent).toBe('SkyCruncher/2.4.0');
  });

  it('epistemic.measured lists exactly the genuinely-measured families', () => {
    expect(measuredFamilies(receipt)).toEqual([
      'wcs', 'sip', 'tps', 'lens_distortion_measured',
      'psf_field', 'psf_attribution', 'bc_rematch', 'deep_confirmed', 'spcc',
    ]);
  });

  it('honest-or-absent: not_measured families never enter epistemic.measured', () => {
    const r = JSON.parse(JSON.stringify(receipt));
    r.psf_field.not_measured = true;             // self-flagged unmeasured
    r.lens_distortion_measured.not_measured = true;
    const fams = measuredFamilies(r);
    expect(fams).not.toContain('psf_field');
    expect(fams).not.toContain('lens_distortion_measured');
    expect(fams).toContain('wcs'); // untouched families stay
  });

  it('honest-or-absent: absent receipt fields are omitted, never fabricated', () => {
    const bare = { version: '2.4.0', wcs: { CTYPE1: 'RA---TAN' }, solution: { ra_hours: 5.5 } };
    const bareSha = receiptSha256(Buffer.from(JSON.stringify(bare)));
    const def = buildManifestDefinition(bare, { assetTitle: 'bare', receiptSha256: bareSha });
    const rec = def.assertions.find((a) => a.label === 'org.skycruncher.receipt').data;
    // present field kept
    expect(rec.solve.ra_hours).toBe(5.5);
    // absent solve fields omitted (not null, not 0)
    expect('dec_degrees' in rec.solve).toBe(false);
    expect('confidence' in rec.solve).toBe(false);
    // no deep_confirmed in receipt ⇒ provenance flag absent, not fabricated true/false
    expect('deep_confirmed' in rec.provenance).toBe(false);
    expect('bc_rematch_present' in rec.provenance).toBe(false);
    // epistemic.measured reflects only what's really there
    const epi = def.assertions.find((a) => a.label === 'org.skycruncher.epistemic').data;
    expect(epi.measured).toEqual(['wcs']);
    expect(epi.aesthetic).toEqual([]);
  });

  it('render params, when supplied, are typed VERIFIED_PRESERVING under visual', () => {
    const def = buildManifestDefinition(receipt, {
      assetTitle: 'M66', receiptSha256: sha, assetKind: 'render',
      renderParams: { stf_stretch: { midtone: 0.25, shadow: 0.02 } },
    });
    const epi = def.assertions.find((a) => a.label === 'org.skycruncher.epistemic').data;
    expect(epi.asset_kind).toBe('render');
    expect(epi.visual).toEqual([
      { name: 'stf_stretch', epistemic_type: 'VERIFIED_PRESERVING', params: { midtone: 0.25, shadow: 0.02 } },
    ]);
  });

  it('rejects a missing/invalid receipt_sha256 (the binding is mandatory)', () => {
    expect(() => buildManifestDefinition(receipt, { assetTitle: 'x' })).toThrow(/receiptSha256/);
    expect(() => buildManifestDefinition(receipt, { assetTitle: 'x', receiptSha256: 'nothex' })).toThrow();
  });
});
