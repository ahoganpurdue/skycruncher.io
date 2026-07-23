# SkyCruncher — Full Pipeline Step Map (narrative)

> GENERATED from `tools/dag/steps/steps_map.json` (map v1.0, 2026-07-17) by `tools/dag/steps/render_narrative.mjs`. Curated / judgment-derived, validator-gated (NOT drift-gated). Do not hand-edit — edit the map and regenerate.

Full-pipeline step map v1.0, assembled from the five domain segments (A upload->solve, B calibration/refinement, C photometry/science, D packaging/export, E interface arms + open traces). ONE unified flow with file-type tags on steps (never parallel per-type chains). Per-step schema identical to the segments; only top-level order (global 1..24), cross-segment wiring edges, and the carried ruling-1 flag on step:entry were changed by the assembler — no step prose was re-derived. Confirm (upload->solve) is drawn as its own closing beat per ruling 7 while the runtime emits forced_confirm LAST (segment C's emission-order-inversion flag, kept verbatim). Packaging/export (D) is the terminal chapter but is on-demand: it runs at export/download time (or when the headless driver writes), NOT as a receipt-observed runtime stage (chapter note below; segment D placement flag carried unchanged).

Assembled from: `test_results/dag_procedure_draft/segments/segment_A.json`, `test_results/dag_procedure_draft/segments/segment_B.json`, `test_results/dag_procedure_draft/segments/segment_C.json`, `test_results/dag_procedure_draft/segments/segment_D.json`, `test_results/dag_procedure_draft/segments/segment_E.json`. Rulings: DEC-2026-07-17-01 (segment A Phase-0 rulings, applied in segment_A.json).

---

## Chapter 1 — Entry — how a frame enters the instrument  *(segment E)*

### 1. Choose how a frame enters the instrument
*interface · code-derived · fits, cr2-raw, jpeg-tiff, interface*

Five surfaces can hand a frame to the pipeline, and every one funnels into the SAME single-frame engine (a fresh OrchestratorSession -- the one live stateful orchestrator; the auto-path orchestrator was deleted). The interactive wizard, the batch/folder queue, the Node headless driver, the MCP surface, and the desktop shell are entry ARMS, not separate pipelines: each constructs a session, steps it load->extract->metrology->solve->calibrate->integrate, and gets a receipt built the same way. Two facts hold across all arms. First, a session is single-use: it releases (nulls) the raw sensor buffer right after ingest, so re-entering step 1 on a live session is forbidden by design -- a re-run is always a fresh session on the same bytes. Second, the wizard's progress is a set of LOAD-BEARING status strings (ingest / signal / verification / solver / calibration) that the UI polls; they are a contract, not free text, and their exact values must be preserved. Cloud-folder connectors (Drive, Dropbox) are registered as UI cards but are honest STUBS, not a live path.

**Visible at this point:** raw file bytes · which entry arm / interface was used · polled stage status string (wizard arms)

*Anchors: `stage:load`, `src/engine/pipeline/orchestrator_session.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): five sibling interface arms CONFIRMED (each a real how-do-I-bring-a-frame-in decision). [orig question] the five entry arms (interactive wizard, batch/folder queue, headless driver, MCP surface, desktop shell) are drawn here as sibling interface steps converging into the one pipeline. Confirm this granularity vs. folding them back into a single 'Bring a frame in' step with arm tags (the v2 step:upload treatment).
- MERGE (2026-07-17): step:upload (segment A / v2 'Bring a frame into the tool') is superseded by this entry step (segment E's fuller entry-arm derivation); segment A's ruling-1 flag is carried verbatim below so all seven DEC-2026-07-17-01 rulings remain in the merged map.
- RULED 2026-07-17 (DEC-2026-07-17-01): the batch/folder arm is drawn as a convergence into the single-frame flow and tagged [NOT CONFIRMED]; segment E traces whether it runs the identical OrchestratorSession path end-to-end. [orig question] the batch/folder arm is described as converging into the single-frame flow from metadata onward; that convergence is an architectural inference, not traced end-to-end in code.

#### 1.1. Interactive wizard (single-frame)
*interface · code-derived · fits, cr2-raw, jpeg-tiff, interface*

The default surface: a drag-drop / file-picker upload zone that accepts one frame, plus a 'load the bundled sample' shortcut and an optional target-hint box. Selecting a file constructs a fresh OrchestratorSession and walks the six wizard steps in the browser, driving the interactive step-by-step UI. This arm surfaces the polled status strings the UI contract depends on: step 1 logs the status string 'ingest' (RUNNING then SUCCESS), even though the receipt STAGE record for step 1 is 'load' and the decode substage inside step 2 is 'extract.decode' -- the token 'ingest' lives in the UI status layer, not the receipt stage ids. Because the session frees its raw buffer after ingest, the wizard cannot re-enter step 1; re-solving reloads the file into a new session.

**Visible at this point:** single chosen frame (drop / picker / bundled sample) · optional target hint {label, ra_hours, dec_degrees} · polled status strings: ingest -> signal -> verification -> solver -> calibration

*Anchors: `src/engine/ui/MainUpload.tsx`, `src/engine/ui/IngestionStep.tsx`, `src/engine/pipeline/orchestrator_session.ts`*

**Flags:**

- ALIAS NOTE (segment E): the UI status string 'ingest' is emitted by step 1 (logStage 'ingest'), while the receipt stage record for step 1 is 'load' and the decode substage is 'extract.decode'. The dag_base node stage:ingest is a legacy file-derived duplicate of stage:extract.decode -- see narrative_E.md 'ENRICHMENT LEDGER EDIT SPEC'.

#### 1.2. Batch / folder queue
*interface · code-derived · fits, cr2-raw, jpeg-tiff, interface, batch*

The dashboard's solve-queue arm ingests many frames from a mapped source and solves them ONE AT A TIME. The trace is now confirmed end-to-end: each queued file gets a FRESH OrchestratorSession and is stepped step1_Load -> step2_Extract -> step3_Metrology -> step4_Solve -> step5_Calibrate -> step6_Integrate -- exactly the sequence the Node headless driver runs, described in the runner's own header as 'the browser lane'. Runs are strictly sequential (never parallel -- solves are memory-heavy and the pinned byte-identity assumes an undisturbed run) and a bad frame cannot derail the loop: a thrown stage becomes a per-row 'failed' outcome. A failed/partial run (step 5 throws when there is no lock, so step 6 never fires) gets a synthetic run_finished{ok:false} emitted on the session's PUBLIC bus so the partial run still flushes a capture record and stays replayable; this wrapper never forks the bus and never mutates the solve, so the pinned reference solves stay byte-identical -- it runs only in the queue, never the wizard.

**Visible at this point:** queued rows with per-file state (queued/running/solved/failed) · per-row honest stage note (real stage label off the bus) · per-row runId + frameSha + format

*Anchors: `src/engine/ui/dashboard/solve_queue/queue_runner.ts`, `src/engine/ui/dashboard/solve_queue/SolveQueuePane.tsx`, `src/engine/ui/dashboard/solve_queue/queue_state.ts`*

**Flags:**

- TRACE RESOLVED (segment E, ruling 1): the batch/folder queue runs a FRESH OrchestratorSession per file, stepped load->extract->metrology->solve->calibrate->integrate IDENTICALLY to the headless driver (queue_runner.ts:6-11,106-164). It does NOT diverge from the single-frame path. The v2 [NOT CONFIRMED] batch tag should LIFT in assembly; keep the 'batch' file-type-style tag so the convergence stays visible.

##### 1.2.1. Pick the batch source
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

The queue's source is re-mappable behind one connector interface, and the seam honestly surfaces each source's availability. Live sources: dropped files, a re-mappable local folder (File System Access API in the browser, native dialog on desktop), the intake-lane folder (fetch_intake output layout), and the bundled repo/demo frames (the two pinned reference captures). Each folder connector enumerates only its immediate file children and keeps only frames the format registry recognizes, with LAZY byte access -- a file's bytes are read exactly when its row runs, never eagerly. The Google Drive and Dropbox cards are explicit STUBS: their status is 'stub', their pick() rejects with a typed ConnectorStubError rather than fabricating a file, and wiring the real connector is a status swap plus a pick() body with no change to the queue or runner (real OAuth is post-Monday, drive.file + Google Picker / the Dropbox Chooser -- never a broad readonly scope). A browser lacking the directory API reports 'unavailable', honest rather than hidden.

**Visible at this point:** connector cards with status ready | unavailable | stub · chosen SourceFiles (name, size, lazy read) · STUB rejection notice for cloud connectors

*Anchors: `src/engine/ui/dashboard/solve_queue/connectors.ts`*

#### 1.3. Headless driver (Node filepath arm)
*interface · code-derived · fits, cr2-raw, interface, headless*

With no UI, runWizardPipeline reads a file straight off disk and drives the REAL wizard in Node: it boots the compiled wasm, installs an fs-backed atlas loader, constructs the same OrchestratorSession, and steps step1_Load..step6_Integrate -- returning a receipt that is IEEE bit-identical to the browser wizard export. This is the arm every apispec/runspec and run.mjs exercises, and it feeds the (env-gated, default-off, post-receipt) Arrow table and community-push sinks. It supports FITS and camera RAW (the old 'FITS lane only' scoping was retired 2026-07-11). It hashes the source bytes ONCE before decode (the libraw arm transfers/detaches the buffer) so a no-solve frame can still be identified. A frame that produces no geometric lock does not throw at the step-5 guard: this entry emits run_finished{ok:false} and returns an honest FAILURE receipt (exportFailurePacket) -- a headless-entry-scoped branch that leaves the SOLVED path (both pinned reference solves + the sacred apispec gates) byte-identical by construction.

**Visible at this point:** receipt value-identical to the browser export · honest no-solve failure packet (stageOfDeath, stageTimings, frameSha256) · optional Arrow dir / community push (env-gated, default OFF)

*Anchors: `tools/api/headless_driver.ts`, `src/engine/pipeline/orchestrator_session.ts`*

#### 1.4. MCP surface (agent / connector arm)
*interface · code-derived · fits, interface, mcp, public-later*

A Model Context Protocol server exposes the headless solve API to an MCP client (Claude Desktop / Claude Code, and -- over a streamable-HTTP transport -- a claude.ai custom connector). It is a thin conversational/programmatic front door OVER the headless driver, NOT a parallel pipeline: solve_fits spawns the real run.mjs -> runWizardPipeline solve (always a FRESH real solve, no caching that could serve a stale receipt), inspect_receipt is a read-only dot-path projection over a saved receipt (absent paths return a MISSING sentinel, never a fabricated value), draft_annotation returns a TESTIMONY draft that is never persisted (only the step-7 'Confirm & attach' UI action promotes it, and the block is string-only, never parsed into the solve), and instrument_status / rig_profiles / list_widgets / render_widget / the CSL thesis tools round out the surface. The stdio and remote transports share ONE tool registry (zero duplicated logic). The remote transport requires auth on every request, defaults to a READ+SOLVE allowlist with the write tools (thesis_submit / thesis_stamp / draft_annotation) excluded until the owner opts in, and a remote-triggered solve takes the cross-session heavy-lane lock at concurrency 1, failing closed with a busy error.

**Visible at this point:** solve_fits compact summary (solved?, ra_hours, dec, scale, matched, confidence, schema version) · inspect_receipt projection (MISSING for absent paths) · draft_annotation proposal (requires_user_confirmation) · remote allowlist = read+solve; write tools local-only

*Anchors: `tools/mcp/server.mjs`, `tools/mcp/remote_server.mjs`, `tools/api/headless_driver.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): included as first-class interface step, developer-surface badged (public-later intent). [orig question] the MCP surface is a developer/agent + public-later connector surface (read+solve remote allowlist; write tools local-only). Confirm whether it appears in the user-facing procedure map or is footnoted as a non-wizard programmatic surface.
- HONEST CAVEAT (segment E): the MCP solve_fits tool restricts inputs to .fit/.fits/.fts by its OWN runSolve guard (server.mjs:112-114), even though the underlying runWizardPipeline supports camera RAW headless. This is a surface-scope choice, not a pipeline limitation.

#### 1.5. Desktop / Tauri shell
*interface · code-derived · cr2-raw, interface, desktop*

The desktop build wraps the SAME web wizard and batch queue in a Tauri shell -- the entry experience is the browser arm, so no separate pipeline exists. Its one interface-distinct behavior is folder access: the native folder picker doubles as the filesystem-scope GRANT (owner ruling 2026-07-10 -- the capability file configures no fs scope; picking a folder adds exactly that folder plus its immediate children to the scope, persisted across restarts), and it is adapted to the same directory-handle shape the browser uses so the connector seam is identical across browser and desktop. Separately, a native GPU demosaic can be dispatched over a Tauri IPC boundary as a RARE fallback taken only when no color-filter pattern is supplied; that boundary carries raw little-endian bytes (16-bit Bayer in, 32-bit-float RGBA out) and assumes Canon RGGB. It is a DECODE-internal transport, not an app entry surface -- cross-referenced here, owned by the decode step.

**Visible at this point:** same wizard + queue UI as the browser · native folder pick = persisted fs-scope grant · (decode-internal) native GPU demosaic IPC on the no-CFA fallback

*Anchors: `src/engine/ui/dashboard/solve_queue/connectors.ts`, `boundary:tauri_native_ipc`, `src/engine/core/NativeGpuBridge.ts`*

**Flags:**

- Cross-ref: boundary:tauri_native_ipc (native GPU demosaic) is a decode-internal boundary, not an entry surface -- its operational detail belongs to the Decode step (segment A/B), not here.

---

## Chapter 2 — Upload → Solve  *(segment A)*

### 2. Read the frame's metadata
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

Before any pixel is decoded, the tool reads the file's own metadata and establishes what it can trust. It is deliberately honest-or-absent: nothing is invented to be helpful. Format, instrument fields, and two independent trust gates (clock, location) are resolved here; the values flow into the receipt's provenance at packaging time (this step writes no receipt block of its own).

**Visible at this point:** detected format id + isRaw flag · camera/lens model · focal length, aperture, ISO, exposure · timestamp + timestamp_source · gps_lat/lon + gps_source · derived Julian Date · raw EXIF/header tag dump

*Anchors: `stage:load`, `src/engine/pipeline/m1_ingestion/metadata_reaper.ts`*

#### 2.1. Identify the container format
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

The format is read from the file's magic bytes, not its extension. A camera raw's TIFF+CR signature is checked before the generic TIFF fallback so it cannot be mis-routed. The result also sets a photometry tier: FITS and camera raw can feed calibrated photometry, an already-rendered JPEG/TIFF is flagged approximate.

**Visible at this point:** format id (CR2/NEF/ARW/RAF/FITS/JPEG/TIFF/UNKNOWN) · isRaw flag · photometry tier

*Anchors: `src/engine/pipeline/m1_ingestion/format_registry.ts`*

#### 2.2. Pull instrument and capture fields
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Camera/lens model, focal length, aperture, ISO, exposure and capture time are pulled from the FITS header or the EXIF/TIFF tags, and a Julian Date is derived from the capture-time claim. A camera with no lens data gets the literal placeholder 'Unknown Lens' -- a known trap, because that string is truthy and downstream code must guard against it rather than read it as no-lens.

**Visible at this point:** camera_model, lens_model (or 'Unknown Lens') · focal_length, aperture, iso_gain, exposure_time

*Anchors: `src/engine/pipeline/m1_ingestion/metadata_reaper.ts`*

#### 2.3. Vet the capture clock
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff*

The capture time is trust-checked, not trusted blindly. A missing time is left as an empty string, never the current clock (which would silently misplace later planet/ephemeris work). A time that predates the camera format, sits in the future, or matches a dead-battery reset signature is treated as an unset clock. This only disables planet/ephemeris overlays downstream; it never blocks the plate solve.

**Visible at this point:** timestamp + timestamp_source (USER/EXIF/FITS/DEFAULT) · timestampTrusted verdict

*Anchors: `src/engine/pipeline/m1_ingestion/time_trust.ts`*

#### 2.4. Vet the observer location
*branch-point · code-derived · fits, cr2-raw*

Observer GPS is trust-checked the same way. A zero-vector or camera-default position is recorded as absent, not a fake fix. A defaulted location would later compute a zenith for the wrong hemisphere, so it is withheld rather than guessed. Like the clock, an absent location only disables the sky-guest overlays and the zenith hint rung.

**Visible at this point:** gps_lat/lon + gps_source · gpsTrusted verdict

*Anchors: `src/engine/pipeline/m1_ingestion/location_trust.ts`*

### 3. Decode the file to pixels
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

The bitstream is turned into pixels. The output is a full-resolution linear RGB frame plus the untouched sensor buffer; nothing is stretched or black-subtracted here so the frame stays bit-for-bit reproducible. If the file cannot be decoded at all this step halts with an error rather than continuing on empty data.

**Visible at this point:** untouched sensor buffer · full-resolution linear RGB frame · image dimensions · which decoder ran · sensor black/white levels + white-balance coeffs · color-filter pattern (or CFA-unknown verdict)

*Anchors: `stage:extract.decode`, `boundary:rawler_cfa`, `boundary:libraw_mem_image`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-01): Decode and Detect are elevated to separate major steps -- CONFIRMED precedent (each is a distinct decision a user could ask about). [orig question] the runtime groups decode+luminance+detect+color-peek under one 'extract' stage; this draft elevates Decode and Detect to separate major steps because each is a distinct decision. Confirm the elevation.
- RULED 2026-07-17 (DEC-2026-07-17-01): stage:ingest is a legacy alias of stage:extract.decode; segment E resolves the duplicate in the enrichment ledger. [orig question] enrichment carries BOTH a stage:ingest node and a stage:extract.decode node describing the same decode; the live withStage sites use 'extract' only. Confirm stage:ingest is legacy/alias.

#### 3.1. Reuse a cached decode or decode fresh
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff*

A content-fingerprint cache is checked first and a prior decode of the same frame is reused if found. Only on a miss does the actual bitstream decode run.

**Visible at this point:** cache hit/miss

*Anchors: `stage:extract.decode`*

#### 3.2. Select the decoder arm
*branch-point · code-derived · cr2-raw, branch-point*

FITS decodes directly (often already-demosaiced RGB, passed through unchanged); JPEG/TIFF goes through the browser image decoder; camera raw goes through Rawler (the default arm since the 2026-07-11 cutover) or LibRaw (a retained cold path, never deleted, selected by env flag). Only the LibRaw arm carries the dominant-channel RGB16 buffer with ~4-7% cross-leak and its two independent mosaic-detection tests.

**Visible at this point:** decoder identity in the receipt

*Anchors: `src/engine/pipeline/m1_ingestion/rawler_decoder.ts`, `boundary:libraw_mem_image`*

#### 3.3. Demosaic the mosaic, or refuse to guess a color
*branch-point · code-derived · cr2-raw, branch-point*

A Bayer color-filter mosaic is demosaiced to full-resolution linear RGB, reading each pixel's filter color from its absolute sensor position so cropping stays correctly phased. If the color-filter pattern cannot be determined, the decoder refuses to guess (a wrong-phase guess imprints a checkerboard) and block-averages to phase-agnostic grayscale, marking color 'not measured' so the frame geometry stays solvable.

**Visible at this point:** linear RGB frame or grayscale-with-color-not-measured

*Anchors: `boundary:rawler_cfa`, `src/engine/wasm_decode/src/lib.rs`*

### 4. Detect the stars
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

Stars are found on the science buffer through four acts: build the detection buffer, model the background, threshold and extract blobs, then cull and curate. The same condition that picks the buffer also drives the reported status text, so the two cannot drift. If signal analysis returns no result the step raises an error and halts.

**Visible at this point:** clean star detections with sub-pixel centroids · anomalies[] and planet_candidates[] (drawable populations) · per-reason culling tally (assignment-time) · CFA verdict on raw frames

*Anchors: `stage:extract.detect`, `src/engine/pipeline/m4_signal_detect/signal_processor.ts`*

#### 4.1. Choose and build the detection buffer
*branch-point · code-derived · fits, cr2-raw, branch-point*

When an un-demosaiced native Bayer buffer is available (camera raw, Rawler path) detection runs on that data with 2x2 binning; otherwise it reduces the RGB frame to single-channel luminance. Reduction uses standard Rec.709 weights normally, but switches to equal weights when the frame is a CFA mosaic read as luminance, so the perceptual weighting does not imprint a 2-pixel checkerboard on detection. The equal-weight guard is off by default and engages only on the flagged mosaic case.

**Visible at this point:** detection buffer (native-Bayer 2x2 or luminance) · reported detection-path status

*Anchors: `stage:extract.luminance`, `src/engine/pipeline/m4_signal_detect/luminance_reduce.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-01): luminance-build stays NESTED under Detection -- no standalone major step. [orig question] the runtime emits luminance-build as its own sub-stage (extract.luminance); here it is nested under Detection. Confirm nesting vs. a standalone major step.

#### 4.2. Model the background and mask artifacts
*pipeline · code-derived · fits, cr2-raw*

A background mean/median is estimated with a sigma-clipped, NaN/BLANK-mask-aware pass so undefined FITS regions do not drag the estimate toward zero. A thermal hot-pixel prepass runs on a detection-support COPY (a pixel spikes above its 8-neighbor median AND those neighbors sit at background -- a real star leaks PSF into its ring, a hot pixel does not), gated on measured spike density. A frame-measured vignette-flattening lever (gain(r)=1+a2 r^2+a4 r^4, fit from the frame's own sky, applied BEFORE thresholding) also lives here -- but it sits behind an env flag that defaults OFF, so as shipped detection runs on unflattened luminance, held back because the sigma thresholds were calibrated on unflattened frames.

**Visible at this point:** background/noise estimate · hot-pixel mask (on copy) · vignette-flatten status (default OFF)

*Anchors: `src/engine/pipeline/m4_signal_detect/masked_background.ts`, `src/engine/pipeline/m4_signal_detect/hot_pixel_map.ts`, `src/engine/pipeline/m4_signal_detect/detection_flatten.ts`*

**Flags:**

- Answers the owner's standing question 'does vignette correction apply before or after detection?': a detection-plane flatten is designed to apply BEFORE thresholding (default OFF); a separate per-star per-band vignette map applies AFTER solve at the measurement level (also default OFF).

#### 4.3. Threshold and extract blobs
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Sigma thresholding over the background model plus connected-component blob extraction yields candidate sources with sub-pixel centroids. Morphological filtering rejects non-stellar blobs. This is the act that turns a luminance surface into a raw candidate list.

**Visible at this point:** raw blob list with sub-pixel centroids

*Anchors: `src/engine/pipeline/m4_signal_detect/source_extractor.ts`*

#### 4.4. Cull and curate the star list
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Per-blob thermal discriminators (sharpness = peak/flux, 2nd-moment FWHM/ellipticity on an 11x11 stamp) cut hot-pixel/dark-current junk from uncooled high-ISO DSLR frames, calibrated OUTSIDE the clean reference distributions so they are a no-op there. Horizon/terrain culling traces the sky/foreground boundary from the negative space of the detections themselves, and fires only when an evidence gate says terrain exists. Every culled star is counted at assignment time into a per-reason tally, so hard-rejected and planet-routed stars are counted, not just what survives into anomalies[].

**Visible at this point:** clean_stars · anomalies[] + planet_candidates[] · per-reason culling_tally

*Anchors: `src/engine/pipeline/m4_signal_detect/detection_cuts.ts`, `src/engine/pipeline/m4_signal_detect/horizon_envelope.ts`, `src/engine/pipeline/m4_signal_detect/culling_stats.ts`*

#### 4.5. Sample each star's color before releasing the buffer
*pipeline · receipt · cr2-raw, fits*

Just before the full-resolution decoded image is released from memory, the red/green/blue values at each detected star's center pixel are read and stored on the star, along with a rough blue-over-green color index. A star whose center falls outside the image is left without color values rather than given fabricated ones, and the color index is computed only where the green channel is above zero. These per-star colors are carried forward for the later hardware-profile spectral report.

**Visible at this point:** per-star sampled RGB + blue/green color index

*Anchors: `stage:extract.spectral_peek`*

### 5. Resolve the pixel scale (and sky-guest list)
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

Between detection and the solve, the angular pixel scale is resolved through its own trust ladder -- this is a distinct step the prior draft omitted entirely. It also builds the ephemeris guest list, but only when both clock and location are trusted, since a defaulted clock or missing site would compute a guest list for the wrong sky.

**Visible at this point:** pixel scale (arcsec/px) + which rung locked it · assumed-focal finding (if any, labeled separately) · ephemeris guest list (or empty)

*Anchors: `stage:metrology`, `src/engine/pipeline/stages/metrology.ts`*

#### 5.1. Pixel-scale trust ladder
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

FITS header optics are tried first; then the EXIF focal length combined with a sensor-database pixel pitch; and finally a blind triangulation from the brightest detected stars if neither is available. The rung that produced the lock is recorded, and any focal length that had to be assumed is emitted as a separately labeled finding -- never folded into the scale as if it were measured -- so the receipt shows the chain of trust.

**Visible at this point:** scale value · winning rung · assumed-focal finding (if present)

*Anchors: `stage:metrology`*

#### 5.2. Build the sky-guest list
*branch-point · code-derived · fits, cr2-raw*

Planets, moons and satellites are enumerated for the frame -- but only when both the capture timestamp and observer location passed their trust gates. Otherwise the list is left empty rather than computed for the wrong sky. This never affects the plate solve.

**Visible at this point:** ephemeris guest list (or empty)

*Anchors: `stage:metrology`*

### 6. Resolve the search hint
*branch-point · receipt · fits, cr2-raw, jpeg-tiff*

Before the solver runs, a search prior is resolved through a fixed four-rung ladder that picks a search radius. The first rung that qualifies wins; each is checked in order. A hint only narrows the search -- it never decides whether a solution is accepted, which the verification gate alone does. RA is carried in HOURS, Dec in degrees.

**Visible at this point:** resolved hint {ra_hours, dec_degrees, radius_deg, trusted} · hint source (CONFIG/FITS_HEADER/ZENITH/BLIND)

*Anchors: `stage:user_target_hint`, `src/engine/pipeline/stages/solve.ts`*

#### 6.1. Rung 1 -- user target hint
*branch-point · receipt · fits, cr2-raw, jpeg-tiff, branch-point*

If the user (or headless caller) supplied an explicit sky target -- label plus RA(hours)/Dec(degrees) -- it becomes the widest-trust prior: a 15-degree-radius cone, marked trusted (which later arms a tighter fine-centering pass in the ultra-wide solver). The azimuth-mode UI sentinel (ra === -1, where dec holds an azimuth) is screened out here so it can never be forwarded as a literal -1h RA and poison the search center. This rung wins outright when present.

**Visible at this point:** hint {radius_deg: 15, trusted: true, source: CONFIG}

*Anchors: `stage:user_target_hint`*

#### 6.2. Rung 2 -- header pointing hint
*branch-point · code-derived · fits, branch-point*

If no user hint was given, the resolver checks for a pointing the file's header already claims -- a telescope/mount RA/Dec (e.g. a smart-telescope GOTO). When present it seeds a tighter 4.0-degree-radius cone and is also marked trusted.

**Visible at this point:** hint {radius_deg: 4.0, trusted: true, source: FITS_HEADER}

*Anchors: `src/engine/pipeline/m6_plate_solve/hint_resolver.ts`*

**Flags:**

- [NOT CONFIRMED] whether any camera-RAW EXIF field ever populates the header-pointing field; verified only as FITS/mount-sourced this session.

#### 6.3. Rung 3 -- zenith hint
*branch-point · code-derived · cr2-raw, jpeg-tiff, branch-point*

If neither prior rung fired, the resolver tries 'straight up': the sky coordinate overhead at the capture site and time, a 90-degree-radius search. This rung fires ONLY when both the observer location and the capture clock independently passed their trust gates, because a defaulted position or unset clock would compute the zenith for the wrong hemisphere and could push the true center outside a radius-limited search. Unlike rungs 1-2 it is marked untrusted (does not arm the tighter fine-centering pass).

**Visible at this point:** hint {radius_deg: 90, source: ZENITH, untrusted}

*Anchors: `src/engine/pipeline/m6_plate_solve/hint_resolver.ts`*

#### 6.4. Rung 4 -- full-sky blind fallback
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

When no rung qualifies, the search falls back to the full sky (180-degree radius), marked untrusted. This is a hint-ladder outcome, distinct from the ultra-wide blind SOLVER escalation that a full-sky search may later trigger. The prior draft folded this rung into its 'Blind Solve' step; this draft keeps it as the ladder's fourth rung.

**Visible at this point:** hint {radius_deg: 180, source: BLIND, untrusted}

*Anchors: `src/engine/pipeline/stages/solve.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-01): the full-sky fallback is hint rung 4, with a converge edge that bridges into the ultra-wide solve -- the full-sky quad attempt falls through to the UW escalation. [orig question] is the full-sky fallback best drawn as the 4th hint rung (here) or as the entry to the ultra-wide solve step? It is a hint-radius outcome in code, but narratively bridges into blind solving.

### 7. Primary solve -- quad match
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

With whichever radius the hint ladder resolved (15/4/90/180 degrees), the primary WASM quad matcher runs. It is the branch that solves normal and narrow fields; on a miss it falls through to the ultra-wide escalation. The lock records image-center RA(hours)/Dec(degrees), rotation, pixel scale, matched stars, a confidence score, and solved_via (which prior seeded it).

**Visible at this point:** on lock: RA/Dec/rotation/scale/matched_stars/confidence/solved_via · per-branch solve timing (absent, never zero, for branches not attempted)

*Anchors: `stage:solve.quad_wasm`, `src/engine/pipeline/m6_plate_solve/solver_entry.ts`*

#### 7.1. Prepare solver inputs
*branch-point · code-derived · fits, cr2-raw, branch-point*

The matcher takes a magnitude-ranked subset of detections (capped at 30 by default) and nearby catalog stars (capped at 100 by mag_v), and first drops any detection with non-finite coordinates, which would otherwise crash the compiled matcher. On a narrow field (frame diagonal under 6 degrees) the verification gate is relaxed to accept a lock on four anchor-star matches at 0.5 confidence, because the standard wide-field threshold rejects genuine deep-stack solves whose honest confidence is lower.

**Visible at this point:** curated detection subset (<=30) · catalog subset (<=100) · narrow-field gate state

*Anchors: `src/engine/pipeline/stages/solve_context.ts`*

#### 7.2. Form and hash quads
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Four-star geometric groups are formed from the brightest stars and each is hashed into a rotation- and scale-invariant descriptor -- the geometry that lets a local star pattern be recognized regardless of orientation or field size.

**Visible at this point:** quad descriptors

*Anchors: `src/engine/pipeline/m6_plate_solve/solver_entry.ts`*

#### 7.3. Match descriptors against the catalog
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Each quad descriptor is matched against the catalog index, producing candidate correspondences between detected quads and cataloged star patterns.

**Visible at this point:** candidate quad correspondences

*Anchors: `src/engine/pipeline/m6_plate_solve/star_catalog_adapter.ts`*

#### 7.4. Fit a WCS and verify
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

For every candidate correspondence a world coordinate system is fitted and checked -- do the detected stars actually land on the cataloged positions it predicts? The first candidate that verifies becomes the solution. If the matcher returned no candidate quads, or every fitted candidate fails verification, this branch reports no lock and the solver falls through to the ultra-wide escalation.

**Visible at this point:** verified WCS or no-lock verdict

*Anchors: `src/engine/pipeline/m6_plate_solve/solver_entry.ts`*

### 8. Ultra-wide / blind escalation
*pipeline · receipt · cr2-raw*

When the radius-limited quad matcher does not lock -- most often an ultra-wide DSLR nightscape with no usable pointing -- the solver escalates through wider, more expensive tiers under a wall-clock budget (90s on the libraw cold arm, 360s on the rawler default arm). Exactly one branch fires on any solved run. On a genuine miss it reports failure with structured diagnostics rather than a guessed pose.

**Visible at this point:** on lock: same fields as the quad solve; on miss: structured failure diagnostics

*Anchors: `stage:solve`, `src/engine/pipeline/m6_plate_solve/solver_entry.ts`*

#### 8.1. Anchored ultra-wide sweep
*branch-point · code-derived · cr2-raw, branch-point*

A wider TypeScript-side anchored sweep searches across the sky, seeding candidate centers from the brightest detections and (when armed) any trusted hint. A candidate must clear a minimum significance (sweep-z >= 4.5) and dominate any distant runner-up peak to be taken forward.

**Visible at this point:** sweep candidate centers + peak significance

*Anchors: `stage:solve`, `src/engine/pipeline/m6_plate_solve/solver_entry.ts`*

#### 8.2. Fit-tight-reverify -- diagnostic footnote (not a solve rung)
*pipeline · code-derived · cr2-raw*

A verdict-NEUTRAL diagnostic that runs alongside the escalation, NOT a rung on the accepted-solve line (which goes sweep -> deep-verify). Because the radius-inflated wide net lets chance track-matches accumulate, it fits Brown-Conrady distortion on the provisional matches and re-verifies through a tight (3-pixel) net, with an inner-region pinhole fallback, then LOGS the tight-net significance while changing NO verdict as shipped. The diagnostic pass (SOLVER_UW_FIT_REVERIFY) defaults ON; it only becomes an acceptance rung if SOLVER_UW_TIGHT_ACCEPT is flipped on (default OFF, orchestrator-only after a false-positive audit, and even then the tight-net bar is the SAME +5 sigma as the wide gate -- it adds evidence, never lowers the bar). It also carries the load-bearing HOURS->DEGREES catalog conversion. Drawn here as a footnote/badge on the ultra-wide solve, off the sweep->deep line.

**Visible at this point:** tight-net re-verification z (logged evidence; accepts nothing unless the accept flag is on)

*Anchors: `src/engine/pipeline/m6_plate_solve/uw_tight_reverify.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-01): fit-tight-reverify is a diagnostic footnote/badge, NOT a solve rung -- SOLVER_UW_TIGHT_ACCEPT defaults OFF (verdict-neutral), so as shipped it accepts no solve; re-kinded from branch-point to a non-branching diagnostic and taken off the main sweep->deep line, TIGHT_ACCEPT-off cited at pipeline_config.ts:222-226. [orig question] the fit-tight-reverify tier is default DIAGNOSTIC-ONLY (TIGHT_ACCEPT off) -- should a non-accepting tier appear as a solve rung in the user-facing procedure, or be footnoted?

#### 8.3. Deep-verify escalation
*branch-point · code-derived · cr2-raw, branch-point*

A further escalation rung uses forced photometry at the catalog positions a provisional pose predicts, measuring real brightness at each on the untouched luminance frame and comparing the confirmation rate against a deterministic scrambled-null draw (a binomial excess-z). This is the rung that rescues true ultra-wide solutions the wide gate rejects.

**Visible at this point:** deep-verify excess-z · escalation lock or continued miss

*Anchors: `stage:solve.uw_escalation`, `src/engine/pipeline/m6_plate_solve/deep_verify.ts`*

#### 8.4. Honest failure
*pipeline · code-derived · cr2-raw*

If no tier verifies within the wall-clock budget, the pipeline reports a genuine miss with structured diagnostics (what was tried, why each fell short) rather than returning a guessed pose. A miss is a first-class outcome, not an error to paper over.

**Visible at this point:** structured failure diagnostics; no WCS

*Anchors: `src/engine/pipeline/m6_plate_solve/solver_entry.ts`*

### 9. Confirm the lock (forced photometry)
*pipeline · receipt · fits, cr2-raw*

After a lock -- from either the quad solve or the ultra-wide escalation -- an independent check can run. It never changes the coordinate solution, scale, matched stars, or confidence; it is a separate confirmation record with its own significance. In the runtime this runs in the post-solve step alongside PSF/color/calibration work; that boundary is now ruled -- forced-confirmation is the CLOSING BEAT of the upload->solve chapter. The refinement/science chapter (segment C) begins after this beat and cross-references this confirmation record, but does not own or re-run it.

**Visible at this point:** solved_via provenance · forced-confirmation record + set-level significance · four-state verdict

*Anchors: `stage:forced_confirm`, `src/engine/pipeline/m6_plate_solve/forced_confirm.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-01): forced-confirm is the LAST beat of upload->solve; the refinement chapter (segment C) cross-references it, does not own it. [orig question] forced-confirmation runs in the post-solve step (after the WCS is fixed, interleaved with PSF/SPCC/calibration that are out of this scope). Is it the last beat of 'upload->solve' or the first beat of the refinement chapter?

#### 9.1. Record which prior seeded the lock
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

solved_via records the category of search prior active when the solve locked -- blind, user-assisted, or metadata-assisted -- by mapping the winning hint rung. It returns nothing rather than guessing 'blind' when the source is not honestly known. A hinted solve is not a lesser solve (acceptance never consults the hint); this is denominator bookkeeping for detection-improvement analysis, not a quality tag.

**Visible at this point:** solved_via in {blind, assisted:user, assisted:metadata}

*Anchors: `stage:solve_provenance`*

#### 9.2. Forced photometry at catalog positions
*pipeline · code-derived · fits, cr2-raw*

The fitted solution's predicted catalog positions are probed with a matched-aperture flux measurement on the untouched luminance frame (fixed positions, no re-centroiding), and the real confirmation count is compared against repeated deterministic scrambled on-frame draws.

**Visible at this point:** per-star forced fluxes · real-vs-scrambled confirmed counts

*Anchors: `src/engine/pipeline/m6_plate_solve/deep_verify.ts`*

#### 9.3. Set-level gate and four-state verdict
*branch-point · code-derived · fits, cr2-raw, branch-point*

A set-level family-wise gate promotes candidates to CONFIRMED only when the real confirmed count beats the frame-wide scrambled null; otherwise the whole set collapses to zero, so a ~2-sigma candidate floor is never laundered into 'confirmed' across hundreds of candidates. Since the 2026-07-15 sigma-swap the N-invariant false-discovery-rate statistic is the primary verdict driver; the legacy set-excess-z (known sqrt(N)-malformed) is kept only as a diagnostic fallback. A pure classifier turns the result into one of four states: CONFIRMED / REFUSED / INSUFFICIENT_TARGETS / NOT_RUN.

**Visible at this point:** confirm_status verdict + set-level significance

*Anchors: `src/engine/pipeline/m6_plate_solve/fdr_confirm.ts`, `src/engine/pipeline/m6_plate_solve/confirm_status.ts`*

---

## Chapter 3 — Calibration & Refinement  *(segment B)*

### 10. Refine the astrometry and gate the distortion models
*pipeline · receipt · fits, cr2-raw, jpeg-tiff*

Once a lock is accepted, a read-only measurement layer runs on top of the solved world coordinate system (COORDINATE ledger). It measures how well the linear solution reproduces the matched-star positions and, when the scatter warrants, fits two candidate optical-distortion models -- but it attaches either one to the solution only if that model earns its place out of sample. The whole layer emits as one refinement stage that WRITES the solution's astrometry record; the three passes inside it -- residual measurement, then the polynomial (SIP) gate, then the spline (TPS) gate -- run NESTED and finish just before this stage closes. What those gates control is EMISSION: whether distortion coefficients land on solution.astrometry. They never change the solved coordinates, matched stars, pixel scale, or confidence, so the pinned solve numbers are byte-identical whether a model is admitted or refused.

**Visible at this point:** residual scatter (RMS arcsec) · distortion-detected flag · admitted SIP polynomial (or absent + a sip_gate verdict) · admitted TPS spline (or null + a tps_gate verdict)

*Anchors: `stage:m7_refine`, `src/engine/pipeline/stages/calibrate.ts`*

**Flags:**

- Cross-segment ENTRY: this chain converges from segment A's accepted lock (step:solve_quad / step:solve_uw), not from step:confirm. Forced-confirmation (segment A step:confirm, ruling 7) runs temporally AFTER this whole chain (stage_order: forced_confirm is the last stage record); the assembler should wire the converge edge to the lock, not to confirm.

#### 10.1. Measure the residual scatter and fit a candidate polynomial
*branch-point · receipt · fits, cr2-raw, jpeg-tiff, branch-point*

Each matched catalog star is projected back through the linear solution to a predicted pixel, and the detected-minus-predicted offsets are combined into a residual scatter (RMS in arcseconds) plus a mean shift vector. Distortion is flagged when that scatter exceeds about 1.2 arcseconds. With fewer than fifteen usable matches -- planetary-verification sentinels (residual >= 999, gaia_id 'planet_*') and gross outliers excluded -- it reports zero residual and no distortion rather than guessing. Only when distortion is flagged AND more than twenty usable matches are present does it fit a candidate order-3 SIP polynomial by least squares; a rank-deficient star layout makes the fit abstain (returns nothing) rather than emit non-finite coefficients. The residual scatter and distortion flag are written to the astrometry record immediately; the candidate polynomial is held back and survives only if the next pass admits it.

**Visible at this point:** rms_arcsec · distortion_detected · candidate SIP (held, not yet emitted)

*Anchors: `stage:calibrate.m7_analyze`, `src/engine/pipeline/m7_astrometry/residual_analyzer.ts`*

#### 10.2. Gate the polynomial -- keep it only if it generalizes out of sample
*branch-point · receipt · fits, cr2-raw, jpeg-tiff, branch-point*

The candidate polynomial is put through deterministic 5-fold out-of-sample cross-validation and compared, on the held-out stars, against two baselines: applying no correction at all (the linear residual) and a plain affine tilt plane. It is admitted onto the solution only if, out of sample, it beats the no-correction residual AND does no worse than the affine plane; otherwise it is refused with a specific machine-readable reason -- too few points to test (coverage), a singular fold fit, worse than no correction, or an overfit the affine plane already matches. The distrust is earned: a low-order global polynomial fit to a sparse, center-weighted star set interpolates its own control points but extrapolates catastrophically toward the frame corners (on the pinned CR2 frame roughly 3 px displacement inside the star hull versus roughly 1300 px at the corner, measured about 34x worse than an external reference). The gate records its full verdict either way -- the out-of-sample and in-sample residuals, and the matched-star hull radius versus the frame-corner radius as an extrapolation-reach witness that is RECORDED, never thresholded (a hull cutoff would need a tuned constant). Admitted attaches solution.astrometry.sip; refused leaves it absent with the verdict explaining why. It never touches the world coordinate system, the matched stars, or confidence.

**Visible at this point:** sip_gate verdict {admitted, reason} · rms_oos vs rms_linear vs rms_oos_affine (arcsec) · hull_radius_px vs corner_radius_px + corner displacement · sip attached only when admitted

*Anchors: `stage:calibrate.sip_gate`, `src/engine/pipeline/m7_astrometry/sip_gate.ts`*

#### 10.3. Gate the spline -- four-part out-of-sample admission
*branch-point · receipt · fits, cr2-raw, jpeg-tiff, branch-point*

A thin-plate spline is fit to the same leftover position errors as a non-polynomial companion, carried into ASDF/GWCS export as a tabular lookup. It runs on the SAME fire gate as the polynomial -- scatter above about 1.2 arcseconds and more than twenty matched stars. Generalized cross-validation picks the spline's smoothing strength over a grid, and the spline is admitted only if it clears every arm of a four-part gate: its out-of-sample error stays within twice the larger of its in-sample error or a floor (the overfit arm); it beats applying no correction; its peak displacement stays under a physical refraction budget scaled to the field span (1.02 arcsec/deg times a worst-case secant-squared-zenith factor times a margin, the physics-ceiling arm); and up front it is refused when the control points are too few or lopsided, or the linear system is singular. Precedent: the SeeStar/M66 galactic-band frame FIRES the fit (in-sample residual about 3 arcsec) but is REFUSED because it does not generalize (out-of-sample about 35 arcsec) -- an interpolating spline laundering its own control points. The admitted model, or an explicit null, plus the full verdict (out-of-sample and in-sample residuals, the chosen smoothing, a machine-readable reason) is written to the astrometry record. Observe-and-annotate only: the reported solve values are identical whether the spline is admitted or refused. This pass closes the refinement stage, which is the record that emits the astrometry write.

**Visible at this point:** tps_gate verdict {admitted, reason, lambda_selected} · rms_oos vs rms_insample vs rms_linear (arcsec) · displacement_amplitude vs physics_ceiling (arcsec) · tps model or explicit null

*Anchors: `stage:calibrate.tps_gate`, `src/engine/pipeline/m6_plate_solve/tps_fitter.ts`, `src/engine/pipeline/m6_plate_solve/tps_eval.ts`*

### 11. Measure this frame's own lens distortion
*pipeline · receipt · fits, cr2-raw*

Independently of the polynomial and spline fits, an always-on observation fits a Brown-Conrady lens-distortion model to this frame's own solver-verified star matches, comparing each matched star's detected position against where the linear solution predicts it. This is distinct from the nominal lens-database prior segment A may apply to the matching coordinates BEFORE the quad step: that prior is a catalog lens profile; this is a per-frame measurement of the actual optics. It is a pure read of the world coordinate system and matched stars and mutates neither, so the astrometric result is byte-identical whether or not it runs (COORDINATE ledger, observation-only). It always fits the primary radial term k1, but admits the higher-order radial terms only when the matched stars actually reach far enough toward the frame corners (k2 needs a maximum normalized radius >= 0.8 with enough stars beyond 0.6; k3 needs enough beyond 0.85), and the tangential decentering terms only when the stars fill enough of the azimuth (at least 5 of 8 octants each holding >= 15 pairs). Terms that fail their coverage gate are refused rather than fit from a coverage hole. Honest-or-absent: no result at all when there is no usable solution, and a 'not measured' record when fewer than ten matched pairs are available or the fit is degenerate. Where the azimuthal coverage is too thin to separate lens distortion from a decentered optic, it still reports k1 but flags the magnitude as upper-bound-honest and the sign as tentative. It also records the 2-D residual scatter before and after correction and, when the higher-order terms are available, a sign-flip ('mustache') verdict for whether the radial profile changes sign across the field, with inner- and outer-lobe significance -- reported undetermined when the quintic term was not fit.

**Visible at this point:** k1 (+ k2/k3/p1/p2 when their coverage gate passes) · per-term coverage_refused flags · n_used / n_pairs · 2-D rms before vs after correction · decentering-confound warning (or none) · mustache sign-flip verdict · or an explicit not_measured record

*Anchors: `stage:bc_measure`, `src/engine/pipeline/m2_hardware/lens_distortion_refit.ts`, `src/engine/pipeline/m2_hardware/lens_distortion.ts`*

### 12. Recover edge stars under the distortion model, then keep or discard the denser solve
*branch-point · receipt · fits, cr2-raw, branch-point*

This is the PRIMARY, default-on two-pass rail (owner ruling 2026-07-08: measured-BC application promoted to primary). It recovers stars near the frame edges that the initial solve missed because its matching had not yet accounted for lens distortion -- but by construction it can only ever ADD to a good solve, never degrade it. The denser match set replaces the original only when it clears two independent guards together; if either fails, the original solution is kept byte-identical (COORDINATE ledger; a well-corrected narrow field recovers nothing and keeps). Fail-soft throughout: any throw degrades to no rematch and the downstream consumers still run on the original set. Sequencing that matters: this rail runs BEFORE every match-consuming product (hardware profile, color calibration, PSF field), so an accepted densification is the FINAL writer of the match set and every consumer reads the post-rematch stars -- the receipt's stale-pre-rematch label is false by construction.

**Visible at this point:** matched counts before vs after · recovered stars with per-star keep/reject reasons · rms before vs after · keep-or-replace decision (APPLIED / KEPT_ORIGINAL)

*Anchors: `stage:bc_rematch`, `src/engine/pipeline/m2_hardware/lens_distortion_rematch_pass.ts`, `src/engine/pipeline/m2_hardware/lens_distortion_rematch.ts`*

#### 12.1. Apply the model and re-match the full detection list
*pipeline · code-derived · fits, cr2-raw*

The measured distortion model is applied to the catalog star positions, the full detection list (clean stars plus anomalies) is re-matched against them, and the polynomial refinement is re-run on the enlarged set. Each recovered star's residual is then computed through the same linear-plus-polynomial prediction the original matches used. (Internal convention trap: catalog right ascension is carried in HOURS and converted to degrees only at the projection call -- the same single-source sky-to-pixel path the residual analysis uses.)

**Visible at this point:** recovered candidate matches + final-chain residuals · re-refit candidate astrometry on the enlarged set

*Anchors: `src/engine/pipeline/m2_hardware/lens_distortion_rematch.ts`*

#### 12.2. Screen each recovered star -- one rule for all
*branch-point · code-derived · fits, cr2-raw, branch-point*

A recovered star is kept only if its residual after the refit lands inside the SAME acceptance envelope the original matches already cleared. When a coherent native science image is present (the buffer is exactly the full frame), it additionally requires forced photometry to confirm real flux at the predicted position; where no such native buffer exists, the flux check is recorded as not-measured rather than silently skipped. Every recovered star -- kept or rejected -- is classified by one shared rule, so the tally is honest about what was admitted and the reason for each rejection, not just what survived.

**Visible at this point:** per-star kept / reject_reason · forced-photometry SNR (or a not-measured flux check) · envelope survivors

*Anchors: `src/engine/pipeline/m2_hardware/lens_distortion_rematch_pass.ts`*

#### 12.3. Keep or replace -- never-worse AND wrong-sign, both required
*branch-point · code-derived · fits, cr2-raw, branch-point*

The densified solution replaces the original ONLY when it clears both guards at once. The never-worse structural guard requires strictly more matched stars AND a post-chain residual no worse than before. The wrong-sign control re-runs the recovery with the distortion coefficients negated and requires the correct sign to recover meaningfully more edge stars than the negated sign -- genuine radial signal beats its own negation, while chance recovers about equally under either. Neither is a tuned threshold: never-worse is a comparison, wrong-sign is the module's own negated-coefficient control. The wrong-sign guard is LOAD-BEARING for the SeeStar bit-identity pin: a well-corrected narrow field's handful of recoveries are chance, indistinguishable from the negated control, so it fails wrong-sign, KEEPS the original, and the sacred solve stays byte-identical. On APPLIED the match set, star count, and astrometry are replaced (the linear WCS and confidence are left unchanged -- the densification evidence lives in this block, never laundered into confidence), the match epoch advances, and the native-representation stamp is refreshed before color calibration reads it.

**Visible at this point:** never-worse verdict · wrong-sign pass/fail · APPLIED or KEPT_ORIGINAL · new match epoch on APPLIED

*Anchors: `src/engine/pipeline/m2_hardware/lens_distortion_rematch_pass.ts`*

### 13. Profile the instrument (forensic report)
*pipeline · receipt · fits, cr2-raw*

With the match set final, a forensic instrument profile is derived. From the solved pixel scale it infers a focal length, and from the matched stars -- each carrying per-channel brightness samples and a catalog color peeked at the detection step -- it fits approximate radial-distortion and vignetting terms, a per-channel color bias, and flags for likely filters or sensor modifications. The distortion and vignetting fit runs only when at least ten clean matched stars survive after planetary markers and gross-residual outliers are excluded; below that it falls back to a coarse single-coefficient estimate, and every distortion value is labeled APPROXIMATE -- never a calibrated lens model (honest-or-absent). The report is null when there is no solution to profile, and it carries a label tied to the final match generation, so a profile computed from an outdated match set would be flagged rather than silently trusted. This is a report, not a stored calibration.

**Visible at this point:** inferred focal length · approximate radial-distortion + vignetting terms (labeled APPROXIMATE) · per-channel color bias · filter / sensor-mod flags · match-epoch label · or null when unsolved

*Anchors: `stage:calibrate.hardware_profile`, `src/engine/pipeline/m2_hardware/hardware_profiler.ts`, `src/engine/pipeline/stages/calibrate.ts`*

#### 13.1. Bank the profile to the per-rig store (application ladder off)
*pipeline · code-derived · fits, cr2-raw*

The forensic profile feeds a cross-frame Optical Workbench store that accumulates one compact deposit per solved frame, keyed per rig. The key prefers a body serial when the metadata surfaced one (SERIAL tier) and otherwise degrades to body-model times lens-string (MODEL_ONLY tier); focal length is NEVER part of the key. The store is a pure side channel -- never-fatal, zero-mutation: it only reads a finished receipt and appends a row, so the solve is byte-identical whether storage succeeds, throws, or is absent (a headless Node run with no backend injected is a clean no-op). Crucially, the APPLICATION of a pooled per-rig prior back into a future solve -- the 'rung-3' distortion prior -- is ladder-gated OFF: deposits are banked, but nothing reads them back into the solver yet. Honest state: collection is live, application is not.

**Visible at this point:** per-rig deposit row (side channel; not in the receipt) · rig_key + quality tier (SERIAL / MODEL_ONLY) · no pooled-prior application (rung-3 off)

*Anchors: `stage:workbench_deposit`, `src/engine/pipeline/m2_hardware/workbench_store.ts`, `src/engine/pipeline/stages/workbench_deposit.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): stays calibration-domain here in the refinement chapter; packaging chapter cross-references the deposit write (domain over temporal). [orig question] the Optical-Workbench per-rig deposit WRITE fires at the END of the packaging seam (after the receipt is built) and is NOT in the receipt stage walk -- so temporally it belongs to the packaging chapter (segment D). The per-rig store concept and its ladder-gated-OFF rung-3 application are calibration-domain, so it is drawn here as a sub-step of Hardware Profile. Confirm this cross-reference placement vs. moving the deposit-write beat wholly into segment D.

### 14. Re-warp the display preview (optional, default off)
*branch-point · receipt · fits, cr2-raw, jpeg-tiff, branch-point*

A display-only step (RENDER plane -- it consumes the coordinate and pixel ledgers and feeds neither) can redraw the on-screen preview with the fitted lens distortion removed: it reads the preview image, the admitted polynomial, and the reference pixel, then applies a single inverse warp so the distortion the solve measured is taken out of the pixels the viewer sees. It rewrites ONLY the preview image -- never the world coordinate system, the matched stars, or the solve numbers (all finalized above) -- and writes no receipt data block. It is not the export path: FITS and ASDF export carry their own distortion at the file boundary (segment D). It is OFF by default and reports SKIP when the flag is off, when the solve carried no admitted polynomial (SeeStar has none, so this is a no-op regardless), or when preview rendering is disabled; it reports APPLIED only when it actually re-warps, and the warp is a provable identity that returns the image untouched when no distortion is present. On any rendering error the preview is left unchanged. Because the flag defaults off, the pinned frames are byte-identical. This is the last beat of the calibration chapter; the flow then hands to color calibration (segment C).

**Visible at this point:** render verdict APPLIED / SKIP · rewritten preview image on APPLIED (no receipt data block)

*Anchors: `stage:render_apply_sip`, `src/engine/core/ImageProcessor.ts`*

**Flags:**

- Cross-segment EXIT: render_apply_sip is the last calibration stage in the receipt walk; the flow converges into segment C (stage:spcc). The assembler wires that edge.

---

## Chapter 4 — Photometry & Science  *(segment C)*

### 15. Chapter boundary -- the lock has been confirmed
*interface · receipt · fits, cr2-raw, interface*

The photometry/science chapter begins after the plate solution has been independently confirmed. Forced confirmation -- forced photometry at the catalog positions the fitted world-coordinate solution predicts, gated by a single set-level significance test against scrambled on-frame draws, ending in a four-state verdict (confirmed, refused, insufficient-targets, or not-run) -- is described in the upload-to-solve chapter and OWNED there (segment A, step:confirm), per owner ruling 7. It never alters the coordinate solution, its scale, the matched-star list, or the confidence; the per-color check is reported as not-measured because only combined luminance exists at that point. This step is a pointer, not an owned beat: the science stages below read the same solved, catalog-matched positions the confirmation used. HONEST RUNTIME NUANCE: in machine emission order the confirmation stage actually runs LAST among the post-solve stages -- after the SPCC and PSF stages below (stage order: psf_attribution -> forced_confirm) -- so opening the chapter with it is a narrative-curation choice, not the runtime beat that precedes these stages.

**Visible at this point:** confirmed/refused/insufficient/not-run verdict (from segment A) · solved_via provenance (from segment A) · the fitted WCS, scale, matched_stars, confidence -- fixed and never touched downstream

*Anchors: `stage:forced_confirm`, `xref:step:confirm`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): keep ruling-7 narrative placement (confirm = closing beat of upload-to-solve) with the honest emission-order note retained. [orig question] emission-order inversion. In the receipt-replayed stage order forced_confirm runs AFTER the SPCC/PSF photometry stages (psf_attribution -> forced_confirm -> calibrate), yet ruling 7 places forced-confirmation as the closing beat of upload-to-solve (segment A). Confirm the photometry chapter opens with forced-confirm as a backward cross-reference (as drawn here) rather than the assembler re-ordering it to run after psf_attribution.

### 16. Calibrate color against the catalog
*pipeline · receipt · fits, cr2-raw*

Spectrophotometric color calibration. After the solve, each matched star's brightness is measured in red, green, and blue at its catalog-matched position on the RETAINED full-resolution linear frame, and the instrument's color response is fit -- a straight line relating instrumental blue-minus-red color to catalog Gaia BP-RP -- plus a photometric zero point that transfers instrumental magnitude onto the Gaia G scale. It is a PIXEL / PSF-measurement product: it works only in pixel space and never modifies the coordinate solution. Eligibility is format-agnostic (any retained linear science frame plus matched stars), so it fires on FITS and raw DSLR (CR2/rawler) but NOT on already-rendered JPEG/TIFF, which never retain the linear frame and are correctly excluded. Air mass is derived for the field center and recorded; the corrections that would consume it stay off by default (sub-step 5).

**Visible at this point:** color slope / intercept / r-squared / rmse (or an honest refusal) · photometric zero point + its status · per-star surfaced RGB fluxes and instrumental color · band partition counts (Gaia-G vs Johnson-V) · recorded air mass (or absent) · exposure source: MEASURED or ASSUMED_1S

*Anchors: `stage:spcc`, `stage:science`, `src/engine/pipeline/stages/science.ts`, `src/engine/pipeline/m8_photometry/spcc_calibrator.ts`*

**Flags:**

- [STALE REF] The 2026-07-12 MULTILAYER_MATRIX.md audited the per-star vignette/extinction flux correction feeding SPCC/forced-confirm/psf_field as ABSENT / UNWIRED. On rest-integration that seam now EXISTS as additive default-OFF levers (PSF_FLUX_VIGNETTE_CORRECT and PSF_FLUX_EXTINCTION_CORRECT, both default 0). Current honest state: wired but INERT as shipped -- SPCC/psf_field/forced-confirm consume RAW fluxes, both pinned reference solves stay byte-identical. Cite the current state, treat the matrix's 'absent' wording as superseded.

#### 16.1. Check eligibility, or refuse honestly
*branch-point · code-derived · fits, cr2-raw, branch-point*

Before any color is fit, four honest-refusal gates run. A monochrome sensor refuses with REFUSED_GRAY (no genuine per-channel color to calibrate). An unknown or unsupported color-filter-array phase refuses with UNCALIBRATED_CFA (the RGB may be a gray-replicated proxy). A downscaled (2x2-binned) solve whose matched detections did not carry the restored native full-resolution coordinates refuses with BINNED_COORDS_NOT_RESTORED rather than photometer half-resolution pixels -- it never silently falls back to binned coordinates. Absence of a retained linear frame or of matched stars is a clean SKIP, not a failure. Every refusal nulls every numeric (never a sentinel) and records the reason.

**Visible at this point:** refusal reason (REFUSED_GRAY / UNCALIBRATED_CFA / BINNED_COORDS_NOT_RESTORED) or clean SKIP or proceed

*Anchors: `stage:spcc`, `src/engine/pipeline/stages/science.ts`*

#### 16.2. Measure each matched star in red, green, and blue
*pipeline · code-derived · fits, cr2-raw*

At each catalog-matched star position, aperture photometry on the retained native full-resolution RGB frame yields per-band fluxes with a local annulus background (a star is usable only when its aperture has signal, its annulus has at least eight background samples, and it is not saturated). This is a PSF-measurement extraction on untouched native pixels at the coordinate-supplied position -- never a pre-warped buffer. The optional per-star vignette divide (per-band, chromatic) and extinction divide (k times airmass) are applied to the EXTRACTED flux here when their flags are on, alongside the raw value; both flags default OFF, so as shipped the fluxes are raw.

**Visible at this point:** per-star flux_r/flux_g/flux_b · usable/unusable per star · raw fluxes (corrected variants only when the default-off levers are enabled)

*Anchors: `stage:spcc`, `src/engine/pipeline/m8_photometry/spcc_calibrator.ts`, `src/engine/pipeline/m8_photometry/rgb_aperture_photometry.ts`*

#### 16.3. Fit the instrumental color line (Gaia-G stars only)
*branch-point · code-derived · fits, cr2-raw, branch-point*

Instrumental color, minus-2.5 times the log of blue-over-red flux, is regressed against catalog Gaia BP-RP to recover a slope, intercept, r-squared, and rmse. Only rows whose catalog band is Gaia G feed the fit: Johnson-V / HYG rows are a different photometric system and would corrupt both the color regression and the zero point, so they are counted in the band partition and REFUSED from the fit while still being surfaced per-star. Below eight usable stars the color fit is left UNCALIBRATED (a zero point may still be recorded); a singular normal-equation system (no instrumental-color spread) is flagged DEGENERATE. The color fit is invariant to sensor gain (it rides flux ratios), so it carries no gain caveat.

**Visible at this point:** color slope / intercept / r-squared / rmse · color_fit_status (VALID / UNCALIBRATED / INVALID_REFUSED) · band partition: n_gaia_g vs n_johnson_v · n usable stars

*Anchors: `stage:spcc`, `src/engine/pipeline/m8_photometry/spcc_calibrator.ts`*

#### 16.4. Fit the photometric zero point (labeled by trust)
*pipeline · code-derived · fits, cr2-raw*

The zero point is the clipped median of catalog Gaia G minus instrumental magnitude across the usable Gaia-G stars. It is honestly demoted when its inputs are weak: the absolute zero point rides an APPROXIMATE gain model (the Canon-T6 heuristic ISO-to-gain curve for DSLR, a fixed fallback for FITS -- never a per-camera-calibrated gain, LAW 3), and when no positive exposure time is present the exposure is an ASSUMED one second and the absolute zero point is demoted to a HINT (off by minus-2.5 log of the true exposure). Color and relative products are unaffected in every case. The zero-point regression is where a future single-frame extinction term would be absorbed.

**Visible at this point:** zero point + zp rmse · zero_point_status · zp gain provenance note (heuristic / fixed fallback) · exposure_source: MEASURED or ASSUMED_1S

*Anchors: `stage:spcc`, `src/engine/pipeline/m8_photometry/spcc_calibrator.ts`*

#### 16.5. Record air mass; hold the extinction correction (default OFF)
*branch-point · code-derived · fits, cr2-raw, branch-point*

Air mass at the field center is derived from the solution, metadata, and clock; it is recorded when both a trusted clock and trusted GPS exist and recorded as ABSENT (never fabricated) on a blind solve with no trusted geometry. This is the science/air-mass report: air mass is RECORDED but NOT APPLIED as shipped. The per-star atmospheric-extinction flux correction (k times air mass, default k = 0.15 mag/airmass, an honest broadband-visual value) and the matching zero-point extinction term live behind PSF_FLUX_EXTINCTION_CORRECT, which defaults OFF. The per-band vignette flux divide lives behind PSF_FLUX_VIGNETTE_CORRECT, also default OFF -- and note that even when enabled an achromatic radial gain cancels in the blue-over-red ratio, so correcting COLOR requires the per-band (chromatic) map this path fits. As shipped, none of these divide the fluxes, so SPCC, psf_field, and forced-confirm all consume RAW fluxes and both pinned reference solves stay byte-identical.

**Visible at this point:** air_mass (or absent, with reason) · vignette/extinction correction status: WIRED but default OFF (inert) · raw fluxes feeding the fit

*Anchors: `stage:spcc`, `src/engine/pipeline/constants/pipeline_config.ts`*

**Flags:**

- Answers 'is extinction/vignette applied to the science photometry?': NO as shipped. Both the extinction flux divide + zero-point term (PSF_FLUX_EXTINCTION_CORRECT) and the per-band vignette flux divide (PSF_FLUX_VIGNETTE_CORRECT) are wired but default OFF and additive; air mass is recorded, not applied. A chromatic (per-band) transmission map is required before the vignette lever can correct color rather than only magnitude.

### 17. Apply catalog white balance to the preview
*pipeline · receipt · fits, cr2-raw*

A RENDER-plane, display-only step: the on-screen preview is redrawn using the per-channel white-balance gains the color-calibration step derived from catalog star colors (a total-least-squares / errors-in-variables estimate), replacing the earlier empirical white balance taken from the average color of the frame's bright stars. The gains are anchored to the green channel and clamped to a safe range, and the sky background level is left untouched so the background stays neutral. It applies only when those gains passed their quality gate AND previews are enabled; otherwise it reports a SKIP and leaves the preview on its existing empirical white balance. Because the plate-solve, PSF, and forced-photometry measurements all read the original unscaled linear data, no measured value changes and both pinned reference solves stay byte-identical; the render consumes the ledgers and feeds neither back. It writes no receipt block, and any rendering error is caught and leaves the preview as it was.

**Visible at this point:** preview redrawn through catalog white balance, or SKIP · applied gains (green-anchored, clamped) when applied · verdict APPLIED / SKIP in the stage record

*Anchors: `stage:spcc_render_gains`, `src/engine/core/ImageProcessor.ts`*

#### 17.1. Gate on gain quality and preview availability
*branch-point · code-derived · fits, cr2-raw, branch-point*

The re-render fires only when the calibration gains are present and marked applied (they passed their quality gate), preview generation is enabled, and a preview float buffer plus scale factors exist. If any precondition is missing the step returns applied=false and the preview is unchanged -- an honest SKIP that keeps the empirical white balance rather than forcing a lower-confidence catalog balance.

**Visible at this point:** applied=true (re-rendered) or applied=false (SKIP), with the reason implicit in the missing precondition

*Anchors: `stage:spcc_render_gains`*

### 18. Measure the point-spread field
*pipeline · receipt · fits, cr2-raw*

Using the solved, catalog-matched star positions, this stage measures how star images are shaped across the frame. It is a PIXEL / PSF-measurement product on the science luminance buffer's OWN grid -- native, or 2x2-binned when the sensor-native path produced a downscaled buffer -- with no resampling before measurement, so reported shapes are not blurred by interpolation. It reads only the luminance buffer and never alters the world-coordinate solution, the matched-star list, or the confidence. Results (per-star full-width-at-half-maximum, ellipticity, orientation, summarized as a coarse three-by-three field map) are written to the psf_field receipt block; with no solution, no image buffer, or inconsistent dimensions the stage records psf_field as null rather than a fabricated map.

**Visible at this point:** per-star FWHM / ellipticity / orientation · field medians + coarse 3x3 map of shape variation · fit method (compiled LM vs moment fallback) · grid label: SCIENCE_NATIVE or SCIENCE_BINNED2X · psf_field null on honest absence

*Anchors: `stage:psf_field`, `src/engine/pipeline/stages/psf_characterize.ts`, `src/engine/pipeline/m10_psf/psf_field.ts`*

**Flags:**

- [NOT CONFIRMED / alias] The enrichment ledger carries BOTH stage:psf_field (receipt-observed, walked cr2+fits) and stage:psf_characterize (code-side function id, walked_by [] -- never surfaces in a receipt). The runtime withStage id is 'psf_field'; psf_characterize.ts is the function it wraps. Confirm stage:psf_characterize is a code-side alias, mirroring the documented psf/integrate fold-before-completion trap (code stage ids that never appear in receipts).

#### 18.1. Disambiguate native vs binned grid
*branch-point · code-derived · fits, cr2-raw, branch-point*

The science buffer is either native (width times height) or 2x2-binned (half by half); the length is tested against both and the measurement grid is set accordingly. If the length matches neither, dimensions are incoherent and the stage skips honestly (returns null). Planetary-verification sentinels are excluded from the star set (they are not stellar PSFs).

**Visible at this point:** grid decision (native / binned) or honest null on incoherent dims · star set with planet sentinels excluded

*Anchors: `stage:psf_field`*

#### 18.2. Fit each star's shape (compiled least-squares, honest fallback)
*pipeline · code-derived · fits, cr2-raw*

A two-dimensional Gaussian is fit to a small pixel stamp around each star through a compiled Levenberg-Marquardt least-squares routine (wasm refine_stars_lm), with a local background subtracted from each stamp first because that routine carries no baseline term. When the compiled routine is unavailable the stage degrades to a moment-based estimate and labels the method as such rather than inventing a fit. A formal error bar is reported only for fits whose covariance is well-conditioned. The optional per-star vignette AMPLITUDE correction (CELL 2) is produced only when its flag is on; default OFF means no corrected amplitude is recorded and the measurement is byte-identical.

**Visible at this point:** per-star fitted width / ellipticity / orientation · method label (compiled LM vs moment) · formal error bar where covariance is well-conditioned · vignette amp correction: default OFF (no corrected amp)

*Anchors: `stage:psf_field`, `boundary:wasm_refine_stars_lm`*

#### 18.3. Summarize the field into a 3x3 map
*pipeline · code-derived · fits, cr2-raw*

The per-star fits are reduced to field medians (major/minor FWHM, ellipticity, orientation) and a coarse three-by-three grid of nine regions capturing how the shape varies across the frame. Each region's median shape is what the attribution step reads next. Every summarized number is honest-or-null; the raw per-star fits stay a diagnostic detail on the block.

**Visible at this point:** field median FWHM / ellipticity / orientation · 3x3 regional shape map (nine regions) · number of successful fits

*Anchors: `stage:psf_field`, `src/engine/pipeline/m10_psf/psf_field.ts`*

### 19. Attribute the measured PSF to physics
*pipeline · receipt · fits, cr2-raw*

After the point-spread function is measured, this step explains the measured star shapes by predicting the physical effects that broaden or elongate them and comparing each prediction against the measurement, which stays the sole arbiter. It changes nothing it reads and is purely additive, so the sacred solve stays byte-identical by construction (physics INFORMS and GUIDES, never OVERRIDES). Every output is labeled by one of six epistemic tiers -- CALCULATED (immutable maths), CONFIRMED (a calculated quantity validated against the measurement, then trusted as exact for its share), FITTED (form immutable, magnitude fit from the measurement), APPROXIMATE (assumed constants or approximate models), INFERRED (a deduction from the comparison), or NOT_MEASURED (inputs unavailable, honest absence) -- so a fabricated number is never presented as a measurement. It decomposes the measured anisotropy into sidereal drift, diffraction, seeing, differential refraction, and coma, plus an unexplained residual core.

**Visible at this point:** measured major/minor FWHM, ellipticity, anisotropy (copied from psf_field) · per-systematic prediction with its epistemic tier · decomposition into explained-drift + residual core · mount/tracking inference · list of APPROXIMATE assumptions used

*Anchors: `stage:psf_attribution`, `src/engine/pipeline/stages/psf_attribution.ts`*

#### 19.1. Sidereal drift -- calculated, then test-then-trust
*branch-point · code-derived · fits, cr2-raw, branch-point*

The expected star trail for an untracked mount is CALCULATED exactly from exposure time, declination, and pixel scale, with its direction taken from the fitted CD matrix (or synthesized from roll/scale/parity, flagged as such). A presence gate then tests it against the measurement: a predicted trail below about half a pixel (the 0.5-pixel measurement floor) is marked NEGLIGIBLE -- it can neither be confirmed nor refuted. Otherwise it is CONFIRMED_PRESENT only when the measured elongation agrees in DIRECTION to within about twenty degrees and in MAGNITUDE to within about a third (line-angle tolerance 22 degrees, magnitude tolerance 0.35 against the core-line quadrature). A confirmed trail is then trusted as EXACT for its component and the remainder reported as an unexplained residual core; a mismatch is NOT_CONFIRMED and the elongation is attributed elsewhere. Parity is honored via the CD/roll direction; the sign of the sky is never asserted independently.

**Visible at this point:** calculated drift (arcsec and px) + drift position angle · presence: CONFIRMED_PRESENT / NOT_CONFIRMED / NEGLIGIBLE · direction deviation + magnitude ratio evidence · explained-drift and residual-core px when confirmed · the exact drift kernel seam (for a future known-kernel deconvolution)

*Anchors: `stage:psf_attribution`*

#### 19.2. Diffraction floor -- calculated per color channel
*pipeline · code-derived · fits, cr2-raw*

The diffraction-limited FWHM floor (1.028 times wavelength over aperture diameter) is CALCULATED per color channel from focal length and aperture, reported in both arcseconds and science-grid pixels, alongside the green-channel Rayleigh limit and the aperture diameter. It is a lower bound on the measured PSF -- never a subtraction from it. When focal length, aperture, or scale are unavailable it is recorded as NOT MEASURED.

**Visible at this point:** per-channel diffraction floor (arcsec + px) · green Rayleigh limit · aperture diameter · diffraction-limited flag for green

*Anchors: `stage:psf_attribution`*

#### 19.3. Seeing -- approximate, air-mass scaled
*pipeline · code-derived · fits, cr2-raw*

An APPROXIMATE seeing estimate is reported as an assumed zenith value (2.0 arcseconds) scaled by air mass through the standard secant-z-to-the-0.6 law. Air mass here reuses the same observing geometry the refraction cell computes -- altitude, hour angle, and air mass from the target coordinates, observer GPS, and the zone-honest capture instant -- and is null when no trusted geometry exists (then seeing falls back to air mass one). The assumed 2.0-arcsecond zenith constant is recorded in the APPROXIMATE list so it is never mistaken for a measured site seeing.

**Visible at this point:** approximate seeing (arcsec + px) · air mass used (or 1 when geometry absent) · explicit note that the 2.0 arcsec zenith is ASSUMED

*Anchors: `stage:psf_attribution`*

#### 19.4. Differential refraction + chromatic dispersion -- predictor only
*branch-point · code-derived · fits, cr2-raw, branch-point*

This cell revives the DifferentialRefractionCorrector (Bennett 1982 apparent-altitude form, delegated to the optics manager) to predict the field-level plate stretch toward the zenith across the frame, plus a chromatic-dispersion term (cell 5) that predicts the single-star PSF elongation from blue refracting more than red. Both are APPROXIMATE and, crucially, PREDICTOR ONLY -- they are reported alongside the measurement and NEVER wired back into the solve or subtracted from the measured shape (LAW 1, the measurement stays the arbiter). The cell is gated: it fires only when BOTH the capture clock and the observer GPS pass their strict trust gates (a zone-resolved clock and a real location), because a bogus clock or defaulted position yields bogus alt-az geometry; otherwise it records NOT MEASURED with the reason stated. RA is carried in HOURS through the geometry; the parallactic/zenith direction sets the elongation axis without asserting a sky sign.

**Visible at this point:** target altitude + air mass · field differential refraction (arcsec + px) · zenith/parallactic image position angle · chromatic-dispersion magnitude (arcsec + px) along the zenith line · NOT MEASURED with reason when clock or GPS is untrusted

*Anchors: `stage:psf_attribution`, `src/engine/pipeline/m5_coordinate_flatten/differential_refraction_corrector.ts`*

#### 19.5. Coma -- form immutable, magnitude fitted
*pipeline · code-derived · fits, cr2-raw*

Coma is FITTED: its FORM is immutable (ellipticity grows radially with field radius, oriented radially), and only its magnitude coefficient is fit from the measured three-by-three field, so it is form-exact and magnitude-empirical -- accumulable per lens copy later (like Brown-Conrady distortion), never fabricated from EXIF. It requires all nine measured regions and at least four successful fits; when the measured field does not match the radial coma form no coefficient is asserted, and with too few regions it is NOT MEASURED.

**Visible at this point:** coma coefficient (when the field matches the radial form) · pattern-consistent flag · NOT MEASURED when regions are too few

*Anchors: `stage:psf_attribution`*

#### 19.6. Decompose the shape and infer the mount
*pipeline · code-derived · fits, cr2-raw*

The systematics converge into one decomposition: when drift is confirmed the measured major axis is exact-drift in quadrature with a residual core (the seeing/guiding/focus/optics that physics cannot attribute to drift, with the diffraction and seeing floors sitting inside it); with no confirmed drift the whole measured PSF is reported as residual. From the drift presence gate the mount is INFERRED as untracked (measured elongation matches the static sidereal drift), tracked (measured elongation far below the predicted drift), or indeterminate. Two additive cells ride alongside, both honest-or-absent: undistorted PSF centroids (cell 4 -- native plus native-to-corrected positions via the injected this-solve or resolved Brown-Conrady lens model; a SIP/TPS solve with no native-to-corrected applicator records native-only as an honest gap, and the pinned CR2's lying EXIF yields no model, so native only), and a sky-deprojected shape (cell 6 -- the pixel shape converted to sky angle through the local CD Jacobian, behind a flag that defaults OFF; the forced-confirm shape gate keeps consuming raw pixels, so a migration would need a paired recalibration).

**Visible at this point:** decomposition: measured major = explained drift (x) residual core, or all-residual · tracking inference: UNTRACKED / TRACKED / INDETERMINATE + rationale · undistorted centroids with model provenance (or honest native-only gap) · sky-deprojected shape (only when the default-off Jacobian flag is enabled)

*Anchors: `stage:psf_attribution`*

---

## Chapter 5 — Packaging & Export  *(segment D)*

> ON-DEMAND: this chapter runs when the user exports/downloads or the headless driver writes — it is NOT a receipt-observed runtime stage. The receipt-replayed stage order ends at forced_confirm → calibrate; a single buildReceipt call folds the run's stage records into the receipt at export/download time. Drawn as the terminal chapter; segment D's packaging-placement OWNER RULING NEEDED flag is carried unchanged for the owner.

### 20. Stamp what produced this run
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Before (in code, DURING) the receipt is assembled, the pipeline records the self-description a third party needs to reproduce the run: the schema version the document conforms to, the engine build identity and the state of the load-bearing flags that changed the scientific product, and a full reproducibility envelope. These three are computed inline within the single receipt-assembly call, not as separate runtime stages, and none of them is a receipt-observed stage; they are presented as a distinct step because they answer a distinct question -- 'which build, which config, which catalog produced this?' -- that a user genuinely asks. Every field here is MEASURED or an honest null whose note explains why it is absent; nothing is fabricated. This whole block is deliberately OUTSIDE the byte-identical pinned-solve contract, because build/platform/version values legitimately vary from one machine to another.

**Visible at this point:** receipt schema version (the API contract version) · engine build version + load-bearing flag states · reproducibility envelope (source commit, lock digest, atlas content id, effective_config_hash, compute backend, platform, wasm identity)

*Anchors: `stage:schema_versions`, `stage:build_identity`, `stage:reproducibility`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): elevation CONFIRMED (one step per reproduce-this-run question a user could ask). [orig question] build-identity, reproducibility and schema-version are computed INLINE inside the single buildReceipt call (never separate runtime stages, never in the receipt stage_order), but the enrichment ledger carries them as distinct stage:* nodes and they answer a distinct 'reproduce-this-run' question. This draft elevates them to their own major step. Confirm the elevation vs. nesting them as sub-concerns of receipt assembly.
- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): terminal chapter WITH the explicit on-demand trigger note (fires at export/download or headless write). [orig question] this entire packaging/export chapter is NOT a receipt-observed stage (the stage_order walk ends at forced_confirm -> calibrate); buildReceipt runs once at export/download time and folds the stage_records in. Is packaging drawn as a terminal chapter after the refinement chapter, or as an on-demand branch off the completed run (triggered by the user's export choice / the headless driver's write)?

#### 20.1. Stamp the schema version
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The receipt carries a single schema-version constant -- the versioned contract for the exported solve receipt (live value 2.27.0 on this branch) -- emitted from one shared source rather than a hand-written number anywhere in the assembly. A version is NEVER advanced without a genuine structural change; bumping it with zero shape change would be dishonest versioning. A separate, independently-lifecycled science-packet version tracks the compact strip-a-RAW export, and a third in-memory result-wrapper version deliberately lives elsewhere -- the three are NOT unified so a version reliably distinguishes products of different shapes. A value-neutral shape fingerprint (receipt_schema) hashes the receipt's STRUCTURE so that adding, renaming, removing, or retyping a field forces a deliberate version decision, while a change to a numeric VALUE leaves the fingerprint untouched -- the tripwire that makes the honest-versioning rule enforceable.

**Visible at this point:** receipt.version = RECEIPT_SCHEMA_VERSION (2.27.0) · the three separate product versions kept distinct

*Anchors: `stage:schema_versions`, `src/engine/pipeline/stages/schema_versions.ts`*

#### 20.2. Record the engine build and load-bearing flags
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The engine/app build version is resolved through the unified version manifest (which resolves in turn to the package manifest's version), checked against the real package manifest by a drift test so it can never silently go stale, and reported as absent rather than fabricated when the surface is missing. Alongside it, three load-bearing flag states are read -- each through the SAME predicate the pipeline itself keys on, so the recorded state can never disagree with what actually ran: which raw-image decoder arm is active (it changes the frame PIXELS), which star-atlas source is active (it changes the CATALOG the solve matched against), and a confirmation-diagnostic flag (it changes receipt content, not the verdict). Two of the three change the scientific product outright; all three are recorded because a third party reproducing a receipt byte-for-byte needs their state.

**Visible at this point:** engine_version (or honest null) · VITE_DECODER_RAWLER · VITE_ATLAS_GAIA · CONFIRM_FDR_SHADOW flag states

*Anchors: `stage:build_identity`, `src/engine/pipeline/stages/build_identity.ts`*

#### 20.3. Assemble the reproducibility envelope
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The envelope records the execution context needed to reproduce the solve: the source commit identifier, a dependency-lock digest, the star-atlas content identity (the committed golden fingerprint of the shipped catalog, plus a fresh build-box atlas-manifest hash that catches drift between the committed expectation and the bytes that actually shipped), a source clean-or-dirty tri-state flag, the compute backend the numeric solve ran on, the measured runtime (Node version or browser, detected by reading environment globals and claiming nothing), and the wasm crate identity. Layered on top is the effective_config_hash: a stable fingerprint of the ENTIRE effective config snapshot (not just the override delta), so a reader knows exactly which knob set shaped the run -- value-sensitive by design, so any knob change moves it. Every field is a MEASURED value or an honest null whose accompanying note names WHY it is unavailable and what would make it measurable -- never a placeholder. The whole block sits outside the byte-identical contract by construction.

**Visible at this point:** source commit · lock digest · atlas content id + manifest sha · source_dirty · compute_backend · platform · wasm identity · effective_config_hash (full-config fingerprint)

*Anchors: `stage:reproducibility`, `src/engine/pipeline/stages/reproducibility.ts`*

### 21. Assemble the measurement receipt
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

Every computed pipeline product is folded into a single, schema-versioned document -- the receipt, which is also the headless Toolchest API product. It reads BOTH the coordinate and pixel ledgers and mutates NEITHER (LAW 1); the heavy pixel arrays are still live references at this point and are dropped later, at serialization time. The assembly is honest-or-absent throughout (LAW 3): every block is either a MEASURED value the run produced or an explicit null -- never a placeholder number. The discipline that keeps the pinned reference solves byte-identical across schema growth is that every new block is ADDITIVE and honest-null on the sacred frames, so the asserted scientific fields never move. Two sub-decisions define the coordinate spine (which WCS is written) and the product's shape (solved vs no-solve); the rest of the assembly folds the honest-or-absent measurement blocks and the observer's testimony.

**Visible at this point:** the full assembled receipt object (live pixel refs still attached) · solution summary: sentinel-filtered residuals + REAL mean star width · every honest-or-absent product/provenance block

*Anchors: `stage:package`, `src/engine/pipeline/stages/package.ts`*

#### 21.1. Emit the fitted world-coordinate solution
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

The receipt writes the REAL fitted world-coordinate matrix -- the crpix/crval/CD that actually verified the matched stars -- and only falls back to a re-synthesized approximation, explicitly labelled SOURCE:'SYNTHESIZED', when no fitted matrix exists. This is the one place right ascension crosses from the engine's internal HOURS to FITS degrees: crval[0] is multiplied by 15 HERE, so the downstream export writers must consume the receipt WCS verbatim and never multiply again (the double-conversion trap). Declination stays in degrees throughout. The pixel convention is stated honestly -- engine 0-based centres, y-down image space -- and the CD matrix carries image-space parity as fitted; no sign is asserted (a true 1-based/flipped FITS writer is a downstream deliverable, not this emission). The FITTED-vs-SYNTHESIZED discriminator is load-bearing: it is the precondition the FITS/ASDF export arms gate on, so a synthesized approximation is never later written as if it verified stars.

**Visible at this point:** receipt.wcs {CTYPE,CRPIX,CRVAL(deg),CD(deg/px),SOURCE} · SOURCE = FITTED | SYNTHESIZED

*Anchors: `stage:package`, `boundary:fits_io`, `src/engine/pipeline/stages/package.ts`*

#### 21.2. Fold the honest-or-absent measurement and provenance blocks
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The solution summary is built by filtering sentinel values out of the residuals (dropping planet-verification markers and non-finite entries) and reporting the REAL mean star width from the matched stars -- not the solver's residual proxy -- falling back to the forensic estimate only when no width samples survive, and to null when even that is absent. Around it, the assembler folds the run's measurement blocks strictly by SURFACING existing computation, each honest-or-absent: per-star photometry, SPCC colour, the PSF field and its attribution, and hardware profile (all owned and measured by the science/refinement chapters -- enumerated here, never re-computed), plus the packaging-owned provenance blocks: pipeline_provenance (which raw decoder arm produced the pixels + which atlas content the solve matched), solve_provenance (the CATEGORY of search prior active when the solve locked -- blind / user-assisted / metadata-assisted -- denominator bookkeeping, never a quality tag), and a derived four-state confirm_status classification over the already-computed forced-photometry block. None of these fold-ins touches the WCS, matched stars, scale, or confidence.

**Visible at this point:** solution summary (sentinel-filtered residuals, real mean_fwhm_px) · pipeline_provenance {decoder_arm, atlas_id} · solve_provenance.solved_via · confirm_status four-state verdict · cross-referenced science blocks (spcc / psf / photometry) honest-or-absent

*Anchors: `stage:package`, `stage:solve_provenance`, `src/engine/pipeline/stages/package.ts`*

**Flags:**

- [SEGMENT BOUNDARY] The per-star photometry / SPCC / PSF blocks folded here are MEASURED and owned by the photometry-science chapter (segment C); this step only surfaces them into the receipt honest-or-absent. Cross-reference, not ownership.

#### 21.3. Attach the observer's testimony
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The observer's free-text testimony -- a target description, location text, a sky-quality note, rig notes, and any session issues -- is attached as STRINGS ONLY, never parsed into a number, a knob, or any solve input. It is kept structurally separate from the metadata that feeds the physics model, so testimony can never be laundered into evidence (a location string never becomes a GPS fix; a 'Bortle 4' note never becomes the numeric bortle class the model reads). When every field is empty the block is recorded as null rather than an empty skeleton, which is what keeps the pinned reference solves byte-identical -- their receipts carry a null testimony block. Provenance is recorded as either typed directly by the observer or drafted by the annotation assistant and then EXPLICITLY confirmed in the export interface before being applied; the assistant tool never writes a session on its own -- the UI confirm is the only gate that promotes a draft.

**Visible at this point:** user_annotations {description, location_text, sky_bortle_text, rig_notes, session_issues, provenance, captured_at} or null

*Anchors: `stage:user_annotations`, `src/engine/pipeline/stages/user_annotations.ts`*

#### 21.4. Solved receipt or honest no-solve record
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

The receipt is a discriminated union of two products. A SOLVED run assembles the full receipt above. A run that produced NO geometric lock assembles a SEPARATE no-solve record instead -- so the analytics flywheel banks an honest artifact rather than a frame that vanishes. The two are told apart STRUCTURALLY: the no-solve receipt carries an explicit no-solve marker and a null solution, and a solved receipt carries a non-null solution and no such marker (a consumer narrows on solution === null). The no-solve product is itself honest-or-absent -- it reduces the heavy detection buffers to COUNTS, carries the solve ladder's own attempt diagnostics, and sets every block a solved receipt would carry (WCS / PSF / SPCC / confirm) to explicit null. The solved builder is untouched by the no-solve builder, which is exactly why the pinned reference solves stay byte-identical by construction.

**Visible at this point:** solved receipt (solution != null) OR no-solve receipt (kind:'no_solve', solution:null) · on no-solve: detection counts, solve-attempt diagnostics, failure block

*Anchors: `stage:package`, `src/engine/pipeline/stages/package.ts`*

### 22. Serialize the receipt to bytes
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The assembled receipt object is turned into the canonical receipt bytes. Serialization is PURE -- no browser download or document machinery lives in the byte producer -- so a command-line consumer produces receipts byte-identical to the browser's (one implementation, two callers). A read-only structural check runs at the real export boundaries, observing and warning without ever rejecting, transforming, or reshaping the receipt, so the emitted bytes are identical whether or not it runs.

**Visible at this point:** canonical receipt JSON bytes (heavy typed arrays stripped) · structural-drift warning (if any) — non-mutating

*Anchors: `stage:receipt_serializer`, `stage:receipt_schema`, `src/engine/pipeline/stages/receipt_serializer.ts`*

#### 22.1. Strip the heavy typed arrays
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

A JSON replacer drops a FIXED set of heavy typed-array fields -- the science image buffer, segmentation masks, the horizon vector, and grid arrays -- which JSON encoding would otherwise expand into hundreds of megabytes of index-keyed text. The set is explicit and closed, so a future producer of a large typed array cannot silently explode the receipt. A companion helper names the output file from the solution's spatial hash, falling back to a timestamp when no solve produced one. The result is the exact byte stream both the browser download and the headless driver emit.

**Visible at this point:** receipt JSON minus {scienceBuffer, segmentationMasks, horizonVector, anomaly_grid, scattering_profile} · file name: baseName_${spatial_hash|timestamp}.json

*Anchors: `stage:receipt_serializer`, `src/engine/pipeline/stages/receipt_serializer.ts`*

#### 22.2. Observe-and-warn structural validation
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

At the real export boundaries (the browser save and the headless write) a structural validation runs as a read-only diagnostic: it checks that every required top-level field is present and that each engine-owned discriminator, parity, and scalar field has the expected type, then emits any mismatch as a single labelled warning -- it NEVER rejects, transforms, or writes into the receipt, so the downloaded bytes are value-neutral to it. It dispatches on the same structural tag the variant fork used (a no-solve receipt is the one carrying the explicit marker and null solution) and tolerates additive fields and honestly-null identity fields, because additive growth is not drift. The paired value-neutral shape fingerprint is what makes an added/renamed/removed/retyped field force a deliberate schema-version decision while leaving numeric-value changes invisible to it.

**Visible at this point:** one labelled drift warning or clean pass (bytes unchanged either way)

*Anchors: `stage:receipt_schema`*

### 23. Export the products
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

One unified dispatcher owns every export format and knows how each is written; it is also the honest availability gate. For the current run it returns, per format, either available or a DISABLED row with a human reason -- 'run the pipeline first', 'requires a fitted WCS', 'requires the science frame' -- surfacing the FIRST unmet precondition. The formats fork here: a JSON receipt and Arrow tables need only a completed run; FITS and ASDF need a FITTED (star-verified) WCS AND the science frame in memory; PNG and C2PA are declared-coming, shown disabled and NEVER faked. The dispatcher also picks the runtime sink -- a native save dialog plus file write on the Tauri desktop shell, or a Blob/anchor download in the browser -- with byte production never re-implemented here (the shared dependency-free serializers own the bytes). All arms are on-demand outcomes of the user's format choice; they converge back to a written file.

**Visible at this point:** per-format availability matrix {available, reason, coming} · chosen runtime sink (Tauri save-dialog | browser download)

*Anchors: `src/engine/ui/utils/save_export.ts`*

#### 23.1. Availability matrix and runtime sink
*branch-point · code-derived · fits, cr2-raw, jpeg-tiff, branch-point*

The single availability matrix is pure over the receipt plus a has-science-frame flag: receipt/arrow flip available the moment a run completes; FITS/ASDF flip available only when the receipt carries a FITTED WCS AND the science frame is still in memory, and otherwise carry the first unmet reason; PNG/C2PA are always disabled with a coming note. This is the UI-side enforcement of the fitted-WCS-only export law -- the same law the FITS/ASDF byte writers enforce again on their own. The sink is chosen at write time: the Tauri desktop shell opens a native save dialog and writes the bytes (the browser bundle never loads the desktop plugins), while the browser path builds a Blob and clicks a download anchor. A cancelled desktop dialog is an honest no-op, not an error.

**Visible at this point:** EXPORT_FORMATS menu (receipt · fits · asdf · arrow · png-coming · c2pa-coming) · disabled rows with reasons · sink = Tauri save-dialog | browser Blob

*Anchors: `src/engine/ui/utils/save_export.ts`*

**Flags:**

- [SEGMENT BOUNDARY] The headless / batch write path (tools/api solve_to_receipt.runspec + headless_driver) writes canonical receipt bytes DIRECTLY via serializeReceipt, bypassing this UI dispatcher; that interface/headless arm is segment E. Cross-reference.

#### 23.2. Write the JSON receipt
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The always-available product: the full measurement receipt as JSON. The browser path is thin -- it runs the observe-and-warn validation, serializes the packet minus the heavy buffers through the shared pure serializer, and triggers a download named from the spatial hash. No byte machinery is duplicated here; the same serializer feeds the desktop sink and the headless driver, so all three surfaces emit identical bytes.

**Visible at this point:** skycruncher_receipt_${spatial_hash|timestamp}.json (heavy buffers stripped)

*Anchors: `src/engine/ui/utils/save_packet.ts`, `src/engine/pipeline/stages/receipt_serializer.ts`*

#### 23.3. Write a FITS file
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The one dependency-free FITS serializer (desktop, browser and headless all run it) writes the science frame as a big-endian float32 payload plus the fitted WCS as keyword cards. It enforces the export law: it REFUSES an absent WCS, a SYNTHESIZED WCS, or any non-finite WCS keyword -- a synthesized approximation is never written as if it verified stars. It consumes the receipt WCS VERBATIM (already degrees, CD in deg/px, 0-based crpix) and therefore must never re-multiply CRVAL by 15 -- the ×15 already happened once at receipt assembly, and the ONLY coordinate arithmetic here is CRPIX+1 to reach FITS 1-based. This is one of two independent HOURS->degrees conversion sites (the stacking lane's own FITS writer is the other, and eats an engine-internal WCS, not a receipt WCS -- the two must never both fire on the same number). SIP coefficients are run through the shared internal->FITS sign bridge (a pure negation, A_FITS = IDEAL - OBSERVED = -A_internal) so a reader that APPLIES them moves stars TOWARD the catalog instead of away -- emitting the raw internal coefficients was the M7 sign bug. Non-finite samples are preserved as the IEEE-NaN FITS blank (differs from the stacker's 0-fill) so a reader's footprint mask survives.

**Visible at this point:** skycruncher_${spatial_hash}.fits (BITPIX -32, fitted WCS cards, SIP negated, NaN blanks) · REFUSED with a reason when WCS is absent/synthesized/non-finite

*Anchors: `src/engine/pipeline/export/fits_writer.ts`, `src/engine/pipeline/export/sip_convention.ts`, `boundary:fits_io`, `boundary:fits_nan_mask`*

#### 23.4. Write an ASDF / GWCS file
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The one dependency-free ASDF serializer writes the image as a little-endian binary block plus the FULL receipt as YAML metadata, AND a native astropy-interpretable GWCS transform pipeline. Two WCS carriers ride the file: a labelled FITS-keyword mapping (the fallback for readers without gwcs) and, alongside it, a native gwcs transform tree carrying either LINEAR+SIP or, when a thin-plate spline is fitted, a TPS tabular lookup. It is honest-or-absent with a deliberate asymmetry vs the FITS writer: an UNSOLVED receipt still exports with the WCS blocks simply absent (ASDF is the full-receipt carrier), but a present-but-non-FITTED WCS refuses loudly. Both distortion carriers export the FITS/astropy sign direction: SIP through the same shared negation bridge, and the TPS tabular table baked as u - f (subtraction, not addition) using the fitter's OWN evaluator so nothing drifts -- because the tabular output IS the coordinate fed to the CD matrix with no implicit add, the table must already hold the corrected offset. The GWCS fidelity is proven, not asserted: a Python oracle checks that pixel->world reproduces the FITS-WCS to sub-arcsec, and the tag/extension versions are captured from that installed oracle rather than guessed.

**Visible at this point:** skycruncher_${spatial_hash}.asdf (image block + YAML receipt + native gwcs/wcs) · wcs_fits fallback mapping + native wcs (LINEAR+SIP or TPS tabular) · REFUSED when wcs is present-but-non-FITTED; WCS blocks absent when unsolved

*Anchors: `src/engine/pipeline/export/asdf_writer.ts`, `src/engine/pipeline/export/sip_convention.ts`*

#### 23.5. Write the Arrow tables
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

A completed run's tabular results are packaged as Apache Arrow columnar files (little-endian Feather v2) for external tools and dashboards: the matched catalog stars, the detected sources, the catalog-forced confirmed photometry, and a single-row run summary carrying the solve centre, pixel scale, and confirmation verdict. Every column is labelled with its physical units in the field metadata -- which heads off the recurring right-ascension unit confusion, since the run summary reports RA in HOURS while the matched-star table reports it in DEGREES, and both say so; residuals are in arcseconds, positions in pixels. The export only READS a completed run and performs no new computation, and it is honest about absence: a missing product is written as an EMPTY table carrying the full column schema, never a fabricated row. The catalog identifier is written as text so a large integer id is not rounded, and columns that can never be null carry no validity bitmap. The heavy Arrow dependency is lazy-loaded so it never bloats the base bundle.

**Visible at this point:** ${stem}_${tag}_{matched_stars|detections|forced|summary}.arrow · units-labelled columns (RA hours in summary, RA degrees in matched table) · empty-schema table on an absent product

*Anchors: `boundary:toolchest_arrow_export`*

#### 23.6. Render products (boundary note — declared, not faked)
*pipeline · code-derived · fits, cr2-raw, jpeg-tiff*

The RENDER plane's export products are honestly declared but not built. A rendered-image PNG export and a C2PA provenance-signed export are shown in the format menu as 'coming' -- disabled rows with a human reason, never a fabricated file. This honours the three-layer law: the render plane consumes BOTH the coordinate and pixel ledgers and feeds NEITHER; it is display-only and default-off. The receipt already carries render-plane blocks as ready slots that are honestly null because no producer stage is wired -- for example the multiscale nebulosity decomposition block sits at null on every real receipt (its widget shows DECOMPOSITION NOT RUN) until a render stage lights it up. The C2PA signing path, when built, verifies against the legacy assertion namespace so previously-signed assets keep verifying while new signatures use the current namespace; today it is a disabled, declared row.

**Visible at this point:** PNG row (coming, disabled) · C2PA row (coming, disabled) · render-plane receipt blocks null (e.g. nebulosity_layer) — no producer wired

*Anchors: `src/engine/ui/utils/save_export.ts`*

**Flags:**

- RULED 2026-07-17 (DEC-2026-07-17-02, defaults): honest stub in the map; full treatment belongs to the render-products build NOW IN FLIGHT (worktree rest/wt-renderprod) -- note that the map updates when it lands. [orig question] render products (PNG rendered-image export, C2PA signing) are declared-coming/not-built and the render-plane receipt blocks (e.g. nebulosity_layer) are null with no producer. Is this render-products boundary note in scope for the packaging chapter, or a stub belonging to a future render chapter?

---

## Chapter 6 — Handing the result back  *(segment E)*

### 24. Hand the result back to the caller
*interface · code-derived · fits, cr2-raw, jpeg-tiff, interface*

Each arm returns the solve through its own exit, but all return the SAME receipt content underneath. The interactive wizard advances to the step-7 review UI and can save a packet; the headless driver returns the receipt object directly (bit-identical to the browser export); the MCP surface returns a compact solve summary (or a saved-receipt projection, or a rendered widget PNG); the batch queue marks each row solved or failed and keeps the run replayable. An honest NO-SOLVE is a first-class returned outcome on every arm -- a failure receipt / a solved:false summary / a failed row -- never a guessed pose dressed as a solution. The receipt's assembly, serialization, and export formats (the Float32-stripping serializer, the schema version, FITS/ASDF writers, save-packet) are owned by the packaging/export chapter; this step is only the interface-level 'how each arm returns'. Per the forced-confirm ruling, the returned receipt's last upload->solve beat is the forced-photometry confirmation record; the refinement chapter cross-references it rather than owning it.

**Visible at this point:** returned receipt / compact summary / saved packet · honest no-solve outcome (failure receipt | solved:false | failed row)

*Anchors: `tools/api/headless_driver.ts`, `tools/mcp/server.mjs`, `stage:forced_confirm`*

**Flags:**

- Cross-ref: receipt assembly / serializer / RECEIPT_SCHEMA_VERSION / FITS+ASDF writers / save-packet are owned by the packaging/export segment (D). This step is the interface-level return only. Forced-confirm scope = ruling 7 (last beat of upload->solve; refinement chapter cross-references).

---

## Owner ruling queue

Every `OWNER RULING NEEDED` flag in the map, in walk order. These are the open scope-boundary calls for the owner; each stays surfaced here until ruled.


_0 open owner ruling(s)._
