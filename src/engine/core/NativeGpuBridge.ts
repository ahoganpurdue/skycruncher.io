import { invoke } from '@tauri-apps/api/core';

/**
 * Bridge to the native Tauri/wgpu backend.
 *
 * HONEST STATUS (docs/NEXT_MOVES.md §14.f): the intended design was
 * "full-resolution pixel data never crosses IPC" via u64 buffer handles —
 * that protocol was NEVER COMPLETED. What exists today:
 *  - `demosaic()` transfers the FULL Bayer buffer across IPC as RAW BYTES
 *    (Tauri v2 raw payload → `InvokeBody::Raw`, dims in headers; the f32 frame
 *    returns via `tauri::ipc::Response`). The old `Array.from` JSON smuggling
 *    (a 24MP Uint16Array became a ~96MB JSON string, 300-700MB round-trips) was
 *    retired 2026-07-11 (§14.c). Pixel data STILL crosses IPC (once, as bytes) —
 *    the handle-based "never crosses" design remains unbuilt.
 *  - The handle API below (`registerBuffer`/`releaseBuffer`) registers data by
 *    sending it across IPC, and the consumer commands the design implies
 *    (`run_demosaic(handle)`, `get_preview(handle)`) DO NOT EXIST — no Rust
 *    command reads a registered buffer, and this class has zero production
 *    callers.
 * Do not build on the handle API as-is; fold it into the §14.c raw-bytes
 * (`tauri::ipc::Response`) redesign first.
 *
 * [Module: M3] [Domain: MemoryResidency] JS_HEAP -> NATIVE_GPU_VRAM
 */
export class NativeGpuBridge {
    /**
     * Returns true if running in a native Tauri environment with wgpu support.
     */
    static async isNative(): Promise<boolean> {
        try {
            return await invoke<boolean>('is_native');
        } catch {
            return false;
        }
    }

    /**
     * Dispatch demosaic to the native wgpu backend over RAW-BYTES IPC
     * (docs/NEXT_MOVES.md §14.c; LAW 7 binary_layouts#tauri_native_ipc).
     *
     * The Bayer buffer is sent as a raw little-endian `Uint8Array` body (Tauri v2
     * raw payload → `InvokeBody::Raw`), with the dims carried in the `width`/
     * `height` invoke headers; the native side returns the demosaiced interleaved-RGB
     * f32 frame (`width*height*3`) as raw bytes (`tauri::ipc::Response` → `ArrayBuffer`).
     * This retires the `Array.from()` JSON smuggling (a 24MP Uint16Array became a
     * ~96MB JSON string, and the f32 result returned the same way — 300-700MB
     * round-trips), mirroring the `query_catalog_v2` binary path. Output shape matches
     * the browser/CPU demosaic paths (RGB w·h·3) — see LAW 7 binary_layouts#tauri_native_ipc.
     */
    static async demosaic(bayerData: Uint16Array, width: number, height: number): Promise<Float32Array> {
        // Raw LE u16 body: a byte view over EXACTLY this Uint16Array's region
        // (respects byteOffset/byteLength when it is a view into a larger Arrow buffer).
        const bayerBytes = new Uint8Array(bayerData.buffer, bayerData.byteOffset, bayerData.byteLength);
        const responseBuffer = await invoke<ArrayBuffer>('demosaic_native', bayerBytes, {
            headers: { width: String(width), height: String(height) },
        });
        // Native side returns raw LE f32 bytes (interleaved RGB, width*height*3).
        return new Float32Array(responseBuffer);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // HANDLE-BASED API — INCOMPLETE DESIGN STUB, zero production callers
    // (docs/NEXT_MOVES.md §14.f). Registration itself ships the bytes across
    // IPC, and nothing on the Rust side ever consumes a stored buffer.
    // NOT a zero-copy protocol as wired.
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    /**
     * Register a binary buffer in the Rust-side registry. Returns a u64
     * handle. HONEST: `Array.from(data)` sends the full buffer across IPC as
     * JSON to get it into Rust memory, and no existing command consumes the
     * handle afterwards — see the class-level status note.
     */
    static async registerBuffer(data: Uint8Array): Promise<number> {
        return invoke<number>('register_buffer', {
            data: Array.from(data)
        });
    }

    /**
     * Release a buffer handle when it is no longer needed.
     * Returns true if the handle existed.
     */
    static async releaseBuffer(handle: number): Promise<boolean> {
        return invoke<boolean>('release_buffer', { handle });
    }

    /**
     * Get diagnostics about the buffer registry.
     * Returns [activeCount, totalBytes].
     */
    static async bufferDiagnostics(): Promise<[number, number]> {
        return invoke<[number, number]>('buffer_diagnostics');
    }
}
