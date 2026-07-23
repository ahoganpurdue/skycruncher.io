//! solver-core — the greenfield native plate solver.
//!
//! HARD RULE (audit P0-5): no environment reads anywhere in this crate. Configuration arrives
//! as one immutable, fully-resolved `solver_contracts::config::SolveConfig` from the CLI
//! boundary. A grep-guard test enforces this.
//!
//! Module map (plan rev 2):
//!   index       — g15u release: manifest, checksums/stamp, mmap zero-copy Arrow, prefix-table
//!                 key lookup (M1)
//!   stars       — dec-ring/RA-bucket CSR spatial grid over stars.arrow; per-cell brightest-k (M1)
//!   geom        — unit vectors, gnomonic (builder-convention, degrees), mean direction (M2)
//!   coder       — canonical quad coder (coder.mjs buildQuadCodes semantics, bit-exact) (M2)
//!   verify      — a.net real_verify_star_lists port (decision-identity vs TS oracle) (M3)
//!   prep        — detection validity/dedup/UNION-priority/uniformize (M-1 frozen policy) (M4a)
//!   quadgen     — incremental det-quad generation + sky-true band targeting + re-tangent coding (M4a)
//!   coordinator — the immediate-verification control loop (M4b)
//!   hypo        — Kabsch pose fit + cheap gates (M4b)
//!   refine      — sigma-clipped TAN refine + independent rematch/rejudge (M4b)
//!   runtime     — budgets, cancellation, retirement order (M4b)

pub mod build_info;
// Lane ownership (parallel agents, disjoint file sets — seams carved by the orchestrator):
pub mod index; // M1: index/{manifest,mmap_arrow,band,probe,release_verify}.rs
pub mod stars; // M1: stars.rs
pub mod geom; // M2: geom.rs
pub mod coder; // M2: coder.rs
pub mod verify; // M3: verify.rs
pub mod prep; // M4a
pub mod quadgen; // M4a
pub mod coordinator; // M4b
pub mod hypo; // M4b
pub mod refine; // M4b
pub mod runtime; // M4b
pub mod deskcheck; // M4.5: ORACLE_ASSISTED truth-family desk-check (off the blind path)

pub use solver_contracts as contracts;
