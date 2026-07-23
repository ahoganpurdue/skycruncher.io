#!/usr/bin/env node
// stale_inflight_lint.mjs — REPORT-ONLY mechanical linter.
// Scans docs/NEXT_MOVES.md + CLAUDE.md (+ optionally docs/GATES.md prose) for
// STATUS-CLAIM markers ("in flight", "RUNNING", "in progress", "queued",
// "BLOCKED ON", "pending") and cross-checks each against freshness signals:
//   1. git-blame age of the claim line (> --days = suspect)
//   2. references to thesis ids that are now STAMPED (registry.jsonl) => terminal
//   3. references to commits that have landed (git cat-file), corroborating stale
//   4. an inline ISO date older than --days on the claim line
// It NEVER edits any doc. Output = a ranked staleness report (file:line, claim,
// evidence, suggested action). CRITICAL > HIGH > MEDIUM, then by age.
//
// CLI:  node tools/docs/stale_inflight_lint.mjs [--root <dir>] [--days N]
//                                               [--include-gates] [--json] [--self-test]
//
// Exit code is always 0 in report mode (informational); --self-test exits 1 on failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

// --- status-claim markers (case-insensitive regexes) ------------------------
const MARKERS = [
  { name: 'in flight', re: /\bin[-\s]?flight\b/i },
  { name: 'RUNNING', re: /\bRUNNING\b/ }, // case-sensitive: status-marker convention
  { name: 'in progress', re: /\bin[-\s]progress\b/i },
  { name: 'queued', re: /\bqueued\b/i },
  { name: 'BLOCKED ON', re: /\bblocked on\b/i },
  { name: 'pending', re: /\bpending\b/i },
];

function detectMarkers(line) {
  return MARKERS.filter((m) => m.re.test(line)).map((m) => m.name);
}

// Thesis/DRAFT id tokens that are specific enough to cross-check.
function thesisTokens(line) {
  const out = [];
  const re = /\b(?:THESIS-(?:\d[\w-]*)|DRAFT-[a-z][\w-]*)/gi;
  let m;
  while ((m = re.exec(line))) out.push(m[0]);
  return out;
}

// Match a doc token against a stamped id (handles short forms like "THESIS-002"
// referring to registry id "THESIS-002-decoder-flip-reach").
function matchStamped(token, stampedMap) {
  const t = token.toUpperCase();
  for (const id of stampedMap.keys()) {
    const u = id.toUpperCase();
    if (u === t || u.startsWith(t) || t.startsWith(u)) return id;
  }
  return null;
}

// candidate short commit shas on the line (7-40 hex, often `abc1234` or @abc1234)
function commitTokens(line) {
  const out = new Set();
  const re = /(?:^|[\s@(`])([0-9a-f]{7,40})(?=[\s)`.,;]|$)/g;
  let m;
  while ((m = re.exec(line))) out.add(m[1]);
  return [...out];
}

function isoDatesOlderThan(line, nowMs, days) {
  const out = [];
  const re = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  let m;
  while ((m = re.exec(line))) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isNaN(t)) {
      const age = (nowMs - t) / 86400000;
      if (age > days) out.push({ date: m[0], age });
    }
  }
  return out;
}

// --- registry ---------------------------------------------------------------
function loadStamped(registryPath) {
  const map = new Map(); // id -> status
  if (!registryPath || !fs.existsSync(registryPath)) return map;
  const lines = fs.readFileSync(registryPath, 'utf8').split(/\r?\n/);
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && o.kind === 'stamp' && o.id) map.set(o.id, o.status || 'STAMPED');
    } catch { /* skip malformed */ }
  }
  return map;
}

// --- git helpers (best-effort; return null on any failure) ------------------
function makeGit(root) {
  let repoTop = null;
  try {
    repoTop = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { repoTop = null; }
  const commitCache = new Map();
  return {
    ok: !!repoTop,
    blameAgeDays(absPath, lineNo, nowMs) {
      if (!repoTop) return null;
      try {
        const out = execFileSync(
          'git', ['-C', repoTop, 'blame', '-L', `${lineNo},${lineNo}`, '--line-porcelain', '--', absPath],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const m = out.match(/^committer-time (\d+)/m);
        if (!m) return null;
        return (nowMs - Number(m[1]) * 1000) / 86400000;
      } catch { return null; }
    },
    commitExists(sha) {
      if (!repoTop) return false;
      if (commitCache.has(sha)) return commitCache.get(sha);
      let exists = false;
      try {
        execFileSync('git', ['-C', repoTop, 'cat-file', '-e', `${sha}^{commit}`],
          { stdio: 'ignore' });
        exists = true;
      } catch { exists = false; }
      commitCache.set(sha, exists);
      return exists;
    },
  };
}

// --- core scan (pure; git + registry injected for testability) --------------
// ctx: { stampedMap, days, nowMs, blameFn(abs,line)->ageDays|null, commitFn(sha)->bool }
function scanText(label, absPath, text, ctx) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const markers = detectMarkers(raw);
    if (markers.length === 0) return;

    const signals = [];
    let tier = null; // CRITICAL > HIGH > MEDIUM
    let ageDays = ctx.blameFn ? ctx.blameFn(absPath, lineNo) : null;

    // (1) stamped-thesis reference -> terminal, strongest signal
    const stampedRefs = [];
    for (const tok of thesisTokens(raw)) {
      const id = matchStamped(tok, ctx.stampedMap);
      if (id) stampedRefs.push({ tok, id, status: ctx.stampedMap.get(id) });
    }
    if (stampedRefs.length) {
      tier = 'CRITICAL';
      signals.push(
        'references STAMPED thesis ' +
          stampedRefs.map((s) => `${s.id} (${s.status})`).join(', ') +
          ` — a terminal-verdict thesis marked "${markers[0]}"`,
      );
    }

    // (3) landed-commit corroboration (only meaningful with an aging line).
    // Suppressed on self-evident completion-summary lines, where the marker word
    // ("pending"/"queued") appears in a sub-clause of an already-done statement.
    const COMPLETION = /\b(LANDED|SHIPPED|DONE|RESOLVED|MERGED|RETIRED|REMOVED|byte-identical)\b/;
    let landedCommits = [];
    if (ctx.commitFn && !COMPLETION.test(raw)) landedCommits = commitTokens(raw).filter((s) => ctx.commitFn(s));

    // (2) blame age
    if (ageDays != null && ageDays > ctx.days) {
      signals.push(`claim line unchanged for ${ageDays.toFixed(1)}d (> ${ctx.days}d threshold)`);
      if (landedCommits.length) {
        signals.push(`cites landed commit(s) ${landedCommits.join(', ')} yet still marked "${markers[0]}"`);
        if (!tier) tier = 'HIGH';
      }
      if (!tier) tier = 'MEDIUM';
    }

    // (4) inline stale date — FALLBACK age proxy, only when git-blame gave us
    // nothing for this line (blame is authoritative when available; this avoids
    // pairing an unrelated inline date with generic "in-flight" prose).
    if (ageDays == null) {
      const staleDates = isoDatesOlderThan(raw, ctx.nowMs, ctx.days);
      if (staleDates.length) {
        const oldest = staleDates.sort((a, b) => b.age - a.age)[0];
        signals.push(`inline date ${oldest.date} is ${oldest.age.toFixed(1)}d old alongside marker "${markers[0]}" (git-blame unavailable — date used as age proxy)`);
        if (!tier) tier = 'MEDIUM';
      }
    }

    if (signals.length === 0) return; // marker present but no staleness evidence -> not actionable

    let suggestion;
    if (stampedRefs.length) {
      suggestion = `Update or delete: ${stampedRefs.map((s) => s.id).join(', ')} already has a terminal ${stampedRefs.map((s) => s.status).join('/')} verdict — the "${markers.join('/')}" phrasing no longer holds.`;
    } else if (landedCommits.length && ageDays != null && ageDays > ctx.days) {
      suggestion = `Confirm whether the cited work (${landedCommits.join(', ')}) has completed; if so, drop the "${markers.join('/')}" marker.`;
    } else {
      suggestion = `Re-verify this "${markers.join('/')}" claim against current state; it has not been touched in ${ageDays != null ? ageDays.toFixed(1) + 'd' : 'a while'}.`;
    }

    findings.push({
      file: label,
      line: lineNo,
      tier,
      markers,
      ageDays,
      signals,
      suggestion,
      text: raw.trim().replace(/\s+/g, ' ').slice(0, 180),
    });
  });
  return findings;
}

const TIER_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
function rankFindings(f) {
  return f.slice().sort((a, b) => {
    const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (t !== 0) return t;
    return (b.ageDays ?? 0) - (a.ageDays ?? 0);
  });
}

// --- production run ---------------------------------------------------------
function run(opts) {
  const root = opts.root || DEFAULT_ROOT;
  const nowMs = opts.nowMs || Date.now();
  const targets = [
    { label: 'docs/NEXT_MOVES.md', abs: path.join(root, 'docs', 'NEXT_MOVES.md') },
    { label: 'CLAUDE.md', abs: path.join(root, 'CLAUDE.md') },
  ];
  if (opts.includeGates) targets.push({ label: 'docs/GATES.md', abs: path.join(root, 'docs', 'GATES.md') });

  const registryPath = path.join(root, 'test_results', 'theses', 'registry.jsonl');
  const stampedMap = loadStamped(registryPath);
  const registryPresent = fs.existsSync(registryPath);
  const git = makeGit(root);

  const ctx = {
    stampedMap,
    days: opts.days,
    nowMs,
    blameFn: git.ok ? (abs, line) => git.blameAgeDays(abs, line, nowMs) : null,
    commitFn: git.ok ? (sha) => git.commitExists(sha) : null,
  };

  let all = [];
  const scanned = [];
  for (const t of targets) {
    if (!fs.existsSync(t.abs)) continue;
    scanned.push(t.label);
    all = all.concat(scanText(t.label, t.abs, fs.readFileSync(t.abs, 'utf8'), ctx));
  }
  return {
    ranked: rankFindings(all),
    meta: {
      root, scanned, days: opts.days,
      registryPresent, stampedCount: stampedMap.size,
      gitAvailable: git.ok,
    },
  };
}

function printReport({ ranked, meta }) {
  console.log('stale-inflight-lint — REPORT ONLY (never edits docs)');
  console.log(`root: ${meta.root}`);
  console.log(`scanned: ${meta.scanned.join(', ') || '(none found)'}`);
  console.log(
    `signals: git-blame=${meta.gitAvailable ? 'on' : 'OFF'} · registry=${meta.registryPresent ? meta.stampedCount + ' stamped ids' : 'ABSENT (cross-check skipped honestly)'} · age-threshold=${meta.days}d`,
  );
  console.log(`findings: ${ranked.length}`);
  console.log('');
  if (ranked.length === 0) {
    console.log('  (no stale in-flight claims detected)');
    return;
  }
  ranked.forEach((f, i) => {
    console.log(`#${i + 1}  [${f.tier}]  ${f.file}:${f.line}   markers: ${f.markers.join(', ')}`);
    console.log(`    claim: ${f.text}`);
    for (const s of f.signals) console.log(`    ↳ ${s}`);
    console.log(`    → ${f.suggestion}`);
    console.log('');
  });
}

// --- self-test --------------------------------------------------------------
function selfTest() {
  const nowMs = Date.parse('2026-07-11T12:00:00Z');
  const stampedMap = new Map([
    ['THESIS-002-decoder-flip-reach', 'FAIL'],
    ['THESIS-2026-07-10-001', 'FAIL'],
  ]);
  // injected blame: line 3 is old, others fresh
  const blameFn = (_abs, line) => (line === 3 ? 20 : 0.5);
  const commitFn = (sha) => sha === 'abc1234'; // pretend this one landed
  const ctx = { stampedMap, days: 3, nowMs, blameFn, commitFn };

  const fixture = [
    'Line 1: nothing to see here, plain prose.',                                  // 1 no marker
    '- THESIS-002 recal sweep dispatched, in flight (@abc1234).',                 // 2 CRITICAL (stamped ref)
    '- Old queued task from the before-times, still pending review.',             // 3 MEDIUM (blame 20d)
    '- Fresh in-flight item started today, no stale evidence.',                   // 4 marker, fresh, NO signal -> skip
    '- Historical note: shipped 2020-01-01, RUNNING then (now done).',            // 5 inline stale date
    '- A calm sentence mentioning progress but not the marker phrase.',           // 6 no marker
  ].join('\n');

  // git-ON pass: blame authoritative; inline-date must NOT fire on line 5.
  const found = scanText('FIXTURE', '/fixture.md', fixture, ctx);
  const byLine = new Map(found.map((f) => [f.line, f]));

  const checks = [];
  const assert = (name, cond) => checks.push({ name, ok: !!cond });

  assert('flags stamped-thesis line 2 as CRITICAL', byLine.get(2)?.tier === 'CRITICAL');
  assert('stamped signal names the id', byLine.get(2)?.signals.join(' ').includes('THESIS-002-decoder-flip-reach'));
  assert('flags aged line 3 as MEDIUM', byLine.get(3)?.tier === 'MEDIUM');
  assert('does NOT flag fresh marker line 4', !byLine.has(4));
  assert('git-ON: inline-date line 5 suppressed (blame authoritative)', !byLine.has(5));
  assert('does NOT flag no-marker line 6', !byLine.has(6));
  assert('does NOT flag no-marker line 1', !byLine.has(1));
  assert('git-ON: exactly 2 findings', found.length === 2);
  const ranked = rankFindings(found);
  assert('ranking puts CRITICAL first', ranked[0]?.line === 2);

  // completion-line guard: a "LANDED ... pending recal" summary keeps its commits
  // from escalating to HIGH (still MEDIUM by age, not commit-corroborated).
  const doneFixture = '- **LANDED overnight** (@abc1234): promotion BLOCKED pending recal.';
  const doneCtx = { stampedMap, days: 1, nowMs, blameFn: () => 5, commitFn };
  const doneFound = scanText('FIXTURE', '/f.md', doneFixture, doneCtx);
  assert('completion-line not escalated to HIGH by commit ref', doneFound[0]?.tier === 'MEDIUM');
  assert('completion-line has no commit-corroboration signal', !doneFound[0]?.signals.some((s) => s.includes('cites landed')));

  // git-OFF pass: no blame -> inline-date fallback fires on line 5.
  const ctxNoGit = { stampedMap, days: 3, nowMs, blameFn: null, commitFn: null };
  const foundNoGit = scanText('FIXTURE', '/fixture.md', fixture, ctxNoGit);
  const noGitLines = new Map(foundNoGit.map((f) => [f.line, f]));
  assert('git-OFF: inline-date line 5 flagged as MEDIUM', noGitLines.get(5)?.tier === 'MEDIUM');
  assert('git-OFF: stamped line 2 still CRITICAL (git-independent)', noGitLines.get(2)?.tier === 'CRITICAL');
  assert('git-OFF: aged-but-no-date line 3 not flagged (no blame, no date)', !noGitLines.has(3));

  // matchStamped short-form behavior
  assert('short-form THESIS-002 matches full id', matchStamped('THESIS-002', stampedMap) === 'THESIS-002-decoder-flip-reach');
  assert('unrelated token does not match', matchStamped('THESIS-999', stampedMap) === null);
  // marker word-boundary sanity
  assert('does not treat "pendingfoo" substring as running-word only', detectMarkers('rerunning the loop').includes('RUNNING') === false);

  let pass = 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (c.ok) pass++;
  }
  console.log(`\nself-test: ${pass}/${checks.length} passed`);
  return pass === checks.length;
}

// --- arg parsing ------------------------------------------------------------
function parseArgs(argv) {
  const o = { days: 3, json: false, includeGates: false, selfTest: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--json') o.json = true;
    else if (a === '--include-gates') o.includeGates = true;
    else if (a === '--days') o.days = Number(argv[++i]);
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node tools/docs/stale_inflight_lint.mjs [--root DIR] [--days N] [--include-gates] [--json] [--self-test]');
  process.exit(0);
} else if (opts.selfTest) {
  process.exit(selfTest() ? 0 : 1);
} else {
  const result = run(opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}
