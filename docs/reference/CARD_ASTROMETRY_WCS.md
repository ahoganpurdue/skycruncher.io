<!-- REFERENCE · category: reference · tags: Solver · algorithm card; regenerate on formula changes · created 2026-07-08 -->
# Astrometry & WCS — algorithm card (solve & geometry lane)

This card documents blind plate solving and the coordinate math around it: turning a pattern of detected stars into a WCS (a mapping from pixel to sky), fitting out lens distortion, and vetoing solves that point too close to the Sun. It is the geometric core of the instrument — everything downstream (photometry, confirmation, rendering) is keyed off the WCS this lane produces.

Symbols: (x,y)=pixel; (ξ,η)=tangent-plane coords, radians; (α,δ)=RA/Dec, **RA in HOURS** unless stated; CRPIX=[crpix[0],crpix[1]]; CD=2×2 matrix, rad/px.
Every entry below is VERIFIED against the code at the cited line; none are assumed from the paper alone.

> **Cold-path note (legacy vs. current reference engine):** entries 1 (quad-hash blind solving), 2 (gnomonic/CD-matrix WCS fit, implemented in `wasm_compute/src/sky_transform.rs`), and 5 (sun-proximity veto), plus the RA-in-hours / `crpix[0]`/`crpix[1]` conventions in the Symbols line and the UNIT WARNINGS section below, describe the legacy TS/WASM solver lane (`solver_entry.ts`, `sky_transform.rs`, `fine_center_lever.ts`). The shipping reference solver is now a separate Rust core on `crates/solver-core` — a different control loop (no anchor/rotation sweep, no batch generate-cluster-judge; see `test_results/greenfield_solver/NIGHT_LEDGER_2026-07-21.md` for the cutover record). These entries remain accurate as a description of the retained legacy/cold path, not the current core's algorithm. Entries 3 (SIP distortion fit) and 4 (Brown-Conrady lens distortion) are pre-/post-solve pipeline stages independent of which solver produces the lock and are unaffected by this note.

### 1. Quad-hash blind plate solving
Forms 4-star groups ("quads") from the brightest nearby stars, encodes each quad's shape as a small, rotation/scale-invariant numeric code, and looks that code up in a pre-built catalog index; two or more matches are enough to seed a WCS. This is the entry point for solving a field with no prior pointing information.
- **Idea**: form 4-star "quads" from local brightest stars, hash relative geometry (rotation+scale invariant), match hash codes against a pre-built catalog quad index; ≥2 matches seed a WCS.
- **Code**: `src/engine/pipeline/m6_plate_solve/solver_entry.ts:30-33` (algorithm doc), quad-pool construction L954-1414, WASM matcher call L1446.
- **Cite**: Lang, Hogg, Mierle, Blanton & Roweis (2010), "Astrometry.net: Blind Astrometric Calibration of Arbitrary Astronomical Images", AJ 139, 1782 — cited verbatim in the file header (`:38-39`).
- **Gotcha**: lineage only, not a vendored index/API — own TS/WASM reimplementation with its own tolerance schedule (`quadtolerance`, default `SOLVER_QUAD_tolerance_DEFAULT=0.01` — calibrated, see docs/GATES.md) plus an anchor/rotation-sweep fallback for ultra-wide no-quad-match frames absent from the original paper.

### 2. Gnomonic (TAN) projection + CD-matrix linear WCS fit
Once a rough match is found, this fits the actual pixel-to-sky mapping: a standard tangent-plane (gnomonic) sky projection combined with a linear pixel transform (the CD matrix), solved by least squares from the matched star pairs.
- **Projection**: $\xi = \cos\delta\sin(\alpha-\alpha_0) / D$; $\eta = [\cos\delta_0\sin\delta - \sin\delta_0\cos\delta\cos(\alpha-\alpha_0)] / D$, where $D = \sin\delta_0\sin\delta + \cos\delta_0\cos\delta\cos(\alpha-\alpha_0)$. Inverse via $\rho=\sqrt{\xi^2+\eta^2}$, $c=\arctan\rho$.
- **Fit**: $[\xi;\eta] = CD\cdot[x-crpix_x;\ y-crpix_y]$; CD solved by normal equations from ≥3 (pixel,ξ,η) pairs: $CD=(J^TJ)^{-1}J^T[\xi,\eta]$.
- **Code**: `src/engine/wasm_compute/src/sky_transform.rs:23-44` (`gnomonic_project`), `:48-68` (`inverse_gnomonic`), `:157-201` (`fit_wcs_bulk`), `:128-142`/`:145-155` (scale·rotation·parity ⇄ CD).
- **Cite**: Calabretta & Greisen (2002), "Representations of celestial coordinates in FITS", A&A 395, 1077 (FITS-WCS Paper II, TAN projection); Greisen & Calabretta (2002), A&A 395, 1061 (Paper I, CD-matrix/keyword convention).
- **Gotcha**: `gnomonic_project`'s `ra_rad`/`dec_rad` args are RADIANS; TS callers convert from HOURS at the call site (`residual_analyzer.ts:125`, `raDeg/15`) — an hours/degrees slip here is silent, no runtime unit check. Parity is a solved-for ±1 sweep variable (`solver_entry.ts:989,1077-1138`, brute-force theta×parity), never asserted from geometry.

### 3. SIP (Simple Imaging Polynomial) distortion fit
A post-solve refinement step: when the linear WCS leaves a residual pattern in the matched-star positions, this fits a low-order polynomial correction on top of it, following the FITS-standard SIP convention.
- **Formula**: $dx(u,v) = \sum_{2\le p+q\le \text{order}} A_{pq}\, u^p v^q$, $dy(u,v)$ analogous with $B_{pq}$; $u=x_{det}-crpix_x$, $v=y_{det}-crpix_y$; $(dx,dy)=\text{detected} - \text{catalog-projected pixel position}$. Solved per-axis by least-squares normal equations (Gaussian elimination, partial pivoting).
- **Code**: `src/engine/pipeline/m7_astrometry/residual_analyzer.ts:52-115` (`analyze`; fires when RMS>1.2″ AND ≥20 of ≥15 total matches), `:142-172` (`performSIPFit`, $p+q\in[2,\text{order}]$ — 0th/1st order omitted per FITS convention), `:177-241` (normal-equations + Gaussian elimination solver).
- **Cite**: Shupe, Moshir, Li, Makovoz, Narron & Fall (2005), "The SIP Convention for Representing Distortion in FITS Image Headers", ADASS XIV, ASP Conf. Ser. 347, 491.
- **Gotcha**: the file's own header comments (`:17-26`) show the convention being worked out live in prose ("? No", "OR x+f(x,y)?") — the SHIPPED code lands on the standard form (correction relative to CRPIX, p+q≥2 only) but arrived at empirically rather than copied from the spec. In practice fires on CR2/DSLR wide fields (enough matches), not narrow SeeStar/FITS frames.

### 4. Brown-Conrady inverse radial lens distortion
A nominal, EXIF-driven lens-distortion prior applied to matching coordinates before the solve: a simple two-term radial model, with a numerical inverse computed because the physically natural direction (corrected→native) has no closed-form reverse.
- **Formula**: $r_d = r_u\cdot(1 + k_1 r_u^2 + k_2 r_u^4)$, r normalized to the frame half-diagonal, center = frame center. Forward (corrected→native) is a direct evaluation; inverse (native→corrected, what the solve path needs) has no closed form — solved by a 10-iteration radial fixed point.
- **Code**: `src/engine/pipeline/m2_hardware/lens_distortion.ts:64-106` (`makeBrownConradyDistortion`; `toNative` L75-83 direct, `toCorrected` L85-98 fixed-point).
- **Cite**: Brown (1966), "Decentering Distortion of Lenses", Photogrammetric Engineering 32(3), 444; Conrady (1919), "Decentered Lens-Systems", MNRAS 79, 384.
- **Gotcha**: RADIAL-ONLY ($k_1,k_2$) — the tangential decentering terms ($p_1,p_2$) that make this "Brown-Conrady" rather than plain radial distortion are carried in `DistortionCoeffs`/`LENS_DB` but deliberately NOT applied (no clean radial fixed-point inverse exists with them); exact only for lenses with $p_1=p_2\approx0$ (the shipped target, ROKINON_14_MUSTACHE), approximate otherwise. Coordinate-space transform of detection POINTS only — never resamples pixels (two-ledger law).

### 5. Sun-proximity veto (ultra-wide false-positive guard)
Rejects a candidate solve if its center points suspiciously close to the Sun's current position — a common source of false-positive locks on ultra-wide fields — unless daylight capture is independently confirmed.
- **Formula**: veto = angularSep(crval_RA,crval_Dec ; sun_RA,sun_Dec) < `SOLVER_UW_SUN_VETO_DEG`(=40°), bypassed if `daytimeConfirmed`. Great-circle separation via the spherical law of cosines (acos form).
- **Code**: `src/engine/pipeline/m6_plate_solve/fine_center_lever.ts:38-44` (`angularSepDeg`), `:128-138` (`isSunVetoed`); wired at `solver_entry.ts:2027`.
- **Sun position**: NOT Meeus ch. 25's dedicated solar-coordinates series. The Sun is a zero-orbit body whose geocentric RA/Dec = −(Earth's heliocentric vector), computed through the SAME generic low-precision Keplerian propagator used for every planet: `src/engine/wasm_compute/src/ephemeris.rs:81-109` (`solve_kepler_internal` — mean anomaly → eccentric anomaly via analytic seed $E_0=M+e\sin M(1+e\cos M)$ then 5 fixed Newton steps, no convergence check → heliocentric ECLIPTIC vector only). The ecliptic → equatorial rotation via fixed obliquity 23.43929° happens downstream in `batch_solve_ephemeris` (`ephemeris.rs:179,206-209`).
- **Cite**: element set/constants (mean motion $0.9856076686/a^{1.5}$, per-body N,i,w,a,e,M) match the widely-circulated Paul Schlyter "Computing Planetary Positions" formulation (stjarnhimlen.se/comp/ppcomp.html) [VERIFY — a practical/tutorial source, not a peer-reviewed paper; consistent in spirit with the low-precision planetary theory in Meeus, *Astronomical Algorithms*, ch. 33, but distinct from ch. 25's Sun-specific series].
- **Gotcha**: no trusted clock ⇒ `sunPosition=null` ⇒ veto never fires (honest-absent, not a false pass, not a false veto). `daytimeConfirmed` bypass requires a REAL observer site + trusted timestamp — the fictional (0,0) fallback site is excluded so it can never fake daylight.

## UNIT WARNINGS
- RA is **HOURS** internally everywhere (`crval[0]`, catalog `ra_hours`, sun/planet positions); degrees ONLY at the FITS-file read/write boundary (`tools/stack/fits_io.mjs`).
- WCS reference-pixel keys are `crpix[0]`/`crpix[1]` (array, `src/engine/types/Main_types.ts:76`), never `CRPIX1`/`CRPIX2`.
- Parity (image mirroring) is a solved-for sweep variable, never asserted from convention (`solver_entry.ts:989` on) — image-space is y-down; a sign flip mirrors the whole solution.
- Atlas rows are per-source: Gaia-format rows carry `ra` in DEGREES (`s.ra_deg`/`s.ra`); the legacy hybrid (Gaia + HYG-in-hours) rows this discrimination logic once had to handle are retired — the shipped atlas is Gaia-pure — but the discriminator itself remains in code (`isGaiaFormat` in `ingestStars`, `src/engine/pipeline/m6_plate_solve/star_catalog_adapter.ts:382`) as a defensive check.

---
**Not yet carded** (all 5 task-candidates above were verified — none skipped this pass): planetary-anchor ephemeris beyond the Sun (same Kepler propagator, `bright_star_anchors.ts`/`planetary_adapter.ts`); `vector_solver.ts` (Tri-Lock, dormant last-resort rung); DifferentialRefractionCorrector (live as an APPROXIMATE clock+GPS-gated field-level predictor in `stages/psf_attribution.ts:38,375-391`; delegated formula is Bennett $1/\tan(h+7.31/(h+4.4))$ in `optics_manager.ts:290-298`, never wired into the solve) — candidates for a future card pass.

## Related
- [CARD_SOLVER_QUADS_SWEEP.md](CARD_SOLVER_QUADS_SWEEP.md) — sibling card covering the quad-hash matching internals this one only summarizes
- [CARD_TIME_EPHEMERIS.md](CARD_TIME_EPHEMERIS.md) — the sun-position Kepler propagator behind the sun-veto guard (entry 5)
- [processing_flow.md](../01-canonical/processing_flow.md) — pipeline walk showing where solve and WCS fit among the other stages
- [NEXT_MOVES.md](../NEXT_MOVES.md) — executable solver-work specs (SIP export boundary, anchor lever) that touch this card's formulas
- [GATES.md](../GATES.md) — pinned reference solves this card's formulas must reproduce byte-identically
- [WHITEPAPER.md](../WHITEPAPER.md) — system paper's verified-nucleus claims about quad/TAN/SIP solving
- [CARD_STACKING_DRIZZLE.md](CARD_STACKING_DRIZZLE.md) — stub: the solve-first stacking lane that reuses this card's WCS fit for frame registration
