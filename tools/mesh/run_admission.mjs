// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — ADMISSION-CONTROLS driver (thin wrapper; LAW-4, banked data only)
// ═══════════════════════════════════════════════════════════════════════════
// Integration wrapper for the admission-controls wave. Runs the completion gate
// (legs 1+3; leg 2 = stub) + the occlusion-mask stack RETROACTIVELY on the
// banked graded sets (M66 clean / beach galactic-nightscape / IMG_1757 rotated-
// vertical nightscape), assembles the per-band operating characteristics vs the
// promotion bar, the gate OC curve (a leverage-strictness sweep), and the mask
// unmasked-false-rate validation. NOTHING feeds a solve.
//
//   node tools/mesh/run_admission.mjs

import fs from 'node:fs';
import path from 'node:path';
import { runCompletionGate } from './completion_gate.mjs';
import { buildOcclusionMask, validateMaskAgainstLabels, renderMaskOverlay } from './occlusion_mask.mjs';
import { writePNG, plotPoint, drawPolyline } from '../psf/imaging.mjs';

const OUT = 'D:/AstroLogic/test_artifacts/admission_controls_2026-07-22';
const OUT_LOCAL = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY/test_results/admission_controls_2026-07-22';
const STARS = 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/stars.arrow';
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(OUT_LOCAL, { recursive: true });

const FRAMES = [
  { frame: 'M66', klass: 'SeeStar 3.68"/px clean deep-sky (Leo Triplet)', matches: 'D:/AstroLogic/test_artifacts/mesh_finder_2026-07-22/M66_mesh_matches.json', meta: 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_capture_meta.json', buffer: 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21/m66_buffer.f32', dims: null, oracle: 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/oracle_m66/m66.wcs', densMag: 15, banked_false: '2.7% inner / 20.5% outer(.70-.85) / 18.5% (.85-1.0)' },
  { frame: 'beach', klass: 'DSLR 14mm nightscape 60.7"/px galactic-plane', matches: 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/beach_full_mesh_matches.json', meta: 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/beach_capture_meta.json', buffer: 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/beach.f32', dims: 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/beach.dims.json', oracle: 'D:/AstroLogic/test_artifacts/mesh_graduation_2026-07-22/oracle_beach/beach_t4.wcs', densMag: 10, banked_false: '64% even inner (confusion-limited)' },
  { frame: 'IMG_1757_allm10', klass: 'Canon T6 + Rokinon 14mm 60.4"/px rotated-vertical nightscape+terrain', matches: 'D:/AstroLogic/test_artifacts/mesh_gate3_2026-07-22/IMG_1757_allm10_mesh_matches.json', meta: 'D:/AstroLogic/test_artifacts/mesh_gate3_2026-07-22/IMG_1757_capture_meta.json', buffer: 'D:/AstroLogic/test_artifacts/mesh_gate3_2026-07-22/IMG_1757.f32', dims: 'D:/AstroLogic/test_artifacts/mesh_gate3_2026-07-22/IMG_1757.dims.json', oracle: 'D:/AstroLogic/test_artifacts/mesh_gate3_2026-07-22/oracle/IMG_1757_xy.wcs', densMag: 10, banked_false: '49% inner / 93% outer(.70-.85) (confusion-limited)' },
];

// promotion bar
const BAR = { outer_retention: 2 / 3, accepted_false: 0.05 };

function loadBuffer(bufPath, W, H) { const raw = fs.readFileSync(bufPath); return new Float32Array(raw.buffer, raw.byteOffset, W * H); }

const report = { campaign: 'mesh-completion admission controls (legs 1+3 + occlusion mask; leg 2 = stub)', generated: new Date().toISOString(), regime: 'ASSISTED-ORACLE labelling; gate/mask never consult the oracle; NEVER pooled with blind-solve stats', promotion_bar: BAR, frames: {} };

for (const F of FRAMES) {
  console.log(`\n═══ ${F.frame} ═══`);
  // ── gate ──
  const g = runCompletionGate({ frame: F.frame, matchesPath: F.matches, metaPath: F.meta, oracleWcsPath: F.oracle, starsPath: STARS, magLimit: 15, out: OUT });
  const oc = g.summary.operating_characteristics;
  // ── mask ──
  const meta = JSON.parse(fs.readFileSync(F.meta, 'utf8'));
  const dims = F.dims ? JSON.parse(fs.readFileSync(F.dims, 'utf8')) : null;
  const W = (dims && dims.width) || meta.width, H = (dims && dims.height) || meta.height;
  const L = loadBuffer(F.buffer, W, H);
  const mask = buildOcclusionMask({ meta, dims, L, starsPath: STARS, P: { densMagLimit: F.densMag } });
  const maskVal = validateMaskAgainstLabels(mask, g.completions, g.labels);
  renderMaskOverlay(path.join(OUT, `${F.frame}_occlusion_overlay.png`), L, mask, W, H, { completions: g.completions, labels: g.labels });
  fs.writeFileSync(path.join(OUT, `${F.frame}_occlusion_mask.json`), JSON.stringify({ frame: F.frame, ...mask.summary, mask_validation_vs_oracle: maskVal }, null, 2));
  fs.writeFileSync(path.join(OUT, `${F.frame}_occlusion_regions.json`), JSON.stringify({ frame: F.frame, n: mask.regions.length, regions: mask.regions.slice(0, 4000) }, null, 2));

  // ── promotion-bar check on the outer bands (legs 1+3, leg2 absent) ──
  const outer = oc.filter((b) => b.band !== '0.00-0.70' && b.n_labeled > 0);
  const outerMet = outer.map((b) => ({ band: b.band, retention: b.true_retention, accepted_false: b.accepted_false_rate, meets_bar: b.true_retention != null && b.true_retention >= BAR.outer_retention && b.accepted_false_rate != null && b.accepted_false_rate <= BAR.accepted_false }));
  const nOuterMet = outerMet.filter((b) => b.meets_bar).length;
  // leg-2 headroom = accepted-false above the 5% bar the FDR-existence leg must close
  const leg2Headroom = outer.map((b) => ({ band: b.band, accepted_false: b.accepted_false_rate, headroom_above_bar: b.accepted_false_rate == null ? null : +(Math.max(0, b.accepted_false_rate - BAR.accepted_false)).toFixed(3) }));

  report.frames[F.frame] = {
    class: F.klass, banked_false_labels: F.banked_false,
    gate: { image: g.summary.image, counts: g.summary.counts, decision_tally: g.summary.decision_tally, meta_pointing_err_px_median: g.summary.catalog.meta_pointing_err_px_median, operating_characteristics: oc, outer_bands_meeting_bar: `${nOuterMet}/${outer.length}`, outer_bar_detail: outerMet, leg2_headroom: leg2Headroom },
    mask: { masked_cell_fraction: mask.summary.masked_fraction, per_reason_cell_fraction: mask.summary.per_reason_fraction, validation: maskVal },
  };
  console.log(`  gate tally ${JSON.stringify(g.summary.decision_tally)}`);
  for (const b of oc) console.log(`   ${b.band}  n=${b.n} baseFalse=${b.baseline_false_rate} retain=${b.true_retention} kill=${b.false_kill} accFalse=${b.accepted_false_rate}`);
  console.log(`  mask maskedCellFrac=${mask.summary.masked_fraction} unmaskedFalse=${maskVal.false_rate_unmasked} (allFalse=${maskVal.false_rate_all}, unmaskedN=${maskVal.unmasked_n})`);
}

// ═══ OC CURVE: leverage-strictness sweep on M66 (the frame where legs 1+3 have
//     a discrimination story) — retention vs accepted-false per outer band ═══
const SWEEP = [Infinity, 1.1, 1.0, 0.9, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5];
const M66 = FRAMES[0];
const ocCurve = { frame: 'M66', knob: 'leverageRefuse (LEG-1 extrapolation/conditioning risk; planner conditioning-risk math)', bands: { '0.70-0.85': [], '0.85-1.00': [] } };
for (const lev of SWEEP) {
  const g = runCompletionGate({ frame: 'M66_sweep', matchesPath: M66.matches, metaPath: M66.meta, oracleWcsPath: M66.oracle, starsPath: STARS, magLimit: 15, P: { leverageRefuse: lev } });
  for (const b of g.summary.operating_characteristics) if (ocCurve.bands[b.band]) ocCurve.bands[b.band].push({ lev: lev === Infinity ? null : lev, retention: b.true_retention, accepted_false: b.accepted_false_rate });
}

// ── render OC curve PNG (retention Y vs accepted-false X; promotion-bar box) ──
function renderOcCurve(outPath, curve) {
  const Wd = 900, Hd = 640, m = { l: 80, r: 30, t: 60, b: 70 };
  const bytes = new Uint8Array(Wd * Hd * 3).fill(18);
  const px = (fx) => m.l + fx * (Wd - m.l - m.r); const py = (fy) => Hd - m.b - fy * (Hd - m.t - m.b);
  const axis = [200, 200, 210], grid = [55, 55, 62];
  // grid + axes (accepted-false 0..0.30, retention 0..1)
  const XMAX = 0.30;
  for (let gx = 0; gx <= 6; gx++) { const x = px(gx / 6); drawPolyline(bytes, Wd, Hd, [[x, py(0)], [x, py(1)]], grid, 0.5); }
  for (let gy = 0; gy <= 5; gy++) { const y = py(gy / 5); drawPolyline(bytes, Wd, Hd, [[px(0), y], [px(1 * XMAX / XMAX), y]], grid, 0.5); }
  drawPolyline(bytes, Wd, Hd, [[px(0), py(0)], [px(1), py(0)]], axis, 0.9);
  drawPolyline(bytes, Wd, Hd, [[px(0), py(0)], [px(0), py(1)]], axis, 0.9);
  // promotion-bar box: retention>=0.667 AND accepted_false<=0.05 (green target)
  const bx = px(BAR.accepted_false / XMAX), by = py(BAR.outer_retention);
  for (let x = m.l; x <= bx; x++) { drawPolyline(bytes, Wd, Hd, [[x, py(1)], [x, by]], [30, 80, 40], 0.35); }
  drawPolyline(bytes, Wd, Hd, [[px(0), by], [bx, by]], [80, 230, 120], 0.9);
  drawPolyline(bytes, Wd, Hd, [[bx, py(1)], [bx, by]], [80, 230, 120], 0.9);
  // series
  const colors = { '0.70-0.85': [90, 170, 255], '0.85-1.00': [255, 140, 60] };
  for (const [band, pts] of Object.entries(curve.bands)) {
    const line = pts.filter((p) => p.accepted_false != null && p.retention != null).map((p) => [px(Math.min(XMAX, p.accepted_false) / XMAX), py(p.retention)]);
    drawPolyline(bytes, Wd, Hd, line, colors[band], 0.9);
    for (const p of pts) { if (p.accepted_false == null || p.retention == null) continue; const X = px(Math.min(XMAX, p.accepted_false) / XMAX), Y = py(p.retention); for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) plotPoint(bytes, Wd, Hd, X + dx, Y + dy, colors[band], 0.95); } }
  writePNG(outPath, bytes, Wd, Hd);
}
renderOcCurve(path.join(OUT, 'M66_gate_oc_curve.png'), ocCurve);
report.oc_curve_M66 = ocCurve;
report.oc_curve_note = 'X=accepted-false-rate, Y=true-retention, per outer band, over the LEG-1 leverage-refuse sweep. Green box = promotion target (retention>=2/3 AND accepted-false<=5%). The near-VERTICAL-drop trajectory (retention collapses while accepted-false barely moves) = local geometry has NO ROC power on M66-class corner false-completions; the residual accepted-false is the LEG-2 headroom.';
report.outputs = { oc_curve_png: path.join(OUT, 'M66_gate_oc_curve.png'), overlays: FRAMES.map((f) => path.join(OUT, `${f.frame}_occlusion_overlay.png`)) };

// verdict synthesis
report.verdict = {
  legs_1_3_standalone: 'DO NOT MEET the promotion bar. On the clean frame (M66) legs 1+3 have no local-geometry ROC power on corner false-completions (measured≈local-affine-prediction by construction of the cascade; the error is a COHERENT local distortion offset invisible to consensus/residual/conditioning) — best outer accepted-false ~0.11-0.19 vs the 0.05 bar. On confusion frames (beach/IMG_1757) LEG 3 + the mask correctly flag ~99-100% of completions as occluded/crowded (honest "untrustworthy class"), leaving too few unmasked to certify.',
  what_legs_1_3_DO: 'LEG 1 rejects genuinely unsupported/extrapolated completions (robustness floor); LEG 3 + the occlusion mask remove confusion-limited/structured regions wholesale (beach 100% of completions masked, IMG_1757 99%). Unmasked false rate drops toward M66-class where any region survives (IMG_1757 0.528->0.385, n=13).',
  leg2_headroom: 'The ~11-19% residual accepted-false in the M66 outer bands is exactly the FDR-existence (LEG 2) headroom — a pixel-level per-star + set-level forced-confirm test is the only lever that can catch coherent-offset false-completions that share their neighbours\' bias. Wired post-train via leg2FdrExistence() -> forced_confirm.ts.',
};

fs.writeFileSync(path.join(OUT, 'ADMISSION_CONTROLS_REPORT.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT_LOCAL, 'ADMISSION_CONTROLS_REPORT.json'), JSON.stringify(report, null, 2));
console.log('\n★ wrote', path.join(OUT, 'ADMISSION_CONTROLS_REPORT.json'));
console.log('★ wrote', path.join(OUT_LOCAL, 'ADMISSION_CONTROLS_REPORT.json'));
console.log('★ OC curve', path.join(OUT, 'M66_gate_oc_curve.png'));
