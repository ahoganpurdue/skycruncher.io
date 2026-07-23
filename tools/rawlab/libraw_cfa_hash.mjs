// ═══════════════════════════════════════════════════════════════════════════
// LIBRAW CFA HASH vs RAWLER (framing + value-domain contract probe) — task #15
// ═══════════════════════════════════════════════════════════════════════════
//   node tools/rawlab/libraw_cfa_hash.mjs [--file <p>]
// Extracts the dominant-channel CFA u16 mosaic from libraw-wasm imageData()
// (the ONLY CFA obtainable — no raw accessor exists) and hashes it LE-u16 md5
// the SAME way the rawler spike hashed its full-sensor CFA, so the two decoders'
// products can be compared. Reports framing (active-area vs full-sensor) + value
// domain (scaled/black-subtracted vs raw ADU).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeCR2, detectPattern, terminateDecodeWorkers } from '../psf/decode_cr2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const i = args.indexOf('--file');
const FILE = path.resolve(ROOT, i >= 0 ? args[i + 1] : 'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1653.CR2');

// rawler spike ground truth (IMG_1653), from coordinator handoff
const RAWLER = {
    full: '5344x3516', cfa: 'GBRG', blacklevel: [2046, 2046, 2049, 2049], whitelevel: 15094,
    active_area: '5202x3465', crop_area: '5184x3456',
    fullframe_cfa_le_u16_md5: '968381f814547668c6a85b75f31038f2', min: 1, max: 15935, mean: 2618.13,
};

async function main() {
    const { w, h, rgb16: mem, meta } = await decodeCR2(FILE);
    const { pat } = detectPattern(mem, w, h);
    const patName = pat.map(c => 'RGB'[c]).join('');

    // Build the dominant-channel CFA u16 mosaic on the ACTIVE area libraw delivers.
    const n = w * h;
    const cfa = new Uint16Array(n);
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (let y = 0; y < h; y++) {
        const pr = (y & 1) * 2, row = y * w;
        for (let x = 0; x < w; x++) {
            const v = mem[(row + x) * 3 + pat[pr + (x & 1)]];
            cfa[row + x] = v;
            if (v < mn) mn = v; if (v > mx) mx = v; sum += v;
        }
    }
    // LE u16 md5 (Uint16Array bytes are native LE on x64 node == LE u16 stream)
    const md5 = crypto.createHash('md5').update(Buffer.from(cfa.buffer, cfa.byteOffset, cfa.byteLength)).digest('hex');

    const out = {
        file: path.relative(ROOT, FILE),
        libraw: {
            framing: 'ACTIVE-AREA only (optical-black borders already discarded)',
            dims: `${w}x${h}`, cfa_pattern: patName,
            left_margin: meta?.left_margin, top_margin: meta?.top_margin,
            raw_width: meta?.raw_width, raw_height: meta?.raw_height,
            thumb_dims: `${meta?.thumb_width}x${meta?.thumb_height}`,
            value_domain: 'BLACK-SUBTRACTED + SCALED to [0,65535] (document mode); NOT raw ADU',
            cfa_le_u16_md5: md5, min: mn, max: mx, mean: +(sum / n).toFixed(2),
            blacklevel_exposed: null, whitelevel_exposed: null, wb_exposed: null,
        },
        rawler: RAWLER,
        comparison: {
            framing_match: `${w}x${h}` === RAWLER.active_area,
            md5_match: md5 === RAWLER.fullframe_cfa_le_u16_md5,
            implied_linear_scale_raw_to_libraw: +(65535 / (RAWLER.whitelevel - RAWLER.blacklevel[0])).toFixed(4),
            verdict: 'MISMATCH EXPECTED — two orthogonal divergences (see notes); NOT a determinism failure',
            notes: [
                `FRAMING: libraw active=${w}x${h} vs rawler active_area=${RAWLER.active_area} (1-row conv. diff: libraw h=${h} vs rawler 3465); rawler full-sensor ${RAWLER.full} + crop_area ${RAWLER.crop_area}. libraw meta.thumb=${meta?.thumb_width}x${meta?.thumb_height} == rawler crop_area, but libraw DELIVERS the active area.`,
                `VALUE DOMAIN: libraw is black-subtracted (min ${mn}~0) + scaled to full 16-bit (max ${mx}~65535); rawler is raw ADU (min ${RAWLER.min} max ${RAWLER.max} mean ${RAWLER.mean}, pedestal ~${RAWLER.blacklevel[0]}, white ${RAWLER.whitelevel}). libraw ≈ (raw - black) * ${+(65535 / (RAWLER.whitelevel - RAWLER.blacklevel[0])).toFixed(4)}, lossy+integer -> bit-exact md5 impossible.`,
                `libraw-wasm exposes NEITHER blacklevel, whitelevel, WB, nor CFA pattern in metadata(); rawler provides all four. Optical-black border rows are gone in libraw -> no dark-reference for calibration.`,
            ],
        },
    };
    const OUT = path.resolve(ROOT, 'test_results/libraw_vs_rawler_cfa_2026-07-09.json');
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    console.log(`\n[hash] wrote ${path.relative(ROOT, OUT)}`);
    terminateDecodeWorkers();
    return 0;
}
const code = await main().catch(e => { console.error('[hash] FATAL:', e); return 1; });
setTimeout(() => process.exit(code), 300);
