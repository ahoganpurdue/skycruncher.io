#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/calib/calibrate_light.mjs — 4-class calibration apply (cutover #14)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/calib/calibrate_light.mjs --light <raw> [--out <bin>]
//        [--mode full|dark-only|bias-only] [--masters <dir>]
//
// Ledger: PIXEL. Applies the master frames on the FULL-frame CFA grid,
// PRE-DEMOSAIC (LAW 1: calibration is a native-grid pixel op), f32:
//
//   full       : (light − masterDark) / flat_norm
//   dark-only  : (light − masterDark)                (diagnostics / Stack-B arm)
//   bias-only  : (light − masterBias)                (uncalibrated-ish reference)
//
// masterDark is exposure-matched ⇒ includes the bias pedestal ⇒ subtracted
// WHOLE (never bias-then-dark). flat_norm = max(masterFlat, FLAT_FLOOR): the
// optical-black border reads ≈0 in a bias-subtracted flat, so dividing by it
// would blow up — below the floor the flat applies NO correction (÷1). Detection
// only ever sees the active area, but the floor keeps the full-grid .bin sane.
//
// Output: calibrated CFA f32 .bin (FULL frame) + manifest (dims/pattern/mode/
// master md5s/units/convention). The calibrated grid is DARK-SUBTRACTED ADU
// (pedestal removed) — honest value-domain label in the manifest.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BIN_DIR, JSON_DIR, decodeCfa, md5OfF32, quickStats } from './decode_util.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

const LIGHT = flag('light');
const MODE = flag('mode', 'full');
// masters: JSON manifests live in test_results; .bin payloads on D: (via bin_path).
const MASTERS = path.resolve(flag('masters') ?? JSON_DIR);
const FLAT_FLOOR = 0.05; // below this the flat is unilluminated (OB border) → ÷1
const log = (...a) => console.log('[calibrate_light]', ...a);

if (!LIGHT) { console.error('[calibrate_light] FATAL: --light <raw> required'); process.exit(1); }
if (!['full', 'dark-only', 'bias-only'].includes(MODE)) { console.error(`[calibrate_light] FATAL: bad --mode ${MODE}`); process.exit(1); }

function loadMaster(name) {
    const manPath = path.join(MASTERS, `${name}.manifest.json`);
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    // bin_path (absolute D: location) is authoritative; fall back to sibling.
    const binPath = man.bin_path && fs.existsSync(man.bin_path) ? man.bin_path : path.join(MASTERS, man.file);
    const buf = fs.readFileSync(binPath);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return { f32, man };
}

async function main() {
    const started = Date.now();
    log(`calibrating ${path.basename(LIGHT)} · mode=${MODE} · masters=${path.relative(ROOT, MASTERS)}`);

    const d = await decodeCfa(LIGHT);
    const W = d.width, H = d.height, LEN = W * H;

    const bias = loadMaster('master_bias');
    const dark = loadMaster('master_dark');
    const flat = loadMaster('master_flat');
    // geometry parity — masters and light MUST share the full-frame CFA grid
    for (const [n, m] of [['bias', bias], ['dark', dark], ['flat', flat]]) {
        if (m.f32.length !== LEN) throw new Error(`${n} master length ${m.f32.length} != light ${LEN} (geometry mismatch)`);
        if (m.man.cfa_pattern_full !== d.pattern) throw new Error(`${n} pattern ${m.man.cfa_pattern_full} != light ${d.pattern}`);
    }

    const out = new Float32Array(LEN);
    let floored = 0;
    if (MODE === 'bias-only') {
        for (let i = 0; i < LEN; i++) out[i] = d.cfa[i] - bias.f32[i];
    } else if (MODE === 'dark-only') {
        for (let i = 0; i < LEN; i++) out[i] = d.cfa[i] - dark.f32[i];
    } else { // full
        for (let i = 0; i < LEN; i++) {
            const sub = d.cfa[i] - dark.f32[i];
            const fl = flat.f32[i];
            if (fl < FLAT_FLOOR) { out[i] = sub; floored++; }
            else out[i] = sub / fl;
        }
    }

    // calibrated CFA is a large binary → D: (owner storage directive); its small
    // manifest goes next to it AND a copy under test_results for discoverability.
    const outPath = path.resolve(flag('out') ?? path.join(
        BIN_DIR, 'calibrated', `${path.basename(LIGHT).replace(/\W+/g, '_')}_${MODE}.bin`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(out.buffer, out.byteOffset, out.byteLength));

    const st = quickStats(out);
    const manifest = {
        producer: 'tools/calib/calibrate_light.mjs',
        light: path.basename(LIGHT), mode: MODE,
        file: path.basename(outPath),
        bin_path: outPath, // absolute D: location (owner storage directive)
        dtype: 'f32', endianness: 'LE-host',
        dims: { width: W, height: H }, length: LEN,
        grid: 'FULL-frame CFA (incl OB borders), cpp=1, index=y*W+x',
        cfa_pattern_full: d.pattern, active_area: d.activeArea,
        value_domain: MODE === 'bias-only'
            ? 'bias-subtracted ADU (pedestal removed)'
            : MODE === 'dark-only'
                ? 'dark-subtracted ADU (pedestal + dark removed)'
                : 'dark-subtracted, flat-fielded (pedestal removed; response flattened)',
        convention: 'masterDark exposure-matched ⇒ includes bias pedestal ⇒ subtracted WHOLE',
        flat_floor: FLAT_FLOOR, flat_floored_pixels: floored,
        masters: { bias: bias.man.md5, dark: dark.man.md5, flat: flat.man.md5 },
        stats: { min: +st.min.toFixed(2), max: +st.max.toFixed(2), mean: +st.mean.toFixed(3), std: +st.std.toFixed(3) },
        elapsed_s: +((Date.now() - started) / 1000).toFixed(1),
        produced_at: new Date().toISOString(),
    };
    const manJson = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(outPath.replace(/\.bin$/, '.manifest.json'), manJson);
    // discoverability copy of the manifest under test_results (small JSON only)
    const trDir = path.join(JSON_DIR, 'calibrated');
    fs.mkdirSync(trDir, { recursive: true });
    fs.writeFileSync(path.join(trDir, path.basename(outPath).replace(/\.bin$/, '.manifest.json')), manJson);
    log(`wrote ${outPath} (${(out.byteLength / 1e6).toFixed(1)}MB) md5=${md5OfF32(out)}`);
    log(`  domain=${manifest.value_domain} · mean=${st.mean.toFixed(2)} std=${st.std.toFixed(2)} min=${st.min.toFixed(1)} max=${st.max.toFixed(1)} floored=${floored}`);
    return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('[calibrate_light] FATAL:', e); process.exit(1); });
