/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * PIPELINE CONFIGURATION â€” Centralized Algorithmic Thresholds
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

/**
 * Env-overridable numeric constant. In Node/headless/test contexts (the validation
 * harness, e2e, api harness) an env var of the same name overrides the default so a
 * lever can be A/B'd OFF/ON WITHOUT mutating source; in the browser `process` is
 * undefined → always the default. Byte-identical when the env var is unset. The
 * dynamic `process.env[key]` (not a static `process.env.FOO`) is intentional so Vite
 * does not statically inline it; the try/catch makes it bulletproof in the browser.
 */
function envIntOverride(key: string, dflt: number): number {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[key] != null) {
            const v = parseInt(String(process.env[key]), 10);
            if (Number.isFinite(v)) return v;
        }
    } catch { /* no process (browser) → default */ }
    return dflt;
}

function envFloatOverride(key: string, dflt: number): number {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[key] != null) {
            const v = parseFloat(String(process.env[key]));
            if (Number.isFinite(v)) return v;
        }
    } catch { /* no process (browser) → default */ }
    return dflt;
}

/**
 * Env-overridable STRING constant (same Node/browser contract as the numeric
 * helpers above). In the browser `process` is undefined → always the default.
 * Used for file-path knobs that are meaningful only in Node/headless (e.g. a
 * search-prior model on disk) — the browser default of '' means "absent".
 */
function envStrOverride(key: string, dflt: string): string {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[key] != null) {
            const v = String(process.env[key]);
            if (v.length > 0) return v;
        }
    } catch { /* no process (browser) → default */ }
    return dflt;
}

export const PIPELINE_CONSTANTS = {
    // â”€â”€â”€ STAGE 1-4: HINTS & ZENITH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    HINT_ASSUMED_ALTITUDE: 45,
    HINT_CARDINAL_RADIUS: 30,
    HINT_COORDINATE_RADIUS: 15,
    HINT_FITS_HEADER_RADIUS: 4.0,  // FITS RA/DEC header hint: half-diagonal ~2.3 deg + GOTO pointing margin
    HINT_ZENITH_RADIUS: 90,
    // Deep-sector paging cap (B4): hinted solves only page atlas sectors when
    // the hint radius is at or below this. Future wide-radius hint rungs
    // (zenith 90 deg / azimuth 30 deg) must NOT page in the full 338 MB deep
    // atlas — they run on L1/L2 anchors only. FITS 4 deg hints are unaffected.
    SECTOR_LOAD_MAX_RADIUS_DEG: 16,

    // â”€â”€â”€ STAGE 1.8: LENS inference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    LENS_STANDARD_SIGMA: 3.0,
    LENS_ULTRA_WIDE_FL_THRESHOLD: 20,
    LENS_inference_MIN_STARS: 5,
    LENS_DRIFT_MIN_STARS: 12,

    // ─── OPTICS: UNTRUSTED-FL HINT-PROVIDER SEAM (core/optics_hint_provider.ts) ───
    // Master gate for the wide-field focal-length PRIOR provider. When ON (default),
    // the electronics-less factory-default 50mm signature (fl=50 + placeholder/absent
    // lens, no user hint) is seeded with the labelled WIDE_FIELD_FL_PRIOR_MM (14mm)
    // ASSUMPTION and that assumption is recorded in the receipt (`optics_hints`). This
    // is LOAD-BEARING for the calibrated CR2 blind solve: the EXIF_OPTICS lock
    // 206.265·4.30/14 = 63.35"/px seeds the solve (sacred: blindOutcome=solved,
    // 63.211"/px, 55 matched). Flag OFF ⇒ the provider declines ⇒ the honest-absent
    // ladder falls through to the untrusted nominal 50mm (documented degraded outcome,
    // NOT a gate). Env/config-overridable like the SOLVER_* levers (OPTICS_WIDE_FIELD_PRIOR=0);
    // browser `process` is undefined → always the default. Byte-identical when unset.
    OPTICS_WIDE_FIELD_PRIOR: envIntOverride('OPTICS_WIDE_FIELD_PRIOR', 1) === 1,

    // â”€â”€â”€ STAGE 2: FLATTENING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    FULL_FRAME_DIAGONAL_MM: 43.3,
    DISTORTION_MIN_THRESHOLD: 0.001,

    // â”€â”€â”€ STAGE 3-4: HARDWARE & SPECTRAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    LIE_DETECTOR_THRESHOLD: 0.08,
    DEFAULT_SAMPLE_RGB: { r: 128, g: 128, b: 128 },
    B_V_HEURISTIC_SCALE: 0.5,

    // â”€â”€â”€ STAGE 4.5: SPECTROSCOPY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    SKY_SAMPLE_GRID: 5,
    DEFAULT_Aerosol_Optical_Depth: 0.1,

    // â”€â”€â”€ STAGE 5: PLATE SOLVER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    SOLVER_FALLBACK_SCALE: 2.0,
    SOLVER_RETRY_SIGMA: 1.5,
    SOLVER_BLIND_SIGMA: 2.5,
    SOLVER_SCALE_MISMATCH_THRESHOLD: 0.001,
    SOLVER_MIN_MATCHES: 4,                   // Aligned with quad-hash foundational unit
    SOLVER_MAX_EXTRACTION_STARS: 500,
    SOLVER_MAX_QUAD_STARS: 80,
    // Env-overridable (dense ultra-wide fields starve verify at the defaults —
    // 56°×39° footprint used 12-14 det / ~50 cat while astrometry.net matched 556;
    // overrides are experimental-run knobs, defaults are the calibrated values):
    SOLVER_MAX_DET_STARS: envIntOverride('SOLVER_MAX_DET_STARS', 30),      // Phase 1: Filter image stars to top 30 by flux
    SOLVER_MAX_CAT_STARS: envIntOverride('SOLVER_MAX_CAT_STARS', 100),     // Phase 1: Filter catalog stars to top 100 by mag_v
    SOLVER_QUAD_tolerance_DEFAULT: 0.01,     // Tightened from 0.03 to reduce hallucinations
    SOLVER_QUAD_tolerance_WIDE: 0.12,
    SOLVER_MAX_SCALE_variance: 0.15,         // Relaxed for wide-field compatibility
    SOLVER_LOCKED_SCALE_variance: 0.05,      // 5% variance for testing Hypothesis 2
    SOLVER_VERIFICATION_RADIUS_ARCSEC: 120,
    SOLVER_MAX_VERIFY_RADIUS_ARCSEC: 2000,    // Cap to prevent hallucination inflation, accommodates 22px distortion
    SOLVER_DEFAULT_SIGMA: 3.0,
    SOLVER_MAX_MATCH_ATTEMPTS: 100,

    // â”€â”€â”€ STAGE 5.1: MATCHING GEOMETRY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    SOLVER_PLANET_LOCK_RADIUS_PX: 50,        // Proximity for planetary lock (detectedâ†”projected)
    SOLVER_FOCUS_REGION_MARGIN_PX: 200,      // Frame margin for focus regions
    SOLVER_FOCUS_REGION_MIN_RADIUS_PX: 100,  // Minimum focus region radius
    SOLVER_ANCHOR_PROXIMITY_PX: 10,          // Quad anchor proximity
    SOLVER_RIDGE_COARSE_RADIUS_PX: 60,       // Coarse ridge scan proximity
    SOLVER_RIDGE_FINE_RADIUS_PX: 30,         // Fine ridge scan proximity
    SOLVER_MIN_LOCK_confidence: 0.3,         // Minimum confidence for lock acceptance
    // Alternative acceptance for verifyWCS-passed locks whose frame-wide achievable-match
    // confidence deflates on deep/mosaic frames (metric divides by catalog-in-frame; the
    // 2026-07-12 root-cause dropped M101 @12,180 verified matches + r_mosaic G/I/R @161/176/225
    // while sibling bands of the SAME field solved). Evidence basis for 100: all four dropped
    // verified locks clear it (min 161); the known historical false positive carried ~46
    // (excluded 2x). Owner-confirmed 2026-07-12. Never lowers the 0.3 floor — adds an
    // evidence path (calibrated; orchestrator-only).
    SOLVER_LOCK_MATCH_COUNT_FLOOR: 100,      // Verified-match count that accepts a lock regardless of deflated confidence
    SOLVER_VERIFY_INNER_RADIUS_FRAC: 0.35,   // Inner verification zone as fraction of image
    SOLVER_BRIGHT_STAR_MAG_LIMIT: 3.5,       // Magnitude cutoff for search centers
    SOLVER_TIGHT_RESIDUAL_ARCSEC: 20,        // Residual threshold for confidence boost
    SOLVER_MIN_RIDGE_CONSENSUS: 3,           // Minimum stars for ridge scan acceptance

    // Ultra-wide central-patch matching (Phase B). Quad hashing assumes a
    // similarity transform (constant scale), but gnomonic scale grows as
    // sec^2(theta) off-axis: +7.2% at 15 deg, +33% at 30 deg, ~3x at 55 deg.
    // On a 110-deg FOV frame (14mm DSLR) full-frame quads mix center and edge
    // stars and fit garbage intermediate scales (observed 37-195"/px smear vs
    // 63.4 truth). Above the FOV threshold, quad star sets, the catalog fetch,
    // and the verify anchor are restricted to this patch radius around the
    // projection center, where the linear approximation holds. Blind center
    // pruning separation is capped to the patch radius so every true center
    // has an overlapping hypothesis.
    SOLVER_WIDE_PATCH_MIN_FOV_DEG: 30,       // FOV diagonal above which patch mode engages
    // Patch radius bounds QUAD BASELINES, and quad-code error from
    // differential lens distortion scales with baseline: at 15 deg the codes
    // land 3-6% off (hash bins are ~1% — true quads hashed into buckets the
    // walk never visits; measured: fully-calibrated null model, best
    // candidate +0.8 sigma = truth never in the pool). 6 deg keeps codes
    // inside bin width. Sky-component centroid keeps the patch on stars.
    SOLVER_WIDE_PATCH_RADIUS_DEG: 6,
    // Verify anchor for ultra-wide, SMALLER than the quad patch: consumer
    // wide lenses carry real barrel/mustache distortion (tens of px at
    // 10-15 deg off-axis) that a linear WCS cannot follow — a TRUE
    // candidate at the Jupiter center verified only 3 stars at ~800"
    // median residual over a 15-deg anchor. Distortion is locally smooth,
    // so a quad fit absorbs the local affine: judge the lock where the
    // linear model can actually hold. SIP/TPS handle the global field
    // downstream (M7).
    SOLVER_WIDE_VERIFY_ANCHOR_DEG: 6,
    // Ultra-wide BRIGHT COMPLETENESS verification. Known-answer injection of
    // the brute-forced ground-truth WCS (bundled CR2, Jupiter anchor) proved
    // the old "brightest 3x detections" verify set (6681 rows, mag to ~10.2)
    // statistically BLIND: the true WCS scored z=-0.2 against decoy rotations
    // because chance matches on thousands of mag 10+ deep-sector rows drown
    // the real signal. An ultra-wide rig (short focal, small pupil) reliably
    // detects only the bright end; measured on production inputs, mag<6.0
    // separates truth from decoys at z=+6.4..+7.4 while mag<8.5 gives z=0.
    // Statistics AND the reported match set both use this subset.
    // Env-overridable for deep-detection regimes ONLY (e.g. superpixel-binned
    // long exposures where detection completeness reaches past mag 6 — the
    // z=0-at-8.5 evidence above was measured on a bright-end-only detection
    // set and does NOT transfer to deep sets; raise det/cat caps TOGETHER so
    // the chance model stays completeness-matched). Default = calibrated value.
    SOLVER_UW_VERIFY_MAG_LIMIT: envFloatOverride('SOLVER_UW_VERIFY_MAG_LIMIT', 6.0),
    // Anchored rotation-sweep candidate generator (ultra-wide anchor mode):
    // translation is pinned by the bright-anchor hypothesis and scale by the
    // metrology lock, leaving rotation x parity — brute-force them against
    // the bright catalog (the exact methodology that ground-truthed the
    // bundled frame). The sweep's own 1440-orientation score distribution is
    // the null; a peak this many sigma above it is handed to verifyWCS.
    // Measured: true orientation peaks at z=+7.1; best junk orientation +2.8.
    SOLVER_UW_SWEEP_MIN_Z: 4.5,
    // TOP-N ANCHOR CANDIDATES (NEXT_MOVES §2a). Anchor misidentification is a
    // PROVEN failure mode: IMG_1653's flux-argmax anchor landed on a frame-edge
    // artifact (37,2431), so the anchored sweep pinned translation to garbage and
    // could never lock. Rank the hygiene-passing detections by flux and try the
    // top N as ALTERNATIVE anchor hypotheses per center — candidate #0 is the exact
    // former argmax, so the sweep tries #1/#2 ONLY when #0 fails to lock, and
    // returns on the first verified lock. Each extra anchor multiplies the
    // per-center sweep cost (and the sub-threshold escalation, capped separately),
    // so this trades center coverage within blindBudgetMs for anchor diversity.
    // DEFAULT 1 (OFF): the top-3 A/B measured 0/6 gauntlet gain (no new locks) with
    // an untested budget-dilution downside, so the lever ships OFF pending evidence
    // and graduates via the validation harness (docs/VALIDATION_HARNESS.md, candidate
    // uw_anchor_topN). Env-overridable (SOLVER_UW_ANCHOR_CANDIDATES=3) so the harness
    // A/Bs it without mutating source. 1 == exact pre-§2a single-argmax, byte-identical
    // (CR2 locks on anchor#0 either way; SeeStar never enters the loop).
    // Ultra-wide + anchor-mode only (FOV-gated → narrow fields never reach it).
    SOLVER_UW_ANCHOR_CANDIDATES: envIntOverride('SOLVER_UW_ANCHOR_CANDIDATES', 1),
    // [CAMPAIGN DIAGNOSTIC · LOG-ONLY, default 0 = OFF] When > 0, log the top-N
    // DISTINCT anchored-sweep peaks (full candidate WCS + sweep-z + an adjacent
    // verify-σ line) on EVERY anchor, before the accept/reject — so wide dense
    // fields that never clear the sweep gate still emit rankable candidate
    // pointings for photometric arbitration. 0 ⇒ dead code (both pinned solves
    // byte-identical by construction). NOT a calibrated gate — a log toggle.
    SOLVER_UW_LOG_TOP_PEAKS: envIntOverride('SOLVER_UW_LOG_TOP_PEAKS', 0),
    // --- UW FIT-TIGHT-REVERIFY ESCALATION TIER (solver_entry.verifyWCS FAIL-UW) ---
    // On an ultra-wide wide-net FAIL, fit distortion (SECONDARY BC-rung) on the
    // provisional matches then re-verify through a TIGHT net at fit precision -- the
    // astrometry.net play. Split gating:
    //   SOLVER_UW_FIT_REVERIFY (default ON)  -- verdict-NEUTRAL diagnostic: runs the
    //     fit + tight re-match and LOGS tight-sigma / tight-matches / fitted k1k2,
    //     changing NO verdict. Pin-safe by construction (the pins pass the wide-net
    //     and never enter the FAIL branch), so it earns tight-sigma evidence on every
    //     UW refusal from day one.
    //   SOLVER_UW_TIGHT_ACCEPT (default OFF) -- ACCEPTANCE: only with this ON does a
    //     tight-sigma >= bar candidate become a solution. ORCHESTRATOR-ONLY flip after
    //     a false-positive audit (gauntlet + IMG_1414 FP case); money runs set it =1.
    SOLVER_UW_FIT_REVERIFY: envIntOverride('SOLVER_UW_FIT_REVERIFY', 1) === 1,
    SOLVER_UW_TIGHT_ACCEPT: envIntOverride('SOLVER_UW_TIGHT_ACCEPT', 0) === 1,
    // Fire-window floor: run the diagnostic only when wide excess-sigma >= this
    // (garbage centers score ~0 and skip the fit -- also the compute guard).
    SOLVER_UW_TIGHT_REVERIFY_FLOOR_Z: envFloatOverride('SOLVER_UW_TIGHT_REVERIFY_FLOOR_Z', 2.5),
    // Tight match radius (px). At ~85"/px this ~3px is ~4', vs the ~21' wide net.
    SOLVER_UW_TIGHT_NET_PX: envFloatOverride('SOLVER_UW_TIGHT_NET_PX', 3.0),
    // CALIBRATED-CLASS (orchestrator-owned): tight-net acceptance bar. Default is the
    // SAME +5 sigma as the wide gate -- this tier ADDS evidence, it does NOT lower the
    // bar (LAW 2). Do not move this to make a frame pass.
    SOLVER_UW_TIGHT_ACCEPT_SIGMA: envFloatOverride('SOLVER_UW_TIGHT_ACCEPT_SIGMA', 5),
    // --- ROUND 2 evidence-source levers (default OFF; orchestrator-owned) ---
    // A: DEEP MATCH PASS. Page a sampled atlas pattern over the footprint (a >16deg
    //    UW field otherwise SKIPS deep-sector paging, solver_entry:379-382) and fit
    //    on a DEEP >=100-pair set instead of the starved ~10-16 bright-subset pairs.
    SOLVER_UW_TIGHT_DEEP: envIntOverride('SOLVER_UW_TIGHT_DEEP', 0) === 1,
    // Deep reproject/match mag limit + brightest-N pooled-catalog cap (compute guard).
    SOLVER_UW_TIGHT_DEEP_MAG: envFloatOverride('SOLVER_UW_TIGHT_DEEP_MAG', 12.0),
    SOLVER_UW_TIGHT_DEEP_CAT_CAP: envIntOverride('SOLVER_UW_TIGHT_DEEP_CAT_CAP', 4000),
    // B: INNER-REGION PINHOLE-TIGHT fallback when the fit has too few pairs. Tight-
    //    verify the PINHOLE WCS inside r <= FRAC*halfDiag where barrel is negligible.
    //    Radial displacement at normalized r is |k1*r^2 + k2*r^4|*r*halfDiag; at
    //    FRAC=0.4 with k2~0 that is |k1|*0.064*halfDiag (~|k1|*99px on the 4954
    //    frame), tight-net-clean only for a mild barrel (|k1| <~0.03).
    SOLVER_UW_TIGHT_INNER: envIntOverride('SOLVER_UW_TIGHT_INNER', 0) === 1,
    SOLVER_UW_TIGHT_INNER_FRAC: envFloatOverride('SOLVER_UW_TIGHT_INNER_FRAC', 0.4),

    // ─── FITS VALIDATION A/B SEAM (identity/null lever — no solve effect yet) ───
    // The FITS solve-vs-truth rail (tools/validation/fits_binding.*) A/Bs the NARROW
    // FITS wizard solve OFF(0)/ON(1) via this env var, read at module-load exactly
    // like SOLVER_UW_ANCHOR_CANDIDATES so a fresh vitest process picks it up. It is
    // WIRED as a seam but is a DELIBERATE IDENTITY LEVER: 0 and 1 currently produce a
    // BYTE-IDENTICAL solve (no downstream FITS solver knob reads it yet). The rail's
    // PRIMARY value is therefore the OFF-arm solver-vs-oracle-truth validation, NOT a
    // lever win — we do NOT fabricate a lever effect the solver does not have. When a
    // genuinely-safe FITS solve lever exists, it hangs off THIS constant (a real 0↔1
    // split) and graduates through the harness (candidate fits_solve). Byte-identical
    // when unset. Narrow FITS only (the UW anchor lever above is FOV-gated the other way).
    SOLVER_FITS_VALIDATION_ARM: envIntOverride('SOLVER_FITS_VALIDATION_ARM', 0),

    // ─── FINE-CENTER LEVER (ultra-wide bright-anchor refinement) ───
    // The anchored sweep pins translation, so it only fires within ~0.5° of the
    // true anchor (measured: 0.8° center error collapsed the true peak 8.5→2.4
    // sigma). The blind center list is D5-pruned to ~6° and carries one
    // ephemeris point per planet — so it routinely misses by more than the
    // sweep can absorb. AROUND each bright anchor (planets from ephemeris + the
    // bundled classic bright-star list, since Gaia saturates at mag_g 1.94) lay
    // a fine local grid and try those centers first. Pure evidence-add: no gate
    // is changed. Ultra-wide only (FOV-gated → narrow fields byte-identical).
    SOLVER_UW_FINE_HALF_DEG: 1.5,          // grid half-extent around each anchor (deg)
    SOLVER_UW_FINE_STEP_DEG: 0.3,          // grid step (deg) — under the ~0.5° sweep tolerance
    SOLVER_UW_FINE_MAX_CENTERS: 400,       // cap on generated fine centers (planets/brightest first)
    SOLVER_UW_FINE_ANCHOR_DEDUP_DEG: 1.0,  // collapse anchors nearer than this (absorbs pre-injected grids)

    // ─── THESIS-002 reach levers (OPERATIONAL ordering/budget — NOT calibrated gates) ───
    // Divergence diagnosis 2026-07-10: rawler detection density × the 90s blind budget
    // dies at 67/530 centers BEFORE the appended fine centers; the recal sweep returned
    // honest NULL (thresholds cannot carry it) → the reorder carries the flip alone.
    // Both levers are rawler-arm-only at their use sites: the libraw arm's ordering
    // (push/append) and budget (90_000 literal) stay bit-identical by construction.
    SOLVER_UW_FINE_PROMOTE: false,             // default OFF: fine centers stay APPENDED (byte-identical); the rawler arm promotes (prepends) at the use site
    SOLVER_UW_RAWLER_BLIND_BUDGET_MS: 360_000, // rawler-arm blind ceiling — operational honesty bound; RAISED 180→360 by OWNER RULING 2026-07-12 (decisions ledger D-uw-rawler-budget-360: priors/hints make blind rare, so the rare blind grind may run longer; non-silent per THESIS-002 P4, which this citation satisfies). History: 180_000 was 2× the libraw 90_000 UX literal (git blame d5fa7a7); measured null on recovery (D2/A4: 31/31 no_solves unchanged at 2.5×) — this is a budget/UX call, not a recovery lever. The libraw cold arm keeps its 90_000 literal bit-identical.

    // ─── SEARCH-ORDER PRIORS lane (task #20 / D-priors-lane-go 2026-07-12) — EXPERIMENTAL, default OFF ───
    // Lane ① (search priors ONLY): when ON, banked-receipt priors handed to the
    // solver via SolverOptions.searchPriors REORDER the blind sweep so likely
    // centers are visited first (see search_priors.ts — reorder ONLY, never prunes,
    // never touches verify/thresholds/the math gate). Analytics: ~95% of solve
    // wall-time is the blind sweep and the pinned UW solves lock at the LAST anchor,
    // so front-loading a likely center is pure wall-time recovery with zero effect
    // on WHAT is accepted. Env/config-overridable (SOLVER_SEARCH_PRIORS=1); browser
    // `process` undefined → always the default 0. Flag OFF ⇒ the call-site is skipped
    // entirely ⇒ bit-identical (both pinned e2e byte-identical). Operational ordering,
    // NOT a calibrated gate.
    SOLVER_SEARCH_PRIORS: envIntOverride('SOLVER_SEARCH_PRIORS', 0) === 1,
    // Path to a derived search-prior model JSON (produced by
    // tools/adaptive/derive_search_priors.mjs — the file's `.model` sub-object is
    // the SearchPriorModel). Node/headless ONLY: when this is set AND
    // SOLVER_SEARCH_PRIORS is ON, the single orchestrator loads + shape-validates
    // it at solve time and hands it to the solver via SolveContext.searchPriors
    // (load/parse failure ⇒ null, never fatal). Default '' = absent; the browser's
    // `process` is undefined so it is ALWAYS '' there → the model is null → the
    // reorder seam is skipped → both pinned e2e stay byte-identical.
    SOLVER_SEARCH_PRIORS_MODEL_PATH: envStrOverride('SOLVER_SEARCH_PRIORS_MODEL_PATH', ''),

    // ─── FALSE-POSITIVE BACKSTOPS for the fine-center lever (evidence, NOT gates) ───
    // WINNER-DOMINANCE (lever centers only): a real anchored solve has ONE
    // correct rotation that dominates the sweep; a chance alignment shows several
    // comparable orientations. For a LEVER-generated center, require the peak
    // orientation to beat its best angularly-distant runner-up by this many
    // sweep-sigma before it may verify. The base sweep is untouched.
    SOLVER_UW_DOMINANCE_MARGIN_Z: 1.5,     // peak must exceed distant runner-up by this (sweep sigma)
    SOLVER_UW_DOMINANCE_MIN_SEP_DEG: 20,   // runner-up orientation must be ≥ this far (deg) from the peak lobe
    // SOLVER_UW_SUN_VETO_DEG (was 40) RETIRED 2026-07-10 — owner ruling: "if we
    // match the stars with confidence, we don't need to check if the sun is up.
    // We can kill it." The sun-proximity veto layer in verifyWCS is gone (the A5
    // evidence showed forced-photometry confirmation is the load-bearing FP
    // catcher). Owner-ruled removal, NOT a lowered gate — history + case study:
    // docs/NEXT_MOVES.md §6.

    // ─── DEEP-VERIFY ESCALATION (catalog-forced photometry; NEXT_MOVES §7·5a) ───
    // Sub-threshold sweep peaks in [ESCALATE_MIN_Z, SOLVER_UW_SWEEP_MIN_Z) get
    // ONE extra evidence tier instead of dying: project deep-catalog stars the
    // sweep NEVER used (mag ∈ [MAG_MIN, MAG_MAX] — the sweep matches mag<6, so
    // the probes are statistically independent) through the candidate WCS and
    // measure matched-aperture flux at each predicted position at a ~2σ
    // single-hypothesis threshold (position fixed BEFORE looking at pixels —
    // no look-elsewhere penalty). The null is calibrated ON-FRAME at seeded
    // scrambled positions; only a MIN_EXCESS_Z binomial separation lets the
    // candidate proceed — and then it still passes the FULL normal verify
    // chain (verifyWCS UW sigma/unique gates + sun veto). This ADDS evidence
    // above the calibrated 4.5σ sweep gate; nothing existing is loosened.
    SOLVER_UW_ESCALATE_MIN_Z: 3.0,          // sweep-z floor to qualify for escalation
    SOLVER_UW_ESCALATE_MIN_EXCESS_Z: 10,    // +10σ-class forced-photometry separation required
    SOLVER_UW_ESCALATE_SNR_THRESHOLD: 2,    // per-position forced-photometry acceptance (σ)
    SOLVER_UW_ESCALATE_MAG_MIN: 6.0,        // probe stars strictly BELOW the sweep's bright set
    SOLVER_UW_ESCALATE_MAG_MAX: 10.0,       // catalog-depth ceiling for probes
    SOLVER_UW_ESCALATE_MAX_POSITIONS: 200,  // probe cap (brightest-first)
    SOLVER_UW_ESCALATE_MAX_PER_SOLVE: 8,    // budget guard: escalations per solve (3σ tail is populous)
    // Positional RMS handed to the forced aperture (r_ap = max(2, 0.68·FWHM,
    // 1.2·posRms)): an ANCHORED candidate pins translation to the anchor
    // detection itself, so the model error at probe positions is the bloomed-
    // anchor centroid error (~1-3 px) plus sweep θ-quantization (<1 px over
    // the 6° patch) — NOT the 0.5° center-grid coarseness. Widening the
    // aperture for it is an honest SNR loss, never a recentering step.
    SOLVER_UW_ESCALATE_POS_RMS_PX: 3,

    // ─── POST-SOLVE DEEP HARVEST (catalog-forced; NEXT_MOVES §7·5b) ───
    // After a confirmed lock, forced photometry at deep-catalog predicted
    // positions harvests real stars blind detection missed. Results carry
    // provenance CATALOG_FORCED on a separate solution field — NEVER mixed
    // into blind detections or matched_stars.
    SOLVER_DEEP_HARVEST_MAX_POSITIONS: 500, // brightest-first cap
    // ⚠ 15.0 REVERTED to 12.5 SAME-DAY by measurement (row 538): the owner-
    // confirmed "bundle 15" raise was probed by the step-4 battery and the
    // wrong-WCS calibration arm LEAKED (BY 1/41 admitted, conjunction 15/41 at
    // 10.2σ, gate false-PASSED) — at G15 target density a wrong WCS still lands
    // on real stars. The 12.5 environment's 5/5 wrong-WCS collapse is the proven
    // safety. The row-513 23.7× win was about per-star PRODUCT harvest — the
    // owner proposal on the table is a SPLIT constant (confirm targets stay
    // 12.5-calibrated; product harvest goes 15) rather than a blind raise.
    SOLVER_DEEP_HARVEST_MAG_MAX: 12.5,      // confirm-target depth (Gaia G ≤ 12.5, wrong-WCS-safe)
    // Candidate SNR floor for the densification harvest (B3). Decoupled from
    // the SOLVE-side escalation acceptance (SOLVER_UW_ESCALATE_SNR_THRESHOLD)
    // so the two lanes — one gates a POINTING, one lists CANDIDATES — can be
    // tuned independently without cross-coupling. Default == 2 keeps the
    // harvest byte-identical to the shared escalation floor on introduction.
    SOLVER_DEEP_HARVEST_SNR_THRESHOLD: 2,   // per-position candidate acceptance (σ)

    // ─── POST-SOLVE CONFIRMATION (forced_confirm; FP wave C) ───
    // Promote CATALOG_FORCED candidates to CATALOG_FORCED_CONFIRMED only after
    // a more-sensitive AND more-stringent per-star conjunction, gated at the SET
    // level (the confirmed count must beat its own scrambled-null confirmed rate
    // at a binomial excess — the family-wise bar is SOLVER_CONFIRM_SET_EXCESS_Z
    // below, its own calibrated gate, DECOUPLED from the escalation gate
    // SOLVER_UW_ESCALATE_MIN_EXCESS_Z; see the calibration note at the
    // constant). Runs POST-SOLVE in the
    // session on the native Float32 science luminance (never the 8-bit solve
    // buffer). Never mutates confidence/matched_stars/WCS — writes deep_confirmed
    // only. These are ARMED confirmation-specific bars (not the DETECT_* thermal
    // no-ops); calibrated on real frames to confirm real stars on clean refs and
    // collapse to zero on scrambled/wrong-WCS positions.
    SOLVER_CONFIRM_SNR_FLOOR: 3.0,          // native-buffer promotion SNR floor
    SOLVER_CONFIRM_SNR_FLOOR_APPROX: 5.0,   // 8-bit fallback: bright-only promotion
    SOLVER_CONFIRM_SHAPE_MIN_SNR: 5.0,      // below this the moment shape is noise-driven → NOT_MEASURED
    SOLVER_CONFIRM_SHAPE_FWHM_TOL_FRAC: 0.6,// |momentFwhm − frameFwhm|/frameFwhm ≤ this
    SOLVER_CONFIRM_UNDERSAMPLED_FWHM_PX: 2.2, // frame FWHM below this ⇒ shape has ~0 power (5D3-class)
    SOLVER_CONFIRM_LOCAL_NULL_K: 16,        // local-null decoy count
    SOLVER_CONFIRM_SET_NULL_DRAWS: 4,       // frame-wide null draws for the set gate
    // Set-level family-wise gate (binomial excess of confirmed count over the
    // scrambled-null confirmed rate). CALIBRATED on the real SeeStar M66 frame
    // (tools/api/confirm_null_evidence.apispec.ts): TRUE-WCS excess = 77.9σ
    // (198/205 confirmed) vs a MAX WRONG-WCS excess of 9.3σ (0 confirmed) over
    // crpix offsets 18–120px. 15σ sits with comfortable margin ABOVE every
    // wrong-WCS tail (9.3σ) and FAR below the true signal (77.9σ) — decoupled
    // from the escalation gate (SOLVER_UW_ESCALATE_MIN_EXCESS_Z) so the two
    // bars are independently reviewable.
    // ⚠ RETIRED FROM DECIDING (phase-2 FDR flip, 2026-07-22): the set-level
    // decision is now the BY step-up inside confirmForcedSet (fdr_confirm.ts).
    // This value is FROZEN — never tuned — and continues to be REPORTED
    // (deep_confirmed.setExcessZ / confirm_status.setGateZ) for continuity.
    SOLVER_CONFIRM_SET_EXCESS_Z: 15,

    // --- M7: TPS DISTORTION FIT (tps_fitter.ts) ---
    // Regularization (smoothing) parameter for the thin-plate-spline fit on the
    // matched-star residual field. NOT a solver sigma gate and NOT a GATES.md
    // number: it is the spline's own fit-vs-smoothness knob, recorded verbatim in
    // the receipt's tps block so any solve is reproducible. The fit runs in a
    // NORMALIZED coordinate space (control-point offsets scaled by the max control
    // radius) so the r²·log r kernel entries are O(1) and λ trades meaningfully:
    //   λ → 0    exact interpolation (rings; chases centroid noise)
    //   λ → ∞    collapses to the affine plane (weights → 0 — the sanity limit)
    // 1e-3 = light smoothing that removes the systematic optical distortion
    // without overfitting per-star centroid jitter. TPS is a COORDINATE-ledger
    // OBSERVATION appended to the receipt; it never feeds solve/verify/acceptance,
    // so changing it can never move a sacred number (both e2e stay byte-identical).
    SOLVER_TPS_LAMBDA: 1e-3,

    // --- M7: TPS OUT-OF-SAMPLE EMISSION GATE (tps_fitter.ts fitTpsGated) ---
    // The plain in-sample rms_after is a LAUNDERED number: with ~100 knots the
    // spline INTERPOLATES its control points (rms_after ≈ 3", λ=1e-3) while its
    // OUT-OF-SAMPLE prediction on non-knot stars is ~10× worse (measured 35.7" on
    // the SeeStar/M66 frame — the depth study's forced-photometry recovery dropped
    // 1403→1136 when this overfit TPS was applied). These constants gate emission on
    // MEASURED generalization, so an overfit spline is refused (tps:null + a
    // tps_gate evidence block) instead of shipping a dishonest 3" claim. Practice
    // references: k-fold CV + GCV λ (Wahba 1990, "Spline Models for Observational
    // Data"); refuse-if-worse-than-baseline mirrors SCAMP/astrometry.net distortion
    // acceptance. NOT solver sigma gates — post-solve, COORDINATE-ledger observation
    // only; changing them can never move a sacred solve number.
    //
    // Deterministic k-fold count (fold assignment is a hash of quantized (u,v) —
    // NEVER Math.random). 5 = standard bias/variance CV compromise.
    SOLVER_TPS_CV_FOLDS: 5,
    // OOS admit multiplier: rms_oos must be ≤ MULT × max(rms_insample, OOS_FLOOR).
    // 2× tolerates honest fold-to-fold variance while catching a 10× overfit gap.
    SOLVER_TPS_OOS_INSAMPLE_MULT: 2,
    // Small absolute OOS noise floor (arcsec) — the irreducible centroid/linear-WCS
    // precision below which an OOS-vs-in-sample difference is noise, not overfit
    // (prevents refusing a near-perfect fit whose in-sample is ~0). ≈¼ px at SeeStar
    // scale. This is the "linear-WCS rms floor" term of the emission inequality.
    SOLVER_TPS_OOS_FLOOR_ARCSEC: 1.0,
    // GCV λ search grid (log-spaced), CAPPED at 1e-1: beyond this the spline
    // collapses toward its affine plane (weights→0) — an "affine spline" is not a
    // distortion spline (the linear WCS + SIP already carry the affine part), and
    // that degenerate regime is exactly where an overfit field's OOS can dip a hair
    // under the linear residual and sneak past the gate. Capping keeps GCV in the
    // genuine-spline regime; the beats-linear condition then refuses honestly.
    SOLVER_TPS_LAMBDA_GRID: [1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1] as number[],
    // Physics sanity ceiling (refusal bar, NOT a knob): the spline's peak
    // displacement must not exceed the plausible optical+atmospheric budget. Budget
    // = REFRACTION_ARCSEC_PER_DEG × sec²(zenith) × field_span_deg, ×MARGIN. With
    // altitude unknown we take the worst plausible zenith (WORST_SEC2) honestly.
    // Differential-refraction coefficient ≈1.02"/deg near zenith (Filippenko 1982,
    // atmospheric differential refraction); MARGIN=3 is generous so this only trips
    // on a physically-impossible spline, never a real wide-field distortion.
    SOLVER_TPS_REFRACTION_ARCSEC_PER_DEG: 1.02,
    SOLVER_TPS_PHYSICS_MARGIN: 3,
    // sec²(75°) ≈ 14.9 — worst plausible observing zenith angle (airmass ≈ 3.9);
    // beyond this few science frames are taken. Larger ⇒ MORE permissive ceiling.
    SOLVER_TPS_WORST_SEC2_ZENITH: 14.9,

    // --- M3: CFA CLASSIFIER (2x2-block-uniformity, run pre-binning) ---
    // Statistical std-Bayer / mono / quad-Bayer classifier over the raw frame,
    // BEFORE 2x2 luminance binning. Discriminators are PATTERN-AGNOSTIC — they
    // measure phase-mean SEPARATION, not which phase is which colour:
    //   L0 = normalised spread of the 4 pixel-level 2x2-phase means. A colour
    //        CFA gives systematically different raw counts per phase (dye
    //        transmission) => L0 large. Mono / quad (at the 2x2 scale) => ~0.
    //   L1 = same spread computed on the 2x2-BINNED image. A quad-Bayer binned
    //        image is ITSELF a half-res Bayer mosaic => L1 large; a std-Bayer or
    //        mono binned image is smooth luminance => ~0. This splits quad<->mono.
    // Decision: L0>=L0_THR -> std-bayer; else L1>=L1_THR -> quad-bayer; else mono.
    // Measured on the real Canon 60Da Carina Bayer FITS (full-frame scan):
    //   L0 = 0.060 (black=0, conservative) / 0.077 (pedestal), L1 = 0.0003
    //   => std-bayer with ~1.7-2.2x margin on L0 and a ~300x margin under L1_THR.
    CFA_CLASSIFY_L0_THRESHOLD: 0.035,   // >= this => std-bayer
    CFA_CLASSIFY_L1_THRESHOLD: 0.10,    // (L0 below) and >= this => quad-bayer

    // --- M4: FAST-FAIL DETECTION GUARD (dense / non-converging frame) ---
    // A pathological frame (pure noise, a mis-binned mosaic) produces a candidate
    // density that makes the O(deep x vanguard) dedup loop + the fwhm^2-scaled Mie
    // window scans grind for MINUTES (the ~470s Carina-class silent hang). The
    // guard reads the vanguard + deep candidate counts the instant both are known
    // and, if the deep-candidate density is pathological, bails LOUD + FAST with a
    // structured diagnostic (counts, density, dimensions, why) BEFORE those passes.
    // CALIBRATED on the real Carina 60Da (extract_blobs uses count>=2):
    //   deep = 43,197 candidates = 9,613/MP over a 4.49 MP binned frame; vanguard
    //   = 14,194. The trigger sits ~4x above that density AND behind a 50k absolute
    //   floor (deep must exceed BOTH), so Carina — and any smaller frame — is
    //   double-protected and never trips. NOTE: this is a conservative bound above
    //   the richest verified real field; confirm against the live carina e2e at
    //   merge before tightening.
    DETECT_MAX_CANDIDATE_DENSITY_PER_MP: 40000,  // deep candidates per megapixel
    DETECT_MIN_CANDIDATES_FOR_GUARD: 50000,      // absolute deep-count floor; below => never bail

    // --- M4: PER-BLOB THERMAL-NOISE CUTS (detection_cuts.ts, NEXT_MOVES §7) ---
    // SExtractor-style shape discriminators measured TS-side on an 11x11
    // luminance stamp. MEASURED VERDICT (2026-07-07 instrumented runs): on
    // demosaiced DSLR grids the blob-level shape stats do NOT separate thermal
    // junk from faint real stars — the 5D3's distributions overlap the clean
    // bundled CR2's almost exactly (sharpness p50 0.34 vs 0.33, max 1.03 vs
    // 1.01; momentFwhm saturates at the 11x11 noise limit ~7.4px on both) —
    // so these ceilings are calibrated OUTSIDE every measured distribution
    // (SeeStar vanguard/deep n=288/921: sharp max .60/.85, mfw min 3.40/2.68,
    // ell max .40/.61 · bundled CR2 n=89/2207: sharp max .37/1.006, mfw min
    // 5.96/5.37, ell max .26/.47 · 5D3 n=17233: sharp max 1.03, mfw min 2.90,
    // ell max .64). They are ARMED GUARDS against true sub-pixel spikes and
    // streak clusters (which measure mfw<1.3 / sharp>1.1 / ell>0.7 on grids
    // where the stamp isn't noise-saturated), NOT the 5D3 lever — that is the
    // hot-pixel map below. Byte-identical e2e = the no-op proof.
    // Semantics: FWHM_FLOOR <= 0 disables; SHARPNESS_MAX Infinity disables;
    // ELLIPTICITY_MAX >= 1 disables.
    DETECT_FWHM_FLOOR_PX: 1.3,        // < min measured clean mfw (2.68) — sub-pixel spikes only
    DETECT_SHARPNESS_MAX: 1.10,       // > max measured anywhere (1.03) — lone-pixel ratio guard
    DETECT_ELLIPTICITY_MAX: 0.70,     // > max measured anywhere (0.64) — streak/cluster guard

    // --- M4: STATISTICAL HOT-PIXEL MAP (hot_pixel_map.ts, NEXT_MOVES §7) ---
    // A pixel is masked pre-extraction iff it spikes NSIGMA above its
    // 8-neighbour median WHILE that median sits within NEIGHBOR_BG_SIGMA of
    // the frame background (a real star elevates its neighbours via the PSF;
    // a hot pixel does not). Copy-on-flag: zero flags = the original buffer,
    // untouched — clean frames byte-identical by construction. NSIGMA <= 0
    // disables. CALIBRATED from the measured [HotPixelMap] candidate ladders
    // (2026-07-07): SeeStar M66 = 0 flagged at every N>=6; bundled CR2 = 35 px
    // at N6 (its handful of real DSLR hot pixels); 5D3 (ISO6400/43°C) =
    // 8,474 px at N6 vs 0 at N12 — the thermal-junk population lives at
    // 6-10σ, so N=6 is the discriminating rung.
    //
    // DENSITY APPLICATION GATE (measured-evidence gate, same pattern as the
    // fast-fail guard): masking is APPLIED only when the flagged density
    // marks the frame thermal-noise-dominated. Measured: bundled CR2 =
    // 1.75 flagged/MP (masking those 35 real hot pixels moved the calibrated
    // solve's 5th decimal — empirically NOT a no-op); 5D3 = 378 flagged/MP.
    // The populations separate ~200x in density space; 25/MP sits ~14x above
    // the clean frame and ~15x below the thermal one. Below the gate the
    // buffer is returned untouched — clean frames byte-identical BY
    // CONSTRUCTION (the flagged count is still measured and logged).
    DETECT_HOTPIXEL_NSIGMA: 6,
    DETECT_HOTPIXEL_NEIGHBOR_BG_SIGMA: 3,   // "neighbours at background" ceiling
    DETECT_HOTPIXEL_MIN_DENSITY_PER_MP: 25, // apply mask only above this flagged density

    // --- M4: DETECTION-PLANE FLATTENING (EXPERIMENTAL — default-OFF) ---
    // Four independent, audit-verified detection-plane levers behind env flags.
    // ALL default to the legacy behaviour, so with the vars unset (every gate,
    // both browser and Node pinned solves) detection is BYTE-IDENTICAL by
    // construction. Ledger: PIXEL. Each lever touches ONLY a detection-luminance
    // COPY — the science buffer (`lum`), photometry (pool.refineStars), Mie /
    // background and every receipt measurement keep reading NATIVE pixels (the
    // same split the lens-distortion prior uses: matching coords corrected,
    // photometry native). See detection_flatten.ts for the two-plane invariants.
    //
    // ⚠ PROMOTION CAVEAT — do NOT flip these to default-ON casually. The primary
    // m4 detection σ literals (sigFactor=2.0, vanguard base=3.0, deep=1.0) were
    // implicitly calibrated on UNFLATTENED frames; flattening an artifact shifts
    // the detection statistics exactly as the CFA-parity flag did (50d9a1a).
    // Promoting ANY of these requires a PAIRED threshold recalibration + one
    // rebaseline (decoder-cutover #14 discipline), NOT a default flip. Campaign
    // runs opt in per-run via the env var.
    //
    // 1. Subtract the fitted deg-2 background surface (BackgroundSurfaceModeler,
    //    already fit at signal_processor:421 but never consumed) from the DEEP
    //    detection buffer before its global mean+σ threshold. The fit needs the
    //    vanguard stars + horizon, so it can only affect the deep pass.
    DETECT_APPLY_BG_SURFACE: envIntOverride('DETECT_APPLY_BG_SURFACE', 0) === 1,
    // 2. Multiply the detection buffer by a frame-measured radial vignette gain
    //    (a2/a4 fit ported from tools/psf/corrections.mjs:115) BEFORE the surface
    //    fit and before extraction (owner order: vignette first, then
    //    background/band). Detection copy only — the render-layer vignette
    //    flatten (tools/rawlab/aesthetic_render.mjs) is a SEPARATE plane/copy.
    DETECT_APPLY_VIGNETTE_GAIN: envIntOverride('DETECT_APPLY_VIGNETTE_GAIN', 0) === 1,
    // 3. Density-guard regime at the fast-fail boundary: 0 = legacy THROW
    //    (default), 1 = CAP (keep the top-N-by-flux deep candidates at the
    //    density boundary, stamp the dropped tail HIGH_DENSITY, continue). Does
    //    NOT move DETECT_MAX_CANDIDATE_DENSITY_PER_MP / _MIN_CANDIDATES_FOR_GUARD
    //    — only the action taken when they trip.
    DETECT_DENSITY_GUARD_MODE: envIntOverride('DETECT_DENSITY_GUARD_MODE', 0),
    // 4. Defer the Milky-Way centreline/ellipse trace until AFTER the real
    //    horizon envelope is derived (it currently traces against a height*0.8
    //    placeholder) and feed it the measured terrain silhouette when terrain
    //    evidence exists (placeholder when full-sky — byte-identical there).
    DETECT_MW_REAL_HORIZON: envIntOverride('DETECT_MW_REAL_HORIZON', 0) === 1,

    // â”€â”€â”€ IMAGE EXPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    PREVIEW_MAX_DIM: 3840,
    PREVIEW_JPEG_QUALITY: 0.85,
    // APPLIED-SCIENCE render (PIXEL ledger, render-only) — the UMBRELLA governing
    // flag for the "measurements as displayed" corrected preview (v1: geometric
    // distortion warp via the SIP|TPS|BC selection ladder; vignette flatten is a
    // deferred P2 sub-flag). DEFAULT ON (1.3.2 product ruling): the post-solve
    // wizard preview is re-rendered through the ONE inverse warp of the arbitrated
    // per-frame-fitted model. HONEST-OR-ABSENT: a no-op when no qualifying model
    // exists (SeeStar has no SIP/TPS/BC fit ⇒ byte-identical warp-free STF), and it
    // NEVER touches WCS/matched_stars/solve/receipt — the render plane feeds neither
    // ledger, so both pinned reference solves stay byte-identical (they assert SOLVE
    // numbers + receipt bytes, not rendered pixels; headless generatePreviews=false
    // makes it a hard no-op on every gate lane).
    RENDER_APPLIED_SCIENCE: envIntOverride('RENDER_APPLIED_SCIENCE', 1) === 1,
    // LEGACY kill-switch (SUPERSEDED by RENDER_APPLIED_SCIENCE; flag-graveyard
    // review S9 records the graduation). Default flipped 0→1 at the applied-science
    // default-ON flip so it no longer forces OFF; still honored — `RENDER_APPLY_SIP=0`
    // force-disables the corrected render regardless of the umbrella. The applied
    // render fires iff RENDER_APPLIED_SCIENCE && RENDER_APPLY_SIP.
    RENDER_APPLY_SIP: envIntOverride('RENDER_APPLY_SIP', 1) === 1,

    // ─── SPCC CHANNEL GAINS (render-lane white balance; COLOR_MATH_PROGRAM §3.2) ───
    // RENDER-LANE CONSTANTS — NOT calibrated SOLVER gates. These gate whether the
    // SPCC-DERIVED per-channel white-balance gains (m8_photometry/spcc_calibrator
    // fitChannelGains, TLS) are APPLIED to the preview render (PIXEL ledger), never
    // the solve/PSF/forced-photometry chain (which always reads LINEAR UNSCALED
    // data). The gains are ALWAYS recorded in the receipt (spcc.gains) regardless;
    // below the gate the render falls back to the existing star-ensemble-white
    // heuristic (honest-or-absent). Both pinned solves stay byte-identical (they
    // assert SOLVE numbers, not rendered pixels).
    //
    // CALIBRATED N=7 solved (2026-07-10 sweep — test_results/overnight_run_2026-
    // 07-10/spcc_gains_n5.json; SeeStar M66/M81/M100/M1/Arp-316/M31/Crescent OSC
    // FITS through the REAL headless pipeline). The fit r² is CLEANLY BIMODAL:
    // strong color solves M66 r²=0.897 (233★) and M81 r²=0.757 (192★) vs weak/junk
    // fits ≤0.373 (already-balanced M31 0.261/2437★, nebula-dominated Crab −6.78
    // with gain_b=145.7, tiny-N M100 9★ / Arp-316 12★). The r² floor sits in the
    // gap [0.373, 0.757]; MIN_STARS refuses the tiny-N fits on count; MAX_GAIN
    // catches Crab's blowup. VERDICT: gate cleanly separates → APPLY-BY-DEFAULT ON,
    // only strong color solves apply (M66/M81 pass; the other 5 fall back to the
    // honest heuristic). NOT frame-to-frame instability (different targets, not the
    // same rig repeated) — the gate, not the raw gains, is what ships.
    SPCC_GAINS_WHITE_REF_BP_RP: 0.0,   // white reference color (A0V/Vega ≈ 0 BP-RP)
    SPCC_GAINS_MIN_STARS: 20,          // ≫ tiny-N junk (9–12★), ≪ healthy (192–2437★)
    SPCC_GAINS_MIN_R2: 0.55,           // min(r²_br,r²_gr) floor, centered in the [0.373,0.757] gap
    SPCC_GAINS_SLOPE_MIN: 0.3,         // b−r TLS slope sanity (healthy 0.53–0.91; junk ≤0.35 or <0)
    SPCC_GAINS_SLOPE_MAX: 3.0,         // b−r TLS slope sanity: upper bound
    SPCC_GAINS_MIN_GAIN: 0.25,         // per-channel gain sanity: floor (healthy gains 0.68–1.57)
    SPCC_GAINS_MAX_GAIN: 4.0,          // per-channel gain sanity: ceiling (catches Crab gain_b=145.7)
    // REVERSIBILITY (R11): the ONE kill flag for APPLICATION. 0 ⇒ gains are still
    // fit + recorded but NEVER applied to pixels (record-always survives the flag).
    // Env-overridable like the SOLVER_* levers (SPCC_GAINS_APPLY=0); browser
    // `process` undefined ⇒ default. Byte-identical solves either way.
    SPCC_GAINS_APPLY: envIntOverride('SPCC_GAINS_APPLY', 1) === 1,

    // ─── PSF-MEASUREMENT-LAYER CORRECTIONS (cells ②③⑥; MULTILAYER_MATRIX §4) ───
    // The fourth-layer doctrine: a physical map/coefficient is applied to the
    // EXTRACTED per-star QUANTITY (flux, shape), NEVER by pre-warping the source
    // buffer. All three DEFAULT-OFF and ADDITIVE (corrected values reported
    // ALONGSIDE the raw measurement; the solve/WCS/matched_stars and the
    // forced-confirm gates keep consuming RAW) → both pinned reference solves are
    // byte-identical by construction. These are NOT calibrated solver gates.
    //
    // ② Divide each extracted per-star flux by the per-band vignette transmission
    //    at the star's position (SPCC per-band color/zp, psf_field amp, forced
    //    photometry). Per-band = CHROMATIC (achromatic gain cancels in color).
    PSF_FLUX_VIGNETTE_CORRECT: envIntOverride('PSF_FLUX_VIGNETTE_CORRECT', 0) === 1,
    // ③ Per-star atmospheric-extinction flux correction (k·X mag, X=airmass).
    //    SPCC zero-point consumes corrected fluxes when ON.
    PSF_FLUX_EXTINCTION_CORRECT: envIntOverride('PSF_FLUX_EXTINCTION_CORRECT', 0) === 1,
    // ③ Extinction coefficient (mag / airmass) when the atmosphere stage supplies
    //    no measured k. DEFAULT-labeled honest broadband-visual value (~0.15 mag/
    //    airmass, dark-site V). Used only when PSF_FLUX_EXTINCTION_CORRECT is ON.
    PSF_EXTINCTION_K_DEFAULT: envFloatOverride('PSF_EXTINCTION_K_DEFAULT', 0.15),
    // ⑥ Report SKY-corrected PSF shape (FWHM-maj/min, orientation, ellipticity)
    //    via the LOCAL Jacobian of the best coordinate model at each star,
    //    ALONGSIDE the raw-pixel values (both always). Does NOT change what
    //    forced_confirm's shape gate consumes (it keeps raw px; migration needs
    //    a paired recal).
    PSF_JACOBIAN_DEPROJECT: envIntOverride('PSF_JACOBIAN_DEPROJECT', 0) === 1,

    ARCSEC_PER_DEGREE: 3600,
    PACKET_VERSION: "2.1.0",
    GAMMA_CORRECTION: 1/2.2
};

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG-AS-ARGUMENT OVERRIDE SEAM (NEXT_MOVES §11b)
// ═══════════════════════════════════════════════════════════════════════════
//
// Thread runtime PIPELINE_CONSTANTS overrides for a knob experiment WITHOUT
// editing source per experiment. Every consumer reads PIPELINE_CONSTANTS via
// LIVE property access at call-time (no consumer destructures it into a
// module-scoped const), so an Object.assign BEFORE a solve is picked up
// everywhere — no plumbing needed.
//
// ── PROCESS-GLOBAL MUTATION HAZARD ──────────────────────────────────────────
// PIPELINE_CONSTANTS is a shared mutable singleton. applyConfigOverrides
// mutates it IN PLACE, so the change LEAKS across every solve in the SAME
// process. This is SAFE TODAY because tools/api/run.mjs forks a FRESH vitest
// process per solve (one solve = one process = one clean config). A future
// caller that runs MULTIPLE solves in ONE process (e.g. an in-process sweep)
// MUST snapshot+restore around each solve — capture with snapshotConfig(keys)
// before applyConfigOverrides and restoreConfig(snapshot) after — or one
// experiment's knobs silently bleed into the next. NEVER call this on the
// calibrated wizard/e2e path: an override is by definition experimental.

/** Result of an applyConfigOverrides call — the keys that took vs were refused. */
export interface ConfigOverrideResult {
    /** Known keys whose value was assigned into PIPELINE_CONSTANTS. */
    applied: string[];
    /** Keys refused: unknown name OR a value whose typeof differs from the default. */
    rejected: string[];
}

/**
 * A recorded active-override value. Numeric/string/boolean values come from
 * applyConfigOverrides (a real PIPELINE_CONSTANTS knob). An OBJECT value is a
 * namespaced experimental MARKER recorded via recordExperimentalMarker — a
 * pure receipt self-description (e.g. a pre-detection pixel LIFT descriptor)
 * that sets no numeric knob.
 */
export type ActiveOverrideValue = number | string | boolean | Record<string, unknown>;

// The overrides applied in THIS process (null = none → a calibrated run). Read
// by buildReceipt to stamp `config_overrides` + `experimental` (honest-or-absent).
let _activeConfigOverrides: Record<string, ActiveOverrideValue> | null = null;

/**
 * Assign runtime overrides into PIPELINE_CONSTANTS for a knob experiment.
 * Only KNOWN keys with a TYPE-COHERENT value are applied — an unknown key or a
 * type mismatch (e.g. a string for a numeric knob) is REJECTED, never silently
 * created as garbage. Records the applied set for the receipt stamp. A null /
 * empty / undefined argument is a strict NO-OP (config stays byte-identical).
 * See the PROCESS-GLOBAL MUTATION HAZARD note above before calling.
 */
export function applyConfigOverrides(
    overrides: Record<string, number | string | boolean> | null | undefined
): ConfigOverrideResult {
    const applied: string[] = [];
    const rejected: string[] = [];
    if (overrides) {
        const target = PIPELINE_CONSTANTS as Record<string, unknown>;
        for (const [k, v] of Object.entries(overrides)) {
            if (!Object.prototype.hasOwnProperty.call(target, k)) {
                rejected.push(k);           // unknown key — do NOT create it
            } else if (typeof target[k] !== typeof v) {
                rejected.push(k);           // type mismatch — refuse garbage
            } else {
                target[k] = v;
                applied.push(k);
            }
        }
    }
    if (rejected.length > 0) {
        try { console.warn(`[pipeline_config] applyConfigOverrides rejected unknown/mistyped keys: ${rejected.join(', ')}`); } catch { /* no console */ }
    }
    if (applied.length > 0) {
        _activeConfigOverrides = _activeConfigOverrides ?? {};
        // Type-safe: only keys that passed the typeof-match guard above reach here,
        // so overrides[k] is one of number | string | boolean.
        for (const k of applied) _activeConfigOverrides[k] = overrides![k];
    }
    return { applied, rejected };
}

/**
 * The overrides applied in this process (a COPY), or null when none were
 * applied. buildReceipt reads this to stamp the receipt: absent/null = a
 * calibrated run; a non-null object = an EXPERIMENTAL run.
 */
export function getActiveConfigOverrides(): Record<string, ActiveOverrideValue> | null {
    return _activeConfigOverrides ? { ..._activeConfigOverrides } : null;
}

/**
 * Record a NAMESPACED, object-valued experimental MARKER into the active
 * override record so a run that applied a NON-NUMERIC experiment — e.g. a
 * pre-detection pixel LIFT (nebulosity background subtraction) — is stamped
 * `experimental:true` + `config_overrides.<name>` in the receipt via
 * getActiveConfigOverrides. Unlike applyConfigOverrides this does NOT mutate
 * PIPELINE_CONSTANTS (there is no numeric knob to set) — it is a pure receipt
 * self-description so a lifted run can never be mistaken for a calibrated one.
 * Cleared by restoreConfig like any other active override. A no-marker run is
 * byte-identical (this is never called). NEVER call on a calibrated wizard/e2e
 * path — a marker is by definition experimental.
 */
export function recordExperimentalMarker(name: string, descriptor: Record<string, unknown>): void {
    _activeConfigOverrides = _activeConfigOverrides ?? {};
    _activeConfigOverrides[name] = descriptor;
}

/** Capture the current values of the given keys, for restore around a solve. */
export function snapshotConfig(keys: string[]): Record<string, unknown> {
    const snap: Record<string, unknown> = {};
    const target = PIPELINE_CONSTANTS as Record<string, unknown>;
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(target, k)) snap[k] = target[k];
    }
    return snap;
}

/** Restore values captured by snapshotConfig and clear the active-override record. */
export function restoreConfig(snapshot: Record<string, unknown>): void {
    const target = PIPELINE_CONSTANTS as Record<string, unknown>;
    for (const [k, v] of Object.entries(snapshot)) {
        if (Object.prototype.hasOwnProperty.call(target, k)) target[k] = v;
    }
    _activeConfigOverrides = null;
}

export const FILTER_SIGNATURES = [
    { r: -0.02, g: -0.15, b:  0.01, type: 'CLS' },
    { r:  0.08, g: -0.20, b:  0.12, type: 'DUAL_NB' },
    { r: -0.05, g: -0.08, b:  0.06, type: 'UHC' },
    { r: -0.01, g: -0.01, b: -0.01, type: 'UV_IR' },
];

