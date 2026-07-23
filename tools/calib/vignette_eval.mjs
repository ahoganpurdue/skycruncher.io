// ═══════════════════════════════════════════════════════════════════════════
// SHARED VIGNETTE → TRANSMISSION EVALUATOR (tools/calib interchange lane)
// ═══════════════════════════════════════════════════════════════════════════
// Bridges the TWO vignette conventions the flat-FITS interchange must speak:
//
//   • our internal a2/a4 GAIN model (src/engine/pipeline/m10_psf/vignette_map.ts):
//       gain(r) = 1 + a2·r² + a4·r⁴   — a flux-RECOVERY multiplier, so
//       corrected_flux = measured_flux · gain(r).  The physical TRANSMISSION that
//       a flat records is the RECIPROCAL:  T(r) = 1 / gain(r)  ∈ (0,1].
//       (Matches vignette_map.transmissionAt() by construction.)
//
//   • the lensfun "pa" ATTENUATION model (m2_hardware/lensfun_ingestor.ts):
//       att(r) = 1 + k1·r² + k2·r⁴ + k3·r⁶   — which IS the transmission directly,
//       so measured_flux = ideal_flux · att(r)  and  corrected = measured / att(r).
//
// Both are exactly 1.0 at the optical center (r = 0) by construction. `r` is
// normalized to the HALF-DIAGONAL (r = 1 at the image corner) — the shared
// vignette_map + hugin/lensfun stored-coefficient convention, verified in the
// row-509 artifact (D:/AstroLogic/test_artifacts/vignette_prior_check_2026-07-22/
// deviation_stats.json: "half-diagonal, r=1 at image corner").
//
// PURE, no I/O. This is a faithful restatement of the two PUBLISHED model formulas
// (not a re-derivation): the interchange must emit them regardless of what the
// engine does at runtime. LAW 1: PIXEL-plane / prior data only; touches no
// measurement path.

/**
 * @typedef {{ kind: 'gain', a2: number, a4: number }} GainModel
 * @typedef {{ kind: 'pa', k1: number, k2: number, k3: number }} PaModel
 * @typedef {GainModel | PaModel} VignetteModel
 */

/**
 * Transmission ∈ (0,1] at a normalized r² (r² = (dx²+dy²)/halfDiag², so r²=1 at
 * the corner). Center (r²=0) → 1 for both model kinds.
 * @param {VignetteModel} model
 * @param {number} r2
 * @returns {number}
 */
export function transmissionAtR2(model, r2) {
    if (model.kind === 'gain') {
        const g = 1 + model.a2 * r2 + model.a4 * r2 * r2;
        return g > 0 ? 1 / g : 0;
    }
    if (model.kind === 'pa') {
        return 1 + model.k1 * r2 + model.k2 * r2 * r2 + model.k3 * r2 * r2 * r2;
    }
    throw new Error(`vignette_eval: unknown model.kind ${model && model.kind}`);
}

/**
 * Render a full transmission plane (Float32, row-major w·h), normalized to EXACTLY
 * 1.0 at the optical center. `center` defaults to the geometric center and
 * `halfDiagPx` to hypot(cx,cy) so r=1 lands at the corner (the vignette_map/lensfun
 * convention). The explicit center-divide guarantees the 1.0-at-center invariant
 * even if a model is fed that is not identically 1 at r=0.
 * @param {{ w: number, h: number, model: VignetteModel,
 *           center?: { cx: number, cy: number }, halfDiagPx?: number }} spec
 * @returns {Float32Array}
 */
export function renderFlatPlane({ w, h, model, center, halfDiagPx }) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        throw new Error(`renderFlatPlane: bad dims ${w}x${h}`);
    }
    const cx = center ? center.cx : (w - 1) / 2;
    const cy = center ? center.cy : (h - 1) / 2;
    const hd = halfDiagPx || Math.hypot(cx, cy) || 1;
    const hd2 = hd * hd;
    const centerT = transmissionAtR2(model, 0) || 1; // = 1 for both models; guard div-by-0
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const dy = y - cy;
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const dx = x - cx;
            const r2 = (dx * dx + dy * dy) / hd2;
            out[row + x] = transmissionAtR2(model, r2) / centerT;
        }
    }
    return out;
}

/**
 * Build gain-model bands from a vignette_map.ts map (or its serialized form).
 * `which` = 'rgb' → 3 chromatic planes; 'luma' → a single achromatic plane.
 * @param {{ r:{a2:number,a4:number}, g:{a2:number,a4:number}, b:{a2:number,a4:number}, luma:{a2:number,a4:number} }} map
 * @param {'rgb'|'luma'} [which='rgb']
 * @returns {{ name: string, model: GainModel }[]}
 */
export function bandsFromVignetteMap(map, which = 'rgb') {
    const g = (f) => ({ kind: 'gain', a2: +f.a2, a4: +f.a4 });
    if (which === 'luma') return [{ name: 'luma', model: g(map.luma) }];
    return [
        { name: 'R', model: g(map.r) },
        { name: 'G', model: g(map.g) },
        { name: 'B', model: g(map.b) },
    ];
}

/**
 * Build a single pa-model band from an ingested lensfun breakpoint.
 * @param {{ k1:number, k2:number, k3:number }} bp
 * @param {string} [name='pa']
 * @returns {{ name: string, model: PaModel }[]}
 */
export function bandFromLensfunPA(bp, name = 'pa') {
    return [{ name, model: { kind: 'pa', k1: +bp.k1, k2: +bp.k2, k3: +bp.k3 } }];
}
