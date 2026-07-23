#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// cutover_riders.mjs — decoder-cutover ceremony riders (2026-07-11)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/rawlab/cutover_riders.mjs [--file <raw>]
//
// Runs cutover_riders.labspec.ts through BOTH decoder arms (SERIALIZED — one
// heavy wasm lane at a time), then emits:
//   1. test_results/decoder_cutover_2026-07-11/spcc_delta.md  — SPCC + photometry
//      blocks per arm + deltas; LOUD kill flag if default-arm color_r2 WORSENS.
//   2. tools/rawlab/cutover_golden_manifest.json — additive rgb16 handoff md5s
//      per arm (the `rawler_cfa` LAW-7 boundary, binary_layouts.ts:226).
//
// Arms (POST-cutover @56cf96d):
//   rawler_default = VITE_DECODER_RAWLER ABSENT (the shipped default)
//   libraw_cold    = VITE_DECODER_RAWLER=0 (the cold path)
//
// EVIDENCE-ONLY: reports what was MEASURED. On the CR2 lane SPCC is gated OFF
// (FITS-only, science.ts:118) so both arms are EXPECTED to carry receipt.spcc=null.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const FILE = path.resolve(argVal('--file') ?? path.join(ROOT, 'public', 'demo', 'sample_observation.cr2'));
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const WORK = path.join(ROOT, 'test_results', 'decoder_cutover_2026-07-11');
const ARMDIR = path.join(WORK, `riders_${path.basename(FILE).replace(/\W+/g, '_')}_${TS}`);
const MD_OUT = path.join(WORK, 'spcc_delta.md');
const GOLDEN = path.join(ROOT, 'tools', 'rawlab', 'cutover_golden_manifest.json');
fs.mkdirSync(ARMDIR, { recursive: true });

const log = (...a) => console.log('[riders]', ...a);

function runArm(arm) {
    const outJson = path.join(ARMDIR, `arm_${arm}.json`);
    const env = { ...process.env, RAWLAB_RIDER_FILE: FILE, RAWLAB_RIDER_OUT: outJson };
    delete env.VITE_DECODER_RAWLER;                 // default arm: flag ABSENT ⇒ rawler
    if (arm === 'libraw_cold') env.VITE_DECODER_RAWLER = '0';
    log(`arm '${arm}' — spawning wizard run (sequential; one heavy lane at a time)…`);
    const r = spawnSync(process.execPath,
        [VITEST_BIN, 'run', '-c', 'tools/rawlab/ab_pipeline.config.ts', 'tools/rawlab/cutover_riders.labspec.ts'],
        { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(ARMDIR, `arm_${arm}.vitest.log`), (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));
    if (!fs.existsSync(outJson)) {
        const tail = ((r.stdout ?? '') + (r.stderr ?? '')).slice(-2000);
        return { arm, exit: r.status, record: null, error: `arm record missing:\n${tail}` };
    }
    return { arm, exit: r.status, record: JSON.parse(fs.readFileSync(outJson, 'utf8')) };
}

// ── SERIAL: default (rawler) then cold (libraw) ──
const rawler = runArm('rawler_default');
const libraw = runArm('libraw_cold');

if (!rawler.record) { console.error('[riders] FATAL: default (rawler) arm produced no record —', rawler.error); process.exit(1); }
if (!libraw.record) { console.error('[riders] WARN: cold (libraw) arm produced no record —', libraw.error); }

const R = rawler.record, L = libraw.record ?? {};
const num = (v) => (typeof v === 'number' ? v : null);
const fmt = (v, d = 6) => (typeof v === 'number' ? v.toFixed(d) : (v ?? 'null'));

// ── SPCC delta + KILL check ──
const rSpcc = R.spcc, lSpcc = L.spcc;
const rR2 = num(rSpcc?.color_r2), lR2 = num(lSpcc?.color_r2);
let killFlag = 'N/A — SPCC did not run on either arm (CR2 lane is FITS-only)';
if (rR2 != null && lR2 != null) {
    const worse = rR2 < lR2;
    killFlag = worse
        ? `⚠️ KILL SIGNAL: default-arm color_r2 (${fmt(rR2)}) is WORSE than cold-arm (${fmt(lR2)}) — Δ=${fmt(rR2 - lR2)}. ESCALATE (orchestrator decision; no revert authority here).`
        : `OK: default-arm color_r2 (${fmt(rR2)}) ≥ cold-arm (${fmt(lR2)}) — Δ=${fmt(rR2 - lR2)}.`;
} else if (rR2 != null || lR2 != null) {
    killFlag = `PARTIAL: SPCC ran on only one arm (rawler_r2=${fmt(rR2)}, libraw_r2=${fmt(lR2)}) — cannot compute Δ.`;
}

function spccBlock(rec, label) {
    const s = rec?.spcc;
    if (!s) return `**${label}** — receipt.spcc = \`null\`  \n_${rec?.spcc_note ?? 'SPCC absent'}_\n`;
    return [`**${label}** — receipt.spcc:`, '```json', JSON.stringify(s, null, 2), '```'].join('\n');
}
function solveLine(rec) {
    const s = rec?.solve;
    if (!s?.solved) return `solve: NOT SOLVED${rec?.solve_error ? ` (${rec.solve_error})` : ''}`;
    return `solve: RA=${fmt(s.ra_hours)}h Dec=${fmt(s.dec_degrees, 5)}° scale=${fmt(s.pixel_scale, 4)}"/px matched=${s.stars_matched} conf=${fmt(s.confidence)}`;
}
function photLine(rec) {
    const p = rec?.photometry;
    if (!p) return 'photometry: null';
    return `photometry: keys=[${(p.keys ?? []).join(',')}] n_stars=${p.n_stars} provenance=${JSON.stringify(p.provenance_counts)}`;
}

const md = `# Decoder-cutover ceremony rider — SPCC delta pair

_Generated ${new Date().toISOString()} by \`tools/rawlab/cutover_riders.mjs\`_

**Frame:** \`${path.relative(ROOT, FILE)}\` (${R.file_bytes} bytes)
**HEAD:** run at commit — see git log
**Arms:** \`rawler_default\` (VITE_DECODER_RAWLER absent, the shipped default @56cf96d) vs \`libraw_cold\` (VITE_DECODER_RAWLER=0)

## KILL CHECK (default-arm color_r2 must NOT worsen)

**${killFlag}**

> NOTE (EVIDENCE-ONLY): the bundled frame is a **CR2**. The SPCC gate is
> \`isFits && scienceRgb && matched>0\` (src/engine/pipeline/stages/science.ts:118),
> so the CR2 lane produces **no SPCC block on either decoder arm** — SPCC only
> runs on FITS input, which neither RAW decoder (rawler/libraw) is on the path
> for. The decoder cutover therefore **cannot** change SPCC on this lane; the
> color delta that DOES move with the demosaic is the matched **photometry**
> block (aperture photometry on the science luminance), shown below.

## SPCC block per arm

${spccBlock(R, 'rawler_default')}

${spccBlock(L, 'libraw_cold')}

## Photometry + solve per arm (the observable decode delta)

| arm | rawler_default | libraw_cold |
|---|---|---|
| receipt.version | ${R.receipt_version ?? 'null'} | ${L.receipt_version ?? 'null'} |
| ${solveLine(R)} | | |
| ${solveLine(L)} | | |

- **rawler_default** — ${solveLine(R)}
  - ${photLine(R)}
  - confirm_status: ${JSON.stringify(R.confirm_status)}
- **libraw_cold** — ${solveLine(L)}
  - ${photLine(L)}
  - confirm_status: ${JSON.stringify(L.confirm_status)}

## rgb16 decode-handoff (the \`rawler_cfa\` LAW-7 boundary)

| field | rawler_default | libraw_cold |
|---|---|---|
| dims | ${R.rgb16?.width}x${R.rgb16?.height} | ${L.rgb16?.width}x${L.rgb16?.height} |
| stride | ${R.rgb16?.stride} | ${L.rgb16?.stride} |
| isDemosaiced | ${R.rgb16?.isDemosaiced} | ${L.rgb16?.isDemosaiced} |
| dtype | ${R.rgb16?.dtype} | ${L.rgb16?.dtype} |
| elems/px | ${R.rgb16?.elems_per_px} | ${L.rgb16?.elems_per_px} |
| len_bytes | ${R.rgb16?.len_bytes} | ${L.rgb16?.len_bytes} |
| **md5** | \`${R.rgb16?.md5}\` | \`${L.rgb16?.md5}\` |
| stats(min/max/mean) | ${R.rgb16?.stats ? `${R.rgb16.stats.min}/${R.rgb16.stats.max}/${R.rgb16.stats.mean}` : 'n/a'} | ${L.rgb16?.stats ? `${L.rgb16.stats.min}/${L.rgb16.stats.max}/${L.rgb16.stats.mean}` : 'n/a'} |
| rawler_contract | ${JSON.stringify(R.rgb16?.rawler_contract)} | ${JSON.stringify(L.rgb16?.rawler_contract)} |

md5 equality across arms: **${R.rgb16?.md5 && L.rgb16?.md5 ? (R.rgb16.md5 === L.rgb16.md5 ? 'IDENTICAL (unexpected)' : 'DIFFER (expected — rawler integer demosaic vs libraw document-mode passthrough)') : 'incomplete'}**

## Per-arm raw records
- \`${path.relative(ROOT, path.join(ARMDIR, 'arm_rawler_default.json'))}\`
- \`${path.relative(ROOT, path.join(ARMDIR, 'arm_libraw_cold.json'))}\`
`;

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(MD_OUT, md);
log('wrote', path.relative(ROOT, MD_OUT));

// ── Golden manifest: additive rgb16 handoff md5s ──
let manifest = { schema: 'cutover_golden.v1', boundary: 'rawler_cfa (binary_layouts.ts:226)', entries: [] };
if (fs.existsSync(GOLDEN)) { try { manifest = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch { /* seed fresh */ } }
const stamp = new Date().toISOString();
for (const rec of [R, L]) {
    if (!rec?.rgb16?.md5) continue;
    manifest.entries.push({
        recorded_at: stamp,
        frame: path.basename(rec.file),
        arm: rec.arm,
        flag_env: rec.flag_env,
        rawler_enabled: rec.rawler_enabled,
        decode_handoff: {
            dims: `${rec.rgb16.width}x${rec.rgb16.height}`,
            stride: rec.rgb16.stride,
            isDemosaiced: rec.rgb16.isDemosaiced,
            dtype: rec.rgb16.dtype,
            elems_per_px: rec.rgb16.elems_per_px,
            len_bytes: rec.rgb16.len_bytes,
            md5: rec.rgb16.md5,
            stats: rec.rgb16.stats,
            rawler_contract: rec.rgb16.rawler_contract,
        },
    });
}
fs.writeFileSync(GOLDEN, JSON.stringify(manifest, null, 2));
log('appended', path.relative(ROOT, GOLDEN), `(${manifest.entries.length} total entries)`);

console.log('\n[riders] SUMMARY');
console.log('  KILL:', killFlag);
console.log('  rawler md5:', R.rgb16?.md5, '| libraw md5:', L.rgb16?.md5);
console.log('  rawler solve:', solveLine(R));
console.log('  libraw solve:', solveLine(L));
process.exit(0);
