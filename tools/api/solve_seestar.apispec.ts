/**
 * Toolchest API headless smoke (I2.1): the SeeStar M66 FITS through the REAL
 * wizard pipeline in Node, asserted against THE SACRED NUMBERS **EXACTLY**.
 *
 * BYTE-IDENTICAL POLICY (LAW 2 — gates are never loosened): every numeric
 * assertion below is `toBe` (IEEE-754 bit equality via ===), NOT closeTo.
 * If this fails at ULP level the fix is diagnosis (atlas ingest order,
 * Node-vs-Chromium V8 skew), never a tolerance.
 *
 * Run: npx vitest run -c tools/api/api_harness.config.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from './headless_driver';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');

// The sacred SeeStar regression numbers (CLAUDE.md / docs/GATES.md — the
// browser e2e asserts these same values byte-identically).
const SACRED = {
    ra_hours: 11.341267568475146,
    dec_degrees: 13.048784954351197,
    pixel_scale: 3.6801611047133536,
    confidence: 0.7967181264113802,
    matched: 265,
} as const;

describe('tools/api headless smoke — SeeStar M66 (sacred numbers, exact)', () => {
    it('runs the real pipeline in Node and reproduces the browser solve EXACTLY', async () => {
        expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH} (local-only asset)`).toBe(true);

        const buf = fs.readFileSync(FIT_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const { receipt, events, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

        // ── The API contract version ──
        // 2.7.0: TPS emission is now OUT-OF-SAMPLE GATED (fitTpsGated). This SeeStar/
        // M66 frame FIRES the TPS fire gate (rms ≈ 31") but its interpolating spline
        // (in-sample ≈3", OOS ≈35") is REFUSED — so the receipt now carries
        // `astrometry.tps === null` + a `tps_gate(admitted:false)` verdict instead of
        // a laundered 3" tps block (asserted below). This is a post-solve COORDINATE
        // observation: every sacred SOLVE number stays IEEE bit-identical; the version
        // bump + honest TPS emission is the one sanctioned delta.
        // (2.6.0 = source_provenance; 2.5.0 = optics_hints; 2.4.0 = residual vectors +
        //  photometry; 2.3.0 = tps.)
        // 2.8.0: additive `fidelity` field on the SPCC receipt block
        // (COLOR_MATH_PROGRAM §4.1 — color as a MEASURED product). Post-solve
        // surfacing only; every sacred SOLVE number below stays IEEE bit-identical.
        // 2.9.0: additive `gains` field on the SPCC receipt block (§3.2 — SPCC-
        // grounded white balance). Per-channel TLS-fit render gains, ALWAYS recorded;
        // APPLICATION is render-lane only (PIXEL ledger), so every sacred SOLVE
        // number below stays IEEE bit-identical (this headless path renders nothing).
        // 2.10.0: additive top-level `confirm_status` block — the DERIVED four-state
        // forced-photometry confirmation verdict (the "safety catcher"). Pure
        // classification of the already-computed deep_confirmed; every sacred SOLVE
        // number below stays IEEE bit-identical.
        // 2.11.0: additive top-level `solve_provenance` block — LEAN solve provenance
        // (Escalation §7 Monday slice). Pure classification of the already-resolved
        // hint source; every sacred SOLVE number below stays IEEE bit-identical.
        // 2.13.0: additive top-level `pipeline_provenance` block (decoder_arm + atlas
        // identity). SeeStar is FITS-native → routed to the pure-TS FITS decoder, NOT
        // rawler/libraw → decoder_arm=null (honest). Every SOLVE number stays identical.
        // 2.14.0: additive rawler_calibration + user_target_hint + nebulosity_layer
        // blocks (task #11, merged 2026-07-12) — all three null/absent on FITS-native
        // frames (honest-or-absent). Enumerated rebaseline; SOLVE pins unchanged.
        // 2.15.0: additive star-data correction cells (①–⑥, all default-OFF/inert).
        // On this FITS SeeStar solve: spcc.vignette/extinction=null (flags OFF),
        // psf_attribution centroids/sky_deprojected/chromaticDispersion honest-null;
        // rawler_calibration null (FITS-native). SOLVE pins byte-identical.
        // 2.16.0: additive top-level `compute_routes` block (loud compute-route
        // observability). This FITS SeeStar headless solve stamps demosaic=skipped
        // (pre_demosaiced_stacked) + preview=skipped (previews_disabled, headless
        // I1.2). Pure diagnostic — every sacred SOLVE number below stays IEEE
        // bit-identical. (Worktree branched at 2.15.0; version reconciles at merge.)
        // 2.17.0: FDR gate-authority flip (2026-07-22) — additive fdr blocks;
        // solve numbers + conjunction stats byte-identical, verdict unchanged.
        expect(receipt.version).toBe('2.20.0');
        // [COMPUTE-ROUTE OBSERVABILITY · 2.16.0] The invisible seam-skips are now loud.
        expect(Array.isArray(receipt.compute_routes)).toBe(true);
        expect(receipt.compute_routes).toEqual([
            { seam: 'demosaic', route: 'skipped', reason: 'pre_demosaiced_stacked' },
            { seam: 'preview', route: 'skipped', reason: 'previews_disabled' },
        ]);
        // [PROVENANCE · 2.13.0] FITS-native frame → NO raw decode ran → decoder_arm null;
        // atlas_id is the committed LAW-7 golden fingerprint (non-null on-box).
        expect(receipt.pipeline_provenance).not.toBeNull();
        expect(receipt.pipeline_provenance.decoder_arm).toBeNull();
        expect(typeof receipt.pipeline_provenance.atlas_id).toBe('string');
        // [PROVENANCE · 2.11.0] The SeeStar frame carries a FITS-header GOTO pointing,
        // so its search was seeded by a metadata prior → solved_via='assisted:metadata'.
        // A clean solve (no earlier failed attempt) → failed_attempts ABSENT. This
        // proves the new field survives the headless (Node) path bit-identically.
        expect(receipt.solve_provenance).not.toBeNull();
        expect(receipt.solve_provenance.solved_via).toBe('assisted:metadata');
        expect('failed_attempts' in receipt.solve_provenance).toBe(false);
        // [SAFETY CATCHER] MEASURED: the M66 forced-photometry SET-LEVEL gate PASSES
        // — set excess 77.9σ ≫ the 15σ SOLVER_CONFIRM_SET_EXCESS_Z gate — so this
        // frame is CONFIRMED (209/215 forced targets confirmed). setGateZ is the
        // CITED constant, never re-derived.
        expect(receipt.confirm_status.status).toBe('CONFIRMED');
        expect(receipt.confirm_status.setExcessZ).toBe(21.12);
        expect(receipt.confirm_status.nTargets).toBe(36);
        // 2.17.0 gate authority: BY step-up decides (probe 2026-07-22: 205/205).
        expect(receipt.confirm_status.gate_authority).toBe('FDR_BY');
        expect(receipt.confirm_status.n_confirmed_fdr).toBe(32);
        expect(receipt.confirm_status.fdr_q).toBe(0.05);
        expect(receipt.confirm_status.confirmed).toBe(29);
        expect(receipt.confirm_status.setGateZ).toBe(15);
        // Honest-or-absent: no ledger match on either path → null block (byte-identical).
        expect(receipt.source_provenance).toBeNull();
        // TPS emission gate: this frame's overfit spline is refused (honest-or-absent).
        expect(receipt.solution.astrometry.tps).toBeNull();
        expect(receipt.solution.astrometry.tps_gate?.admitted).toBe(false);

        // 2.20.0: additive top-level `final_astrometry` block — the step-6 TERMINAL
        // data-fidelity refit (a SECOND, provenance-tagged WCS). A PRODUCT: never
        // overwrites the solve WCS / feeds confirm, so every SACRED SOLVE number
        // below stays IEEE bit-identical. This FITS SeeStar carries a real GPS site +
        // trusted clock, so differential refraction is APPLIED (sub-px to ~1.2px);
        // the SNR-weighted refit lowers the WEIGHTED RMS (26.97→23.69") on M66's
        // large, non-smooth (TPS-refused) residual field. The refined LINEAR WCS
        // terms equal the solve's (a linear-WCS refit is a separate solver).
        const fa = receipt.final_astrometry;
        expect(fa).not.toBeNull();
        expect(fa.provenance).toBe('REFINED_FINAL_ASTROMETRY');
        expect(fa.ledger).toBe('COORDINATE');
        expect(fa.grid).toBe('SCIENCE_NATIVE');
        expect(fa.n_stars).toBe(265);
        expect(fa.n_psf_centroids).toBe(256);
        expect(fa.psf_centroid_source).toBe('WASM_LM_GAUSSIAN');
        expect(fa.sip_order).toBe(3);
        expect(fa.sip).not.toBeNull();
        expect(fa.sip.a_order).toBe(3);
        // refined WCS linear terms ARE the solve's (never a linear refit): the refined
        // block carries crval in HOURS (engine convention), so ×15 == the solve WCS's
        // CRVAL1 (degrees), crpix/cd equal verbatim. Ties the product to the solve linear.
        expect(fa.wcs.crval[0] * 15).toBe(receipt.wcs.CRVAL1);
        expect(fa.wcs.crpix[0]).toBe(receipt.wcs.CRPIX1);
        expect(fa.wcs.cd[0][0]).toBe(receipt.wcs.CD1_1);
        // exact refined-fit evidence (deterministic — no wall-clock enters the fit).
        expect(fa.rms.linearArcsec).toBe(30.53905);
        expect(fa.rms.refinedArcsec).toBe(30.43463);
        expect(fa.rms.weightedLinearArcsec).toBe(26.97165);
        expect(fa.rms.weightedRefinedArcsec).toBe(23.69182);
        expect(fa.rms.solveMeanResidualArcsec).toBe(20.66891);
        expect(fa.improved).toBe(true);
        expect(fa.weighting.method).toBe('PSF_AMPLITUDE');
        // differential refraction APPLIED (real FITS site + trusted clock).
        expect(fa.refraction.applied).toBe(true);
        expect(fa.refraction.tier).toBe('APPROXIMATE');
        expect(fa.refraction.siteLatDeg).toBe(46.2184);
        expect(fa.refraction.siteLonDeg).toBe(-84.068);
        expect(fa.refraction.fieldCenterAltDeg).toBe(43.7383);
        expect(fa.refraction.medianDisplacementPx).toBe(0.4155);
        expect(fa.refraction.maxDisplacementPx).toBe(1.2418);
        expect(fa.refraction.zenithPaImageDeg).toBe(232.904);

        // ── THE SACRED NUMBERS — exact equality, no tolerances ──
        expect(receipt.solution).toBeTruthy();
        expect(receipt.solution.ra_hours).toBe(SACRED.ra_hours);
        expect(receipt.solution.dec_degrees).toBe(SACRED.dec_degrees);
        expect(receipt.solution.pixel_scale).toBe(SACRED.pixel_scale);
        expect(receipt.solution.confidence).toBe(SACRED.confidence);
        expect(receipt.solution.stars_matched).toBe(SACRED.matched);
        // Session-side mirror (what the e2e reads from the live wizard).
        expect(session.solution?.ra_hours).toBe(SACRED.ra_hours);
        expect(session.solution?.matched_stars?.length).toBe(SACRED.matched);

        // ── Event stream: consumable headless (ROADMAP Toolchest constraint #2) ──
        const locked = events.find(
            (e) => e.kind === 'finding' && (e as any).finding?.kind === 'solution_locked'
        ) as any;
        expect(locked, 'no solution_locked finding in event stream').toBeTruthy();
        expect(locked.finding.raHours).toBe(SACRED.ra_hours);
        expect(locked.finding.matched).toBe(SACRED.matched);
        expect(
            events.some((e) => e.kind === 'run_finished' && (e as any).ok === true),
            'no run_finished(ok) in event stream'
        ).toBe(true);

        // ── [SCHEMA A · inc 3] per-star 2D residual vectors (WASM narrow path) ──
        // Every matched star carries a real vector recovered by gnomonic reprojection
        // through the solved WCS. The wasm scalar `residual_arcsec` is a LINEAR sky-
        // space approximation (edge-inflated); the gnomonic vector is the CORRECT
        // residual (solver_entry.ts documents the measured center-agree/edge-diverge).
        {
            const cd = receipt.wcs;
            const ms = receipt.solution.matched_stars as any[];
            const vecStars = ms.filter((m) => m.dx_px != null);
            expect(vecStars.length).toBe(ms.length); // every match got a vector
            for (const m of vecStars) {
                // (c) dRA/dDec are EXACTLY the fitted-CD image of (dx,dy) — parity via CD.
                const dRA = (cd.CD1_1 * m.dx_px + cd.CD1_2 * m.dy_px) * 3600;
                const dDec = (cd.CD2_1 * m.dx_px + cd.CD2_2 * m.dy_px) * 3600;
                expect(Math.abs(dRA - m.dRA_arcsec)).toBeLessThan(1e-9);
                expect(Math.abs(dDec - m.dDec_arcsec)).toBeLessThan(1e-9);
            }
            // (b) center-most match: gnomonic reprojection ≈ wasm-linear scalar where
            // the small-angle approximation holds (measured <0.1" on M66; bound 0.5").
            const central = vecStars.slice().sort(
                (a, b) => Math.hypot(a.x - cd.CRPIX1, a.y - cd.CRPIX2) - Math.hypot(b.x - cd.CRPIX1, b.y - cd.CRPIX2)
            )[0];
            const magPx = Math.hypot(central.dx_px, central.dy_px) * receipt.solution.pixel_scale;
            expect(Math.abs(magPx - central.residual_arcsec)).toBeLessThan(0.5);
        }

        // ── Headless contract: no browser preview artifacts were produced ──
        expect(session.previewUrl).toBeNull();
    });
});
