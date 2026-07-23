-- Q3  Scale-residual & center-offset vs label, by truth stratum
-- The core accuracy-drift query over the truth stratum. scale_residual_pct =
-- (solved_scale / label_scale - 1) * 100 ; center_offset_deg = great-circle
-- separation of solved crval vs label center. Stratify by truth_class so the
-- anet_preview resolution-mismatch cohort does not contaminate anet_native.
SELECT truth_stratum,
       count(*)                                          AS n,
       median(scale_residual_pct)                        AS median_scale_resid_pct,
       min(scale_residual_pct)                           AS min_scale_resid_pct,
       max(scale_residual_pct)                           AS max_scale_resid_pct,
       count(*) FILTER (WHERE scale_within_band)         AS n_scale_within_2pct,
       median(center_offset_deg)                         AS median_center_off_deg,
       max(center_offset_deg)                            AS max_center_off_deg
FROM ${SOLVES}
WHERE solved AND has_label AND scale_residual_pct IS NOT NULL
GROUP BY truth_stratum
ORDER BY truth_stratum;
