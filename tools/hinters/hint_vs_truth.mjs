#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HINT vs TRUTH — score a blind hint census against an oracle-WCS answer key
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node tools/hinters/hint_vs_truth.mjs --census <census.jsonl> \
 *        --truth <truth.json> [--receipt <base=path,...>] [--out <report.json>]
 *
 * PURE (no engine imports) — joins the blind census rows (hint_census.mjs
 * output) with an oracle-truth file and emits a per-methodology error table
 * (signed error, |error|, % error) for every scored quantity. Truth is joined
 * HERE and never in the census — the census must stay blind.
 *
 * ── ORACLE TRUTH SCHEMA (--truth) ─────────────────────────────────────────
 * Either an ARRAY of frame entries, or an OBJECT map keyed by frame name/base:
 *
 *   [
 *     {
 *       "frame": "sample_observation.cr2",   // filename OR base (ext stripped) — matched either way
 *       "wcs": {
 *         "ra_hours":        17.5858,         // optional (not a census quantity; carried for context)
 *         "dec_deg":         -23.30,          // optional
 *         "scale_arcsec_px": 63.211,          // REQUIRED to score pixel_scale + derived-FL
 *         "rotation_deg":    12.4,            // optional (only scored against a --receipt)
 *         "parity":          -1               // optional (+1 mirrored sky / -1 normal; y-down convention)
 *       },
 *       "pitch_um": 6.25                       // optional true sensor pitch; enables FL scoring +
 *                                              //   derived-FL-from-true-scale. If absent, the census's
 *                                              //   MEASURED SENSOR_DB pitch is used (documented per row).
 *     }, ...
 *   ]
 *
 * ── DERIVED-FL-FROM-TRUE-SCALE ────────────────────────────────────────────
 * The honest post-solve FL the sky confirms:  FL_mm = 206.265 × pitch_µm / scale_arcsec_px
 * (optics_manager.recoverFocalLengthFromScale — pitch µm, scale arcsec/px). Emitted as its own
 * reference value AND used as the truth every focal_length_mm methodology is scored against.
 *
 * ── POST-SOLVE RECEIPTS (--receipt) ───────────────────────────────────────
 * Comma-separated base=path pairs (or a single path applied to all frames). A
 * receipt's solution.pixel_scale is scored as a POSTSOLVE_RECEIPT_scale
 * methodology, its recovered FL as POSTSOLVE_RECOVERED_FL, and rotation/parity
 * (if present) against the oracle wcs.
 *
 * Honest-or-absent: a null prediction is reported as ABSTAIN (never scored as 0);
 * a missing truth field yields verdict NOT_MEASURED for that quantity.
 */
import fs from 'node:fs';
import path from 'node:path';

// ── args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CENSUS = argVal('--census', 'test_results/hinter_census/census.jsonl');
const TRUTH = argVal('--truth', null);
const RECEIPT_ARG = argVal('--receipt', null);
const OUT = argVal('--out', 'test_results/hinter_census/scored.json');

if (!TRUTH) { console.error('ERROR: --truth <oracle.json> is required.'); process.exit(2); }

const stripExt = (fn) => fn.replace(/\.(fit|fits|fts|cr2|arw|nef|dng|json)$/i, '');
const finitePos = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
const recoverFL = (scale, pitch) => (finitePos(scale) && finitePos(pitch) ? 206.265 * pitch / scale : null);

// ── load census rows ───────────────────────────────────────────────────────
function loadCensus(p) {
    const rows = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (e) { console.error('skip malformed census line:', e.message); }
    }
    return rows;
}

// ── load + index truth (array OR keyed object) ──────────────────────────────
function loadTruth(p) {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const idx = new Map(); // base → entry
    const put = (key, entry) => { if (key) idx.set(stripExt(String(key)).toLowerCase(), entry); };
    if (Array.isArray(raw)) {
        for (const e of raw) put(e.frame ?? e.base ?? e.frame_id, e);
    } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) put(v.frame ?? k, { frame: k, ...v });
    }
    return idx;
}

function truthFor(idx, row) {
    return idx.get(stripExt(row.frame).toLowerCase()) ?? idx.get(String(row.base).toLowerCase()) ?? null;
}

// ── receipts (optional) ─────────────────────────────────────────────────────
function loadReceipts(arg) {
    const map = new Map(); // base → receipt obj ; '*' → single receipt for all
    if (!arg) return map;
    for (const part of arg.split(',').map((s) => s.trim()).filter(Boolean)) {
        const eq = part.indexOf('=');
        if (eq >= 0) {
            const base = stripExt(part.slice(0, eq)).toLowerCase();
            try { map.set(base, JSON.parse(fs.readFileSync(part.slice(eq + 1), 'utf8'))); }
            catch (e) { console.error(`receipt read failed (${part}):`, e.message); }
        } else {
            try { map.set('*', JSON.parse(fs.readFileSync(part, 'utf8'))); }
            catch (e) { console.error(`receipt read failed (${part}):`, e.message); }
        }
    }
    return map;
}

// ── scoring primitive ───────────────────────────────────────────────────────
function scoreOne(quantity, methodology, source_tier, pred, truth, units, note) {
    const row = { quantity, methodology, source_tier, units, predicted: pred ?? null, truth: truth ?? null, note: note ?? null };
    if (pred == null) { row.verdict = 'ABSTAIN'; return row; }
    if (truth == null) { row.verdict = 'NOT_MEASURED'; return row; }
    const signed = pred - truth;
    row.signed_error = signed;
    row.abs_error = Math.abs(signed);
    row.pct_error = truth !== 0 ? (signed / truth) * 100 : null;
    row.verdict = 'SCORED';
    return row;
}

// ── main ────────────────────────────────────────────────────────────────────
const census = loadCensus(CENSUS);
const truthIdx = loadTruth(TRUTH);
const receipts = loadReceipts(RECEIPT_ARG);

const report = { generated: new Date().toISOString(), census: CENSUS, truth: TRUTH, receipt: RECEIPT_ARG, frames: [] };

for (const row of census) {
    const t = truthFor(truthIdx, row);
    const wcs = t?.wcs ?? {};
    const trueScale = finitePos(wcs.scale_arcsec_px);

    // Pitch used for FL scoring: prefer explicit truth pitch, else the census's
    // MEASURED sensor-DB pitch (honest — never the 4.3 assumption).
    const dbPitch = finitePos(
        (row.methodologies ?? []).find((m) => m.methodology === 'SENSOR_DB_findSensorByCamera')?.value
    );
    const truthPitch = finitePos(t?.pitch_um) ?? dbPitch;
    const pitchProvenance = finitePos(t?.pitch_um) ? 'truth.pitch_um' : (dbPitch ? 'census SENSOR_DB (measured)' : 'none');

    // The honest derived-FL from the true scale (the FL methodologies' truth).
    const trueFL = recoverFL(trueScale, truthPitch);

    const scored = [];

    // ── pixel_scale_arcsec_px methodologies ──
    for (const m of (row.methodologies ?? []).filter((x) => x.quantity === 'pixel_scale_arcsec_px')) {
        scored.push(scoreOne('pixel_scale_arcsec_px', m.methodology, m.source_tier, finitePos(m.value), trueScale, 'arcsec/px',
            m.note));
    }

    // ── focal_length_mm methodologies (truth = derived-FL-from-true-scale) ──
    for (const m of (row.methodologies ?? []).filter((x) => x.quantity === 'focal_length_mm')) {
        scored.push(scoreOne('focal_length_mm', m.methodology, m.source_tier, finitePos(m.value), trueFL, 'mm',
            `truth = 206.265×${truthPitch ?? '?'}µm/${trueScale ?? '?'} (${pitchProvenance})`));
    }

    // ── pixel_pitch_um methodologies (only scorable when truth carries pitch) ──
    for (const m of (row.methodologies ?? []).filter((x) => x.quantity === 'pixel_pitch_um')) {
        scored.push(scoreOne('pixel_pitch_um', m.methodology, m.source_tier, finitePos(m.value),
            finitePos(t?.pitch_um), 'um', finitePos(t?.pitch_um) ? null : 'truth pitch not supplied'));
    }

    // ── reference values (not scored) ──
    const refs = {
        derived_FL_from_true_scale_mm: trueFL,
        derived_FL_pitch_um: truthPitch,
        derived_FL_pitch_provenance: pitchProvenance,
        true_scale_arcsec_px: trueScale,
        true_ra_hours: wcs.ra_hours ?? null,
        true_dec_deg: wcs.dec_deg ?? null,
        true_rotation_deg: wcs.rotation_deg ?? null,
        true_parity: wcs.parity ?? null,
    };

    // ── POST-SOLVE receipt methodologies (optional) ──
    const receipt = receipts.get(String(row.base).toLowerCase()) ?? receipts.get(stripExt(row.frame).toLowerCase()) ?? receipts.get('*');
    if (receipt) {
        const sol = receipt.solution ?? receipt.receipt?.solution ?? {};
        const rScale = finitePos(sol.pixel_scale);
        scored.push(scoreOne('pixel_scale_arcsec_px', 'POSTSOLVE_RECEIPT_scale', 'POSTSOLVE_MEASURED', rScale, trueScale, 'arcsec/px',
            'receipt.solution.pixel_scale — the sky-confirmed measured scale'));
        const rFL = recoverFL(rScale, truthPitch);
        scored.push(scoreOne('focal_length_mm', 'POSTSOLVE_RECOVERED_FL', 'POSTSOLVE_MEASURED', rFL, trueFL, 'mm',
            `recoverFocalLengthFromScale(receipt scale, ${truthPitch ?? '?'}µm)`));
        if (sol.rotation_deg != null || sol.rotation != null) {
            scored.push(scoreOne('rotation_deg', 'POSTSOLVE_RECEIPT_rotation', 'POSTSOLVE_MEASURED',
                sol.rotation_deg ?? sol.rotation, finitePos(wcs.rotation_deg) ?? wcs.rotation_deg ?? null, 'deg',
                'rotation vs oracle (sign convention not asserted by repo — inspect before trusting sign)'));
        }
        if (sol.parity != null && wcs.parity != null) {
            scored.push({ quantity: 'parity', methodology: 'POSTSOLVE_RECEIPT_parity', source_tier: 'POSTSOLVE_MEASURED',
                predicted: sol.parity, truth: wcs.parity, verdict: sol.parity === wcs.parity ? 'MATCH' : 'MISMATCH',
                note: 'y-down image space; +1 = mirrored sky' });
        }
    }

    report.frames.push({
        frame: row.frame, base: row.base, format: row.format,
        truth_matched: !!t, truth_source: t?.source ?? (t ? 'oracle' : null),
        references: refs, scored,
    });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

// ── human-readable table ────────────────────────────────────────────────────
const fmt = (x, d = 4) => (x == null ? '—' : (typeof x === 'number' ? x.toFixed(d) : String(x)));
for (const f of report.frames) {
    console.log(`\n══ ${f.frame} (${f.format}) truth=${f.truth_matched ? (f.truth_source ?? 'yes') : 'NO-MATCH'} ══`);
    console.log(`   true scale=${fmt(f.references.true_scale_arcsec_px)} "/px · derived FL=${fmt(f.references.derived_FL_from_true_scale_mm, 2)}mm (pitch ${fmt(f.references.derived_FL_pitch_um, 3)}µm via ${f.references.derived_FL_pitch_provenance})`);
    const byQ = {};
    for (const s of f.scored) (byQ[s.quantity] ??= []).push(s);
    for (const q of Object.keys(byQ)) {
        console.log(`   ┌─ ${q}`);
        for (const s of byQ[q]) {
            const err = s.verdict === 'SCORED'
                ? `Δ=${fmt(s.signed_error)} |Δ|=${fmt(s.abs_error)} ${s.pct_error != null ? '(' + fmt(s.pct_error, 2) + '%)' : ''}`
                : s.verdict;
            console.log(`   │  ${s.methodology.padEnd(30)} pred=${String(fmt(s.predicted)).padStart(12)}  ${err}`);
        }
    }
}
console.log(`\n[hint_vs_truth] report → ${OUT}`);
