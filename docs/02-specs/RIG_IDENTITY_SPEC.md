# RIG IDENTITY SPEC (CANONICAL — owner-ruled 2026-07-10 late; implementation = the per-serial wave, post-Monday)

Successor to MODEL_ONLY workbench keying. Owner ruling: hold THREE identification values per rig,
match against ANY, and detect busts BETWEEN them.

## 1. The three identity legs
1. **body_serial** — camera body serial (EXIF MakerNote ladder, surfacing mission in flight 2026-07-10;
   placeholder/absent → null-honest). Present ~100% on Canon raws, 0% on FITS (measured,
   test_results/serial_coverage/).
2. **lens_serial** — lens serial with MANDATORY placeholder rejection (19/23 measured lens serials are
   "0000000000" manual-glass placeholders — all-zero/empty patterns = null, never a key).
3. **rig_hash** — a generated identity minted at FIRST SUCCESSFUL PROFILING (first image a rig passes
   through the workbench deposit path). Stable thereafter; the rig's durable name in our data plane.
   Owner: "once they pass at least one image through, that rig has a hash we can validate against."

## 2. Matching & bust detection (owner intent)
- IDENTIFICATION: match on ANY leg (serials when present; rig_hash always after first profiling; FITS
  no-serial rigs live on rig_hash + user-assigned rig name via the workbench).
- **BUST DETECTION = cross-leg consistency**: when legs disagree — serials say rig A but measured
  behavior matches rig B's stored profile (or matches nothing) — flag honestly, never silently merge.
  Bust taxonomy: lens swapped between bodies · serial collision/reuse · mislabeled or relabeled data ·
  profile drift (real physical change: drop/repair/re-shim — itself scientifically interesting).
- Owner framing: "not perfect, but we can tool up something to validate our hardware profiles against
  the database, so we can positively identify the specific setup."

## 3. Measured fingerprints backing the rig_hash (validation substrate)
The rig_hash is an assigned ID; POSITIVE identification comes from measured-profile similarity checks
against the database. Candidate fingerprints, strongest-first, honest about maturity:
- **Hot/defect-pixel constellation** (body-unique, stable, ALREADY MEASURED per-frame by
  hot_pixel_map) — the near-term workhorse: a sparse coordinate set behaves like a sensor biometric.
- **Measured distortion residual field** (lens-copy-unique at fine scale; per-capture BC/SIP already
  measured) — separates copies of the same lens model.
- **OB bias structure** (per-frame dark anchor, post-rawler) — body-level signature.
- **PRNU** (photo-response non-uniformity — the forensic-grade sensor fingerprint) — FUTURE: needs
  flats/stacks; slots into the calibration-frame program.
- Dust-mote map — weak/transient; corroborating only.
Validator tool (post-Monday wave): given a frame + claimed identity, score measured fingerprints
against stored profiles → CONSISTENT / BUST(type) / INSUFFICIENT-DATA (honest three-state, never a
silent guess).

## 4. Privacy boundary (binds to DATA_DISTRIBUTION_PLAN §4)
Raw serials are device identifiers: LOCAL-ONLY keys. Anything crossing to community/production buckets
carries a **salted/HMAC rig_hash**, never raw serials. Fingerprint data shared only in derived,
non-invertible form (e.g. similarity scores or hashed constellations), decided per-artifact at the
production-plane design.

## 5. Sequencing
1. In flight now: body/lens serial surfacing (session-local).
2. Per-serial wave (post-Monday): workbench keying ladder {any-leg match} + rig_hash minting at first
   deposit + migration of existing MODEL_ONLY deposits.
3. Validator tool + hot-pixel-constellation fingerprint scoring.
4. PRNU joins when the calibration-frame program (darks/flats intake) supplies data.

## Related
- [OPTICAL_WORKBENCH_SCHEMA](../OPTICAL_WORKBENCH_SCHEMA.md) — the predecessor MODEL_ONLY workbench keying this spec supersedes
- [DATA_DISTRIBUTION_PLAN](DATA_DISTRIBUTION_PLAN.md) — the privacy boundary (§4) this spec's rig_hash sharing rule binds to
- [PRIVACY_DESIGN](../01-canonical/PRIVACY_DESIGN.md) — the local-only-key vs salted-hash rule this spec's privacy boundary extends
- [DARK_CALIBRATION_POLICY](../DARK_CALIBRATION_POLICY.md) — the calibration-frame program (darks/flats) that PRNU fingerprinting depends on
