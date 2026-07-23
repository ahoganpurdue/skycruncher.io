-- Q1  Accept-band distribution by arm (solved frames)
-- Shows which √2 scale band each arm's accepts land in. Drift signal: a shift in
-- the accept-band histogram between arms/builds = the search is landing at a
-- different scale tier (e.g. band-major coarse->fine vs baseline band-asc).
-- ${SOLVES}/${BANDS} are substituted by query_telemetry.mjs with read_json_auto()
-- over the NDJSON; against parquet, replace with the view (see SCHEMA_DRAFT preamble).
SELECT arm, accept_band, count(*) AS n
FROM ${SOLVES}
WHERE solved
GROUP BY arm, accept_band
ORDER BY arm, accept_band;
