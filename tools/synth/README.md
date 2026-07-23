# tools/synth — Reverse Pipeline v0 (synthetic frame generator)

The **inverse** of the plate solver. The solver goes image → WCS; this goes
**location + time + pointing → a synthetic image + a truth sidecar**, by running
the rig's measured transforms *forward* over a real catalog star field. Every
acceptance number downstream (solver center/scale error, sextant location, PSF
recovery, distortion refit) can now be measured against a **known** answer.

```
node tools/synth/generate_frame.mjs --rig narrow_seestar        # one frame + truth sidecar
node tools/synth/generate_frame.mjs --selftest                  # determinism proof
node tools/synth/closed_loop.mjs                                # the acceptance table (below)
```

## The pipeline (what runs, in order)

1. **pointing → RA/Dec center** — `--ra/--dec` directly, or `--alt/--az` + `--lat/--lon/--utc`
   through standard-Meeus horizontal→equatorial (`astro.mjs`).
2. **plate scale** — from the rig's `FOCALLEN` + `XPIXSZ` (the same metrology
   identity the wizard reads back: `arcsec/px = 206.265 · pitch_µm / FL_mm`).
3. **linear WCS** — `crval=[RA_deg,Dec_deg]`, `crpix=center`, `cd=cdFrom(scale,rot,parity)`.
4. **real star field** — `loadCatalog` over `public/atlas` (HYBRID Gaia-deg / HYG-hours
   rows, normalized to `ra_deg`), honestly mag-limited at the atlas depth (~12.5).
5. **forward distortion** — `projectStars` gnomonic-projects each star through the
   linear WCS, then applies `makeBrownConrady(k1,k2,w,h).toNative` (corrected→native).
   This is the **exact forward** of the solver's un-distort inverse (`toCorrected`),
   so a same-`k1/k2` solve recovers the injected linear WCS.
6. **PSF placement** — elliptical Gaussian (FWHM/ellipticity/PA per rig), flux from
   the `synthetic_inject` mag→flux law.
7. **extinction gradient** — optional per-star airmass dimming, differential about
   the field-center airmass (only the edge-to-edge gradient shows).
8. **sky + vignette + noise** — sky background, radial vignette gain
   (`corrections.mjs::vignetteGain`), Poisson≈Gaussian shot noise + Gaussian read
   noise, sensor saturation clip.
9. **emit** — a `BITPIX=-32` 3-plane FITS (`writeFitsPlanar`) the wizard ingests
   today + a `*.truth.json` sidecar.

Nothing geometric is reimplemented — steps 4–5, 8 reuse the live tools/ primitives
(CLAUDE.md LAW 4). No `tsx` is available to import the TS evaluators, so the
`.mjs` mirrors (`corrections.mjs`, `common.mjs`) are used, exactly as
`cascade_math.ts` documents for its own `capture_cascade.mjs` mirror.

## What is REAL vs SYNTHETIC-ENGINEERING vs APPROXIMATE

| Component | Status | Note |
|---|---|---|
| geometry (gnomonic + CD) | **REAL** | live `projectStars` / `cdFrom` |
| plate scale | **REAL** | metrology identity from FL + pixel pitch |
| star field | **REAL** | live atlas, honestly mag-limited at atlas depth |
| Brown-Conrady k1/k2 | **MEASURED** (pooled Rokinon 14mm) / **NOMINAL** | forward `toNative`; pooled k1=+0.0329,k2=+0.0020 (SOURCE in `rig_profiles.mjs`) |
| PSF shape (FWHM/ellip/PA) | **SYNTHETIC-ENGINEERING** | a plausible parameter, not a measured `psf_field` (v1 slot) |
| sky background | **SYNTHETIC-ENGINEERING** | flat level (no sky-gradient model — v1 slot) |
| noise | **SYNTHETIC-ENGINEERING** | Poisson≈Gaussian shot + Gaussian read |
| extinction k | **APPROXIMATE** | differential dimming; measured-k slot documented |
| alt-az math | standard Meeus | engine `TimeService` parity = v1 slot |
| FITS container | `BITPIX=-32` 3-plane | wizard-ingestible; CR2/CFA container = v0.5 |

The truth sidecar carries an `honesty` block stamping every one of these per frame,
and `OBJECT='SYNTHETIC'` + `SYNTHGEN`/`SYNTHSED` cards mark the FITS as generated.

## Closed-loop acceptance (the deliverable)

`closed_loop.mjs` generates three regimes, pushes each through the **real** headless
wizard (`tools/api/run.mjs`), and scores solved-vs-truth. Deterministic frames ⇒
reproducible table.

```
rig               frame        stars scale"/px dist  verdict   Δcenter Δscale% matched echo
narrow_seestar    2160x3840      245     3.74 iden  SOLVE       2.535"  0.000    241   PASS
medium_refractor  2400x1800      517     7.48 brow  SOLVE       4.476"  0.374    342   PASS
wide_dslr14       1800x1200     1125    63.21 brow  NO_SOLVE  timeout   — lost_in_space FOUND
                                                              truth cluster sep=2.3° votes=5 accepted
```

- **Δcenter** = great-circle solved-vs-truth center. Both solving regimes land
  **sub-pixel** (2.5″/4.5″ vs 3.74″/7.48″ pixels).
- **echo guard = PASS**: the FITS carries only a **coarse goto** (truth + 0.1°), never
  a WCS — the solved center lands on **truth**, not the goto, so the solve is a real
  star-match refine, not a header echo.
- **medium Δscale 0.374%**: the honest fingerprint of the mild BC distortion the
  FITS lane does **not** undistort — the fitted scale absorbs it. Not an error; a
  measured effect the reverse pipeline surfaces.
- **wide NO_SOLVE**: the FITS **narrow-quad** wizard does not terminate on a 31°
  distorted field (grinds to the vitest 360 s cap). Ultra-wide blind solving is the
  **CR2 anchor-sweep lane**, which `run.mjs` explicitly excludes (FITS-lane only).
  The incubator second opinion (`lost_in_space`, the FL≤35 mm blind lane) **finds
  the truth cluster** on the same frame → this is a **solver-lane** finding, not a
  generator defect. The generator produced a geometrically sound wide frame.

## Determinism

Same seed ⇒ **byte-identical** frame and sidecar (`--selftest` proves plane +
sidecar identity and seed-sensitivity; the written FITS file is byte-identical
across runs). Required for regression use. `generatedAtUnix` is intentionally
`null` (a timestamp would break reproducibility — honest-or-absent).

## v1 slots (named, so a real measurement drops straight in)

- **measured extinction k** — `DEFAULT_EXTINCTION_K` / rig `extinctionK`; replace with
  the atmosphere lane's fitted k.
- **donor `psf_field`** — place PSFs from a real M66-receipt psf_field per region
  instead of one parameterized FWHM.
- **pooled vignette fit** — swap the nominal `a2/a4` for a `flatness.mjs` fit.
- **sky-background model** — spatial light-pollution gradient (currently flat).
- **CR2/CFA container (v0.5)** — emit the mem_image RGB16 dominant-channel form so
  the DSLR decode+demosaic path is exercised (today: the FITS lane).
- **engine alt-az parity** — cross-check `astro.mjs` against `TimeService`
  (load-bearing for sextant validation below).

## Uses

- **Solver ROC / gate calibration** — every accept gate becomes a MEASURED quantity
  vs known truth (the same method `synthetic_inject.mjs` runs at the detection level;
  this runs it at the **pixel** level through the real decode+detect+solve).
- **Sextant P1/P2 ground truth** — a truth-known-location frame (set `--lat/--lon/--utc`,
  point by `--alt/--az`) is exact ground truth for deriving/validating observer
  location from a solve + time + up-reference. (Wire the engine alt-az parity slot
  first so the frame validates the ENGINE's transform, not just this tool's.)
- **Optical Workbench validation loop** — generate with rig profile X → solve/refit →
  recover X. Closes the per-rig profile loop against a known distortion/PSF/vignette.
```
