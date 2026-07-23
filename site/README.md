# skycruncher.io landing page — static, self-contained (no build step; zero external requests by default).

Deploy: `npx wrangler pages deploy site --project-name skycruncher-io`
DNS binding of the apex domain to the Pages project is an owner step in the Cloudflare dashboard.

## Contents
- `index.html` — the landing page. The measurement-corpus section + the two time-series
  charts render from BAKED data inlined in the page (same content as the JSON files below).
- `database_summary.json` — SANITIZED snapshot of the analytics roll-up
  (`test_results/analytics/database_summary.json` → provenance/spec blocks stripped, no
  local paths; modules limited to corpus / solve / residuals / wall). Snapshot 2026-07-12,
  pre-cutover solver — regenerate + re-inline after the full-corpus re-pass.
- `series.json` — the time-series feed (one point today: the 2026-07-12 baseline).
  Schema per point: `{date, git, blind_rate_all, blind_rate_attempted,
  rate_by_format:{CR2,FITS}, wall_median_s, wall_p90_s}`.
- `widgets/` — solve-render gallery PNGs, standard DARK theme. Rendered by screenshotting
  the widget registry's SSR twins (`test_results/mcp_renders/<id>.html`) with the twin's own
  dark var-set re-injected as a final `:root` override (the twins concatenate
  dark→paper→night var sets in one rule, so night wins by default — the override flips it),
  `#capture` element at deviceScaleFactor 2. `lens_profile_3d`: the SSR twin carries no
  script — the 3D surface draws client-side in-app, so the static export shows measured
  stats with an empty plot area (captioned honestly on the page).
- `dag_preview.png` — homepage card image for the DAG page (viewport capture of `dag/`).
- `dag/` — read-only static embed of the interactive pipeline DAG
  (`tools/dag/ui/*` + `dag_base.json` + `enrichment.json` + `steps_map.json`;
  annotations are a static `[]`, every annotate affordance gated off via
  `DAG_READ_ONLY` in `dag/dag_app.js`). Sanitization-gated: no local-machine paths.

## Live hydration (optional)
`STATS_URL` in `index.html` (default `null` = fully static). When set to a JSON endpoint
(the R2 `site_stats.json` pattern), the page refreshes at load: the stat bar, the
measurement-corpus section, and both time-series charts from one envelope:
`{ as_of, stats:{...}, database:<database_summary.json shape>, series:<series.json shape> }`.
Baked values remain the honest fallback, stamped with their snapshot dates.
