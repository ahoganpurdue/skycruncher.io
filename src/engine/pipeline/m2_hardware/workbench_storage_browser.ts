// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL WORKBENCH — browser storage adapters (IndexedDB preferred, localStorage
// fallback). Environment-neutral to IMPORT (all browser-API access is lazy /
// inside methods) so this module is safe in a Node bundle graph; it only DOES
// anything when a browser storage backend is actually present. NEVER imports
// node:fs (the headless JSON-lines impl lives in tools/workbench/node_storage.ts).
//
// SIZE BOUNDING (mechanics, NOT a gate): the store is capped at DEFAULT_CAP
// deposits with oldest-first eviction. This is a client-storage hygiene number,
// freely tunable — it is NOT a calibrated constant and carries no science
// meaning. Raise it if a rig accrues more history than the cap.
// ═══════════════════════════════════════════════════════════════════════════════

import type { ObservationDeposit, WorkbenchStorage } from './workbench_store';

/** Oldest-first eviction cap (mechanics; tune freely — not a gate). */
export const DEFAULT_CAP = 5000;
const DB_NAME = 'skycruncher_workbench';
const STORE = 'deposits';
const LS_KEY = 'skycruncher.workbench.deposits';

// ─── localStorage adapter (synchronous; injectable for testing) ───────────────

/** Minimal Storage surface used here (matches DOM Storage + easy to fake). */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/**
 * Synchronous localStorage-backed store. A single JSON array under one key with
 * oldest-first eviction. Sync means a deposit completes within the packaging
 * call (deterministic). Pass a fake `StorageLike` to unit-test in Node.
 */
export class LocalStorageWorkbenchStorage implements WorkbenchStorage {
    constructor(
        private readonly store: StorageLike,
        private readonly cap: number = DEFAULT_CAP,
    ) {}

    private read(): ObservationDeposit[] {
        try {
            const raw = this.store.getItem(LS_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    append(deposit: ObservationDeposit): void {
        const rows = this.read();
        rows.push(deposit);
        // oldest-first eviction (mechanics, not a gate)
        const bounded = rows.length > this.cap ? rows.slice(rows.length - this.cap) : rows;
        this.store.setItem(LS_KEY, JSON.stringify(bounded));
    }

    list(rigKey?: string): ObservationDeposit[] {
        const rows = this.read();
        return rigKey == null ? rows : rows.filter(r => r.rig_key === rigKey);
    }
}

// ─── IndexedDB adapter (asynchronous; fire-and-forget from the deposit hook) ──

/**
 * IndexedDB-backed store: an auto-increment object store with a `rig_key` index.
 * Insertion order == key order, so `list` returns oldest-first. On append the
 * row count is trimmed to `cap` oldest-first. All async — the deposit hook does
 * NOT await it (never blocks a solve).
 */
export class IndexedDbWorkbenchStorage implements WorkbenchStorage {
    constructor(private readonly cap: number = DEFAULT_CAP) {}

    private open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const os = db.createObjectStore(STORE, { keyPath: '_seq', autoIncrement: true });
                    os.createIndex('rig_key', 'rig_key', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async append(deposit: ObservationDeposit): Promise<void> {
        const db = await this.open();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).add(deposit);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            await this.evict(db);
        } finally {
            db.close();
        }
    }

    private evict(db: IDBDatabase): Promise<void> {
        return new Promise<void>((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            const countReq = os.count();
            countReq.onsuccess = () => {
                let over = countReq.result - this.cap;
                if (over <= 0) { resolve(); return; }
                // delete oldest (lowest auto-increment keys) first
                const cursorReq = os.openCursor();
                cursorReq.onsuccess = () => {
                    const cur = cursorReq.result;
                    if (cur && over > 0) { cur.delete(); over--; cur.continue(); }
                };
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve(); // eviction is best-effort, never fatal
        });
    }

    async list(rigKey?: string): Promise<ObservationDeposit[]> {
        const db = await this.open();
        try {
            return await new Promise<ObservationDeposit[]>((resolve, reject) => {
                const tx = db.transaction(STORE, 'readonly');
                const os = tx.objectStore(STORE);
                const req = rigKey == null
                    ? os.getAll()
                    : os.index('rig_key').getAll(IDBKeyRange.only(rigKey));
                req.onsuccess = () => {
                    const rows = (req.result as any[]).map(({ _seq, ...rest }) => rest as ObservationDeposit);
                    resolve(rows);
                };
                req.onerror = () => reject(req.error);
            });
        } finally {
            db.close();
        }
    }
}

/**
 * Pick the best available browser backend: IndexedDB when present, else
 * localStorage. Throws when neither exists (the deposit hook's resolver catches
 * this → no-op, honest absence). NEVER called in a Node/vitest env (the resolver
 * gates on `typeof indexedDB`/`localStorage`).
 */
export function makeBrowserWorkbenchStorage(cap: number = DEFAULT_CAP): WorkbenchStorage {
    if (typeof indexedDB !== 'undefined') return new IndexedDbWorkbenchStorage(cap);
    if (typeof localStorage !== 'undefined') return new LocalStorageWorkbenchStorage(localStorage, cap);
    throw new Error('no browser storage backend (indexedDB/localStorage) available');
}
