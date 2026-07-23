#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/manifest_test.mjs — self-test for manifest.mjs (Manifest v2)
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (tools-lane idiom; `_test.mjs` NOT
// `.test.mjs` so vitest's default include never sweeps it into the gate).
//   node tools/testkit/lib/manifest_test.mjs
// Covers: tokenizer categories · sampler determinism (sha-ordered) · axis-vs-
// nothing discrimination · the 25-frame → 3 solve + 22 stack targeted test ·
// timeout table (all branches incl. size-scaled) · buildManifest end-to-end with
// an injected synthetic probe (hermetic, no filesystem/corpus coupling).
// ═══════════════════════════════════════════════════════════════════════════

import {
  tokenize, classifySets, assignTimeout, sampleCorrelated, buildManifest, distribution,
  SAMPLE_N, MAX_READ, TIMEOUT_MS, FAST_REF_BYTES,
} from './manifest.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const mk = (rel, sha, format = 'CR2', over = {}) => ({ id: rel, rel, sha, format, oversize: false, size_bytes: 20_000_000, ...over });

// ── (1) tokenizer categories ─────────────────────────────────────────────────
{
  const c = tokenize('L_0020_ISO800_240s__18C.CR2');
  eq(c.exposure, ['240'], 'tokenize exposure 240s'); eq(c.iso, ['800'], 'tokenize iso800');
  eq(c.temp, ['18'], 'tokenize temp 18C'); eq(c.seq, ['0020'], 'tokenize seq 0020');
  eq(c.band, 'l', 'tokenize trailing single-letter band l (cocoon light prefix)');
  const rm = tokenize('r_mosaic_R.fits');
  eq(rm.band, 'r', 'tokenize r_mosaic band = trailing R'); eq(rm.stemNoBand, 'r_mosaic', 'tokenize r_mosaic stemNoBand');
  const img = tokenize('IMG_1238.CR2');
  eq(img.seq, ['1238'], 'tokenize IMG seq'); eq(img.band, null, 'tokenize IMG no band'); eq(img.stemNoBand, 'img', 'tokenize IMG stem');
  const cy = tokenize('cygnus_loop_r0c0_6h.fit');
  eq(cy.mosaic, ['r0c0'], 'tokenize mosaic tile r0c0'); eq(cy.integration, ['6'], 'tokenize integration 6h');
  eq(cy.band, null, 'cygnus no band'); eq(cy.stemNoBand, 'cygnus_loop', 'cygnus stem');
  const ts = tokenize('DSO_M66_60.0s_20260516_064736.fit');
  eq(ts.timestamp, ['20260516_064736'], 'tokenize timestamp'); eq(ts.exposure, ['60.0'], 'tokenize 60.0s exposure');
}

// ── (2) sampler determinism (sha-ordered, stable) ────────────────────────────
{
  const members = [mk('f/e', 'sha_e'), mk('f/a', 'sha_a'), mk('f/c', 'sha_c'), mk('f/b', 'sha_b'), mk('f/d', 'sha_d')];
  const r1 = sampleCorrelated(members, 3);
  const r2 = sampleCorrelated([...members].reverse(), 3);       // input order must not matter
  eq(r1.sampled.map((m) => m.id), ['f/a', 'f/b', 'f/c'], 'sampler picks 3 lowest sha, sorted');
  eq(r1.sampled.map((m) => m.id), r2.sampled.map((m) => m.id), 'sampler deterministic regardless of input order');
  eq(r1.skipped.map((m) => m.id), ['f/d', 'f/e'], 'sampler skips the remainder');
  eq(SAMPLE_N, 3, 'SAMPLE_N = 3');
}

// ── (3) axis-vs-nothing discrimination + the 25→3+22 targeted test ───────────
{
  const frames = [];
  for (let i = 20; i <= 44; i++) frames.push(mk(`corpus/cocoon_60da/lights/L_00${i}_ISO800_240s__18C.CR2`, 'sha' + String(i).padStart(3, '0')));
  const { records, groups } = classifySets(frames);
  const disp = [...records.values()];
  eq(disp.filter((r) => r.lane === 'solve').length, 3, '25-frame correlated cluster → exactly 3 solve-lane');
  eq(disp.filter((r) => r.lane === 'stack').length, 22, '25-frame correlated cluster → exactly 22 stack-lane');
  eq(disp.filter((r) => r.disposition === 'sampled').length, 3, '3 sampled');
  eq(disp.filter((r) => r.disposition === 'skipped_correlated_set').length, 22, '22 skipped_correlated_set');
  eq(groups[0].kind, 'correlated_set', 'cocoon group kind = correlated_set');

  // axis-varying: r_mosaic bands enumerate fully (never sampled)
  const rm = ['B', 'G', 'H', 'I', 'O', 'R'].map((b) => mk(`rotating/r_mosaic_${b}.fits`, 'shrm' + b, 'FITS'));
  const rmc = classifySets(rm);
  eq([...rmc.records.values()].filter((r) => r.disposition === 'enumerated').length, 6, 'r_mosaic 6 bands all enumerated');
  eq(rmc.groups[0].kind, 'axis_varying', 'r_mosaic kind = axis_varying');
  eq(rmc.groups[0].axis, 'filter_band', 'r_mosaic axis = filter_band');

  // unconfirmed set: bare IMG counters, no acquisition signature → enumerate all
  const img = [1238, 1241, 1266, 1286, 1410, 1414, 1576].map((n) => mk(`challenge/DSLR/IMG_${n}.CR2`, 'shimg' + n));
  const imgc = classifySets(img);
  eq([...imgc.records.values()].every((r) => r.disposition === 'enumerated'), true, 'IMG_#### with no signature → all enumerated (honest default, no sampling)');
  eq(imgc.groups[0].kind, 'unconfirmed_set', 'IMG group kind = unconfirmed_set');

  // small set (≤ N) → enumerate
  const two = [1, 2].map((n) => mk(`rotating/carina60Da_180s_iso800_00${n}.fit`, 'shcar' + n, 'FITS'));
  const twoc = classifySets(two);
  eq([...twoc.records.values()].every((r) => r.disposition === 'enumerated'), true, 'size-2 cluster → enumerate (nothing to sample)');
  eq(twoc.groups[0].kind, 'small_set', 'size-2 kind = small_set');

  // science-axis (mosaic + integration) varying → enumerate
  const cyg = ['r0c0_6h', 'r0c1_3h', 'r0c2_12h', 'r1c0_4h', 'r1c1_3h'].map((t) => mk(`rotating/cygnus_loop_${t}.fit`, 'shcy' + t, 'FITS'));
  const cygc = classifySets(cyg);
  eq(cygc.groups[0].kind, 'axis_varying', 'cygnus tiles kind = axis_varying');
  ok(/mosaic/.test(cygc.groups[0].axis) && /integration/.test(cygc.groups[0].axis), 'cygnus axis names mosaic + integration');
}

// ── (4) timeout table — every branch ─────────────────────────────────────────
{
  const cr2 = assignTimeout(mk('x.CR2', 's', 'CR2'), undefined);
  eq(cr2.timeout_ms, TIMEOUT_MS.BLIND, 'CR2 → blind budget'); eq(cr2.budget_class, 'blind', 'CR2 blind class'); eq(cr2.provenance, 'measured', 'CR2 measured');

  const fitsWcs = assignTimeout(mk('x.fits', 's', 'FITS'), { probed: true, wcs_present: true, pixel_count: 26_000_000 });
  eq(fitsWcs.timeout_ms, TIMEOUT_MS.FITS_FAST, 'header-WCS FITS → fast budget'); eq(fitsWcs.provenance, 'measured', 'fast measured');

  const fitsBlind = assignTimeout(mk('carina.fit', 's', 'FITS'), { probed: true, wcs_present: false, pixel_count: 18_000_000 });
  eq(fitsBlind.timeout_ms, TIMEOUT_MS.BLIND, 'no-WCS FITS → blind budget (carina lesson)'); eq(fitsBlind.budget_class, 'blind', 'no-WCS FITS blind class');

  const probeless = assignTimeout(mk('x.fits', 's', 'FITS'), undefined);
  eq(probeless.timeout_ms, TIMEOUT_MS.BLIND, 'probe-unavailable FITS → conservative blind'); eq(probeless.provenance, 'scaled:probe-unavailable', 'probe-unavailable flagged, not guessed');

  const big = assignTimeout(mk('huge.fits', 's', 'FITS', { size_bytes: FAST_REF_BYTES * 3 + 1 }), { probed: true, wcs_present: true, pixel_count: 200_000_000 });
  eq(big.provenance, 'size-scaled', 'oversized header-WCS FITS → size-scaled provenance');
  ok(big.timeout_ms > TIMEOUT_MS.FITS_FAST && big.timeout_ms <= TIMEOUT_MS.BLIND, 'size-scaled budget between fast and blind cap');

  const over = assignTimeout(mk('big.fits', 's', 'FITS', { oversize: true, size_bytes: MAX_READ + 1 }), undefined);
  eq(over.timeout_ms, null, 'oversize → no budget (skipped)'); eq(over.budget_class, 'skip', 'oversize skip class');
  eq(MAX_READ, 2147483648, 'MAX_READ = 2 GiB');
}

// ── (5) buildManifest end-to-end with injected synthetic probe (hermetic) ────
{
  const frames = [];
  for (let i = 1; i <= 25; i++) frames.push(mk(`corpus/cocoon/lights/L_00${String(i).padStart(2, '0')}_ISO800_240s__18C.CR2`, 'shc' + String(i).padStart(3, '0')));
  frames.push(mk('rotating/carina60Da_180s_iso800_001.fit', 'shcar1', 'FITS'));
  frames.push(mk('rotating/carina60Da_180s_iso800_002.fit', 'shcar2', 'FITS'));
  frames.push(mk('archive/huge.fits', 'shhuge', 'FITS', { oversize: true, size_bytes: MAX_READ + 5 }));
  frames.push(mk('rotating/Andromeda M31 90s-431.fit', 'shand', 'FITS'));
  // synthetic probe: carina no-WCS, Andromeda header-WCS
  const probe = (f) => f.format !== 'FITS' ? undefined
    : { probed: true, wcs_present: /Andromeda/.test(f.rel), pixel_count: 26_000_000 };
  const m = await buildManifest({ frames, label: 'QUIET-BASELINE', probe });
  eq(m.schema, 'testkit.manifest.v2', 'manifest schema tag');
  eq(m.label, 'QUIET-BASELINE', 'manifest label carried');
  eq(m.distribution.sampled, 3, 'buildManifest cocoon sampled 3');
  eq(m.distribution.skipped_correlated_set, 22, 'buildManifest cocoon skipped 22');
  eq(m.distribution.skipped_too_large, 1, 'buildManifest oversize skip 1');
  const carinaRow = m.frames.find((r) => /carina60Da_180s_iso800_001/.test(r.rel));
  eq(carinaRow.timeout_class, 'blind', 'buildManifest carina blind budget'); eq(carinaRow.header_wcs, false, 'carina header_wcs false');
  const andRow = m.frames.find((r) => /Andromeda/.test(r.rel));
  eq(andRow.timeout_class, 'fast', 'buildManifest Andromeda fast budget'); eq(andRow.header_wcs, true, 'Andromeda header_wcs true');
  const overRow = m.frames.find((r) => r.disposition === 'skipped_too_large');
  eq(overRow.timeout_ms, null, 'oversize row no timeout');
  // distribution() is a pure rollup of rows
  const d2 = distribution(m.frames);
  eq(d2.solve_lane, m.distribution.solve_lane, 'distribution() reproduces the manifest rollup');
}

console.log(`\nmanifest self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
