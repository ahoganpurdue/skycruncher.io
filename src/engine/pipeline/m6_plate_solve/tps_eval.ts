// ═══════════════════════════════════════════════════════════════════════════
// TPS EVALUATION PRIMITIVES — pure, ZERO imports (Math only)
// ═══════════════════════════════════════════════════════════════════════════
//
// One implementation of the thin-plate-spline forward evaluation, shared by:
//   - tps_fitter.ts (the M6 engine fit-core — transitively wasm-bearing), and
//   - export/asdf_writer.ts (the ASDF serializer, a deliberately engine-free leaf
//     that must run under plain `tsx` with NO wasm on the import chain).
// Keeping these here (not in tps_fitter) lets the serializer bake its GWCS
// tabular lookup from the IDENTICAL evaluator without dragging the engine/wasm
// into the pure byte path (LAW 4: one implementation, no code in two places).

/** U(r) = r²·ln r (natural log), U(0)=0. Inputs are coordinate DELTAS. */
export function tpsKernel(du: number, dv: number): number {
    const r2 = du * du + dv * dv;
    if (r2 <= 0) return 0;
    return 0.5 * r2 * Math.log(r2); // r²·ln r ≡ ½ r²·ln r²
}

/**
 * Evaluate the fitted field f(ũ,ṽ) = a0 + a1·ũ + a2·ṽ + Σ w_i·U(‖p̃ − p̃_i‖) at a
 * NORMALIZED coordinate (p̃ = (pixel − crpix)/scale). Returns the displacement in
 * the field's own units (pixels, as fitted). `un`/`vn` are the normalized control
 * coordinates; `w` the spline weights; `affine` the [a0,a1,a2] polynomial part.
 */
export function evalTpsField(
    u: number, v: number,
    un: number[], vn: number[], w: number[], affine: [number, number, number],
): number {
    let s = affine[0] + affine[1] * u + affine[2] * v;
    for (let i = 0; i < un.length; i++) s += w[i] * tpsKernel(u - un[i], v - vn[i]);
    return s;
}
