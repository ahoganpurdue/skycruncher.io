<!-- REFERENCE · category: reference · tags: Solver, Infra · algorithm card STUB; fill on Phase-K port or next tools/stack algorithm change · created 2026-07-11 -->
# Stacking & Drizzle — algorithm card (registration, rejection-combine, drizzle lane)

This card will document the multi-frame stacking lane: solve-first registration, rejection-combine, and drizzle. It exists as a placeholder to keep the reference-card set complete; it has not been written yet.

**STUB — NOT YET WRITTEN.** Fill trigger: the in-app port of the `tools/stack/` lane behind a proper engine seam, or the next algorithm change in `tools/stack/` — whichever lands first.

Scope this card will cover, per the shipped lane (`tools/stack/stack.mjs` @b979c79, validated on a distributed multi-frame collection): solve-first registration in WCS space (vs pixel-space quad-fit), per-pixel sigma-clip ($k=3$, ≥3 contributors) inverse-variance combine, Fruchter–Hook drizzle (square kernel, `--drizzle N --pixfrac f`), solve-driven cluster hint propagation, correlated-input exclusion (the honesty rule that keeps $\sqrt N$ claims real), and the rejection-map byproduct (`*_rejmap` — a candidate future satellite-trail detection feed). Until this card is written, the algorithm evidence of record is `docs/ROADMAP.md` Phase K (measured numbers: 0.10–0.31 px cross-frame rms, 6.63× SNR gain honest-attributed, the stack itself solving at 0.754 px) and the lane source.

## Related
- [CARD_ASTROMETRY_WCS.md](CARD_ASTROMETRY_WCS.md) — the WCS fit machinery that solve-first registration reuses per frame
- [CARD_PHOTOMETRY_STATS.md](CARD_PHOTOMETRY_STATS.md) — the robust-statistics toolkit (sigma-clip, MAD) the rejection-combine draws on
- [../ROADMAP.md](../ROADMAP.md) — Phase K: the validated headless lane this card will document and its in-app port plan
