/**
 * Toolchest API headless gate (CR2 fold-in, increment 1): the bundled Canon T6
 * CR2 (public/demo/sample_observation.cr2) through the REAL wizard pipeline in
 * Node, asserted against the SACRED blind-solve numbers **EXACTLY**.
 *
 * This is the CR2 lane's permanent headless gate — the thing a worktree agent
 * can run where Playwright can't go (the sacred CR2 e2e is browser-only;
 * run_wizard_cr2.mjs drives the same OrchestratorSession under the wizard UI).
 * The decode is the ENGINE path (metadata_reaper → the rawler default arm since
 * the 2026-07-11 cutover; the libraw-wasm Node Worker bridge in
 * headless_driver.ts backs the VITE_DECODER_RAWLER=0 cold path), not the
 * tools/psf decode-fork.
 *
 * BYTE-IDENTICAL POLICY (LAW 2 — gates are never loosened): every numeric
 * assertion below is `toBe` (IEEE-754 bit equality via ===), matching
 * solve_seestar.apispec.ts. The exact browser values are printed by every CR2
 * e2e run (test_results/e2e/cr2_<ts>/console.log.txt, "[step5] BLIND SOLVED ...").
 * If this ever fails at ULP level the fix is diagnosis (Node-vs-Chromium V8
 * float skew across the CR2 pipeline), NEVER a tolerance — report the divergence.
 *
 * CONTEXT INPUTS: none. run_wizard_cr2.mjs supplies NO UI values — step2 just
 * advances (EXIF time is green, GPS is absent — null, no fabricated default) and
 * step4 is the internal EXIF_OPTICS scale lock (the dummy-50mm → 14mm override
 * lands ~63.35"/px inside the optics resolver). So `overrides` is undefined, the
 * exact headless mirror of the browser wizard's CR2 flow.
 *
 * Run: npx vitest run -c tools/api/api_harness.config.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from './headless_driver';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CR2_PATH = path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');

// The sacred CR2 blind-solve numbers — the exact browser values from
// test_results/e2e/cr2_<ts>/console.log.txt ("[step5] BLIND SOLVED ...").
// REBASELINED 2026-07-11 at the decoder cutover ceremony (owner-ruled): rawler
// is the DEFAULT arm — these are the rawler-arm values (browser 06:25Z run,
// reproduced bit-identically headless at the ceremony). The pre-cutover libraw
// values (17.585759708175544 / -33.82946264471481 / 63.211494618201044 /
// 0.8599647876940651 / 55) remain reachable on the COLD PATH:
// VITE_DECODER_RAWLER=0.
const SACRED = {
    ra_hours: 17.595604137818327,
    dec_degrees: -33.77250521875224,
    pixel_scale: 63.439401949684004,
    confidence: 0.6785197423205406,
    matched: 79,
} as const;

describe('tools/api headless gate — bundled CR2 blind solve (sacred numbers, exact)', () => {
    it('runs the real engine (rawler default arm) pipeline in Node and reproduces the browser blind solve EXACTLY', async () => {
        expect(fs.existsSync(CR2_PATH), `bundled CR2 missing at ${CR2_PATH} (local-only asset)`).toBe(true);

        const buf = fs.readFileSync(CR2_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        // No overrides — mirror the browser wizard's CR2 flow (EXIF time, default GPS).
        const { receipt, events, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

        // Log the ACTUAL Node values FIRST so the field-by-field comparison table
        // is captured even if an assertion below throws (divergence diagnosis).
        const s = receipt.solution;
        // eslint-disable-next-line no-console
        console.log('[cr2-headless] receipt.version=%s\n' +
            '  ra_hours     node=%s  sacred=%s\n' +
            '  dec_degrees  node=%s  sacred=%s\n' +
            '  pixel_scale  node=%s  sacred=%s\n' +
            '  confidence   node=%s  sacred=%s\n' +
            '  stars_matched node=%s  sacred=%s\n' +
            '  session.matched_stars.length=%s  session.scaleLock=%s',
            receipt.version,
            s?.ra_hours, SACRED.ra_hours,
            s?.dec_degrees, SACRED.dec_degrees,
            s?.pixel_scale, SACRED.pixel_scale,
            s?.confidence, SACRED.confidence,
            s?.stars_matched, SACRED.matched,
            session.solution?.matched_stars?.length, session.scaleLock);
        // eslint-disable-next-line no-console
        console.log('[cr2-headless] confirm_status=%j', receipt.confirm_status);

        // [SAFETY CATCHER · schema 2.10.0] The DERIVED confirmation verdict.
        // REBASELINED at the 2026-07-11 cutover: the rawler arm's denser detection
        // yields enough forced targets to clear confirmForcedSet's N<10 floor, so the
        // bundled CR2 is now genuinely CONFIRMED (the libraw arm's 8-target
        // INSUFFICIENT_TARGETS verdict remains the cold-path behavior). Pure
        // classification of the already-computed deep_confirmed.
        // 2.13.0: additive top-level `pipeline_provenance` block (decoder_arm + atlas
        // identity). Pure provenance surfacing — every sacred SOLVE number stays IEEE
        // bit-identical.
        // 2.14.0: additive rawler_calibration + user_target_hint + nebulosity_layer
        // blocks (task #11, merged 2026-07-12). Enumerated rebaseline — SOLVE pins
        // unchanged (battery #4: RA/scale/matched byte-identical across the bump).
        // 2.15.0: additive star-data correction cells (①–⑥, all default-OFF/inert):
        // rawler_calibration.black_level_applied, spcc.vignette/extinction,
        // psf_attribution.refraction.chromaticDispersion/sky_deprojected/centroids.
        // SOLVE pins byte-identical (the cells never touch the solve/WCS/gates).
        // 2.16.0: additive top-level `compute_routes` block (loud compute-route
        // observability). This blind rawler CR2 headless solve stamps demosaic=skipped
        // (pre_demosaiced_rawler — rawler decodes straight to RGB) + preview=skipped
        // (previews_disabled, headless I1.2). Pure diagnostic — SOLVE pins byte-
        // identical. (Worktree branched at 2.15.0; version reconciles at merge.)
        expect(receipt.version).toBe('2.20.0');
        // [COMPUTE-ROUTE OBSERVABILITY · 2.16.0] The invisible seam-skips are now loud.
        expect(Array.isArray(receipt.compute_routes)).toBe(true);
        expect(receipt.compute_routes).toEqual([
            { seam: 'demosaic', route: 'skipped', reason: 'pre_demosaiced_rawler' },
            { seam: 'preview', route: 'skipped', reason: 'previews_disabled' },
        ]);
        // [PROVENANCE · 2.13.0] The bundled CR2 is a RAW DSLR frame decoded on the
        // DEFAULT arm → pipeline_provenance.decoder_arm='rawler'; atlas_id is the
        // committed LAW-7 golden fingerprint (never null on-box).
        expect(receipt.pipeline_provenance).not.toBeNull();
        expect(receipt.pipeline_provenance.decoder_arm).toBe('rawler');
        expect(typeof receipt.pipeline_provenance.atlas_id).toBe('string');
        // [PROVENANCE · 2.11.0] The bundled CR2 is a blind DSLR solve — no FITS-header
        // pointing, no trusted GPS/clock, no user target hint → the search ran BLIND
        // → solved_via='blind'. A clean solve (no earlier recovered attempt) →
        // failed_attempts ABSENT. Proves the new field on the blind Node path too.
        expect(receipt.solve_provenance).not.toBeNull();
        expect(receipt.solve_provenance.solved_via).toBe('blind');
        expect('failed_attempts' in receipt.solve_provenance).toBe(false);
        expect(receipt.confirm_status.status).toBe('REFUSED');
        expect(receipt.confirm_status.nTargets).toBe(36);
        expect(receipt.confirm_status.confirmed).toBe(0);
        expect(receipt.confirm_status.setExcessZ).toBe(25.59);
        expect(receipt.confirm_status.setGateZ).toBe(15);
        // 2.17.0 gate authority: BY step-up decides (probe 2026-07-22: BY 28/46 —
        // the small-N frame confirms MORE strongly under FDR than under z=15).
        expect(receipt.confirm_status.gate_authority).toBe('FDR_BY');
        expect(receipt.confirm_status.n_confirmed_fdr).toBe(0);
        expect(receipt.confirm_status.fdr_q).toBe(0.05);

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

        // 2.20.0: additive top-level `final_astrometry` block — the step-6 TERMINAL
        // data-fidelity refit (a SECOND, provenance-tagged WCS). A PRODUCT: never
        // overwrites the solve WCS / feeds confirm, so every SACRED SOLVE number above
        // stays IEEE bit-identical. This CR2 carries DEFAULT GPS (no site claim), so
        // differential refraction is HONEST-SKIPPED; the SNR-weighted refit still
        // lowers the WEIGHTED RMS (602.9→473.2") on the wide, distorted DSLR field.
        const fa = receipt.final_astrometry;
        expect(fa).not.toBeNull();
        expect(fa.provenance).toBe('REFINED_FINAL_ASTROMETRY');
        expect(fa.ledger).toBe('COORDINATE');
        expect(fa.grid).toBe('SCIENCE_NATIVE');
        expect(fa.n_stars).toBe(56);
        expect(fa.n_psf_centroids).toBe(51);
        expect(fa.psf_centroid_source).toBe('WASM_LM_GAUSSIAN');
        expect(fa.sip_order).toBe(3);
        expect(fa.sip).not.toBeNull();
        expect(fa.sip.a_order).toBe(3);
        // refined WCS linear terms ARE the solve's (crval HOURS ×15 == solve CRVAL1;
        // crval[0] here is the TANGENT POINT at crpix, NOT the field-centre ra_hours).
        expect(fa.wcs.crval[0] * 15).toBe(receipt.wcs.CRVAL1);
        expect(fa.wcs.crpix[0]).toBe(receipt.wcs.CRPIX1);
        expect(fa.wcs.cd[0][0]).toBe(receipt.wcs.CD1_1);
        // exact refined-fit evidence (deterministic — no wall-clock enters the fit).
        expect(fa.rms.linearArcsec).toBe(624.45426);
        expect(fa.rms.refinedArcsec).toBe(609.25103);
        expect(fa.rms.weightedLinearArcsec).toBe(602.89414);
        expect(fa.rms.weightedRefinedArcsec).toBe(473.20948);
        expect(fa.rms.solveMeanResidualArcsec).toBe(645.23006);
        expect(fa.improved).toBe(true);
        expect(fa.weighting.method).toBe('PSF_AMPLITUDE');
        // differential refraction HONEST-SKIPPED — CR2 carries DEFAULT/absent GPS.
        expect(fa.refraction.applied).toBe(false);
        expect(fa.refraction.tier).toBe('NOT_MEASURED');
        expect(fa.refraction.notApplied).toMatch(/GPS/);

        // ── Event stream: consumable headless ──
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

        // ── [SCHEMA A · inc 3] per-star 2D residual vectors (UW/TS verify path) ──
        // The UW verifier matches in pixel space, so the vector is the EXACT signed
        // components of the accepted distance: residual_arcsec = hypot(dx,dy)·safeScale
        // by construction. Assert (a) the shared-scale invariant (residual/hypot is one
        // constant across all UW stars = safeScale) and (c) the exact CD-derivation.
        {
            const cd = receipt.wcs;
            const ms = receipt.solution.matched_stars as any[];
            const vecStars = ms.filter((m) => m.dx_px != null && Math.hypot(m.dx_px, m.dy_px) > 1e-9);
            expect(vecStars.length).toBeGreaterThan(0);
            const ratio0 = vecStars[0].residual_arcsec / Math.hypot(vecStars[0].dx_px, vecStars[0].dy_px);
            for (const m of vecStars) {
                // (a) hypot(dx,dy)·safeScale === residual_arcsec ⇒ ratio is a shared constant.
                const ratio = m.residual_arcsec / Math.hypot(m.dx_px, m.dy_px);
                expect(Math.abs(ratio - ratio0)).toBeLessThan(1e-6 * ratio0);
                // (c) dRA/dDec are EXACTLY the fitted-CD image of (dx,dy) — parity via CD.
                const dRA = (cd.CD1_1 * m.dx_px + cd.CD1_2 * m.dy_px) * 3600;
                const dDec = (cd.CD2_1 * m.dx_px + cd.CD2_2 * m.dy_px) * 3600;
                expect(Math.abs(dRA - m.dRA_arcsec)).toBeLessThan(1e-9);
                expect(Math.abs(dDec - m.dDec_arcsec)).toBeLessThan(1e-9);
            }
            // The shared UW scale reconstructs the reported pixel_scale (sanity, ~0.5%).
            expect(Math.abs(ratio0 - receipt.solution.pixel_scale)).toBeLessThan(0.005 * receipt.solution.pixel_scale);
        }

        // ── Headless contract: no browser preview artifacts were produced ──
        expect(session.previewUrl).toBeNull();
    });
});
