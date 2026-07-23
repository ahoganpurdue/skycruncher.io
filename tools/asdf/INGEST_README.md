# ASDF Ingestor — read our own exports AND NASA Roman L2 (tools/asdf + tools/roman)

An incubator-lane (LAW 4) reader that ingests ASDF files — both SkyCruncher's own
`export/asdf_writer.ts` output and **Roman Space Telescope** WFI L2 products
(ASDF-native) — and emits a normalized *ingest manifest*: the stable seam a
future engine `m1` lane would consume to bring an external ASDF into the pipeline.

Nothing here touches `src/`. The byte production for our OWN exports still lives
solely in the shared writer; this is the read side.

## Pieces

| File | Role |
|---|---|
| `tools/asdf/asdf_reader.mjs` | Dependency-free Node ASDF reader: `#ASDF` header + a hand-rolled YAML-1.1 **subset** parser + binary blocks. Returns `{tree, blocks[], readBlock(i), readNdarray(node)}`. |
| `tools/asdf/asdf_reader.test.mjs` | Round-trip gate on our own writer (linear / SIP / TPS) — part of the sacred `npx vitest run`. |
| `tools/roman/make_fixture.py` | Builds a small **schema-valid** Roman WFI L2 ASDF (isolated WSL venv), or an honest Roman-shaped fallback. |
| `tools/roman/eval_gwcs.py` | Python bridge (asdf+gwcs, WSL): evaluates pixel→sky at center + 4 corners. The `.mjs` does NOT re-implement the gwcs stack. |
| `tools/roman/ingest_roman.mjs` | Dialect auto-detect + normalized manifest builder (ROMAN_L2 / SKYCRUNCHER). |
| `tools/roman/ingest.test.mjs` | Deterministic ingest gate (SKYCRUNCHER dialect, bridge disabled) — part of `npx vitest run`. |
| `tools/asdf/export_m66.asdfspec.ts` + `asdf_harness.config.ts` | Real-wizard M66 → ASDF fixture + real-receipt round-trip (needs wasm + local assets; OUT of the sacred gate). |

## Supported YAML subset (and what FAILS HONESTLY)

The parser targets exactly the constructs our writer and `roman_datamodels`
(via the `asdf` library's PyYAML block-style dump) emit. It **never guesses** —
anything outside the subset throws an `AsdfError` naming the construct + 1-based
line.

**Supported**
- `#ASDF` / `#ASDF_STANDARD` comment lines, `%YAML` / `%TAG` directives, the
  single `--- [!tag]` document start
- block mappings (`key: value`, 2-space indent), bare or quoted keys
- block sequences (`- item`, incl. compact-mapping items `- key: v` and tagged
  items `- !tag`)
- flow sequences `[a, b, [c, d]]` and flow mappings `{k: v}` — including
  **multi-line flow** (asdf line-wraps long flows across indented continuation
  lines; our own writer keeps them single-line)
- tags: short `!core/ndarray-1.1.0` and verbose `!<tag:stsci.edu:gwcs/…>`, on
  mappings, sequences AND scalars (`!unit/unit-1.0.0 pixel`, `!time/time-1.4.0 …`)
- YAML anchors `&id` / aliases `*id`
- scalars: `null`/`~`, bools, ints, floats (incl. the `1.0e-8` exponent case),
  `.inf`/`.nan`, double- and single-quoted and plain strings
- Roman placeholder sentinels (`'?'`, `-999999`) → normalized to **absent**
- binary blocks: `\xd3BLK` magic, 48-byte big-endian header, a deterministic
  sequential header walk (block-index tolerant), ndarray `source`→block or inline

**Unsupported (throws, never silently mis-parsed)**
- block scalars (`|`, `>`), multi-line plain scalars
- complex/explicit keys (`?`), merge keys (`<<`), YAML sets
- multiple documents in the tree region (only the first `---`)
- **compressed** binary blocks — a compressed block is *flagged* honestly
  (`compression: 'lz4'`, `decodable: false`); `readBlock` throws rather than
  return undecoded bytes. Real Roman L2 products are lz4-compressed; the fixture
  defaults to uncompressed so the pixel round-trip is exercised. A JS lz4 decode
  is a v2 hook (the reader stays dependency-free today).

## Dialects & the manifest

`ingestAsdf(file)` auto-detects:
- **ROMAN_L2** — `tree.roman` tagged `wfi_image-*` with a `meta` subtree.
- **SKYCRUNCHER** — a versioned receipt (`tree.version` + `wcs_fits`/`solution`).
- **UNKNOWN** — surfaces top-level keys + any discovered gwcs (honest, no guess).

The manifest carries `source_dialect`, `asdf` (standard version + block count),
`meta`, `exposure`, `data {shape,dtype,byteorder,compression,decodable}`,
`wcs_center`, `corners`, and a `wcs` block with the **transform inventory**
(read from the JS tree — dialect-independent) + the **evaluation** (via the
Python bridge). Honest-or-absent throughout: a missing field is omitted, an
un-evaluable WCS is `{evaluated:false, error}`, never a fabricated number.

## Python-bridge dependency (WSL isolated venv)

WCS evaluation and the Roman fixture need Python libs that must NOT disturb the
system env the ASDF **conformance** gate depends on (`asdf 5.3.1 / astropy 6.0.0
/ gwcs 0.21.0`). So they live in an **isolated venv**:

```
python3 -m venv --without-pip ~/roman_venv          # ensurepip apt pkg absent → bootstrap:
curl -sS https://bootstrap.pypa.io/get-pip.py | ~/roman_venv/bin/python
~/roman_venv/bin/python -m pip install roman_datamodels     # pulls asdf/gwcs/astropy/rad
```
`roman_datamodels 1.0.0` (asdf 5.3.1, gwcs 1.0.3) installs cleanly this way —
the schema-valid fixture path was used, not the fallback. The `.mjs` shells to
`~/roman_venv/bin/python` (override via `ROMAN_VENV_PY`). NOTE: `/tmp` is wiped
on WSL restart — keep the venv in `$HOME`.

## Reproduce the cross-dialect proof

```
# Roman L2 fixture (schema-valid) → test_results/roman/roman_l2_fixture.asdf
~/roman_venv/bin/python tools/roman/make_fixture.py --shape 16

# Our own M66 export (real wizard) → test_results/m66_export.asdf
npx vitest run -c tools/asdf/asdf_harness.config.ts

# Same ingest driver over both:
node tools/roman/ingest_roman.mjs test_results/roman/roman_l2_fixture.asdf
node tools/roman/ingest_roman.mjs test_results/m66_export.asdf
```

## Roadmap (honest, not built)

- **JWST embedded-ASDF extraction from FITS.** JWST products carry the ASDF tree
  inside a FITS `ASDF` BINTABLE extension (the `fits_embed` convention), not as a
  standalone ASDF. A v2 reader would locate that extension's byte span and hand
  it to this same subset parser — the tree grammar is identical; only the framing
  (FITS block boundaries + the embedded-block offsets) differs.
- **Engine m1 wiring.** The manifest is deliberately the seam: an `m1` ingest
  lane would map `wcs_center`/`corners`/`data.shape` into the pipeline's hard
  metadata + an initial WCS prior, letting an external Roman/JWST/SkyCruncher
  frame enter measurement without a re-solve. Compressed-block decode + a native
  (non-bridged) gwcs evaluator would land here so the lane is Python-free.
- **C2PA validate-and-sign ledger.** Ingest is the natural place to *verify* an
  incoming file's provenance (is it an unmodified Roman L2? a signed SkyCruncher
  export?) and to record an epistemic-typed (M/V/A) manifest of what was read
  vs. derived — the provenance keystone the beautification/handoff design calls
  for, applied on the READ side.
