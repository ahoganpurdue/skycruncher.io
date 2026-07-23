#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ITERATIVE-BC lane — determinism gate for the banked-data-first leg
// ═══════════════════════════════════════════════════════════════════════════
// Runs enumerate_targets.mjs TWICE to distinct outputs and asserts the ledgers
// are byte-identical (md5). This is exit-gate #4 ("deterministic re-run of the
// banked-data leg byte-stable"). Pure banked data, no live compute.
//
// USAGE: node tools/iterbc/verify_deterministic.mjs
// Exit 0 = byte-stable; exit 1 = drift (prints the first differing offset).

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ENUM = path.join(HERE, 'enumerate_targets.mjs');
const LOOP = path.join(HERE, 'loop_runner.mjs');
const ART = 'D:/AstroLogic/test_artifacts/iterbc_2026-07-21';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iterbc-det-'));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function checkPair(label, argsFor) {
  const outA = path.join(tmp, `${label}_a.json`);
  const outB = path.join(tmp, `${label}_b.json`);
  execFileSync(process.execPath, argsFor(outA), { stdio: 'pipe' });
  const a = fs.readFileSync(outA);
  execFileSync(process.execPath, argsFor(outB), { stdio: 'pipe' });
  const b = fs.readFileSync(outB);
  const ok = a.length === b.length && md5(a) === md5(b);
  console.log(`[iterbc/verify] ${label}: bytes ${a.length}/${b.length} md5 ${md5(a).slice(0, 12)}/${md5(b).slice(0, 12)} -> ${ok ? 'STABLE' : 'DRIFT'}`);
  if (!ok) {
    let off = -1; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) { off = i; break; }
    console.error(`  first byte diff at offset ${off}`);
  }
  return ok;
}

let allOk = checkPair('enumerate', (out) => [ENUM, '--out', out]);
// The loop leg needs the banked live-capture buffer; skip (honest) if absent.
if (fs.existsSync(path.join(ART, 'm66_buffer.f32'))) {
  const dA = fs.mkdtempSync(path.join(tmp, 'loopA-'));
  const dB = fs.mkdtempSync(path.join(tmp, 'loopB-'));
  execFileSync(process.execPath, [LOOP, '--out-dir', dA], { stdio: 'pipe' });
  execFileSync(process.execPath, [LOOP, '--out-dir', dB], { stdio: 'pipe' });
  const a = fs.readFileSync(path.join(dA, 'm66_loop_ledger.json'));
  const b = fs.readFileSync(path.join(dB, 'm66_loop_ledger.json'));
  const ok = a.length === b.length && md5(a) === md5(b);
  console.log(`[iterbc/verify] loop: bytes ${a.length}/${b.length} md5 ${md5(a).slice(0, 12)}/${md5(b).slice(0, 12)} -> ${ok ? 'STABLE' : 'DRIFT'}`);
  allOk = ok && allOk;
} else {
  console.log('[iterbc/verify] loop: SKIPPED — banked capture buffer absent (run capture_m66.iterbcspec first)');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(allOk ? '[iterbc/verify] PASS — banked legs byte-stable across runs.' : '[iterbc/verify] FAIL');
process.exit(allOk ? 0 : 1);
