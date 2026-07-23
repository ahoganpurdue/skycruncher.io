# solverkit — a composable headless star-solve + consensus-verification toolchest

**Bucket 1 of the solver toolchest.** One clean home for SkyCruncher's scattered
solver weapons — the abandoned/misplaced ones resuscitated and *corrected*, plus
a new robust consensus validator — all **headless**, all reusing the **live**
primitives (WASM kernels, `tools/psf` atlas + projection helpers), all **out of
the live app/wizard workflow's way** (CLAUDE.md LAW 4, the incubator pattern).

**No app/client code is touched.** Nothing under `src/` was modified or deleted.
Where a tool here supersedes a live `src/` original, that is *documented* (below)
as a later, separately-gated removal — not done here.

Ethos (CLAUDE.md): **two ledgers** (coordinate math ≠ pixel ops), **honest-or-
absent** (every number is measured or printed `NOT MEASURED` — never a
placeholder), **gates are never lowered — evidence is added**. Deterministic /
geometric / statistical math only — **no ML** (the ONNX/MobileSAM path was
deleted deliberately).

---

## The two contracts (`contract.mjs`)

A solve is `GENERATOR → VALIDATOR`.

- **GENERATOR** `{det, cat, meta} → CandidateWCS[]` — a hypothesis maker. Cheap,
  lossy, allowed to be wrong. Every candidate is tagged with the **measured**
  evidence that produced it (sweep z, quad error, match count). An empty list is
  an honest "no hypothesis".
- **VALIDATOR** `{candidate WCS, det, cat} → {inliers, matched, sigma, score,
  refinedWcs, accepted, …}` — the skeptic. Independently re-derives consensus,
  measures it against its **own chance null**, LO-refines, and accepts **only**
  when the measured `sigma ≥ 5` and `inliers ≥ 8`.

**WCS shape** (`crval`=[raDeg,decDeg] **degrees**, `crpix`=[x,y], `cd`=deg/px):
byte-compatible with `tools/psf/forced_detect.projectStars`.

### Evidence-gate-to-client rule
A solverkit tool may be promoted into `src/` (wizard/auto path) **only** when, on
the measured `gauntlet.mjs`: (1) it produces byte-reproducible numbers
(deterministic; solverkit seeds its PRNG), (2) every accept clears
`sigma ≥ 5 & inliers ≥ 8` vs its own null, and (3) it doesn't regress the sacred
e2e (seestar byte-identical, cr2 solved). Until then it lives here.

---

## Tools

| File | Role | Status |
|---|---|---|
| `contract.mjs` | GENERATOR/VALIDATOR contracts, `GATE`, `notMeasured()` | — |
| `common.mjs` | data-root resolution, WASM init, geometry (affine fit, CD helpers), detection/catalog/FITS loaders | — |
| `ransac.mjs` | **VALIDATOR** — RANSAC++/LO-RANSAC/MAGSAC consensus fit + self-calibration | **working** |
| `bayesian_logodds.mjs` | **VALIDATOR** — astrometry.net-style Bayesian log-odds acceptor (Lang 2010) | **working** |
| `anchored_sweep.mjs` | **GENERATOR** — ultra-wide anchored rotation sweep | **working** |
| `quad.mjs` | **GENERATOR** — WASM quad-hash matcher | **working** (starved on UW by design) |
| `trilock.mjs` | resuscitated Tri-Lock **scale** solver | **working, scale-only** |
| `vector_consensus.mjs` | resuscitated Vector-Consensus (corrected) | **working, scale-only + drift** |
| `driver.mjs` | compose generator → validator, report | **working** |
| `gauntlet.mjs` | generators × validator matrix, tabulated | **working** |
| `synthetic_inject.mjs` | **ORACLE** — synthetic-frame injection/recovery (measures where the gates land on truth) | **working** |

### Run
```
node tools/solverkit/ransac.mjs --selftest          # known-answer calibration
node tools/solverkit/bayesian_logodds.mjs --selftest      # log-odds known-answer
node tools/solverkit/bayesian_logodds.mjs --discriminate  # marginal vs clean (count vs log-odds)
node tools/solverkit/driver.mjs sample_observation  # full solve of the bundled CR2
node tools/solverkit/driver.mjs IMG_1757 --bright-stars
node tools/solverkit/anchored_sweep.mjs IMG_1410 [--bright-stars]
node tools/solverkit/quad.mjs sample_observation
node tools/solverkit/trilock.mjs sample_observation
node tools/solverkit/vector_consensus.mjs sample_observation
node tools/solverkit/gauntlet.mjs [--fast]
node tools/solverkit/synthetic_inject.mjs --selftest # injection/recovery known-answer + determinism
node tools/solverkit/synthetic_inject.mjs --sweep    # the recovery map (P(recover) & sigma vs each axis)
```
Detections load from `test_results/cr2_dets/<name>.app.json`; the atlas + WASM
`pkg/` are sourced from the main deploy (self-healing `DATA_ROOT` in
`common.mjs`, override with `SOLVERKIT_DATA_ROOT`). A fresh worktree lacks
`node_modules` (not needed — the kit uses only node builtins + the WASM pkg) and
the gitignored `pkg/` (copy from main once).

---

## The centerpiece: RANSAC++ / LO-RANSAC / MAGSAC (`ransac.mjs`)

`validateWCS(candidate, det, cat, opts)`:
1. project catalog through the candidate WCS → nearest-detection **putative
   correspondences** (radius-scaled net, mirrors the app's ultra-wide net);
2. **RANSAC** minimal-sample (3-pt full affine) inlier maximization, then
   **LO-RANSAC** refit on the inlier set (shrinking tolerance);
3. score {candidate, refined} each against **its own random-orientation null**
   (a real field aligns at one orientation, a chance config at none) → measured
   `sigma`; **MAGSAC** threshold-free soft score marginalized over noise scale;
4. `accepted = sigma ≥ 5 & inliers ≥ 8`.

`validateFromCorrespondences(corr, crval, …)` seeds the same consensus from
explicit det↔catalog pairs (e.g. quad matches).

### Calibration (known-answer) — `node ransac.mjs --selftest`
Reconstruct the bundled CR2's **true** geometry (locate the aligning anchor +
orientation → Jupiter anchor, **θ≈156.25**, matching the app's solved 155.65),
then contrast with decoys:

| WCS | matched | sigma | accepted |
|---|---|---|---|
| **TRUE** (Jupiter, θ=156.25) | 92 | **+5.9σ** | **yes** |
| DECOY (θ+90°) | 34 | −0.5σ | no |
| DECOY (wrong sky center) | 114* | +2.0σ | no |

\* Note the honest subtlety: over the loose ultra-wide net a decoy can rack up a
higher **raw** matched count (114 > 92) — raw counts are **not** a discriminator.
The **null-referenced sigma is** (TRUE +5.9σ accepted; both decoys rejected;
margin 3.9σ). This is the whole reason a validator computes a null.

---

## The Bayesian log-odds acceptor (`bayesian_logodds.mjs`)

The count test asks *how many* catalog stars matched; the **log-odds** asks *how
well each landed* and *how many would land that well by chance*. Astrometry.net's
published acceptor (**Lang, Hogg, Mierle, Blanton, Roweis 2010**, AJ 139:1782,
[arXiv:0910.2233](https://arxiv.org/abs/0910.2233)) — the reason it runs unattended
at >99.9% success with zero false positives.

`bayesLogOddsValidate(candidate, det, cat, opts)` (contract.mjs VALIDATOR):
1. project catalog through the candidate WCS → predicted pixel positions;
2. per DETECTION *i*, mixture likelihood
   `L_fg(i) = (1−f)·ρ + f·Σ_c (1/2πσ²)exp(−r_ic²/2σ²)`, background `L_bg(i)=ρ=1/A`;
3. `logL = Σ_i log(L_fg(i)/L_bg(i))` — pinpoint matches weigh ≈1, grazes at 2σ ≈0.14,
   and the distractor floor `log(1−f)` **charges every un-aligned detection**, so a
   WCS predicting stars where none sit is driven negative;
4. **depth-match** (Lang): our mag≤6 catalog is far shallower than the detector, so
   only the brightest `~2.5×(catalog-in-frame)` detections are tested — the rest
   *cannot* be catalog matches and must not be charged the floor;
5. **three ANDed gates, none lowered**: `logL > τ` (decision-theoretic Bayes-factor
   threshold) **AND** `sigma ≥ 5` (logL vs the candidate's own random-orientation
   null — frame-normalized) **AND** `hard ≥ 8` (pinpoint matches, pFg>0.5).

Pure **acceptor** — it does not refit the WCS (`refinedWcs=null`); compose
`GENERATOR → ransac(refine) → bayes(accept)`.

### Calibration — `node bayesian_logodds.mjs --selftest`
Bundled CR2 TRUE geometry (anchored-sweep generator → Jupiter/Saturn solve) vs decoys:

| WCS | logL | sigma | rawCount | accepted |
|---|---|---|---|---|
| **TRUE** | **+304** | **+9.4σ** | 71 | **yes** |
| DECOY (θ+90°) | −136 | −0.1σ | 32 | no |
| DECOY (wrong sky center) | +106 | +1.7σ | 114 | no |

The **dual gate is load-bearing**: the wrong-center decoy fools *both* a raw-count
gate (114 > 71) *and* τ-alone (logL +106 > τ≈14) over the loose UW net — only its
null-referenced **sigma (+1.7)** rejects it (chance alignments are unstable under
reorientation). Deterministic: byte-identical `logL=303.8140536357182` across
separate process invocations.

### Marginal discrimination — `node bayesian_logodds.mjs --discriminate`
CLEAN `IMG_1414` vs MARGINAL `IMG_1576` (each frame's top anchored-sweep candidate):

| frame | rawCount | log-odds sigma | verdict |
|---|---|---|---|
| `IMG_1414` (clean Jupiter) | 122 | **+9.6σ** | **ACCEPT** |
| `IMG_1576` (odd-center marginal) | 171 | **+4.7σ** | **reject** (<5) |

Raw count **inverts** them (171 > 122 — the sloppy solve racks up *more* loose
matches); a count gate waves both through. The log-odds sigma separates them
cleanly: the marginal sits genuinely *at* the gate (+4.7σ), its 171 matches
chance-unstable. This is the discrimination the count test structurally cannot make.

**τ calibration is DEFERRED to Agent 5's synthetic-injection oracle**
(`synthetic_inject.mjs`, not landed here): inject a known WCS → high logL, decoys →
low → the ROC that fixes τ at a measured false-positive rate. Until then `τ` is a
documented placeholder (`TAU_DEFAULT = ln(1e6)`) and the **sigma gate carries the
reject**; τ will tighten it. Marked as such in code and output.

---

## Resuscitated / relocated solvers — the honest state

### `trilock.mjs` — Tri-Lock scale solver — **WORKING, SCALE-ONLY**
Port of `MetrologyService.solveScale` (`src/engine/pipeline/m7_astrometry/
metrology.ts:23`). LAZARUS_REVIVAL **Candidate 5a**: this one is *live and
correctly gated* in the app — **no root bug**. Relocating it makes it runnable
headless and pins down its true contract: it returns a **scale (″/px) + triangle
match count only — NO pointing/orientation** (`refinedWcs = null`, reported
`NOT MEASURED`). It is a metrology *ruler*, a composable scale GENERATOR that
seeds the sweep/RANSAC pipeline — **not** a standalone plate solver.
- Measured on bundled CR2: locks **72.9″/px** (true 63.35; ~15% high — triangle
  side-ratios are distorted on a 14 mm field; honest limit).

### `vector_consensus.mjs` — Vector Consensus — **WORKING (CORRECTED), SCALE-ONLY + DRIFT**
Port of `VectorConsensusSolver` (`src/engine/pipeline/m6_plate_solve/
vector_solver.ts:33`). LAZARUS_REVIVAL **Candidate 5b**: dormant in the
quarantined auto path, and it carried the codebase's **"fake number" original
sin**. This relocation **corrects** it — the fabrications are **excised, not
ported**:
- ✂ `mapLensWarpage()` `totalDelta += 0.01` per edge star (a k1 invented from
  nothing, `vector_solver.ts:99`) → distortion = **NOT MEASURED**.
- ✂ `isAtEdge()` magic `x<500||x>4600||y<500||y>3000` (hardwired to one sensor,
  `:192`) → replaced with a **resolution-relative** radial partition.
- ✂ `saveHardwareFingerprint()`/`localStorage` browser side-effect → dropped.
- ✂ `solveVignette()` — a real radial measurement, but it needs `ImageData`
  (PIXEL ledger) the detection-only lane doesn't carry → **NOT MEASURED** here
  (it belongs in the `tools/psf` pixel lane).
- ✔ `solveBlind()` — scale + match count (scale-only, like Tri-Lock). Bundled
  CR2: 81.3″/px (imperfect on UW).
- ✔ `solveGeometricDrift()` — center-vs-edge scale split → radial `k1 = 1 −
  edgeScale/centerScale`, reported **only when both sub-solves lock**, with the
  underlying scales shown so its (currently noisy on UW) reliability is visible.

**Neither is a frontier solver for the anchorless CR2 class** (both start from a
bright anchor / bright-triangle set the no-anchor landscape frames lack — the
same conclusion as LAZARUS_REVIVAL). Their honest home is *scale metrology* that
feeds the sweep, which is how they are wired here.

---

## Survey: other solver logic living in the wrong place

Per the owner directive, solverkit is also the audit of scattered solve loops.

- **`tools/corpus/run_corpus.mjs` — DUPLICATE solve loop (LAW-4 "code in two
  places").** Its `triage()`/`cr2SolveAtHint()` re-implement the whole
  region→project→quad→`fitWCS`→scale-gate→verify→consensus core inline, with
  quadruplicated tangent-plane helpers (LAZARUS_REVIVAL **Candidate 6**). The
  **kernels are shared** (same Rust WASM); the **JS orchestration** is what is
  copied — now in ≥3 near-identical places (`run_corpus`, `tools/stack/
  solve_lib.solveAtHint`, the live `solver_entry.ts`). **solverkit’s
  `quad.mjs` + `ransac.mjs` is the corrected, single-home version of that solve
  core.** *Do not merge run_corpus into it* — run_corpus’s value is its
  **independent** null-model cross-check (it caught a real false positive at
  226″/px) plus its unique 4 GB streamed-FITS / CR2-libraw intake, which must be
  preserved. The disciplined move (future, gated): have `run_corpus.mjs` import
  the shared solve core instead of carrying its own copy.
- **`src/engine/pipeline/m6_plate_solve/vector_solver.ts`** — see above; the
  corrected home is `vector_consensus.mjs`.
- **The ultra-wide anchored sweep** currently lives *inline* inside
  `solver_entry.ts` (~L706-826). `anchored_sweep.mjs` is the extracted, testable,
  reusable copy.
- Dormant Rust solvers (`spherical_global`, `ridge_directed`) with named root
  bugs (LAZARUS_REVIVAL Candidate 8) are **owner-gated Rust internals** — out of
  scope for this headless JS bucket; noted, not touched.

### Supersession map (later, separately-gated `src/` removals — NOT done here)
| solverkit tool | supersedes (headless use) | live `src/` status |
|---|---|---|
| `quad.mjs` + `ransac.mjs` | `tools/corpus/run_corpus.mjs` inline solve core; `tools/stack/solve_lib.solveAtHint` | keep both live; consolidate to shared core later |
| `anchored_sweep.mjs` | the inline sweep in `solver_entry.ts` | **stays live** — app path; extract only when promoted |
| `vector_consensus.mjs` | `vector_solver.ts` (`VectorConsensusSolver`) | dormant in auto path; remove after its own C1 decision |
| `trilock.mjs` | — (thin CLI over the same live kernel) | `metrology.ts` stays live (correctly gated) |

---

## Gauntlet sanity — which generator×validator solves which

Measured by `gauntlet.mjs` (each cell = validator sigma vs its own null;
accept = ≥5σ & ≥8★; miss prints the best sub-gate sigma, honest):

| frame | class | generator | generator×RANSAC |
|---|---|---|---|
| `sample_observation` (CR2) | CLEAN (Jupiter) | anchored_sweep | **SOLVE +5.9σ / 92★** (scale 64.2″/px) |
| `IMG_1410` (CR2) | CLEAN (Jun-3) | anchored_sweep | **SOLVE +5.3σ / 42★** (scale 63.35″/px) |
| `IMG_1414` (CR2) | CLEAN (Jun-3) | anchored_sweep | **SOLVE +6.2σ / 133★** |
| `IMG_1757` (CR2) | NOISY (Altair) | anchored_sweep +bright-stars | miss +3.8σ / 139★ (needs the de-noise lever, `CR2_SOLVER_FINDINGS` §2b — not yet in kit) |
| `IMG_1653` (CR2) | FOREGROUND | anchored_sweep +bright-stars | miss +4.7σ / 132★ (terrain-blob anchors; the frontier class) |
| `sample_observation` (CR2) | CLEAN | quad | miss +2.4σ / 81★ (quad structurally starved on UW) |
| `M66` (SeeStar FITS) | narrow | quad | **SOLVE +12.9σ / 66★**, scale **3.677″/px** (matches seestar e2e 3.6776″/px) |

**4/7 combos cleared the 5σ gate.** The anchored-sweep × RANSAC lane converts the
CLEAN ultra-wide class (3/3) and honestly fails NOISY/FOREGROUND (the genuine
frontier — same classes as `CR2_SOLVER_FINDINGS.md`); the quad × RANSAC lane owns
the narrow FITS lane (+12.9σ, scale matching the seestar regression) and is
honestly starved on ultra-wide. One composable toolchest, honest gate throughout.
Run `node tools/solverkit/gauntlet.mjs` to regenerate.

<!-- ═══ BEGIN synthetic_inject.mjs section (Agent 5) — self-contained, appended for clean merge ═══ -->
---

## The ground-truth oracle: `synthetic_inject.mjs` — injection / recovery harness

**Bucket-1 confidence tool #1** (`docs/archive/SOLVER_TOOLSET.md` §1, ranked highest
confidence-per-effort). It turns every acceptance gate from an *asserted constant*
into a *measured* quantity: render a synthetic frame from a **known WCS**, run the
REAL `anchored_sweep → ransac` lane on it, and measure what fraction — and at what
σ — is recovered vs star density, anchor brightness, foreground fraction, and
noise. That draws the actual **ROC** and shows *where* the frozen σ≥5 / ★≥8 gate
sits on it. Injection-recovery is the wide-field-survey standard for measuring a
detection transfer function — DES **Balrog** (arXiv:2501.05683 / 2012.12825), HSC
**SynPipe**, DESI **Obi-wan**, Kepler (arXiv:1303.0255); this is the SkyCruncher
plate-solve instance. **No gate is lowered — the tool only measures where the
frozen gates land on truth.** Deterministic: every draw is from `common.mjs`'s
seeded PRNG (Box-Muller for Gaussians — no new RNG); same seed ⇒ byte-identical.

```
node tools/solverkit/synthetic_inject.mjs --selftest      # known-answer calibration + decoys + determinism proof
node tools/solverkit/synthetic_inject.mjs                 # single clean injection, full recovery report
node tools/solverkit/synthetic_inject.mjs --sweep         # the recovery map (P(recover) & σ vs each axis; ~6 min)
node tools/solverkit/synthetic_inject.mjs --sweep --fast  # coarse grid, 4 seeds/pt (~2 min)
```

**Pipeline.** `injectFrame(knownWcs)` → forward-projects the atlas through the WCS
(exact gnomonic + linear CD, same `projectStars` the validator uses), assigns
flux from magnitude, adds seeded position jitter + logistic detection
completeness, injects a **bright anchor object at the sky center** (the sweep's
lock target — Jupiter's role in the bundled frame), then layers scriptable
**foreground blobs** (bright + large, the terrain class) and **uniform false
detections** (clutter). `injectAndRecover()` runs `driver.solveFrame` on the
result and scores recovery via `wcsAgreementDeg` (inverse-gnomonic corner
agreement — orientation- and scale-sensitive, immune to the raw-count trap):
`recovered ⇔ accepted AND the accepted WCS points at the injected sky < 0.5°`.

### `--selftest` — known answer (stable)
| case | result | verdict |
|---|---|---|
| **CLEAN** (no fg, low noise) | **+12.4σ / 221★**, agree 0.13°, scaleErr 0.0%, rotErr 0.25°, **recovered** | accept ✓ |
| DECOY-A (true geom rotated +90°) | +0.1σ / 23★ | reject ✓ (a field aligns at ONE orientation) |
| DECOY-B (scrambled positions) | +5.0σ / 67★ accepted, **recovers no truth** | honest FPR finding (below) |
| determinism | same seed ⇒ byte-identical detections | ✓ |

The clean synthetic **+12.4σ** is *higher* than the real bundled-CR2 solve
(**+5.9σ / 92★**, `ransac.mjs --selftest`) **by design**: the synthetic frame is
distortion-free, so all 221 in-frame catalog stars land exactly where the linear
CD predicts, whereas real 14 mm barrel distortion scatters many out of the tight
net. **That gap IS the documented honest limit** — the injected model is
optimistic; anchor every recovery curve to the real +5.9σ before trusting it.

**Measured FPR finding (DECOY-B):** a *dense uniform-random* field reaches
**σ≈5.0 — right at the gate** — via RANSAC selection bias (LO-RANSAC overfits a
chunk of random points, then its rotation-null under-counts), yet it points at no
real sky (`recovered=false`). This is exactly the **count-vs-quality gap** a
one-sided count/σ test cannot close and the Bayesian log-odds verifier
(`SOLVER_TOOLSET.md` §2.1, Agent 6) is built to — the harness surfaces it as a
number instead of a worry.

### `--sweep` — the recovery map (8 seeds/point, bundled-CR2 geometry)
Per-axis P(recover) and recovered-σ, with the interpolated 50% boundary. Headline:
**the anchor object is the dominant lever** — a bright anchor makes the CLEAN
class robust to foreground/clutter/noise across the tested ranges; recovery breaks
when the *anchor itself* is out-competed or absent.

Measured (`test_results/solverkit/synthetic_recovery.{json,txt}`, byte-reproducible):

| axis (others held clean) | tested range | **50% crossing** | reading |
|---|---|---|---|
| foreground blobs, dim mag-2 anchor | 0 → 20 blobs | robust (no crossing) | large-FWHM terrain blobs are filtered by the anchor FWHM≤40 gate ⇒ a mag-2 anchor survives 20 blobs |
| **anchor-object mag**, 12 fg blobs | −3 → +4 mag | **2.5 mag** | recovers 8/8 to mag 2, collapses to 0/8 at mag 3 — the anchor must be ≳ mag 2.5 to stay in the top-K vs foreground (**the NO-ANCHOR boundary**) |
| false detections (uniform clutter) | 0 → 3000 | robust (no crossing) | σ degrades 12.2 → 7.6 but stays > gate; uniform clutter raises the null, the true peak holds |
| **position noise σ** | 1 → 44 px | **25.6 px** | σ 12.0 → 9.2 (16px) → 6.2 (28px, 3/8) → 4.4 (44px, 1/8); jitter past ~26 px breaks the match net |

Representative crossing rows (P = recovered fraction over 8 seeds):

```
anchor-object mag :  mag  2 → P=1.00 σ=12.0    |  mag  3 → P=0.00 (anchor buried by foreground)
position noise σ  :  16px → P=1.00 σ=9.2       |  28px → P=0.38 σ=6.2   |  44px → P=0.12 σ=4.4
```

**Headline:** the CLEAN ultra-wide class is *robust* to foreground count and uniform
clutter (a bright, small-FWHM anchor dominates — and large terrain blobs are culled
by the anchor FWHM gate), and recovery breaks along two measured axes — **anchor
brightness (< mag ~2.5 with competing foreground)** and **astrometric jitter
(> ~26 px)**. That is where the frozen 5σ gate sits on the injected ROC.

**Honest limit.** Curves reflect the *injected model* (linear CD, no lens
distortion; Gaussian jitter; synthetic blobs — not a terrain photograph) and a
**single sky center** (the anchor object's position) rather than the app's full
planet+bright-star center list, and with **pixel scale pinned** (metrology's job).
They therefore bound the SOLVABLE-with-a-known-anchor class optimistically; the
NO-ANCHOR / real-distortion frontier needs on-real-background injection (the
Balrog design) to de-bias — a documented follow-up.

**Feeds Agent 6 (log-odds):** the `{params → σ, recovered}` rows are a labelled
truth set — inject known frames, and calibrate the log-odds threshold τ so it sits
on THIS measured ROC (kills the DECOY-B false-accept the count test admits).
<!-- ═══ END synthetic_inject.mjs section (Agent 5) ═══ -->

---

## Same-set (cross-band) WCS transfer — `cross_band_transfer.mjs` (owner decision D4)

Owner-approved ruling **D-cross-band-wcs-transfer** (dashboard 2026-07-12; spec
`docs/TEST_SUITE_PLAN.md` D4): in a multi-band mosaic, faint narrowband channels
may be too photon-starved to solve alone — solve the RICH band and **copy** that
fitted WCS to the identical-geometry faint siblings, tagged
`solved_via: same_set_transfer` (never a re-synthesized WCS, never pooled with
blind-solve statistics). Acceptance = the sibling's OWN detected stars match the
source band's residual field within rms, else REJECT.

`node tools/solverkit/cross_band_transfer.mjs` measures this on the only banked
identical-geometry multi-band set (`r_mosaic` "Orion Square Panel 1", 6 filters
B·G·Hα·I·OIII·R, 5524×5503, ~0.477"/px) from banked artifacts only — no fresh
solve. Frame trap handled: receipt WCS is in a ~2× downsampled solve frame while
`test_results/fits_dets/` detections are full-res (scaled by `bin=fullDim/2·CRPIX`).

**MEASURED** (`test_results/solverkit/cross_band_transfer.json`, byte-reproducible):
- **Arm A — independent-solve WCS agreement** (G/I/R each solved blind, conf~0.25):
  centre **2.9–26.2"**, max-corner **56–89"**, scale within 1%.
- **Arm B — transfer is LOSSLESS**: source-WCS-on-sibling-detections ≡
  source-WCS-on-own-detections to within **max 1.6"** across match tol 6/10/20px
  (self rms floor ~3.7–13" set by the marginal solves) — the 6 filters share
  geometry, so a source WCS predicts a sibling's stars as well as its own.
- **Arm C — faint siblings**: **9/9** transfers ACCEPT; B/Hα/OIII (Hα has only 150
  detections and cannot solve blind) each get a usable regional WCS with 17–38
  own-detection star confirmations at the source band's residual rms.

**Honest bound (N=1, regional):** `same_set_transfer` is **VALIDATED as a
mechanism** (lossless; residual-match gate behaves correctly) but this set banks
only LOOSE source solves (conf~0.25), so precision is REGIONAL (~4–13"), not
sub-arcsec — transfer precision = source-solve precision. A tight-source multi-band
set is not banked. RESEARCH sandbox: tools/ + test_results only; no gate touched.
