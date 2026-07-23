use wasm_bindgen::prelude::*;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct Quad {
    pub indices: [usize; 4],
    pub code: [f64; 4],
}

// Build canonical 4D quad code
pub fn build_quad(p: &[(f64, f64)], idx: &[usize; 4]) -> Option<Quad> {
    // CRITICAL: geometry must come from the four points SELECTED BY idx.
    // The original code read p[0..4] directly, so every combination produced
    // the identical quad of the array's first four points (all quads in one
    // hash bin, bogus correspondences, no genuine matches possible).
    let pts = [p[idx[0]], p[idx[1]], p[idx[2]], p[idx[3]]];

    let mut max_d2 = -1.0;
    let mut ai = 0;
    let mut bi = 1;
    for m in 0..4 {
        for n in m+1..4 {
            let dx = pts[m].0 - pts[n].0;
            let dy = pts[m].1 - pts[n].1;
            let d2 = dx*dx + dy*dy;
            if d2 > max_d2 {
                max_d2 = d2;
                ai = m;
                bi = n;
            }
        }
    }

    let mut others = [0; 2];
    let mut o_idx = 0;
    for m in 0..4 {
        if m != ai && m != bi {
            others[o_idx] = m;
            o_idx += 1;
        }
    }

    let mut idx_a = ai;
    let mut idx_b = bi;
    let mut idx_c = others[0];
    let mut idx_d = others[1];

    let a = pts[idx_a];
    let b = pts[idx_b];
    let c = pts[idx_c];
    let d = pts[idx_d];

    let ux = b.0 - a.0;
    let uy = b.1 - a.1;
    let det = ux * ux + uy * uy;
    if det < 1e-9 { return None; }

    let transform = |pt: (f64, f64)| -> (f64, f64) {
        let dx = pt.0 - a.0;
        let dy = pt.1 - a.1;
        ((dx * ux + dy * uy) / det, (-dx * uy + dy * ux) / det)
    };

    let mut tc = transform(c);
    let mut td = transform(d);

    if tc.0 + td.0 > 1.0 {
        tc = (1.0 - tc.0, -tc.1);
        td = (1.0 - td.0, -td.1);
        std::mem::swap(&mut idx_a, &mut idx_b);
    }

    if tc.0 > td.0 || (tc.0 == td.0 && tc.1 > td.1) {
        std::mem::swap(&mut tc, &mut td);
        std::mem::swap(&mut idx_c, &mut idx_d);
    }

    // Reject degenerate/non-compact quads: canonical codes of useful quads live
    // near the unit box. Huge or non-finite codes carry no geometric information
    // and pile into saturated hash bins.
    let code = [tc.0, tc.1, td.0, td.1];
    if !code.iter().all(|v| v.is_finite() && v.abs() <= 4.0) { return None; }

    Some(Quad {
        indices: [idx[idx_a], idx[idx_b], idx[idx_c], idx[idx_d]],
        code
    })
}

pub fn get_hash_bins(code: &[f64; 4]) -> [i32; 4] {
    let bin = 0.05;
    [
        (code[0] / bin).floor() as i32,
        (code[1] / bin).floor() as i32,
        (code[2] / bin).floor() as i32,
        (code[3] / bin).floor() as i32,
    ]
}

#[wasm_bindgen]
pub fn solve_planar_local(
    det_x: &[f64],
    det_y: &[f64],
    det_ids: &[f64],
    cat_x: &[f64],
    cat_y: &[f64],
    cat_ids: &[f64],
    tolerances: &[f64],
    max_stars: usize,
    logger: Option<js_sys::Function>
) -> Vec<f64> {
    let log_msg = |msg: &str| {
        if let Some(f) = logger.as_ref() {
            let this = wasm_bindgen::JsValue::null();
            let js_msg = js_sys::JsString::from(msg);
            let _ = f.call1(&this, &js_msg);
        }
    };

    let det_n = det_x.len().min(det_y.len()).min(max_stars);
    let mut det_pts = Vec::with_capacity(det_n);
    for i in 0..det_n { det_pts.push((det_x[i], det_y[i])); }

    let cat_n = cat_x.len().min(cat_y.len()).min(max_stars);
    let mut cat_pts = Vec::with_capacity(cat_n);
    for i in 0..cat_n { cat_pts.push((cat_x[i], cat_y[i])); }

    let mut det_quads = Vec::new();
    for i in 0..det_n.saturating_sub(3) {
        for j in i+1..det_n.saturating_sub(2) {
            for k in j+1..det_n.saturating_sub(1) {
                for l in k+1..det_n {
                    if let Some(q) = build_quad(&det_pts, &[i, j, k, l]) {
                        det_quads.push(q);
                    }
                }
            }
        }
    }

    let mut cat_quads = HashMap::new();
    for i in 0..cat_n.saturating_sub(3) {
        for j in i+1..cat_n.saturating_sub(2) {
            for k in j+1..cat_n.saturating_sub(1) {
                for l in k+1..cat_n {
                    if let Some(q) = build_quad(&cat_pts, &[i, j, k, l]) {
                        let bins = get_hash_bins(&q.code);
                        cat_quads.entry(bins).or_insert_with(Vec::new).push(q);
                    }
                }
            }
        }
    }

    let mut results = Vec::new();
    log_msg(&format!(
        "[planar] det_n={} cat_n={} det_quads={} cat_quad_bins={} cat_quads_total={}",
        det_n, cat_n, det_quads.len(), cat_quads.len(),
        cat_quads.values().map(|v| v.len()).sum::<usize>()
    ));

    // Bounded top-K collection: with a dense catalog side, C(cat_n, 4) quads
    // produce enough coincidental sub-tolerance matches to grow an unbounded
    // Vec past isize::MAX (capacity-overflow panic). Keep only the best
    // MAX_KEPT by error, compacting when full.
    const MAX_KEPT: usize = 2000;
    const FINAL_TAKE: usize = 200;

    for &tol in tolerances {
        let mut matches: Vec<[f64; 9]> = Vec::new();
        let mut admit = tol * tol; // shrinks once the buffer has filled

        for dq in &det_quads {
            // PARITY FIX: mirrored fields (negative parity — e.g. FITS
            // bottom-up rows vs. the catalog projection) produce det codes
            // whose y components are NEGATED relative to their catalog twin.
            // The old code computed a mirror distance (d2) but only walked
            // the hash bins of the UNmirrored det code — the mirrored twin
            // lives ~2*|y|/bin bins away and was never retrieved, so true
            // quads on mirrored data could never match. Walk BOTH bin sets.
            let mirrored_code = [dq.code[0], -dq.code[1], dq.code[2], -dq.code[3]];
            let bins_direct = get_hash_bins(&dq.code);
            let bins_mirror = get_hash_bins(&mirrored_code);
            let passes: &[([i32; 4], [f64; 4])] = if bins_mirror == bins_direct {
                &[(bins_direct, dq.code)]
            } else {
                &[(bins_direct, dq.code), (bins_mirror, mirrored_code)]
            };

            for &(bins, code_used) in passes {
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        for dw in -1..=1 {
                            let b = [bins[0]+dx, bins[1]+dy, bins[2]+dz, bins[3]+dw];
                            if let Some(cqs) = cat_quads.get(&b) {
                                for cq in cqs {
                                    // code_used is either the det code (direct
                                    // parity) or its mirror — one L2 distance
                                    // covers both cases per pass.
                                    let mut dist_sq = 0.0;
                                    for i in 0..4 { dist_sq += (code_used[i] - cq.code[i]).powi(2); }

                                    if dist_sq.is_finite() && dist_sq < admit {
                                        matches.push([
                                            det_ids[dq.indices[0]], det_ids[dq.indices[1]], det_ids[dq.indices[2]], det_ids[dq.indices[3]],
                                            cat_ids[cq.indices[0]], cat_ids[cq.indices[1]], cat_ids[cq.indices[2]], cat_ids[cq.indices[3]],
                                            dist_sq
                                        ]);
                                        if matches.len() >= MAX_KEPT {
                                            matches.sort_by(|a, b| a[8].partial_cmp(&b[8]).unwrap_or(std::cmp::Ordering::Equal));
                                            matches.truncate(MAX_KEPT / 2);
                                            admit = matches[matches.len() - 1][8];
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            } // end parity passes
        }

        log_msg(&format!("[planar] tol={} -> {} raw matches", tol, matches.len()));
        if !matches.is_empty() {
            matches.sort_by(|a, b| a[8].partial_cmp(&b[8]).unwrap_or(std::cmp::Ordering::Equal));
            for m in matches.into_iter().take(FINAL_TAKE) {
                results.extend_from_slice(&m);
            }
            break;
        }
    }

    results
}
