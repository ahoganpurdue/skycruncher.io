/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IMAGE-DATA-LIKE — headless-safe ImageData construction (I1.3, Toolchest API)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Node has no global ImageData constructor. The session's solve path only
 * ever READS `width`/`height` and indexes `data[i]` on the object it builds
 * (verified: runSolve/solvePlate/verifyWCS consume width/height; pixel bytes
 * are read via indexed access in planetary_verification and — only when no
 * curated detections are forwarded — SourceExtractor), so a structural
 * stand-in is safe where the browser class is absent.
 *
 * In the browser this returns a REAL `new ImageData(...)` — byte-identical
 * behavior by construction.
 */

/** Structural subset of ImageData that headless consumers rely on. */
export interface ImageDataLike {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/**
 * Construct an ImageData: the real class when the global exists (browser),
 * else a structurally-identical plain object (Node / headless drivers).
 */
export function makeImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
    if (typeof ImageData !== 'undefined') {
        // Cast: lib.dom types the ctor as Uint8ClampedArray<ArrayBuffer>
        // (ImageDataArray); our buffers are always ArrayBuffer-backed.
        return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h);
    }
    return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
}
