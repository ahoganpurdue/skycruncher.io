import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// 1. Shim Browser Globals
const self = globalThis;
self.self = self;
self.window = self;
self.location = { href: (workerData && workerData.url) ? workerData.url : 'file://' };

self.importScripts = async (...urls) => {
    for (const url of urls) {
        let filePath = url;
        if (typeof url === 'string' && !url.includes('://')) {
             if (workerData && workerData.url) {
                const workerDir = path.dirname(fileURLToPath(workerData.url));
                filePath = path.resolve(workerDir, url);
            }
        } else if (url.startsWith('file:')) {
            filePath = fileURLToPath(url);
        }
        
        if (!fs.existsSync(filePath)) {
            if (fs.existsSync(filePath + '.ts')) filePath += '.ts';
            else if (fs.existsSync(filePath + '.js')) filePath += '.js';
            else if (fs.existsSync(filePath + '/index.ts')) filePath += '/index.ts';
        }

        try {
            await import(pathToFileURL(filePath).href);
        } catch (e) {
            console.error(`[WorkerShim] Failed to import: ${filePath}`, e.message);
        }
    }
};

if (typeof self.navigator === 'undefined') {
    self.navigator = { userAgent: 'node' };
}

// 2. Fetch Polyfill
self.fetch = async (url) => {
    let filePath = url;
    if (url instanceof URL || (typeof url === 'string' && url.startsWith('file:'))) {
        filePath = fileURLToPath(url);
    } else if (typeof url === 'string' && !url.includes('://')) {
        if (workerData && workerData.url) {
            const workerDir = path.dirname(fileURLToPath(workerData.url));
            filePath = path.resolve(workerDir, url);
        }
    }

    try {
        const buffer = fs.readFileSync(filePath);
        
        if (typeof Response !== 'undefined') {
            return new Response(buffer, {
                status: 200,
                headers: { 'Content-Type': filePath.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' }
            });
        }
        
        return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', filePath.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream']]),
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            text: async () => buffer.toString(),
            blob: async () => new Blob([buffer])
        };
    } catch (e) {
        console.error(`[WorkerShim] Fetch error for ${url}:`, e.message);
        return { ok: false, status: 404 };
    }
};

// 3. Messaging
const listeners = new Set();
self.addEventListener = (type, listener) => {
    if (type === 'message') listeners.add(listener);
};

self.postMessage = (data, transfer) => {
    if (parentPort) parentPort.postMessage(data, transfer);
};

if (parentPort) {
    parentPort.on('message', (data) => {
        const event = { data };
        // A worker message handler (libraw's decode dispatch) may be async and
        // REJECT mid-decode — e.g. "data corrupted at <offset>" near EOF on a
        // truncated/corrupt RAW. Invoked bare (fire-and-forget), that rejection was
        // an UNHANDLED promise rejection inside the worker thread, which Node
        // terminates the whole process for — surfacing to vitest as an "unknown
        // file" crash the decode caller could never catch. Catch it and route it to
        // the log path so the decode boundary fails cleanly instead of killing the
        // process. No behaviour change when handlers resolve (the common path).
        const onHandlerReject = (err) => {
            console.error('[WorkerShim] worker message handler rejected:', err);
        };
        try {
            if (typeof self.onmessage === 'function') {
                const r = self.onmessage(event);
                if (r && typeof r.then === 'function') r.catch(onHandlerReject);
            }
            listeners.forEach((l) => {
                const r = l(event);
                if (r && typeof r.then === 'function') r.catch(onHandlerReject);
            });
        } catch (err) {
            onHandlerReject(err);
        }
    });
}

// 4. Load
if (workerData && workerData.url) {
    try {
        await import(workerData.url);
    } catch (e) {
        console.error(`[WorkerShim] Worker script import failed:`, e);
    }
}

