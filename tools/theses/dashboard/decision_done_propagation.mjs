#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/decision_done_propagation.mjs
//   DECISION-ledger done-propagation — EXTENDS tools/ops/done_propagation.mjs
//   (the work-items reconciler) to the owner-decisions docket.
// ============================================================================
// WHY: a ruled decision's implementation.status lags the code that satisfies it.
// owner_decisions.json carries, per ruled decision (and per sub-tier child), an
// `implementation` object {status, evidence, updated}. When `evidence` NAMES a
// commit hash that actually exists in the repo, that decision is provably built.
//
// TWO CONFIDENCE TIERS (mirrors done_propagation.mjs; the whole point of the ask):
//   CONFIRM  = implementation.evidence names a commit hash that EXISTS in git,
//              and the recorded status is `pending` (or the field is absent) →
//              propose flip to `implemented`. This is the ONLY auto-flip-eligible
//              tier — it rests on an exact, verifiable commit hash.
//   SUGGEST  = a fuzzy/textual match only (>=2 distinctive title/summary terms in
//              one commit subject, NO verified hash) → an "evidence landed —
//              confirm" chip. NEVER auto-flipped — a human confirms.
//
// HONESTY / FENCES (LAW 3 + DECISIONS_MAINTENANCE.md):
//   • This tool is REPORT-ONLY. It NEVER writes owner_decisions.json — that file
//     is a hand-curated editorial ledger ("Ruled items are DELETED, not
//     state-flipped"); the orchestrator applies a CONFIRM by hand in the same
//     breath as a relay. A dropped report at
//     test_results/theses/dashboard/decision_reconcile.json is served at
//     /data/decision_reconcile.json (existing passthrough) and the dashboard
//     overlays a chip — but the LEDGER is never machine-rewritten here.
//   • Already-settled statuses (implemented / obsolete / owner-side) are SKIPPED
//     for proposals; an `implemented` row whose evidence hash is NOT in the repo
//     is flagged as an integrity note (never silently trusted).
//   • Never touches .dashboard_token, source, docs, or the registry.
//
// CLI: node tools/theses/dashboard/decision_done_propagation.mjs
//        [--repo DIR] [--ledger FILE] [--since SPEC] [--json]
//        [--out FILE] [--git-log-json FILE] [--self-test] [--help]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..');
const MAIN_REPO = process.env.SKYCRUNCHER_MAIN_CHECKOUT || DEFAULT_REPO;
const LEDGER_REL = path.join('test_results', 'theses', 'dashboard', 'owner_decisions.json');
export const SCHEMA = 'decision-reconcile/1';

// settled statuses that need no proposal (never re-flipped by this tool)
const SETTLED = new Set(['implemented', 'obsolete', 'owner-side']);

// --- helpers (self-contained; done_propagation.mjs runs on import, so we don't
//     import it — these are the same conservative rules, re-stated) --------------
const STOP = new Set(('a an the of for to in on and or with vs via per at by as is be into from out off ' +
  'not no its it that this than then but are was were has have had will would can could all any one two ' +
  'new now also more most only same such so if when while their our your').split(/\s+/));
const COMMON = new Set(('task solve solver gate gates item items wave waves fix build tool tools test tests ' +
  'module done open blocked queued pending next move work step add update landed ship wire port flag default ' +
  'report honest owner live app ui mode path lane rig frame stage decision ruling ruled').split(/\s+/));
export function tokenize(str) {
  return String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}
export function distinctiveTerms(text) {
  const seen = new Set();
  for (const t of tokenize(text)) { if (STOP.has(t) || COMMON.has(t)) continue; seen.add(t); }
  return [...seen];
}
// Repo convention is "@1c09a34". Accept @-prefixed hex (7-40) + bare hex with an
// a-f letter (so a 7-digit decimal date fragment is never mistaken for a hash).
export function extractHashes(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/@([0-9a-f]{7,40})\b/gi)) out.add(m[1].toLowerCase());
  for (const m of s.matchAll(/\b([0-9a-f]{7,40})\b/gi)) { const h = m[1].toLowerCase(); if (/[a-f]/.test(h)) out.add(h); }
  return [...out];
}
const short = (h) => String(h || '').slice(0, 7);
const isoDay = (t) => String(t || '').slice(0, 10);

// --- classify one node (a decision or a child) ------------------------------
// node: { id, title/summary, implementation? }
// ctx:  { commits:[{hash,subject,body,date}], hashExists(h)->{hash,subject,date}|null|bool }
export function classifyNode(node, ctx) {
  const impl = (node && node.implementation && typeof node.implementation === 'object' && !Array.isArray(node.implementation))
    ? node.implementation : null;
  const status = (impl && typeof impl.status === 'string') ? impl.status.trim().toLowerCase() : null;
  const evidence = impl && impl.evidence != null ? String(impl.evidence) : '';
  const text = `${node.title || ''} ${node.summary || ''}`;

  // integrity note: an implemented row whose evidence hash is NOT in the repo.
  if (status === 'implemented') {
    for (const h of extractHashes(evidence)) {
      const ex = ctx.hashExists(h);
      if (!ex) return { tier: 'INTEGRITY', reason: `status=implemented but evidence hash @${short(h)} not found in repo`, hash: h };
    }
    return null; // settled + (verified or no-hash) — nothing to do
  }
  if (status && SETTLED.has(status)) return null; // obsolete / owner-side — leave alone

  // CONFIRM: evidence names a commit hash that exists → auto-flip eligible.
  for (const h of extractHashes(evidence)) {
    const ex = ctx.hashExists(h);
    if (ex) {
      const commit = (ex && typeof ex === 'object') ? ex : { hash: h, subject: null, date: null };
      return {
        tier: 'CONFIRM', reason: `evidence names commit @${short(h)} — exists in repo`,
        hash: commit.hash || h, commit, current_status: status, proposed_status: 'implemented',
      };
    }
  }

  // SUGGEST: fuzzy — >=2 distinctive terms of title/summary in one commit subject.
  const terms = distinctiveTerms(text);
  if (terms.length >= 2 && Array.isArray(ctx.commits)) {
    let best = null;
    for (const c of ctx.commits) {
      const subj = new Set(tokenize(c.subject));
      const matched = terms.filter((t) => subj.has(t));
      if (matched.length >= 2 && (!best || matched.length > best.matched.length)) best = { c, matched };
    }
    if (best) {
      return {
        tier: 'SUGGEST', reason: `fuzzy: title terms {${best.matched.join(', ')}} in a commit subject — CONFIRM manually`,
        commit: { hash: best.c.hash, subject: best.c.subject, date: best.c.date },
        current_status: status, proposed_status: null,
      };
    }
  }
  return null;
}

// --- reconcile (pure) -------------------------------------------------------
export function reconcile(ledger, ctx, opts = {}) {
  const decisions = Array.isArray(ledger && ledger.decisions) ? ledger.decisions : [];
  const confirmed = [], suggestions = [], integrity = [];
  const push = (cls, base) => {
    const row = { ...base, ...cls };
    if (cls.tier === 'CONFIRM') confirmed.push(row);
    else if (cls.tier === 'SUGGEST') suggestions.push(row);
    else if (cls.tier === 'INTEGRITY') integrity.push(row);
  };
  for (const dc of decisions) {
    const cls = classifyNode(dc, ctx);
    if (cls) push(cls, { id: dc.id, title: dc.title || null, child_id: null });
    if (Array.isArray(dc.children)) {
      for (const ch of dc.children) {
        const c2 = classifyNode(ch, ctx);
        if (c2) push(c2, { id: dc.id, child_id: ch.id || null, title: ch.title || dc.title || null });
      }
    }
  }
  return {
    generated_at: opts.now || new Date().toISOString(),
    schema: SCHEMA,
    confirmed, suggestions, integrity,
    summary: { decisions: decisions.length, confirm: confirmed.length, suggest: suggestions.length, integrity: integrity.length },
  };
}

// --- IO / git ---------------------------------------------------------------
function loadGitLog(repo, since) {
  const fmt = '%H%x1f%s%x1f%b%x1f%cI%x1e';
  const out = execFileSync('git', ['-C', repo, 'log', `--since=${since}`, `--format=${fmt}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return parseGitLog(out);
}
export function parseGitLog(raw) {
  const commits = [];
  for (const rec of String(raw).split('\x1e')) {
    if (!rec.trim()) continue;
    const [hash, subject, body, date] = rec.replace(/^\r?\n/, '').split('\x1f');
    if (!hash) continue;
    commits.push({ hash: hash.trim().toLowerCase(), subject: (subject || '').trim(), body: (body || '').trim(), date: (date || '').trim() });
  }
  return commits;
}
function makeHashExists(repo, commits) {
  const inWindow = new Map(commits.map((c) => [c.hash, c]));
  return (h) => {
    const hit = [...inWindow.keys()].find((k) => k.startsWith(h));
    if (hit) return inWindow.get(hit);
    try {
      const out = execFileSync('git', ['-C', repo, 'show', '-s', '--format=%H%x1f%s%x1f%cI', `${h}^{commit}`], { encoding: 'utf8' });
      const [hh, s, d] = out.trim().split('\x1f');
      return { hash: (hh || h).toLowerCase(), subject: (s || '').trim(), date: (d || '').trim() };
    } catch { return null; }
  };
}
function resolveRepo(opts) {
  if (opts.repo) return opts.repo;
  if (fs.existsSync(path.join(DEFAULT_REPO, LEDGER_REL))) return DEFAULT_REPO;
  if (fs.existsSync(path.join(MAIN_REPO, LEDGER_REL))) return MAIN_REPO;
  return DEFAULT_REPO;
}
function resolveLedger(opts, repo) {
  if (opts.ledger) return opts.ledger;
  const here = path.join(repo, LEDGER_REL);
  return fs.existsSync(here) ? here : path.join(MAIN_REPO, LEDGER_REL);
}

function printReport(res, meta) {
  console.log('decision done-propagation — REPORT ONLY (never writes owner_decisions.json)');
  console.log(`ledger: ${meta.ledger}  (${res.summary.decisions} decisions)`);
  console.log(`window: --since "${meta.since}"  → ${meta.commits} commits\n`);
  console.log(`== CONFIRM (${res.confirmed.length})  [evidence hash verified in repo → propose implemented] ==`);
  for (const r of res.confirmed) {
    console.log(`  ${r.id}${r.child_id ? ' / ' + r.child_id : ''}  @${short(r.hash)}  (${r.current_status || 'no impl field'} → implemented)`);
    if (r.commit && r.commit.subject) console.log(`      "${r.commit.subject}" ${isoDay(r.commit.date)}`);
  }
  console.log(`\n== SUGGEST (${res.suggestions.length})  [fuzzy — confirm by hand, NEVER auto-flip] ==`);
  for (const r of res.suggestions) {
    console.log(`  ${r.id}${r.child_id ? ' / ' + r.child_id : ''}  ${r.reason}`);
    if (r.commit) console.log(`      <- @${short(r.commit.hash)} "${r.commit.subject}"`);
  }
  console.log(`\n== INTEGRITY (${res.integrity.length})  [implemented but hash not in repo] ==`);
  for (const r of res.integrity) console.log(`  ${r.id}${r.child_id ? ' / ' + r.child_id : ''}  ${r.reason}`);
  console.log(`\nsummary: confirm=${res.summary.confirm} suggest=${res.summary.suggest} integrity=${res.summary.integrity} / ${res.summary.decisions} decisions`);
}

function run(opts) {
  const repo = resolveRepo(opts);
  const ledgerPath = resolveLedger(opts, repo);
  if (!fs.existsSync(ledgerPath)) { console.error(`ledger not found: ${ledgerPath}`); process.exit(2); }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const since = opts.since || '30 days ago';
  const commits = opts.gitLogJson
    ? JSON.parse(fs.readFileSync(opts.gitLogJson, 'utf8')).map((c) => ({ hash: String(c.hash || '').toLowerCase(), subject: c.subject || '', body: c.body || '', date: c.date || '' }))
    : loadGitLog(repo, since);
  const hashExists = opts.gitLogJson
    ? (h) => commits.find((c) => c.hash.startsWith(h)) || null
    : makeHashExists(repo, commits);
  const res = reconcile(ledger, { commits, hashExists });
  const meta = { ledger: ledgerPath, since, commits: commits.length };
  if (opts.out) { fs.writeFileSync(opts.out, JSON.stringify(res, null, 2) + '\n'); console.log(`decision reconcile → ${opts.out}`); }
  else if (opts.json) console.log(JSON.stringify({ meta, ...res }, null, 2));
  else printReport(res, meta);
}

// --- self-test --------------------------------------------------------------
function selfTest() {
  const checks = [];
  const assert = (n, c) => checks.push({ name: n, ok: !!c });

  assert('extractHashes @ + bare, drops decimal', (() => {
    const h = extractHashes('landed @48103f0 see 9fa9988 plus 2026071');
    return h.includes('48103f0') && h.includes('9fa9988') && !h.includes('2026071');
  })());
  assert('distinctive drops common', (() => {
    const t = distinctiveTerms('SIP convention bug at the export boundary');
    return t.includes('convention') && t.includes('export') && t.includes('boundary') && !t.includes('the');
  })());

  const commits = [
    { hash: '48103f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'clockdrive retitle', body: '', date: '2026-07-11T10:00:00-07:00' },
    { hash: 'deadbee1111111111111111111111111111111111', subject: 'SIP convention export boundary negation', body: '', date: '2026-07-10T10:00:00-07:00' },
  ];
  const ctx = { commits, hashExists: (h) => commits.find((c) => c.hash.startsWith(h)) || null };

  // CONFIRM: pending status + evidence hash that exists
  const c1 = classifyNode({ id: 'D-a', title: 'Clockdrive name', implementation: { status: 'pending', evidence: 'landed @48103f0' } }, ctx);
  assert('CONFIRM on verified pending hash', c1 && c1.tier === 'CONFIRM' && c1.proposed_status === 'implemented' && c1.hash.startsWith('48103f0'));

  // absent implementation but title fuzzy-matches a commit subject → SUGGEST
  const c2 = classifyNode({ id: 'D-b', title: 'SIP convention export boundary' }, ctx);
  assert('SUGGEST on fuzzy title match (no hash)', c2 && c2.tier === 'SUGGEST' && c2.proposed_status === null);

  // pending + hash NOT in repo → no CONFIRM (and no fuzzy) → null
  const c3 = classifyNode({ id: 'D-c', title: 'zzq unrelated obscure', implementation: { status: 'pending', evidence: 'see @0000fff' } }, ctx);
  assert('pending + missing hash → no auto-flip', c3 === null);

  // already implemented + verified hash → null (settled, no integrity flag)
  const c4 = classifyNode({ id: 'D-d', title: 'x', implementation: { status: 'implemented', evidence: '@48103f0' } }, ctx);
  assert('implemented + verified hash → null', c4 === null);

  // implemented + hash NOT in repo → INTEGRITY
  const c5 = classifyNode({ id: 'D-e', title: 'x', implementation: { status: 'implemented', evidence: '@0000fff' } }, ctx);
  assert('implemented + missing hash → INTEGRITY', c5 && c5.tier === 'INTEGRITY');

  // owner-side → skipped
  assert('owner-side → null', classifyNode({ id: 'D-f', title: 'y', implementation: { status: 'owner-side', evidence: '' } }, ctx) === null);

  // children processed independently
  const led = { decisions: [
    { id: 'D-p', title: 'parent', children: [
      { id: 'ch-1', title: 'child one', implementation: { status: 'pending', evidence: '@48103f0' } },
    ] },
  ] };
  const res = reconcile(led, ctx, { now: 'T' });
  assert('child CONFIRM carried with child_id', res.confirmed.length === 1 && res.confirmed[0].child_id === 'ch-1' && res.confirmed[0].id === 'D-p');
  assert('schema id', res.schema === 'decision-reconcile/1');

  // NEVER auto-flip on fuzzy: a fuzzy match must never land in `confirmed`
  const led2 = { decisions: [{ id: 'D-q', title: 'SIP convention export boundary' }] };
  const res2 = reconcile(led2, ctx, { now: 'T' });
  assert('fuzzy stays in suggestions, never confirmed', res2.confirmed.length === 0 && res2.suggestions.length === 1);

  assert('parseGitLog roundtrip', (() => {
    const raw = ['H1', 's1', 'b1', 'd1'].join('\x1f') + '\x1e';
    const c = parseGitLog(raw); return c.length === 1 && c[0].hash === 'h1' && c[0].subject === 's1';
  })());

  let pass = 0;
  for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`); if (c.ok) pass++; }
  console.log(`\nself-test: ${pass}/${checks.length} passed`);
  return pass === checks.length;
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--json') o.json = true;
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--ledger') o.ledger = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--git-log-json') o.gitLogJson = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node tools/theses/dashboard/decision_done_propagation.mjs [--repo DIR] [--ledger FILE]');
  console.log('         [--since SPEC] [--json] [--out FILE] [--git-log-json FILE] [--self-test]');
  console.log('\nREPORT ONLY. CONFIRM = verified commit hash (auto-flip eligible, applied by hand);');
  console.log('SUGGEST = fuzzy match (never auto-flipped). Never writes owner_decisions.json.');
  process.exit(0);
} else if (opts.selfTest) {
  process.exit(selfTest() ? 0 : 1);
} else {
  run(opts);
}
