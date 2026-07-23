// arrow_loader.mjs — fetch + decode a starplate blob (Arrow IPC file format).
//
// Schema per docs/STARPLATES_SPEC.md §3.2 / §5.2 (FROZEN):
//   0 ra_deg:f64  1 dec_deg:f64  2 pm_ra_masyr:f32  3 pm_dec_masyr:f32
//   4 g_mag:f32   5 bp_rp:f32    6 source_id:u64
// Rows sorted g_mag asc — so any brightest-K LOD is a row prefix.
// This loader works from the documented schema only; it never assumes row
// counts and reports what it actually decoded.
//
// source_id note (spec §3.1 tooling trap): u64 exceeds Number.MAX_SAFE_INTEGER.
// The lab does not touch source_id at all — display needs none of it — which
// is the safest possible handling.

import { tableFromIPC } from 'apache-arrow';

const REQUIRED = ['ra_deg', 'dec_deg', 'g_mag', 'bp_rp'];

/**
 * Try each URL in order; return the first successfully decoded starplate.
 * Result: { raDeg: Float64Array, decDeg: Float64Array, gMag: Float32Array,
 *           bpRp: Float32Array, rows, bytes, url, fetchMs, decodeMs, release }
 */
export async function loadStarplate(urls) {
  const failures = [];
  for (const url of urls) {
    let res;
    const t0 = performance.now();
    try {
      res = await fetch(url);
    } catch (err) {
      failures.push(`${url}: fetch failed (${err.message})`);
      continue;
    }
    if (!res.ok) {
      failures.push(`${url}: HTTP ${res.status}`);
      continue;
    }
    const buf = await res.arrayBuffer();
    const fetchMs = performance.now() - t0;

    const t1 = performance.now();
    const table = tableFromIPC(new Uint8Array(buf));
    const decodeMs = performance.now() - t1;

    const missing = REQUIRED.filter((name) => !table.getChild(name));
    if (missing.length > 0) {
      const have = table.schema.fields.map((f) => f.name).join(', ');
      throw new Error(
        `starplate at ${url} is missing column(s) [${missing.join(', ')}] — ` +
        `decoded schema: [${have}]. Expected docs/STARPLATES_SPEC.md §3.2.`,
      );
    }

    // Single record batch (spec §3.2) => toArray() returns the contiguous
    // TypedArray view: Float64Array for f64 columns, Float32Array for f32.
    const raDeg = table.getChild('ra_deg').toArray();
    const decDeg = table.getChild('dec_deg').toArray();
    const gMag = table.getChild('g_mag').toArray();
    const bpRp = table.getChild('bp_rp').toArray();

    // Release id from schema custom_metadata (key suffix match — the lab
    // hardcodes no key prefixes and no product names).
    let release = null;
    for (const [key, value] of table.schema.metadata) {
      if (key.endsWith('.release')) { release = value; break; }
    }

    return {
      raDeg, decDeg, gMag, bpRp,
      rows: table.numRows,
      bytes: buf.byteLength,
      url, fetchMs, decodeMs, release,
    };
  }
  throw new Error(
    `no starplate blob reachable — tried:\n  ${failures.join('\n  ')}\n` +
    'See tools/renderlab/README.md ("Data") for how to provide one.',
  );
}
