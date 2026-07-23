// ═══════════════════════════════════════════════════════════════════════════
// SHARED STAGE: WORKBENCH DEPOSIT — post-package collection hook (DEFAULT ON)
// ═══════════════════════════════════════════════════════════════════════════
// Ledger: NEITHER (pure OBSERVATION — reads a finished receipt, writes a
// side-channel row). Invoked at the END of the shared packaging seam
// (orchestrator_session.exportPacket), AFTER buildReceipt returns.
//
// ─── NEVER-FATAL, ZERO-MUTATION CONTRACT ───────────────────────────────────────
// The WHOLE hook is wrapped in try/catch. A storage failure (or any throw, sync
// or async) must NEVER fail a solve or alter the receipt. `extractDeposit` only
// READS the receipt — it copies scalar fields into a compact row and never
// touches the receipt object — so the sacred solve stays byte-identical whether
// storage succeeds, throws, or is absent. Decouple ruling: collection is
// observational, on a side channel.
//
// ─── STORAGE RESOLUTION (default-on) ────────────────────────────────────────────
// The hook always runs (no feature flag gating it off). Whether a row PERSISTS
// depends on an available storage backend:
//   • explicit  → whatever `configureWorkbench({storage})` injected (headless
//                 Node JSON-lines, or a test double).
//   • browser   → auto-resolved IndexedDB/localStorage when those globals exist.
//   • otherwise → no-op (honest absence — e.g. a Node vitest env with nothing
//                 injected; that is exactly why the api-smoke gate stays
//                 byte-identical: the deposit is a pure no-op there).
//
// ─── SYNC vs ASYNC ──────────────────────────────────────────────────────────────
// Node JSON-lines storage is synchronous → the deposit completes WITHIN the
// packaging call (deterministic for the headless evidence lane + tests). Browser
// IndexedDB storage is async → fire-and-forget (its rejection is swallowed).
// ═══════════════════════════════════════════════════════════════════════════════

import { extractDeposit, assignEpoch, type WorkbenchStorage } from '../m2_hardware/workbench_store';
import { makeBrowserWorkbenchStorage } from '../m2_hardware/workbench_storage_browser';

let _enabled = true;                        // DEFAULT ON
let _storage: WorkbenchStorage | null = null;
let _browserResolveTried = false;

/** Inject a storage backend (headless Node, or a test double). */
export function configureWorkbench(opts: { storage?: WorkbenchStorage | null; enabled?: boolean }): void {
    if (opts.storage !== undefined) { _storage = opts.storage; _browserResolveTried = _storage != null; }
    if (opts.enabled !== undefined) _enabled = opts.enabled;
}

/** Test/introspection: the currently-resolved storage (may be null). */
export function currentWorkbenchStorage(): WorkbenchStorage | null { return _storage; }

/** Reset module state (tests only). */
export function __resetWorkbenchForTest(): void {
    _enabled = true; _storage = null; _browserResolveTried = false;
}

function isPromise(v: any): v is Promise<unknown> {
    return v != null && typeof v.then === 'function';
}

/**
 * Resolve a storage backend. Prefers an explicitly-injected one; else, in a
 * browser env (indexedDB/localStorage present), builds+caches the browser
 * adapter. In a Node/vitest env with nothing injected → null (no-op). The
 * browser adapter module is import-safe in Node (no node:fs; browser globals
 * touched lazily inside methods), so a static import is fine.
 */
function resolveStorage(): WorkbenchStorage | null {
    if (_storage) return _storage;
    if (_browserResolveTried) return null;
    _browserResolveTried = true;
    const hasBrowserStorage =
        (typeof indexedDB !== 'undefined') ||
        (typeof localStorage !== 'undefined' && typeof window !== 'undefined');
    if (!hasBrowserStorage) return null;
    try {
        _storage = makeBrowserWorkbenchStorage();
    } catch {
        _storage = null; // no backend — honest absence
    }
    return _storage;
}

/**
 * Post-package collection hook. Extract a compact deposit from the FINISHED
 * receipt and persist it side-channel. Never throws; never mutates the receipt.
 * Fire-and-forget for async storage; synchronous storage completes inline.
 */
export function depositFromReceipt(receipt: any): void {
    if (!_enabled) return;
    try {
        const storage = resolveStorage();
        if (!storage) return;
        const deposit = extractDeposit(receipt);
        if (!deposit) return;
        const prior = storage.list(deposit.rig_key);
        if (isPromise(prior)) {
            // async backend: assign epoch after the read, then append; swallow all
            prior
                .then(async (p) => {
                    deposit.epoch = assignEpoch(p, deposit);
                    await storage.append(deposit);
                })
                .catch(() => { /* never-fatal side channel */ });
            return;
        }
        // sync backend: complete inline (deterministic for headless + tests)
        deposit.epoch = assignEpoch(prior, deposit);
        const app = storage.append(deposit);
        if (isPromise(app)) app.catch(() => { /* never-fatal */ });
    } catch {
        /* never-fatal: a storage failure must never fail a solve or alter the receipt */
    }
}
