#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/publish_docs.mjs — CURATED narrative-doc publisher
// ============================================================================
// Copies a hand-curated set of narrative reports into
//   test_results/theses/dashboard/docs/<slug>.md
// and writes docs_manifest.json alongside them. The dashboard's DOCUMENTS tab
// reads that manifest and serves the copies at /docs/<slug>.md so the owner can
// read session reports from a laptop over the home LAN.
//
// HONESTY (LAW 3): these copies are a SNAPSHOT and MAY BE STALE. The manifest
// carries the canonical source_path + copied_at for every entry so the UI can
// say so out loud ("snapshot — may be stale; canonical lives at <path>"). We
// never invent a doc: a curated source that is missing on disk is SKIPPED and
// recorded in manifest.missing (never a fake copy, never a fabricated size).
//
// This tool is idempotent: re-running rewrites every copy + prunes any stale
// *.md in the docs dir that is no longer in the curated set. It only ever
// touches *.md files and docs_manifest.json under the docs dir — nothing else.
//
// Usage:  node tools/theses/dashboard/publish_docs.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const DOCS_DIR = path.join(ROOT, 'test_results', 'theses', 'dashboard', 'docs');
const MANIFEST_PATH = path.join(DOCS_DIR, 'docs_manifest.json');

// ---- the curated manifest ---------------------------------------------------
// slug MUST be stable (it is the URL-hash key: #documents/<slug>) and match
// /^[A-Za-z0-9._-]+$/ (the server's route guard). source is repo-root-relative.
// `category` groups entries in the DOCUMENTS tab and mirrors the docs/ folder
// scheme (docs/00-README-STRUCTURE.md): canonical · research · ledger · plan ·
// session-report (narrative run outputs that live under test_results/, not docs/).
// Additive field — older UI ignores it; grouping consumers key off it.
const CURATED = [
    { slug: 'efficiency-review',    source: 'test_results/efficiency_review_2026-07-10/EFFICIENCY_REVIEW.md',   title: 'Pipeline Efficiency Review',        one_liner: 'Pipeline efficiency synthesis (Arrow/WASM/WebGPU candidates)', category: 'research' },
    { slug: 'event-why-narrative',  source: 'test_results/pm_fables_2026-07-11/EVENT_WHY_NARRATIVE.md',          title: 'Event / Why Narrative',             one_liner: 'Event/why narrative (Monday booth)', category: 'session-report' },
    { slug: 'future-integration',   source: 'test_results/pm_fables_2026-07-11/FUTURE_INTEGRATION_PLAN.md',      title: 'Future Integration Plan',           one_liner: 'API/MCP future-state integration vision', category: 'plan' },
    { slug: 'wrap-report',          source: 'test_results/session_wrap_2026-07-11/WRAP_REPORT.md',               title: 'Falsification-Marathon Wrap',       one_liner: 'Falsification-marathon session wrap', category: 'session-report' },
    { slug: 'morning-report',       source: 'test_results/overnight_run_2026-07-10/MORNING_REPORT.md',           title: 'Overnight Morning Report',          one_liner: 'Overnight run morning report (v1.0.0 ship night)', category: 'session-report' },
    { slug: 'divergence-diagnosis', source: 'test_results/decoder_cutover_2026-07-10/DIVERGENCE_DIAGNOSIS.md',   title: 'Decoder Divergence Diagnosis',      one_liner: 'Decoder divergence root-cause', category: 'session-report' },
    { slug: 'decoder-visual',       source: 'test_results/decoder_visual_2026-07-11/REPORT.md',                  title: 'Rawler Visual A/B Verdict',         one_liner: 'Rawler visual A/B inspection verdict', category: 'session-report' },
    { slug: 'operations-map',       source: 'docs/OPERATIONS_MAP.md',                                            title: 'Agentic Operations Map (DRAFT)',    one_liner: 'Agentic operations map DRAFT v0', category: 'canonical' },
    { slug: 'gaia-atlas-plan',      source: 'test_results/gaia_atlas_2026-07-10/GAIA_ATLAS_PLAN.md',             title: 'Gaia Atlas Acquisition Plan',       one_liner: 'Gaia atlas acquisition plan', category: 'plan' },
    { slug: 'proxy-adjudication',   source: 'test_results/owner_proxy_2026-07-10_late/ADJUDICATION_PACKAGE.md',  title: 'Proxy Round-2 Adjudication',        one_liner: 'Proxy round-2 adjudication', category: 'session-report' },
    { slug: 'recal-table',          source: 'test_results/recal_sweep_2026-07-10_late/RECAL_TABLE.md',           title: 'Recal Sweep NULL Table (signed)',   one_liner: 'Recal sweep NULL table (signed)', category: 'ledger' },
    { slug: 'oklab-research',       source: 'test_results/color_research_2026-07-11/oklab/OKLAB_RESEARCH.md',    title: 'Oklab Render-Layer Research',       one_liner: 'Oklab render-layer research', category: 'research' },
    { slug: 'booth-checklist',      source: 'test_results/demo_build_2026-07-11/BOOTH_CHECKLIST.md',             title: 'Monday Booth Checklist',            one_liner: 'Monday booth rehearsal checklist', category: 'session-report' },
    { slug: 'server-utilization',   source: 'docs/local/SERVER_UTILIZATION_AND_VISION_2026-07-18.md',            title: 'Server Utilization & Vision',       one_liner: 'Server surface today, mapped direction, and full-utilization vision (owner-requested Fable doc)', category: 'plan' },
    { slug: 'cloud-native-vision',  source: 'docs/local/CLOUD_NATIVE_VISION_2026-07-18.md',                      title: 'Cloud-Native End-State Vision',     one_liner: 'What the project looks like fully off local disk, with the phased migration path (owner-requested Fable doc)', category: 'plan' },
    { slug: 'corpus-scouting-wishlist', source: 'docs/local/CORPUS_SCOUTING_WISHLIST_2026-07-18.md',              title: 'Corpus Scouting Wishlist',          one_liner: 'What frame types to grab next and which stalled pipeline program each one unblocks', category: 'plan' },
    { slug: 'corpus-graduation-run', source: 'docs/local/CORPUS_GRADUATION_RUN_DESIGN_2026-07-18.md',            title: 'Corpus Graduation Run Design',      one_liner: 'The reserved one-shot corpus run: arms, frame set, wall-clock, graduation criteria, precondition gates — owner GO starts execution', category: 'plan' },
];

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

function main() {
    fs.mkdirSync(DOCS_DIR, { recursive: true });

    const docs = [];
    const missing = [];
    const seenSlugs = new Set();
    const nowIso = new Date().toISOString();

    for (const entry of CURATED) {
        const { slug, source, title, one_liner, category } = entry;
        if (!SLUG_RE.test(slug)) {
            missing.push({ slug, source_path: source, reason: `invalid slug (must match ${SLUG_RE})` });
            continue;
        }
        if (seenSlugs.has(slug)) {
            missing.push({ slug, source_path: source, reason: 'duplicate slug in curated set — skipped' });
            continue;
        }
        seenSlugs.add(slug);

        const absSrc = path.resolve(ROOT, source);
        if (!fs.existsSync(absSrc) || !fs.statSync(absSrc).isFile()) {
            missing.push({ slug, source_path: source, reason: 'source not found on disk — NOT COPIED' });
            console.warn(`[publish_docs] MISSING (skipped): ${source}`);
            continue;
        }

        let buf, srcStat;
        try {
            buf = fs.readFileSync(absSrc);
            srcStat = fs.statSync(absSrc);
        } catch (err) {
            missing.push({ slug, source_path: source, reason: `unreadable: ${String(err && err.message || err)}` });
            console.warn(`[publish_docs] UNREADABLE (skipped): ${source}`);
            continue;
        }

        const destName = `${slug}.md`;
        fs.writeFileSync(path.join(DOCS_DIR, destName), buf);

        docs.push({
            slug,
            title,
            one_liner,
            category: category || 'session-report',    // groups the DOCUMENTS tab; mirrors docs/ folder scheme
            source_path: source,                       // canonical location (repo-relative) — shown prominently in the UI
            copied_at: nowIso,                         // when THIS snapshot was taken
            source_mtime: srcStat.mtime.toISOString(), // canonical last-modified — extra honesty on staleness
            size: buf.length,                          // bytes of the copied snapshot
        });
        console.log(`[publish_docs] copied ${source}  (${buf.length} B)  → docs/${destName}`);
    }

    // prune stale copies: any *.md in the docs dir not in the current slug set
    const keep = new Set(docs.map((d) => `${d.slug}.md`));
    let pruned = 0;
    for (const f of fs.readdirSync(DOCS_DIR)) {
        if (f.endsWith('.md') && !keep.has(f)) {
            try { fs.unlinkSync(path.join(DOCS_DIR, f)); pruned++; console.log(`[publish_docs] pruned stale copy: ${f}`); }
            catch (err) { console.warn(`[publish_docs] could not prune ${f}: ${String(err && err.message || err)}`); }
        }
    }

    const manifest = {
        generated_at: nowIso,
        published_by: 'tools/theses/dashboard/publish_docs.mjs',
        docs_dir: 'test_results/theses/dashboard/docs',
        note: 'SNAPSHOT — copies may be stale; each entry\'s source_path is the canonical, live location.',
        count: docs.length,
        missing,          // curated entries that were skipped (honest absence, never fabricated)
        docs,             // [{slug, title, one_liner, source_path, copied_at, source_mtime, size}]
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    console.log(`\n[publish_docs] wrote ${MANIFEST_PATH}`);
    console.log(`[publish_docs] SUMMARY: ${docs.length} copied · ${missing.length} missing/skipped · ${pruned} pruned`);
    if (missing.length) {
        console.log('[publish_docs] missing/skipped:');
        for (const m of missing) console.log(`  - ${m.slug} (${m.source_path}) — ${m.reason}`);
    }
}

main();
