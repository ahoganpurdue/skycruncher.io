#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// spcc_cr2_approx.mjs — SPCC-approx color for the bundled CR2 + cold-vs-default
// delta pair + rgb16 golden md5.  Deliverable for owner decision
// D-spcc-cr2-color-go (approved 2026-07-12) and the two outstanding
// decoder-cutover riders (SPCC delta pair + rgb16 golden md5).
// ═══════════════════════════════════════════════════════════════════════════
//   node tools/color/spcc_cr2_approx.mjs [--file <raw>]
//
// SERIAL (one heavy wasm lane at a time): rawler_default then libraw_cold.
// Emits under test_results/spcc_cr2_approx_<ts>/:
//   1. spcc_cr2_delta.md         — SPCC-approx color block per arm + Δ, provenance.
//   2. arm_<arm>.json            — raw per-arm records.
//   3. rgb16_golden.json         — deterministic decode pin (md5 + len + dims) per
//      arm.  NOTE: promoting this to a STANDING GATE is an orchestrator / GATES.md
//      decision, NOT this tool's.
//
// EVIDENCE-ONLY: reports what was MEASURED; null = honest absence.
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
const WORK = path.join(ROOT, 'test_results', `spcc_cr2_approx_${TS}`);
fs.mkdirSync(WORK, { recursive: true });

const log = (...a) => console.log('[spcc-cr2]', ...a);
const HEAD = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '?';

function runArm(arm) {
    const outJson = path.join(WORK, `arm_${arm}.json`);
    const env = { ...process.env, SPCC_CR2_FILE: FILE, SPCC_CR2_OUT: outJson };
    delete env.VITE_DECODER_RAWLER;                 // default arm: flag ABSENT ⇒ rawler
    if (arm === 'libraw_cold') env.VITE_DECODER_RAWLER = '0';
    log(`arm '${arm}' — spawning wizard + SPCC-approx (serial; one heavy lane at a time)…`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath,
        [VITEST_BIN, 'run', '-c', 'tools/color/spcc_cr2_approx.config.ts'],
        { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(WORK, `arm_${arm}.vitest.log`), (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));
    log(`arm '${arm}' done in ${((Date.now() - t0) / 1000).toFixed(1)}s (exit ${r.status})`);
    if (!fs.existsSync(outJson)) {
        const tail = ((r.stdout ?? '') + (r.stderr ?? '')).slice(-2500);
        return { arm, exit: r.status, record: null, error: `arm record missing:\n${tail}` };
    }
    return { arm, exit: r.status, record: JSON.parse(fs.readFileSync(outJson, 'utf8')) };
}

const rawler = runArm('rawler_default');
const libraw = runArm('libraw_cold');
if (!rawler.record) { console.error('[spcc-cr2] FATAL: default (rawler) arm produced no record —', rawler.error); process.exit(1); }
if (!libraw.record) { console.error('[spcc-cr2] WARN: cold (libraw) arm produced no record —', libraw.error); }

const R = rawler.record, L = libraw.record ?? {};
const fmt = (v, d = 6) => (typeof v === 'number' ? v.toFixed(d) : (v ?? 'null'));
const delta = (a, b) => (typeof a === 'number' && typeof b === 'number' ? (a - b) : null);

const rS = R.spcc_approx ?? {}, lS = L.spcc_approx ?? {};
const dR2 = delta(rS.color_r2, lS.color_r2);
let colorVerdict;
if (typeof rS.color_r2 === 'number' && typeof lS.color_r2 === 'number') {
    colorVerdict = rS.color_r2 >= lS.color_r2
        ? `OK: default-arm color_r2 (${fmt(rS.color_r2)}) ≥ cold-arm (${fmt(lS.color_r2)}) — Δ=${fmt(dR2)}. Rawler arm is color-consistent (not worse).`
        : `NOTE: default-arm color_r2 (${fmt(rS.color_r2)}) < cold-arm (${fmt(lS.color_r2)}) — Δ=${fmt(dR2)}. Report only; no gate/revert authority here (arms solve different star sets: rawler ${R.matched_count} vs libraw ${L.matched_count} matched).`;
} else {
    colorVerdict = `PARTIAL: color fit invalid/absent on one or both arms (rawler_r2=${fmt(rS.color_r2)}, libraw_r2=${fmt(lS.color_r2)}). CR2_DEMOSAIC_APPROX color needs the fit's usable-star floor; recorded honestly.`;
}

function block(rec, label) {
    const s = rec?.spcc_approx;
    if (!s || s.error) return `**${label}** — spcc_approx ${s?.error ? `ERROR: ${s.error}` : 'absent'}`;
    const g = s.gains;
    return [
        `**${label}** (source \`${s.source}\`, valid=${s.valid}):`,
        `- color: slope=${fmt(s.color_slope)} intercept=${fmt(s.color_intercept)} r²=${fmt(s.color_r2)} rmse=${fmt(s.color_rmse)} (n_used=${s.color_n_used}, valid=${s.color_valid})`,
        `- zeropoint: zp=${fmt(s.zeropoint, 4)} rmse=${fmt(s.zp_rmse)} (n_used=${s.zp_n_used}, valid=${s.zp_valid})`,
        `- n_usable stars=${s.n_usable} (matched=${rec.matched_count}, with catalog BP-RP=${rec.matched_with_bv})`,
        `- fidelity: r²_survivor=${fmt(s.fidelity?.r2_survivor)} r²_full=${fmt(s.fidelity?.r2_full)} rmse=${fmt(s.fidelity?.rmse_survivor_mag)}`,
        `- render WB gains: ${g ? `[${g.gains.map(v => (typeof v === 'number' ? v.toFixed(4) : v)).join(', ')}] (TLS N=${g.nStars}, r²=${fmt(g.r2)}, gate=${g.gate_reason}, applied=${g.applied})` : 'null'}`,
    ].join('\n');
}

const md = `# SPCC-approx for CR2 — measurement + cold-vs-default delta

_Generated ${new Date().toISOString()} by \`tools/color/spcc_cr2_approx.mjs\` @ ${HEAD}_

**Decision:** \`D-spcc-cr2-color-go\` (approved 2026-07-12; spec docs/TEST_SUITE_PLAN.md §7 D1).
**Frame:** \`${R.file}\` (${R.file_bytes} bytes)
**Arms:** \`rawler_default\` (VITE_DECODER_RAWLER absent, shipped default @56cf96d) vs \`libraw_cold\` (=0).

> **Why a tools/ lane, not the receipt (EVIDENCE-ONLY):** the engine SPCC gate is
> FITS-only (\`isFits && scienceRgb && matched>0\`, stages/science.ts:118) AND the
> CR2 path never retains its full-res linear RGB (orchestrator_session.ts:556-558),
> so \`receipt.spcc\` is **null** on CR2 on BOTH arms (confirmed: rawler=${JSON.stringify(R.receipt_spcc)}, libraw=${JSON.stringify(L.receipt_spcc)}).
> This lane reconstructs the identical native \`fullRGB\` via the deterministic
> \`decodeScienceFrame\` and calls \`computeSpccCalibration\` directly on the REAL
> solve's matched stars (scales=null ⇒ native==detection space, 1:1 correspondence).
> Color is stamped **CR2_DEMOSAIC_APPROX**, never SPCC_RGB (CR2 = demosaiced Bayer,
> no filter-curve reference; honest but lower fidelity). Wiring this into the engine
> (relax gate + retain fullRGB + tag) is a src/ change — orchestrator/surgeon, not here.

## Color-consistency verdict (default arm vs cold arm)

**${colorVerdict}**

## SPCC-approx block per arm

${block(R, 'rawler_default')}

${block(L, 'libraw_cold')}

## Δ (rawler_default − libraw_cold)

| metric | rawler_default | libraw_cold | Δ |
|---|---|---|---|
| color_slope | ${fmt(rS.color_slope)} | ${fmt(lS.color_slope)} | ${fmt(delta(rS.color_slope, lS.color_slope))} |
| color_r2 | ${fmt(rS.color_r2)} | ${fmt(lS.color_r2)} | ${fmt(dR2)} |
| color_rmse | ${fmt(rS.color_rmse)} | ${fmt(lS.color_rmse)} | ${fmt(delta(rS.color_rmse, lS.color_rmse))} |
| zeropoint | ${fmt(rS.zeropoint, 4)} | ${fmt(lS.zeropoint, 4)} | ${fmt(delta(rS.zeropoint, lS.zeropoint), 4)} |
| n_usable | ${rS.n_usable ?? 'null'} | ${lS.n_usable ?? 'null'} | ${delta(rS.n_usable, lS.n_usable) ?? 'null'} |
| matched | ${R.matched_count ?? 'null'} | ${L.matched_count ?? 'null'} | ${delta(R.matched_count, L.matched_count) ?? 'null'} |

_NOTE: the two arms solve DIFFERENT star sets (rawler ${R.matched_count} vs libraw ${L.matched_count} matched — the sacred CR2 pin), so the Δ mixes decode-color and match-set effects; it is a consistency read, not an isolated decode-color contrast._

## solve per arm
- **rawler_default** — RA=${fmt(R.solve?.ra_hours)}h Dec=${fmt(R.solve?.dec_degrees, 5)}° scale=${fmt(R.solve?.pixel_scale, 4)}"/px matched=${R.solve?.stars_matched} conf=${fmt(R.solve?.confidence)}
- **libraw_cold**  — RA=${fmt(L.solve?.ra_hours)}h Dec=${fmt(L.solve?.dec_degrees, 5)}° scale=${fmt(L.solve?.pixel_scale, 4)}"/px matched=${L.solve?.stars_matched} conf=${fmt(L.solve?.confidence)}

## rgb16 decode-handoff (deterministic decode pin — see rgb16_golden.json)

| field | rawler_default | libraw_cold |
|---|---|---|
| dims | ${R.rgb16?.width}x${R.rgb16?.height} | ${L.rgb16?.width}x${L.rgb16?.height} |
| dtype / elems-per-px | ${R.rgb16?.dtype} / ${R.rgb16?.elems_per_px} | ${L.rgb16?.dtype} / ${L.rgb16?.elems_per_px} |
| len_bytes | ${R.rgb16?.len_bytes} | ${L.rgb16?.len_bytes} |
| **md5** | \`${R.rgb16?.md5}\` | \`${L.rgb16?.md5}\` |
`;

fs.writeFileSync(path.join(WORK, 'spcc_cr2_delta.md'), md);
log('wrote', path.relative(ROOT, path.join(WORK, 'spcc_cr2_delta.md')));

// ── rgb16 golden pin (NOT a standing gate — promotion is orchestrator/GATES.md) ──
const golden = {
    schema: 'spcc_cr2_rgb16_golden.v1',
    boundary: 'fullRGB == decodeScienceFrame output == extractRawSensorData().data (rawler arm, ingest.ts:184); rawler_cfa LAW-7 boundary binary_layouts.ts:226',
    promotion_note: 'DECODE-DETERMINISM PIN, NOT A STANDING GATE. Promoting this md5 to a gate in docs/GATES.md is an orchestrator decision, not this tool\'s. Banked here as evidence only.',
    frame: R.file,
    file_bytes: R.file_bytes,
    head: HEAD,
    recorded_at: new Date().toISOString(),
    arms: [R, L].filter(r => r?.rgb16?.md5).map(r => ({
        arm: r.arm, flag_env: r.flag_env, rawler_enabled: r.rawler_enabled,
        dims: `${r.rgb16.width}x${r.rgb16.height}`, dtype: r.rgb16.dtype,
        elems_per_px: r.rgb16.elems_per_px, len_elems: r.rgb16.len_elems, len_bytes: r.rgb16.len_bytes,
        md5: r.rgb16.md5,
    })),
};
fs.writeFileSync(path.join(WORK, 'rgb16_golden.json'), JSON.stringify(golden, null, 2));
log('wrote', path.relative(ROOT, path.join(WORK, 'rgb16_golden.json')));

console.log('\n[spcc-cr2] SUMMARY');
console.log('  color verdict:', colorVerdict);
console.log('  rawler md5:', R.rgb16?.md5, `(${R.rgb16?.len_bytes}B, ${R.rgb16?.width}x${R.rgb16?.height})`);
console.log('  libraw md5:', L.rgb16?.md5, `(${L.rgb16?.len_bytes}B, ${L.rgb16?.width}x${L.rgb16?.height})`);
console.log('  rawler spcc_approx:', JSON.stringify(rS));
console.log('  libraw spcc_approx:', JSON.stringify(lS));
process.exit(0);
