#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/inspect_incoming.mjs — provenance-aware intake seam (INGEST direction)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/inspect_incoming.mjs <any-asset>
//
// Given ANY incoming asset, report its C2PA provenance: absent / present-foreign /
// ours-valid / tampered — honestly. This is the read-side counterpart to signing:
// the seam a future intake-fetcher (tools/overnight/fetch_intake.mjs) calls to know
// what it just received before it enters the pipeline.
//
// POSTURE (owner directive, intake-fetcher memory): provenance at intake is a
// FLAG, not a GATE. "No provenance" is the normal wild-west case — reported as a
// neutral ABSENT, never an error. This tool always exits 0 when it produced a
// report; the `verdict` field is advisory for the caller to act on. (For a hard
// pass/fail gate on a KNOWN-signed asset, use verify.mjs, which exits 5 on tamper.)
//
// Verdicts:
//   ABSENT                — no C2PA manifest (normal; provenance simply not present)
//   SKYCRUNCHER_VALID     — our org.skycruncher.* (or legacy org.astrologic.*)
//                           assertions present + integrity valid
//   SKYCRUNCHER_TAMPERED  — our assertions present but the binding failed (edited)
//   FOREIGN_VALID         — C2PA from another tool, integrity valid, not ours
//   FOREIGN_INVALID       — C2PA present (any signer) but integrity failed
//   UNREADABLE            — c2patool could not parse (corrupt / unsupported)
//
// LEGACY NAMESPACE: assets signed before the SkyCruncher rename carry
// `org.astrologic.*` labels. Verification accepts BOTH namespaces (new first,
// legacy retained — never dropped) so old signed images still verify as ours.

const OUR_RECEIPT_LABELS = ['org.skycruncher.receipt', 'org.astrologic.receipt'];
const OUR_EPISTEMIC_LABELS = ['org.skycruncher.epistemic', 'org.astrologic.epistemic'];

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireC2paTool } from './lib/env.mjs';

const FAIL_CODE = /(mismatch|invalid|error|notvalid|failed|missing)/i;

function runTool(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function parseJsonLoose(s) { try { return JSON.parse(s); } catch { return null; } }

function main() {
  const assetArg = process.argv.slice(2).find((t) => !t.startsWith('--'));
  if (!assetArg) {
    process.stderr.write('usage: node tools/c2pa/inspect_incoming.mjs <any-asset>\n');
    process.exit(1);
  }
  const tool = requireC2paTool();
  const asset = path.resolve(assetArg);
  if (!fs.existsSync(asset)) { process.stderr.write(`[c2pa] asset not found: ${asset}\n`); process.exit(1); }

  const detailed = runTool(tool, [asset, '-d']);
  const combined = detailed.stdout + detailed.stderr;

  // No manifest ⇒ ABSENT (the normal wild-west intake case).
  if (/No claim found/i.test(combined)) {
    process.stdout.write(JSON.stringify({
      asset, c2pa_present: false, verdict: 'ABSENT',
      is_skycruncher: false, advisory: 'no provenance — flag for intake, do not gate',
    }, null, 2) + '\n');
    process.stderr.write('[c2pa] INTAKE: ABSENT (no C2PA provenance)\n');
    process.exit(0);
  }

  const dj = parseJsonLoose(detailed.stdout);
  if (!dj || !dj.active_manifest) {
    process.stdout.write(JSON.stringify({ asset, c2pa_present: true, verdict: 'UNREADABLE', is_skycruncher: false }, null, 2) + '\n');
    process.stderr.write('[c2pa] INTAKE: UNREADABLE (C2PA data present but unparseable)\n');
    process.exit(0);
  }

  const status = Array.isArray(dj.validation_status) ? dj.validation_status : [];
  const codes = status.map((s) => s.code);
  const integrityValid = codes.includes('claimSignature.validated')
    && codes.includes('assertion.dataHash.match')
    && !status.some((s) => FAIL_CODE.test(s.code));

  const report = parseJsonLoose(runTool(tool, [asset]).stdout);
  const mid = report?.active_manifest;
  const man = report?.manifests?.[mid] || {};
  const assertions = man.assertions || [];
  const receiptAssertion = assertions.find((a) => OUR_RECEIPT_LABELS.includes(a.label));
  const epistemicAssertion = assertions.find((a) => OUR_EPISTEMIC_LABELS.includes(a.label));
  const isOurs = !!receiptAssertion;
  const issuer = man.signature_info?.issuer || null;

  let verdict;
  if (isOurs) verdict = integrityValid ? 'SKYCRUNCHER_VALID' : 'SKYCRUNCHER_TAMPERED';
  else verdict = integrityValid ? 'FOREIGN_VALID' : 'FOREIGN_INVALID';

  process.stdout.write(JSON.stringify({
    asset,
    c2pa_present: true,
    verdict,
    integrity_valid: integrityValid,
    is_skycruncher: isOurs,
    signer: issuer,
    dev_cert: /test/i.test(issuer || ''),
    claim_generator: man.claim_generator || null,
    validation_codes: codes,
    receipt_sha256: receiptAssertion?.data?.receipt_sha256 || null,
    measured_families: epistemicAssertion?.data?.measured || null,
    advisory: 'provenance is a FLAG for intake, not a gate',
  }, null, 2) + '\n');
  process.stderr.write(`[c2pa] INTAKE: ${verdict}${isOurs ? ' (SkyCruncher provenance)' : ''}\n`);
  process.exit(0);
}

main();
