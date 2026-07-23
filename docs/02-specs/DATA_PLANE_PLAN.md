# Data-Plane Plan — Arrow / WASM / WebGPU (draft)

This plan proposes one shared Arrow columnar buffer as the data spine across the WASM solver,
the WebGPU render path, and on-disk catalog storage — replacing the JSON-parse/re-marshal cost
paid today at each of those boundaries.

> **STATUS: DRAFT — NOT RATIFIED.** Synthesized from three audits. Every step needs sign-off
> before code. No Rust/gate-touching work has been done. This is a routing + sequencing draft only.
>
> **AUDIT COVERAGE:** all three legs are audit-backed — WASM, WebGPU, and Arrow. Arrow claims are
> file:line-cited MEASURED findings, not WASM/WebGPU intersection inferences.

---

## UNIFYING THESIS

One **Arrow columnar buffer** as the single data spine across all three lanes, replacing the
`JSON.parse -> object soup -> re-marshal` tax paid at every boundary today:

```
  DISK (starplates cells / atlas sectors, Arrow IPC)
    -> zero-copy WASM views (shared linear-memory backing, no Vec copy-out)
      -> direct WebGPU buffer upload (createBuffer from the same ArrayBuffer, no base64 round-trip)
```

**This is not greenfield — Arrow is already LANDED but DORMANT** (recovered Arrow audit, MEASURED):
`apache-arrow` is a live dependency and TWO flag-gated Arrow paths already exist behind default-OFF flags —
a browser atlas-sector seam (`VITE_ATLAS_BINARY`, `atlas_arrow_codec.ts`, landed 2026-07-06) and a native
starplates cell path (`VITE_STARPLATES`, `starplates_provider.ts` + Rust `query_catalog_v2`, landed in the
07-09 merge). Both are inert TODAY (no `.arrow` twins shipped; no built T1 release). See the ARROW LEG section.

The audits independently converged on the SAME natural columns:
- WASM: the solver's SIX parallel `Float64Array`s (anchorsX/Y/B, atlasRa/Dec/Mag) + the 10-col
  `extract_blobs` flat result `[x,y,rawX,rawY,flux,peak,fwhm,circ,theta,snr]*N` are already columnar —
  they are just copied at the boundary (`vector_solver.ts:70/235`, `metrology.ts:70`; `source_extractor.ts:83`). **Cold path since the greenfield cutover** — `vector_solver.ts`'s WASM solver kernels belong to the legacy TS/WASM solver lane retired by the greenfield Rust solver core; this Arrow-spine plan now applies only to the frozen legacy engine.
- WebGPU: `demosaic_pipeline` already exposes a resident `rgbBuffer?:GPUBuffer` (`:15`); an Arrow-backed
  linear buffer is uploadable without a CPU re-pack.

**The spine is an OPTIMIZATION of existing seams, not a rewrite.** Zero-copy IN is already done
(`get_input_buffer_ptr` -> `extract_blobs_shared`, `source_extractor.ts:140-147`). The remaining tax is
COPY-OUT + re-marshal — and the WASM `extract_blobs` copy-out elimination (Phase 2) IS the zero-copy Arrow handoff point.

---

## HARD BOUNDARIES (read first — these gate every step below)

1. **TWO-LEDGER LAW (LAW 1).** COORDINATE math (WCS, distortion-as-functions, star positions) stays
   strictly separate from PIXEL ops (stretch, fill, deconv). PSF stamps measured on the NATIVE grid —
   never resample before measurement. An Arrow spine may carry both, but must NOT let a pixel op read a
   coordinate column as if native, or vice-versa. Column provenance/units travel WITH the buffer
   (recall the hybrid-atlas + RA-hours-vs-degrees traps).

2. **GPU = RENDER / PREVIEW LANE ONLY.** Nothing on the GPU may feed WCS, PSF measurement, photometry,
   or deep-verify **without a bit-stability proof**. RENDER-LANE-SAFE set (WebGPU audit §plan-1): STF
   stretch, RL-deconv *preview* (display-only, never the measured native stamp), background-model viz,
   star-overlay compositing, starplates T1 point rendering. Everything else is FORBIDDEN behind the GPU
   until proven bit-identical flag-ON and flag-OFF.

3. **LAW 5 — Rust changes need sign-off + `wasm-pack build --target web --release` rebuild.**
   Every WASM plan step is a PROPOSAL. The frozen pinned reference solves are ULP-sensitive to the
   exact LLVM/opt that built the shipped `pkg/wasm_compute_bg.wasm` — record that toolchain before
   any rebuild (WASM baseline §6).

4. **EVERY STEP NAMES ITS PROTECTING GATE.** The four gates, from the audits:
   - **Greenfield reference solves** — the pinned-solve bank for the current reference solver engine, sentinel-gated by `greenfield_gate.mjs` (decision-core byte-exact per pin). Includes `M66_seestar` (scale=3.679184978895153"/px, matched=265, band=4, ra_deg=170.11844356557404, dec_deg=13.048758677673888 — the same field as the legacy SeeStar pin below, RA agrees to within 0.0004° across engines) among 15 SOLVED + 4 BudgetExhausted-refused production-tier pins; full bank (11 PASS, 4 PASS-DEGRADED, 2 REFUSED-HONEST, 0 false positives).
   - **Legacy/cold-path pins (pre-cutover TS/WASM engine — retained, never deleted; still the correct protecting gates for the legacy-lane WASM/GPU work this plan itself proposes, since that work targets the frozen legacy engine)**: **SeeStar e2e byte-identical**: `RA=11.341253475172621h, scale=3.6776147325019153"/px, matched=272, conf 0.83108935...`; **CR2 e2e solved**: `blindOutcome=solved` — 79 matched on the rawler default arm since the 2026-07-11 cutover; the `RA=17.5858h, 63.211"/px, 55 matched` pins quoted at this plan's writing are the retained libraw cold path (`VITE_DECODER_RAWLER=0`)
   - **api-smoke bit-identical receipt**: `npx vitest run -c tools/api/api_harness.config.ts` — pass count per `docs/GATES.md` (headless Node receipt IEEE-identical to browser)
   - **static trio**: `npx tsc --noEmit` + `npx vitest run` — baselines per `docs/GATES.md` ONLY (the counts hand-copied here at writing drifted within a day; never restate them)
   A GPU render path must stay byte-identical with the flag **ON and OFF**. A WASM change must not perturb the receipt.

---

## ARROW LEG — LANDED-BUT-DORMANT (disk / catalog format)

This section evaluates three ways to move the on-disk catalog format from JSON to Arrow IPC.
It predates the later Gaia-only catalog ruling (HYG retired from every path, atlas regenerated
Gaia-pure) — Option C below, in particular, describes a HYG+Gaia hybrid that this plan proposed
as the "current intended architecture" at the time; that premise is now historical, since the
shipped atlas was regenerated Gaia-pure rather than kept hybrid. The rest of this section is
retained for its Arrow-format reasoning, which still applies.

Recovered Arrow audit (every claim file:line-cited and measured). Arrow is a landed SEAM, not a
live catalog format. Neither flag-gated path is reachable at the time of this audit: the browser
seam has no `.arrow` twins shipped (converter writes only to gitignored `test_results/atlas_arrow`,
`atlas_to_arrow.mjs:54`), and the native path has no built T1 release plus an incomplete bundle
(see the bundled-manifest note below). `renderlab` consumes starplate `.arrow` for VISUALIZATION
only (`tools/renderlab/arrow_loader.mjs:14`), never the solve path.

**Honest sizing (measured — NOT the 60-900× column-native ceiling):** Arrow.gz is only **−20.5% vs
JSON.gz** (`STARPLATES_SPEC.md:507`); an Arrow sector is ~**44% smaller raw + ~2× faster parse** vs JSON
(`atlas_arrow_codec.ts:24`). Real and worth taking — but a parse/size win, not an order-of-magnitude one.

**Three paths considered:**
- **Option A — rank 1, low risk (recommended first move):** ship 36 `.arrow` sector twins for the CURRENT
  atlas and flip `VITE_ATLAS_BINARY`. The seam is already coded (`atlas_arrow_codec.ts`,
  `adapter.tryLoadArrowSector:245`); just run `atlas_to_arrow.mjs convert`, drop the twins into
  `public/atlas/sectors`, flip the flag. **Gate:** converter-verify (`value-mismatches=0` +
  `byte-identical-serialization=true`) AND both pinned e2e references byte-identical. Risk LOW —
  per-sector JSON fallback survives (`adapter:210`).
- **Option C — rank 2, the architecture originally intended here (superseded — see note above):**
  hybrid — browser keeps JSON/Arrow sectors (HYG + Gaia coexist, `spec 2.1`), native desktop gains
  the Gaia deep tier via starplates T1. Finish the native leg: build the T1 release (from the full
  64-chunk Gaia harvest), commit the missing `t0/allsky.arrow` blob, run `STARPLATES_PARITY=1` +
  benchmark, then decide on a default-ON flip (`spec 9.1 step7`). Effort MEDIUM-HIGH; no SeeStar
  risk (v1 untouched).
- **Option B — rank 3, trap (NOT a drop-in):** starplates T1 REPLACING `public/atlas/sectors`. starplates is
  **pure-Gaia** (`STARPLATES_SPEC.md:716`) — at the time of this audit it dropped the HYG named
  stars + mag-6.8-10 gap-fill (`tools/atlas/README.md:24`), changing the star SET and **breaking
  the SeeStar `matched=272` pinned reference** (parity there is set-equality, not byte-identity,
  `spec:609`). Also browser-cannot-read-native. HIGH effort, HIGH regression risk. Do NOT treat as
  a swap.

> **Note — bundled-manifest sequencing (a follow-up decision at the time of this audit).**
> The committed manifest at `src-tauri/resources/starplates/starplates-2026.07-gdr3/manifest.json`
> (coverage **0.8636**, 10612/12288 cells, built from the truncated vanguard CSV) had **NO `t0/allsky.arrow`
> blob in resources** — so the native seed path could not init at that point. The full-harvest release
> then being built (64/64 chunks, coverage → ~1.0) publishes under the canonical id
> **`starplates-2026.07-gdr3`** to an EMPTY bucket (no immutability conflict). The committed bundled
> manifest would then MISMATCH the published release **BY DESIGN** until the bundle is refreshed. (The
> adjacent `vanguard.bin` bundle-or-retire item was resolved as **retire**: the v1 mmap reader,
> `init_catalog`/`query_catalog`, and the §9.2 parity gate were removed; JSON atlas became the sole
> non-native catalog path — see the STARPLATES_SPEC retirement notice.) Client impact at the time: nil
> (sync had no production caller and the seed was already broken).

---

## PHASE 0 — CAPTURE BASELINES (do this FIRST, no code changes)

Exact commands the audits named. Capture BEFORE any lane work; these are the revert tripwires.

```
# Pinned e2e (time the runs; outputs must match verbatim — pins canonical in GATES.md/CLAUDE.md)
E2E_PORT=<fresh> node tools/e2e/run_wizard_seestar.mjs      # RA=11.341253475172621h, scale=3.6776147325019153, matched=272, conf 0.83108935...
node tools/e2e/run_wizard_cr2.mjs                            # blindOutcome=solved; 79 matched (rawler default) / 55 matched (libraw cold path VITE_DECODER_RAWLER=0)

# Static trio (per GATES.md — canonical, regenerated; NEVER hand-copy counts here)
npx tsc --noEmit                                             # baseline: see GATES.md
npx vitest run                                               # baseline: see GATES.md
npx vitest run -c tools/api/api_harness.config.ts            # baseline: see GATES.md (bit-identity gate)
```

Plus the audit-named measurements that are currently ESTIMATED, to turn `[P]`->`[M]`:
- **Preview encode baseline** to beat: `ImageProcessor.float32ToImageData` (`:236-258`) + `toDataURL('jpeg')`
  wall-time at 8MP and >=100MP. The ~100-400ms claim is ESTIMATED — measure it. **NOT MEASURED** yet.
- **renderlab GPU reality-check** on the actual dev GPU (README numbers are headless self-report): starfield
  119k gpu-pass ms + sustained fps, quiver 100k, cascade grid eval ms; >=20-iter mean±sd (§5). **NOT MEASURED (real GPU).**
- **WebView2 render-canvas smoke**: `getContext('webgpu')+configure()`+one presented frame inside Tauri/WebView2.
  Named Phase-0 unknown. **NOT MEASURED / NOT VERIFIED.**
- **Shipped-wasm toolchain**: exact `wasm-pack` + `rustc`/LLVM versions that built current `pkg/wasm_compute_bg.wasm`.
- **Arrow equivalence baseline** (Option A gate): `node tools/atlas/atlas_to_arrow.mjs verify` -> `value-mismatches=0` + `byte-identical-serialization=true`. **NOT MEASURED** yet.
- Per-stage timings: `source_extractor.ts:113` `performance.now()` detection log + signal_processor logs; check
  whether `package.ts` records stage timings before assuming they exist.

---

## PHASED ROADMAP (ordered payoff/risk after Phase 0)

Incubator-lane-first is MANDATORY (LAW 4): prototype in `tools/` (esp. `tools/renderlab/` port 3007 --strictPort,
NEVER 3005), prove, then port behind a module seam. Effort ballparks use the calibrated ledger (code-wave ~45min tool-time).

### Phase 1 — GPU STF stretch (WebGPU Rank #1: highest payoff / lowest risk)
- **What:** kill the GPU->CPU->base64 preview round-trip. Fullscreen-triangle render pass samples the resident
  linear buffer with STF/OETF in-shader, replacing `float32ToImageData` CPU `pow(1/2.2)` (`ImageProcessor.ts:241`) + the ~100-400ms encode.
- **Seam files:** `demosaic_pipeline.ts` (exposes `rgbBuffer?:GPUBuffer :15`), `core/ImageProcessor.ts` (STF v2, CPU today), `WebGPUContext.ts` (JOIN the singleton device — do NOT fork).
- **Classification:** RENDER-LANE-SAFE.  **Effort:** ~code-wave.
- **Gate:** SeeStar+CR2 e2e byte-identical (flag ON & OFF) + preview-present <=16ms@8MP.
- **Incubator-first:** prove present-path in `tools/renderlab/` first — **WebView2 canvas presentation is UNPROVEN in-repo** (compute ships, swapchain never exercised). This is the gating risk, not the shader.

### Phase 2 — Arrow spine: WASM COPY-OUT elimination (WASM Rank #2, low effort, no Rust)
- **What:** stop marshalling the `extract_blobs` `Vec<f64>` back as a JS array copy. Write blob results into a
  thread-local output buffer + return a pointer (mirror the `extract_blobs_shared` INPUT pattern at
  `source_extractor.ts:140-147`); TS reads a `Float64Array` view. This IS the Arrow columnar handoff point.
- **Seam files:** `lib.rs` `extract_blobs :487` / `extract_blobs_shared :473`, `source_extractor.ts:83` (`.slice()` copy-out), `photometry.rs`.
- **Effort:** LOW.  **Risk:** LOW (same values, removes a copy).
- **Gate:** SeeStar byte-identity + api-smoke bit-identical receipt.
- **Note:** requires sign-off (LAW 5) + rebuild (touches Rust return path). Do the TS-side buffer view first if a pointer export already exists.

### Phase 3 — starplates T1 point rendering in-app (WebGPU Rank #2)
- **What:** instanced point-sprites for catalog marks. `tools/renderlab/starfield.mjs` already proves the pipeline at 119k.
- **Seam files:** requires the Phase-3 render seam + starplates local store to land first; `WebGPUContext` singleton.
- **Classification:** RENDER-LANE-SAFE (display marks, no measurement).  **Effort:** ~code-wave.
- **Gate:** visual-parity ±1px vs DOM caps + fallback-exercised test.
- **Risk (blocks the phase if unresolved):** `vite.config.ts:26-27` sets COOP=same-origin + COEP=require-corp. Cross-origin
  starplate blob / atlas-tile fetches will be **BLOCKED by COEP require-corp** unless the source carries CORP/CORS headers. Verify on the R2 `starplates` bucket BEFORE this phase.

### Phase 4 — star-overlay + residual-quiver instancing behind hybrid seam (WebGPU Rank #3)
- **What:** SVG chrome above, GPU marks below, ONE shared `sx/sy` scale. Fires only past density thresholds (SVG stays at 25-star cap).
- **Seam files:** `ui/calibration/`, existing SVG widgets (`DistortionCascade2dWidget.tsx:97`, `DetectionDensityWidget.tsx:70`, PsfField — all SVG today).
- **Classification:** RENDER-LANE-SAFE.  **Effort:** ~code-wave.
- **Gate:** shared-scale parity (tick vs mark never disagree by >1px). **Constraint:** hit-testing/a11y stays DOM.

### Phase 5 — solver cross-match/verify inner loop -> WASM (WASM Rank #1: HIGHEST payoff, HIGHEST risk)
- **What:** port the dominant remaining TS hot loop — catalog<->detection cross-match/verify (`solver_entry.ts:997-1062`,
  nearest-neighbor of projected catalog across many search centers, $O(N \cdot M)$ per center, worst on ultra-wide) + the DEFAULT-ON two-pass BC-rematch rail — into WASM as scalar-f64 with FIXED iteration/tie-break order. **Cold path since the greenfield cutover** — `solver_entry.ts`'s cross-match/verify loop and BC-rematch rail belong to the legacy TS/WASM solver retired by the greenfield Rust solver core; this Phase-5 WASM port now targets only the frozen legacy lane.
- **Seam files:** `solver_entry.ts:997-1062`, `:1925` (`verify_astrometric_lock`), `lib.rs`, `photometry.rs`.
- **Effort:** ~code-wave + sign-off + rebuild.  **Risk:** HIGH.
- **Gate:** SeeStar e2e byte-identical + CR2 solved + api-smoke bit-identical receipt.
- **Why last despite highest payoff:** the BC-rematch wrong-sign guard is essential to SeeStar bit-identity
  (CLAUDE.md) — removing or reordering it changes the receipt. f64 TS==Rust is fine, but any reduction reorder shifts ULPs. Keep `simd128` OFF for this reduction or PROVE no autovec reassociation of the distance sums. Do NOT attempt before Phase-6 SIMD determinism is resolved.

### Phase 6 — simd128 determinism investigation (WASM Rank #3, gating for Phase 5)
- **What:** resolve the `deploy.md:16` warning `'+simd128 is not a recognized feature'`. Confirm whether the SHIPPED
  pkg actually has SIMD enabled and whether it is deterministic across rebuild toolchains. If autovec reassociation is
  active on f64 reductions in `extract_blobs`/`fit_gaussian_2d`, that is the `-ffast-math`-class risk to the frozen pinned reference solves.
- **Effort:** ~audit.  **Risk:** MED.  **Gate:** re-run both pinned e2e references after any rebuild.

### DEFERRED / DO-NOT-TOUCH
- **WASM threads (wasm-bindgen-rayon):** BLOCKED by the api-smoke bit-identity gate — parallel reductions are
  non-deterministic. Only ever for the DEFAULT-OFF RL-deconv/convolution lane (`rl_deconv.ts`, ~84s/18MP TS pool,
  off the gate path), and even there prefer SIMD-scalar tiling over rayon. Tauri prod COOP/COEP is **NOT VERIFIED**.
- **cullAnomalies density-grid + $O(N^2)$ linear-anomaly detect** (`source_extractor.ts:262-387`) -> WASM only if
  profiling shows it hot; integer-grid math = LOW determinism risk. Gate: SeeStar byte-identity.
- **background-model viz + RL-deconv PREVIEW as GPU heatmap** (WebGPU Rank #4): RENDER-LANE-SAFE only as a LABELED
  display; measured RL stamp stays CPU native-grid (LAW 1); must write NO receipt field.

---

## CROSS-LANE CONSOLIDATION (do-NOT-fork rules)
- Any WebGPU render port MUST join the `WebGPUContext` singleton device (`configure({device: getDevice()})`) — the
  "Nuclear-Fix" `GPUAdapter.prototype.requestDevice` monkeypatch (`WebGPUContext.ts:82-101`) assumes ONE device.
- **SHARED-WGSL HAZARD:** do NOT edit uniform structs of dual-ABI shaders — `demosaic_bayer.wgsl` (native `include_str!`
  16-byte uniform; browser uses SEPARATE `demosaic_bayer_param.wgsl` 48-byte) and the LIVE dual-consumer
  `reconstruct.wgsl` (`reconstruct.rs:11` `include_str!` AND `m9_export/reconstruct.ts:4` `?raw` — keep both layouts in sync).
- **Cascade shader choice (WebGPU §7.5):** the two live cascade widgets are hand-rolled **WebGL2** (`webgl_surface.ts:189-217`),
  not WebGPU. Porting to WebGPU would consolidate to one shader dialect, but WebGL stays the ratified choice for now — do NOT duplicate the surface in both APIs.

---

## OPEN DECISIONS (conflicts / not yet resolved)
The Arrow audit is **no longer missing** — it was recovered and folded in (ARROW LEG section), so the spine
thesis now rests on MEASURED evidence, not intersection inferences. The remaining open items:
1. **WebGL-vs-WebGPU cascade consolidation — ratified WebGL-for-now.**
   Revisit only after Phase 1 proves WebView2 canvas presentation; do NOT duplicate the surface in both APIs.
2. **Bundled-manifest refresh timing — approved: post-publish wave.** Refresh the
   committed manifest + add the missing T0 blob once the full-harvest release is published. (The
   `vanguard.bin` retirement half of this wave has landed: the v1 reader + `init_catalog`/
   `query_catalog` + the §9.2 parity gate were removed; the manifest refresh remains outstanding.)
3. **simd128 determinism verification** (Phase 6) BEFORE any WASM hot-loop port (Phase 5) — confirm the shipped
   `pkg` SIMD state is deterministic across rebuild toolchains; the BC wrong-sign guard is essential to SeeStar bit-identity.
4. **COEP require-corp** on cross-origin starplate/atlas fetches (Phase 3) — the `starplates` bucket IS live
   (public r2.dev URL enabled) but its CORP/CORS posture is **NOT VERIFIED** against a
   crossOriginIsolated page; verify/set CORS (S3 `PutBucketCors` works with held keys) before Phase 3.
5. **Phase-5 ordering** — highest payoff but gated on #3 above + the BC wrong-sign guard. Confirm the sequence.

## Related
- [Data Platform — system I/O map](../DATA_PLATFORM.md) — this draft's home in the Related-maps list of the system I/O map
- [Starplates Spec](../STARPLATES_SPEC.md) — Option C plans the native starplates T1 leg this spec builds
- [Starplates Dataplane byte contract](../reference/CARD_STARPLATES_DATAPLANE.md) — the cell/Arrow IPC byte contract this plan's ARROW LEG section builds on
- [NEXT_MOVES](../NEXT_MOVES.md) — §9's SoA-refactor question this plan's Phase 0 baselines and §9.3-style benchmark answer
- [GATES](../GATES.md) — canonical source of the static-trio/e2e numbers this plan's Phase 0 baselines are measured against
