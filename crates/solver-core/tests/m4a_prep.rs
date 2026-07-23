//! M4a prep unit tests — the M-1 frozen pool policy against hand-computed cases:
//! validity cull, UNION priority + peak-arm promotion, dedup strictness + survivor
//! mapping, round-robin uniformize order, counters.

use solver_contracts::config::SearchPolicy;
use solver_contracts::request::Detection;
use solver_core::prep::{prepare, PreparedFrame};

fn det(id: u32, x: f64, y: f64, flux: f64, peak: f64) -> Detection {
    Detection { id, x, y, flux, peak_value: peak, fwhm: 3.0, snr: 10.0 }
}

fn policy() -> SearchPolicy {
    SearchPolicy::default() // dedup 4.0, grid 10x10, peak_arm_weight 2 — M-1 frozen
}

fn order(p: &PreparedFrame) -> Vec<u32> {
    p.det_id.clone()
}

#[test]
fn validity_cull() {
    let dets = vec![
        det(0, 10.0, 10.0, 5.0, 0.1),
        det(1, f64::NAN, 10.0, 5.0, 0.1),  // NaN x
        det(2, 10.0, f64::NAN, 5.0, 0.1),  // NaN y
        det(3, 10.0, 10.0, f64::NAN, 0.1), // NaN flux
        det(4, 10.0, 10.0, 0.0, 0.1),      // flux == 0
        det(5, 10.0, 10.0, -1.0, 0.1),     // flux < 0
        det(6, -0.1, 10.0, 5.0, 0.1),      // x < 0
        det(7, 1000.0, 10.0, 5.0, 0.1),    // x == W (out)
        det(8, 10.0, 999.9, 5.0, 0.1),     // in (y < H)
        det(9, 500.0, 1000.0, 5.0, 0.1),   // y == H (out)
    ];
    let p = prepare(&dets, 1000, 1000, &policy());
    assert_eq!(p.counters.raw, 10);
    assert_eq!(p.counters.valid, 2, "only ids 0 and 8 pass the validity cull");
    assert_eq!(p.counters.pool, 2);
    let mut ids = order(&p);
    ids.sort_unstable();
    assert_eq!(ids, vec![0, 8]);
}

#[test]
fn union_priority_and_peak_promotion() {
    // One cell (all near origin, well separated > 4 px):
    //   A(id 0): flux 10, peak 0.1 -> rank_flux 0, rank_peak 2 -> prio min(0, 4) = 0 (flux arm)
    //   B(id 1): flux 5,  peak 0.9 -> rank_flux 1, rank_peak 0 -> prio min(1, 0) = 0 (peak arm, strict)
    //   C(id 2): flux 1,  peak 0.5 -> rank_flux 2, rank_peak 1 -> prio min(2, 2) = 2 (tie -> NOT promoted)
    // priority ties (A, B at 0) break by id asc -> A, B, C.
    let dets = vec![
        det(0, 10.0, 10.0, 10.0, 0.1),
        det(1, 30.0, 10.0, 5.0, 0.9),
        det(2, 50.0, 10.0, 1.0, 0.5),
    ];
    let p = prepare(&dets, 1000, 1000, &policy());
    assert_eq!(order(&p), vec![0, 1, 2]);
    assert_eq!(p.counters.peak_arm_promoted, 1, "only B strictly promoted by the peak arm");
    assert_eq!(p.uni_rank, vec![1, 2, 3]);
    assert_eq!(p.rank_of(1), Some(2));
    assert_eq!(p.pool_index_of(2), Some(2));
}

#[test]
fn dedup_strict_radius_and_survivor_mapping() {
    // B sits 3.9 px from A (deduped, A survives — A has higher flux priority);
    // C sits exactly 4.0 px from A (strict <, so KEPT).
    let dets = vec![
        det(0, 100.0, 100.0, 10.0, 0.0),
        det(1, 103.9, 100.0, 5.0, 0.0),
        det(2, 104.0, 100.0, 4.0, 0.0),
        det(3, 500.0, 500.0, 1.0, 0.0),
    ];
    let p = prepare(&dets, 1000, 1000, &policy());
    assert_eq!(p.counters.valid, 4);
    assert_eq!(p.counters.deduped, 1);
    assert_eq!(p.counters.pool, 3);
    assert_eq!(p.survivors.len(), 1);
    assert_eq!(p.survivors[0].dropped_id, 1);
    assert_eq!(p.survivors[0].kept_id, 0);
    assert_eq!(p.resolve_kept(1), Some(0), "dropped resolves to survivor");
    assert_eq!(p.resolve_kept(0), Some(0), "kept resolves to itself");
    assert_eq!(p.resolve_kept(99), None, "unknown id resolves to None");
    assert_eq!(p.rank_of(1), None, "dropped id has no pool rank");
    let mut ids = order(&p);
    ids.sort_unstable();
    assert_eq!(ids, vec![0, 2, 3]);
}

#[test]
fn dedup_priority_order_decides_survivor() {
    // Same positions, but the SECOND detection has the higher priority — it must survive.
    let dets = vec![
        det(0, 100.0, 100.0, 5.0, 0.0),
        det(1, 103.0, 100.0, 10.0, 0.0),
    ];
    let p = prepare(&dets, 1000, 1000, &policy());
    assert_eq!(p.counters.pool, 1);
    assert_eq!(p.det_id, vec![1]);
    assert_eq!(p.survivors[0].dropped_id, 0);
    assert_eq!(p.survivors[0].kept_id, 1);
}

#[test]
fn uniformize_round_robin_order() {
    // 1000x1000 frame, 10x10 grid => 100 px cells.
    // Cell (0,0): a1 (flux 100), a2 (flux 1). Cell (5,0): b1 (flux 50), b2 (flux 2).
    // Pass 1 = {a1, b1} sorted by priority -> a1, b1. Pass 2 = {a2, b2} -> b2, a2.
    // Expected uniformized order: a1(10), b1(11), b2(13), a2(12).
    let dets = vec![
        det(10, 10.0, 10.0, 100.0, 0.0),
        det(12, 50.0, 10.0, 1.0, 0.0),
        det(11, 510.0, 10.0, 50.0, 0.0),
        det(13, 550.0, 10.0, 2.0, 0.0),
    ];
    let p = prepare(&dets, 1000, 1000, &policy());
    assert_eq!(order(&p), vec![10, 11, 13, 12]);
    assert_eq!(p.uni_rank, vec![1, 2, 3, 4]);
}

#[test]
fn nonfinite_peak_ranks_last_in_peak_arm() {
    // NaN peak must not hijack the descending peak sort (guard maps it to -inf).
    let dets = vec![
        det(0, 10.0, 10.0, 10.0, f64::NAN),
        det(1, 30.0, 10.0, 1.0, 0.5),
    ];
    let p = prepare(&dets, 1000, 1000, &policy());
    // flux arm: 0 then 1. peak arm: 1 (0.5) then 0 (-inf).
    // prio(0) = min(0, 2*1) = 0; prio(1) = min(1, 0) = 0; tie -> id asc.
    assert_eq!(order(&p), vec![0, 1]);
    assert_eq!(p.counters.peak_arm_promoted, 1, "det 1 promoted; NaN-peak det 0 not");
}
