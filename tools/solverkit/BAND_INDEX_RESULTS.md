<!-- LEDGER · solverkit lost-in-space band-index incubator · measured numbers -->
# Per-scale-band quad-hash index — architecture + measured recovery

**Incubator (CLAUDE.md LAW 4): `tools/solverkit/` only. No `src/`, no engine wiring,
no Rust. Nothing here touches the wizard/auto path.** This is the lost-in-space
(blind, no-anchor, no-hint) plate solver for the **FL ≤ 35 mm DSLR class** — the CR2
gauntlet class the anchored-sweep needs a bright anchor to reach. All numbers below
are MEASURED and byte-reproducible (fixed catalog + seeded validators). A miss is a
miss; a false positive is reported as one.

## Why bands (the lesson d482c09 paid for)
The prior unmerged prototype (`d482c09`) proved a **single multi-scale index floods**:
the 4-star geometric hash (Lang/Hogg/Mierle/Blanton/Roweis 2010, astrometry.net) is
scale-invariant *by construction*, so a 3° quad and a 40° quad of the same shape land
in the same bucket. One table ⇒ a lookup returns a haystack the verifier can't afford.
**Fix: split the index into scale bands by quad angular diameter.** Each band is a
small, scale-coherent table; the solver only queries the band(s) a detection quad's
pixel size can occupy under the plate-scale prior. (The log-odds gate itself already
works — d482c09 showed it rejecting a 7.4σ decoy — so the architecture, not the gate,
was the failure.)

## Band design (from FOV math)
Target FL 14–35 mm on the bundled-CR2 sensor (5202×3464):
| FL | plate scale | FOV (h×v) | quads used |
|---|---|---|---|
| 14 mm | 63.35"/px | 91.5°×61° | 6–40° (7–44% of field) |
| 35 mm | 25.34"/px | 36.6°×24.4° | 3–24° (8–66% of field) |

⇒ default **band edges [3, 6, 12, 24, 45]°** (quad angular diameter) span "a few % …
~half the field" across the whole FL 14–35 mm range. Plate-scale prior for the solve:
**20–70"/px**. Override both with `--bands` / `--scaleMin/--scaleMax`.

## Catalog + index size (measured)
Catalog = all-sky **bright** set (`loadBrightAtlas`, level_1+level_2 Gaia, ra DEGREES),
**mag-capped ≤ 6** BEFORE quad enumeration (bounds the C(n,4) blow-up; these are the
stars a wide DSLR sub actually detects — the sacred CR2 matched 55 at mag≤6, so a
deeper catalog only adds unmatchable quads). d482c09's mag≤9 single-index = 59 MB for
reference. Measured `build_band_index.mjs` (default budget, **6.8 s build**):

| band | diam (deg) | nQuads | file |
|---|---|---|---|
| B0 | [3, 6)  | 49,776  | 3.72 MB |
| B1 | [6, 12) | 149,360 | 11.13 MB |
| B2 | [12, 24)| 173,586 | 12.83 MB |
| B3 | [24, 45)| 177,193 | 12.92 MB |
| **total** | | **549,915** | **~40.6 MB** (+ stars.json 0.11 MB) |

4502 bright stars; bounded AB(widest-pair)+interior enumeration (neighbors=10,
interior=6, quadsPerPair=4); no band hit its cap. Serialized to
`test_results/solverkit_index/` (gitignored). Rebuild: `node build_band_index.mjs`.

## The solve loop (`lost_in_space.mjs`)
detections → detection quads (**both parities swept**, never asserted) → per-band
hash lookup (correspondence-preserving canonical code — verified permutation/
similarity-invariant, mirror-sensitive, vertex-order-preserved) → 4-pt affine →
**full-geometry cluster vote** (pointing+scale+rotation+parity; ≥2 votes = ≥2
independent quads = ≥8 co-aligned stars) → compose **RANSAC refine → bayesian log-odds
ACCEPT**. Both of main's validators are reused verbatim; **acceptance requires BOTH
independent nulls (RANSAC σ≥5 AND bayes σ≥5 & logL>τ & hard≥8).**

### The dual gate is load-bearing (a caught false positive)
Bayes-alone accepted the bundled CR2 at **RA 3.68h / 27.9"/px, σ=6.5** — a dense-field
(2227 detections) chance alignment at the WRONG sky/scale. RANSAC independently scored
that same candidate **σ=0.6 (reject)**. ANDing the two nulls kills it. On IMG_1410 the
same split recurs (bayes σ=15.2, RANSAC σ=2.3 → held). This is CLAUDE.md LAW 2 in
action: two independent chance-nulls is *more* evidence, not a lowered gate.

## Measured recovery — synthetic injection sweep (the oracle)
`synthetic_inject.injectFrame` renders a distortion-free (linear CD) frame from a known
WCS; `lost_in_space` solves it blind; recovery scored by `wcsAgreementDeg`. **NO anchor
injected** (the honest no-anchor class). `recovered` ⇔ both gates accept AND corner
agreement < 0.5°. "region-correct" = accepted + scale within 8% + agreement < 2°.

`node eval_bands.mjs --synthetic --fast` (4 trials/scale = rot × 2 parities × 2 seeds,
4 sky centers cycled; distortion-free injection):

| plate scale | FOV | band regime | region-correct | strict-recovered (<0.5°) | median agreement |
|---|---|---|---|---|---|
| 30"/px | ≈42° | B0/B1 | **4/4** | 1/4 | 1.08° |
| 45"/px | ≈63° | B2 | 2/4 | 0/4 | 2.05° |
| 63"/px | ≈88° | B2/B3 | 1/4 | 0/4 | 2.94° |

Single-trial spot checks confirm the mechanism cleanly: `[180,10] s30 rot40 p+` →
recovered, agree **0.18°**, both gates (bayes 70 / RANSAC 31); `[80,20] s45 rot20 **p−1**`
→ recovered, agree 1.47° (**parity sweep works**); `[259.6,−22.5] s63 rot156` → accepted
but agree 3.21° (wide-field precision loss).

**Reading:** the index reliably finds the **correct sky region** at narrow/medium FOV
(B0/B1, region-correct 4/4) and **degrades toward ultra-wide** (2/4 at 63°, 1/4 at 88°).
**Strict sub-0.5° corner precision is rare — by construction, not by bug:** a frame is
one big TAN and index quads are coded in a gnomonic plane about their own centroid, so
for large (12–45°) quads spanning a 60–90° field the projections diverge and the
recovered *linear* WCS is a global compromise (right region, 1–3° corner precision on a
40–90° field). Real 14 mm barrel distortion (absent from the synthetic) compounds this
on the wide end. `region-correct` (accepted + scale within 8% + agreement < 2°) is the
honest "found the sky" measure; strict `<0.5°` is a wide-field *linear-WCS* precision
ceiling that a distortion/SIP refit is designed to lift.

## CR2 known-answer control (blind)
`node eval_bands.mjs --cr2` — bundled `sample_observation` (sacred e2e = 63.211"/px,
RA 17.5858h), solved with **no hint**:

- **Verdict: does NOT crack the blind CR2. No false positive** (`accepted=false`).
- Wall time **31.9 s**. Best rejected candidate: RA 5.70h / 54.7"/px, bayes σ=3.8 /
  RANSAC σ=−0.2. The truth region (RA 17.6h, scale 63.35) drew only a **single-vote**
  cluster at the wrong scale (25.5"/px) — i.e. the true large-quad geometry was **not
  matched**, consistent with the wide-field (91° FOV) + 14 mm barrel-distortion limit
  the synthetic sweep isolates. Honest: the bright-star band index is not sufficient
  for the 14 mm ultra-wide frame.

## Gauntlet — blind crack-rate (ZERO gate-tuning)
`node eval_bands.mjs --gauntlet`:

| frame | nDet | verdict |
|---|---|---|
| sample_observation (14 mm CR2) | 2227 | no-crack (best bσ=3.8 / rσ=−0.2) |
| IMG_1410 (CLEAN)  | 2023 | no-crack (bσ=15.2 / **rσ=2.3** — dual gate held) |
| IMG_1414 (CLEAN)  |  835 | no-crack (bσ=6.0 / rσ=1.0) |
| IMG_1653 (FOREGROUND) | 907 | no-crack (bσ=2.1) |
| **IMG_1757 (NOISY/Altair)** | 4768 | **SOLVE** — RA 19.70h / dec +22.7 / 56.5"/px, **bayes σ=18.2 (381★) AND RANSAC σ=5.9 (254★)** |
| CSM30803_5DMkIII (5D3) | 17226 | no-crack (bσ=4.0 / rσ=1.3) — physics-limited, expected |

**1/6 cracked blind.** The pattern is **bright-detection density, not the anchored-
sweep CLEAN/NOISY labels**: IMG_1757 (densest, 4768 det) is the crack; the sparser
CLEAN frames and the distortion-heavy bundled CR2 are not. The 5D3 honestly no-cracks
(thermal-limited, index-independent — as documented).

### IMG_1757 — blind crack, ✅ **ORACLE-CONFIRMED TRUE_POSITIVE (2026-07-09)**
RA 19.70h is consistent with the Altair field (Altair RA 19.85h, in-frame); **254–381
stars co-align across two independent chance-nulls**, and the result is deterministic.
**Adjudicated same night against astrometry.net** (WSL, lite cfg, hinted ±15°):
oracle SOLVED — index-4115, log-odds **23.74**, 37 quad matches, frame center
**RA 19.0293h / Dec +2.77°, 60.25″/px** (53.2°×74.1° field, parity neg, rot −136.3°).
The oracle located the true center **11.73° from the hint point** (not a rubber-stamp);
the candidate's 11.7° center offset is the documented CR2 **anchor-vs-frame-center
convention** (candidate center bbox-confirmed inside the oracle frame); **scale agrees
to −6.2%** — strong for a barrel-distorted 14 mm where global pixscale is only a mean.
Artifacts: `test_results/solverkit_adjudication/IMG_1757.*`. **Gauntlet: 0/6 → 1/6.**
(This is a frame the anchored-sweep MISSED — README gauntlet: IMG_1757 miss +3.8σ —
cracked by the per-band lost-in-space mechanism, not by anchor tuning.)

## What's needed before any engine-rung proposal
1. **Wide-field precision (the CR2 blocker).** A quad lock must be followed by a
   **distortion/SIP refit + re-verify** (the app's residual_analyzer already does SIP);
   a global linear affine cannot model a 90° TAN + 14 mm barrel. Until then the index
   owns the **narrow/medium** FOV, not the 14 mm ultra-wide.
2. **Oracle adjudication** of IMG_1757 (and any future crack) via astrometry.net before
   it counts — the standing truth-loop, not a self-referential σ.
3. **Coverage vs FPR sweep.** The index budget (neighbors/interior/quadsPerPair) trades
   recall against table size and false-collision load; not yet swept to a measured knee.
4. **A standing gauntlet fixture** with truth labels so crack-rate is a tracked number,
   not a one-shot.

Nothing here clears the contract.mjs evidence-gate-to-client bar yet (byte-reproducible
✓, dual-null σ≥5 ✓, but no oracle confirmation and no wide-field precision). It stays in
the incubator.

## Post-lock refit (`post_lock_refit.mjs`, opt-in `lost_in_space.mjs --refit`)
Follow-up #1 above, built and MEASURED. Turns a region lock into a precision solve by
fitting linear WCS + radial Brown-Conrady, then RE-VERIFYING through the **unchanged**
dual-null gate. COORDINATE ledger only (star/detection positions, distortion-as-
functions; no pixel resample). The radial-fit math is adapted from
`tools/psf/refit_distortion.mjs` (engine port: `m2_hardware/lens_distortion_refit.ts`);
`corrections.mjs makeBrownConrady` is reused for the k1/k2 apply/undistort.

**Method (the four traps this had to clear, all measured):**
1. **Frame-centre tangent.** The lock's `crval` is the winning quad centroid — e.g.
   IMG_1757 22° from the true frame centre (the "anchor-vs-frame-centre convention").
   Re-project the seed at pixel (cx,cy) so the gnomonic origin is the frame centre.
2. **Fixed base + folded absorbers.** A 14 mm plate scale VARIES with radius (IMG_1757:
   60.25″/px centre vs 56.5″/px field-mean). A free affine re-fit each pass collapses
   the CD to the mean and k1 (=0 at r=0) can never move the centre. So the base WCS is
   held FIXED and a joint `[tx,ty,rot,a,k1,k2]` fit carries the correction; the linear
   absorbers are then FOLDED into the CD (`CD'=CD·M⁻¹`) so it reports the CENTRE scale.
3. **Chance-rejected anchors, not positional re-matching.** At 56″/px with 4768
   detections the field is dense: a loose positional net is chance-dominated and drives
   k1/k2 into runaway (measured: k1→−0.18 fitting noise). The model is fit ONLY from
   chance-REJECTED correspondences — the lock's quad pairs ∪ the RANSAC-consensus
   centre+mid stars harvested from the validated seed WCS. (The blind lock alone yields
   just **7 distinct pairs in a thin ru 0.36–0.52 annulus** — no centre, no corner
   leverage; the harvest adds the coverage, e.g. IMG_1757 → 246 anchors, rMax 1.05.)
4. **Gate byte-unchanged.** Re-verify feeds the verbatim validators the refined LINEAR
   WCS + detections UNDISTORTED by the fitted k1/k2 (a coordinate transform of
   centroids). The fit's net/anchor tolerances are documented MECHANICS, never gates.

**IMG_1757 — the payoff (oracle GOLD: RA 285.4394°, Dec +2.7719°, 60.25″/px):**
| | frame-centre sep vs oracle | scale err | dual-null re-verify |
|---|---|---|---|
| lock (pre-refit) | **2.149°** | −6.55% | bayes σ18.2 / ransac σ5.9 (the lock accept) |
| **+ refit** | **0.872°** (2.5× tighter) | **−3.91%** | bayes **σ31.9** (478★, +13.7σ) / ransac σ3.2 |

The refit tightens the pointing 2.5× and lifts bayes-σ 18→32 (478 stars co-aligned after
the distortion correction, vs ~110 before) — the mechanism works. It does NOT re-clear
the FULL dual gate: the RANSAC arm (a LINEAR-consensus null at 12 px) stays σ3.2 because
a single k1/k2 (fitted `k1=−0.146, k2=+0.013`, centre scale 56.5→57.9″/px) leaves a
**~14 px residual** — part real higher-order/decentering barrel, part anchor-position
quality (harvest tol 12 px). Honest: a precision GAIN, not a re-accept.

**CR2 known-answer control (RA 17.5858h, 63.211″/px) — still does NOT crack:**
Blind, the lock's best is **132° off** (wrong region) and the true region draws only a
single-vote cluster at the WRONG scale (25.5 vs 63.2). Seeded from that wrong-region
best, the refit stays 132° off AND does **not** false-accept — the dual gate holds
(ransac σ0.5). The anchored-sweep's cheap top candidate seeds Saturn (18° off, z3.5),
also not the true region. **The residual physics is PRE-lock:** the 14 mm barrel keeps
the true large-quad geometry out of the scale-invariant hash match, so no seed lands on
truth — a post-lock refit cannot manufacture the missing lock. (Confirms follow-up #1's
framing: the refit owns PRECISION-given-a-lock, not the wide-field BLIND-LOCK itself.)

**Gauntlet `--refit` (zero gate-tuning) — no new cracks, refit is precision-only:**
Default verdicts BYTE-IDENTICAL to the table above (bσ 3.8/15.2/6.0/2.1/18.2/4.0,
1/6 cracked). With `--refit`: IMG_1757 (the only lock) → Δbayesσ **+13.7**; the 5
non-locks all refit from their REJECTED best and all **reject** (ransac σ0.5–3.7, none
clear the dual gate; Δbayesσ ≤0 on the wrong-region seeds). The refit never becomes a
new accept path — exactly the required behaviour.

**Iteration/convergence:** with a fixed base the anchors-only fit converges in ONE pass
(re-projecting static anchors under the updated model is identity); the ≤3-iteration
loop is retained for the coverage-gated term escalation. **What still blocks the RANSAC
arm on IMG_1757:** re-harvesting anchors under the improved model (tighter tol → sub-14px
residual) is the untried lever to close σ3.2→≥5 — deferred. 5D3 stays thermal-limited
(refit garbage from its wrong-region seed, correctly rejected).

## Files
- `post_lock_refit.mjs` — post-lock distortion/SIP refit + gate-unchanged re-verify (`postLockRefit(frame, seedWcs, {seedCorr, truth})`); CLI `--seed lock|anchored|<ra,dec,scale,rot,parity>`.
- `band_hash.mjs` — shared Lang-2010 code + bucket quantiser + SkyGrid (builder+solver).
- `build_band_index.mjs` — per-band index builder (`--mag --bands --neighbors …`).
- `lost_in_space.mjs` — blind solve loop + `lostInSpaceSolve(frame, index, opts)` export.
- `eval_bands.mjs` — `--synthetic [--fast] | --cr2 | --gauntlet`.
