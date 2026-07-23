/**
 * SERIAL-AWARE SIGNATURE (M6) — the per-copy (Optical Workbench) keying future.
 *
 * Owner ruling: serial-first identity, model = fallback tier. The matcher takes
 * `{ make?, model, serial? }` from day one; `serialResolve` is stubbed OFF, so
 * behaviour is byte-identical to the model-tier lookup until per-copy deposits
 * graduate. These tests pin: (a) absent serial ⇒ identical to matchByBody, (b) a
 * supplied serial + resolver ⇒ per-copy wins over the model tier, (c) a resolver
 * that misses ⇒ honest fall-through to the model tier.
 */
import { describe, it, expect } from 'vitest';
import { matchIdentifier, type BodyRegistryEntry } from '../pipeline/m2_hardware/identifier_matcher';
import { findSensorByCamera, SENSOR_DB } from '../pipeline/m2_hardware/sensor_db';

const registry: BodyRegistryEntry<string>[] = Object.entries(SENSOR_DB).map(
  ([key, profile]) => ({ entry: key, bodies: profile.camera_bodies }),
);

describe('matchIdentifier — serial-aware surface (absent-tolerant, additive)', () => {
  it('with NO serial, resolves byte-identically to the model-tier findSensorByCamera', () => {
    for (const model of ['Canon EOS 5D Mark II', 'ZWO Seestar S50', 'Canon EOS R6', 'Nope 999']) {
      const viaModel = findSensorByCamera(model);
      const viaSig = matchIdentifier({ model }, registry);
      // matchIdentifier returns the DB key; map back to the profile for parity.
      const viaSigProfile = viaSig ? SENSOR_DB[viaSig] : null;
      expect(viaSigProfile).toBe(viaModel);
    }
  });

  it('a supplied serial + resolver takes tier-0 precedence over the model tier', () => {
    // A measured per-copy entry must win even when the model would resolve.
    const perCopy = matchIdentifier(
      { model: 'Canon EOS 5D Mark II', serial: 'SN-PERCOPY-42' },
      registry,
      { serialResolve: (s) => (s === 'SN-PERCOPY-42' ? 'PER_COPY_5D2' : null) },
    );
    expect(perCopy).toBe('PER_COPY_5D2'); // NOT the model-tier IMX/CANON key
  });

  it('a resolver that misses falls through to the model tier (honest)', () => {
    const modelTier = matchIdentifier(
      { model: 'Canon EOS 5D Mark II', serial: 'UNKNOWN-SN' },
      registry,
      { serialResolve: () => null },
    );
    expect(modelTier ? SENSOR_DB[modelTier].pixel_size_um : null).toBe(6.41);
  });

  it('a serial with no resolver is ignored (stub OFF today)', () => {
    const r = matchIdentifier({ model: 'ZWO Seestar S50', serial: 'SN-1' }, registry);
    expect(r ? SENSOR_DB[r].sensor_model : null).toContain('IMX462');
  });
});
