#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/verify.mjs — verify a signed asset + round-trip our assertions
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/verify.mjs <asset> [--receipt <original.receipt.json>]
//
// Verdict from c2patool's validation_status codes — NOT its exit code (c2patool
// reports a broken binding as a status entry while still exiting 0, so a naive
// exit-code check would pass a tampered asset). We treat ANY code containing
// mismatch/invalid/error as a failure, and require both claimSignature.validated
// AND assertion.dataHash.match for a PASS.
//
// With --receipt, recomputes sha256 over the original receipt bytes and compares
// it to the embedded org.skycruncher.receipt.receipt_sha256 — proving both that our
// custom assertions round-tripped intact and that the manifest binds THAT receipt.
//
// LEGACY NAMESPACE: assets signed before the SkyCruncher rename carry
// `org.astrologic.*` labels; verification accepts BOTH (new first, legacy retained
// and never dropped) so previously-signed images still verify as ours.
//
// Exit 0 = VALID · 5 = INVALID/tampered · 3 = tool missing · 1 = usage/error.

// Accepted assertion labels — new namespace first, legacy retained (cold-path doctrine).
const OUR_RECEIPT_LABELS = ['org.skycruncher.receipt', 'org.astrologic.receipt'];
const OUR_EPISTEMIC_LABELS = ['org.skycruncher.epistemic', 'org.astrologic.epistemic'];

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireC2paTool } from './lib/env.mjs';
import { receiptSha256 } from './manifest_from_receipt.mjs';

const FAIL_CODE = /(mismatch|invalid|error|notvalid|failed|missing)/i;

/** sha256 of a receipt file's bytes, or null if it cannot be read. */
function receiptSha256IfAvailable(p) {
  try { return receiptSha256(fs.readFileSync(p)); } catch { return null; }
}

function runTool(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function main() {
  const argv = process.argv.slice(2);
  let assetArg = null, receiptArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--receipt') receiptArg = argv[++i];
    else if (!argv[i].startsWith('--')) assetArg = argv[i];
    else { process.stderr.write(`[c2pa] unknown flag ${argv[i]}\n`); process.exit(1); }
  }
  if (!assetArg) {
    process.stderr.write('usage: node tools/c2pa/verify.mjs <asset> [--receipt <receipt.json>]\n');
    process.exit(1);
  }
  const tool = requireC2paTool();
  const asset = path.resolve(assetArg);
  if (!fs.existsSync(asset)) { process.stderr.write(`[c2pa] asset not found: ${asset}\n`); process.exit(1); }

  // (1) validation_status from the detailed report
  const detailed = runTool(tool, [asset, '-d']);
  const dj = parseJsonLoose(detailed.stdout);
  const status = Array.isArray(dj?.validation_status) ? dj.validation_status : null;

  // No manifest / unreadable ⇒ nothing to verify ⇒ INVALID.
  if (!dj || !dj.active_manifest) {
    const out = { asset, valid: false, reason: 'NO_C2PA_MANIFEST', codes: [] };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.stderr.write('[c2pa] VERDICT: INVALID (no readable C2PA manifest)\n');
    process.exit(5);
  }

  const codes = (status || []).map((s) => s.code);
  const hasSig = codes.includes('claimSignature.validated');
  const hasDataHash = codes.includes('assertion.dataHash.match');
  const failing = (status || []).filter((s) => FAIL_CODE.test(s.code));
  const valid = hasSig && hasDataHash && failing.length === 0;

  // (2) round-trip our assertions from the clean (default) report
  const report = parseJsonLoose(runTool(tool, [asset]).stdout);
  const mid = report?.active_manifest;
  const assertions = report?.manifests?.[mid]?.assertions || [];
  const receiptAssertion = assertions.find((a) => OUR_RECEIPT_LABELS.includes(a.label));
  const epistemicAssertion = assertions.find((a) => OUR_EPISTEMIC_LABELS.includes(a.label));
  const embeddedSha = receiptAssertion?.data?.receipt_sha256 || null;

  // (3) optional receipt binding check
  let sha_match = null, expected_sha = null;
  if (receiptArg) {
    expected_sha = receiptSha256IfAvailable(path.resolve(receiptArg));
    sha_match = expected_sha != null && embeddedSha != null && expected_sha === embeddedSha;
  }

  const out = {
    asset,
    valid,
    signer: report?.manifests?.[mid]?.signature_info?.issuer || null,
    dev_cert: /test/i.test(report?.manifests?.[mid]?.signature_info?.issuer || ''),
    codes,
    failing_codes: failing.map((s) => ({ code: s.code, explanation: s.explanation })),
    org_skycruncher_receipt_present: !!receiptAssertion,
    org_skycruncher_epistemic_present: !!epistemicAssertion,
    receipt_sha256: embeddedSha,
    measured_families: epistemicAssertion?.data?.measured || null,
    ...(receiptArg ? { expected_receipt_sha256: expected_sha, receipt_sha256_match: sha_match } : {}),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  const shaNote = receiptArg ? ` · receipt_sha256_match=${sha_match}` : '';
  process.stderr.write(`[c2pa] VERDICT: ${valid ? 'VALID' : 'INVALID'}${shaNote}\n`);
  // sha mismatch is a hard fail too (bound to a different receipt)
  process.exit(valid && (sha_match !== false) ? 0 : 5);
}

main();
