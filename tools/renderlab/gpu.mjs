// gpu.mjs — WebGPU bootstrap + honest fallback + optional GPU timestamp timing.
//
// LAW 3 (honest-or-absent): a missing adapter/device NEVER leaves a blank
// canvas — boot throws GpuUnavailableError and main.mjs renders the DOM
// fallback message. GPU pass timing is only reported when the adapter
// actually exposes 'timestamp-query'; otherwise the HUD shows "--".

export class GpuUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'GpuUnavailableError';
  }
}

/**
 * Request adapter + device and configure the canvas context.
 * Throws GpuUnavailableError with a human-readable reason on any gap.
 */
export async function initWebGPU(canvas) {
  if (!('gpu' in navigator)) {
    throw new GpuUnavailableError('navigator.gpu is not present (browser has no WebGPU).');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new GpuUnavailableError('requestAdapter() returned null (no usable GPU adapter).');
  }

  const hasTimestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: hasTimestamps ? ['timestamp-query'] : [],
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new GpuUnavailableError('canvas.getContext("webgpu") returned null.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { adapter, device, context, format, hasTimestamps };
}

/**
 * GpuTimer — real render-pass time via timestamp queries when the feature
 * exists. lastMs stays null (HUD prints "--") when it does not. Never fakes
 * a number.
 */
export class GpuTimer {
  constructor(device, enabled) {
    this.enabled = !!enabled;
    this.lastMs = null;
    this._mapPending = false;
    if (!this.enabled) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    this.resolveBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /** Attach to a render pass descriptor; undefined when timing is unavailable. */
  passTimestampWrites() {
    if (!this.enabled) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /** Call after pass.end(), before queue.submit(). */
  resolve(encoder) {
    if (!this.enabled || this._mapPending) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, 16);
  }

  /** Fire-and-forget after submit; updates lastMs when the map completes. */
  collect() {
    if (!this.enabled || this._mapPending) return;
    this._mapPending = true;
    this.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const ts = new BigUint64Array(this.readBuffer.getMappedRange());
      const deltaNs = ts[1] - ts[0];
      // Guard against out-of-order timestamps on some drivers.
      if (deltaNs >= 0n && deltaNs < 10_000_000_000n) {
        this.lastMs = Number(deltaNs) / 1e6;
      }
      this.readBuffer.unmap();
      this._mapPending = false;
    }).catch(() => {
      // Device destroyed mid-flight (hot reload / teardown) — go silent, stay honest.
      this.enabled = false;
      this.lastMs = null;
      this._mapPending = false;
    });
  }
}
