# tools/sextant — mount-geometry navigation (digital sextant vertical #4)

Recover the observer's **(latitude φ, longitude λ)** from an **alt-az–tracked** session's
field-rotation-vs-time history. An alt-az mount that tracks a target without a physical
derotator (SeeStar S30/S50 class) lets the field genuinely rotate; the per-sub registration
**rotation angle vs UTC** traces the **parallactic angle** q(t) up to an unknown constant
camera-orientation offset q0. With the target's (RA, Dec) known (solved) and per-sub
timestamps trusted, fitting q(t) recovers (φ, λ). **The mount's leveling is the plumb line —
no atmosphere is used.** Spec: `docs/ATMOSPHERE_SEXTANT_SPEC.md` ADDENDUM ("mount-geometry
nav family, verticals 4-5").

**Relationship to the other verticals.** The atmosphere verticals (extinction / refraction /
sky-background, spec increments 2–10) need a *wide* field with an airmass gradient and fail on
narrow fields. This one is the **complement**: it works on NARROW fields (a 2° SeeStar frame is
fine — it needs the target to *move across the sky over time*, not span sky within one frame),
and it bypasses the atmosphere entirely. Fusion (spec increment 11) combines all verticals'
(lat,lon) likelihood surfaces via Mahalanobis agreement into GOLD/SILVER/REFUSED tiers; this
vertical emits the same honest-or-absent product and slots straight in.

Everything here is `tools/` incubator code (Law 4): a pure-JS fitter kernel + a thin CLI, zero
`src/` edits. The astronomical primitives are re-implemented locally (a plain `.mjs` cannot
import the TS `@/` engine modules) and **pinned to the engine's `TimeService` as source of
truth** by the standing cross-check in `mount_rotation_fit.test.ts` (< 1e-9 agreement) — the
"reuse TimeService" mandate honored as validation, not blind duplication.

---

## The physics (verified, not assumed)

The field-rotation angle an un-derotated alt-az mount imprints on each sub equals the
**parallactic angle** q — the angle at the target in the astronomical triangle Pole–Zenith–Star,
between the hour circle (toward the celestial pole) and the vertical circle (toward the zenith):

```
q = atan2( sin H ,  tan(φ)·cos(δ) − sin(δ)·cos(H) )          H = LST(λ, t) − RA
```

- `H` = local hour angle; `LST(λ,t) = GMST(t) + λ` (East longitude positive); RA is in **HOURS**
  internally (repo unit trap). `atan2` (not raw `atan`) fixes the quadrant — dividing the fully
  correct `atan2(cosφ·sinH, sinφ·cosδ − cosφ·sinδ·cosH)` by `cosφ` is sign-safe because
  `cosφ > 0` for `|φ| < 90°`.
- **Cross-checked numerically:** the finite-difference `dq/dt` matches the independent
  field-rotation-rate formula `dq/dt = ω·cos(φ)·cos(Az)/cos(alt)` (the addendum's `dρ/dt`) in
  **magnitude to FD precision** across many geometries. The **sign** of that formula is
  convention-dependent (azimuth origin + image parity), so it is **never asserted** — see below.

Observed model per sub *i*:  `rotation_i = s · q(φ, λ; RA, δ, t_i) + q0  (mod 360)`, with
**parity `s ∈ {+1, −1}`** (rotation/image sign, CLAUDE.md law: derive from data, never assert)
and **q0** the constant camera offset. Fit = **VarPro** (q0 profiled as a σ-weighted circular
mean, so the nonlinear search is only 2-D over (φ,λ)) + **Levenberg–Marquardt** + **Tukey-biweight
IRLS** (c = 4.685) — the same robust family as `tools/atmosphere/fit_vertical`. Both parities are
fit; the data picks the winner.

### Two EXACT degeneracies (the load-bearing findings)

Rotation-vs-time alone does **not** uniquely determine (φ, λ). Two exact aliases exist, each
proven and each broken by a *different* physical constraint. Missing either makes the fitter
**confidently wrong** (a silent false-confidence event — the one thing the instrument must never do).

1. **Hemisphere/longitude alias `(φ, λ) ↔ (−φ, λ+180°)`.** One shows algebraically (and we verify
   numerically to 1e-6) that `q(−φ, λ+180°) = q(φ, λ) + 180°` for all t — the constant 180° is
   **fully absorbed by q0**, so the two observers give *identical* rotation curves. But altitude
   flips sign under the same map: `alt(−φ, λ+180°) = −alt(φ, λ)`. **The frames exist ⇒ the target
   was above the horizon ⇒** the physical branch is the one that keeps it up. The alias always
   puts the target *below* the horizon → the **horizon constraint breaks it exactly**. (Implemented:
   the fit picks the branch with the larger session-mean target altitude.)

2. **Parity alias `s = +1 ↔ s = −1`.** `q(H)` is **odd in H**, so on a **(near-)meridian-symmetric**
   arc the +q and −q hypotheses fit within noise (each absorbing the difference into (φ,λ,q0)). We
   observe `parity_margin → 0` exactly for symmetric low transits. Broken by arc **asymmetry**: an
   *asymmetric* meridian crossing (or a monotonic off-meridian arc) separates the two parities
   decisively. The fitter measures the separation and **refuses when it is < 1σ-per-point**.

A third, numerical edge: the parallactic angle is **singular at the zenith** (a star overhead has
no defined position angle). A target passing within ~5° of the zenith makes the covariance
unreliable → guarded by a `zenith_proximity` refusal.

---

## Refusal grammar (honest-or-absent)

Output is either `MEASURED` with **(φ, λ) ± a covariance ellipse**, or `NOT_MEASURED` naming the
**failed predicate**. Every threshold is an **initial engineering value** (Law 2 — flag-not-tune;
changed only by adding evidence, never to make a case pass). Defaults in `fit_core.mjs`
`PREDICATE_DEFAULTS`:

| predicate | fires when | default | rationale |
|---|---|---|---|
| `n_points` | valid points `< MIN_N` | 5 | need enough to define a curve |
| `session_arc` | arc `< MIN_ARC_MIN` **or** HA span `< MIN_HA_SPAN_DEG` | 20 min / 5° | short arc ⇒ ~constant dq/dt ⇒ one rate constrains one *combination* of (φ,λ), not both |
| `parity` | parity separation `< MIN_PARITY_SEP` | 1.0 σ | s=±1 mirror hypotheses fit within noise (symmetric arc) |
| `rate_curvature` | curvature-of-q(t) SNR `< MIN_CURV_SNR` | 3 | too little curvature to separate φ from λ (capture through transit) |
| `zenith_proximity` | max target alt `> MAX_ALT_DEG` | 85° | parallactic angle singular near zenith |
| `covariance` | `σ_lat > MAX_SIGMA_LAT_DEG` or `σ_lon > MAX_SIGMA_LON_DEG` | 20° / 20° | the data's own error bars refuse a city/region-tier fix |
| `sanity` | `|φ| > 90`, λ out of range, or redχ² `> MAX_REDCHI2` | 90 / 9 | series inconsistent with a single alt-az model + noise |

**Hard precondition (not yet auto-enforced here):** `timestampTrusted`. A wrong clock rotates the
whole alt-az frame and biases λ by 15°/hr — a real pipeline run must gate on the existing
`stages/ingest` clock forensics before trusting any (lat,lon) out of this tool.

---

## Characterization curve (synthetic, truth-known)

`node tools/sextant/mount_rotation_fit.mjs --sweep` → `test_results/sextant/sweep_recovery.json`.
243 configs: 3 regimes × 3 session lengths × 3 latitudes (0/40/65°) × 3 declinations (−20/30/70°)
× 3 rotation noises (0.01/0.05/0.2°). Regimes: **cross_asym** = asymmetric meridian crossing (best
geometry), **transit** = symmetric about the meridian, **offmeridian** = monotonic descending arc.
Errors are median |Δlat|,|Δlon| over the MEASURED configs (deg); σ are the reported 1σ (deg).

| regime | len | MEASURED/total | med \|Δlat\| | med \|Δlon\| | med σlat | med σlon | dominant refusals |
|---|---|---|---|---|---|---|---|
| cross_asym | 10 min | 0/27 | — | — | — | — | session_arc, n_points |
| cross_asym | 60 min | 7/27 | 0.008 | 0.007 | 0.011 | 0.044 | parity, n_points, zenith |
| cross_asym | 180 min | 19/27 | 0.013 | 0.020 | 0.017 | 0.036 | parity, n_points, zenith |
| transit | 10 min | 0/27 | — | — | — | — | session_arc, n_points |
| transit | 60 min | 7/27 | 0.004 | 0.026 | 0.004 | 0.016 | parity, n_points, zenith |
| transit | 180 min | 18/27 | 0.004 | 0.020 | 0.009 | 0.035 | parity, rate_curvature, zenith |
| offmeridian | 10 min | 0/27 | — | — | — | — | session_arc, n_points |
| offmeridian | 60 min | 7/27 | 0.046 | 0.063 | 0.089 | 0.043 | parity, rate_curvature |
| offmeridian | 180 min | 20/27 | 0.063 | 0.044 | 0.082 | 0.080 | rate_curvature, parity |

Noise scaling (cross_asym, 180 min): med |Δlat| 0.008° → 0.015° → 0.141° as noise goes
0.01° → 0.05° → 0.2° per sub; the reported σ track the noise.

**The headline honesty result: 0 / 243 silent false-confidence events** — across every config, no
MEASURED fix is ever wrong by more than ~3× its own reported covariance. Encoded as a standing
test (`HONESTY INVARIANT`). Reading of the table:

- **Short arcs (10 min) correctly refuse** everywhere (`session_arc`) — as required.
- **Asymmetric meridian crossings recover best** (sub-0.02° in favorable geometry); the meridian is
  the richest-curvature geometry *when the arc is asymmetric*. A **symmetric** transit is
  parity-degenerate and honestly refuses.
- **Off-meridian arcs recover with wider bars** (less curvature) — still honest, just looser.
- Real single-frame precision will be far coarser than these idealized-noise numbers imply; the
  addendum's own assessment is **city/region-level (~75–85% reliability)**, tripod-leveling-limited.
  Nothing here is a graduated science product until validated against ground truth (spec inc 11).

---

## Real-session input contract

`mount_rotation_fit.mjs --series <file.json> --target <raH,decDeg>` where `<file.json>` is either
a bare array or `{series, target}`:

```json
{ "target": { "ra_hours": 10.716, "dec_deg": -59.68 },
  "series": [ { "t_utc": "2024-03-30T18:38:13Z", "rotation_deg": 12.4, "sigma": 0.05 },
              { "t_utc": "2024-03-30T18:41:19Z", "rotation_deg": 12.9, "sigma": 0.05 } ] }
```

- `t_utc` = ISO-8601 or epoch-ms UTC (per-sub DATE-OBS). `rotation_deg` = each sub's field
  **rotation** (position angle of the sub's WCS relative to a reference sub). `sigma` optional
  (per-sub rotation uncertainty in deg); if absent the fit uses the residual scatter.
- **How to get `rotation_deg`** (not currently ledgered — the stack lane stores only per-frame CD
  matrices): solve each sub and take `rotation = atan2(±CD2_1, CD1_1)` with the sign from the CD
  determinant (**parity from data, never asserted**), *or* run a pairwise-rotation estimator on the
  detections. `tools/stack/solve_lib.mjs::refineWCS` already produces a per-frame WCS to extract from.
- **Ground truth for scoring:** `SITELAT` / `SITELONG` FITS header cards (SeeStar writes them;
  `src/engine/pipeline/m1_ingestion/fits_decoder.ts:393-399` reads them into `gps_lat`/`gps_lon`).
  Score a fix in km via `TimeService.computeAltAz`-style geodesy (same motion as sextant P1).

`real_data_attempt.mjs [--dir <path>] [--match <substr>]` inventories a directory of FITS subs
(reads header cards only, no pixel decode) and reports N / arc / site-truth / whether rotations are
available, then exercises the fitter's data-sufficiency gate.

---

## Real-data verdict (2026-07-09)

**No usable local alt-az multi-sub session exists.** A full inventory of `Sample Files/` + corpus
(scout) found exactly one multi-sub same-target sequence: a **2-frame Canon EOS 60Da DSLR** pair in
`Sample Files/rotating/` (`carina60Da_180s_iso800_00{1,2}.fit`). Its headers (verified):

- **N = 2** subs — below `MIN_N = 5`.
- DATE-OBS `2014-03-30T18:38:13` and `18:41:19` UT → **arc ≈ 3.1 min**, below `MIN_ARC_MIN = 20`.
- **No `SITELAT`/`SITELONG`** — no ground truth to score against.
- No WCS/CROTA — unsolved, so per-sub rotations aren't even available.

`real_data_attempt.mjs --match carina` → **`NOT_MEASURED · n_points`** ("only 2 valid points, need
≥ 5"). This is the honest first real-data outcome: the instrument **refuses insufficient data rather
than fabricating a fix**. A positive real measurement needs a **SeeStar alt-az session**: ≥ 5 (ideally
tens of) solved subs of one target spanning ≥ 20 min through/near the meridian **asymmetrically**,
with per-sub DATE-OBS and (for scoring) SITELAT/SITELONG. That drop is the critical-path capture ask.

---

## Files

| file | role |
|---|---|
| `lib/astro.mjs` | GMST/LMST/alt-az/parallactic primitives (pinned to `TimeService`) |
| `fit_core.mjs` | the fitter kernel — `fitMountGeometry({series, target})` + `PREDICATE_DEFAULTS` |
| `synth.mjs` | truth-known q(t) generator for validation |
| `chart.mjs` | dependency-free SVG diagnostics (rotation vs time, residuals, covariance ellipse) |
| `mount_rotation_fit.mjs` | CLI: `--sweep` (characterization) / `--series` (real fit) |
| `real_data_attempt.mjs` | FITS-sub inventory + data-sufficiency gate |
| `mount_rotation_fit.test.ts` | standing gate: engine cross-check + refusal predicates + honesty invariant |

## Deviations from the build-prompt formulas

- The prompt's `tan(q)` and `dρ/dt = ω·cos(lat)·cos(Az)/cos(alt)` are both correct; the second is
  correct **in magnitude only** — its sign is convention-dependent, so parity is **fit** (s = ±1),
  not asserted (CLAUDE.md parity law).
- The prompt frames the fit as **3 parameters (φ, λ, q0)**; here **q0 is profiled out** (VarPro,
  circular mean) so the nonlinear search is **2-D over (φ, λ)**, and **parity is a discrete 4th
  hypothesis** fit both ways.
- The prompt did not anticipate the **two exact degeneracies** above; discovering and breaking them
  (horizon constraint; parity-separation gate) is the core of what makes this fitter honest rather
  than confidently wrong. These are the primary contributions of this vertical.

---
---

# P1 — VALIDATION SEXTANT (pure composition)  ·  a SECOND thing this lane hosts

> Distinct from the mount-geometry vertical above. Where vertical #4 recovers (φ,λ) from a
> *rotation-vs-time* series, **P1 is the composition + validation floor** the spec's inc-11
> names ("P1 = GPS validation at continental scale — catching lied EXIF GPS; P2 = derivation
> follows"). Owner-scoped this increment to **PURE COMPOSITION only** — no fit, no new physics,
> no new measurement claims. Files: `lib/p1_sextant.ts` (module) · `p1_validate.mjs` (CLI) ·
> `p1_validate.runspec.ts` + `.config.ts` (kernel) · standing tests
> `src/engine/tests/sextant_p1.test.ts` (rides `npx vitest run`).

**What it composes.** `(solved WCS RA/Dec) + (trusted UTC) + (a CLAIMED observer lat/lon)` →
the field's Alt/Az + parallactic angle + Bennett refraction + Kasten–Young airmass, and a
**VALIDATE / REFUTE / REFUSE** verdict with honest error propagation and a **coordinate-free**
attestation. A TRUE CALCULATION (Meeus / IAU 1982 GMST), reusing the engine's `TimeService`,
`OpticsManager.calculateAtmosphericRefraction` (Bennett 1982), and `AtmosphericManager.computeAirMass`
verbatim (Law 4 — no duplicate math). **LEDGER: COORDINATE only** (zero pixels). RA is **HOURS**
internally; longitude **East-positive** degrees.

**It does NOT derive.** A single-plate *fix* needs an independent up/zenith reference (horizon /
gravity-EXIF / atmospheric gradient) that P1 does not measure — that is **P2** and the inc-8/9/10
verticals. `derived_location` is **always NOT_MEASURED** (`no_up_reference`). The zenith↔location
map (`locationToZenith`/`zenithToLocation`, exact inverses) lives here because P2 inverts it; P1
exercises it forward.

**HARD GATE — trusted clock (LOAD-BEARING).** `timestampTrusted` gates everything time-derived. A
wrong clock rotates the alt-az frame, so an untrusted clock → **REFUSED / `timestamp_untrusted`** —
never a wrong position. The e2e receipt carries no explicit ingest verdict, so the CLI **never
infers trust**: `--trusted` = the caller asserts it (echoing the ingest forensics); absent → treated
untrusted → refuse.

| status | when | position emitted? |
|---|---|---|
| `VALIDATED` | field above horizon at claimed loc+time (claim admissible) | claim echoed, validated |
| `REFUTED` / `field_below_horizon_at_claimed_location` | claim physically impossible — the lied-GPS catch | none |
| `REFUSED` / `timestamp_untrusted` | untrusted clock | none |
| `REFUSED` / `no_claimed_location` | no GPS to validate (deriving is P2) | none |

**Honest error propagation.** longitude ← time (the longitude problem): `σ_lon = (360°/86164.0905 s)·σ_t`
— exact kinematics, MEASURED when a time σ is given. latitude of a *derived* fix = up-reference σ ⇒
**NOT_MEASURED** in P1 (the honest statement of why P1 validates but cannot derive). altitude σ ←
WCS-center σ via numeric Jacobian (APPROXIMATE).

**INITIAL ENGINEERING VALUES (Law 2 — flag, don't tune):** `SIDEREAL_DEG_PER_SEC = 360/86164.0905`
(exact Earth sidereal rate) · `JACOBIAN_STEP_DEG = 1e-4`. Bennett P/T (1010 hPa / 10 °C) and
Kasten–Young live in the engine and are reused; refraction/airmass are labelled **APPROXIMATE**.

### MEASURED RESULT — banked e2e receipts (2026-07-22)
`node tools/sextant/p1_validate.mjs --receipt <summary.json> [--trusted]`. Zero src/ production
diffs; tsc 0.

| frame | claimed GPS | status | product |
|---|---|---|---|
| **SeeStar M66** (`seestar_…01-23-17`) | FITS 46.218°, −84.068° | **VALIDATED** | field **43.738° above horizon** (az 236.85° WSW, post-transit), airmass **1.445**, Bennett **62.4″**, boresight→zenith **46.262°**; derived_location NOT_MEASURED; coordinate-free attestation |
| **CR2 beach** (`cr2_…05-47-27`) | `gps_source=DEFAULT`, null | **REFUSED** `no_claimed_location` | honest refusal — P1 validates a claim, it does not derive (P2) |
| **SeeStar M66** (no `--trusted`) | — | **REFUSED** `timestamp_untrusted` | all time-derived geometry null — no wrong position emitted |

The VALIDATED altitude reproduces an independent Meeus transform to 1e-6 and sits below the transit
bound `90 − |lat − dec| = 56.85°` — the alt-az frame is anchored correctly. The two refusals are the
honest-or-absent products, not failures. Outputs (gitignored): `test_results/sextant/p1_*.json`.

**Roadmap:** P2 (derivation) + the atmospheric verticals (inc-8/9/10) + fusion (inc-11) are
RESEARCH-RISK / owner-gated separate increments. P1 is the composition + validation floor they build on.
