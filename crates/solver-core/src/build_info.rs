//! Compile-time embedded build configuration (see build.rs). Receipts stamp these so a
//! wrong-cwd build (dropped rustflags) is visible in every result.

use solver_contracts::receipt::BuildInfo;

pub const RUSTFLAGS: &str = env!("SOLVER_BUILD_RUSTFLAGS");
pub const OPT_LEVEL: &str = env!("SOLVER_BUILD_OPT_LEVEL");
pub const TARGET: &str = env!("SOLVER_BUILD_TARGET");
pub const PROFILE: &str = env!("SOLVER_BUILD_PROFILE");

/// `git_commit` is supplied by the CLI (the only layer allowed to touch the environment).
pub fn build_info(git_commit: String) -> BuildInfo {
    BuildInfo {
        solver_core_version: solver_contracts::SOLVER_CORE_VERSION.to_string(),
        quad_coder_version: solver_contracts::QUAD_CODER_VERSION.to_string(),
        verify_policy_version: solver_contracts::VERIFY_POLICY_VERSION.to_string(),
        rustflags: RUSTFLAGS.to_string(),
        opt_level: OPT_LEVEL.to_string(),
        target: TARGET.to_string(),
        profile: PROFILE.to_string(),
        git_commit,
    }
}

#[cfg(test)]
mod tests {
    /// Grep-guard (Layer 1): solver-core must never read the environment at runtime.
    /// `std::env::var` / `env::var` outside build.rs or this test file is a contract violation.
    #[test]
    fn no_env_reads_in_solver_core() {
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        fn walk(dir: &std::path::Path, offenders: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, offenders);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let text = std::fs::read_to_string(&p).unwrap();
                    // Allow compile-time env! (build.rs-embedded); forbid runtime env reads.
                    if text.contains("std::env::var") || text.contains("env::var(") {
                        if !p.ends_with("build_info.rs") {
                            offenders.push(p.display().to_string());
                        }
                    }
                }
            }
        }
        walk(&src_dir, &mut offenders);
        assert!(offenders.is_empty(), "runtime env reads in solver-core: {offenders:?}");
    }
}
