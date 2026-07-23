/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MANIFEST TRANSACTION — Deferred-Commit Pattern for FSM State Tracking
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Eliminates the verbose, per-micro-step manifest mutation pattern that
 * clutters the orchestrator hot-path. Instead of mutating the manifest
 * and calling logManifest() after every microscopic operation, stages
 * accumulate changes and commit them once at stage boundaries.
 *
 * DESIGN:
 *   - tx.set('key', value) — stages a mutation (zero cost, no I/O)
 *   - tx.commit('stageName') — applies all pending mutations, timestamps,
 *     and emits a single logManifest() call
 *   - The manifest object is still the single source of truth for downstream
 *     consumers; the transaction just controls WHEN it gets updated
 *
 * This reduces ~15 scattered logManifest calls to ~8 batched commits at
 * natural stage boundaries, improving both performance and code clarity.
 */

import type { PipelineManifest } from '../types/manifest';
import type { TelemetryLogger } from '../diagnostics/telemetry_logger';

/** One manifest state transition observed at commit time (Phase U provenance events). */
export interface ManifestChange {
    key: string;
    /** Previous value (stringified); undefined when the field was previously unset. */
    from?: string;
    to: string;
}

export class ManifestTransaction {
    private pending: Partial<PipelineManifest> = {};

    constructor(
        private manifest: PipelineManifest,
        private logger: TelemetryLogger,
        /**
         * Optional observer invoked after each commit with the actual state
         * transitions (no-op sets are filtered out). Used by the Glass
         * Pipeline to emit `provenance_changed` events; callers that don't
         * pass it are unaffected.
         */
        private onCommit?: (changes: ManifestChange[], stageName: string) => void
    ) {}

    /**
     * Stage a manifest field mutation. This does NOT mutate the manifest yet.
     * Mutations are held until commit() is called.
     */
    set<K extends keyof PipelineManifest>(key: K, value: PipelineManifest[K]): void {
        (this.pending as any)[key] = value;
    }

    /**
     * Apply all pending mutations to the manifest and emit a single
     * telemetry update. Resets the pending queue.
     */
    commit(stage: string): void {
        if (Object.keys(this.pending).length === 0) return;

        // Capture the real transitions BEFORE applying (for provenance events).
        let changes: ManifestChange[] | null = null;
        if (this.onCommit) {
            changes = [];
            for (const key of Object.keys(this.pending)) {
                const from = (this.manifest as any)[key];
                const to = (this.pending as any)[key];
                if (from === to) continue; // no-op set — not a state transition
                changes.push({
                    key,
                    from: from === undefined || from === null ? undefined : String(from),
                    to: String(to)
                });
            }
        }

        Object.assign(this.manifest, this.pending);
        this.manifest.lastUpdated = new Date().toISOString();
        this.logger.logManifest(this.manifest);
        this.pending = {};

        if (this.onCommit && changes && changes.length > 0) {
            this.onCommit(changes, stage);
        }
    }

    /**
     * Direct access to the underlying manifest (for read-only consumers).
     */
    getManifest(): PipelineManifest {
        return this.manifest;
    }

    /**
     * Check if there are uncommitted mutations.
     */
    hasPending(): boolean {
        return Object.keys(this.pending).length > 0;
    }
}
