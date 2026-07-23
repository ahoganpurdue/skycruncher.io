#!/usr/bin/env node
/**
 * fdr_byte_identity.mjs — PHASE-1 INVARIANT CHECK (LAW 2). Verifies that turning
 * CONFIRM_FDR_SHADOW on changes NOTHING except the additive deep_confirmed.fdr_shadow
 * key. Compares the flagOFF vs flagON captured receipts: for every frame it strips
 * fdr_shadow from the flagON deep_confirmed and deep-equals the remainder to flagOFF,
 * and diffs confirm_status + the sacred solution pins field-by-field.
 * Exit 0 = byte-identical (no phase-1 bug). Exit 1 = a LEGACY field moved (phase-1 bug).
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('test_results/fdr_shadow_2026-07-12/receipts');
const FRAMES = ['seestar_m66', 'cr2', 'seestar_wrongWCS_crpix+30', 'seestar_wrongWCS_crpix+70'];

function load(frame, tag) {
    const p = path.join(DIR, `${frame}.${tag}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
// strip additive shadow key so the legacy remainder is comparable
function stripShadow(obj) {
    if (!obj) return obj;
    const clone = JSON.parse(JSON.stringify(obj));
    if (clone.deep_confirmed && clone.deep_confirmed.fdr_shadow) delete clone.deep_confirmed.fdr_shadow;
    if (clone.solution_pins) { // drop the summary's fdr_* + flag fields (expected to differ)
        for (const k of Object.keys(clone.solution_pins)) {
            if (k.startsWith('fdr_') || k === 'flag') delete clone.solution_pins[k];
        }
    }
    return clone;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let bug = false;
const report = [];
for (const f of FRAMES) {
    const off = load(f, 'flagOFF');
    const on = load(f, 'flagON');
    if (!off || !on) { report.push({ frame: f, status: 'MISSING', off: !!off, on: !!on }); bug = true; continue; }
    const offS = stripShadow(off);
    const onS = stripShadow(on);
    const identical = eq(offS, onS);
    const onHasShadow = !!(on.deep_confirmed && on.deep_confirmed.fdr_shadow);
    const offHasShadow = !!(off.deep_confirmed && off.deep_confirmed.fdr_shadow);
    if (!identical) bug = true;
    if (offHasShadow) bug = true; // flag-off must NOT carry a shadow block
    report.push({
        frame: f,
        legacy_identical_OFF_vs_ON: identical,
        flagOFF_has_shadow: offHasShadow,   // must be false
        flagON_has_shadow: onHasShadow,     // must be true
    });
}
console.log(JSON.stringify({ byte_identity_bug: bug, frames: report }, null, 2));
process.exit(bug ? 1 : 0);
