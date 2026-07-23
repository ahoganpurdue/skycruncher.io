<!-- REFERENCE · category: reference · tags: Infra · perf measurements; revise on hot-path changes -->
# Performance Notes — DSLR expedition, revised targets, the serialization wall

This is a running record of where the pipeline actually spends wall-clock time, and what to do about it — not a design doc, a measurement log. It exists because "feels slow" is not actionable; every claim below is tagged **[M]**easured or **[P]**redicted so a reader can tell which is which.

**Living doc, revised as hot paths change.** Companion: `docs/archive/SEESTAR_ROBUSTNESS.md` §5 (original FITS profile), ROADMAP GPU strategy.

## 1. The serialization wall — where data movement actually costs us

An audit of every major copy/encode boundary in the hot paths, to find out whether data marshaling (as opposed to actual computation) is a meaningful cost anywhere in the pipeline.

| Boundary | Size (typical) | Cost | Verdict |
|---|---|---|---|
| FITS big-endian decode → Float32 RGB (JS byte loop) | 47 MB → 100 MB | ~1 s **[M]** | Acceptable; 5-10× headroom via wider reads if ever needed |
| **CR2 mem_image u16 → Float32 RGB → Arrow → IndexedDB cache** | 108 MB u16 → **216 MB f32, then cloned again for cache** | step-2 dominator **[P]**, structured-clone + disk write on main thread | **THE wall for DSLR.** Actions D1–D3 below |
| `extract_blobs` Float32 → WASM heap | 33 MB (8 MP) copy per extraction | ~10s of ms **[P]** | Fine; single copy, curated-star forwarding already removed the duplicate extraction |
| `verify_astrometric_lock` per-candidate array copies | ~11 KB × ≤200 candidates | trivial **[M]** (solve 1.1 s total) | Non-issue |
| Preview canvas → `toDataURL('jpeg')` base64 string | full-res canvas → MB-scale string, main-thread encode | ~100-400 ms at 8 MP **[P]**; catastrophic at ≥100 MP | Browser lane already excludes monsters; add preview-dim cap (D4) |
| Atlas sector `JSON.parse` | 9 MB/sector | 100-300 ms/sector **[M-ish]** | Known; Arrow sectors planned (DATA_PLATFORM step 2). Hinted solves touch 1-2 sectors — not currently killing us |
| Event bus | in-memory refs, ring 2000 | ~0 | Non-issue (deliberate design) |
| JSON receipt export (stripped replacer) | 717 KB **[M]** | trivial | Non-issue |
| Manifest/telemetry logging | strings | trivial | Non-issue |

**Verdict on "are we passing the wall meaningfully":** on the SeeStar path, **no** — total compute ~4.5 s **[M]** with no single serialization step over ~1 s. On the DSLR path, **yes, once** — the u16→f32→Arrow→IndexedDB quadruple-handling of an 18 MP frame is the projected step-2 dominator and is pure data plumbing, not science. It's also *deferrable* plumbing (cache and Arrow are conveniences, not solve requirements).

## 2. Expedite-DSLR actions (formal list, in leverage order)

The concrete fixes that follow from the audit above, ranked by how much they actually move the DSLR-path number.

| # | Action | Effect | Phase |
|---|---|---|---|
| D1 | **Cache the u16 mem_image, not the f32 expansion** — convert to Float32 lazily per consumer | halves cache write + halves resident set (216→108 MB) | B |
| D2 | **Skip IndexedDB persist above a size threshold** (or make persist async-idle) — a solve session doesn't need durable pixel cache | removes the structured-clone + disk write from the critical path | B |
| D3 | **Defer the Arrow copy until export/API actually needs it** (today it's built during ingest) | removes a full-frame copy from step 2 | B |
| D4 | **Preview-dimension cap** (~4K long edge) before canvas/`toDataURL`; STF math already samples, only the encode needs capping | bounds preview cost for any input size | U-polish |
| D5 | Blind-solve center pruning with the EXIF scale prior (63.35″/px known ⇒ FOV known ⇒ skip centers whose bright-star density can't match) | attacks the ~165-center × per-center cost wall | B |
| D6 | Worker offload (existing plan) — moves all of the above off the main thread; perceived speed | D |
| D7 | Rust spherical star-cap + observer plumbing (proposal ready, pending review) | unlocks the ultra-wide strategy at bounded cost | B |

## 3. Revised targets (supersedes SEESTAR_ROBUSTNESS §5 table where they differ)

| Path | Today | Target (browser) | Target (native, Phase D) |
|---|---|---|---|
| Hinted SeeStar FITS, upload→solved | **4.5 s [M, 2026-07-05]** — predates 5 default-on post-solve stages (psf_field/psf_attribution/bc_measure/bc_rematch/forced_confirm); current total UNMEASURED, likely higher — re-measure before quoting | hold ≤5 s | 0.3–0.6 s |
| Hinted Siril float FITS (any drizzle) | ~4-6 s **[M-ish]** (headless corpus 1-2.5 s solve-only) | ≤6 s | ≤1 s |
| CR2 step 1-2 (decode+ingest) | unmeasured; first run in flight | **≤8 s** post-D1-D3 | ≤2 s |
| CR2 steps 3-4 (detect + EXIF lock) | unmeasured | ≤5 s + ≤1 s | ≤1 s total |
| CR2 step 5 blind (ultra-wide, v1) | frontier | **≤120 s honest v1**, ≤30 s after D5/D7 | ≤10 s; index era: ≤3 s |
| Corpus sweep per file (headless) | 0.8–2.5 s small, 10.6 s @170 MP, 26.8 s @374 MP streamed **[M]** | n/a | native runner later |
| Monsters ≥2 GB | headless only, streamed **[M]** | not supported in browser | in-scope |

**Standing measurement discipline:** every E2E scenario already records per-step wall ms in `summary.json`; when a target above is violated by a run, that's a regression finding, not a shrug.

## 4. D5 outcome + the ultra-wide physics finding

**D5 measured:** 169 → 27 centers at quarter-FOV separation; full blind sweep completes in ~85 s **[M]** (previously exhausted 90 s at ~a third of coverage). Honest verify rejections at 3–9% confidence — no false locks.

**Why it still didn't solve — the projection, not the budget.** Quad hashing assumes a similarity transform (constant scale). Gnomonic scale grows $\sec^2(\theta)$ off-axis: +7% at 15°, +33% at 30°, **~3× at 55°** (the corner of a 110°-diagonal 14 mm frame). Full-frame quads mix center and edge stars and fit garbage intermediate scales — the measured candidate smear was 37–195″/px around a 63.4 truth, with near-misses at 40–44% vs the 37.5% scale gate. No budget fixes that; it's geometry.

**Fix (implemented): central-patch matching.** Above 30° FOV diagonal, quad star sets (det + catalog), the per-center catalog fetch (was 137° = whole sky per hypothesis), and the verify anchor are all restricted to a **6°-radius** central patch. (The radius was later tightened from an initial 15°: the binding error above 30° FOV is not gnomonic scale but **quad-code** error — differential lens distortion pushes codes 3–6% off at 15° while hash bins are only ~1% wide, so true quads hash into buckets the code walk never visits, leaving the best candidate at only +0.8σ with truth never in the pool. 6° keeps codes inside bin width; live in `SOLVER_WIDE_PATCH_RADIUS_DEG`, `constants/pipeline_config.ts`.) Center-pruning separation is capped at the patch radius so every true center overlaps a hypothesis patch. Verification keeps the full gnomonic model, so a central lock generalizes. This also cuts per-center cost (smaller fetch/projection/verify), partially paying for the denser center grid.

## 5. Desktop production build — first artifacts

`npm run tauri:build` completed clean (6 m 41 s release compile): **`SkyCruncher_0.1.0_x64-setup.exe` (NSIS) + `SkyCruncher_0.1.0_x64_en-US.msi`** in `target/release/bundle/`. Untested as installers — ticketed for a user-side smoke install.

## Related
- [SEESTAR_ROBUSTNESS.md](../archive/SEESTAR_ROBUSTNESS.md) — companion doc for the original FITS perf profile cited in this doc's header
- [ROADMAP.md](../ROADMAP.md) — GPU rendering strategy referenced in this doc's header
- [DATA_PLATFORM.md](../DATA_PLATFORM.md) — Arrow-sectors plan referenced for the atlas `JSON.parse` cost (§1)
- [WEBGPU_RENDER_PLAN.md](../02-specs/WEBGPU_RENDER_PLAN.md) — GPU rendering plan behind the worker-offload action (D6)
- [DATA_PLANE_PLAN.md](../02-specs/DATA_PLANE_PLAN.md) — Arrow columnar spine plan behind deferring the Arrow copy (D3)
