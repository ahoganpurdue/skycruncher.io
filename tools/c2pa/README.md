# `tools/c2pa/` — C2PA provenance incubator

Sign SkyCruncher outputs with **C2PA** manifests built **from receipts**, verify them
round-trip, and read provenance off **incoming** assets. This lane is the incubator
(LAW 4) for the artifact specified in `docs/PROVENANCE_HANDOFF_DESIGN.md`: a
signed, portable record that partitions an image into **measured truth**,
**verified-honest processing**, and **frankly-aesthetic manipulation**.

Rides the Content Authenticity Initiative's reference CLI (`c2patool`). Everything
here is **headless** and **DEV-CERT** (see the warning below). Zero `src/` edits.

---

## The in ↔ out flow

```
  INGEST                     SOLVE                 RENDER / EXPORT              VERIFY
  ------                     -----                 ---------------             ------
  inspect_incoming.mjs  →    tools/api/run.mjs  →  manifest_from_receipt.mjs → verify.mjs
  (ABSENT / OURS /           (real wizard          (receipt → C2PA manifest    (valid? tampered?
   FOREIGN / TAMPERED)        pipeline →             definition)                 ours? bound to
                              receipt.json)         sign_render.mjs   (embed)     THIS receipt?)
                                                    sidecar_fits.mjs  (detach)   tamper_check.mjs
                                                                                  (negative control)
```

- **Ingest** — `inspect_incoming.mjs <asset>` reports whether an arriving file
  already carries provenance (ours, foreign, or none). Provenance at intake is a
  **flag, not a gate** (owner directive): `ABSENT` is the normal wild-west case.
- **Solve** — the existing `tools/api/run.mjs <fits>` runs the real calibrated
  pipeline and writes the canonical receipt. (This lane consumes receipts; it
  never solves.)
- **Manifest** — `manifest_from_receipt.mjs <receipt.json>` maps the receipt to a
  C2PA manifest definition (the intellectual core; pure + unit-tested).
- **Sign** — `sign_render.mjs` **embeds** a signed manifest into a raster
  (PNG/JPEG); `sidecar_fits.mjs` writes a **detached** `.c2pa` for FITS/ASDF
  (which cannot carry an embedded manifest).
- **Verify** — `verify.mjs <asset>` gives a pass/fail verdict from C2PA
  `validation_status` and round-trips `receipt_sha256`. `tamper_check.mjs` is the
  reproducible negative control (flip one byte → must fail).

### Quickstart

```bash
node tools/c2pa/fetch_c2patool.mjs                       # provision the CLI (once)

RCPT="test_results/api_runs/<name>.receipt.json"         # from tools/api/run.mjs

# embedded (raster render):
node tools/c2pa/render_starfield.mjs "$RCPT" --out out.png
node tools/c2pa/manifest_from_receipt.mjs "$RCPT" --asset-title obs --out man.json
node tools/c2pa/sign_render.mjs --asset out.png --manifest man.json --out out.signed.png
node tools/c2pa/verify.mjs out.signed.png --receipt "$RCPT"
node tools/c2pa/tamper_check.mjs out.signed.png --receipt "$RCPT"

# detached (FITS/ASDF):
node tools/c2pa/manifest_from_receipt.mjs "$RCPT" --asset-kind science --out sman.json
node tools/c2pa/sidecar_fits.mjs --asset <the.fit> --manifest sman.json
node tools/c2pa/verify.mjs <out-dir>/<the.fit> --receipt "$RCPT"   # sidecar auto-associated
```

---

## Assertion schema (v1)

Standard C2PA carries *that an edit happened*; it has no vocabulary for *the
epistemic status* of the result. We add two custom assertions.

**`org.skycruncher.receipt`** — the solve, cryptographically bound to the exact receipt:

```jsonc
{
  "schema_version": "1.0.0",
  "receipt_sha256": "<sha256 of the receipt JSON bytes>",   // the binding anchor
  "receipt_schema_version": "2.4.0",                        // receipt.version
  "solve": { "ra_hours": …, "dec_degrees": …, "scale_arcsec_px": …,
             "matched": …, "confidence": … },
  "provenance": { "deep_confirmed": true, "bc_rematch_present": true,
                  "bc_rematch_applied": false, "sip_present": true,
                  "tps_present": true, "lens_distortion_measured_present": true }
}
```

**`org.skycruncher.epistemic`** — the Measured / Verified-preserving / Aesthetic
typing seed (`PROVENANCE_HANDOFF_DESIGN.md §2`):

```jsonc
{
  "schema_version": "1.0.0",
  "asset_kind": "render" | "science",
  "measured":  ["wcs","sip","tps","lens_distortion_measured","psf_field",
                "psf_attribution","bc_rematch","deep_confirmed","spcc"],
  "visual":    [],   // VERIFIED_PRESERVING render/pixel ops (empty ⇒ none recorded)
  "aesthetic": []    // ML/aesthetic ops (empty ⇒ none; deterministic core has none)
}
```

Plus the native **`c2pa.actions`** (`c2pa.created`, claim generator
`SkyCruncher/<version>`).

**Honest-or-absent** is enforced in the mapping: a receipt field that is missing,
`null`, or self-flagged `not_measured` is **never** fabricated into an assertion.
A family enters `measured[]` **only** when genuinely present and measured — flip a
family's `not_measured` and it drops out (unit-tested in
`manifest_from_receipt.test.mjs`).

**`receipt_sha256` is the anchor.** The `solve` block is a convenience projection
(C2PA re-serializes f64s, so e.g. `ra_hours` may print with one fewer digit in the
stored manifest). The sha256 binds the *whole* receipt byte-for-byte; that is what
`verify.mjs --receipt` checks.

**Namespace note.** `PROVENANCE_HANDOFF_DESIGN.md` drafts these under
`com.skycruncher.*`; this incubator uses **`org.skycruncher.*`** per its task spec.
Field *vocabulary* is aligned to the draft (MEASURED / VERIFIED_PRESERVING /
AESTHETIC; `receipt_sha256` ≙ the design's `seal_hash` intent). The prefix must be
**frozen once** (design-doc open-question §8.3) before any production signing.

---

## ⚠ DEV-CERT — not production

Signing uses the CAI's **public test certs** (`es256`, shipped inside the fetched
`bin/c2patool/sample/`). A manifest signed with them is fully valid and parseable,
but its signer is **not on any production C2PA trust list** — it identifies as
`C2PA Test Signing Cert`. Every artifact this lane produces is DEV-CERT on purpose.
`verify.mjs` / `inspect_incoming.mjs` surface a `dev_cert: true` flag so a DEV
signature is never mistaken for a trusted one.

### Production certificate options (build-time decision)

Going to a trusted signature is a **certificate**, not a code, change — the mapping
and manifest structure above are production-ready. Options, roughly in ascending
cost/trust: (1) a **self-hosted CA** whose root is published for opt-in trust —
cheap, but third parties must add the anchor; (2) a **conformant commercial signer**
/ CA already on the C2PA trust list (e.g. via a certificate authority that issues
C2PA-conformant end-entity certs) — verifiable out of the box, recurring cost;
(3) an **HSM / KMS-backed key** (c2patool supports remote/OpenSSL signers) for a
production key that never touches disk. In all three the signing stays
**offline-capable** (no phone-home to produce or verify), consistent with the
local-only posture. Recommendation tracks the design doc: publish `org.skycruncher.*`
as an open schema and pursue trust-list conformance so the epistemic vocabulary can
propagate. Until that decision lands, **do not ship** signatures from this lane as
production provenance.

---

## The vision — a portable ledger that travels with the image

C2PA turns each export into a signed **ledger** the artifact carries wherever it
goes — a durable civic record of what was *measured* versus what was *indulged*.
That is exactly the leverage `SURFACE_CONVERGENCE.md` needs: one core, one receipt,
capability-tiered shells (overnight rig, browser demo, desktop instrument) all
emitting the *same* honest receipt — so the manifest is the one artifact that keeps
the science attached to the pixels across every surface and every downstream tool.
It realizes the responsible-editing thesis of `PROVENANCE_HANDOFF_DESIGN.md` (§7,
the "wine-at-dinner" contract): we do not forbid the glass — we pour it at the
table, write down exactly how much, sign the note, and hand it over so the record of
what was real and what was indulgence goes *with* the image. The verifier (design
§6) is where the ledger gains teeth: because SkyCruncher can read C2PA on the way
back in, it can quantify — with forced photometry against the sealed measured layer
— how far any later edit departed from what was actually captured. That is the
capability no beautification tool offers, and the mechanism by which honest
provenance becomes the field's shared language rather than one vendor's feature.

---

## Files

| File | Role |
|---|---|
| `fetch_c2patool.mjs` | Provision the c2patool CLI + DEV certs into gitignored `bin/` |
| `lib/env.mjs` | Resolve the tool binary + DEV cert paths (single source of layout) |
| `manifest_from_receipt.mjs` | **Core.** Receipt → C2PA manifest definition (pure, tested) |
| `manifest_from_receipt.test.mjs` | 8 unit tests over a committed minimal M66 fixture |
| `fixtures/m66_min.receipt.json` | Self-contained fixture (real M66 sacred values) |
| `render_starfield.mjs` | Render a receipt's measured `matched_stars` to a PNG |
| `sign_render.mjs` | Embed a signed manifest into a raster (DEV-CERT) |
| `sidecar_fits.mjs` | Detached `.c2pa` sidecar for FITS/ASDF (asset byte-unchanged) |
| `verify.mjs` | Verdict from `validation_status` + `receipt_sha256` round-trip |
| `tamper_check.mjs` | Reproducible negative control (1 IDAT byte → must fail) |
| `inspect_incoming.mjs` | Ingest seam: ABSENT / OURS-valid / TAMPERED / FOREIGN |

`bin/` (the binary + its DEV certs) is gitignored; restore with `fetch_c2patool.mjs`.
Signed/verified artifacts land under `test_results/c2pa/` (also gitignored).

## Honest gaps

- **DEV-CERT only** — no production trust (see above); the biggest gap to a real product.
- **Not wired into the app** — incubator per LAW 4. Porting behind a module seam
  (`stages/c2pa_manifest.ts`, `save_packet.ts`) is future work per `PROVENANCE_HANDOFF_DESIGN.md §5`.
- **`epistemic.visual` / `aesthetic` are stubs** — populated only when a V/A pixel
  op supplies its params + preservation proof; the deterministic core emits none,
  so they are honestly `[]`. The design doc's per-op `preservation_proof` block is
  not yet produced here.
- **Confirmation gate is N=1** (`deep_confirmed`, SeeStar-only) — recorded honestly
  as provenance, not asserted as a trusted science product.
- **c2patool pinned to v0.9.12** — a deliberate pin; the newer c2pa-rs monorepo CLI
  has a shifted interface. Bump deliberately.
