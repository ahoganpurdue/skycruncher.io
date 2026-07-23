/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BINARY LAYOUT CONTRACTS — LAW 7 declaration seed (DECLARATION-ONLY)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md LAW 7 (Memory Boundary Layout): strides/indexing/units on an
 * enumerated binary boundary change ONLY with a same-commit update to THIS
 * file, citing the entry. This module is the SEED: one typed entry per
 * enumerated boundary, transcribed from the CLAUDE.md UNIT/FORMAT TRAPS +
 * ROUTING table. It is DECLARATION-ONLY — NO consumer is rewired by its
 * existence; the codegen + golden-vector battery (check_layout_contracts.mjs)
 * is the decoder-cutover-#14 session opener, NOT this commit.
 *
 * HONESTY DISCIPLINE (LAW 3): every fact here is either (a) transcribed from an
 * authoritative source (CLAUDE.md traps, the FITS/Arrow/wasm specs), or (b)
 * flagged "UNVERIFIED — <where to check>" when it could not be confirmed from
 * code in this pass. Nothing is invented. `goldenVector` is `null` on EVERY
 * entry — the measured reference bytes are NOT MEASURED yet (they land with the
 * decoder cutover). Do not treat any field as a measured guarantee until its
 * golden vector exists and the battery is green.
 *
 * This is surface `binary_layouts` @ 0.1.0 in the unified version manifest
 * (src/engine/versions/surfaces.json).
 */

/** The golden reference bytes are not captured yet (LAW 3: honest-or-absent). */
export const GOLDEN_VECTOR_STATUS = 'NOT MEASURED — lands with decoder cutover #14' as const;

/**
 * This layout-contract surface's version (mirrors surfaces.json binary_layouts).
 * 0.2.0 (additive, decoder-rail pre-cutover): widened `goldenVector` from the
 * seed's always-null to `GoldenVectorRef | null` and added the `rawler_cfa`
 * boundary — the FIRST entry carrying a MEASURED golden pointer.
 * 0.3.0 (additive, atlas reproduce-first): the `atlas_rows` boundary graduates
 * seed→MEASURED — its golden vector is BORN (SHA-256 fingerprint of the frozen
 * deep catalog, byte-proved 38/38 regenerable by tools/atlas/verify_atlas_repro.mjs).
 * The atlas_rows strideRule/units are also corrected from the 0.1.0 hedge (shipped
 * canonical = JSON TEXT, Arrow = twin; hybrid Gaia-deg/HYG-hours rows; HYG faint
 * end ≈ mag 21). The other six 0.1.0 seed entries stay null/NOT-MEASURED.
 * 0.4.0 (additive, stage-modular test environment wave): adds the
 * `seam_capsule` boundary — the on-disk per-stage session-state capsule
 * (raw LE .bin per typed array + JSON sidecar) written by the env-gated
 * pipeline/seam_capture.ts and replayed by the stage_replay executor.
 * 0.5.0 (additive, confirm-lane Gaia-only cutover 2026-07-22): adds the
 * `g15u_stars_arrow` boundary — the greenfield quad-index's stars.arrow
 * (Gaia DR3 G≤15, 4-column single-batch Arrow IPC) consumed by the post-solve
 * confirm/deep-verify lane behind VITE_CATALOG_G15U (g15u_catalog.ts).
 */
export const BINARY_LAYOUTS_VERSION = '0.5.0' as const;

/**
 * A MEASURED golden-vector pointer: the committed manifest that records the
 * reference hashes (the raw `.bin` bytes are local/regenerable, never
 * committed). Introduced at 0.2.0 for the decoder-cutover rail.
 */
export interface GoldenVectorRef {
    /** Repo-relative path to the committed golden manifest (the pointer). */
    manifestPath: string;
    /** md5 of the boundary's serialized reference bytes, as in the manifest. */
    md5: string;
    /** What exactly was hashed (serialization + dims + byte count). */
    serialization: string;
}

export interface BinaryLayoutEntry {
    /** Stable boundary id. */
    name: string;
    /** Contract version for THIS boundary (independent of the surface version). */
    version: string;
    /** Element/record datatype at the boundary. */
    dtype: string;
    /** Precise stride / indexing / packing rule (the load-bearing sentence). */
    strideRule: string;
    /** Byte order at the boundary. */
    endianness: string;
    /** Physical/units meaning of the values (non-empty on every entry). */
    units: string;
    /** Parity / coordinate convention (image y-down, WCS, RA hours-vs-deg, …). */
    coordinateConvention: string;
    /** Measured reference pointer, or null while NOT MEASURED (0.1.0-seed entries). */
    goldenVector: GoldenVectorRef | null;
    /** Golden-vector provenance (or why it is null — honest status string). */
    goldenVectorStatus: string;
    /** Free-form provenance + trap notes + where the authoritative code lives. */
    notes: string;
}

/**
 * One entry per enumerated LAW-7 boundary. ORDER is not load-bearing; the
 * `name` is the citation key used in handoffs ("LAW 7: binary_layouts#<name>").
 */
export const BINARY_LAYOUTS: readonly BinaryLayoutEntry[] = [
    {
        name: 'libraw_mem_image',
        version: '0.1.0',
        dtype: 'uint16 (RGB16, 3 channels interleaved)',
        strideRule:
            'Interleaved RGB, length = w*h*3; pixel (x,y) channel c at flat index (y*w + x)*3 + c ' +
            '(stride IDENTICAL across decode modes). CONTENT depends on the libraw decode mode, ' +
            'gated by CFA type (metadata_reaper NEEDS_FULL_DEMOSAIC): BAYER (CR2, document mode / ' +
            'noInterpolation:true) = dominant-channel with ~4-7% cross-channel leak (NOT one-hot, ' +
            'NOT CFA/Bayer mosaic). X-TRANS (RAF, full Markesteijn demosaic / noInterpolation:false, ' +
            'owner directive 2026-07-13) = genuinely demosaiced RGB, all 3 channels populated. ' +
            'convertMemImageToRgb DETECTS which (multi-channel-lit + median 2nd/max ratio) and routes ' +
            'accordingly, so consumers need not branch on format. ' +
            'w/h can factor TWO ways; disambiguate via meta/stride coherence, and on a NEAR-TIED ' +
            'coherence prefer the EXACT-meta-match dims (60Da case: a 413.3-vs-411.1 tie mis-picked ' +
            '3468x5196 over the exact 3464x5202 and SHEARED the frame).',
        endianness: 'host-native (Uint16Array copied from libraw-wasm mem_image into the JS heap)',
        units: 'ADU (per-channel 16-bit linear intensity)',
        coordinateConvention: 'image-space, y-down (row-major); +1 parity = mirrored sky — do NOT assert parity sign',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Source: CLAUDE.md UNIT/FORMAT TRAPS. Tie-break rule currently lives in tools/color/rgb_to_xyz.mjs ' +
            '(NOT yet in the shared psf decode lane). This boundary is replaced at decoder cutover #14 (rawler ' +
            'integer demosaic; contract becomes FULL frame + optical-black borders). UNVERIFIED: exact wasm-buffer ' +
            'byte-endianness before the JS-heap copy — check src/engine/pipeline/m1_ingestion + libraw-wasm.',
    },
    {
        name: 'atlas_rows',
        version: '0.2.0',
        dtype: 'hybrid per-row JSON record (Gaia row | HYG row), one object per line',
        strideRule:
            'CANONICAL on-disk form = JSON TEXT (MEASURED 2026-07-11), NOT Arrow. Three shipped file classes under ' +
            'public/atlas: (1) level_1_anchors.json + level_2_pattern.json — PRETTY JSON.stringify(rows,null,2) with ' +
            'CRLF line endings, top-5000/next-5000 Gaia bright stars (mag<10) sorted by mag_g asc. (2) 36 ' +
            'sectors/level_3_sector_0..35.json — MINIFIED, one object per line, exact bytes = ' +
            "'[' + rows.join(',\\n') + ']' (LF): a [Gaia block] then [HYG block], CONTIGUOUS, no interleave. " +
            '(3) 36 sectors/*.arrow value-equivalent TWINS (flag VITE_ATLAS_BINARY, adapter:104) — NOT canonical. ' +
            'HYBRID rows discriminated PER ROW (isGaia = source_id||mag_g defined): Gaia key order ' +
            'id,ra,dec,mag_g,bp_rp,pm_ra,pm_dec,source_id; HYG key order id,[proper],ra,dec,mag,[spect] ' +
            '(proper/spect presence-preserving). Sector id = decIndex*6 + raIndex, raIndex=floor(ra_h/4), ' +
            'decIndex=floor((dec+90)/30) (star_catalog_adapter.getSectorId). Regenerable BYTE-EXACT (38/38) by ' +
            'tools/atlas/verify_atlas_repro.mjs from gaia_vanguard_dr3.csv + the named HYG cells.',
        endianness: 'N/A — UTF-8 JSON TEXT (the canonical form). The .arrow twins are little-endian Arrow IPC (see arrow_seam).',
        units:
            'RA per-row: Gaia rows = DEGREES, HYG rows = HOURS (stored AS-IS, NEVER normalized). Magnitude: Gaia ' +
            'mag_g (Gaia G stuffed into magnitude_V downstream, band=GaiaG); HYG mag. Rounding: ra/dec 4dp, ' +
            'mag/bp_rp 3dp, pm 1dp, source_id Float64 (2^53-lossy, replicated for byte-repro). HYG merge = STRICT ' +
            'mag>6.8, faint end reaches mag ≈ 21 (MEASURED global max — NOT the README/legacy "6.8–10" claim).',
        coordinateConvention:
            'equatorial RA/Dec; RA unit is PER-ROW (Gaia deg / HYG hours). Gaia id always 0 (vanguard CSV has no id ' +
            'col); Sol-filter guarded so id:0 Gaia survive. COORDINATE ledger.',
        goldenVector: {
            manifestPath: 'tools/atlas/atlas_repro_manifest.json',
            md5: 'fc2c4482e9664b0f6456e7428a1f2c2a',
            serialization: 'aggregate md5 of the sorted "path:sha256" lines over the 2 anchors + 36 sectors (byte-exact frozen fingerprint)',
        },
        goldenVectorStatus:
            'MEASURED 2026-07-11 (atlas reproduce-first, step 1) — tools/atlas/verify_atlas_repro.mjs regenerates all ' +
            '38 shipped files BYTE-EXACT (38/38) from gaia_vanguard_dr3.csv + the named HYG cells; the committed ' +
            'manifest records per-file SHA-256 + the aggregate md5. The 338MB raw bytes are gitignored/local-only, ' +
            'so the manifest is the committed pointer (no .bin).',
        notes:
            'Source: CLAUDE.md UNIT/FORMAT TRAPS + ROUTING (Atlas/catalog) + audit ' +
            'test_results/atlas_rebuild_2026-07-11/LAYOUT_TRANSCRIPTION.md. Chain: gaia_vanguard_dr3.csv → ' +
            'tools/generate_star_atlas.ts → tools/atlas/rebucket_sectors.mjs → tools/atlas/merge_hyg_sectors.mjs. ' +
            'BYTE-ORDER FINDING (contradicts the audit "bucketing irrelevant to repro"): the frozen artifact was ' +
            'built with the generator\'s PRE-FIX buggy shard bucketing — order is shard-load-bearing, so the ' +
            'verifier pins ATLAS_LEGACY_BUCKETING; a fixed-generator full regen is content-identical but ' +
            'byte-different (owner rebaseline). SECTOR_LOAD_MAX_RADIUS_DEG=16 gates deep-sector load. Hybrid-row ' +
            'discrimination is a repeat trap.',
    },
    {
        name: 'starplates_blobs',
        version: '0.1.0',
        dtype: 'UNVERIFIED — check tools/starplates/build_release.mjs (release builder)',
        strideRule:
            't0/t1 blobs + a 4-band lost-in-space index (~40.6MB, 4 bands). EXACT blob record stride and band-index ' +
            'layout are UNVERIFIED in this pass — check tools/starplates/build_release.mjs (producer), ' +
            'tools/starplates/publish_r2.mjs (R2 layout), and tools/solverkit (band-index consumer).',
        endianness: 'UNVERIFIED — check tools/starplates/build_release.mjs',
        units: 'catalog star positions (RA/Dec) + magnitude per band — UNVERIFIED per-field unit; check build_release.mjs',
        coordinateConvention: 'equatorial RA/Dec — RA unit (hours vs degrees) UNVERIFIED; check the release builder',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'starplates = the catalog-dataplane name; R2 bucket `starplates`. Bundled-manifest-vs-release mismatch is ' +
            'an owner decision (see memory: starplates R2 standup). This entry is deliberately UNVERIFIED-heavy — the ' +
            'byte layout must be transcribed from the builder BEFORE any consumer rewire (LAW 7).',
    },
    {
        name: 'arrow_seam',
        version: '0.1.0',
        dtype: 'Apache Arrow IPC columnar (per-column validity + data buffers)',
        strideRule:
            'Arrow RecordBatch column buffers per the Arrow spec (bitmap validity buffer + typed data buffer, ' +
            'null-count in the field node). Atlas->Arrow codec: src/engine/pipeline/m6_plate_solve/atlas_arrow_codec.ts; ' +
            'producer: tools/atlas/atlas_to_arrow.mjs; in-memory view: src/engine/core/ArrowMemory.ts. EXACT column ' +
            'schema (field names/types/order) UNVERIFIED here — check atlas_arrow_codec.ts.',
        endianness: 'little-endian (Apache Arrow IPC mandates little-endian buffers)',
        units: 'per-column (positions, magnitudes) — RA-unit hybridity inherited from atlas_rows',
        coordinateConvention: 'equatorial RA/Dec per column (COORDINATE ledger)',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Source: CLAUDE.md ROUTING (Atlas/catalog) + apache-arrow dep. The seam between the catalog store and the ' +
            'solver. UNVERIFIED: whether the shipped sectors are Arrow-IPC or a rebucketed custom blob (see atlas_rows ' +
            '“shipped sectors = 6x6 rebucketed layout”) — reconcile before a stride change.',
    },
    {
        name: 'g15u_stars_arrow',
        version: '1.0.0',
        dtype:
            'Apache Arrow IPC file, SINGLE record batch, 4 columns: ' +
            'ra_deg:Float64, dec_deg:Float64, g_mag:Float32, source_id:Uint64. No validity buffers (null_count 0).',
        strideRule:
            'Columnar (per-column contiguous typed buffers), NOT interleaved. Row i = {ra_deg[i], dec_deg[i], ' +
            'g_mag[i], source_id[i]}. 6,491,802 rows (Gaia DR3 all-sky G≤15). NO in-format compression (apache-arrow ' +
            'JS 21 writer). Consumer: src/engine/pipeline/m6_plate_solve/g15u_catalog.ts (whole-table load+cache, cone ' +
            'filter per query — the tools/psf/g15u_stars.mjs regionStars pattern). Producer: the greenfield quad-index ' +
            'builder (starplates-2026.07-quadidx-g15u; manifest.json .schema field is the authoritative column contract).',
        endianness: 'little-endian (Apache Arrow IPC mandates little-endian buffers)',
        units:
            'ra_deg = RA in DEGREES (UNIT TRAP: the engine catalog convention is HOURS — g15u_catalog.ts converts ' +
            'ra_hours = ra_deg/15 at the boundary); dec_deg = Dec in DEGREES; g_mag = Gaia G magnitude (dimensionless); ' +
            'source_id = Gaia DR3 source id (u64, dimensionless).',
        coordinateConvention:
            'equatorial J2000 RA/Dec, RA in DEGREES on the wire (COORDINATE ledger). Pure Gaia — no per-row deg/hours ' +
            'hybridity (unlike atlas_rows). Band is always GaiaG (never pool with JohnsonV).',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'The CONFIRM/deep-verify lane consumption seam (owner Gaia-only ruling 2026-07-22; VITE_CATALOG_G15U, ' +
            'default OFF). Path resolved via the greenfield index ladder (SKYCRUNCHER_QUADIDX_DIR → storage.json ' +
            'index_root → default; mirrors src-tauri/src/greenfield_solve.rs::resolve_quadidx_dir). REFERENCE BYTES ' +
            'are on D: (not committed) — the g15u manifest records stars.arrow sha256 ' +
            '726677e9d7bfe655481f1268071033965e589108c904ecad85cefdb771995b3e (181,771,274 bytes, rows 6,491,802); a ' +
            'golden-vector manifest is the follow-up when this graduates. LAW 7: any column/stride change updates ' +
            'this entry + g15u_catalog.ts in the same commit.',
    },
    {
        name: 'wgsl_structs',
        version: '0.1.0',
        dtype: 'WGSL struct fields (f32/u32/vecN) on the WebGPU compute path',
        strideRule:
            'WGSL struct member alignment (std140/std430-style): vec3 aligns to 16 bytes, each member padded to its ' +
            'alignment, struct size rounded to the largest member alignment. EXACT field order/padding UNVERIFIED — ' +
            'check the GPU preprocess path (src/engine/pipeline/m3_gpu_preprocess/demosaic_pipeline.ts) and any inline ' +
            'WGSL string literals. SHARED-WGSL HAZARD: one shader consumed by multiple bind layouts — a struct change ' +
            'ripples across every bind group using it.',
        endianness: 'little-endian (WebGPU buffers are little-endian)',
        units: 'pixel intensity / linear channel values (PIXEL ledger)',
        coordinateConvention: 'image-space, y-down (GPU texture/buffer coordinates)',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Source: CLAUDE.md ROUTING + repo gotchas (shared-WGSL hazard). PIXEL ledger — never mixes with COORDINATE ' +
            'math. UNVERIFIED: whether WGSL lives as inline TS string literals or generated from the Rust side.',
    },
    {
        name: 'wasm_typed_array',
        version: '0.1.0',
        dtype: 'Float64/Float32/Uint16 typed arrays across the JS<->wasm (Rust) boundary',
        strideRule:
            'Flat typed-array crossings into src/engine/wasm_compute (e.g. refine_stars_lm star stamps + LM params, ' +
            'solver_planar inputs). Packing = the Rust export’s expected order; values are COPIED across the linear- ' +
            'memory boundary (a zero-copy view is invalidated by any wasm realloc). EXACT per-export packing UNVERIFIED ' +
            '— check src/engine/wasm_compute/src/lib.rs exports.',
        endianness: 'little-endian (wasm linear memory is little-endian by spec)',
        units: 'mixed per-export — pixel ADU (stamps), pixels (coords), arcsec/deg (params)',
        coordinateConvention:
            'native pixel grid, y-down — PSF stamps measured on the NATIVE grid, never resampled before measurement (LAW 1)',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Source: CLAUDE.md LAW 1 + LAW 5 + ROUTING (PSF). Any Rust signature change requires ' +
            '`wasm-pack build --target web` in src/engine/wasm_compute/ AND owner sign-off (LAW 5); pkg/ is gitignored.',
    },
    {
        name: 'fits_io',
        version: '0.1.0',
        dtype: 'FITS BITPIX-typed image data (8/16/32/-32/-64) + 80-byte ASCII header cards',
        strideRule:
            'Row-major image array of NAXIS1 x NAXIS2 in the BITPIX dtype; header keyword cards are 80 bytes each. ' +
            'CRVAL RA/Dec keywords are in DEGREES at the file boundary and converted to HOURS internally immediately. ' +
            'There is NO single chokepoint for this conversion (corrected 2026-07-10 — the prior claim here was ' +
            'false): the live sites are (1) tools/stack/fits_io.mjs (stack lane, read AND write — its own docstring ' +
            'documents the two directions), (2) src/engine/pipeline/m1_ingestion/fits_decoder.ts:403 (engine ingest, ' +
            'hard.ra_hint = ra / 15), (3) src/engine/pipeline/stages/package.ts:77 + :101 (receipt export, ' +
            'crval[0] * 15 on both the fitted and synthesized branches). Downstream writers (export/fits_writer.ts, ' +
            'export/asdf_writer.ts) consume the ALREADY-converted receipt.wcs and must NOT convert again.',
        endianness: 'big-endian (FITS standard: image + BINTABLE data are big-endian)',
        units:
            'CRVAL RA/Dec = DEGREES at the file; internal crval[0]/catalog RA = HOURS. Converted at the enumerated ' +
            'sites in strideRule — NOT one seam; audit every site when changing units.',
        coordinateConvention:
            'FITS WCS — CRPIX is 1-indexed, CRVAL in degrees. Internal keys are crpix[0]/crpix[1] (never CRPIX1). COORDINATE ledger.',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Source: CLAUDE.md UNIT/FORMAT TRAPS (RA HOURS internally, DEGREES at boundary) + ROUTING. The HOURS-vs- ' +
            'DEGREES conversion is the classic hours-cost trap. A rewire that trusts a "single chokepoint" would miss ' +
            'fits_decoder.ts:403 — exactly the units bug LAW 7 exists to prevent. Consolidation of the three ' +
            'conversion sites into a true chokepoint = FOLLOW-UP (not done; this entry documents reality, not intent).',
    },
    {
        // ── DECODER-CUTOVER #14 — LIVE DEFAULT since the 2026-07-11 flip ──
        // Rawler is the DEFAULT RAW arm (isRawlerDecoderEnabled defaults TRUE);
        // this entry is the live contract. The libraw_mem_image entry above is
        // the retained COLD PATH's contract (VITE_DECODER_RAWLER=0, owner
        // cold-path ruling — never delete).
        name: 'rawler_cfa',
        version: '0.1.0',
        dtype: 'uint16 (single-channel Bayer CFA mosaic, cpp=1, bps=16)',
        strideRule:
            'FULL sensor frame INCLUDING optical-black borders, length = width*height (cpp=1); photosite (x,y) at ' +
            'flat index y*width + x. Color of (x,y) = the 2x2 CFA tile at phase (y&1)*2 + (x&1), tile read at FULL- ' +
            'frame origin (0=R,1=G,2=B; rawler cfa.color_at). Bundled T6: GBRG 5344x3516 (active-origin view: RGGB). ' +
            '5D-MkIII: RGGB 5920x3950. Active-area / recommended-crop are SEPARATE rects carried in the contract — ' +
            'do NOT pre-trim before measurement (the OB borders are the per-frame dark anchor, ' +
            'DARK_CALIBRATION_POLICY §1 Reading B).',
        endianness:
            'host-native Uint16Array at the wasm boundary (wasm linear memory is little-endian by spec); golden ' +
            'hashes serialize explicit LE u16 (DecodedRaw.cfa_full_le).',
        units:
            'raw ADU (linear, with the per-frame black pedestal; NOT black-subtracted, NOT scaled). Per-channel ' +
            'black levels (bayer [R,G,B,E] tile) + white/saturation level + WB coeffs (RGBE, absent channel = null) ' +
            'ride the contract metadata — blacklevel varies PER FRAME (measured: 2046 on IMG_1653 vs 2045 on the ' +
            'bundled demo CR2, same camera).',
        coordinateConvention:
            'image-space, y-down (row-major), FULL-frame pixel coordinates (active/crop/OB rects share this origin). ' +
            'CFA phase = (y&1)*2 + (x&1). Parity/sky-mirror sign NOT asserted.',
        goldenVector: {
            manifestPath: 'test_results/decoder_prestage/golden/IMG_1653.CR2.golden_manifest.json',
            md5: '968381f814547668c6a85b75f31038f2',
            serialization: 'full-frame CFA u16 LE, 5344x3516, 37,579,008 bytes (IMG_1653.CR2)',
        },
        goldenVectorStatus:
            'MEASURED — pre-stage native probe (tools/rawlab/rawler_probe, bit-identical vs the frozen row-91 ground ' +
            'truth) AND reproduced at wasm runtime by src/engine/wasm_decode (decoder-rail session 2026-07-10). ' +
            'Companion demosaic-luma golden (integer bilinear, u32 LE) md5 4f7560079a37316dae7595006bc46e1f lives in ' +
            'the same manifest. The .bin bytes are LOCAL/regenerable; the manifest is the committed pointer.',
        notes:
            'Producer: rawler 0.7.2 decode(RawSource::new_from_slice, RawDecodeParams::default) in ' +
            'src/engine/wasm_decode (wasm32; rayon auto-degrades single-thread + deterministic; uuid js feature is ' +
            'the sole wasm32 fix). TS consumer: src/engine/pipeline/m1_ingestion/rawler_decoder.ts (decodeCfaContract ' +
            '= the format-registry COMING CFA CONTRACT entry fn; decodeRawlerForPipeline = the flag-ON m1 payload: ' +
            'integer-bilinear demosaic of the ACTIVE area, phase-correct via absolute coords, OB clamped out of ' +
            'science pixels, additive `rawler` record carrying levels/WB/OB harvest). At cutover this entry ' +
            'supersedes libraw_mem_image (which already carries the "replaced at decoder cutover #14" note).',
    },
    {
        // ── TAURI NATIVE IPC (JS <-> Rust/wgpu) — demosaic_native command ──
        // ENUMERATED 2026-07-11 (owner order, efficiency review §14c): converting
        // the demosaic_native payload from JSON number-array smuggling to raw
        // little-endian binary IPC made this crossing a genuine binary boundary,
        // so it is enumerated here. TRANSPORT-ONLY: dtype/stride/endianness/units
        // are unchanged vs the prior JSON path — only the wire encoding changed.
        name: 'tauri_native_ipc',
        version: '0.2.0',
        dtype: 'Bayer CFA uint16 (input body) + interleaved RGB float32 (output body) across the ' +
            'JS<->Tauri-native (Rust/wgpu) invoke boundary — demosaic_native',
        strideRule:
            'INPUT: flat single-channel Bayer mosaic, length width*height (cpp=1), photosite (x,y) at ' +
            'flat index y*width + x; carried as a raw byte body (Tauri InvokeBody::Raw), dims in the ' +
            "invoke 'width'/'height' headers. OUTPUT: interleaved RGB, length width*height*3, pixel " +
            '(x,y) channel c at (y*width+x)*3 + c; returned as a raw byte body (tauri::ipc::Response). ' +
            'TRANSPORT CHANGE 2026-07-11: was JSON number arrays (Array.from -> InvokeBody::Json, ' +
            'Vec<u16> in / Vec<f32> out); now raw LE bytes both directions (retires the 300-700MB ' +
            'Array.from round-trip). OUTPUT-LAYOUT CORRECTION 2026-07-21 (v0.2.0): the output is ' +
            'interleaved RGB (w·h·3), NOT RGBA (w·h·4). The prior 0.1.x entry claimed w·h·4, but the ' +
            'demosaic shader has always written w·h·3 (outIdx=(y*w+x)*3) and the JS consumer ' +
            '(ArrowMemory.createRgbBuffer) has always expected RGB — the RGBA claim was a spec/impl ' +
            'mismatch on a native path that never actually executed (the Rust pipeline panicked at ' +
            'creation until the 2026-07-21 kernel fix). Now aligned to the real RGB w·h·3 layout. ' +
            'Gated/rare native path: fires only under Tauri + wgpu with NO explicit CFA params (native ' +
            'uses the parameterized shader with Canon-RGGB DEFAULT params baked into Rust).',
        endianness:
            'little-endian both directions (u16 in, f32 out). JS sends a Uint8Array view over the ' +
            'Uint16Array (byteOffset/byteLength respected); Rust decodes via u16::from_le_bytes and ' +
            'serializes via f32::to_le_bytes (host-endian-agnostic). All Tauri desktop targets ' +
            '(x86_64/aarch64) are LE, so the wire bytes equal host order.',
        units:
            'INPUT: raw ADU (linear Bayer mosaic, native grid). OUTPUT: demosaiced linear RGB channel ' +
            'intensities (PIXEL ledger, black-subtracted / WB-scaled / normalized by the shader). Units ' +
            'unchanged vs the prior JSON path; only the output channel count (RGBA->RGB) was corrected.',
        coordinateConvention:
            'image-space, y-down, native pixel grid (PIXEL ledger — never mixes with COORDINATE math). ' +
            'CFA phase = RGGB/Canon (cfa_offset 0,0) via the Canon-RGGB DEFAULT params the native side ' +
            'bakes into the parameterized shader (demosaic_bayer_param.wgsl). Parity/sky-mirror NOT asserted.',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Producer: src-tauri/src/lib.rs demosaic_native (raw InvokeBody::Raw body + width/height ' +
            'headers -> tauri::ipc::Response) -> native_gpu::demosaic::DemosaicPipeline (wgpu, ' +
            'demosaic_bayer_param.wgsl). Consumer: src/engine/core/NativeGpuBridge.ts demosaic ' +
            '(Uint8Array body + headers -> ArrayBuffer -> Float32Array). Mirrors the query_catalog_v2 ' +
            'binary-IPC pattern (the in-repo good pattern, also tauri::ipc::Response). Source: owner order ' +
            '(efficiency review §14c) + docs/NEXT_MOVES.md §14.c. v0.2.0 (2026-07-21): the native kernel ' +
            'fix retargeted the wgpu pipeline to the parameterized shader and corrected the output layout ' +
            'from the (never-executed) RGBA w·h·4 claim to the real interleaved-RGB w·h·3 the shader ' +
            'writes; the bind-group layout (uniform@0 + read-storage raw@1 + storage rgb@2) now matches ' +
            'the shader interface so the pipeline no longer panics at creation. First native-vs-CPU / ' +
            'native-vs-browserGPU ULP numbers measured by the desktop test rail ' +
            '(tools/desktop_rail; test_results/desktop_rail_2026-07-21). HONEST: golden BYTES still NOT ' +
            'MEASURED as a headless layout-contract vector — the boundary needs a packaged Tauri + wgpu ' +
            'runtime; the rail exercises it live but does not bank a fixed golden vector here.',
    },
    {
        // ARROW CARRIER program, Phase 1 (packages/toolchest): the TABULAR receipt
        // products serialized as Apache Arrow IPC FILE bytes for external consumers
        // (pyarrow/pandas, desktop, dashboards). Tables ride Arrow; rasters ride
        // typed arrays (NEVER mixed). ADDITIVE, consumer-side — reads the receipt,
        // changes NO engine behaviour, does NOT touch the atlas `arrow_seam`.
        name: 'toolchest_arrow_export',
        version: '0.1.0',
        dtype:
            'Apache Arrow IPC FILE (Feather v2) — per-column typed data buffers (Float64/Int32/Utf8). NON-NULLABLE ' +
            'columns carry NO validity bitmap: makeData allocates a nullBitmap ONLY when nullCount>0, so the named ' +
            '6.44MB bitmap-tax debt is avoided by construction.',
        strideRule:
            'One Arrow Table per tabular product, SINGLE RecordBatch: matched_stars (solution.matched_stars), ' +
            'detections (signal.clean_stars), forced_confirmed (deep_confirmed.confirmed_stars), run_summary ' +
            '(solution scalars + confirm_status, single row). Column order + field metadata are fixed by ' +
            'packages/toolchest/src/tables.ts. gaia_id is carried as Utf8 (dodges 2^53 number rounding — but a ' +
            'NUMERIC receipt id is ALREADY pre-rounded upstream at JS parse; the real fix belongs in the receipt producer).',
        endianness: 'little-endian (Apache Arrow IPC mandates little-endian buffers).',
        units:
            'PER-FIELD, labelled in Arrow field metadata (the `units` key on every Field). THE TRAP: ' +
            'run_summary.ra_hours is in HOURS; matched_stars.ra_deg is in DEGREES — both carried, both labelled. ' +
            'Also pixel_scale arcsec/px, residuals arcsec, positions pixels (image y-down), theta radians, mag/bv ' +
            'magnitudes, flux/peak ADU.',
        coordinateConvention:
            'equatorial RA/Dec with RA unit PER-FIELD (HOURS for the solve centre, DEGREES for catalog matched ' +
            'stars); pixel positions image-space y-down; parity carried verbatim as text, sign NOT asserted.',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'ARROW CARRIER program Phase 1 — the forcing consumer that ends Arrow-as-ceremony. Producer: ' +
            'packages/toolchest/src/tables.ts (exportAllTables) over the runWizardPipeline receipt ' +
            '(tools/api/headless_driver.ts; stages/package.ts exportPacket; receipt.version = RECEIPT_SCHEMA_VERSION, ' +
            'read at runtime, never mirrored). Committed golden .arrow fixtures + round-trip/interop tests live under ' +
            'packages/toolchest (fixtures/*.arrow, src/__tests__). goldenVector is null/NOT-MEASURED here: the ' +
            'committed fixtures are the de-facto golden vectors, pinned byte-identical to the live export by ' +
            'interop_fixture.test.ts — a formal golden-manifest md5 entry is the P2 followup. DISTINCT from ' +
            '`arrow_seam` (the atlas->solver catalog store): this is the receipt->consumer export seam.',

    },
    {
        // ── SEAM CAPSULE (stage-modular test environment wave, 2026-07-12) ──
        // The on-disk per-stage session-state capsule written after every
        // withStage completion when CAPTURE_SEAMS=1 (default OFF; capture-off
        // path is a dead branch — see pipeline/seam_capture.ts inertness note).
        // Layout: <root>/<frame_sha>/<seq>_<stage>/capsule.json + <field>.bin.
        name: 'seam_capsule',
        version: '0.1.0',
        dtype: 'per-buffer float32|uint16|uint8 raw arrays + JSON sidecar (capsule.json)',
        strideRule:
            'flat row-major, dims from sidecar shape; luminance w·h; interleaved RGB w·h·3; NO header in ' +
            '.bin — sidecar is sole layout authority; sha256 verified on load',
        endianness: 'little-endian',
        units: 'per-buffer units field, mandatory',
        coordinateConvention:
            'image-space y-down native grid (LAW 1: PIXEL ledger in .bin; COORDINATE ledger inline in ' +
            'sidecar JSON)',
        goldenVector: null,
        goldenVectorStatus: GOLDEN_VECTOR_STATUS,
        notes:
            'Producer: src/engine/pipeline/seam_capture.ts (captureSeam — env-gated, sidecar written ' +
            'stable-stringify-sorted + tmp→rename; buffers snapshotted synchronously at the seam before ' +
            'any await). Consumer: tools/testkit stage_replay executor (stage_replay.mjs — loads the ' +
            'post-(N−1) capsule, runs the real stage fn, compares against the post-N capsule; binary side ' +
            'sha256-then-byte-equal, JSON side Object.is per number). Sidecar carries capsule_schema_version ' +
            '1.0.0 + the imported RECEIPT_SCHEMA_VERSION and BINARY_LAYOUTS_VERSION (generative, never ' +
            'mirrored). Default root D:/AstroLogic/test_artifacts/seams (storage law: K: forbidden for ' +
            'large binaries); env SEAM_CAPTURE_ROOT overrides for tests. Golden status per the frozen seam ' +
            'contract: NOT MEASURED — the first frozen capsule bank lands with the capture builder wave ' +
            '(the goldenVectorStatus field uses the canonical NOT-MEASURED const because the layout ' +
            'battery structurally requires it for null-goldenVector entries).',
    },
] as const;
