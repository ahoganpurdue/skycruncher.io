-- Q4  Refusal rate by arm (positives) + negative-stratum FP/TN
-- Refusal = a labeled/positive frame that did NOT reach Solved (BudgetExhausted).
-- The negative stratum (scrambles) is scored separately: solved-on-a-negative =
-- FALSE POSITIVE (the number that must stay 0), refused = TRUE NEGATIVE.
SELECT arm,
       count(*) FILTER (WHERE NOT is_negative)                        AS n_positive,
       count(*) FILTER (WHERE NOT is_negative AND solved)             AS solved,
       count(*) FILTER (WHERE NOT is_negative AND NOT solved)         AS refused,
       round(count(*) FILTER (WHERE NOT is_negative AND NOT solved)::DOUBLE
             / nullif(count(*) FILTER (WHERE NOT is_negative), 0), 3) AS refusal_rate,
       count(*) FILTER (WHERE is_negative)                            AS n_negative,
       count(*) FILTER (WHERE is_negative AND solved)                 AS false_positives,
       count(*) FILTER (WHERE is_negative AND NOT solved)             AS true_negatives
FROM ${SOLVES}
GROUP BY arm
ORDER BY arm;
