//! runtime — budgets, cancellation, and decision-retirement order (M4b lane).
//!
//! Audit §Budgets and cancellation: every request carries one shared runtime object with
//!   - a HARD deadline (the whole solve) and a SEARCH deadline (hard minus the verify/refine
//!     reserve — search may never consume the time reserved for judging an accepted pose);
//!   - a cancellation flag checked inside every bounded loop (candidate draw, ref gather,
//!     refine iterations) — never only after a long call returns;
//!   - explicit terminal states; a truncated search is telemetry, never a veto.
//!
//! Retirement order (plan rev 2 §Runtime + determinism): every hypothesis receives a
//! canonical sequence number at draw time and decisions RETIRE in that order. v0 is
//! single-threaded so retirement is trivially in-order, but the cursor exists and is
//! asserted so a future `parallel` execution plan can only change wall-clock, never
//! decisions (ExecutionPlan may NEVER alter semantics).
//!
//! No env reads (crate-wide grep-guard). No I/O.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use solver_contracts::config::SearchPolicy;

/// Shared per-solve runtime: deadlines + cancellation. Immutable after construction except
/// the atomic flag, so it can be shared `&SolveRuntime` across threads (cancellation from a
/// controller thread while the solve runs).
#[derive(Debug)]
pub struct SolveRuntime {
    pub started: Instant,
    /// The whole-solve deadline (budget_ms).
    pub hard_deadline: Instant,
    /// Search must stop drawing candidates here: hard − verify_reserve_frac·budget.
    pub search_deadline: Instant,
    cancelled: AtomicBool,
}

impl SolveRuntime {
    pub fn new(budget_ms: u64, verify_reserve_frac: f64) -> Self {
        let started = Instant::now();
        Self::with_start(started, budget_ms, verify_reserve_frac)
    }

    pub fn with_start(started: Instant, budget_ms: u64, verify_reserve_frac: f64) -> Self {
        let budget = Duration::from_millis(budget_ms);
        let reserve_frac = verify_reserve_frac.clamp(0.0, 1.0);
        let search_ms = (budget_ms as f64) * (1.0 - reserve_frac);
        let search = Duration::from_millis(search_ms.max(0.0) as u64);
        Self {
            started,
            hard_deadline: started + budget,
            search_deadline: started + search,
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn from_policy(p: &SearchPolicy) -> Self {
        Self::new(p.budget_ms, p.verify_reserve_frac)
    }

    /// Request cancellation (any thread). Store is SeqCst — cancellation is rare and must
    /// publish immediately; loads on the hot path are Relaxed (a bounded number of extra
    /// iterations after cancel is acceptable and documented).
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    #[inline]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn search_expired(&self) -> bool {
        Instant::now() >= self.search_deadline
    }

    #[inline]
    pub fn hard_expired(&self) -> bool {
        Instant::now() >= self.hard_deadline
    }

    #[inline]
    pub fn wall_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// Canonical hypothesis sequencing + in-order retirement (v0 scaffold).
///
/// `next_seq()` hands out sequence numbers in canonical draw order; `retire(seq)` asserts
/// decisions complete in exactly that order. Single-threaded v0 satisfies this trivially;
/// the assertion is the structural hook that keeps a future parallel executor
/// decision-identical (out-of-order retirement is a loud panic, not a silent reorder).
#[derive(Debug, Default)]
pub struct RetirementCursor {
    next_assign: u64,
    next_retire: u64,
}

impl RetirementCursor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Assign the next canonical sequence number.
    #[inline]
    pub fn next_seq(&mut self) -> u64 {
        let s = self.next_assign;
        self.next_assign += 1;
        s
    }

    /// Retire a decided hypothesis. MUST be called in assignment order.
    #[inline]
    pub fn retire(&mut self, seq: u64) {
        assert_eq!(
            seq, self.next_retire,
            "retirement order violation: retiring seq {} but cursor expects {} — \
             parallel execution changed decision order (ExecutionPlan must never alter semantics)",
            seq, self.next_retire
        );
        self.next_retire += 1;
    }

    #[inline]
    pub fn assigned(&self) -> u64 {
        self.next_assign
    }

    #[inline]
    pub fn retired(&self) -> u64 {
        self.next_retire
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadlines_ordered() {
        let rt = SolveRuntime::new(1000, 0.15);
        assert!(rt.search_deadline <= rt.hard_deadline);
        assert!(!rt.is_cancelled());
        rt.cancel();
        assert!(rt.is_cancelled());
    }

    #[test]
    fn retirement_in_order() {
        let mut c = RetirementCursor::new();
        let a = c.next_seq();
        let b = c.next_seq();
        c.retire(a);
        c.retire(b);
        assert_eq!(c.retired(), 2);
    }

    #[test]
    #[should_panic(expected = "retirement order violation")]
    fn retirement_out_of_order_panics() {
        let mut c = RetirementCursor::new();
        let _a = c.next_seq();
        let b = c.next_seq();
        c.retire(b);
    }
}
