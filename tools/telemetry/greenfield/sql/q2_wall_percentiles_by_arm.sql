-- Q2  Wall-time percentiles by arm (ms)
-- Population latency drift. p99/max catch the budget-bound tail (BudgetExhausted
-- frames sit at ~budget_ms). Swap the GROUP BY to (arm, truth_class) for the
-- per-class cut (q2b in the node runner).
SELECT arm,
       count(*)                        AS n,
       quantile_cont(wall_ms, 0.50)    AS p50_wall_ms,
       quantile_cont(wall_ms, 0.90)    AS p90_wall_ms,
       quantile_cont(wall_ms, 0.99)    AS p99_wall_ms,
       max(wall_ms)                    AS max_wall_ms
FROM ${SOLVES}
GROUP BY arm
ORDER BY arm;
