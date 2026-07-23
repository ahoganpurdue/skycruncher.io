# Third-Party Licensing & Use Criteria

**Purpose.** Evidence audit of third-party licensing and use criteria for everything this project links, bundles, ships, or builds against. This is an engineering compliance inventory, **not legal advice** — confirm any consequential posture with counsel before distribution.

**Date:** 2026-07-12

**How this was generated.** Manifest inventory (npm `package.json` / lockfiles, Rust `Cargo.toml` + `Cargo.lock`, build-staging scripts, bundled-asset directories) cross-joined with per-package license resolution (`license-checker` for npm, local cargo registry cache + crate `Cargo.toml` license fields for Rust, upstream license pages + bundled `LICENSE`/`OFL.txt` for external binaries and data). Usage classification (`shipped-src` / `unreferenced` / `build-dev`) comes from a static import-evidence map and is cross-joined into the npm tables below.

**NOT-RESOLVED policy (honest-or-absent).** Where authorship, license, or exact version could not be established from the repository, the item is **listed as unresolved with the reason** — never guessed, never silently omitted, never assumed permissive. Unresolved items carry an explicit action to resolve them and are surfaced in Attention below. A few licenses were resolved from registry metadata rather than the installed file (the read deny-list blocks `node_modules` on this box); those carry a "confirm against installed file" action and are flagged inline.

---

## Attention items (act on these)

Every weak-copyleft, strong-copyleft / share-alike, unresolved, and latent-copyleft row, ranked by consequence, with the required action. Everything not listed here is permissive attribution-only.

| # | Item | License | Why it needs attention | Required action |
|---|---|---|---|---|
| 1 | **rawler 0.7.2** (dnglab) — Rust crate compiled into `src/engine/wasm_decode` | LGPL-2.1(-only) | **Most consequential.** rawler is the **DEFAULT shipped RAW decoder** (`isRawlerDecoderEnabled` default-true) since the 2026-07-11 cutover. It compiles **statically** into one `.wasm` (Rust has no dynamic linking) and there is **no CDDL escape hatch** as with LibRaw. LGPL §6 relink duty on a monolithic `.wasm` is genuinely unsettled. | Confirm rawler is used **UNMODIFIED** (the `tools/rawlab` probe and the `uuid` `js`-feature shim are ours, not rawler edits — keep it that way). Bundle the **LGPL-2.1 text**; attribute rawler/dnglab; publish a **written source offer** for `wasm_decode` + the rawler 0.7.2 pin + build steps enabling relink; keep rawler behind a clean wasm-bindgen seam so the relink story stays plausible. Any fork/patch of rawler **must** be published under LGPL. |
| 2 | **HYG database** (Astronexus / David Nash) — faint-tail rows merged into bundled atlas sectors | CC-BY-SA-2.5 (v3.x) **or** CC-BY-SA-4.0 (v4.x) — **version unconfirmed** | **Highest data-license risk — share-alike.** ~107k HYG rows (mag>6.8 tail) are appended into shipped `public/atlas/sectors/level_3_sector_*.json` and redistributed. CC-BY-SA triggers **attribution + share-alike** on the HYG-derived data. Copyleft reaches only the HYG-derived rows, **not** your app code — but you cannot impose more-restrictive terms on those rows. | **Pin the exact HYG version shipped** (2.5 vs 4.0 sets the SA version). Add HYG attribution (name, author, source URL, license + link). Decide the SA posture: simplest compliant path = publish the HYG-derived extract under matching CC-BY-SA and say so. **To eliminate the only copyleft-style data obligation entirely: drop the HYG rows and backfill the faint tail from a credit-only source** (extend the Gaia extract fainter, or Tycho-2/Hipparcos). Never relicense HYG rows more restrictively. |
| 3 | **LibRaw** (RAW-decode C++ core, compiled into `libraw-wasm`) | LGPL-2.1-only **OR** CDDL-1.0 (dual since v0.18) | Now the **cold path** (`VITE_DECODER_RAWLER=0`) after the rawler cutover, but **still shipped** (owner ruled never delete). Statically compiled into a `.wasm`, loaded in-process. The LGPL-static-into-WASM relink question is genuinely unsettled — but LibRaw has a **CDDL escape hatch** rawler lacks. Runs **unmodified**. | **ELECT CDDL-1.0** in the NOTICE/licenses screen to sidestep the LGPL-WASM relink debate (CDDL is file-level weak copyleft, no relink duty). Bundle **BOTH** license texts (LGPL-2.1 + CDDL-1.0); attribute LibRaw; state it is unmodified. If you keep the LGPL election instead, publish a source offer for the exact LibRaw version + the `libraw-wasm` build. Exact LibRaw version is **not resolvable from the repo** (>=0.18 inferred from dual-license era) — note as unresolved. |
| 4 | **Bundled demo images** — `DSO_Stacked_..._M 66_60.0s...fit` (SeeStar M66 stack, ~49.8MB) + `sample_observation.cr2` ("Beach first-light frame", ~22.7MB) | **NOT RESOLVED** | Both are staged from `D:\AstroLogic\SampleFiles` at build time (`tools/build/prep_demo_assets.mjs`) and bundled into the shipped desktop app for offline "Load Sample". They **read as owner-captured** astrophotos, but authorship/rights **cannot be verified from the repo** (gitignored binaries on D:). The SeeStar M66 stack in particular could be an owner capture **or** a vendor/community sample. | **Confirm authorship/rights of BOTH frames** (owner-captured, or contributor grant on file). If either is third-party, obtain a license/permission or replace with an owner-captured frame. Add a one-line provenance/credit for demo assets in About; record provenance in a **MANIFEST**, not the presentation layer. |
| 5 | **lensfun** (library + lens-profile database) — dormant runtime-fetch scaffolding | LGPL-3.0-only (library) + CC-BY-SA-3.0 (database) | **Latent, not active.** No lensfun code or data is redistributed today → current obligation is effectively **none**. The bundled `LENS_DB` (`m2_hardware/lens_profiles.ts`) is **hand-authored APPROXIMATE constants**, not copied from lensfun → carries no CC-BY-SA obligation. But `lensfun_ingestor.ts` / `lens_database_adapter.ts` contain **dormant** scaffolding that would fetch lensfun's XML DB at runtime and inherit **CC-BY-SA share-alike** if ever wired live. | Keep `LENS_DB` independently authored and **add a header stating it is independently authored, not lensfun-derived**. Before enabling the ingestor, add lensfun DB attribution and decide the caching/share-alike posture. Leave the runtime-fetch path clearly marked **dormant**. You never link `liblensfun`, so LGPL-3.0 is irrelevant unless that changes. |
| 6 | **Gaia DR3 catalog** — bundled star-atlas extract (`public/atlas/sectors`, ~338MB) | ESA/Gaia open-data terms (**no SPDX**; free use, **credit required**) | Attribution-only and low risk, but **credit is a required action**, not optional. A derived subset (ra/dec/mag_g/bp_rp/pm/source_id) is redistributed in the app. No copyleft, no share-alike, no source offer, no license-text bundling. | Add the **`ESA/Gaia/DPAC` credit line** to the app's About/credits **and to any exported science receipt/packet** that used the catalog. Include the standard DPAC acknowledgement text in docs. Optionally cite Gaia Collaboration (2023) in the whitepaper. |
| 7 | **RawTherapee** — X-Trans "fast" demosaic study reference | GPL-3.0 | No RT code is linked or bundled — but it may be **studied** to author our own Markesteijn/fast demosaic (the X-Trans checkerboard decode fix). Risk is **none while study-only**; becomes **strong-copyleft the moment code is copied or close-paraphrased** (even translated to Rust/TS, even renamed variables, even verbatim lookup tables). | **Reimplement-from-understanding doctrine** (see Standing rules). Keep a written record that any X-Trans reimplementation was authored from the algorithm description, not copied. Do **NOT** paste or mechanically translate RT code; regenerate constant tables from first principles. If any RT code was copied, remove it or accept GPL-3.0 on the combined work. |
| 8 | **NSIS installer — LZMA module** | zlib/libpng (core) + **CPL-1.0 (LZMA module)** + bzip2 license (bzip2 module) | The shipped installer `.exe` embeds NSIS's compression stub. Modern Tauri NSIS uses solid **LZMA**, whose module is **CPL-1.0 = weak copyleft on that module's source only**. No copyleft reaches your app code. | Satisfiable by pointing to the **unmodified upstream NSIS**. List NSIS (zlib/libpng; note CPL-1.0 for the LZMA module) in third-party licenses for completeness. NSIS core needs no runtime attribution legally. |

**Tauri trademark note (not a license obligation, but an action):** Tauri is MIT/Apache-2.0 permissive, but observe **Tauri trademark guidelines** for the product name/logo. Fold into the one-shot brand rename pass; do not churn identifiers piecemeal.

---

## npm — shipped (in the distributed app)

Usage cross-joined from the import-evidence map. `shipped-src` = imported by `src/`; `unreferenced` = declared but no live JS/TS import.

| Package | Version | License (SPDX) | Usage | Obligations | Risk |
|---|---|---|---|---|---|
| @tauri-apps/api | 2.10.1 | Apache-2.0 OR MIT | shipped-src (`NativeGpuBridge.ts` + invoke bindings, connectors, catalog/provider adapters) | Attribution; pick either license (Apache adds patent grant + NOTICE) | attribution |
| @tauri-apps/plugin-dialog | 2.6.0 | MIT OR Apache-2.0 | shipped-src (`save_export.ts`, `solve_queue/connectors.ts`) | Attribution; pick either (Apache adds patent grant) | attribution |
| @tauri-apps/plugin-fs | 2.4.5 | MIT OR Apache-2.0 | shipped-src (`save_export.ts`, `solve_queue/connectors.ts`) | Attribution; pick either (Apache adds patent grant) | attribution |
| @tauri-apps/plugin-log | 2.8.0 | MIT OR Apache-2.0 | **unreferenced** (no JS/TS import; only the Rust `tauri-plugin-log` is registered in `src-tauri/src/lib.rs`) | Attribution if retained; candidate for removal from `package.json` | attribution |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 | shipped-src (`src/desktop/updater.ts` — relaunch/exit) | Attribution; pick either (Apache adds patent grant) | attribution |
| @tauri-apps/plugin-updater | 2.10.1 | MIT OR Apache-2.0 | shipped-src (`src/desktop/updater.ts` — auto-update) | Attribution; pick either (Apache adds patent grant) | attribution |
| apache-arrow | 21.1.0 | Apache-2.0 | shipped-src (`ArrowMemory.ts`, `atlas_arrow_codec`, `starplates_provider`, `demosaic_pipeline`; also `packages/toolchest` peerDep resolved in root) | Attribution + retain NOTICE; express patent grant; no copyleft | attribution |
| exifr | 7.1.3 | MIT | shipped-src (`metadata_reaper.ts`, `sensor_db.ts`, `diagnostic_raw.ts` — EXIF parse) | Attribution (retain copyright + license notice); no patent grant | attribution |
| libraw-wasm | 1.1.2 | ISC | shipped-src (dynamic import at `metadata_reaper.ts:493`; cold-path decoder post-cutover) | Attribution (ISC, MIT-equivalent). **Wrapper ISC governs only the JS/WASM glue — it does NOT relicense the LibRaw C++ in the `.wasm` (see Attention #3).** ISC resolved from registry metadata — confirm against installed `LICENSE`. | attribution |
| lucide-react | 0.300.0 | ISC | shipped-src (`MainUpload.tsx` + 6 more UI components — icon set) | Attribution (ISC, MIT-equivalent); no patent grant | attribution |
| react | 18.3.1 | MIT | shipped-src (`main.tsx`, `MainApp.tsx`, engine hooks, throughout `src/engine/ui`) | Attribution (retain copyright + license notice); no patent grant | attribution |
| react-dom | 18.3.1 | MIT | shipped-src (`main.tsx` `createRoot`; render in engine UI) | Attribution (retain copyright + license notice); no patent grant | attribution |

---

## npm — dev + tooling (not distributed)

Build/test toolchain only; not linked into the shipped app.

| Package | Version | License (SPDX) | Usage | Obligations | Risk |
|---|---|---|---|---|---|
| @tailwindcss/vite | 4.3.2 | MIT | build-dev (`vite.config.ts` plugin) | Attribution (retain notice) | attribution |
| @tauri-apps/cli | 2.10.1 | Apache-2.0 OR MIT | build-dev (`tauri`/`tauri:dev`/`tauri:build` scripts) | Attribution; pick either (Apache adds patent grant) | attribution |
| @types/react | 18.3.28 | MIT | build-dev (TS type stubs, compile-time only) | Attribution; DefinitelyTyped stubs | attribution |
| @types/react-dom | 18.3.7 | MIT | build-dev (TS type stubs, compile-time only) | Attribution; DefinitelyTyped stubs | attribution |
| @vitejs/plugin-react | 4.7.0 | MIT | build-dev (`vite.config.ts` — JSX/Fast-Refresh) | Attribution (retain notice) | attribution |
| @vitest/browser | 4.0.18 | MIT | build-dev (browser-mode provider peer, `vitest.workspace.ts`) | Attribution (retain notice) | attribution |
| @webgpu/types | 0.1.69 | BSD-3-Clause | build-dev (ambient TS types in `tsconfig.json`) | Attribution + no-endorsement clause; no patent grant; no copyleft | attribution |
| playwright | 1.58.2 | Apache-2.0 | build-dev (browser-wasm-suite provider; `tools/e2e`, `tools/repro` CDP) | Attribution + preserve NOTICE; express patent grant; no copyleft | attribution |
| tailwindcss | 4.3.2 | MIT | build-dev (Tailwind v4 engine, CSS build time) | Attribution (retain notice); no copyleft | attribution |
| typescript | 5.9.3 | Apache-2.0 | build-dev (`tsc --noEmit` gate; installed 5.9.3 vs manifest ^5.2.2) | Attribution + preserve NOTICE; express patent grant; no copyleft | attribution |
| vite | 5.4.21 | MIT | build-dev (dev server + bundler; installed 5.4.21 vs manifest ^5.0.8) | Attribution (retain notice); no copyleft | attribution |
| vite-plugin-top-level-await | 1.6.0 | MIT | build-dev (`vite.config.ts` plugin) | Attribution (retain notice) | attribution |
| vite-plugin-wasm | 3.5.0 | MIT | build-dev (`vite.config.ts` — WASM module loading) | Attribution (retain notice) | attribution |
| vitest | 4.0.18 | MIT | build-dev (test runner; `vitest.workspace.ts`) | Attribution (retain notice) | attribution |

---

## Rust crates (cargo)

Deduplicated by crate; the "Where" column names the manifest(s) it resolves from. Versions come from `Cargo.lock` where present, else the local cargo registry cache (`src-tauri` has no `Cargo.lock` — manifest pins used). Where a crate appears at two versions across workspaces, both are shown.

| Crate | Version | License (SPDX) | Where / usage | Obligations | Risk |
|---|---|---|---|---|---|
| **rawler** | 0.7.2 | **LGPL-2.1(-only)** | `wasm_decode` — **DEFAULT shipped RAW decoder**, static into `.wasm` | **Weak copyleft — see Attention #1.** LGPL text + attribution + relink source offer; modifications must be published under LGPL | **weak-copyleft** |
| serde | 1.0.228 | MIT OR Apache-2.0 | `wasm_compute`, `wasm_decode`, `src-tauri` | Attribution; patent grant via Apache arm | attribution |
| serde-wasm-bindgen | 0.6.5 | MIT | `wasm_compute` | Attribution (retain copyright + MIT notice) | attribution |
| js-sys | 0.3.90 | MIT OR Apache-2.0 | `wasm_compute` | Attribution; patent grant via Apache arm | attribution |
| nalgebra | 0.34.1 | Apache-2.0 | `wasm_compute` | Attribution + NOTICE preservation + explicit patent grant | attribution |
| wasm-bindgen | 0.2.113 (wasm_compute), 0.2.126 (wasm_decode) | MIT OR Apache-2.0 | `wasm_compute`, `wasm_decode` | Attribution; patent grant via Apache arm | attribution |
| console_error_panic_hook | 0.1.7 | MIT OR Apache-2.0 | `wasm_compute` (declared legacy `Apache-2.0/MIT`) | Attribution; patent grant via Apache arm | attribution |
| uuid | 1.23.4 | MIT OR Apache-2.0 | `wasm_decode` (+`js` feature) | Attribution; patent grant via Apache arm | attribution |
| serde_json | 1.0.150 | MIT OR Apache-2.0 | `wasm_decode`, `src-tauri` | Attribution; patent grant via Apache arm | attribution |
| tauri-build | 2.5.6 | Apache-2.0 OR MIT | `src-tauri` **build-dependency** (compile-time, not linked into shipped exe) | Attribution; patent grant via Apache arm | attribution |
| log | 0.4.33 | MIT OR Apache-2.0 | `src-tauri` | Attribution; patent grant via Apache arm | attribution |
| tauri | 2.10.3 | Apache-2.0 OR MIT | `src-tauri` — shipped app framework | Attribution; patent grant via Apache arm; **observe Tauri trademark policy** | attribution |
| tauri-plugin-log | 2.8.0 | Apache-2.0 OR MIT | `src-tauri` | Attribution; patent grant via Apache arm | attribution |
| tauri-plugin-dialog | 2.7.1 | Apache-2.0 OR MIT | `src-tauri` (manifest spec `2`) | Attribution; patent grant via Apache arm | attribution |
| tauri-plugin-fs | 2.4.5 | Apache-2.0 OR MIT | `src-tauri` (declared `2`) | Attribution; patent grant via Apache arm | attribution |
| tauri-plugin-persisted-scope | 2.3.5 | Apache-2.0 OR MIT | `src-tauri` (declared `2`) | Attribution; patent grant via Apache arm | attribution |
| tauri-plugin-updater | 2.10.1 | Apache-2.0 OR MIT | `src-tauri` (declared `2`) | Attribution; patent grant via Apache arm | attribution |
| tauri-plugin-process | 2.3.1 | Apache-2.0 OR MIT | `src-tauri` (declared `2`) | Attribution; patent grant via Apache arm | attribution |
| wgpu | 23.0.1 | MIT OR Apache-2.0 | `src-tauri`, `native_gpu` (declared `23.0`) | Attribution; patent grant via Apache arm | attribution |
| native-gpu | 0.1.0 | **first-party (no license declared)** | `native_gpu` — project's own crate | None — own code, no external obligation | none |
| memmap2 | 0.9.10 / 0.9.11 | MIT OR Apache-2.0 | `src-tauri` (manifest ^0.9.5) | Attribution; patent grant via Apache arm | attribution |
| arrow | 54.3.1 (exact pin) | Apache-2.0 | native decode/atlas meta-crate | Attribution + NOTICE retention + patent grant | attribution |
| arrow-array | 54.3.1 (exact pin) | Apache-2.0 | `src-tauri` | Attribution + preserve NOTICE + patent grant | attribution |
| arrow-schema | 54.3.1 (exact pin) | Apache-2.0 | `src-tauri` | Attribution + preserve NOTICE + patent grant | attribution |
| arrow-buffer | 54.3.1 (exact pin) | Apache-2.0 | `src-tauri` | Attribution + preserve NOTICE + patent grant | attribution |
| arrow-ipc | 54.3.1 (exact pin) | Apache-2.0 | `src-tauri` | Attribution + preserve NOTICE + patent grant | attribution |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | `src-tauri` (declared `0.10`) | Attribution; patent grant via Apache arm | attribution |
| ureq | 3.2.0 | MIT OR Apache-2.0 | `src-tauri` (declared `3.2`, native-tls) | Attribution; patent grant via Apache arm | attribution |
| ort | 2.0.0-rc.12 | MIT OR Apache-2.0 | **OPTIONAL** `ai`/`ai-terrain`/`ai-distortion` features, **default OFF**; links ONNX Runtime native lib (Microsoft, MIT) separately | Attribution; patent grant. Not in default build | attribution |
| ndarray | 0.16.1 (also 0.17.2 in lock) | MIT OR Apache-2.0 | **OPTIONAL** `ai` features, **default OFF** (declared `0.16`) | Attribution; patent grant via Apache arm. Not in default build | attribution |
| tempfile | 3.26.0 | MIT OR Apache-2.0 | **DEV-dependency** — does NOT ship (declared `3`) | Attribution; patent grant via Apache arm | attribution |
| pollster | 0.4.0 | Apache-2.0 OR MIT | `native_gpu` (declared legacy `Apache-2.0/MIT`) | Attribution; patent grant via Apache arm | attribution |
| bytemuck | 1.25.1 | Zlib OR Apache-2.0 OR MIT | native gpu/decode (manifest ^1.21, +derive) | Attribution (pick any; all permissive, no source-disclosure) | attribution |
| env_logger | 0.11.11 | MIT OR Apache-2.0 | native (manifest ^0.11) | Attribution (retain notice) | attribution |
| md5 | 0.7.0 | Apache-2.0 OR MIT | native (manifest ^0.7; legacy slash = dual OR) | Attribution (pick either) | attribution |

---

## External binaries & native/special linkage

Native libraries compiled into shipped WASM, external sidecar tools, installer tooling, and study-only references.

| Item | Version | License (SPDX) | Linkage / usage | Obligations | Risk |
|---|---|---|---|---|---|
| **LibRaw** (RAW-decode C++ core, in `libraw-wasm`) | as bundled in `libraw-wasm@1.1.2`; exact LibRaw ver **NOT resolvable** (>=0.18) | **LGPL-2.1-only OR CDDL-1.0** | Statically compiled into a `.wasm`, loaded in-process; **cold path** post-cutover but still shipped (never delete). Unmodified. | **Weak copyleft — see Attention #3.** ELECT CDDL-1.0; bundle both texts; attribute + state unmodified | **weak-copyleft** |
| **rawler** (dnglab) — *cross-reference* | 0.7.2 | LGPL-2.1(-only) | Rust crate → `wasm_decode` cdylib; **default decoder**. Full obligation in the Rust-crates table + **Attention #1**. | Weak copyleft; LGPL text + relink source offer | **weak-copyleft** |
| **c2patool** (Content Authenticity Initiative CLI) | v0.9.12 (pinned in `tools/c2pa/fetch_c2patool.mjs`) | MIT OR Apache-2.0 | **External sidecar**, spawned arm's-length; downloaded at **dev time**, gitignored, **NOT bundled** into the shipped app | Effectively none in the shipped app today. If ever bundled: ship both texts + Apache NOTICE (§4) + gain the patent grant. **Keep dev test-signing certs out of any production trust path** (provenance caveat, not a license issue) | attribution (dev) |
| **NSIS** (installer tooling) | via Tauri bundle target `nsis` | zlib/libpng (core); **LZMA module = CPL-1.0**; bzip2 module = bzip2 license | Generates the shipped `.exe`; the compression stub is embedded in the installer, not in app code | Core needs no runtime attribution. **LZMA module CPL-1.0 = weak copyleft on that module only** (satisfy by pointing to unmodified upstream NSIS — **Attention #8**). List for completeness | attribution |
| **RawTherapee** — X-Trans demosaic study reference | current (reference only; no code linked/bundled) | GPL-3.0 | **Study-only** to inform our own demosaic; no code linked or bundled | **None while study-only.** Becomes strong-copyleft the instant code is copied/close-paraphrased — **Attention #7** + Standing rules | none (study-only) |

*Note: `libraw-wasm@1.1.2` itself (the ISC JS/WASM wrapper) is inventoried in the npm-shipped table; its ISC covers only the wrapper glue, not the LibRaw binary. Author-disclosed ~90% AI-generated / single-author — a supply-chain quality note, not a license issue.*

---

## Bundled data (redistributed in the app)

| Item | Version | License (SPDX) | Usage | Obligations | Risk |
|---|---|---|---|---|---|
| **HYG database** (Astronexus / David Nash) | v3.x (CC-BY-SA-2.5) **or** v4.x (CC-BY-SA-4.0) — **UNCONFIRMED** | CC-BY-SA-2.5 or -4.0 | ~107k faint-tail rows merged into shipped atlas sectors (`merge_hyg_sectors.mjs`) | **Strong copyleft / share-alike — see Attention #2.** Attribution + SA on the HYG-derived data; copyleft does NOT reach your app code | **strong-copyleft** |
| **Gaia DR3 catalog** | DR3 | No SPDX — ESA/Gaia open-data terms (credit required) | Derived subset bundled as atlas sectors (~338MB) | **Credit `ESA/Gaia/DPAC`** in About + exported receipts; DPAC acknowledgement in docs. No copyleft/share-alike/source offer — **Attention #6** | attribution |
| **Inter + JetBrains Mono** (self-hosted `.woff2`) | latin-subset variable builds (Fontsource), unmodified | OFL-1.1 | Bundled fonts in `dist/` + Tauri app | **Essentially satisfied.** `public/fonts/OFL.txt` present + correct (both declare **no** Reserved Font Name; shipped unmodified). Keep OFL.txt shipping alongside fonts; surface it in the About/licenses screen. May not be sold on their own (we don't) | attribution |
| **lensfun** (library + lens-profile DB) | git master scaffolding — **DORMANT** | LGPL-3.0-only (lib) + CC-BY-SA-3.0 (DB) | No code/data redistributed today; bundled `LENS_DB` is hand-authored, **not** lensfun-derived; runtime-fetch path is dormant/unwired | **Latent — see Attention #5.** Current obligation effectively none. Keep `LENS_DB` independently authored + labeled; add attribution + decide SA posture **before** enabling the ingestor | attribution (latent) |
| **Demo images** — SeeStar M66 stack (FITS ~49.8MB) + "Beach first-light" (CR2 ~22.7MB) | 2 pinned frames, staged from `D:` at build (`prep_demo_assets.mjs`) | **NOT RESOLVED** | Bundled into the shipped app for offline "Load Sample" | **Unresolved provenance — see Attention #4.** Confirm owner authorship or obtain license / replace; record provenance in a MANIFEST | **unresolved** |

*Excluded: `favicon.svg` (project-authored/trivial); `public/models` is empty (the ONNX/MobileSAM path was deleted).*

---

## Standing rules

**Reimplement-vs-copy doctrine (for GPL / any copyleft source you study).**
- Copyright protects **expression** (source code), not **ideas / algorithms / math**. Reimplementing an algorithm from understanding is free and carries **no copyleft**.
- **Copying or close-paraphrasing** copyleft code is a derivative work — even translated to another language, even with renamed variables, even verbatim constant/lookup tables (tables can carry copyright). That contaminates the combined work with the source's license (e.g. GPL-3.0 would reach the decode path and arguably the whole app).
- **Clean-room discipline:** derive the method from the published description or your own kernel; do not vendor or transliterate the source file line-by-line; regenerate constant tables from first principles; keep a written record that the work was authored from the algorithm description, not copied. Watch dcraw / LibRaw-demosaic-pack lineage — keep provenance clean.

**LGPL relink honesty (wasm-compiled LibRaw / rawler).** Statically-linked LGPL code in a monolithic `.wasm` has no settled case law on the §6 relink duty. Treat conservatively: keep the LGPL part behind a clean seam, use it **unmodified**, bundle the LGPL text, attribute, and provide a **source offer + build recipe** enabling a user to relink a modified version. Prefer CDDL election where the license offers it (LibRaw); rawler has no such escape, so the source-offer path is mandatory. Any fork/patch of an LGPL component must be published under LGPL.

**Share-alike scope (bundled catalog data).** CC-BY-SA reaches only the copyleft-licensed **data** (e.g. HYG-derived rows), never your app code. Do not impose more-restrictive terms on those rows. The cleanest way to remove a share-alike obligation is to **drop the copyleft data and backfill from a credit-only source**.

**New-dependency checklist — check the license BEFORE adopting.**
1. Resolve the SPDX license from the package metadata **and** the installed `LICENSE` file (don't trust registry metadata alone).
2. Classify: permissive (MIT/ISC/BSD/Apache/Zlib) → fine; **weak copyleft** (LGPL/MPL/CDDL/CPL) → confirm linkage story + relink/source-offer plan before adopting; **strong copyleft / share-alike** (GPL/AGPL/CC-BY-SA) → do not link/bundle without an explicit, deliberate decision (study-only or drop-and-replace preferred).
3. Record **usage** (shipped vs dev vs optional-feature vs dormant) — obligations differ sharply; dev-only and default-off code carries little to no distribution obligation.
4. If authorship/license/version can't be established, mark it **NOT RESOLVED** with the reason and an action — never assume permissive.
5. Prefer brand-neutral, permissively-licensed alternatives; keep any copyleft component behind a clean seam so it stays separable.
6. Add every shipped/bundled item's notice to the app's third-party/About licenses screen.
