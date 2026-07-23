// ═══════════════════════════════════════════════════════════════════════════
// LIBRAW-WASM API INTROSPECTION (headless, no browser)
// ═══════════════════════════════════════════════════════════════════════════
//   node tools/rawlab/inspect_libraw_api.mjs [--file <path>]
// Reports EXACTLY what the installed libraw-wasm exposes: module keys, instance
// own + prototype method names, and (if present) probes any raw-CFA accessor
// candidate so the decoder-cutover contract can be grounded in reality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', 'public/demo/sample_observation.cr2'));
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');

const liveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null; onerror = null;
    constructor(url) {
        super(SHIM_PATH, { workerData: { url: url.toString() } });
        liveWorkers.add(this);
        this.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
        this.on('error', (err) => { if (this.onerror) this.onerror(err); else console.error('[api] worker error:', err); });
        this.on('exit', () => liveWorkers.delete(this));
    }
    addEventListener(type, listener) {
        if (type === 'message') this.on('message', (data) => listener({ data }));
        else this.on(type, listener);
    }
    removeEventListener() {}
}
const withTimeout = (label, p, ms = 180000) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms).unref?.())
]);

function protoMethods(obj) {
    const out = new Set();
    let cur = obj;
    while (cur && cur !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(cur)) {
            if (k === 'constructor') continue;
            out.add(k);
        }
        cur = Object.getPrototypeOf(cur);
    }
    return [...out].sort();
}

async function main() {
    if (!fs.existsSync(FILE)) { console.error(`[api] FILE NOT FOUND: ${FILE}`); return 1; }
    globalThis.Worker = BrowserWorkerOnNode;
    const LibRawModule = await import('libraw-wasm');
    console.log('=== module exports (keys) ===');
    console.log(Object.keys(LibRawModule));
    console.log('default is', typeof LibRawModule.default);
    const LibRaw = LibRawModule.default || LibRawModule;
    const raw = new LibRaw();
    console.log('\n=== instance own property names ===');
    console.log(Object.getOwnPropertyNames(raw).sort());
    console.log('\n=== instance method/prop names (full prototype chain) ===');
    console.log(protoMethods(raw));

    // Open with the SAME params the engine uses, then probe accessors.
    const fileBuf = fs.readFileSync(FILE);
    await withTimeout('open', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength), {
        noInterpolation: true, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false
    }));
    console.log('\n=== metadata() keys + values ===');
    const meta = await withTimeout('metadata', raw.metadata());
    console.log(JSON.stringify(meta, (k, v) => (ArrayBuffer.isView(v) ? `[TypedArray len=${v.length}]` : v), 2));

    // Probe every plausible raw-CFA accessor name; report what exists & returns.
    const candidates = ['rawImageData', 'imageDataRaw', 'rawImage', 'unpack', 'getRawImage',
        'raw_image', 'bayerData', 'cfaData', 'imageData', 'rawData', 'dcrawProcess'];
    console.log('\n=== accessor probe ===');
    for (const name of candidates) {
        const exists = typeof raw[name] === 'function';
        console.log(`  ${name}: ${exists ? 'FUNCTION' : 'absent'}`);
    }
    // Try to actually call a raw accessor if present (besides imageData which we know)
    for (const name of ['rawImageData', 'imageDataRaw', 'rawImage', 'bayerData', 'cfaData']) {
        if (typeof raw[name] === 'function') {
            try {
                const r = await withTimeout(name, raw[name]());
                const kind = ArrayBuffer.isView(r) ? `${r.constructor.name} len=${r.length}`
                    : (r && r.data && ArrayBuffer.isView(r.data)) ? `{data:${r.data.constructor.name} len=${r.data.length}, ...}`
                    : typeof r;
                console.log(`  CALLED ${name}() -> ${kind}`);
            } catch (e) { console.log(`  CALLED ${name}() -> THREW ${e.message}`); }
        }
    }
    for (const w of liveWorkers) w.terminate().catch(() => {});
    return 0;
}
const code = await main().catch(e => { console.error('[api] FAILED:', e); return 1; });
setTimeout(() => process.exit(code), 250);
