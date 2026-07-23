#!/usr/bin/env node
// done_propagation.mjs — the merge-train DONE reconciler (REPORT-ONLY by default).
//
// WHY: the planning corpus (the work-items ledger) lags landed code by hours-to-
// days. A backlog item can already be DONE on main while its ledger status still
// reads "in-flight / queued". This tool reconciles the ledger against the git log
// so DONE-propagation is mechanical instead of a manual re-derivation.
//
// INPUTS
//   A) git log of the MAIN repo (hash · subject · body · commit-date), windowed by
//      --since (default "7 days ago").
//   B) the work-items ledger  test_results/theses/dashboard/work_items.json
//      (read-only from a worktree — test_results/ is gitignored, so it is read from
//      the MAIN repo; the ledger is never in git, hence no git-blame age source).
//   C) optionally the newest OPPORTUNITY_SCAN / slate doc (--scan) — report-only
//      cross-reference: flags which reported items the scan doc also names.
//
// MATCHING (tiered by confidence)
//   EXACT  = a commit subject/body contains the item id VERBATIM, OR the item's
//            status/one_liner names a commit hash that exists in the repo.
//   STRONG = >=2 distinctive terms from the item TITLE appear in one commit SUBJECT
//            (distinctive = title tokens minus stopwords minus repo-common words).
//   WEAK   = single distinctive-term overlap (report-only, never applied).
//
// OUTPUT: a reconciliation report ranked by confidence (per stale-looking item:
//   current status -> evidence commits -> proposed "DONE <date> @<hash>"). DEFAULT
//   is REPORT-ONLY. --apply rewrites work_items.json for EXACT matches ONLY (never
//   STRONG/WEAK — the orchestrator applies those by hand), bumps generated_at,
//   preserves every other field, and appends a sidecar audit line to
//   test_results/theses/dashboard/done_propagation_log.jsonl.
//
// HONESTY
//   - Items already in a resolved state (DONE/FAIL/RETIRED — and the observed
//     resolved variants closed/folded/superseded/demoted/parked) are SKIPPED: the
//     tool never re-labels a closed non-mover as DONE. (The spec names DONE/FAIL/
//     RETIRED; the extra variants are a superset chosen so a resolved-but-not-DONE
//     item is never falsely proposed as DONE — documented, never narrower.)
//   - No deletion, ever. --apply only mutates `status` (+ generated_at) for EXACT.
//   - Unmatched non-resolved items are age-flagged ONLY when their status text
//     carries an ISO date older than --stale-days; no date -> skipped honestly
//     (the ledger is not in git, so there is no other age source).
//
// This tool NEVER edits source, docs, or any dashboard file other than the ledger
// (only on --apply) and its own audit sidecar. It never touches .dashboard_token.
//
// CLI: node tools/ops/done_propagation.mjs
//        [--repo DIR] [--ledger FILE] [--since SPEC] [--scan FILE]
//        [--stale-days N] [--apply] [--json]
//        [--git-log-json FILE]   (inject git log for testability)
//        [--self-test] [--help]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(__dirname, '..', '..');
// test_results/ is gitignored/local — absent in a worktree; fall back to the MAIN repo.
const MAIN_REPO = 'K:\\Coding Projects\\Newtonian Color Engine\\ASTROLOGIC_DEPLOY';
const LEDGER_REL = path.join('test_results', 'theses', 'dashboard', 'work_items.json');
const AUDIT_REL = path.join('test_results', 'theses', 'dashboard', 'done_propagation_log.jsonl');

// --- resolved-state detection (SKIP set) ------------------------------------
// Spec names DONE/FAIL/RETIRED; the extra tokens are the resolved variants seen in
// the live ledger (closed non-mover, folded-into, superseded, demoted, parked). A
// superset only ever suppresses a FALSE "DONE" proposal, never hides a real stale.
const RESOLVED_RE = /\b(done|fail|failed|retired|closed|folded|superseded|demoted|parked)\b/i;
export function isResolved(status) {
  return RESOLVED_RE.test(String(status || ''));
}

// --- distinctive-term extraction --------------------------------------------
const STOP = new Set(('a an the of for to in on and or with vs via per at by as is be into from out off ' +
  'not no its it that this than then but are was were has have had will would can could all any one two ' +
  'new now also more most only same such so if when while its their our your has').split(/\s+/));
// repo-common words: too frequent across commit subjects to be distinctive on their own.
const COMMON = new Set(('task solve solver solved gate gates item items wave waves pass run runs fix fixed ' +
  'build built tool tools test tests module done open blocked queued pending next move moves work step ' +
  'add added update updated landed ship shipped wire wired port ported flag flagged default report honest ' +
  'owner live app ui ux mode path lane rig frame stage stages').split(/\s+/));

export function tokenize(str) {
  return String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}
export function distinctiveTerms(title) {
  const seen = new Set();
  for (const t of tokenize(title)) {
    if (STOP.has(t) || COMMON.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

// --- commit-hash extraction from ledger prose -------------------------------
// Repo convention is "@1c09a34". Accept @-prefixed hex (7-40) plus bare hex tokens
// that contain at least one a-f letter (so a 7-digit decimal is never mistaken).
export function extractHashes(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/@([0-9a-f]{7,40})\b/gi)) out.add(m[1].toLowerCase());
  for (const m of s.matchAll(/\b([0-9a-f]{7,40})\b/gi)) {
    const h = m[1].toLowerCase();
    if (/[a-f]/.test(h)) out.add(h);
  }
  return [...out];
}

// --- date helpers -----------------------------------------------------------
const isoDay = (isoTs) => String(isoTs || '').slice(0, 10);
const short = (hash) => String(hash || '').slice(0, 7);
export function firstIsoDate(text) {
  const m = String(text || '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}
export function buildNewStatus(evidence) {
  return `DONE ${isoDay(evidence.date)} @${short(evidence.hash)}`;
}

// --- core classifier --------------------------------------------------------
// commits: [{hash, subject, body, date}]  (hash = full, lowercased)
// verifyHashFn(hash) -> {hash, subject, date} | null   (out-of-window existence)
export function classifyItem(item, commits, opts = {}) {
  const { verifyHashFn = null } = opts;
  const id = String(item.id || '').toLowerCase();

  // EXACT (a): id verbatim in subject or body.
  if (id) {
    const idHits = commits.filter((c) =>
      (`${c.subject} ${c.body || ''}`).toLowerCase().includes(id));
    if (idHits.length) {
      const best = mostRecent(idHits);
      return { tier: 'EXACT', reason: 'id-verbatim', evidence: best,
        supporting: idHits.slice(0, 3), proposed: buildNewStatus(best) };
    }
  }

  // EXACT (b): status/one_liner names a commit hash that exists.
  const refHashes = extractHashes(`${item.status || ''} ${item.one_liner || ''}`);
  for (const rh of refHashes) {
    const inWindow = commits.find((c) => c.hash.startsWith(rh));
    if (inWindow) {
      return { tier: 'EXACT', reason: `hash @${short(rh)}`, evidence: inWindow,
        supporting: [inWindow], proposed: buildNewStatus(inWindow) };
    }
    if (verifyHashFn) {
      const v = verifyHashFn(rh);
      if (v) {
        return { tier: 'EXACT', reason: `hash @${short(rh)} (outside --since window)`,
          evidence: v, supporting: [v], proposed: buildNewStatus(v) };
      }
    }
  }

  // STRONG / WEAK: distinctive title terms vs commit SUBJECT tokens.
  const terms = distinctiveTerms(item.title);
  if (terms.length) {
    let best = null; // {commit, matched:[...]}
    for (const c of commits) {
      const subjSet = new Set(tokenize(c.subject));
      const matched = terms.filter((t) => subjSet.has(t));
      if (!matched.length) continue;
      if (!best || matched.length > best.matched.length ||
        (matched.length === best.matched.length && c.date > best.commit.date)) {
        best = { commit: c, matched };
      }
    }
    if (best) {
      const tier = best.matched.length >= 2 ? 'STRONG' : 'WEAK';
      return { tier, reason: `terms: ${best.matched.join(', ')}`,
        evidence: best.commit, supporting: [best.commit], proposed: null };
    }
  }
  return null;
}

function mostRecent(commits) {
  return commits.reduce((a, b) => (b.date > a.date ? b : a));
}

// --- reconcile (pure) -------------------------------------------------------
export function reconcile({ items, commits, opts = {}, scanText = null }) {
  const staleDays = opts.staleDays ?? 14;
  const nowMs = opts.now ?? Date.now();
  const scanNames = scanText ? String(scanText).toLowerCase() : null;

  const exact = [], strong = [], weak = [], stale = [], skipped = [];
  for (const item of items) {
    if (isResolved(item.status)) { skipped.push({ id: item.id, status: item.status }); continue; }
    const cls = classifyItem(item, commits, opts);
    const scanListed = scanNames
      ? scanNames.includes(String(item.id).toLowerCase()) : null;
    if (cls) {
      const row = { id: item.id, title: item.title, oldStatus: item.status,
        scanListed, ...cls };
      if (cls.tier === 'EXACT') exact.push(row);
      else if (cls.tier === 'STRONG') strong.push(row);
      else weak.push(row);
    }
    // Age-flag: non-resolved item with no EXACT/STRONG reconciliation whose status
    // carries an ISO date older than the stale threshold.
    if (!cls || cls.tier === 'WEAK') {
      const iso = firstIsoDate(item.status);
      if (iso) {
        const ageDays = Math.floor((nowMs - Date.parse(iso)) / 86400000);
        if (ageDays > staleDays) {
          stale.push({ id: item.id, oldStatus: item.status, isoDate: iso, ageDays,
            weakOnly: !!(cls && cls.tier === 'WEAK') });
        }
      }
    }
  }
  const rankT = (a, b) => (b.evidence.date > a.evidence.date ? 1 : -1);
  exact.sort(rankT); strong.sort(rankT); weak.sort(rankT);
  stale.sort((a, b) => b.ageDays - a.ageDays);
  return {
    exact, strong, weak, stale, skipped,
    summary: { total: items.length, exact: exact.length, strong: strong.length,
      weak: weak.length, stale: stale.length, skipped: skipped.length,
      commits: commits.length },
  };
}

// --- apply (EXACT only) -----------------------------------------------------
// Returns {ledger (mutated deep copy), audit:[{...}]}. Never touches non-EXACT.
export function applyExact(ledger, exactRows, opts = {}) {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const next = JSON.parse(JSON.stringify(ledger));
  const byId = new Map(next.items.map((it) => [it.id, it]));
  const audit = [];
  for (const row of exactRows) {
    const it = byId.get(row.id);
    if (!it) continue;
    const oldStatus = it.status;
    if (isResolved(oldStatus)) continue; // defensive: never overwrite a resolved status
    it.status = row.proposed;
    audit.push({ ts: nowIso, item_id: row.id, old_status: oldStatus,
      new_status: row.proposed, evidence_hash: short(row.evidence.hash) });
  }
  if (audit.length) next.generated_at = nowIso;
  return { ledger: next, audit };
}

// --- IO ---------------------------------------------------------------------
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
    commits.push({ hash: hash.trim().toLowerCase(), subject: (subject || '').trim(),
      body: (body || '').trim(), date: (date || '').trim() });
  }
  return commits;
}
function loadInjected(file) {
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  return arr.map((c) => ({ hash: String(c.hash || '').toLowerCase(),
    subject: c.subject || '', body: c.body || '', date: c.date || '' }));
}
function makeVerifier(repo) {
  return (hash) => {
    try {
      const out = execFileSync('git',
        ['-C', repo, 'show', '-s', '--format=%H%x1f%s%x1f%cI', `${hash}^{commit}`],
        { encoding: 'utf8' });
      const [h, s, d] = out.trim().split('\x1f');
      return { hash: (h || hash).toLowerCase(), subject: (s || '').trim(), date: (d || '').trim() };
    } catch { return null; }
  };
}

function resolveRepo(opts) {
  if (opts.repo) return opts.repo;
  // prefer a repo whose ledger actually exists (worktree lacks test_results/)
  if (fs.existsSync(path.join(DEFAULT_REPO, LEDGER_REL))) return DEFAULT_REPO;
  if (fs.existsSync(path.join(MAIN_REPO, LEDGER_REL))) return MAIN_REPO;
  return DEFAULT_REPO;
}
function resolveLedger(opts, repo) {
  if (opts.ledger) return opts.ledger;
  const here = path.join(repo, LEDGER_REL);
  if (fs.existsSync(here)) return here;
  return path.join(MAIN_REPO, LEDGER_REL);
}

// --- render -----------------------------------------------------------------
function printReport(res, meta) {
  const { summary } = res;
  console.log('done-propagation — REPORT ONLY (default; --apply writes EXACT only)');
  console.log(`repo:   ${meta.repo}`);
  console.log(`ledger: ${meta.ledgerPath}  (${summary.total} items, generated_at ${meta.generatedAt})`);
  console.log(`window: --since "${meta.since}"  -> ${summary.commits} commits`);
  console.log(`scan:   ${meta.scan || 'none'}`);
  console.log(`stale-threshold: ${meta.staleDays} days\n`);

  const scanTag = (r) => (r.scanListed ? '  [scan-listed]' : '');
  console.log(`== EXACT (${res.exact.length})  [applied with --apply] ==`);
  for (const r of res.exact) {
    console.log(`  ${r.id}${scanTag(r)}`);
    console.log(`      status:   "${r.oldStatus}"`);
    console.log(`      proposed: "${r.proposed}"   (${r.reason})`);
    console.log(`      evidence: @${short(r.evidence.hash)} "${r.evidence.subject}"`);
  }
  console.log(`\n== STRONG (${res.strong.length})  [orchestrator applies by hand] ==`);
  for (const r of res.strong) {
    console.log(`  ${r.id}  (${r.reason})${scanTag(r)}`);
    console.log(`      status:   "${r.oldStatus}"`);
    console.log(`      evidence: @${short(r.evidence.hash)} "${r.evidence.subject}"`);
  }
  console.log(`\n== WEAK (${res.weak.length})  [report-only, never applied] ==`);
  for (const r of res.weak) {
    console.log(`  ${r.id}  (${r.reason})  <- @${short(r.evidence.hash)} "${r.evidence.subject}"`);
  }
  console.log(`\n== STALE / AGE-FLAGGED (${res.stale.length}) ==`);
  for (const r of res.stale) {
    console.log(`  ${r.id}  age ${r.ageDays}d (status date ${r.isoDate}, threshold ${meta.staleDays}d)` +
      `${r.weakOnly ? ' [weak-match only]' : ''}`);
    console.log(`      status: "${r.oldStatus}"`);
  }
  console.log(`\nsummary: exact=${summary.exact} strong=${summary.strong} weak=${summary.weak} ` +
    `stale=${summary.stale} skipped=${summary.skipped} (resolved) / ${summary.total} items`);
}

// --- run --------------------------------------------------------------------
function run(opts) {
  const repo = resolveRepo(opts);
  const ledgerPath = resolveLedger(opts, repo);
  if (!fs.existsSync(ledgerPath)) {
    console.error(`ledger not found: ${ledgerPath}`);
    process.exit(2);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const since = opts.since || '7 days ago';
  const commits = opts.gitLogJson ? loadInjected(opts.gitLogJson) : loadGitLog(repo, since);
  const scanText = opts.scan ? fs.readFileSync(opts.scan, 'utf8') : null;
  const verifyHashFn = opts.gitLogJson ? null : makeVerifier(repo);

  const res = reconcile({
    items: ledger.items, commits,
    opts: { staleDays: opts.staleDays, verifyHashFn }, scanText,
  });
  const meta = {
    repo, ledgerPath, since, scan: opts.scan, staleDays: opts.staleDays ?? 14,
    generatedAt: ledger.generated_at,
  };

  if (opts.json) {
    console.log(JSON.stringify({ meta, ...res }, null, 2));
  } else {
    printReport(res, meta);
  }

  if (opts.apply) {
    if (!res.exact.length) {
      if (!opts.json) console.log('\n--apply: no EXACT matches — ledger left untouched.');
      return;
    }
    const { ledger: nextLedger, audit } = applyExact(ledger, res.exact);
    fs.writeFileSync(ledgerPath, JSON.stringify(nextLedger, null, 2) + '\n');
    const auditPath = path.join(path.dirname(ledgerPath), 'done_propagation_log.jsonl');
    fs.appendFileSync(auditPath, audit.map((a) => JSON.stringify(a)).join('\n') + '\n');
    if (!opts.json) {
      console.log(`\n--apply: rewrote ${audit.length} EXACT status line(s) in ${ledgerPath}`);
      console.log(`         audit -> ${auditPath}`);
    }
  }
}

// --- self-test --------------------------------------------------------------
function selfTest() {
  const checks = [];
  const assert = (name, cond) => checks.push({ name, ok: !!cond });

  // resolved-state detection
  assert('isResolved DONE', isResolved('DONE 2026-07-11 @abc1234'));
  assert('isResolved FAIL-stamped', isResolved('FAIL-stamped (2026-07-11)'));
  assert('isResolved retired', isResolved('retired (superseded)'));
  assert('isResolved closed', isResolved('closed — tried, non-mover'));
  assert('isResolved folded', isResolved('folded into decoder-cutover-task14'));
  assert('isResolved in-flight = false', !isResolved('in-flight (0/6->1/6)'));
  assert('isResolved queued = false', !isResolved('queued (next session)'));

  // hash + date + term helpers
  assert('extractHashes @ + bare-hex', (() => {
    const h = extractHashes('landed @1234567 and see abcdef1 plus 2026071 decimal');
    return h.includes('1234567') && h.includes('abcdef1') && !h.includes('2026071');
  })());
  assert('firstIsoDate', firstIsoDate('open 2020-01-03 (stale)') === '2020-01-03');
  assert('firstIsoDate absent', firstIsoDate('open (no date)') === null);
  assert('distinctive drops stop/common', (() => {
    const t = distinctiveTerms('Decoder cutover (task #14) — rawler replaces libraw');
    return t.includes('decoder') && t.includes('rawler') && t.includes('libraw') &&
      !t.includes('task') && !t.includes('the');
  })());
  assert('buildNewStatus', buildNewStatus({ date: '2026-07-05T10:00:00-07:00', hash: 'abcdef1234' }) === 'DONE 2026-07-05 @abcdef1');
  assert('parseGitLog roundtrip', (() => {
    const raw = ['H1', 's1', 'b1', '2026-07-05T00:00:00-07:00'].join('\x1f') + '\x1e' +
      ['H2', 's2', '', '2026-07-06T00:00:00-07:00'].join('\x1f') + '\x1e';
    const c = parseGitLog(raw);
    return c.length === 2 && c[0].hash === 'h1' && c[1].subject === 's2';
  })());

  // end-to-end fixtures
  const items = [
    { id: 'alpha-widget', title: 'Alpha widget interactive flowchart', status: 'in-flight 2026-01-01', one_liner: 'x' },
    { id: 'beta-thing', title: 'Beta thing decode rewrite', status: 'queued', one_liner: 'prep only' },
    { id: 'gamma-done', title: 'Gamma already done', status: 'DONE 2026-07-01 @0000aaa', one_liner: 'x' },
    { id: 'delta-hash', title: 'Delta obscurea referenced', status: 'in progress, landed @1234567', one_liner: '' },
    { id: 'epsilon-weak', title: 'Epsilon zzunusual', status: 'open 2020-01-01', one_liner: '' },
    { id: 'zeta-none', title: 'Zeta obscureb quuxx', status: 'open (no date)', one_liner: '' },
  ];
  const commits = [
    { hash: 'abcdef1234567890000000000000000000000000', subject: '[Module: x] alpha-widget shipped', body: 'implements alpha widget', date: '2026-07-05T10:00:00-07:00' },
    { hash: '1234567abc0000000000000000000000000000000', subject: '[Module: y] beta thing decode rewrite complete', body: '', date: '2026-07-06T10:00:00-07:00' },
    { hash: '9999999000000000000000000000000000000000', subject: 'unrelated epsilon change', body: '', date: '2026-07-07T10:00:00-07:00' },
  ];
  const res = reconcile({ items, commits, opts: { staleDays: 14, now: Date.parse('2026-07-11T00:00:00Z') } });
  const ids = (arr) => arr.map((r) => r.id).sort();
  assert('exact = alpha-widget + delta-hash', JSON.stringify(ids(res.exact)) === JSON.stringify(['alpha-widget', 'delta-hash']));
  assert('alpha exact reason id-verbatim', res.exact.find((r) => r.id === 'alpha-widget').reason === 'id-verbatim');
  assert('delta exact reason hash', /^hash @1234567/.test(res.exact.find((r) => r.id === 'delta-hash').reason));
  assert('alpha proposed DONE date+hash', res.exact.find((r) => r.id === 'alpha-widget').proposed === 'DONE 2026-07-05 @abcdef1');
  assert('strong = beta-thing', JSON.stringify(ids(res.strong)) === JSON.stringify(['beta-thing']));
  assert('weak = epsilon-weak', JSON.stringify(ids(res.weak)) === JSON.stringify(['epsilon-weak']));
  assert('gamma skipped (resolved)', res.skipped.some((r) => r.id === 'gamma-done'));
  assert('gamma not in any match tier', !res.exact.concat(res.strong, res.weak).some((r) => r.id === 'gamma-done'));
  assert('stale includes epsilon-weak (2020)', res.stale.some((r) => r.id === 'epsilon-weak'));
  assert('stale excludes alpha (exact, not flagged)', !res.stale.some((r) => r.id === 'alpha-widget'));
  assert('zeta unmatched + not stale (no date)', !res.stale.some((r) => r.id === 'zeta-none') &&
    !res.exact.concat(res.strong, res.weak).some((r) => r.id === 'zeta-none'));

  // apply mutates EXACT only + writes audit rows; other fields preserved
  const ledger = { generated_at: 'OLD', published: true, items };
  const { ledger: next, audit } = applyExact(ledger, res.exact, { nowIso: '2026-07-11T12:00:00.000Z' });
  const byId = Object.fromEntries(next.items.map((it) => [it.id, it]));
  assert('apply: alpha status rewritten', byId['alpha-widget'].status === 'DONE 2026-07-05 @abcdef1');
  assert('apply: delta status rewritten', byId['delta-hash'].status === 'DONE 2026-07-06 @1234567');
  assert('apply: beta untouched', byId['beta-thing'].status === 'queued');
  assert('apply: gamma untouched', byId['gamma-done'].status === 'DONE 2026-07-01 @0000aaa');
  assert('apply: generated_at bumped', next.generated_at === '2026-07-11T12:00:00.000Z');
  assert('apply: published preserved', next.published === true);
  assert('apply: one_liner preserved', byId['alpha-widget'].one_liner === 'x');
  assert('apply: audit has 2 rows', audit.length === 2);
  assert('apply: audit shape', audit[0].ts && audit[0].item_id && audit[0].old_status &&
    audit[0].new_status && audit[0].evidence_hash);
  assert('apply: source ledger untouched (deep copy)', items.find((it) => it.id === 'alpha-widget').status === 'in-flight 2026-01-01');

  let pass = 0;
  for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`); if (c.ok) pass++; }
  console.log(`\nself-test: ${pass}/${checks.length} passed`);
  return pass === checks.length;
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const o = { apply: false, json: false, selfTest: false, staleDays: 14 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--ledger') o.ledger = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--scan') o.scan = argv[++i];
    else if (a === '--stale-days') o.staleDays = parseInt(argv[++i], 10);
    else if (a === '--git-log-json') o.gitLogJson = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node tools/ops/done_propagation.mjs [--repo DIR] [--ledger FILE] [--since SPEC]');
  console.log('         [--scan FILE] [--stale-days N] [--apply] [--json] [--git-log-json FILE] [--self-test]');
  console.log('\nDefault = REPORT ONLY. --apply rewrites work_items.json for EXACT matches only.');
  process.exit(0);
} else if (opts.selfTest) {
  process.exit(selfTest() ? 0 : 1);
} else {
  run(opts);
}
