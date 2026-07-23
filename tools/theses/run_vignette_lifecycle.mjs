// One-shot CSL lifecycle driver for DRAFT-vignette-ruler (mirrors pdgp template):
//   lint(assert ACCEPT) -> register(0.1.0 file) -> annotate(provenance,
//   submitter_class=AI-RESEARCHER, 0.2.0 additive) -> stamp(RUNNING) ->
//   [measurement already run: vignette_ruler.mjs] -> annotate(deviations) ->
//   stamp(FAIL). Append-only; integrity-chained. Zero src/ touch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register, annotate, stamp, get } from './registry.mjs';
import { lintThesis } from './thesis_lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BY = 'test-runner (measurer, Opus)';
const AUTH = 'orchestrator (INLINE-2 streaming task)';
const ID = 'DRAFT-vignette-ruler';

const draft = JSON.parse(fs.readFileSync(path.join(ROOT, 'test_results', 'theses', 'drafts', `${ID}.json`), 'utf8'));
const meas = JSON.parse(fs.readFileSync(path.join(ROOT, 'test_results', 'theses', 'vignette_ruler', 'vignette_measurement.json'), 'utf8'));

// 1. lint gate
const lint = lintThesis(draft);
console.log('LINT', lint.verdict, 'reasons:', lint.reasons.length, 'warnings:', lint.warnings.length);
if (lint.verdict !== 'ACCEPT') { console.error('LINT NOT ACCEPT — abort'); process.exit(1); }

// 2. register (idempotent-guard)
let entry = get(ID);
if (!entry) { entry = register(draft); console.log('REGISTER minted', entry.id, entry.sha256.slice(0, 12), 'integrity', entry.integrity.ok); }
else console.log('REGISTER already present', entry.sha256.slice(0, 12));

// 3. provenance annotation (submitter_class, 0.2.0 additive)
annotate({ id: ID, annotation_type: 'provenance', fields: { submitter_class: 'AI-RESEARCHER' },
    note: 'AI-RESEARCHER thesis (novel-hinter round, ranks S3+O1 merged = Rank 2). AI submissions never pool with HUMAN (base-rate integrity). INLINE-2, run LAST of tonight (Q-fit build-inclusive).',
    by: BY, authorized_by: AUTH });

// 4. RUNNING
stamp({ id: ID, status: 'RUNNING', by: BY,
    evidence_pointer: 'tools/theses/vignette_ruler.mjs (frozen P1-P6; BUILT the k2/k4 two-term radial fit + Q=|k4|/(|k2|+|k4|) shape arm that did not exist — shipped solver is single r^2, optics_manager.ts:390-404). Cocoon V from master_flat.bin (rig vignette, F7-correlated); wide V from IMG_1653.detplane.f32 (raw-light background falloff).' });

// 5. deviations annotation
const dev = [
  'D1 COCOON V from the FLAT MASTER (master_flat.bin, rig vignette), NOT per-frame light backgrounds: ONE correlated V=0.9033 for all 12 L_ frames (F7 correlated-sample caveat, n_eff=1). Cleanest vignette channel (no additive sky pedestal). s_max=17.485"/px => P1 Cocoon-half OK (>=2.0067) AND P2 OK (<72.77, ~4x margin). Criterion-neutral: P2 was pre-registered WITH the F7 correlated caveat; 12/12 is 1 rig measurement, not 12 independent trials.',
  'D2 KILL MECHANISM — WIDE V from IMG_1653 RAW-LIGHT background (no Rokinon flat exists): V=0.6517 measured corner/center on the raw light. The additive sky/airglow pedestal FLATTENS the ratio vs the true optical cos^4 vignette (a 14mm@corner~44deg optic would give V~0.27), so theta_max=acos(0.6517^(1/3))=29.9deg is UNDER-estimated => f_min=23.39mm OVER-estimated => s_max=37.94"/px UNDER-estimated => BELOW the 63.211"/px truth => TRUTH EVICTED. Falsifies the thesis reasoning_mechanism claim "cannot evict truth on uncalibrated raw input ... 2-3x margin". Profiles are clean monotonic radial falloffs (verified) — real physics, not a measurement bug. UN-ANTICIPATED failure mode: the F6 abstain guard covers flat-corrected frames, NOT sky-pedestal flattening of raw ultra-wide lights.',
  'D3 sample_observation V is SIBLING-DERIVED from IMG_1653 (identical Rokinon 14mm prime; NO decoded plane exists for it) — NOT-INDEPENDENT. Both wide frames evict truth identically. Verdict-robust: even counting ONLY IMG_1653 as the independent wide, P1 = 13/14 still trips the hard 14/14 gate + kill clause.',
  'D4 Q classifier threshold Q_anchor=0.1916 DERIVED from a cos^4 physics model at a 25deg reference field angle (NOT tuned to the measured data; disclosed instrument choice). Wide IMG_1653 Q=0.1974 clears it MARGINALLY; Cocoon flat Q=0.2362 but k4<0 (wrong cos^4 sign) => correctly NOT lens-natural. P4 (0 LENS_NATURAL on Cocoon) OK; P5 (wide LENS_NATURAL, FL_inv=23.39mm in [7,28]) OK AS WRITTEN — but FL_inv=23.39mm is a 67% OVERESTIMATE of the true 14mm, biased HIGH by the SAME sky-flattening that kills P1. P5 passes the frozen band but the number is not trustworthy; APPROXIMATE label mandatory (thesis O1 arm).',
  'D5 pitch = 4.302um RIG_TRUTH (Canon APS-C 22.3x14.9mm / 5184px), sensor half-diagonal d_c = 13.44mm. Census EXIF is the LYING trap (FL=50, lens="Unknown Lens" truthy placeholder, pixel_pitch_um=null) — NOT used. s_true: Cocoon 2.0067"/px MEASURED (nova crosscal L_0020; DERIVED RIG_TRUTH 2.06 agrees), wide 63.211"/px MEASURED (sacred blind CR2 solve). Instrument inputs, not criteria.',
  'D6 P3 negative control operationalized as flat/flat = uniform (V=1 by construction, the definitional flat-corrected frame). Guards-off: V=1 => theta_max=0 => f_min=inf => s_max->0 < s_true => EVICTION. Guards-on: V>=0.97 => ABSTAIN => no eviction. Guard proven LOAD-BEARING (P3 OK). A real calibrated/in-camera-PIC light behaves identically (vignette removed).',
  'D7 P6(ii) wrong-hint arm operationalized STRUCTURALLY (same class as sibling theses): the ruler is REJECT-ONLY (an upper bound) and touches NOTHING in the solver — it has no accept path, and the frozen acceptance gate is UNTOUCHED. 2x/0.5x s_true wrong hints => 0 false accepts by construction; the over-scale 2x hint is ACTIVELY rejected on the wide frames (2x63.211=126.4 > s_max=37.94). Live-solve confirmation deferred (nothing wired live). P6(i): ZERO src/ touch => sacreds structurally byte-identical; cite same-HEAD battery @62a6c14.',
  'D8 INTERPRETIVE (not a criterion change) — DISTINCT from the three sibling FAILs tonight (density-bracket, wide-fov, pdgp), which converged on "correct-but-INERT search priors on a PRE-LOCK matching bottleneck". The vignette ruler is NOT a search prior; it is a reject-only scale-upper-bound falsifier. On the COCOON mislock target it WORKS: s_max=17.485 excludes the 72.77 mislock with ~4x margin (P2) while containing the 2.0067 truth (P1 Cocoon-half). The failure is a DIFFERENT branch: the tool KILLS on its OWN core safety promise (truth-containment BY CONSTRUCTION) on the ultra-wide DSLR class — exactly the frame class the solver frontier cares about — because a raw ultra-wide light has no flat and its sky-pedestal-flattened background falloff is not the optical vignette the never-evict-truth construction assumes. Honest read: the primary bound is safe on scope-class flats, UNSAFE (truth-evicting) on ultra-wide raw lights; the secondary shape arm classifies direction correctly but its FL number inherits the same bias.',
];
annotate({ id: ID, annotation_type: 'deviations', fields: { deviations: dev, count: dev.length },
    note: 'Deviations + interpretive findings from the frozen DRAFT-vignette-ruler run. NO P-criterion reinterpreted; verdict scored on the frozen P1-P6 + kill clause. Q classifier threshold is a disclosed physics-anchored instrument choice, not a tuned gate.',
    by: BY, authorized_by: AUTH });

// 6. FAIL (kill-clause tripped: truth eviction)
const s = meas.scores;
const ev = `test_results/theses/vignette_ruler/vignette_measurement.json; tool tools/theses/vignette_ruler.mjs. VERDICT=FAIL (KILL — kill-clause member tripped: s_max<s_true truth eviction). `
 + `PASSES: P2 mislock-excluded (Cocoon s_max=17.485 < 72.77, ~4x margin; 12/12 but F7-CORRELATED n_eff=1, one rig flat V); P3 negative control (abstain guard load-bearing: flat-corrected V=1 => guards-off evicts, guard removes); P4 class-specificity (0 LENS_NATURAL on Cocoon; flat Q=0.2362 but k4<0 wrong cos^4 sign); P5 class-sensitivity (IMG_1653 LENS_NATURAL, FL_inv=23.39mm in [7,28] — but 67% biased high, see D4); P6 non-interference ((i) 0 src/ touch, sacreds structurally byte-identical @62a6c14; (ii) reject-only ruler + untouched gate => 0 false accepts, 2x actively rejected). `
 + `FAIL/KILL ground: P1 truth-containment ${s.P1_truth_containment.pass}/14 (< 14/14 HARD gate). The two ULTRA-WIDE frames (IMG_1653 s_max=37.94, sample_observation sibling-derived) sit BELOW the 63.211"/px truth: the one-sided natural-vignetting bound, applied to a raw ultra-wide light's SKY-PEDESTAL-FLATTENED background falloff (V=0.6517 vs true optical ~0.27), is too tight and EVICTS truth — falsifying the "cannot evict truth on uncalibrated raw input" mechanism. `
 + `The Cocoon arm (V from the clean FLAT master) is sound and the mislock-rejection headline holds; the kill is the primary bound's core SAFETY promise failing on the ultra-wide DSLR class (no flat available). Distinct from the 3 sibling prior-inert FAILs: this tool WORKS on the mislock but is unsafe (truth-evicting) on wide raw lights.`;
stamp({ id: ID, status: 'FAIL', by: BY, evidence_pointer: ev });

const final = get(ID);
console.log('FINAL status', final.status, 'stamps', final.stamps.length, 'annotations', final.annotations.length,
  'integrity', final.integrity.ok, final.integrity.note);
console.log('stamps chain:', final.stamps.map((x) => `${x.status}[${x.integrity_ok ? 'ok' : 'BAD'}]`).join(' -> '));
