// Type surface for tools/stack/fits_io.mjs consumed from TypeScript (mirrors
// the batch_plan.d.mts pattern). Only the members the batch stack step uses.
export function writeFitsPlanar(
    outPath: string,
    planes: ArrayLike<number>[],
    W: number,
    H: number,
    cards?: Array<[string, string | number | boolean, string?]>
): void;

/** Eats an ENGINE-convention WCS (crval[0] HOURS, flat cd [a,b,c,d]) and does
 *  the ×15 HOURS→degrees conversion ITSELF — see the DE-DUPE SEAM note in
 *  fits_io.mjs (never feed it a receipt.wcs, which is already degrees). */
export function wcsCards(wcs: {
    crval: [number, number];
    crpix: [number, number];
    cd: [number, number, number, number];
}): Array<[string, string | number, string?]>;
