#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/adaptive/derive_search_priors.mjs — banked-receipt → SEARCH-PRIOR MODEL.
//
// Lane ① (search priors ONLY). Reads banked solve receipts, extracts the sky
// centers the solver has historically LOCKED, clusters nearby locks into weighted
// prior regions, and emits a SearchPriorModel JSON (the exact shape the engine
// consumes via SolverOptions.searchPriors — see src/engine/pipeline/m6_plate_solve/
// search_priors.ts). The engine REORDERS its blind sweep toward these regions; it
// never prunes, never touches verify/thresholds/the math gate.
//
// RESEARCH SANDBOX (tools/adaptive): recommender-only. This script produces DATA;
// it never runs the solver and never touches src/. Spec-as-receipt envelope so any
// region is re-derivable from the record. HONEST DENOMINATORS: reports receipts
// scanned vs solved (a weight is a lock COUNT, never a fabricated confidence).
//
// USAGE:
//   node tools/adaptive/derive_search_priors.mjs --receipts <dir> [--out <file>]
//                                                [--merge-deg N] [--radius-deg N]
//   node tools/adaptive/derive_search_priors.mjs --receipts <dir> --source "label"
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const receiptsDir = arg('receipts', null);
const outFile = arg('out', null);
const mergeDeg = parseFloat(arg('merge-deg', '4'));      // cluster locks within this
const radiusDeg = parseFloat(arg('radius-deg', '8'));    // per-region influence radius
const sourceLabel = arg('source', receiptsDir ? `banked-receipts:${path.basename(receiptsDir)}` : 'banked-receipts');

if (!receiptsDir) {
    console.error('ERROR: --receipts <dir> is required.');
    process.exit(2);
}

// Great-circle separation in degrees (ra in HOURS — internal convention).
function sepDeg(raHa, decA, raHb, decB) {
    const D2R = Math.PI / 180;
    const ra1 = raHa * 15 * D2R, ra2 = raHb * 15 * D2R;
    const d1 = decA * D2R, d2 = decB * D2R;
    const h = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin((ra2 - ra1) / 2) ** 2;
    return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / D2R;
}

const files = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.json'));
let scanned = 0;
let solved = 0;
const locks = []; // { ra, dec, scale, file }

for (const f of files) {
    scanned++;
    let r;
    try {
        r = JSON.parse(fs.readFileSync(path.join(receiptsDir, f), 'utf8'));
    } catch {
        continue; // unreadable → skip (honest absence, not a fabricated lock)
    }
    const s = r.solution;
    // A solved receipt has a finite ra_hours + dec_degrees. Failed solves carry
    // null solution fields — they contribute NOTHING (no zero-fill).
    if (s && Number.isFinite(s.ra_hours) && Number.isFinite(s.dec_degrees)) {
        solved++;
        locks.push({ ra: s.ra_hours, dec: s.dec_degrees, scale: s.pixel_scale ?? null, file: f });
    }
}

// Greedy single-link clustering: each lock joins the first cluster whose centroid
// is within mergeDeg, else starts a new one. weight = number of locks in the
// cluster (a real count). Region center = the mean of member locks.
const clusters = [];
for (const lk of locks) {
    let joined = false;
    for (const c of clusters) {
        if (sepDeg(lk.ra, lk.dec, c.ra, c.dec) <= mergeDeg) {
            c.members.push(lk);
            c.ra = c.members.reduce((a, m) => a + m.ra, 0) / c.members.length;
            c.dec = c.members.reduce((a, m) => a + m.dec, 0) / c.members.length;
            joined = true;
            break;
        }
    }
    if (!joined) clusters.push({ ra: lk.ra, dec: lk.dec, members: [lk] });
}

// Deterministic order: strongest (most locks) first, then by ra then dec.
clusters.sort((a, b) => b.members.length - a.members.length || a.ra - b.ra || a.dec - b.dec);

const regions = clusters.map((c) => ({
    ra: c.ra,
    dec: c.dec,
    weight: c.members.length,
    radius_deg: radiusDeg,
    label: c.members.length === 1 ? c.members[0].file : `${c.members.length}-lock cluster`,
}));

const envelope = {
    spec: {
        tool: 'derive_search_priors',
        lane: 'search-priors (lane ①, reorder-only)',
        merge_deg: mergeDeg,
        radius_deg: radiusDeg,
    },
    provenance: {
        receipts_dir: receiptsDir,
        receipts_scanned: scanned,
        receipts_solved: solved,
        locks_used: locks.length,
        clusters: clusters.length,
        generated_at: new Date().toISOString(),
    },
    // The engine consumes THIS sub-object as SolverOptions.searchPriors.
    model: {
        source: sourceLabel,
        regions,
    },
};

const json = JSON.stringify(envelope, null, 2);
if (outFile) {
    fs.writeFileSync(outFile, json);
    console.error(`[derive_search_priors] ${solved}/${scanned} solved → ${regions.length} prior region(s) → ${outFile}`);
} else {
    process.stdout.write(json + '\n');
}
