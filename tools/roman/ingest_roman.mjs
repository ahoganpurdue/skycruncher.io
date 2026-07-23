/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASDF INGESTOR — normalized ingest manifest from a Roman L2 or SkyCruncher ASDF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure read/normalize — no engine, no Rust, no src/ reach-back).
 *
 * Reads an ASDF file with the subset reader (tools/asdf/asdf_reader.mjs), auto-
 * detects the dialect, and emits a NORMALIZED "ingest manifest" — the stable
 * seam a future engine m1 lane would consume to bring an external ASDF (our own
 * export OR a NASA Roman WFI L2) into the pipeline. Two dialects today:
 *   • ROMAN_L2   — roman_datamodels WfiImage L2 (tree.roman, tagged wfi_image)
 *   • SKYCRUNCHER — our own writer's receipt tree (tree.version + wcs_fits/solution)
 *
 * WCS EVALUATION is NOT re-implemented in JS. The gwcs transform stack is a
 * composed astropy model chain whose numerics belong to the real gwcs/astropy —
 * so pixel→sky at the center + 4 corners is delegated to tools/roman/eval_gwcs.py
 * (WSL isolated venv). The transform INVENTORY (which transform/frame tags ride
 * the chain) is read straight off the JS-parsed tree — no Python needed.
 *
 * HONEST-OR-ABSENT: every field is emitted only when actually present in the
 * file. A missing telescope, an un-evaluable WCS, a compressed data block — each
 * is recorded as absent / present-but-unevaluated with a reason, NEVER defaulted
 * or fabricated.
 *
 * CLI: node tools/roman/ingest_roman.mjs <file.asdf> [--out manifest.json] [--no-wcs-eval]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readAsdfFile, isTagged, untag } from '../asdf/asdf_reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL_SCRIPT = path.join(HERE, 'eval_gwcs.py');
const VENV_PY = process.env.ROMAN_VENV_PY || '$HOME/roman_venv/bin/python';

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Build a normalized ingest manifest for an ASDF file.
 * @param {string} filePath
 * @param {{ evalWcs?: boolean }} [opts]
 */
export function ingestAsdf(filePath, opts = {}) {
    const evalWcs = opts.evalWcs !== false;
    const asdf = readAsdfFile(filePath);
    const dialect = detectDialect(asdf.tree);

    const manifest = {
        source_dialect: dialect,
        file: path.basename(filePath),
        asdf: {
            standard_version: asdf.standardVersion ?? null,
            block_count: asdf.blocks.length,
        },
    };

    const view = dialect === 'ROMAN_L2' ? romanView(asdf)
        : dialect === 'SKYCRUNCHER' ? skycruncherView(asdf)
        : unknownView(asdf);

    manifest.meta = view.meta;
    manifest.exposure = view.exposure;
    manifest.data = view.data;

    // ── WCS: inventory (JS) + evaluation (Python bridge) ────────────────────────
    if (view.wcsNode && isGwcs(view.wcsNode)) {
        const wcs = {
            present: true,
            type: 'gwcs',
            key_path: view.wcsPath,
            transform_inventory: inventoryTransforms(view.wcsNode),
        };
        if (evalWcs) {
            const shape = imageShape(view.data);
            wcs.evaluation = evaluateWcs(filePath, view.wcsPath, shape);
        } else {
            wcs.evaluation = { evaluated: false, reason: 'wcs-eval disabled (--no-wcs-eval)' };
        }
        // hoist the center for the top-level convenience field the seam names
        const c = wcs.evaluation?.center?.world;
        manifest.wcs_center = Array.isArray(c)
            ? { ra_deg: c[0], dec_deg: c[1], x: wcs.evaluation.center.x, y: wcs.evaluation.center.y }
            : null;
        manifest.corners = wcs.evaluation?.corners
            ? wcs.evaluation.corners.map((k) => ({ name: k.name, x: k.x, y: k.y, ra_deg: k.world?.[0] ?? null, dec_deg: k.world?.[1] ?? null }))
            : null;
        manifest.wcs = wcs;
    } else if (view.wcsFits) {
        // an SkyCruncher file with only the FITS-keyword fallback (no native gwcs)
        manifest.wcs = { present: true, type: 'wcs_fits', key_path: 'wcs_fits', note: 'FITS-keyword WCS only (no native gwcs block); pixel→sky eval not bridged for this fallback' };
        manifest.wcs_center = null;
        manifest.corners = null;
    } else {
        manifest.wcs = { present: false };
        manifest.wcs_center = null;
        manifest.corners = null;
    }

    return manifest;
}

// ── dialect detection ───────────────────────────────────────────────────────────

function detectDialect(tree) {
    if (tree && Object.prototype.hasOwnProperty.call(tree, 'roman')) {
        const roman = untag(tree.roman);
        if (roman && typeof roman === 'object' && roman.meta) return 'ROMAN_L2';
    }
    // our writer: a versioned receipt with a wcs_fits and/or solution block
    if (tree && (tree.wcs_fits || tree.solution) && typeof tree.version === 'string') return 'SKYCRUNCHER';
    return 'UNKNOWN';
}

// ── per-dialect views (honest-or-absent extraction) ─────────────────────────────

function romanView(asdf) {
    const roman = untag(asdf.tree.roman);
    const meta = roman.meta || {};
    const instr = meta.instrument || {};
    const exp = meta.exposure || {};
    const obs = meta.observation || {};

    return {
        meta: prune({
            telescope: scalarOrAbsent(meta.telescope),
            instrument: scalarOrAbsent(instr.name),
            detector: scalarOrAbsent(instr.detector),
            optical_element: scalarOrAbsent(instr.optical_element),
            observation_id: scalarOrAbsent(obs.observation_id),
            model_type: scalarOrAbsent(meta.model_type),
            calibration_software: scalarOrAbsent(meta.calibration_software_name),
        }),
        exposure: prune({
            type: scalarOrAbsent(exp.type),
            exposure_time: numOrAbsent(exp.exposure_time),
            effective_exposure_time: numOrAbsent(exp.effective_exposure_time),
            nresultants: numOrAbsent(exp.nresultants),
            start_time: timeOrAbsent(exp.start_time),
            end_time: timeOrAbsent(exp.end_time),
        }),
        data: ndarrayInfo(asdf, roman.data),
        wcsNode: meta.wcs ?? null,
        wcsPath: 'roman.meta.wcs',
        wcsFits: null,
    };
}

function skycruncherView(asdf) {
    const t = asdf.tree;
    const sol = t.solution || {};
    // Our receipt has no fixed telescope/instrument slot; surface what exists,
    // honest-absent otherwise (a real capture may carry hardware fields).
    const hw = t.hardware || t.optics || t.camera || {};
    return {
        meta: prune({
            receipt_version: scalarOrAbsent(t.version),
            spatial_hash: scalarOrAbsent(sol.spatial_hash),
            stars_matched: numOrAbsent(sol.stars_matched),
            ra_hours: numOrAbsent(sol.ra_hours),
            dec_degrees: numOrAbsent(sol.dec_degrees),
            pixel_scale_arcsec: numOrAbsent(sol.pixel_scale),
            telescope: scalarOrAbsent(hw.telescope),
            instrument: scalarOrAbsent(hw.instrument ?? hw.camera_model ?? hw.model),
            detector: scalarOrAbsent(hw.sensor ?? hw.detector),
            timestamp_trusted: typeof t.timestamp_trusted === 'boolean' ? t.timestamp_trusted : undefined,
        }),
        exposure: prune({
            export_date: scalarOrAbsent(t.export_date),
        }),
        data: ndarrayInfo(asdf, t.data),
        wcsNode: t.wcs ?? null,      // native gwcs block (present when solved)
        wcsPath: 'wcs',
        wcsFits: t.wcs_fits ?? null,
    };
}

function unknownView(asdf) {
    // Surface the top-level keys so a human can see what it is; find any gwcs.
    const found = findFirstGwcs(asdf.tree);
    return {
        meta: prune({ top_level_keys: Object.keys(asdf.tree || {}) }),
        exposure: null,
        data: null,
        wcsNode: found?.node ?? null,
        wcsPath: found?.path ?? null,
        wcsFits: null,
    };
}

// ── ndarray + shape helpers ─────────────────────────────────────────────────────

function ndarrayInfo(asdf, node) {
    if (!node) return null;
    const body = untag(node);
    if (!body || typeof body !== 'object' || (body.source == null && !Array.isArray(body.data))) return null;
    const info = {
        shape: (body.shape || []).map(Number),
        dtype: typeof body.datatype === 'string' ? body.datatype : (Array.isArray(body.datatype) ? body.datatype[0] : null),
        byteorder: body.byteorder || null,
    };
    if (typeof body.source === 'number') {
        const blk = asdf.blocks[body.source];
        info.source_block = body.source;
        info.compression = blk?.compression ?? null;
        info.decodable = blk?.compression === 'none';
    } else {
        info.inline = true;
        info.decodable = true;
    }
    return info;
}

/** [H, W] from a data-info's shape (first two dims), or null. */
function imageShape(dataInfo) {
    const s = dataInfo?.shape;
    if (Array.isArray(s) && s.length >= 2 && s[0] > 0 && s[1] > 0) return { H: s[0], W: s[1] };
    return null;
}

// ── gwcs inventory (dialect-independent, from the JS tree) ───────────────────────

function isGwcs(node) {
    return isTagged(node) && /gwcs\/wcs/.test(node.__tag__);
}

/**
 * Walk a gwcs/wcs node, tallying the transform + frame + coordinate tags in the
 * chain. Returns { transforms: {name:count}, frames:[…], coordinate_frames:[…],
 * has_sip, has_tabular }.
 */
function inventoryTransforms(wcsNode) {
    const transforms = {};
    const frames = new Set();
    const coordFrames = new Set();
    (function walk(n) {
        if (isTagged(n)) {
            const t = n.__tag__;
            const tm = /transform\/([a-z0-9_]+)-/.exec(t);
            if (tm) transforms[tm[1]] = (transforms[tm[1]] || 0) + 1;
            const fm = /gwcs\/(frame2d|celestial_frame|composite_frame|spectral_frame|temporal_frame)-/.exec(t);
            if (fm) frames.add(fm[1]);
            const cm = /coordinates\/frames\/([a-z0-9_]+)-/.exec(t);
            if (cm) coordFrames.add(cm[1]);
            walk(n.__value__);
            return;
        }
        if (Array.isArray(n)) { for (const x of n) walk(x); return; }
        if (n && typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k]); return; }
    })(wcsNode);

    return {
        transforms,
        frames: [...frames],
        coordinate_frames: [...coordFrames],
        has_sip_polynomial: !!transforms.polynomial,
        has_tabular_distortion: !!transforms.tabular,
    };
}

/** DFS for the first gwcs/wcs node + its dotted path (for UNKNOWN dialects). */
function findFirstGwcs(tree, prefix = '') {
    if (isGwcs(tree)) return { node: tree, path: prefix.replace(/^\./, '') };
    const body = isTagged(tree) ? tree.__value__ : tree;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const k of Object.keys(body)) {
            const r = findFirstGwcs(body[k], `${prefix}.${k}`);
            if (r) return r;
        }
    }
    return null;
}

// ── WCS evaluation bridge (Python via WSL) ───────────────────────────────────────

/**
 * Evaluate pixel→sky at the frame center + 4 corners via tools/roman/eval_gwcs.py
 * in the WSL isolated venv. Returns the parsed JSON on success, or an honest
 * { evaluated:false, error } on any failure — never a fabricated coordinate.
 */
function evaluateWcs(winFile, keyPath, shape) {
    if (!shape) return { evaluated: false, reason: 'no image shape available to place the corners' };
    const scriptWsl = toWslPath(EVAL_SCRIPT);
    const fileWsl = toWslPath(path.resolve(winFile));
    const cmd = `${VENV_PY} "${scriptWsl}" "${fileWsl}" "${keyPath}" --shape ${shape.H},${shape.W}`;
    try {
        const out = execFileSync('wsl', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8', timeout: 120000 });
        const json = JSON.parse(lastJsonLine(out));
        if (json.ok !== true) return { evaluated: false, error: json.error || 'eval_gwcs reported not-ok' };
        return {
            evaluated: true,
            bridge: 'wsl:roman_venv/eval_gwcs.py',
            pixel_convention: json.pixel_convention,
            world_axis_names: json.world_axis_names ?? null,
            world_axis_units: json.world_axis_units ?? null,
            center: json.center,
            corners: json.corners ?? null,
        };
    } catch (e) {
        return { evaluated: false, error: `bridge failed: ${(e && e.message) ? e.message.split('\n')[0] : String(e)}` };
    }
}

/** Windows abs path → WSL /mnt path (drive-letter aware; forward slashes). */
export function toWslPath(p) {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    return p.replace(/\\/g, '/');
}

function lastJsonLine(out) {
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('{')) return lines[i];
    }
    return out.trim();
}

// ── little value helpers (honest-or-absent) ─────────────────────────────────────

/** Roman placeholder sentinels ('?' string, -999999 numeric) are treated as ABSENT. */
function scalarOrAbsent(v) {
    if (v == null) return undefined;
    if (typeof v === 'string') return v === '?' ? undefined : v;
    if (typeof v === 'number') return isRomanNull(v) ? undefined : v;
    if (typeof v === 'boolean') return v;
    return undefined;
}
function numOrAbsent(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || isRomanNull(v)) return undefined;
    return v;
}
function timeOrAbsent(v) {
    // a !time/time tagged scalar or {value:…} flow
    const b = isTagged(v) ? v.__value__ : v;
    if (typeof b === 'string') return b;
    if (b && typeof b === 'object' && typeof b.value === 'string') return b.value;
    return undefined;
}
function isRomanNull(n) { return n === -999999 || n === -999999.0; }

/** Drop undefined-valued keys so the manifest carries only present fields. */
function prune(obj) {
    const out = {};
    for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
    return Object.keys(out).length ? out : null;
}

// ── thin CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    const outIdx = args.indexOf('--out');
    const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
    const evalWcs = !args.includes('--no-wcs-eval');
    if (!file) {
        console.error('usage: node tools/roman/ingest_roman.mjs <file.asdf> [--out manifest.json] [--no-wcs-eval]');
        process.exit(2);
    }
    const manifest = ingestAsdf(file, { evalWcs });
    const text = JSON.stringify(manifest, null, 2);
    if (outPath) { fs.writeFileSync(outPath, text); console.error(`[ingest] wrote ${outPath}`); }
    console.log(text);
}
