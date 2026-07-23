import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * NODE WORKER POLYFILL â€” Enabling Browser-like Workers in Node.js
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * LibRaw WASM and other client-side logic require a global 'Worker' class.
 * This helper bridges the Node.js 'worker_threads' module to a browser-compatible API.
 */
export function initializeNodeWorkerPolyfill(dirname: string) {
    if (typeof (global as any).Worker !== 'undefined') return;

    (global as any).Worker = class NodeWorker extends Worker {
        onmessage: ((ev: any) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;
        
        constructor(url: string | URL, options?: any) {
            const shimPath = path.resolve(dirname, './worker_shim.js');
            super(shimPath, { 
                ...options, 
                workerData: { url: url.toString() },
                execArgv: ['--import', 'tsx']
            });
            
            this.on('message', (data) => {
                if (this.onmessage) this.onmessage({ data });
                this.emit('browser-message', { data });
            });
            
            this.on('error', (err) => {
                if (this.onerror) this.onerror(err);
            });
        }

        addEventListener(type: string, listener: any) {
            if (type === 'message') {
                this.on('browser-message', listener);
            } else {
                this.on(type, listener);
            }
        }
    } as any;
}

