-- Q7  Config-drift sentinel: distinct build/config per arm
-- The instrument's tripwire. In a healthy population each arm carries ONE
-- solver_core_version / git_commit / index md5 / resolved_config_digest. A count
-- > 1 in any cell = silent drift (a config or build changed mid-population) and
-- the pose/wall drift queries above must be re-read partitioned by that split.
SELECT arm,
       count(DISTINCT solver_core_version)       AS n_core_versions,
       count(DISTINCT git_commit)                AS n_git_commits,
       count(DISTINCT index_aggregate_md5)       AS n_index_md5,
       count(DISTINCT resolved_config_digest)    AS n_config_digests,
       string_agg(DISTINCT hit_order_policy_tag, ',') AS hit_order_policies
FROM ${SOLVES}
GROUP BY arm
ORDER BY arm;
