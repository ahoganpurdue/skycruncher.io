# rawler_probe — decoder-cutover #14 pre-stage

Committed replacement for the **throwaway overnight row-91 rawler spike** (nothing
was tracked). Decodes a Canon CR2 with **rawler 0.7.2** and reports the full raw-CFA
contract the cutover will consume, so the decode is reproducible and checkable
bit-for-bit. **Nothing here is imported by `src/`** — the live decode path stays
byte-identical by construction.

## Build (out-of-repo target dir — REQUIRED)

`CARGO_TARGET_DIR` **must** point outside the repo tree (vite watcher + git hygiene).
Only source is committed; `target/`, `*.wasm`, and build output are gitignored.

```sh
export CARGO_TARGET_DIR="$TEMP/rawler_probe_target"   # any path OUTSIDE the repo

# Native harness (ground-truth arbiter):
cargo build --release --bin probe
"$CARGO_TARGET_DIR/release/probe" "<path/to/IMG_1653.CR2>"           # JSON report + GT compare
"$CARGO_TARGET_DIR/release/probe" "<file.CR2>" --golden "<outdir>"   # + golden vectors

# wasm32 compile proof (the cutover target):
rustup target add wasm32-unknown-unknown   # (already installed on this box)
cargo build --release --lib --target wasm32-unknown-unknown
```

## Verified findings (2026-07-10 pre-stage)

### A. Ground-truth reproduction — **MATCH (bit-identical)**
`probe IMG_1653.CR2` reproduces **every** frozen row-91 value
(`tools/rawlab/libraw_cfa_hash.mjs:22-26`):

| field | value |
|---|---|
| full dims | `5344 x 3516` (cpp=1, bps=16) |
| CFA | `GBRG` (2x2) |
| black levels | `[2046, 2046, 2049, 2049]` |
| white level | `15094` |
| active area | `5202 x 3465` @ (142, 51) |
| crop area | `5184 x 3456` @ (152, 56) |
| stats | min `1` · max `15935` · mean `2618.13` |
| **full-frame CFA LE-u16 md5** | **`968381f814547668c6a85b75f31038f2`** ✓ |

Decode entry = `RawSource::new_from_slice(&[u8])` (buffer-based, **no mmap / no fs**),
so the native and wasm32 decode paths are the same function.

### B. wasm32 compile — the "sole fix" is **necessary AND sufficient**
- **WITH** `uuid = { features = ["js"] }`: `cargo build --lib --target wasm32-unknown-unknown` **succeeds**.
- **WITHOUT** it: **fails** — `error: to use uuid on wasm32-unknown-unknown, specify a
  source of randomness using one of the js, rng-getrandom, or rng-rand features`
  (rawler → uuid v4 → getrandom). uuid's `js` feature pulls `getrandom/js` → `js-sys`/`wasm-bindgen`.
- Two other candidate blockers are **non-issues**: `memmap2` compiles via its
  `stub.rs` (non-unix/windows) and the `new_from_slice` path never mmaps;
  `rayon` compiles clean.

### B. rayon runtime on wasm32 — **RUNS, auto single-threaded (no pinning needed)**
Source-verified against `rayon-core 1.13.0` (`src/registry.rs::default_global_registry`
+ `src/lib.rs` "Global fallback when threading is unsupported"): when thread spawn
returns `Unsupported` (exactly the `wasm32-unknown-unknown` case), rayon-core builds a
`num_threads(1).use_current_thread()` fallback pool automatically. Blocking parallel
iterators (`par_iter` / `par_chunks_mut` — **all** rawler uses on the decode path)
execute **sequentially on the calling thread**; they do **not** panic. Only
fire-and-forget `spawn()` / `broadcast_spawn` can be starved, and rawler's decode uses
none. **The cutover does NOT need `wasm-bindgen-rayon` and does NOT need to manually
pin single-threaded.** Sequential execution over disjoint chunks is deterministic →
strengthens the byte-identical CPU/GPU story. (IMG_1653 is old-CR2/LJPEG; the LJPEG
decompressor is single-threaded anyway — rayon is only on CRX/radc + the sRAW
`interpolate_yuv` YUV path.)

## Dep versions (from Cargo.lock, committed)
rawler `0.7.2` · uuid `1.23.4` · getrandom `0.4.3` · rayon `1.12.0` / rayon-core `1.13.0` · memmap2 `0.9.11`.
