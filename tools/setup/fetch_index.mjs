#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * fetch_index — provision the greenfield g15u quad index (+ optional atlas) here
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The greenfield desktop solver (src-tauri/src/greenfield_solve.rs →
 * crates/solver-core QuadIndex::open) reads the g15u BAND-FILE layout:
 *
 *   <index_root>/manifest.json          (release manifest — lists every file + sha256)
 *   <index_root>/stars.arrow            (181 MB — the star table hydrated into matches)
 *   <index_root>/band_0.arrow           (503 MB — CHUNKED on R2, see below)
 *   <index_root>/band_1.arrow ... band_14.arrow
 *
 * It does NOT read the v2 spatial-shard layout — this fetcher provisions the
 * ORIGINAL g15u band files (verified against the manifest's sha256 fields).
 *
 * SOURCE — public R2 (verified live 2026-07-21; contract: docs/R2_STARDATA_LAYOUT.md):
 *   base https://pub-19850926b2c64818900201eb0c1c98b7.r2.dev, prefix
 *   starplates-2026.07-quadidx-g15u/. Per band: GET band_N.arrow; on 404 GET
 *   band_N.parts.json (schema skycruncher.r2.chunked-object/1) → fetch parts[] in
 *   ascending order → concatenate → verify sha256(result)==whole.sha256. Only
 *   band_0 is chunked today (> R2's single-object cap); the rule is generic.
 *   --copy-from <dir> takes precedence per-file (LAN/USB copy of the g15u dir).
 *
 * Resumable (verified files skipped; single-object downloads resume via HTTP
 * Range). Every file sha256-verified. Honest about any file it cannot acquire.
 *
 * ATLAS (--atlas): the legacy browser deep-catalog (star_catalog_adapter) also
 * lives on R2 at atlas-2026.07-hybrid/. Fetches the sector-json-live set (36
 * files the adapter loads) into <atlas_root>/sectors/; the arrow twins are
 * optional (--atlas-twins). NOTE: the packaged app serves /atlas from the
 * EMBEDDED webview root, so atlas_root feeds headless tools / rebuilds, not the
 * in-app browser lane (see docs/LAPTOP_SETUP.md §7).
 *
 * Usage:
 *   node tools/setup/fetch_index.mjs                          # download+verify the index from R2
 *   node tools/setup/fetch_index.mjs --copy-from "E:\g15u"    # copy+verify from a local dir
 *   node tools/setup/fetch_index.mjs --verify-only            # hash every present file, no fetch
 *   node tools/setup/fetch_index.mjs --atlas                  # …and fetch the atlas too
 *   node tools/setup/fetch_index.mjs --atlas-only             # fetch only the atlas
 */

import { createHash } from 'node:crypto';
import {
    existsSync,
    statSync,
    createReadStream,
    createWriteStream,
    mkdirSync,
    renameSync,
    readFileSync,
    writeFileSync,
    rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import {
    resolveStoragePaths,
    ensureStorageConfig,
    LEGACY_INDEX_DIR,
} from '../config/storage_paths.mjs';
import {
    STAR_DATA_BASE_URL,
    QUAD_INDEX_PREFIX,
    ATLAS_PREFIX as SHARED_ATLAS_PREFIX,
} from '../config/star_data_source.mjs';

/**
 * Public R2 base + prefixes (docs/R2_STARDATA_LAYOUT.md, verified live 2026-07-21).
 * Sourced from the single shared config point `tools/config/star_data_source.mjs`
 * (mirror: src/config/starDataSource.ts) — re-exported under the historical names
 * so importers/tests keep working. NEVER hardcode the base URL/prefix in a code path.
 */
export const PUBLIC_BASE_URL = STAR_DATA_BASE_URL;
export const QUAD_PREFIX = QUAD_INDEX_PREFIX;
export const ATLAS_PREFIX = SHARED_ATLAS_PREFIX;

// ─── generic helpers ───────────────────────────────────────────────────────────

function parseArgs(argv) {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t.startsWith('--')) {
            const key = t.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                a[key] = next;
                i++;
            } else {
                a[key] = true;
            }
        } else {
            a._.push(t);
        }
    }
    return a;
}

function fmtBytes(n) {
    if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
    if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
    if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
    return `${n} B`;
}

async function sha256File(path) {
    const h = createHash('sha256');
    await pipeline(createReadStream(path), h);
    return h.digest('hex');
}

/** Chunk-manifest key for a target file (band_0.arrow → band_0.parts.json). */
export function partsManifestKey(file) {
    return file.endsWith('.arrow') ? `${file.slice(0, -'.arrow'.length)}.parts.json` : `${file}.parts.json`;
}

/**
 * Reassemble a chunked object from its parts manifest (schema
 * skycruncher.r2.chunked-object/1): fetch each part in ascending `order`,
 * concatenate raw bytes, verify sha256(result)==whole.sha256. `fetchFn` is
 * injectable (unit-testable without the network). Returns {ok, reason?}.
 */
export async function reassembleChunked({ fetchFn, base, prefix, pm, dest, expectedSha }) {
    if (pm.schema && !String(pm.schema).startsWith('skycruncher.r2.chunked-object/')) {
        return { ok: false, reason: `unexpected chunk schema ${pm.schema}` };
    }
    const whole = expectedSha || pm.whole?.sha256;
    const parts = [...(pm.parts ?? [])].sort((a, b) => a.order - b.order);
    if (parts.length === 0) return { ok: false, reason: 'chunk manifest has no parts' };
    const part = `${dest}.part`;
    rmSync(part, { force: true }); // reassembly restarts atomically (parts are re-streamed)
    const out = createWriteStream(part, { flags: 'w' });
    try {
        let written = 0;
        for (const p of parts) {
            const url = `${String(base).replace(/\/$/, '')}/${prefix}/${p.key}`;
            const res = await fetchFn(url);
            if (!(res.ok || res.status === 206)) {
                out.destroy();
                return { ok: false, reason: `part ${p.key} → HTTP ${res.status}` };
            }
            for await (const chunk of Readable.fromWeb(res.body)) {
                if (!out.write(chunk)) await once(out, 'drain');
                written += chunk.length;
            }
        }
        out.end();
        await once(out, 'finish');
        if (pm.whole?.bytes && written !== pm.whole.bytes) {
            return { ok: false, reason: `reassembled ${written} B ≠ whole ${pm.whole.bytes} B` };
        }
        const sha = await sha256File(part);
        if (whole && sha !== whole) {
            return { ok: false, reason: `whole sha mismatch (got ${sha.slice(0, 12)}…)` };
        }
        renameSync(part, dest);
        return { ok: true };
    } catch (e) {
        try {
            out.destroy();
        } catch {
            /* ignore */
        }
        return { ok: false, reason: `chunked reassembly: ${e.message}` };
    }
}

/** Stream a single object (with Range-resume from an existing .part) → dest, verify sha. */
async function downloadVerified(url, dest, expectedSha, expectedBytes) {
    const part = `${dest}.part`;
    let start = 0;
    if (existsSync(part)) {
        start = statSync(part).size;
        if (start >= (expectedBytes || Infinity)) start = 0;
    }
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    const res = await fetch(url, { headers });
    if (!(res.ok || res.status === 206)) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    const append = res.status === 206 && start > 0;
    const w = createWriteStream(part, { flags: append ? 'a' : 'w' });
    await pipeline(Readable.fromWeb(res.body), w);
    const sha = await sha256File(part);
    if (expectedSha && sha !== expectedSha) return { ok: false, reason: `sha mismatch (got ${sha.slice(0, 12)}…)` };
    renameSync(part, dest);
    return { ok: true };
}

/** Copy a local file → dest with sha verify. */
async function copyVerified(src, dest, expectedSha) {
    const part = `${dest}.part`;
    await pipeline(createReadStream(src), createWriteStream(part));
    const sha = await sha256File(part);
    if (expectedSha && sha !== expectedSha) {
        rmSync(part, { force: true });
        return { ok: false, reason: `sha mismatch (got ${sha.slice(0, 12)}…)` };
    }
    renameSync(part, dest);
    return { ok: true };
}

// ─── quad index ──────────────────────────────────────────────────────────────

function manifestFiles(manifest) {
    const files = [];
    if (manifest.stars?.file) {
        files.push({ file: manifest.stars.file, sha256: manifest.stars.sha256, bytes: manifest.stars.bytes });
    }
    for (const b of manifest.bands ?? []) {
        files.push({ file: b.file, sha256: b.sha256, bytes: b.bytes });
    }
    return files;
}

async function loadManifest(args, indexRoot, baseUrl) {
    const candidates = [];
    if (args.manifest) candidates.push(args.manifest);
    candidates.push(join(indexRoot, 'manifest.json'));
    if (args['copy-from']) candidates.push(join(args['copy-from'], 'manifest.json'));
    for (const c of candidates) {
        if (existsSync(c)) return { manifest: JSON.parse(readFileSync(c, 'utf8')), source: c, bytes: readFileSync(c) };
    }
    if (baseUrl) {
        const url = `${String(baseUrl).replace(/\/$/, '')}/${args.prefix || QUAD_PREFIX}/manifest.json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`manifest fetch ${url} → HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        return { manifest: JSON.parse(buf.toString('utf8')), source: url, bytes: buf };
    }
    throw new Error('no manifest source: pass --copy-from <g15uDir>, --base-url <r2>, or place manifest.json in the index root');
}

async function acquireIndexFile(f, dest, { copyFrom, baseUrl, prefix }) {
    // 1. Local copy (LAN/USB) first.
    if (copyFrom) {
        const src = join(copyFrom, f.file);
        if (existsSync(src)) {
            process.stdout.write(`  ${f.file} — copying ${fmtBytes(f.bytes)} from ${copyFrom}… `);
            const r = await copyVerified(src, dest, f.sha256);
            console.log(r.ok ? 'OK' : `FAILED (${r.reason})`);
            return r;
        }
    }
    // 2. R2 single object; on 404, chunked reassembly.
    if (baseUrl) {
        const url = `${String(baseUrl).replace(/\/$/, '')}/${prefix}/${f.file}`;
        process.stdout.write(`  ${f.file} — downloading ${fmtBytes(f.bytes)}… `);
        const r = await downloadVerified(url, dest, f.sha256, f.bytes);
        if (r.ok) {
            console.log('OK');
            return r;
        }
        if (r.status === 404) {
            const pkey = partsManifestKey(f.file);
            process.stdout.write(`chunked (${pkey})… `);
            const pres = await fetch(`${String(baseUrl).replace(/\/$/, '')}/${prefix}/${pkey}`);
            if (!pres.ok) {
                console.log(`FAILED (parts manifest HTTP ${pres.status})`);
                return { ok: false, reason: `R2-ABSENT (no single object + no ${pkey})` };
            }
            const pm = await pres.json();
            const rr = await reassembleChunked({ fetchFn: fetch, base: baseUrl, prefix, pm, dest, expectedSha: f.sha256 });
            console.log(rr.ok ? `OK (${(pm.parts || []).length} parts)` : `FAILED (${rr.reason})`);
            return rr;
        }
        console.log(`FAILED (${r.reason})`);
        return r;
    }
    return { ok: false, reason: 'no source (need --copy-from or --base-url)' };
}

async function runIndex(args, baseUrl) {
    let indexRoot = args['index-root'];
    let note = '';
    if (!indexRoot) {
        const ens = ensureStorageConfig();
        indexRoot = ens.index_root;
        note = ` (source: ${ens.source}${ens.created ? ', storage.json written' : ''})`;
    }
    const paths = resolveStoragePaths();
    console.log('── fetch_index — greenfield g15u quad index ──');
    console.log(`index_root : ${indexRoot}${note}`);
    console.log(`config     : ${paths.config_path}`);
    mkdirSync(indexRoot, { recursive: true });

    const { manifest, source, bytes } = await loadManifest(args, indexRoot, baseUrl);
    console.log(`manifest   : ${manifest.release} (from ${source})`);
    const localManifest = join(indexRoot, 'manifest.json');
    if (!existsSync(localManifest)) writeFileSync(localManifest, bytes);

    const files = manifestFiles(manifest);
    const total = files.reduce((s, f) => s + (f.bytes || 0), 0);
    console.log(`files      : ${files.length} data files, ${fmtBytes(total)} total\n`);

    const copyFrom = args['copy-from'] || null;
    const prefix = args.prefix || QUAD_PREFIX;
    const verifyOnly = !!args['verify-only'];
    const done = [];
    const missing = [];

    for (const f of files) {
        const dest = join(indexRoot, f.file);
        if (existsSync(dest)) {
            const sz = statSync(dest).size;
            if (!f.bytes || sz === f.bytes) {
                process.stdout.write(`  ${f.file} — verifying… `);
                const sha = await sha256File(dest);
                if (!f.sha256 || sha === f.sha256) {
                    console.log('OK');
                    done.push(f.file);
                    continue;
                }
                console.log(`SHA MISMATCH — re-acquiring`);
            } else {
                console.log(`  ${f.file} — size ${fmtBytes(sz)} ≠ ${fmtBytes(f.bytes)} — re-acquiring`);
            }
        }
        if (verifyOnly) {
            missing.push({ ...f, reason: 'absent (verify-only)' });
            continue;
        }
        const r = await acquireIndexFile(f, dest, { copyFrom, baseUrl, prefix });
        if (r?.ok) done.push(f.file);
        else missing.push({ ...f, reason: r?.reason || 'unacquired' });
    }

    console.log(`\n── index summary ──`);
    console.log(`verified   : ${done.length}/${files.length} files present + sha-matched`);
    if (missing.length === 0) {
        console.log('✓ index COMPLETE — the greenfield solver will find every band + the star table.');
        return 0;
    }
    console.log(`MISSING    : ${missing.length}:`);
    for (const m of missing) console.log(`   - ${m.file} (${fmtBytes(m.bytes)}) — ${m.reason}`);
    const src = args['copy-from'] || LEGACY_INDEX_DIR;
    console.log('\nMANUAL_COPY fallback (if R2 is unreachable) — copy from the desktop g15u dir:');
    for (const m of missing) {
        console.log(`   "${join(src, m.file)}"  ->  "${join(indexRoot, m.file)}"  (${fmtBytes(m.bytes)}, sha256 ${(m.sha256 || '').slice(0, 16)}…)`);
    }
    console.log('Re-run with --verify-only after copying to confirm every sha matches.');
    return 2;
}

// ─── atlas ─────────────────────────────────────────────────────────────────────

async function runAtlas(args, baseUrl) {
    if (!baseUrl) {
        console.log('── atlas — SKIPPED (needs --base-url or the default public base) ──');
        return 0;
    }
    const atlasRoot = args['atlas-root'] || resolveStoragePaths().atlas_root;
    const prefix = args['atlas-prefix'] || ATLAS_PREFIX;
    const includeTwins = !!args['atlas-twins'];
    console.log(`\n── atlas — hybrid deep catalog (${prefix}) ──`);
    console.log(`atlas_root : ${atlasRoot}`);
    mkdirSync(atlasRoot, { recursive: true });

    const murl = `${String(baseUrl).replace(/\/$/, '')}/${prefix}/manifest.json`;
    const mres = await fetch(murl);
    if (!mres.ok) throw new Error(`atlas manifest ${murl} → HTTP ${mres.status}`);
    const mbuf = Buffer.from(await mres.arrayBuffer());
    const manifest = JSON.parse(mbuf.toString('utf8'));
    if (manifest.schema && !String(manifest.schema).startsWith('skycruncher.r2.atlas-aggregate/')) {
        throw new Error(`unexpected atlas schema ${manifest.schema}`);
    }
    writeFileSync(join(atlasRoot, 'manifest.json'), mbuf);

    const wanted = (manifest.files ?? []).filter(
        (f) => f.role === 'sector-json-live' || (includeTwins && f.role === 'sector-arrow-twin'),
    );
    console.log(`objects    : ${wanted.length} (${includeTwins ? 'json-live + arrow-twins' : 'json-live only'})\n`);

    const done = [];
    const missing = [];
    for (const f of wanted) {
        const objKey = f.key.startsWith('sectors/') ? f.key : `sectors/${f.key}`;
        const dest = join(atlasRoot, objKey);
        mkdirSync(dirname(dest), { recursive: true });
        if (existsSync(dest) && (!f.bytes || statSync(dest).size === f.bytes)) {
            const sha = await sha256File(dest);
            if (!f.sha256 || sha === f.sha256) {
                done.push(objKey);
                continue;
            }
        }
        const url = `${String(baseUrl).replace(/\/$/, '')}/${prefix}/${objKey}`;
        process.stdout.write(`  ${objKey} — ${fmtBytes(f.bytes)}… `);
        const r = await downloadVerified(url, dest, f.sha256, f.bytes);
        console.log(r.ok ? 'OK' : `FAILED (${r.reason})`);
        if (r.ok) done.push(objKey);
        else missing.push({ ...f, key: objKey, reason: r.reason });
    }
    console.log(`\n── atlas summary ──`);
    console.log(`verified   : ${done.length}/${wanted.length}${missing.length ? ` — MISSING ${missing.length}` : ' — COMPLETE'}`);
    for (const m of missing) console.log(`   - ${m.key} — ${m.reason}`);
    console.log('(In-app browser confirmation reads the EMBEDDED /atlas — atlas_root feeds headless tools / rebuilds. See LAPTOP_SETUP.md §7.)');
    return missing.length ? 2 : 0;
}

// ─── entry ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    // Default source = public R2, unless the user restricts to a purely local copy.
    const localOnly = !!args['copy-from'] && !args['base-url'] && !args['from-r2'];
    const baseUrl = args['base-url'] || (localOnly ? null : PUBLIC_BASE_URL);

    let code = 0;
    if (!args['atlas-only']) code = await runIndex(args, baseUrl);
    if (args['atlas'] || args['atlas-only']) {
        const ac = await runAtlas(args, baseUrl);
        code = code || ac;
    }
    process.exit(code);
}

// Only run when invoked as a script (allow importing helpers for tests).
if (process.argv[1]?.endsWith('fetch_index.mjs')) {
    main().catch((err) => {
        console.error(`fetch_index FAILED: ${err.message}`);
        process.exit(1);
    });
}
