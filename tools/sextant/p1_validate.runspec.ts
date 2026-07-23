// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/p1_validate.runspec.ts — P1 kernel driven by the .mjs CLI
// ═══════════════════════════════════════════════════════════════════════════
//
// Reads a banked solve receipt (e2e summary.json or a full package receipt), extracts
// the solved WCS center + claimed GPS + observation JD, runs the P1 VALIDATION SEXTANT
// composition, and writes the full P1Result JSON. Env-driven (invoked via vitest by
// p1_validate.mjs so the engine TS resolves). Collected by NO standing gate.
//
// TIME TRUST (honest-or-absent): the e2e receipt does not carry an explicit ingest
// unset-clock verdict, so this kernel NEVER infers trust. `SEXTANT_TRUSTED=1` means the
// caller asserts the observation clock is trusted (echoing the ingest forensics); absent,
// the clock is treated as UNTRUSTED and P1 refuses. The verdict records which.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateClaimedLocation, type SolvedWcs, type ClaimedLocation, type TimeContext } from './lib/p1_sextant';

const RECEIPT = process.env.SEXTANT_RECEIPT || '';
const OUT = process.env.SEXTANT_OUT || '';
const TRUSTED = process.env.SEXTANT_TRUSTED === '1';

/** Pull the solved WCS + claimed GPS + JD from either receipt shape. */
function extract(receipt: any): { wcs: SolvedWcs; claimed: ClaimedLocation | null; jd: number; label: string } {
  const fs2 = receipt.finalSession || {};
  const sol = fs2.solution || receipt.solvedSolution || receipt.solution || {};
  const meta = fs2.metadata || receipt.metadata || {};
  const raHours = sol.ra_hours ?? (typeof sol.ra === 'number' ? sol.ra / 15 : undefined);
  const decDeg = sol.dec_degrees ?? sol.dec;
  if (typeof raHours !== 'number' || typeof decDeg !== 'number') {
    throw new Error('receipt carries no solved RA/Dec — nothing to validate');
  }
  const wcs: SolvedWcs = { raHours, decDeg, rollDeg: sol.rotation };
  const jd = fs2.computed_jd ?? receipt.computed_jd;
  if (typeof jd !== 'number') throw new Error('receipt carries no computed_jd — cannot anchor the alt-az frame');

  const src = meta.gps_source ?? null;
  const lat = meta.gps_lat, lon = meta.gps_lon;
  const claimed: ClaimedLocation | null =
    typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
      ? { latDeg: lat, lonDeg: lon, source: src }
      : null;
  return { wcs, claimed, jd, label: receipt.scenario || 'frame' };
}

describe('sextant P1 validate — banked receipt', () => {
  it('runs the P1 composition and writes the verdict', () => {
    if (!RECEIPT || !fs.existsSync(RECEIPT)) {
      throw new Error(`SEXTANT_RECEIPT not found: ${RECEIPT}`);
    }
    const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
    const { wcs, claimed, jd, label } = extract(receipt);

    const time: TimeContext = {
      jd,
      timestampTrusted: TRUSTED,
      // time σ is unknown for these frames → longitude σ stays NOT_MEASURED unless a
      // caller supplies one; we leave it absent (honest) here.
    };

    const result = validateClaimedLocation(wcs, claimed, time);

    const envelope = {
      frame: label,
      receipt: RECEIPT,
      timestamp_trust_source: TRUSTED ? 'caller_asserted' : 'untrusted_default',
      inputs: {
        wcs_ra_hours: wcs.raHours,
        wcs_dec_deg: wcs.decDeg,
        wcs_roll_deg: wcs.rollDeg ?? null,
        jd,
        claimed_gps: claimed,
      },
      p1: result,
    };

    if (OUT) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(envelope, null, 2));
    }
    // narrative to stdout (the .mjs filters these)
    console.log(`[p1] frame=${label} status=${result.status} predicate=${result.predicate ?? '-'}`);
    if (result.status === 'VALIDATED') {
      console.log(`[p1] alt=${result.boresight_altaz.value!.altitudeDeg.toFixed(3)}° az=${result.boresight_altaz.value!.azimuthDeg.toFixed(3)}° airmass=${result.airmass.value!.toFixed(3)} refraction=${result.refraction_arcsec.value!.toFixed(1)}″ zdist=${result.consistency.boresight_to_zenith_deg.value!.toFixed(3)}°`);
    }
    console.log(`[p1] attestation: ${result.attestation}`);

    // sanity: the kernel produced a well-formed verdict
    expect(['VALIDATED', 'REFUTED', 'REFUSED']).toContain(result.status);
    expect(result.ledger).toBe('COORDINATE');
  });
});
