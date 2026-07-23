/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * BAYER STORAGE SERVICE â€” Persistent RAW Cache
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Handles caching of decoded 16-bit Bayer buffers to avoid redundant 
 * WASM calls and memory bottlenecks.
 * 
 * ENVIRONMENT: Isomorphic (IndexedDB in Browser, Temp files in Node)
 */

export class BayerStorageService {
    private static readonly DB_NAME = 'SkyCruncherBayerCache';
    private static readonly STORE_NAME = 'bayer_buffers';
    private static readonly DB_VERSION = 2;

    private static db: IDBDatabase | null = null;

    /**
     * Initializes the IndexedDB store (Browser only)
     */
    private static async initDB(): Promise<void> {
        if (this.db) return;
        if (typeof indexedDB === 'undefined') return; // Not in browser

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Stores a Bayer buffer indexed by a checksum or key.
     */
    public static async store(key: string, data: Uint16Array | Float32Array, width: number, height: number, stride: number, isDemosaiced: boolean = false, cfaMosaicLuma?: boolean): Promise<void> {
        console.log(`[BayerStorage] Storing buffer for key: ${key} (${width}x${height}, stride=${stride}, demosaiced=${isDemosaiced})`);

        // Browser Implementation (IndexedDB)
        if (typeof indexedDB !== 'undefined') {
            await this.initDB();
            if (!this.db) return;

            return new Promise((resolve, reject) => {
                const transaction = this.db!.transaction(this.STORE_NAME, 'readwrite');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.put({ data, width, height, stride, isDemosaiced, cfaMosaicLuma, timestamp: Date.now() }, key);

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }
    }

    /**
     * Retrieves a Bayer buffer.
     */
    public static async retrieve(key: string): Promise<{ data: Uint16Array | Float32Array, width: number, height: number, stride: number, isDemosaiced: boolean, cfaMosaicLuma?: boolean } | null> {
        if (typeof indexedDB !== 'undefined') {
            await this.initDB();
            if (!this.db) return null;

            return new Promise((resolve, reject) => {
                const transaction = this.db!.transaction(this.STORE_NAME, 'readonly');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.get(key);

                request.onsuccess = () => {
                    if (request.result) {
                        console.log(`[BayerStorage] Cache HIT for key: ${key}`);
                        resolve(request.result);
                    } else {
                        console.log(`[BayerStorage] Cache MISS for key: ${key}`);
                        resolve(null);
                    }
                };
                request.onerror = () => reject(request.error);
            });
        }
        return null;
    }

    /**
     * Clears old entries to prevent storage bloat.
     */
    public static async clear(): Promise<void> {
        if (this.db) {
            const transaction = this.db.transaction(this.STORE_NAME, 'readwrite');
            transaction.objectStore(this.STORE_NAME).clear();
        }
    }
}

