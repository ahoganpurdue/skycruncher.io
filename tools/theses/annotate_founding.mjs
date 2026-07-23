// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/annotate_founding.mjs — retro-stamp the founding AI-bucket thesis
// ═══════════════════════════════════════════════════════════════════════════
//
// One-shot, IDEMPOTENT driver (owner-authorized 2026-07-10; memory:
// owner-proxy-agent-plan — "retro-stamp authorized"). Appends a provenance
// annotation classifying THESIS-2026-07-10-001 as the FOUNDING AI-RESEARCHER
// bucket entry. The thesis was registered before schema 0.2.0 existed, so the
// classification post-dates it — an ANNOTATION (append-only metadata), NOT an
// edit of the frozen thesis.
//
// The registry lives under test_results/theses/ (gitignored, LOCAL): this is a
// DATA operation on the live registry, run against whichever registry dir is
// resolved (THESIS_REGISTRY_DIR / default). Safe to run repeatedly — it detects
// an existing founding provenance annotation and no-ops. Honest-absent: if
// THESIS-2026-07-10-001 is not registered locally, it reports and exits 0.
//
// CLI: node tools/theses/annotate_founding.mjs [--dir <registry_dir>]
// ═══════════════════════════════════════════════════════════════════════════

import { get, annotate, registryDir } from './registry.mjs';

const FOUNDING_ID = 'THESIS-2026-07-10-001';
const ANNOTATION_TYPE = 'provenance';

/** Apply the founding AI-bucket annotation idempotently. Returns a result note. */
export function annotateFounding(opts = {}) {
    const existing = get(FOUNDING_ID, opts);
    if (!existing) {
        return { applied: false, reason: `not-registered: no thesis "${FOUNDING_ID}" in ${registryDir(opts)} (honest-absent — nothing to annotate)` };
    }
    const already = (existing.annotations || []).some(
        (a) => a.annotation_type === ANNOTATION_TYPE && a.fields && a.fields.submitter_class === 'AI-RESEARCHER',
    );
    if (already) {
        return { applied: false, reason: 'already-annotated: founding AI-RESEARCHER provenance annotation is already present (idempotent no-op)', entry: existing };
    }
    const entry = annotate({
        id: FOUNDING_ID,
        annotation_type: ANNOTATION_TYPE,
        fields: { submitter_class: 'AI-RESEARCHER' },
        note: 'Founding AI-bucket entry — the first AI-RESEARCHER thesis; registered pre-0.2.0, classified retroactively. AI submissions never pool with HUMAN (base-rate integrity).',
        by: 'annotate_founding.mjs',
        authorized_by: 'owner',
    }, opts);
    return { applied: true, reason: 'founding AI-RESEARCHER provenance annotation appended', entry };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_DIRECTLY) {
    const dirFlag = process.argv.indexOf('--dir');
    const opts = dirFlag >= 0 && process.argv[dirFlag + 1] ? { dir: process.argv[dirFlag + 1] } : {};
    const res = annotateFounding(opts);
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(0);
}
