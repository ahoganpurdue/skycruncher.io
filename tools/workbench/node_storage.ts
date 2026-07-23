// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL WORKBENCH — headless Node storage adapter (JSON-lines)
// ═══════════════════════════════════════════════════════════════════════════
// tools/ lane (LAW 4): the ONLY place node:fs touches the workbench, so the
// browser bundle graph (orchestrator_session → stages/workbench_deposit →
// workbench_store / workbench_storage_browser) NEVER pulls node:fs. Injected in
// headless entry points via configureWorkbench({ storage }).
//
// Format: one deposit JSON object per line in `<dir>/deposits.jsonl`. Synchronous
// (appendFileSync/readFileSync) so a deposit COMPLETES within the packaging call
// — deterministic for the evidence lane + tests. Default dir is gitignored
// (`test_results/workbench/`), so deposits stay LOCAL (privacy). Unbounded on
// disk (a local dev artifact); the browser adapter carries the size cap.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import type { ObservationDeposit, WorkbenchStorage } from '@/engine/pipeline/m2_hardware/workbench_store';

const FILE = 'deposits.jsonl';

export class NodeJsonlWorkbenchStorage implements WorkbenchStorage {
    private readonly file: string;
    constructor(private readonly dir: string) {
        this.file = path.join(dir, FILE);
    }

    private readAll(): ObservationDeposit[] {
        try {
            const raw = fs.readFileSync(this.file, 'utf8');
            return raw
                .split('\n')
                .filter(l => l.trim().length)
                .map(l => JSON.parse(l) as ObservationDeposit);
        } catch {
            return []; // missing file → empty log (honest absence)
        }
    }

    append(deposit: ObservationDeposit): void {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(this.file, JSON.stringify(deposit) + '\n', 'utf8');
    }

    list(rigKey?: string): ObservationDeposit[] {
        const rows = this.readAll();
        return rigKey == null ? rows : rows.filter(r => r.rig_key === rigKey);
    }
}

/** Construct a JSON-lines workbench store rooted at `dir`. */
export function makeNodeJsonlStorage(dir: string): WorkbenchStorage {
    return new NodeJsonlWorkbenchStorage(dir);
}
