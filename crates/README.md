# SkyCruncher greenfield solver core (`crates/`)

Standalone native Rust plate-solver: detections in → verified WCS out, consuming the
`starplates-2026.07-quadidx-g15u` Arrow quad index directly (mmap, typed columns), with
astrometry.net's control loop. Plan of record: the approved build plan of 2026-07-20 (rev 2,
post-Fable-review); architecture blueprint:
`docs/04-research/SOLVER_ARCHITECTURE_AUDIT_AND_TARGET_DESIGN_2026-07-20.md`.

## Building (IMPORTANT — cwd matters)

`cargo` is not on PATH on this box, and `.cargo/config.toml` (which routes the multi-GB target
dir to `D:/AstroLogic/cargo_target/solver-core` — K: is a thin virtual disk — and sets
`-C target-cpu=native`) is discovered **from the current directory upward**. Always build via:

```cmd
crates\build.cmd build --release
crates\build.cmd test
```

or `cd` into `crates/` first. Do NOT use `--manifest-path` from another cwd: it silently drops
the target-dir and rustflags. `build.rs` embeds the actual build flags into the binary so every
receipt records what was really compiled.

## Crates

- `solver-contracts` — types only: SolveRequest/SolveConfig/SolveResult/SolveReceipt, coordinate
  newtypes, versions. No I/O.
- `solver-core` — the solver: index reader (zero-copy mmap), coder, prep, quad-gen, verify,
  refine, runtime. **No env reads anywhere in this crate** (config arrives resolved from the CLI).
- `solver-cli` — the only executable: `solve`, `batch`, `corpus`, `inspect-release`,
  `golden-extract`, `desk-check`. Parses env/flags into an immutable `SolveConfig` (the ONLY
  place environment is read).

This is a **nested** Cargo workspace, deliberately independent of the repo-root workspace
(nearest-`[workspace]`-wins; the root manifest is not modified).
