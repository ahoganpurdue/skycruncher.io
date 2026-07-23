/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCHEMA VERSIONS — single home for the pipeline's serialized-product versions
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three "versions" circulate in this codebase. They are THREE DIFFERENT
 * PRODUCTS, deliberately NOT unified to one number:
 *
 * 1. `RECEIPT_SCHEMA_VERSION` — the wizard receipt (stages/package.ts
 *    `buildReceipt`). This is THE Toolchest API contract version: the JSON
 *    the step-7 export downloads and headless drivers return. Consumed as
 *    "v2.x" by `tools/psf/solution_to_astrometry.mjs` (shape-discovery on
 *    `version + solution`). Do NOT bump without a schema change — bumping
 *    with zero schema change is dishonest versioning.
 *
 * 2. `SCIENCE_PACKET_VERSION` — the auto-path AstroSciencePacket
 *    (m9_export/serializer.ts `buildAstroPacket`, the <100KB "strip a RAW"
 *    product). A different product with its own lifecycle per that file's
 *    own header; it happens to be at 1.0.0.
 *
 * 3. `AstroPacket.version "1.1"` (types/manifest.ts) — the DEMOTED internal
 *    result model (ROADMAP "AstroPacket disposition": demoted, not deleted).
 *    It is a TypeScript literal type on an in-memory manifest wrapper, not a
 *    serialized product contract. Intentionally NOT centralized here.
 */

/** Wizard receipt (buildReceipt) schema version — the API contract version.
 *  2.3.0: additive `solution.astrometry.tps` block (thin-plate-spline distortion
 *  fit — a non-polynomial companion to `sip`, carried into ASDF/GWCS as a tabular
 *  lookup transform). Present only when the fire gate fires AND the fitter's
 *  coverage discipline admits the sample; honest-absent otherwise.
 *  2.4.0: two additive, honest-or-absent measurement blocks (ATMOSPHERE_SEXTANT_SPEC
 *  incs 3+4, landed across this wave, both pure observation — solve byte-identical):
 *   • SCHEMA A (inc 3): per-matched-star 2D residual vectors — `dx_px`/`dy_px` (px,
 *     det − predicted) + `dRA_arcsec`/`dDec_arcsec` (tangent-plane sky residual through
 *     the fitted CD, parity included) on each `solution.matched_stars[]`, plus
 *     `solution.rig_correction_applied`. Replaces the step-6 quiver's radial-from-centre
 *     synthesis with the real vector (the refraction-gradient input).
 *   • SCHEMA B (inc 4): additive `solution.photometry` block (per-star instrumental
 *     magnitudes + catalog band tag Gaia-G vs Johnson-V, MATCHED / CATALOG_FORCED /
 *     SPCC provenance) + `matched_stars[].cat_band`. Pure surfacing of existing
 *     computation; null-on-absence.
 *  2.5.0: additive top-level `optics_hints` block — the labelled focal-length
 *   ASSUMPTIONS that seeded the scale lock (untrusted-FL hint-provider seam,
 *   core/optics_hint_provider.ts). Each carries {value_mm, source, assumed:true,
 *   reason}; makes the historically-silent wide-field-prior substitution
 *   receipt-visible. null-on-absence (trusted FL / FITS-header lock). Pure
 *   pre-solve seeding surfaced as provenance — the verify gate stays the sole
 *   arbiter, so both sacred solves are byte-identical (SeeStar: null block).
 *  2.6.0: additive top-level `source_provenance` block — the ORIGIN of the frame's
 *   BYTES (Google Drive file/folder, HTTP/archive URL, or local-drop), matched at
 *   ingest against the intake fetcher's content-sha ledger (tools/overnight/
 *   fetch_intake.mjs → intake_ledger.jsonl) and carried on HardMetadata. Each field
 *   {origin, uri, fetched_at, intake_sha256} is nullable; the whole block is null
 *   when the origin is unknown (honest-or-absent, LAW 3 — NEVER fabricated).
 *   Resolution is an opt-in injected resolver (null on the browser + headless
 *   sacred paths, no filesystem/sha), so both pinned reference solves are
 *   byte-identical (bundled sample frames match no ledger row → null block,
 *   identically on browser and headless).
 *  2.7.0: TPS emission is now OUT-OF-SAMPLE GATED (tps_fitter.ts fitTpsGated).
 *   Two schema deltas, both honest-or-absent: (a) `solution.astrometry.tps` may now
 *   be explicit `null` (the out-of-sample CV / GCV-λ / physics gate REFUSED an
 *   overfit spline — previously the key was silently absent); (b) additive
 *   `solution.astrometry.tps_gate` verdict block (admitted/reason + rms_insample vs
 *   rms_oos vs linear residual + the GCV grid + physics ceiling), recorded whenever
 *   the TPS fire gate fires so the presence-or-absence of `tps` is explained, not
 *   silent. The SeeStar/M66 frame's interpolating spline (in-sample 3", OOS 35") is
 *   now refused → its receipt loses the tps block and gains a tps_gate(refused).
 *   Every asserted SOLVE field (RA/scale/matched/conf, bc_rematch) is untouched —
 *   TPS is a post-solve COORDINATE observation — so both pinned reference solves
 *   stay byte-identical on the solve; only the honest TPS emission changes.
 *  2.8.0: additive `fidelity` field on the SPCC receipt block (COLOR_MATH_PROGRAM
 *   4.1 — color as a MEASURED product). The SPCC color regression is promoted from
 *   raw slope/r2 telemetry to a fidelity report: survivor (sigma-clipped, optimistic)
 *   vs UNCLIPPED r2/rmse + a TLS/errors-in-variables slope bracket (OLS attenuates
 *   the slope because the instrumental-color predictor is noisy). Pure post-solve
 *   surfacing of the existing color fit; `validated` is ALWAYS null (EVIDENCE, never
 *   a gate — owner guards calibrated gates) and channel-gain application is NOT
 *   derived from it. null when the color fit is invalid; the whole SPCC block is
 *   absent when SPCC did not run (FITS-only). No SOLVE field changes — both pinned
 *   reference solves stay byte-identical; the SeeStar receipt gains spcc.fidelity,
 *   the CR2/DSLR path carries no SPCC block (honest-or-absent).
 *  2.9.0: additive `gains` field on the SPCC receipt block (COLOR_MATH_PROGRAM
 *   §3.2 — SPCC-grounded white balance, the color analog of applySipUndistort
 *   closing the distortion render loop). Per-channel render white-balance gains
 *   [g_R,g_G,g_B] fit via TLS (errors-in-variables, never OLS) on the SPCC
 *   survivor star set + a quality gate ({passed,reason}, min-stars/r²/slope/gain
 *   sanity) + method/nStars/r²/uncertainty + an `applied` flag. ALWAYS recorded
 *   (record-always, whether or not applied). APPLICATION is RENDER-LANE ONLY
 *   (PIXEL ledger, in ImageProcessor before the STF stretch, replacing the
 *   star-ensemble-white heuristic); the solve/PSF/forced-photometry chain keeps
 *   reading LINEAR UNSCALED data, so BOTH pinned reference solves stay
 *   byte-identical (they assert SOLVE numbers, not rendered pixels). null only
 *   if the gain fit could not run; the whole SPCC block is absent when SPCC did
 *   not run (FITS-only). The SeeStar receipt gains spcc.gains; CR2/DSLR carries
 *   no SPCC block (honest-or-absent).
 *  2.10.0: additive top-level `confirm_status` block — the DERIVED four-state
 *   forced-photometry confirmation verdict (m6_plate_solve/confirm_status.ts,
 *   classifyConfirmStatus). The "safety catcher": the set-level family-wise gate
 *   already decided CONFIRMED/not, but nothing user-visible ASKED it, so a solve
 *   whose verification was REFUSED or never ran displayed as a plain "solved".
 *   This surfaces one verdict {status, setExcessZ, nTargets, confirmed, setGateZ,
 *   reason} so the UI/consumers read a single conclusion. status ∈ {CONFIRMED
 *   (set gate passed) | REFUSED (evaluated, gate failed) | INSUFFICIENT_TARGETS
 *   (ran, too few forced targets for a set verdict — confirmForcedSet's own N<10
 *   floor) | NOT_RUN (pass skipped)}. setGateZ is CITED from
 *   SOLVER_CONFIRM_SET_EXCESS_Z — NO gate math, NO calibrated constant, NO
 *   accept/reject change. null only when there is NO solve (nothing to confirm);
 *   an explicit NOT_RUN when a solve exists but the pass did not run (that
 *   ABSENCE is now visible, not silent). Pure classification of the already-
 *   computed deep_confirmed block, so BOTH pinned reference solves stay
 *   byte-identical (they assert SOLVE numbers): the SeeStar receipt gains
 *   confirm_status=CONFIRMED (M66 set contrast ≫ gate); the CR2 gains
 *   confirm_status=INSUFFICIENT_TARGETS (too few forced targets).
 *  2.11.0: additive top-level `solve_provenance` block — the LEAN success/failure
 *   provenance of the solve (Escalation Controller spec §3/§6/§7 "Monday slice",
 *   owner-ruled 2026-07-11; stages/solve_provenance.ts). ONE field on success:
 *   `solved_via ∈ {blind | assisted:user | assisted:metadata | assisted:tool}` —
 *   the CATEGORY of search prior active when the solve locked, derived from the
 *   wizard hint-resolution rung (BLIND→blind, CONFIG→assisted:user, FITS_HEADER/
 *   ZENITH→assisted:metadata; assisted:tool is unreachable today — no autonomous
 *   producer is wired into the solve path, so it is never emitted). A hinted solve
 *   is NOT a lesser solve: acceptance never consults the hint (the verify σ gate is
 *   the SOLE arbiter) and a hint only SHRINKS the pose-hypothesis count. Purpose:
 *   denominator integrity for blind-rate capability claims + the detection-
 *   improvement map — NO per-rung tag taxonomy. RICHER on failure: `failed_attempts`
 *   ([{outcome_why ∈ scale-never-locked|centers-exhausted|detection-starved,
 *   sigma_reached}]) is present ONLY when an earlier attempt failed before a later
 *   one recovered — absent on a clean solve. NO wall-clock value enters any field
 *   (determinism, spec §6). The Monday slice is provenance RECORDING only — no
 *   escalation loop yet, so `failed_attempts` has no producer today and is always
 *   absent (the shape is forward-compatible; honest-or-absent, LAW 3). null when
 *   there is NO solve, or when the hint source is not honestly known (never a
 *   guessed 'blind'). Pure post-solve classification of an already-resolved hint
 *   source — the solver/WCS/matched_stars are untouched, so BOTH pinned reference
 *   solves stay byte-identical (they assert SOLVE numbers): the SeeStar receipt
 *   gains solve_provenance.solved_via='assisted:metadata' (FITS-header GOTO); the
 *   blind CR2 gains solve_provenance.solved_via='blind'.
 *  2.12.0: additive top-level `user_annotations` block — observer-supplied
 *   free-text TESTIMONY (description / location_text / sky_bortle_text / rig_notes
 *   / session_issues, all STRINGS) + {provenance:'user'|'mcp_assisted', captured_at}
 *   (stages/user_annotations.ts). String-only testimony, NEVER parsed into the
 *   solve — structurally separate from the solve-feeding SoftMetadata. null when
 *   the observer supplied nothing (honest-or-absent, LAW 3). Both pinned reference
 *   solves never set annotations, so their receipts carry `user_annotations: null`
 *   and the SOLVE stays byte-identical — only the additive block + this version
 *   string change. Version numbering reconciled at the 2026-07-11 merge train:
 *   2.11.0 = solve_provenance, 2.12.0 = user_annotations.
 *  2.13.0: additive top-level `pipeline_provenance` block — the DDIA population-gate
 *   must-fix: a populated DB record is un-interpretable across decoder-arm flips and
 *   atlas rebaselines without recording (a) which RAW DECODER ARM produced the frame
 *   pixels and (b) which ATLAS the solve matched against. Two honest-or-absent fields
 *   (stages/package.ts buildPipelineProvenance):
 *   • `decoder_arm ∈ {rawler | libraw | null}` — the arm that ACTUALLY decoded THIS
 *     frame's raw sensor data (rawler = default arm, libraw = VITE_DECODER_RAWLER=0
 *     cold path). null when NO raw decode occurred — FITS-native frames (routed to the
 *     pure-TS FITS decoder, neither rawler nor libraw) and already-rendered demo-tier
 *     inputs (JPEG/TIFF) — NEVER a guess from the flag alone (LAW 3). The session
 *     supplies the honest value from its source-format + isRawlerDecoderEnabled().
 *   • `atlas_id` + `atlas_version_source` — the committed LAW-7 golden fingerprint of
 *     the shipped deep catalog (binary_layouts#atlas_rows goldenVector.md5, pointing at
 *     tools/atlas/atlas_repro_manifest.json). This is the atlas CONTENT identity that
 *     CHANGES on a deliberate rebaseline — exactly the denominator the DB needs.
 *     atlas_version_source names the origin and is EXPLICIT that this is the build-time
 *     manifest md5, NOT a runtime hash of the loaded sectors. null (with an honest
 *     source string) if no golden fingerprint is recorded on-box — never fabricated.
 *   Pure provenance surfacing — reads config + a compile-time contract constant, computes
 *   NO solve field. Both pinned reference solves stay byte-identical: SeeStar (FITS) gains
 *   pipeline_provenance{decoder_arm:null, atlas_id:<md5>}; the blind CR2 gains
 *   pipeline_provenance{decoder_arm:'rawler', atlas_id:<md5>} — only the additive block +
 *   this version string change; RA/scale/matched/conf/bc_rematch are untouched.
 *  2.14.0: THREE additive, honest-or-absent blocks (schema train 2026-07-12),
 *   solve byte-identical (all three are pure post-decode/post-solve surfacing):
 *   • `rawler_calibration` — the LEAN per-frame RAW calibration the rawler decode
 *     arm MEASURED and previously DROPPED (WB / per-channel black + white levels /
 *     CFA pattern / optical-black stats). Reduced from RawlerCfaRecord by
 *     m1_ingestion/rawler_decoder.summarizeRawlerCalibration (heavy raw OB pixel
 *     buffers dropped — stats only), persisted onto HardMetadata at ingest so it
 *     survives the raw-buffer release. Present ONLY on the rawler arm; null on the
 *     libraw cold path, FITS, and demo-tier. No calibration is APPLIED (raw-ADU
 *     domain, value_domain labels it) — MEASURED, recorded, never applied (LAW 2).
 *   • `user_target_hint` — the structured VALUE behind an assisted:user solve
 *     (HINT_TAXONOMY §3): the caller's target label + RA (hours) + Dec (degrees) as
 *     supplied, all under assumed:true. Present iff the CONFIG hint rung seeded the
 *     solve (⟺ solve_provenance.solved_via='assisted:user'); null on a blind solve
 *     or when no hint was supplied. fov_deg is honestly null (CallerTargetHint
 *     carries none). A search prior, NEVER a measurement — the verify σ gate stays
 *     the sole arbiter, so BOTH pinned reference solves carry null here.
 *   • `nebulosity_layer` — the multiscale starlet decomposition receipt block
 *     (m10_psf/nebulosity_layer.buildNebulosityLayerReceipt) wired into buildReceipt
 *     for the FIRST time (the producer had ZERO src importers). The producer
 *     (decomposeNebulosityLayers) is a DEFAULT-OFF render tool with NO stage wired
 *     into the solve path, so this is null on every real receipt today (honest
 *     producer-gap — the NebulosityLayersWidget already renders DECOMPOSITION NOT
 *     RUN and lights up when a producer stage lands). RENDER plane, PIXEL-ledger math.
 *   buildFailureReceipt (the no-solve product) carries all three consistently:
 *   rawler_calibration rides HardMetadata (banked even on a failed rawler decode);
 *   user_target_hint + nebulosity_layer null. Both pinned reference solves gain
 *   three additive keys (rawler_calibration non-null on the rawler CR2 arm; null on
 *   the FITS SeeStar; the other two null on both) + the version string — the SOLVE
 *   numbers are untouched.
 *  2.15.0: STAR-DATA CORRECTION CELLS (LAW-1 fourth "PSF-measurement" layer,
 *   MULTILAYER_MATRIX §4). Six flag-gated / injected corrections applied to the
 *   EXTRACTED per-star QUANTITY (flux, shape, position), NEVER by pre-warping the
 *   source buffer. ALL default-OFF/inert ⇒ both pinned reference solves stay
 *   byte-identical; only additive honest-or-absent keys + this version change:
 *   • rawler_calibration.black_level_applied ([R,G,B] or null) + the
 *     'raw_adu_black_subtracted_over_65535' value_domain (cell ①, decode flag
 *     VITE_DECODE_APPLY_BLACK_LEVEL; null on the default rail).
 *   • spcc.vignette + spcc.extinction (cells ②③, flags PSF_FLUX_VIGNETTE_CORRECT /
 *     PSF_FLUX_EXTINCTION_CORRECT; per-band transmission divide + per-star
 *     extinction feeding the color/zp fits; null on the default SeeStar solve).
 *   • psf_field fits gain vignetteGain + ampVignetteCorrected (cell ②, injected map).
 *   • psf_attribution.refraction.chromaticDispersion (cell ⑤, predicted chromatic-
 *     dispersion PSF-elongation vector; null when observing geometry absent),
 *     sky_deprojected (cell ⑥, flag PSF_JACOBIAN_DEPROJECT; local-Jacobian sky
 *     shape ALONGSIDE raw px; null by default), centroids (cell ④, native +
 *     undistorted positions when a distortion model resolves; native-only else).
 *   None of these touch the WCS/matched_stars/solve or any calibrated gate.
 *  2.16.0: additive top-level `compute_routes` block — LOUD COMPUTE-ROUTE
 *   observability (GPU program piece 1; memory gpu-test-coverage-gap, ledger row
 *   448). Every GPU-capable seam now records ONE honest stamp of which compute path
 *   it ACTUALLY took, killing the silent CPU-degrade / invisible-skip class of
 *   regression. An array of {seam ∈ demosaic|preview, route ∈ native_wgpu|webgpu|cpu
 *   |skipped, reason:<decisive-factor string>} (stages/package.ts buildComputeRoutesBlock;
 *   producers m3_gpu_preprocess/compute_routes.ts, WebGPUContext.getLastInitReason).
 *   Seams stamped: the demosaic decision ladder (native/webgpu/cpu, or a 'skipped'
 *   stamp when the payload arrived already demosaiced — the invisible skip BOTH sacred
 *   lanes take: FITS→pre_demosaiced_stacked, rawler-RAW→pre_demosaiced_rawler) and the
 *   step2 preview seam (webgpu/cpu, or skipped/previews_disabled when generatePreviews
 *   is false — the headless I1.2 default). Honest-or-absent (LAW 3): null when no seam
 *   recorded a route (old receipts / a path that never reached a GPU-capable seam);
 *   `buildFailureReceipt` carries it identically (a failed frame still banks its routes).
 *   Pure diagnostic — it READS what already ran, computes NO solve/WCS/gate value, so
 *   BOTH pinned reference solves stay byte-identical (they assert SOLVE numbers). On the
 *   headless sacred lanes the block is [{demosaic,skipped,pre_demosaiced_stacked|
 *   pre_demosaiced_rawler},{preview,skipped,previews_disabled}] + this version string —
 *   the only receipt deltas; RA/scale/matched/conf/bc_rematch untouched.
 *   NOTE (merge reconciliation): this worktree branched at RECEIPT 2.15.0; main has
 *   since advanced past 2.16.0 — the version number reconciles at the merge train (as
 *   the 2026-07-11 note above records for 2.11↔2.12), the BLOCK is what matters.
 *  2.17.0: CONFIRM GATE AUTHORITY FLIP (phase-2, owner-ruled repeatedly, executed
 *   2026-07-22). The set-level confirmation decision is now the Benjamini-Yekutieli
 *   step-up at q=0.05 over per-star empirical right-tail p-values vs the frame's
 *   OWN scrambled-null SNR pool (dependence-robust; Phipson-Smyth +1). Additive
 *   receipt deltas: `deep_confirmed.fdr` (always present on a confirmation pass;
 *   null on the N<10 floor) + `confirm_status.{gate_authority,n_confirmed_fdr,
 *   fdr_q}`. setExcessZ/setGateZ REMAIN, reported unchanged — RETIRED FROM
 *   DECIDING, never tuned (the z=15 constant is frozen as a reported statistic).
 *   The CONFIRM_FDR_SHADOW flag graduated (removed). Evidence at the flip
 *   (test_results/fdr_flip_2026-07-22/): SeeStar BY 205/205 (conjunction 198),
 *   CR2 BY 28/46 (conjunction 18) — both pins confirm MORE strongly under FDR;
 *   every sacred SOLVE number byte-identical (gate reads outputs, decides only
 *   the confirm verdict). Stage-replay goldens re-captured for the new key.
 *  2.18.0: ADAPTIVE NULL RESOLUTION + UNDERPOWERED HONESTY (adjudication rows
 *   529-530, owner GO 2026-07-22, rides the Gaia cutover train). The g15u probe
 *   proved a set-gate FALSE-REFUSAL class: the scrambled-null pool scaled 4×
 *   WITH candidate count, so small honest sets got an empirical p-floor
 *   (1/(M+1)) the BY threshold could not reach (CR2: floor 1/121 vs hybrid
 *   1/185 → 0 admitted despite inner stars at SNR 83.9 — p-resolution degraded
 *   exactly when the set shrank). Fixes: ① the null SNR pool AUTO-EXTENDS with
 *   MEASURE-ONLY draws until the floor sits below the rank-1 admission
 *   threshold with 2× margin (the full-predicate draws are untouched —
 *   nullRate/setExcessZ semantics identical; deterministic seed lineage, the
 *   old pool is a byte-identical prefix of the extended one) ② additive
 *   `deep_confirmed.fdr.{p_floor,admission_threshold_r1,underpowered}`
 *   ③ `fdr.per_star[].r_norm` (wall-aware admission analysis — recorded, never
 *   deciding) ④ NEW additive confirm_status value CONFIRM_UNDERPOWERED so
 *   "could not decide" (a test-resolution fact) never masquerades as REFUSED.
 *   Confirm-block VALUES shift (bigger pool ⇒ finer p) — the enumerated
 *   rebaseline rides the Gaia cutover train (owner one-rebaseline directive).
 *   q=0.05 / BY / retired-z all UNCHANGED: evidence added, no bar moved (LAW 2).
 *   SET RULE (owner-ruled same day, row 539): the set confirms at
 *   n_confirmed_fdr >= 2 (`setFdrMinAdmissions`) — the finer p-floor that cures
 *   the false-refusal class also enables singleton rank-1 admissions, and a
 *   measured wrong-WCS arm produced exactly one (true arms k={215,203,196,17,4}
 *   vs wrong k={0,0,0,0,1}); singletons refuse honestly with the near-miss
 *   legible in the receipt. Interim rule; superseded by the magnitude-
 *   consistency admission discriminator once its tolerance is measured.
 *  2.19.0: REVIEW-RESPONSE TRAIN (adversarial review 2026-07-22, row 547, owner
 *   GO — findings F2+F3, both CONFIRMED(independent)). ① F3 FAMILY HONESTY:
 *   the FDR step-up now runs over the FULL probed family (every catalog target
 *   measured; structured → p=1 by construction) instead of accepted-only
 *   survivors of the tested statistic (~5-10× anti-conservative), and matched
 *   stars — the WCS's own fit anchors — are EXCLUDED from probe targets by
 *   coordinate coincidence (ID-only exclusion is F1's failure mode). ② F2
 *   PROJECTION: probes are positioned by LINEAR+fitted-SIP+measured-BC (prior
 *   fallback), mirroring the rematch pass's SIP convention verbatim — apertures
 *   no longer go blind past the distortion wall. Additive receipt deltas:
 *   `deep_confirmed.{probed, matched_excluded, projection}`. Confirm-block
 *   VALUES shift (family N, target composition, aperture placement) — the
 *   train's single enumerated rebaseline. q/BY/k>=2/retired-z all unchanged.
 *  2.20.0: additive top-level `final_astrometry` block — the step-6 TERMINAL
 *   data-fidelity refit (stages/final_astrometry.ts, COORDINATE ledger). A
 *   SECOND, provenance-tagged WCS (provenance 'REFINED_FINAL_ASTROMETRY') re-fit
 *   from the evidence-gated matched set using three fidelity upgrades over the
 *   solve's own SIP refit: (a) PSF-fit LM centroids (psf_field, nearest within
 *   tol; raw fallback), (b) differential refraction APPLIED at coordinate level
 *   (Bennett — graduating the psf_attribution predictor; per-star zenith-ward
 *   displacement relative to field centre subtracted before the fit; GATED on
 *   timestampTrusted + a real GPS site, honest-skip otherwise), (c) SNR-honest
 *   PSF-amplitude weighting (bounded, constant-noise proxy). Reuses the SIP
 *   fitter (ResidualAnalyzer.fitSip, weight-extended) + skyToLinearPixel +
 *   postSipResidualPx/evalSipPoly (never a re-derived SIP sign). It is a PRODUCT:
 *   the linear WCS terms are the solve's (a linear-WCS refit is a separate
 *   solver, out of scope); it NEVER overwrites solution.wcs/astrometry, NEVER
 *   mutates matched_stars, and NEVER feeds solve/confirm decisions (owner
 *   loop-closure ruling). Pure post-solve observation ⇒ BOTH pinned reference
 *   solves stay byte-identical (they assert SOLVE numbers): the block is
 *   non-null on both (each carries a measured psf_field + ≥20 matches); refraction
 *   APPLIED on SeeStar (real FITS GPS 46.2184N) and honest-skipped on CR2
 *   (default GPS) — both pinned in the apispecs; only the
 *   additive block + this version string change; RA/scale/matched/conf/
 *   bc_rematch/deep_confirmed are untouched. null when no solve / no fitted WCS /
 *   no measured PSF field / <20 matched stars (honest-or-absent, LAW 3). */
export const RECEIPT_SCHEMA_VERSION = '2.20.0' as const;

/** Auto-path AstroSciencePacket (buildAstroPacket) schema version. */
export const SCIENCE_PACKET_VERSION = '1.0.0' as const;
