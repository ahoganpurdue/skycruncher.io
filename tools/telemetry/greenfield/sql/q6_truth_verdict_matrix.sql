-- Q6  Truth-verdict matrix: arm x stratum x verdict
-- The confusion-matrix roll-up. truth_verdict (derived in flatten_receipt.mjs):
--   TRUE_POSITIVE      solved, center within center_bar_deg, scale within band
--   POSE_OK_SCALE_OFF  solved, center OK, scale outside scale_band_pct
--   GEOM_MISMATCH      solved, center OUTSIDE the bar (wrong pose)
--   SOLVED_UNLABELED   solved, no ground-truth label to check
--   REFUSAL            positive frame did not solve (BudgetExhausted)
--   FALSE_POSITIVE     negative frame solved  (must be 0)
--   TRUE_NEGATIVE      negative frame refused
SELECT arm, truth_stratum, truth_verdict, count(*) AS n
FROM ${SOLVES}
GROUP BY arm, truth_stratum, truth_verdict
ORDER BY arm, truth_stratum, truth_verdict;
