# Third-Party Components & Licenses

This document lists the third-party software components and data sources distributed as
part of the SkyCruncher application, together with their licenses and any attribution
each license requires. It covers components that are shipped or redistributed in the
application and its installer; build-only and development tooling that is not distributed
is not listed here.

SPDX identifiers are used for licenses. Where a component offers a choice of licenses
(e.g. `MIT OR Apache-2.0`), either may be applied. Full license texts for the components
below are included with the application and surfaced in the About / licenses screen.

---

## Rust crates

Compiled into the shipped desktop binary and the shipped WebAssembly modules.

| Component | Version | License (SPDX) | Used for | Upstream |
|---|---|---|---|---|
| tauri | 2.10.3 | Apache-2.0 OR MIT | Desktop application framework | https://tauri.app |
| tauri-plugin-log | 2.8.0 | Apache-2.0 OR MIT | Application logging | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-dialog | 2.7.1 | Apache-2.0 OR MIT | Native file dialogs | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-fs | 2.4.5 | Apache-2.0 OR MIT | Filesystem access | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-persisted-scope | 2.3.5 | Apache-2.0 OR MIT | Persists granted filesystem scopes | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-updater | 2.10.1 | Apache-2.0 OR MIT | Application auto-update | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-process | 2.3.1 | Apache-2.0 OR MIT | Application relaunch / exit | https://github.com/tauri-apps/plugins-workspace |
| wgpu | 23.0.1 | MIT OR Apache-2.0 | GPU compute and rendering | https://github.com/gfx-rs/wgpu |
| arrow | 54.3.1 | Apache-2.0 | Columnar catalog data plane | https://arrow.apache.org |
| arrow-array | 54.3.1 | Apache-2.0 | Arrow arrays | https://arrow.apache.org |
| arrow-schema | 54.3.1 | Apache-2.0 | Arrow schemas | https://arrow.apache.org |
| arrow-buffer | 54.3.1 | Apache-2.0 | Arrow buffers | https://arrow.apache.org |
| arrow-ipc | 54.3.1 | Apache-2.0 | Arrow IPC framing | https://arrow.apache.org |
| serde | 1.0.228 | MIT OR Apache-2.0 | Serialization framework | https://serde.rs |
| serde_json | 1.0.150 | MIT OR Apache-2.0 | JSON serialization | https://github.com/serde-rs/json |
| serde-wasm-bindgen | 0.6.5 | MIT | serde ↔ JavaScript value bridge | https://github.com/RReverser/serde-wasm-bindgen |
| wasm-bindgen | 0.2 | MIT OR Apache-2.0 | Rust ↔ WebAssembly / JavaScript bindings | https://github.com/rustwasm/wasm-bindgen |
| js-sys | 0.3.90 | MIT OR Apache-2.0 | JavaScript global bindings for WebAssembly | https://github.com/rustwasm/wasm-bindgen |
| nalgebra | 0.34.1 | Apache-2.0 | Linear algebra (solver / compute) | https://nalgebra.org |
| console_error_panic_hook | 0.1.7 | MIT OR Apache-2.0 | WebAssembly panic reporting | https://github.com/rustwasm/console_error_panic_hook |
| uuid | 1.23.4 | MIT OR Apache-2.0 | Identifier generation | https://github.com/uuid-rs/uuid |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | SHA-256 (download integrity) | https://github.com/RustCrypto/hashes |
| ureq | 3.2.0 | MIT OR Apache-2.0 | HTTP client (catalog download) | https://github.com/algesten/ureq |
| memmap2 | 0.9.x | MIT OR Apache-2.0 | Memory-mapped file I/O | https://github.com/RazrFalcon/memmap2-rs |
| log | 0.4.33 | MIT OR Apache-2.0 | Logging facade | https://github.com/rust-lang/log |
| env_logger | 0.11.11 | MIT OR Apache-2.0 | Logger implementation | https://github.com/rust-cli/env_logger |
| pollster | 0.4.0 | Apache-2.0 OR MIT | Block-on executor for GPU futures | https://github.com/zesterer/pollster |
| bytemuck | 1.25.1 | Zlib OR Apache-2.0 OR MIT | Plain-data byte casts | https://github.com/Lokathor/bytemuck |
| ort | 2.0.0-rc.12 | MIT OR Apache-2.0 | ONNX Runtime binding — optional feature, not in the default build | https://github.com/pykeio/ort |
| ndarray | 0.16.1 | MIT OR Apache-2.0 | N-dimensional arrays — optional feature, not in the default build | https://github.com/rust-ndarray/ndarray |
| rawler | 0.7.2 | LGPL-2.1 | RAW / CR2 image decoder (default decode path) — see [WebAssembly-shipped components](#webassembly-shipped-components) for the full notice | https://github.com/dnglab/dnglab |

---

## JavaScript / TypeScript packages

Bundled into the shipped application.

| Component | Version | License (SPDX) | Used for | Upstream |
|---|---|---|---|---|
| react | 18.3.1 | MIT | UI library | https://react.dev |
| react-dom | 18.3.1 | MIT | React DOM renderer | https://react.dev |
| apache-arrow | 21.1.0 | Apache-2.0 | Arrow columnar catalog I/O | https://arrow.apache.org |
| exifr | 7.1.3 | MIT | EXIF metadata parsing | https://github.com/MikeKovarik/exifr |
| libraw-wasm | 1.1.2 | ISC | JS/WASM wrapper for the LibRaw decoder (LibRaw core listed under [WebAssembly-shipped components](#webassembly-shipped-components)) | https://www.npmjs.com/package/libraw-wasm |
| lucide-react | 0.300.0 | ISC | Icon set | https://lucide.dev |
| dockview-react | 7.0.3 | MIT | Dockable widget panels (the widget ribbon) | https://dockview.dev |
| @tauri-apps/api | 2.10.1 | Apache-2.0 OR MIT | Tauri JavaScript API bindings | https://tauri.app |
| @tauri-apps/plugin-dialog | 2.6.0 | MIT OR Apache-2.0 | File dialog bindings | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-fs | 2.4.5 | MIT OR Apache-2.0 | Filesystem bindings | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-log | 2.8.0 | MIT OR Apache-2.0 | Logging bindings | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 | Process control bindings | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-updater | 2.10.1 | MIT OR Apache-2.0 | Updater bindings | https://github.com/tauri-apps/plugins-workspace |

---

## WebAssembly-shipped components

The application ships WebAssembly modules built from native (Rust / C++) source. Two of
their components carry license notices beyond permissive attribution.

### rawler 0.7.2 — LGPL-2.1

- **Component.** `rawler` (part of the dnglab project), a RAW image decoder for Canon CR2
  and other camera raw formats. It is compiled into the shipped `wasm_decode` module and
  is the default RAW decode path.
- **License.** GNU Lesser General Public License, version 2.1. The LGPL-2.1 license text
  is included with the application.
- **Modification.** rawler is used unmodified at version 0.7.2.
- **Source availability.** The corresponding source for rawler 0.7.2 is available from the
  upstream project at https://github.com/dnglab/dnglab (crate:
  https://crates.io/crates/rawler). The version used and the WebAssembly build steps are
  documented so that a user may obtain and relink a modified version of this component.

### LibRaw — LGPL-2.1 or CDDL-1.0 (CDDL-1.0 elected)

- **Component.** The LibRaw RAW-decode C++ core, compiled into the `libraw-wasm` module
  (the alternate RAW decode path). Used unmodified.
- **License.** Dual-licensed under LGPL-2.1 or CDDL-1.0. SkyCruncher elects CDDL-1.0. The
  CDDL-1.0 license text is included with the application.
- **Upstream.** https://www.libraw.org
- The `libraw-wasm` JavaScript/WebAssembly wrapper (ISC) is listed under
  [JavaScript / TypeScript packages](#javascript--typescript-packages).

---

## Data sources

Astronomical catalog data redistributed with the application.

### Gaia DR3

The bundled star-atlas sectors are derived from a subset of the ESA Gaia DR3 catalog.

> This work has made use of data from the European Space Agency (ESA) mission Gaia
> (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis
> Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the
> DPAC has been provided by national institutions, in particular the institutions
> participating in the Gaia Multilateral Agreement.

Upstream: https://www.cosmos.esa.int/gaia

### Tycho-2

Bright-star supplement rows in the bundled atlas (stars above the Gaia bright-end
saturation) are drawn from the Tycho-2 Catalogue (Høg et al. 2000). Freely available;
credit requested.

Upstream: https://www.cosmos.esa.int/web/hipparcos/tycho-2

### Hipparcos

Bright-star supplement rows are also drawn from the Hipparcos Catalogue (ESA 1997).
Credit: ESA Hipparcos mission.

Upstream: https://www.cosmos.esa.int/web/hipparcos

### Named-star reference

A small bundled reference of the brightest classically-named stars — proper name, Bayer
designation, and approximate J2000 position and magnitude — is used only to attach human
names to matched stars in the display. It is not used for solving or measurement.

Positions and names are of HYG-database lineage (Hipparcos and Yale Bright Star Catalog).
Attribution:

- HYG Database — Astronexus (David Nash): https://www.astronexus.com/hyg
- Hipparcos Catalogue — ESA: https://www.cosmos.esa.int/web/hipparcos
- Yale Bright Star Catalog: http://tdc-www.harvard.edu/catalogs/bsc5.html

---

## Fonts

Self-hosted web fonts, shipped unmodified. The SIL Open Font License 1.1 text is bundled
with the fonts (`public/fonts/OFL.txt`) and surfaced in the About / licenses screen.

| Font | License (SPDX) | Upstream |
|---|---|---|
| Inter | OFL-1.1 | https://github.com/rsms/inter |
| JetBrains Mono | OFL-1.1 | https://github.com/JetBrains/JetBrainsMono |

---

## Build tools

Listed where the tool's license imposes terms on the distributed artifact.

### NSIS

The Windows installer is produced with NSIS, used unmodified. The NSIS core is licensed
under the zlib/libpng license; the installer's LZMA compression module is licensed under
CPL-1.0, which applies to that module's source only. The shipped installer executable
embeds the NSIS compression stub.

Upstream: https://nsis.sourceforge.io
