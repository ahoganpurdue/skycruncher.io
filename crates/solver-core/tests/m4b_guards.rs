//! M4b grep-guards (plan rev 2 §M4b): no exact-count acceptance discontinuity anywhere in
//! solver-core src/ — the legacy `n_match == 4`-style branch class (a quad that verified
//! with exactly its own 4 stars must never be special-cased into or out of acceptance;
//! acceptance is the continuous log-odds statistic ONLY).

use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// Strip line comments so documentation may mention the forbidden pattern.
fn code_of(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

#[test]
fn no_exact_match_count_branches_in_src() {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&src, &mut files);
    assert!(!files.is_empty());

    // Forbidden: equality comparisons against match-count identifiers or match-list
    // lengths (whitespace-normalized). `>=` / thresholds are fine (refine_min_matches);
    // EQUALITY on a count is the discontinuity class.
    let forbidden = [
        "n_match==",
        "n_matched==",
        "nmatch==",
        "nmatched==",
        "matches.len()==",
        "match_rows.len()==",
        "n_match!=",
        "n_matched!=",
        "matches.len()!=",
    ];

    let mut offenders = Vec::new();
    for f in &files {
        let text = std::fs::read_to_string(f).unwrap();
        for (ln, line) in text.lines().enumerate() {
            let squished: String = code_of(line).split_whitespace().collect();
            for pat in &forbidden {
                if squished.contains(pat) {
                    offenders.push(format!("{}:{}: {}", f.display(), ln + 1, line.trim()));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "exact-count match branches found (acceptance must be the log-odds statistic only):\n{}",
        offenders.join("\n")
    );
}
