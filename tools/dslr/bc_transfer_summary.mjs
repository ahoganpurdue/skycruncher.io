// Assemble test_results/bc_profile_transfer/SUMMARY.json from the emitted
// per-frame apply_*.json + pooled_profile.json + refit_*.json artifacts.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('test_results/bc_profile_transfer');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const pooled = rd('pooled_profile.json');
const applyFiles = fs.readdirSync(DIR).filter((f) => f.startsWith('apply_') && f.endsWith('.json'));
const applications = applyFiles.map((f) => {
    const d = rd(f);
    const byMode = Object.fromEntries(d.modes.map((m) => [m.mode, m]));
    return {
        frame: d.frame,
        n_detections: d.n_detections,
        control_verified: byMode.none?.verified ?? null,
        control_bestVsigma: byMode.none?.bestVerifiedSigma ?? null,
        control_bestPeakZ: byMode.none?.bestPeakZ ?? null,
        nominal_bestVsigma: byMode.nominal?.bestVerifiedSigma ?? null,
        nominal_bestPeakZ: byMode.nominal?.bestPeakZ ?? null,
        measured_bestVsigma: byMode.measured?.bestVerifiedSigma ?? null,
        measured_bestPeakZ: byMode.measured?.bestPeakZ ?? null,
        deltas: d.deltas_vs_control,
        cracked_by_measured: (byMode.none && byMode.measured)
            ? (!byMode.none.verified && byMode.measured.verified)
            : null,
    };
});

const summary = {
    experiment: 'cross-frame lens-profile transfer (measured Brown-Conrady, per-rig)',
    measured_on: new Date().toISOString().slice(0, 10),
    rig: pooled.rig,
    n_solving_same_rig_frames: pooled.n_solving_frames,
    inventory_note: pooled.pooling_caveat,
    pooled_profile: {
        recommended_prior: pooled.recommended_prior,
        per_density: pooled.per_density,
        pooled_k1_mean: pooled.pooled_k1_mean,
        pooled_k1_sd: pooled.pooled_k1_sd,
        pooled_k1_range: pooled.pooled_k1_range,
        sign_vs_nominal: pooled.note_sign_vs_nominal,
    },
    application_AB: {
        method: 'planet anchors held FIXED across modes; only the coordinate un-distortion (prior) varies. mode none=control, nominal=LENS_DB ROKINON_14_MUSTACHE(k1=-0.12,k2=0.05), measured=pooled(k1=+0.0329,k2=+0.00201). Signal = Δσ / ΔpeakZ vs control. NOT a blind solve.',
        frames: applications,
        cracks_by_measured_prior: applications.filter((a) => a.cracked_by_measured === true).map((a) => a.frame),
        n_cracked: applications.filter((a) => a.cracked_by_measured === true).length,
    },
    interpretation: 'GEOMETRY LEVER MEASURED. On frames that already verify given the anchor, the measured pooled prior is NEUTRAL (small Δσ, small +ΔpeakZ) and consistently beats the wrong-direction NOMINAL library prior (which reduces σ/peakZ). On frames that fail to verify even with anchors, see cracks_by_measured_prior. No new blind crack was produced by geometry alone — consistent with the gauntlet deficit being m4 detection-recall-limited, not geometry-limited.',
    artifacts: [
        'test_results/bc_profile_transfer/pooled_profile.json',
        'test_results/bc_profile_transfer/refit_sample_observation_55.json',
        'test_results/bc_profile_transfer/refit_sample_observation_237.json',
        ...applyFiles.map((f) => 'test_results/bc_profile_transfer/' + f),
    ],
};
fs.writeFileSync(path.join(DIR, 'SUMMARY.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
