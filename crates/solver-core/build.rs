// Embed the ACTUAL build configuration into the binary so receipts stamp what was really
// compiled (Fable systems review MAJOR-2: config discovery is cwd-based and can silently drop
// rustflags — drift must be loud, not assumed).
fn main() {
    let rustflags = std::env::var("CARGO_ENCODED_RUSTFLAGS")
        .map(|s| s.replace('\u{1f}', " "))
        .unwrap_or_default();
    println!("cargo:rustc-env=SOLVER_BUILD_RUSTFLAGS={rustflags}");
    println!(
        "cargo:rustc-env=SOLVER_BUILD_OPT_LEVEL={}",
        std::env::var("OPT_LEVEL").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=SOLVER_BUILD_TARGET={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=SOLVER_BUILD_PROFILE={}",
        std::env::var("PROFILE").unwrap_or_default()
    );
}
