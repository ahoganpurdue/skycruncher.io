-- Q5  Post-accept probe share by arm (the abort benefit)
-- Uses the TWO banked per-band censuses on the long solve_bands table: `probes`
-- = final whole-run census, `at_accept_probes` = census snapshot at the moment
-- of accept. post_accept_share = 1 - accept/final = the fraction of probe work
-- spent AFTER the winning hypothesis was accepted. band-major (abort_on_accept)
-- -> ~0 ; baseline (runs the full ladder past accept) -> large.
WITH per_frame AS (
  SELECT arm, receipt_sha256,
         sum(probes)                                            AS final_probes,
         sum(at_accept_probes)                                  AS accept_probes,
         count(*) FILTER (WHERE at_accept_probes IS NOT NULL)   AS n_accept_cells
  FROM ${BANDS}
  WHERE state = 'Solved'
  GROUP BY arm, receipt_sha256
)
SELECT arm,
       count(*)                                                                       AS n_solved_w_accept_census,
       round(avg(1 - accept_probes::DOUBLE / nullif(final_probes, 0)), 3)             AS mean_post_accept_probe_share,
       round(median(1 - accept_probes::DOUBLE / nullif(final_probes, 0)), 3)          AS median_share,
       round(max(1 - accept_probes::DOUBLE / nullif(final_probes, 0)), 3)             AS max_share
FROM per_frame
WHERE n_accept_cells > 0
GROUP BY arm
ORDER BY arm;
