// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/thesis_lint.mjs — the mechanical adversarial grader (CSL v0)
// ═══════════════════════════════════════════════════════════════════════════
//
// The checkable half of the CSL interlocutor. "The declarative schema IS the
// gate" (docs/COMMUNITY_SCIENCE_LAB.md §interlocutor): a thesis that cannot be
// expressed as {hypothesis, equations/variables, domain/strata, FROZEN
// measurable criteria, >=1 derivative corollary, kill-clause, prior-art} cannot
// be submitted. This grader is DETERMINISTIC and ADVISORY-STRUCTURAL — it never
// judges whether the physics is RIGHT (the deterministic harness is sole
// arbiter of that); it enforces that the claim is HONEST and TESTABLE.
//
// ZERO dependencies (dep-free like the MCP server). Reads THESIS_SCHEMA_VERSION
// from thesis_schema.ts by regex (single source, never duplicated) — the same
// idiom tools/mcp/instrument_manifest.mjs uses for RECEIPT_SCHEMA_VERSION.
//
//   import { lintThesis, THESIS_SCHEMA_VERSION } from './thesis_lint.mjs';
//   const { verdict, reasons, warnings } = lintThesis(thesis);   // ACCEPT | REJECT
//
// CLI: node tools/theses/thesis_lint.mjs <thesis.json>   → prints verdict, exits
//      0 on ACCEPT, 1 on REJECT.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_TS = path.join(HERE, 'thesis_schema.ts');

/** Read the whole thesis_schema.ts once (the single source for versions). */
function readSchemaTs() {
    try { return fs.readFileSync(SCHEMA_TS, 'utf8'); } catch { return ''; }
}

/** Read THESIS_SCHEMA_VERSION from thesis_schema.ts (the single source). */
function readSchemaVersion(txt) {
    const m = txt.match(/THESIS_SCHEMA_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : 'UNRESOLVED';
}

/**
 * Read SUPPORTED_SCHEMA_VERSIONS from thesis_schema.ts (the DDIA read-compat
 * window — the reader accepts EVERY listed generation, refuses anything else).
 * Falls back to just the current version if the array can't be parsed.
 */
function readSupportedVersions(txt, current) {
    const m = txt.match(/SUPPORTED_SCHEMA_VERSIONS[^=]*=\s*\[([^\]]*)\]/);
    if (!m) return current === 'UNRESOLVED' ? [] : [current];
    const versions = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    return versions.length ? versions : (current === 'UNRESOLVED' ? [] : [current]);
}

const SCHEMA_TS_TEXT = readSchemaTs();
export const THESIS_SCHEMA_VERSION = readSchemaVersion(SCHEMA_TS_TEXT);
export const SUPPORTED_SCHEMA_VERSIONS = readSupportedVersions(SCHEMA_TS_TEXT, THESIS_SCHEMA_VERSION);

export const THESIS_STATUSES = ['PRE-REGISTERED', 'RUNNING', 'PASS', 'FAIL', 'PARTIAL'];
export const STAMP_STATUSES = ['RUNNING', 'PASS', 'FAIL', 'PARTIAL'];

// Schema 0.2.0 additive enums (mirrors thesis_schema.ts — kept in lockstep here
// because the dep-free grader cannot import the .ts type module).
export const SUBMITTER_CLASSES = ['AI-RESEARCHER', 'HUMAN', 'HYBRID-INTERLOCUTOR'];
export const TIME_BUDGET_LANES = ['inline', 'overnight'];

/** Parse a dotted semver-ish string into a numeric tuple ([major,minor,patch]). */
function parseVer(v) { return String(v).split('.').map((n) => parseInt(n, 10) || 0); }

/** true iff version `v` is >= `target` (component-wise). */
function versionGte(v, target) {
    const a = parseVer(v), b = parseVer(target);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const ai = a[i] || 0, bi = b[i] || 0;
        if (ai !== bi) return ai > bi;
    }
    return true;
}

// A criterion is MEASURABLE only if its expression carries a number and/or a
// comparator. Bare prose ("solve succeeds") is rejected — it cannot be
// mechanically checked. We look for a digit, a comparator glyph, or an
// unambiguous comparison keyword.
const HAS_NUMBER = /\d/;
const HAS_COMPARATOR = /[<>=≤≥±]|\bwithin\b|\bat least\b|\bat most\b|\bexceeds?\b|\bbelow\b|\babove\b|\bgreater\b|\bless\b|\bequals?\b|\bno (?:more|less|worse|better) than\b|\bbit-(?:exact|identical)\b|\bbyte-identical\b/i;

function isMeasurable(expr) {
    if (typeof expr !== 'string' || expr.trim().length === 0) return false;
    return HAS_NUMBER.test(expr) || HAS_COMPARATOR.test(expr);
}

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isArray(v) { return Array.isArray(v); }

/**
 * Grade a thesis object. Returns { verdict: 'ACCEPT'|'REJECT', reasons[],
 * warnings[] }. `reasons` are hard failures (REJECT); `warnings` never block.
 * Every reason is specific enough to act on (the interlocutor's honest job:
 * saying exactly what makes the claim untestable).
 */
export function lintThesis(thesis) {
    const reasons = [];
    const warnings = [];

    if (thesis === null || typeof thesis !== 'object' || Array.isArray(thesis)) {
        return { verdict: 'REJECT', reasons: ['thesis is not a JSON object'], warnings };
    }

    // ── identity / metadata ──────────────────────────────────────────────────
    if (!isNonEmptyString(thesis.id)) reasons.push('id: missing or empty (a thesis needs a stable id)');
    if (!isNonEmptyString(thesis.title)) reasons.push('title: missing or empty');
    if (!isNonEmptyString(thesis.submitter)) reasons.push('submitter: missing or empty');
    if (!isNonEmptyString(thesis.hypothesis)) reasons.push('hypothesis: missing or empty (the falsifiable claim)');
    if (!isNonEmptyString(thesis.reasoning_mechanism)) reasons.push('reasoning_mechanism: missing or empty (WHY the claim should hold)');

    // schema_version: accept any generation in the DDIA read-compat window
    // (SUPPORTED_SCHEMA_VERSIONS); refuse an unknown/future generation. A legacy
    // 0.1.0 entry stays valid forever — additive-only discipline.
    if (!isNonEmptyString(thesis.schema_version)) {
        reasons.push('schema_version: missing (declare the schema generation this thesis targets)');
    } else if (!SUPPORTED_SCHEMA_VERSIONS.includes(thesis.schema_version)) {
        if (THESIS_SCHEMA_VERSION === 'UNRESOLVED' || SUPPORTED_SCHEMA_VERSIONS.length === 0) {
            warnings.push('schema_version: could not resolve the supported schema versions to compare against');
        } else {
            reasons.push(`schema_version: "${thesis.schema_version}" is not a supported generation (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}) — unknown schema generation, cannot validate`);
        }
    }

    // ── submitter_class + time_budget (schema >= 0.2.0 REQUIRED; additive) ────
    // At 0.2.0+ both fields are MANDATORY. On a legacy 0.1.0 entry they are
    // absent-by-design (valid); if a 0.1.0 entry carries them anyway (the
    // "additive-pending" banked drafts), soft-validate — warn, never reject.
    const atV020 = isNonEmptyString(thesis.schema_version) && versionGte(thesis.schema_version, '0.2.0');
    const scPresent = thesis.submitter_class !== undefined && thesis.submitter_class !== null;
    if (atV020 && !scPresent) {
        reasons.push(`submitter_class: missing (REQUIRED at schema >= 0.2.0 — one of ${SUBMITTER_CLASSES.join('/')}; AI-RESEARCHER never pools with HUMAN, so provenance must be declared)`);
    } else if (scPresent && !SUBMITTER_CLASSES.includes(thesis.submitter_class)) {
        const msg = `submitter_class: "${thesis.submitter_class}" is not one of ${SUBMITTER_CLASSES.join('/')}`;
        if (atV020) reasons.push(msg); else warnings.push(`${msg} (additive-pending field on a legacy entry)`);
    }

    const tb = thesis.time_budget;
    const tbPresent = tb !== undefined && tb !== null;
    if (atV020 && !tbPresent) {
        reasons.push('time_budget: missing (REQUIRED at schema >= 0.2.0 — { est_wall_minutes > 0, lane: inline|overnight })');
    } else if (tbPresent) {
        const tbBad = [];
        if (typeof tb !== 'object' || Array.isArray(tb)) {
            tbBad.push('time_budget: must be an object { est_wall_minutes, lane }');
        } else {
            if (!(typeof tb.est_wall_minutes === 'number' && isFinite(tb.est_wall_minutes) && tb.est_wall_minutes > 0)) {
                tbBad.push('time_budget.est_wall_minutes: must be a number > 0 (honest wall-clock estimate)');
            }
            if (!TIME_BUDGET_LANES.includes(tb.lane)) {
                tbBad.push(`time_budget.lane: "${tb && tb.lane}" is not one of ${TIME_BUDGET_LANES.join('/')}`);
            }
        }
        if (tbBad.length) {
            if (atV020) reasons.push(...tbBad);
            else warnings.push(...tbBad.map((r) => `${r} (additive-pending field on a legacy entry)`));
        }
    }

    // status must be a legal lifecycle value (registration path enforces
    // PRE-REGISTERED separately at the MCP layer).
    if (!THESIS_STATUSES.includes(thesis.status)) {
        reasons.push(`status: "${thesis.status}" is not one of ${THESIS_STATUSES.join('/')}`);
    } else if (thesis.status !== 'PRE-REGISTERED') {
        warnings.push(`status: "${thesis.status}" — a NEW submission normally pre-registers (PRE-REGISTERED); non-PRE-REGISTERED is a backfill of an already-run thesis`);
    }

    // ── FROZEN, MEASURABLE pass criteria (the anti-p-hacking rail) ────────────
    if (!isArray(thesis.pass_criteria) || thesis.pass_criteria.length === 0) {
        reasons.push('pass_criteria: missing or empty (>= 1 frozen, measurable criterion required — this is the gate)');
    } else {
        thesis.pass_criteria.forEach((c, i) => {
            const tag = (c && isNonEmptyString(c.id)) ? c.id : `#${i}`;
            if (c === null || typeof c !== 'object') { reasons.push(`pass_criteria[${i}]: not an object`); return; }
            if (!isNonEmptyString(c.id)) reasons.push(`pass_criteria[${i}]: missing id`);
            if (!isNonEmptyString(c.description)) reasons.push(`pass_criteria[${tag}]: missing description`);
            if (c.frozen !== true) reasons.push(`pass_criteria[${tag}]: frozen !== true (criteria MUST freeze before implementation/data access)`);
            if (!isMeasurable(c.measurable)) reasons.push(`pass_criteria[${tag}]: not measurable — "measurable" carries no number or comparator (a criterion that cannot be mechanically checked is not a gate)`);
        });
    }

    // ── kill clause (mandatory falsifier) ─────────────────────────────────────
    if (!isNonEmptyString(thesis.kill_clause)) {
        reasons.push('kill_clause: missing or empty (a thesis MUST state the condition under which it FAILS — an honest FAIL is a valid CSL outcome)');
    }

    // ── derivative predictions (Bayesian consistency check) ───────────────────
    if (!isArray(thesis.derivative_predictions) || thesis.derivative_predictions.filter(isNonEmptyString).length === 0) {
        reasons.push('derivative_predictions: missing or empty (>= 1 corollary required — "for this to hold, what else must be true?")');
    }

    // ── predictions on record ─────────────────────────────────────────────────
    if (!isNonEmptyString(thesis.predictions_on_record)) {
        reasons.push('predictions_on_record: missing or empty (state the expected outcome BEFORE the run)');
    }

    // ── base rates / domain of validity / strata (Bernoulli discipline) ───────
    const brd = thesis.base_rates_domain;
    if (brd === null || typeof brd !== 'object' || Array.isArray(brd)) {
        reasons.push('base_rates_domain: missing (strata + domain_of_validity + cross_stratum_reconciliation required — base rates are explicit and stratified)');
    } else {
        if (!isArray(brd.strata) || brd.strata.filter(isNonEmptyString).length === 0) {
            reasons.push('base_rates_domain.strata: missing or empty (>= 1 stratum — a claim is evaluated WITHIN hardware/sky strata, never blind-pooled)');
        }
        if (!isNonEmptyString(brd.domain_of_validity)) {
            reasons.push('base_rates_domain.domain_of_validity: missing or empty (the physics-bounded domain where the claim holds is MANDATORY)');
        }
        if (!isNonEmptyString(brd.cross_stratum_reconciliation)) {
            // Single-stratum claims can warn rather than reject; multi-stratum MUST reconcile.
            const strataN = (isArray(brd.strata) ? brd.strata.filter(isNonEmptyString).length : 0);
            if (strataN > 1) reasons.push('base_rates_domain.cross_stratum_reconciliation: missing (a multi-stratum claim MUST model the cross-stratum variation — the functional form reveals mechanism)');
            else warnings.push('base_rates_domain.cross_stratum_reconciliation: empty (acceptable for a single-stratum claim, but state why cross-stratum does not apply)');
        }
    }

    // ── prior art (must cite, or explicitly declare CARD-ABSENT) ──────────────
    if (!isArray(thesis.prior_art) || thesis.prior_art.length === 0) {
        reasons.push('prior_art: empty (cite the relevant docs/reference/CARD_*.md or a file/URL, OR add one entry with source:"card-absent" stating explicitly that no card covers this)');
    } else {
        const bad = thesis.prior_art.filter((p) => !(p && isNonEmptyString(p.ref) && isNonEmptyString(p.claim)));
        if (bad.length) reasons.push(`prior_art: ${bad.length} citation(s) missing ref or claim`);
        const hasReal = thesis.prior_art.some((p) => p && ['file', 'card', 'url', 'card-absent'].includes(p.source) && isNonEmptyString(p.ref));
        if (!hasReal) reasons.push('prior_art: no citation has a recognized source (file|card|url|card-absent) with a ref');
    }

    // ── equations / variables (soft — warn if absent, they aid the harness) ───
    if (!isArray(thesis.equations_variables) || thesis.equations_variables.length === 0) {
        warnings.push('equations_variables: empty (a mechanism with no named quantities is hard to test deterministically)');
    } else {
        thesis.equations_variables.forEach((e, i) => {
            if (e === null || typeof e !== 'object') { warnings.push(`equations_variables[${i}]: not an object`); return; }
            if (!isNonEmptyString(e.name)) warnings.push(`equations_variables[${i}]: missing name`);
            if (!isNonEmptyString(e.units)) warnings.push(`equations_variables[${e.name || i}]: missing units (units are first-class — LAW 7 spirit)`);
            if (typeof e.frozen !== 'boolean') warnings.push(`equations_variables[${e.name || i}]: frozen should be a boolean`);
        });
    }

    // ── deviations_log must be an array (empty at submission) ──────────────────
    if (!isArray(thesis.deviations_log)) {
        reasons.push('deviations_log: must be an array (initialized empty at submission)');
    } else if (thesis.deviations_log.length > 0 && thesis.status === 'PRE-REGISTERED') {
        warnings.push('deviations_log: non-empty while status is PRE-REGISTERED (deviations are filled by the test runner, not at submission)');
    }

    // ── verdict_stamps / links shape (soft) ───────────────────────────────────
    if (!isArray(thesis.verdict_stamps)) warnings.push('verdict_stamps: should be an array (append-only)');
    if (thesis.links === null || typeof thesis.links !== 'object') {
        warnings.push('links: should be an object with arxiv/researchgate/orcid/institutions arrays');
    }

    return { verdict: reasons.length === 0 ? 'ACCEPT' : 'REJECT', reasons, warnings };
}

/**
 * BASE-RATE-INTEGRITY GUARD (CSL, schema 0.2.0): AI-RESEARCHER submissions must
 * NEVER be pooled with HUMAN submissions in any aggregate the tools compute —
 * the two populations carry different base rates, and blind-pooling them
 * corrupts the significance math (Bernoulli discipline; owner ruling
 * 2026-07-10, memory: AI never pools with human — base-rate integrity).
 *
 * No tool currently computes a cross-submitter aggregate, so this is a
 * DOCUMENTED NO-OP GUARD today: it is the standing invariant that any FUTURE
 * aggregation MUST partition by submitter_class before folding. Call it on any
 * set of theses (or folded registry entries carrying `submitter_class`) that is
 * about to be pooled into one bucket; it reports whether the bucket is pure.
 *
 * A bucket is IMPURE iff it mixes AI-RESEARCHER with any other class (HUMAN or
 * HYBRID-INTERLOCUTOR). Legacy entries with no submitter_class are treated as a
 * distinct 'LEGACY-UNCLASSED' population and also flagged if mixed with AI.
 *
 * @param {Array<{submitter_class?:string, id?:string}>} entries  the pooled set.
 * @returns {{ ok: boolean, classes: string[], violations: string[] }}
 */
export function assertSubmitterBucketPurity(entries) {
    const violations = [];
    if (!Array.isArray(entries)) {
        return { ok: false, classes: [], violations: ['not an array — cannot check bucket purity'] };
    }
    const classOf = (e) => (e && SUBMITTER_CLASSES.includes(e.submitter_class)) ? e.submitter_class : 'LEGACY-UNCLASSED';
    const present = [...new Set(entries.map(classOf))];
    const hasAI = present.includes('AI-RESEARCHER');
    const hasOther = present.some((c) => c !== 'AI-RESEARCHER');
    if (hasAI && hasOther) {
        const others = present.filter((c) => c !== 'AI-RESEARCHER');
        violations.push(`AI-RESEARCHER pooled with ${others.join('/')} — AI submissions must never share an aggregate with human/legacy submissions (base-rate integrity)`);
    }
    return { ok: violations.length === 0, classes: present, violations };
}

// ─── CLI (run directly, not when imported) ────────────────────────────────────
const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (RUN_DIRECTLY) {
    const file = process.argv[2];
    if (!file) { process.stderr.write('usage: node tools/theses/thesis_lint.mjs <thesis.json>\n'); process.exit(2); }
    let thesis;
    try { thesis = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { process.stderr.write(`could not read/parse ${file}: ${e.message}\n`); process.exit(2); }
    const res = lintThesis(thesis);
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.exit(res.verdict === 'ACCEPT' ? 0 : 1);
}
