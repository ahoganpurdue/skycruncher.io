// [Module: community] End-to-end proof for the receipt-intake channel.
// Takes a REAL banked receipt, scrubs it, and exercises the deployed Worker:
//   scrubbed POST -> 201 | re-POST -> 200 deduped | unscrubbed -> 422 | oversize -> 413
//
// Usage: node tools/community/intake_e2e_proof.mjs [receiptPath] [baseUrl]
import fs from 'node:fs';
import { scrubReceipt } from './scrub_receipt.mjs';

const RECEIPT = process.argv[2] || 'test_results/deep_cones/m66.receipt.json';
const BASE = (process.argv[3] || 'https://skycruncher-ingest.ahoganpurdue.workers.dev').replace(/\/$/, '');
const URL = `${BASE}/v1/receipts`;

async function post(bodyStr) {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr });
  let body;
  try { body = await r.json(); } catch { body = await r.text(); }
  return { status: r.status, body };
}

const raw = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
const { scrubbed, report } = scrubReceipt(raw);
const scrubbedStr = JSON.stringify(scrubbed);

console.log('=== SCRUB REPORT for', RECEIPT, '===');
console.log(JSON.stringify(report, null, 2));
console.log('scrubbed bytes:', Buffer.byteLength(scrubbedStr));

const results = [];

// 1. POST scrubbed -> 201
const r1 = await post(scrubbedStr);
results.push(['POST scrubbed', r1.status, JSON.stringify(r1.body)]);
const key = r1.body && r1.body.key;

// 2. Re-POST same -> 200 deduped:true
const r2 = await post(scrubbedStr);
results.push(['re-POST same', r2.status, JSON.stringify(r2.body)]);

// 3. POST an unscrubbed-shaped payload -> 422 naming field.
// SYNTHETIC by rule: never send a real receipt's raw fields (GPS, provenance,
// prose) across the wire, even to be rejected — the negative case only needs
// the SHAPE of a privacy violation, so it carries fabricated values.
const syntheticUnscrubbed = {
  ...scrubbed,
  metadata: {
    ...(scrubbed.metadata || {}),
    gps_lat: 12.345678,
    gps_lon: -98.765432,
    gps_alt: 123.4,
    source_provenance: { uri: 'synthetic://not-a-real-path/frame.cr2' },
  },
  user_annotations: { location_text: 'synthetic negative-case location' },
};
const r3 = await post(JSON.stringify(syntheticUnscrubbed));
results.push(['POST unscrubbed(synthetic)', r3.status, JSON.stringify(r3.body)]);

// 4. POST >2MB junk -> 413
const junk = JSON.stringify({ version: '2.20.0', pad: 'x'.repeat(2 * 1024 * 1024 + 16) });
const r4 = await post(junk);
results.push([`POST oversize (${Buffer.byteLength(junk)}B)`, r4.status, JSON.stringify(r4.body)]);

// 5. Bad JSON -> 400
const r5 = await post('{not json');
results.push(['POST bad-json', r5.status, JSON.stringify(r5.body)]);

// 6. Missing version -> 422
const r6 = await post(JSON.stringify({ metadata: {} }));
results.push(['POST no-version', r6.status, JSON.stringify(r6.body)]);

console.log('\n=== E2E PROOF TABLE ===');
console.log('case'.padEnd(28), 'status', 'response');
for (const [c, s, b] of results) console.log(String(c).padEnd(28), s, b.slice(0, 160));
console.log('\nintake key:', key);
