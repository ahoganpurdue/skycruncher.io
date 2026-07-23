#!/usr/bin/env node
// tools/contracts/check_layout_contracts.mjs
// ═══════════════════════════════════════════════════════════════════════════
// LAW 7 GOLDEN-VECTOR BATTERY — PRE-STAGE SCAFFOLD (decoder cutover #14, harness half)
// ═══════════════════════════════════════════════════════════════════════════
//
// CLAUDE.md LAW 7 (Memory Boundary Layout): the golden-vector battery lands WITH
// the decoder cutover (#14). This file is the PRE-STAGE of that battery — the tool
// exists now so the cutover session opens against a wired, runnable harness instead
// of a blank file. It is DELIBERATELY NOT wired into any gate battery/config: LAW 7
// says the battery goes green WITH the cutover, and the golden reference bytes are
// NOT MEASURED yet. Run it standalone:
//
//   node tools/contracts/check_layout_contracts.mjs           # human report
//   node tools/contracts/check_layout_contracts.mjs --json    # machine-readable
//   node tools/contracts/check_layout_contracts.mjs --arrow=<path.arrow>  # probe a real Arrow IPC file
//   node tools/contracts/check_layout_contracts.mjs --fits=<path.fits>    # probe a real FITS header
//
// HONESTY DISCIPLINE (LAW 3, honest-or-absent): every boundary reports EXACTLY what
// is assertable HEADLESSLY TODAY and nothing more.
//   • STRUCTURAL   — schema self-consistency of the declaration (always runnable).
//   • ARITHMETIC   — offset/stride/size arithmetic of the DOCUMENTED rule, checked
//                    for internal consistency (never a claim about real device bytes).
//   • CONFORMANCE  — a probe against a CHEAP REAL artifact on disk IF one is present;
//                    otherwise "NOT MEASURED" (an absent artifact is NOT a pass and
//                    NOT a failure — it is honest absence).
//   • GOLDEN       — a null goldenVector (0.1.0-seed entries) reports EXACTLY the
//                    NOT-MEASURED golden line below. A MEASURED GoldenVectorRef
//                    (surface 0.2.0+, first: rawler_cfa) verifies the committed
//                    manifest pointer, and hashes the local .bin bytes when present
//                    (bytes are local/regenerable — absent bytes = pointer-only PASS
//                    with the byte check reported NOT MEASURED in the detail).
//
// EXIT CODE: nonzero iff a STRUCTURAL or ARITHMETIC self-consistency check FAILS, or
// a CONFORMANCE probe found a real artifact that did NOT conform. NOT MEASURED never
// fails the run (honest absence is a legal outcome; the real battery lands at #14).
//
// IMPORT MECHANISM: reads the declaration by importing the zero-import leaf TS module
// src/engine/contracts/binary_layouts.ts with its explicit `.ts` extension under
// Node's native type-stripping — the same pattern as tools/psf/forced_detect.mjs →
// tps_eval.ts (there is NO tsx/loader on the tools lanes; only zero-import leaf .ts
// modules are Node-loadable, and binary_layouts.ts is one). READ-ONLY: this tool
// never writes to src/.

import { BINARY_LAYOUTS, BINARY_LAYOUTS_VERSION, GOLDEN_VECTOR_STATUS }
    from '../../src/engine/contracts/binary_layouts.ts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// libraw golden vectors will be dropped here by the decoder-cutover session.
const GOLDEN_DIR = resolve(root, 'test_results', 'decoder_prestage', 'golden');
// wasm export-signature source (STAT-only here; pkg/ is ingest-restricted — never read).
const WASM_PKG_DIR = resolve(root, 'src', 'engine', 'wasm_compute', 'pkg');

// The exact golden-vector status line every null-goldenVector boundary reports.
const NOT_MEASURED_GV = 'NOT MEASURED — golden vector lands at decoder cutover #14';

// The seven enumerated LAW-7 boundaries (CLAUDE.md LAW 7). Coverage is asserted:
// a boundary silently dropped from the declaration is a real failure.
const CANONICAL_BOUNDARIES = [
    'libraw_mem_image', 'atlas_rows', 'starplates_blobs',
    'arrow_seam', 'wgsl_structs', 'wasm_typed_array', 'fits_io',
];

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const argVal = (flag) => {
    const hit = argv.find((a) => a.startsWith(flag + '='));
    return hit ? hit.slice(flag.length + 1) : null;
};
const ARROW_PATH = argVal('--arrow');
const FITS_PATH = argVal('--fits');

const PASS = 'PASS';
const FAIL = 'FAIL';
const NM = 'NOT MEASURED';

/** One check result. status ∈ {PASS, FAIL, NOT MEASURED}. */
const check = (label, status, detail) => ({ label, status, detail });
const ok = (cond, label, detail) => check(label, cond ? PASS : FAIL, detail);

// ─── STRUCTURAL: schema self-consistency of every declared entry ──────────────
const SEMVER = /^\d+\.\d+\.\d+$/;
function structuralChecks(entry) {
    const out = [];
    const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
    out.push(ok(SEMVER.test(entry.version), 'version is semver', `version="${entry.version}"`));
    out.push(ok(nonEmpty(entry.dtype), 'dtype non-empty', truncate(entry.dtype)));
    out.push(ok(nonEmpty(entry.strideRule), 'strideRule non-empty', `${entry.strideRule.length} chars`));
    out.push(ok(nonEmpty(entry.endianness), 'endianness non-empty', truncate(entry.endianness)));
    // LAW 7 makes UNITS first-class — a blank units field is a real contract defect.
    out.push(ok(nonEmpty(entry.units), 'units non-empty (LAW 7: units first-class)', truncate(entry.units)));
    out.push(ok(nonEmpty(entry.coordinateConvention), 'coordinateConvention non-empty', truncate(entry.coordinateConvention)));
    out.push(ok(nonEmpty(entry.notes), 'notes/provenance non-empty', `${entry.notes.length} chars`));
    if (entry.goldenVector === null) {
        out.push(ok(entry.goldenVectorStatus === GOLDEN_VECTOR_STATUS,
            'goldenVectorStatus matches canonical (null goldenVector)', `"${entry.goldenVectorStatus}"`));
    } else {
        // MEASURED pointer (surface 0.2.0+): status must say MEASURED and the
        // ref must carry a manifest path + an md5 (the committed pointer shape).
        out.push(ok(
            entry.goldenVectorStatus.includes('MEASURED')
            && nonEmpty(entry.goldenVector.manifestPath)
            && /^[0-9a-f]{32}$/.test(entry.goldenVector.md5 ?? ''),
            'goldenVector ref well-formed (MEASURED status + manifestPath + md5)',
            `manifest="${entry.goldenVector.manifestPath}" md5=${entry.goldenVector.md5}`));
    }
    return out;
}

// ─── ARITHMETIC: offset/stride/size self-consistency of the DOCUMENTED rule ────
// Each returns {ok, detail}. Only boundaries with a codifiable-today rule are here;
// UNVERIFIED-heavy boundaries return null (→ NOT MEASURED).
const arithmeticProbe = {
    libraw_mem_image() {
        // Interleaved RGB16, length w*h*3, index (y*w+x)*3+c. Assert the documented
        // flat-index formula is a bijection onto [0, w*h*3) with no gaps/overlaps.
        const w = 7, h = 5, C = 3, total = w * h * C;
        const seen = new Set();
        let min = Infinity, max = -Infinity;
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                for (let c = 0; c < C; c++) {
                    const idx = (y * w + x) * C + c;
                    seen.add(idx);
                    if (idx < min) min = idx;
                    if (idx > max) max = idx;
                }
        const good = seen.size === total && min === 0 && max === total - 1;
        return {
            ok: good,
            detail: `RGB16 interleaved (w${w}×h${h}×3): ${seen.size}/${total} unique flat indices, `
                + `range [${min}..${max}] (expect [0..${total - 1}]) — bijective & in-bounds`,
        };
    },
    fits_io() {
        // 80-byte cards, 2880-byte header blocks (36 cards), BITPIX→byte-size map.
        const CARD = 80, BLOCK = 2880;
        const cardsPerBlock = BLOCK / CARD;
        const bitpix = { 8: 1, 16: 2, 32: 4, '-32': 4, '-64': 8 };
        const badByte = Object.values(bitpix).some((v) => !Number.isInteger(v) || v <= 0);
        const good = BLOCK % CARD === 0 && cardsPerBlock === 36 && !badByte;
        return {
            ok: good,
            detail: `card=${CARD}B, block=${BLOCK}B ⇒ ${cardsPerBlock} cards/block; `
                + `BITPIX byte-map {8:1,16:2,32:4,-32:4,-64:8} all positive-int`,
        };
    },
    wgsl_structs() {
        // std430-style: f32 align4/size4, vec3<f32> align16/size12, u32 align4/size4.
        // Assert the documented "vec3 aligns to 16 / struct rounds to max member
        // alignment" rule produces the canonical offsets/size.
        const members = [
            { n: 'a:f32', align: 4, size: 4 },
            { n: 'b:vec3<f32>', align: 16, size: 12 },
            { n: 'c:u32', align: 4, size: 4 },
        ];
        let offCursor = 0;
        const offsets = [];
        for (const m of members) {
            offCursor = Math.ceil(offCursor / m.align) * m.align;
            offsets.push(offCursor);
            offCursor += m.size;
        }
        const maxAlign = Math.max(...members.map((m) => m.align));
        const structSize = Math.ceil(offCursor / maxAlign) * maxAlign;
        const good = offsets[0] === 0 && offsets[1] === 16 && offsets[2] === 28 && structSize === 32;
        return {
            ok: good,
            detail: `std430 {f32,vec3<f32>,u32}: offsets [${offsets.join(',')}] (expect [0,16,28]), `
                + `struct size ${structSize} (expect 32) — vec3 aligns to 16`,
        };
    },
    wasm_typed_array() {
        // typed-array element sizes + live little-endian confirmation (documented LE).
        const want = { Float64: 8, Float32: 4, Uint16: 2 };
        const live = {
            Float64: Float64Array.BYTES_PER_ELEMENT,
            Float32: Float32Array.BYTES_PER_ELEMENT,
            Uint16: Uint16Array.BYTES_PER_ELEMENT,
        };
        const sizesOk = Object.keys(want).every((k) => want[k] === live[k]);
        const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
        return {
            ok: sizesOk && littleEndian,
            detail: `BYTES_PER_ELEMENT Float64/Float32/Uint16 = ${live.Float64}/${live.Float32}/${live.Uint16} `
                + `(expect 8/4/2); host little-endian = ${littleEndian}`,
        };
    },
    rawler_cfa() {
        // FULL-frame cpp=1 mosaic: flat index y*w + x is a bijection onto [0, w*h),
        // and the CFA phase formula (y&1)*2 + (x&1) hits exactly the 4 tile slots.
        const w = 6, h = 4, total = w * h;
        const seen = new Set();
        const phases = new Set();
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                seen.add(y * w + x);
                phases.add((y & 1) * 2 + (x & 1));
            }
        const good = seen.size === total && phases.size === 4
            && Math.min(...phases) === 0 && Math.max(...phases) === 3;
        return {
            ok: good,
            detail: `CFA mosaic (w${w}×h${h}, cpp=1): ${seen.size}/${total} unique flat indices; `
                + `phase formula covers tile slots {${[...phases].sort().join(',')}} (expect {0,1,2,3})`,
        };
    },
    // atlas_rows / starplates_blobs / arrow_seam: no fully-codifiable offset rule is
    // transcribed in the 0.1.x seed (UNVERIFIED-heavy) → NOT MEASURED (return null).
    atlas_rows: () => null,
    starplates_blobs: () => null,
    arrow_seam: () => null,
};

// ─── CONFORMANCE: probe a cheap REAL artifact IF present, else honest absence ──
// Returns {status, detail}. Never ingests deny-listed dirs (public/atlas, Sample
// Files, pkg/ contents): a real artifact is supplied via --arrow/--fits or lands in
// test_results/decoder_prestage/ at cutover.
const conformanceProbe = {
    libraw_mem_image() {
        // Golden-vector slot. The decoder-cutover session drops reference frames into
        // GOLDEN_DIR; until then this reports the TODO and stays NOT MEASURED.
        if (existsSync(GOLDEN_DIR)) {
            let files = [];
            try { files = readdirSync(GOLDEN_DIR).filter((f) => !f.startsWith('.')); } catch { /* ignore */ }
            if (files.length > 0) {
                // Golden bytes exist but no rawler decoder is wired yet to compare
                // against — presence is recorded, byte-equality is still NOT MEASURED.
                return {
                    status: NM,
                    detail: `golden dir present with ${files.length} file(s) [${files.slice(0, 4).join(', ')}` +
                        `${files.length > 4 ? ', …' : ''}] — byte-equality NOT MEASURED until the rawler `
                        + `decoder is wired at cutover #14 to produce the comparison frame`,
                };
            }
            return { status: NM, detail: `golden dir exists but is empty — awaiting cutover #14 reference bytes` };
        }
        return {
            status: NM,
            detail: `TODO(cutover #14): read golden vectors from ${rel(GOLDEN_DIR)} once the rawler `
                + `decoder lands; dir does not exist yet`,
        };
    },
    arrow_seam() {
        // Cheap real probe: Arrow IPC *file* format begins with the 6-byte magic
        // "ARROW1". Supply a file via --arrow=<path> (cutover points it at a real
        // sector); public/atlas is deny-listed so it is never auto-scanned.
        if (!ARROW_PATH) {
            return { status: NM, detail: 'no --arrow=<path> supplied; public/atlas is ingest-restricted (never auto-scanned)' };
        }
        if (!existsSync(ARROW_PATH)) return { status: NM, detail: `--arrow path not found: ${ARROW_PATH}` };
        try {
            const head = readFileSync(ARROW_PATH).subarray(0, 6).toString('latin1');
            return {
                status: head === 'ARROW1' ? PASS : FAIL,
                detail: `${rel(ARROW_PATH)}: head6="${head}" (expect "ARROW1" — Arrow IPC file magic)`,
            };
        } catch (e) {
            return { status: NM, detail: `could not read --arrow file: ${e.message}` };
        }
    },
    fits_io() {
        // Cheap real probe: a FITS primary header's first card is `SIMPLE  = ...`.
        // Supply via --fits=<path>; Sample Files/ is deny-listed (never auto-scanned).
        if (!FITS_PATH) {
            return { status: NM, detail: 'no --fits=<path> supplied; Sample Files/ is ingest-restricted (never auto-scanned)' };
        }
        if (!existsSync(FITS_PATH)) return { status: NM, detail: `--fits path not found: ${FITS_PATH}` };
        try {
            const card = readFileSync(FITS_PATH).subarray(0, 80).toString('latin1');
            return {
                status: card.startsWith('SIMPLE  =') ? PASS : FAIL,
                detail: `${rel(FITS_PATH)}: first card="${card.slice(0, 30).trimEnd()}…" (expect start "SIMPLE  =")`,
            };
        } catch (e) {
            return { status: NM, detail: `could not read --fits file: ${e.message}` };
        }
    },
    wasm_typed_array() {
        // Export-signature conformance is deferred: pkg/ is ingest-restricted (never
        // read here). STAT the dir only, so the cutover battery knows it is present.
        const present = existsSync(WASM_PKG_DIR);
        return {
            status: NM,
            detail: present
                ? `pkg/ present (stat-only; ingest-restricted) — export-signature conformance NOT MEASURED, `
                + `wired at cutover #14`
                : `pkg/ absent (run wasm-pack build --target web) — export-signature conformance NOT MEASURED`,
        };
    },
    atlas_rows: () => ({ status: NM, detail: 'shipped sectors are 338MB local-only + ingest-restricted; hybrid-row conformance lands at cutover #14' }),
    starplates_blobs: () => ({ status: NM, detail: 'blob/band-index byte layout is UNVERIFIED in the 0.1.x seed; conformance lands at cutover #14' }),
    wgsl_structs: () => ({ status: NM, detail: 'no headless WebGPU device here; real-shader offset conformance lands at cutover #14 (codegen/offset-assert)' }),
};

// ─── helpers ──────────────────────────────────────────────────────────────────
function truncate(s, n = 60) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function rel(p) { return p.startsWith(root) ? p.slice(root.length + 1).replaceAll('\\', '/') : p; }

/**
 * Golden-vector check for one entry. null (0.1.0-seed) → NOT MEASURED (honest
 * absence). MEASURED ref → the committed manifest must exist and carry the
 * entry's md5; if a local .bin of the manifest's recorded byte length exists in
 * the golden dir it is ALSO hashed (bytes are local/regenerable — their absence
 * downgrades only the detail line, never the pointer verdict).
 */
function goldenVectorCheck(entry) {
    if (entry.goldenVector === null) return check('golden vector', NM, NOT_MEASURED_GV);
    const gv = entry.goldenVector;
    const manifestAbs = resolve(root, gv.manifestPath);
    if (!existsSync(manifestAbs)) {
        return check('golden vector', FAIL, `MEASURED ref but committed manifest MISSING: ${gv.manifestPath}`);
    }
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestAbs, 'utf8')); }
    catch (e) { return check('golden vector', FAIL, `manifest unreadable/unparsable: ${e.message}`); }
    const manifestMd5s = JSON.stringify(manifest);
    if (!manifestMd5s.includes(gv.md5)) {
        return check('golden vector', FAIL,
            `entry md5 ${gv.md5} NOT recorded in ${gv.manifestPath} — pointer/manifest drift`);
    }
    // Optional byte verification: hash any same-length .bin next to the manifest.
    const wantLen = manifest?.cfa?.len_bytes;
    let byteNote = 'bytes NOT MEASURED (local/regenerable .bin absent)';
    try {
        const dir = dirname(manifestAbs);
        for (const f of readdirSync(dir).filter((f) => f.endsWith('.bin'))) {
            const p = resolve(dir, f);
            if (wantLen && statSync(p).size === wantLen) {
                const got = createHash('md5').update(readFileSync(p)).digest('hex');
                if (got === gv.md5) { byteNote = `bytes VERIFIED (${f} md5 matches)`; break; }
                return check('golden vector', FAIL, `local ${f} md5=${got} != pointer md5=${gv.md5}`);
            }
        }
    } catch { /* byte check stays NOT MEASURED */ }
    return check('golden vector', PASS,
        `pointer verified: md5 ${gv.md5} recorded in ${gv.manifestPath}; ${byteNote}`);
}

// ─── run ────────────────────────────────────────────────────────────────────
function run() {
    const boundaries = [];
    let failCount = 0;

    // Global coverage + declaration-surface checks (not tied to one boundary).
    const names = BINARY_LAYOUTS.map((e) => e.name);
    const globalChecks = [];
    globalChecks.push(ok(SEMVER.test(BINARY_LAYOUTS_VERSION),
        'BINARY_LAYOUTS_VERSION is semver', `version="${BINARY_LAYOUTS_VERSION}"`));
    globalChecks.push(ok(new Set(names).size === names.length,
        'boundary names are unique', `${names.length} entries, ${new Set(names).size} unique`));
    const missing = CANONICAL_BOUNDARIES.filter((n) => !names.includes(n));
    globalChecks.push(ok(missing.length === 0,
        'all 7 enumerated LAW-7 boundaries present', missing.length ? `MISSING: ${missing.join(', ')}` : names.join(', ')));
    failCount += globalChecks.filter((c) => c.status === FAIL).length;

    for (const entry of BINARY_LAYOUTS) {
        const checks = [...structuralChecks(entry)];

        // arithmetic
        const aProbe = arithmeticProbe[entry.name];
        if (aProbe) {
            const r = aProbe();
            checks.push(r === null
                ? check('offset/stride arithmetic self-consistency', NM, 'no codifiable offset rule transcribed in the 0.1.x seed (UNVERIFIED-heavy entry)')
                : check('offset/stride arithmetic self-consistency', r.ok ? PASS : FAIL, r.detail));
        } else {
            checks.push(check('offset/stride arithmetic self-consistency', NM, 'no arithmetic probe registered for this boundary'));
        }

        // conformance (real artifact)
        const cProbe = conformanceProbe[entry.name];
        const cr = cProbe ? cProbe() : { status: NM, detail: 'no conformance probe registered' };
        checks.push(check('real-artifact conformance probe', cr.status, cr.detail));

        // golden vector — null (seed) = honest absence; a MEASURED ref verifies
        // the committed manifest pointer + the local bytes when present.
        checks.push(goldenVectorCheck(entry));

        failCount += checks.filter((c) => c.status === FAIL).length;
        boundaries.push({ name: entry.name, version: entry.version, units: entry.units, checks });
    }

    return { globalChecks, boundaries, failCount };
}

const result = run();

if (asJson) {
    console.log(JSON.stringify({
        tool: 'check_layout_contracts',
        surfaceVersion: BINARY_LAYOUTS_VERSION,
        goldenVectorStatus: NOT_MEASURED_GV,
        ...result,
        exit: result.failCount > 0 ? 1 : 0,
    }, null, 2));
} else {
    const icon = (s) => (s === PASS ? '✓' : s === FAIL ? '✗' : '·');
    console.log('═══════════════════════════════════════════════════════════════════════════');
    console.log(`LAW 7 layout-contract battery (PRE-STAGE) — binary_layouts surface ${BINARY_LAYOUTS_VERSION}`);
    console.log(`golden vectors: ${NOT_MEASURED_GV}`);
    console.log('═══════════════════════════════════════════════════════════════════════════');
    console.log('\n[global]');
    for (const c of result.globalChecks) console.log(`  ${icon(c.status)} ${c.status.padEnd(12)} ${c.label} — ${c.detail}`);
    for (const b of result.boundaries) {
        console.log(`\n[${b.name}]  v${b.version}  units="${truncate(b.units, 48)}"`);
        for (const c of b.checks) console.log(`  ${icon(c.status)} ${c.status.padEnd(12)} ${c.label} — ${c.detail}`);
    }
    const nm = result.boundaries.flatMap((b) => b.checks).filter((c) => c.status === NM).length
        + result.globalChecks.filter((c) => c.status === NM).length;
    const pass = result.boundaries.flatMap((b) => b.checks).filter((c) => c.status === PASS).length
        + result.globalChecks.filter((c) => c.status === PASS).length;
    console.log('\n───────────────────────────────────────────────────────────────────────────');
    console.log(`SUMMARY: ${pass} PASS · ${result.failCount} FAIL · ${nm} NOT MEASURED (honest-absent)`);
    console.log(result.failCount > 0
        ? `RESULT: FAIL — ${result.failCount} real assertion failure(s) above`
        : `RESULT: OK — no assertion failures (golden battery still NOT MEASURED; lands at decoder cutover #14)`);
    console.log('───────────────────────────────────────────────────────────────────────────');
}

process.exit(result.failCount > 0 ? 1 : 0);
