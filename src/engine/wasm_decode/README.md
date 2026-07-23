# wasm_decode — rawler CFA decode rail (decoder-cutover #14, parallel rail)

Flag-selected SECOND decode arm for the m1 ingestion seam. DEFAULT OFF: the live
path stays libraw-wasm (byte-identical, both pinned reference solves) until the
cutover session flips `VITE_DECODER_RAWLER`. Promoted from the bit-verified
pre-stage probe `tools/rawlab/rawler_probe` (see
`test_results/decoder_prestage/PRESTAGE_REPORT.md`).

## What it exposes

`decode_raw(bytes) -> DecodedRaw` — ONE decode per instance, buffer-based
(`RawSource::new_from_slice`, no fs/mmap). Accessors:

| accessor | contract |
|---|---|
| `meta_json()` | dims/CFA/blacks/white/WB(NaN→null)/active/crop/OB rects JSON |
| `cfa_full()` | FULL-frame u16 mosaic incl. OB borders (LAW 7 `rawler_cfa`) |
| `rgb16_active()` | integer-bilinear demosaic of the ACTIVE area, RGB16 interleaved, raw-ADU domain |
| `demosaic_luma_full_le()` | golden-vector arm: full-frame L=R+G+B u32 LE |
| `cfa_full_le()` | golden-vector arm: full-frame mosaic u16 LE |
| `ob_pixels(i)` / `ob_area_count()` | optical-black harvest (DARK_CALIBRATION_POLICY §1 Reading B; record-only) |

Golden vectors: `test_results/decoder_prestage/golden/IMG_1653.CR2.golden_manifest.json`
(committed pointer; `.bin` bytes are local/regenerable).

## Build (required before the flag can turn ON; pkg/ is gitignored like wasm_compute's)

```
cd src/engine/wasm_decode
wasm-pack build --target web
```

Heavy-lane hygiene: point `CARGO_TARGET_DIR` OUTSIDE the repo before building
(box-load + watcher rules). The crate is its own cargo workspace (empty
`[workspace]` table) — it never touches the root workspace or wasm_compute.

- Browser: loaded on demand by `src/engine/pipeline/m1_ingestion/rawler_decoder.ts`
  via a vite-served dynamic import (dev server; the rail is not bundled into
  production builds while it is an experiment).
- Node (headless lane): same loader reads `pkg/wasm_decode_bg.wasm` from disk and
  boots with `initSync` — the wasm_compute headless pattern.

wasm32 facts settled by the pre-stage: uuid "js" feature is the sole compile fix;
rayon auto-degrades to deterministic single-thread; memmap2 stubs out. LAW 5:
this crate is engine Rust — changes require the wasm-pack rebuild and owner-level
sign-off (the rail itself was owner-directed 2026-07-10).
