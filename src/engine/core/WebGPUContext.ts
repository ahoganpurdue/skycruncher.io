/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WEBGPU CONTEXT — Singleton GPU Device Manager
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * 
 * Provides a cached GPUDevice for all compute shader dispatches.
 * Handles feature detection and implements a "Nuclear Fix" (monkeypatching)
 * to force shared device usage across libraries like ONNX Runtime.
 */

let cachedDevice: GPUDevice | null = null;
let initPromise: Promise<GPUDevice | null> | null = null;
let monkeyPatchApplied = false;

/**
 * [COMPUTE-ROUTE OBSERVABILITY] The specific branch the LAST init() attempt took.
 * Consumers (the demosaic/preview compute-route stamps) read this synchronously
 * right after an awaited init() that returned null, to record WHY GPU compute was
 * unavailable (specific branch, never a generic "no GPU"). 'ok' once a device is
 * acquired. Diagnostic only — never a gate input.
 */
export type WebGpuInitReason =
    | 'ok'
    | 'no_navigator'       // typeof navigator === 'undefined' (bare non-browser host)
    | 'no_navigator_gpu'   // navigator present but navigator.gpu absent (WebGPU unsupported)
    | 'no_adapter'         // requestAdapter() returned null (no suitable GPU)
    | 'init_threw';        // requestAdapter/requestDevice threw
let lastInitReason: WebGpuInitReason | null = null;

export class WebGPUContext {

    /**
     * Initialize the WebGPU device. Caches the result for subsequent calls.
     * Implements a monkeypatch on GPUAdapter to solve ORT device mismatch.
     */
    public static async init(): Promise<GPUDevice | null> {
        if (cachedDevice) return cachedDevice;
        if (initPromise) return initPromise;

        initPromise = (async () => {
            try {
                if (typeof navigator === 'undefined') {
                    lastInitReason = 'no_navigator';
                    console.warn('[WebGPUContext] navigator not available (non-browser host). GPU compute disabled.');
                    return null;
                }
                if (!navigator.gpu) {
                    lastInitReason = 'no_navigator_gpu';
                    console.warn('[WebGPUContext] navigator.gpu not available (WebGPU unsupported). GPU compute disabled.');
                    return null;
                }

                const adapter = await navigator.gpu.requestAdapter({
                    powerPreference: 'high-performance'
                });

                if (!adapter) {
                    lastInitReason = 'no_adapter';
                    console.warn('[WebGPUContext] No suitable GPU adapter found. GPU compute disabled.');
                    return null;
                }

                // Apply Global Monkeypatch to force device sharing
                // This is the "Nuclear Fix" to prevent ORT from creating its own device.
                this.applyNuclearFix(adapter);

                // Request primary compute device
                cachedDevice = await adapter.requestDevice({
                    label: 'SkyCruncher_Primary_Compute',
                    requiredFeatures: [],
                    requiredLimits: {
                        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                        maxBufferSize: adapter.limits.maxBufferSize,
                        maxComputeWorkgroupSizeX: 16,
                        maxComputeWorkgroupSizeY: 16,
                    }
                });

                // Handle device loss
                cachedDevice.lost.then((info) => {
                    console.error(`[WebGPUContext] GPU device lost: ${info.message} (reason: ${info.reason})`);
                    cachedDevice = null;
                    initPromise = null; 
                    monkeyPatchApplied = false; // Reset mask to allow re-patch if needed
                });

                lastInitReason = 'ok';
                console.log(`[WebGPUContext] GPU device initialized (maxBufferSize: ${(adapter.limits.maxBufferSize / 1024 / 1024).toFixed(0)}MB)`);
                return cachedDevice;

            } catch (err) {
                lastInitReason = 'init_threw';
                console.warn('[WebGPUContext] WebGPU initialization failed:', err);
                initPromise = null;
                return null;
            }
        })();

        return initPromise;
    }

    /**
     * Intercepts requestDevice calls to ensure libraries like ONNX Runtime
     * use our exact GPUDevice instance, preventing device mismatch errors.
     */
    private static applyNuclearFix(adapter: any) {
        if (monkeyPatchApplied) return;
        
        console.log("[WebGPUContext] Applying Nuclear Fix: Monkeypatching GPUAdapter.requestDevice...");
        
        const originalRequestDevice = adapter.constructor.prototype.requestDevice;
        adapter.constructor.prototype.requestDevice = async function(descriptor?: GPUDeviceDescriptor) {
            // If we already have a device, return it regardless of the parameters
            // This forces libraries that call requestDevice internally to share ours.
            if (cachedDevice) {
                console.log(`[WebGPUContext] Intercepted requestDevice call. Returning singleton (label: ${cachedDevice.label})`);
                return cachedDevice;
            }
            
            // Otherwise, fall back to the original implementation to create the singleton
            return originalRequestDevice.apply(this, [descriptor]);
        };
        
        monkeyPatchApplied = true;
    }

    public static isAvailable(): boolean {
        return cachedDevice !== null;
    }

    /**
     * [COMPUTE-ROUTE OBSERVABILITY] The branch the LAST init() attempt took. Read
     * synchronously after an awaited init() that returned null to build a SPECIFIC
     * compute-route reason (no generic "no GPU"). null before any init attempt.
     */
    public static getLastInitReason(): WebGpuInitReason | null {
        return lastInitReason;
    }

    public static getDevice(): GPUDevice | null {
        return cachedDevice;
    }

    public static reset(): void {
        cachedDevice = null;
        initPromise = null;
        monkeyPatchApplied = false;
        lastInitReason = null;
    }
}
