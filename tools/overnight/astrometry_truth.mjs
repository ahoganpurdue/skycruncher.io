// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT PIPELINE — astrometry.net TRUTH adapter (the install-gated oracle)
// (design: docs/OVERNIGHT_PIPELINE.md · "astrometry.net — the TRUTH ingestion step")
// ═══════════════════════════════════════════════════════════════════════════
//
// Shells out to an EXTERNAL `solve-field` (astrometry.net), parses its `.wcs`
// product, and feeds it through the CANONICAL truth adapter
// (tools/validation/truth/schema.ts `fromAstrometryNetWcs`) to produce a
// `source: 'astrometry_net'` TruthLabel — an INDEPENDENT external oracle that
// breaks the self-label circularity for graduation.
//
// WHY a `.mjs` that imports `.ts`: Node ≥ 22.18 strips types natively, so this
// reuses the canonical adapter + the canonical FITS header reader
// (tools/stack/fits_io.mjs `readFitsHeaderFd`) rather than re-implementing them
// (LAW 4 — no code in two places). `openFits` can NOT read a solve-field `.wcs`
// (it is a header-only FITS, NAXIS=0, no data unit); `readFitsHeaderFd` can.
//
// EXTERNAL BY CONTRACT: the solve-field binary and the multi-GB index files live
// OUTSIDE this repo. Everything here references them via CONFIGURABLE paths
// (env vars, or a gitignored tools/overnight/astrometry.local.json) — NEVER a
// hardcoded in-project path. Nothing this tool needs is committed except itself.
//
// CONFIG (env wins over the local json; both optional):
//   ASTROMETRY_SOLVE_FIELD   path/command to solve-field         (default 'solve-field' on PATH)
//   ASTROMETRY_WSL_DISTRO    if set (e.g. 'Ubuntu-24.04'), invoke via
//                            `wsl -d <distro> -e solve-field …` and translate
//                            Windows paths (K:\a\b) → /mnt/k/a/b automatically
//   ASTROMETRY_INDEX_DIR     external index directory (for --check-install listing;
//                            solve-field itself reads its own backend .cfg)
//   ASTROMETRY_BACKEND_CONFIG  optional astrometry backend .cfg passed as --config
//                            (a WSL-side path when ASTROMETRY_WSL_DISTRO is set)
//   ASTROMETRY_BACKEND_CONFIG_DEEP  optional 2-PASS deep cfg (LITE+HEAVY). When set,
//                            a pass-1 no-solve escalates to a second solve with this
//                            config; unset ⇒ single-pass (byte-identical behaviour).
//   ASTROMETRY_BACKEND_CONFIG_NARROW optional narrow (5200-only) cfg. Only used by
//                            --check-install (canary-solved against a small/narrow
//                            reference frame). Unset ⇒ that canary is SKIPPED.
//
// --check-install IS A REAL SOLVE (not a file count). Precondition-audit finding #1:
// the old --check-install just COUNTED *.fits under the index dir and reported GREEN
// on any nonzero count — a count is NOT an integrity check (LAW 3). That false-green
// bit twice: a full-size-but-interiorly-corrupt index (the engine core-dumps reading
// it, yet the file is present and passes any size sanity) and a transient oracle
// outage. --check-install now CANARY-SOLVES a known-sky reference through EACH
// configured backend cfg and asserts the recovered centre lands within tolerance of
// the known centre. --check-install --fast keeps the cheap presence+size probe, but
// it is explicitly labelled "presence check only, NOT integrity".
//
// USAGE:
//   node tools/overnight/astrometry_truth.mjs <frame> [--frame-id id] [--out labels.json]
//        [--scale-units arcsecperpix|degwidth] [--scale-low N] [--scale-high N]
//        [--pixel-scale P] [--scale-tol T]   # bounded scale PRIOR (band = P·[1∓T], default T=0.25)
//        [--downsample N] [--cpulimit S] [--cross-check] [--keep] [--json]
//   SCALE HINT (optional, ethos-clean): a known pixel scale P (arcsec/px, e.g. from the
//   corpus manifest) is expanded into a [P·(1−T), P·(1+T)] band and passed to solve-field
//   so its blind search skips the wrong scales. It ACCELERATES the search only — solve-field's
//   own quad-hash verification stays the sole arbiter, so a hint can never fabricate a solve.
//   An explicit --scale-low/--scale-high band takes precedence; no hint ⇒ a BLIND (byte-
//   identical) solve. The report JSON records `scale_hint: { used, source, scale_low/high, … }`.
//   node tools/overnight/astrometry_truth.mjs --self-test      # OFFLINE parse+adapt+compare round-trip
//   node tools/overnight/astrometry_truth.mjs --check-install [--json]        # CANARY-SOLVE every cfg
//   node tools/overnight/astrometry_truth.mjs --check-install --fast [--json] # presence+size probe only
//
// EXIT: 0 = solved (+ agreed, if --cross-check) / self-test PASS / install CANARY GREEN.
//       2 = did not solve.  3 = cross-check DISAGREES.
//       4 = install NOT healthy (solve-field absent, a canary FAILED, or nothing verifiable). 1 = usage/error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readFitsHeaderFd } from '../stack/fits_io.mjs';
import { fromAstrometryNetWcs } from '../validation/truth/schema.ts';
import { compareToTruth } from '../validation/truth/compare.ts';
import { resolveTruth } from '../validation/truth/loader.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── config resolution (external paths only) ─────────────────────────────────
function resolveConfig() {
  let fileCfg = {};
  const local = path.join(HERE, 'astrometry.local.json');
  if (fs.existsSync(local)) {
    try { fileCfg = JSON.parse(fs.readFileSync(local, 'utf8')); }
    catch (e) { console.warn(`[astrometry] ignoring unparseable ${local}: ${e.message}`); }
  }
  const pick = (env, key) => process.env[env] ?? fileCfg[key];
  return {
    solveField: pick('ASTROMETRY_SOLVE_FIELD', 'solveField') ?? 'solve-field',
    wslDistro: pick('ASTROMETRY_WSL_DISTRO', 'wslDistro') ?? null,
    indexDir: pick('ASTROMETRY_INDEX_DIR', 'indexDir') ?? null,
    backendConfig: pick('ASTROMETRY_BACKEND_CONFIG', 'backendConfig') ?? null,
    // 2-PASS: optional deep (LITE+HEAVY) backend cfg tried ONLY on a pass-1 miss.
    backendConfigDeep: pick('ASTROMETRY_BACKEND_CONFIG_DEEP', 'backendConfigDeep') ?? null,
    // NARROW (5200-only) backend cfg — canary-solved against a narrow reference by
    // --check-install; not used by the normal solve path.
    backendConfigNarrow: pick('ASTROMETRY_BACKEND_CONFIG_NARROW', 'backendConfigNarrow') ?? null,
  };
}

// ── scale-hint knob (a BOUNDED search PRIOR, never a truth fabricator) ───────
// A KNOWN pixel scale (from the corpus manifest) is expanded into a [low, high]
// arcsec/px band so solve-field's blind search skips the wrong scales instead of
// grinding every scale to the cpulimit. ETHOS: a scale hint only ACCELERATES the
// search — solve-field's own quad-hash verification stays the SOLE arbiter, so a
// wrong or absent hint can only fail/slow the search, NEVER manufacture a solve
// (same principle as "hints seed the search, they never corrupt a verified
// answer"). No usable pixel scale ⇒ null ⇒ caller falls back to a BLIND solve
// (byte-identical to the pre-hint path).
const SCALE_HINT_DEFAULT_TOL = 0.25;
export function scaleHintBand(pixelScale, tol = SCALE_HINT_DEFAULT_TOL) {
  const ps = Number(pixelScale);
  if (!Number.isFinite(ps) || ps <= 0) return null;
  let t = Number(tol);
  if (!Number.isFinite(t) || t < 0) t = SCALE_HINT_DEFAULT_TOL;
  return { units: 'arcsecperpix', low: ps * (1 - t), high: ps * (1 + t), pixel_scale: ps, tol: t };
}

/** Translate a Windows path (K:\a\b c) to a WSL /mnt path (/mnt/k/a/b c). Pass POSIX through. */
function toWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/'); // already POSIX-ish
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** Build the argv for solve-field (paths pre-translated for the target OS). */
function buildSolveArgv(cfg, opts) {
  const xlat = cfg.wslDistro ? toWslPath : (x) => x;
  const argv = [
    xlat(opts.frameAbs),
    '--overwrite',
    '--no-plots',
    '--dir', xlat(opts.workDir),
    '--wcs', xlat(opts.wcsOut),
    '--new-fits', 'none',
    '--corr', 'none', '--rdls', 'none', '--match', 'none', '--index-xyls', 'none',
    '--downsample', String(opts.downsample ?? 2),
    '--cpulimit', String(opts.cpulimit ?? 300),
  ];
  if (cfg.backendConfig) argv.push('--config', cfg.backendConfig);
  if (opts.scaleLow != null && opts.scaleHigh != null) {
    argv.push('--scale-units', opts.scaleUnits ?? 'arcsecperpix',
              '--scale-low', String(opts.scaleLow), '--scale-high', String(opts.scaleHigh));
  }
  // full command: native → [solve-field, …argv]; wsl → [wsl,-d,distro,-e,solve-field,…argv]
  if (cfg.wslDistro) return { cmd: 'wsl', args: ['-d', cfg.wslDistro, '-e', cfg.solveField, ...argv] };
  return { cmd: cfg.solveField, args: argv };
}

// ── FITS .wcs parsing (reuse canonical header reader) ───────────────────────
function num(cards, key) {
  const v = cards[key];
  if (v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Read a solve-field `.wcs` header → { crval1_deg, crval2_deg, cd:[…] }. Throws if unusable. */
export function parseWcsFile(wcsPath) {
  const fd = fs.openSync(wcsPath, 'r');
  let cards;
  try { ({ cards } = readFitsHeaderFd(fd)); }
  finally { fs.closeSync(fd); }
  const crval1 = num(cards, 'CRVAL1');
  const crval2 = num(cards, 'CRVAL2');
  if (crval1 == null || crval2 == null) throw new Error('.wcs missing CRVAL1/CRVAL2');
  let cd11 = num(cards, 'CD1_1'), cd12 = num(cards, 'CD1_2');
  let cd21 = num(cards, 'CD2_1'), cd22 = num(cards, 'CD2_2');
  if ([cd11, cd12, cd21, cd22].some((v) => v == null)) {
    // CDELT + CROTA2 fallback (rare from solve-field, but handle honestly).
    const cdelt1 = num(cards, 'CDELT1'), cdelt2 = num(cards, 'CDELT2');
    const crota2 = num(cards, 'CROTA2') ?? 0;
    if (cdelt1 == null || cdelt2 == null) throw new Error('.wcs has neither CD matrix nor CDELT1/2');
    const r = (crota2 * Math.PI) / 180;
    cd11 = cdelt1 * Math.cos(r); cd12 = -cdelt2 * Math.sin(r);
    cd21 = cdelt1 * Math.sin(r); cd22 = cdelt2 * Math.cos(r);
  }
  return { crval1_deg: crval1, crval2_deg: crval2, cd: [cd11, cd12, cd21, cd22] };
}

// ── the solve → TruthLabel path ─────────────────────────────────────────────
function runSolveField(cfg, opts) {
  const { cmd, args } = buildSolveArgv(cfg, opts);
  const started = Date.now();
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: (opts.cpulimit ?? 300) * 1000 + 60000 });
  const elapsed_s = (Date.now() - started) / 1000;
  // ENOENT (native binary missing) OR the WSL relay's `execvpe(...) failed`
  // (which exits 0) both mean the binary is ABSENT — not a failed solve.
  if ((res.error && res.error.code === 'ENOENT') || /execvpe\([^)]*\) failed/i.test(String(res.stderr))) {
    return { ok: false, reason: 'SOLVE_FIELD_NOT_FOUND', cmd, elapsed_s, stderr: String(res.error?.message ?? res.stderr) };
  }
  const solved = fs.existsSync(opts.wcsOut);
  return { ok: solved, reason: solved ? 'SOLVED' : 'NO_SOLVE', cmd, args,
           code: res.status, elapsed_s, stdout: res.stdout, stderr: res.stderr };
}

function labelFromWcs(wcsPath, frameId, extraNote) {
  const wcs = parseWcsFile(wcsPath);
  return fromAstrometryNetWcs(wcs, frameId, {
    provenance_note: `astrometry.net solve-field .wcs (CD matrix)${extraNote ? ` — ${extraNote}` : ''}`,
    generated_at: new Date().toISOString(),
  });
}

// ── OFFLINE self-test: synthesize a .wcs at a KNOWN answer, round-trip it ────
// Validates the FULL wiring (FITS-card parse → CD→scale/rotation/parity → deg→hours
// → tolerance compare) WITHOUT needing solve-field or an index installed. Uses the
// bundled CR2 truth (RA 17.5858h, 63.211"/px, rot 155.65, parity 1) as the anchor.
function writeSyntheticWcs(outPath, { crval1_deg, crval2_deg, cd }) {
  const card = (k, v) => (`${k.padEnd(8)}= ${String(v).padStart(20)}`).slice(0, 80).padEnd(80);
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', 8), card('NAXIS', 0),
    card('WCSAXES', 2), (`CTYPE1  = 'RA---TAN'`).padEnd(80), (`CTYPE2  = 'DEC--TAN'`).padEnd(80),
    card('CRPIX1', 2592.5), card('CRPIX2', 1728.5),
    card('CRVAL1', crval1_deg.toExponential(15).toUpperCase()),
    card('CRVAL2', crval2_deg.toExponential(15).toUpperCase()),
    card('CD1_1', cd[0].toExponential(15).toUpperCase()),
    card('CD1_2', cd[1].toExponential(15).toUpperCase()),
    card('CD2_1', cd[2].toExponential(15).toUpperCase()),
    card('CD2_2', cd[3].toExponential(15).toUpperCase()),
    'END'.padEnd(80),
  ];
  let buf = cards.join('');
  buf = buf.padEnd(Math.ceil(buf.length / 2880) * 2880);
  fs.writeFileSync(outPath, Buffer.from(buf, 'latin1'));
}

async function selfTest() {
  // Reconstruct a CD matrix that DECODES to the bundled truth, then confirm the
  // canonical adapter recovers it and grades it TRUE_POSITIVE against BUNDLED_KNOWN.
  const truthScaleArcsec = 63.211, truthRotDeg = 155.65, raHours = 17.5858, decDeg = -33.83;
  const s = truthScaleArcsec / 3600;           // deg/px
  const th = (truthRotDeg * Math.PI) / 180;
  // det = -s²  → parity 1 (det<0); atan2(cd21,cd11)=θ → rotation θ; sqrt|det|·3600 = scale.
  const cd = [s * Math.cos(th), s * Math.sin(th), s * Math.sin(th), -s * Math.cos(th)];
  const wcsPath = path.join(os.tmpdir(), `astrometry_selftest_${process.pid}.wcs`);
  writeSyntheticWcs(wcsPath, { crval1_deg: raHours * 15, crval2_deg: decDeg, cd });

  let pass = true; const checks = [];
  try {
    const label = labelFromWcs(wcsPath, 'sample_observation', 'SELF-TEST synthetic');
    const rec = (name, ok, got, want) => { checks.push({ name, ok, got, want }); if (!ok) pass = false; };
    rec('source=astrometry_net', label.source === 'astrometry_net', label.source, 'astrometry_net');
    rec('ra_hours≈17.5858', Math.abs(label.ra_hours - raHours) < 1e-6, label.ra_hours, raHours);
    rec('dec≈-33.83', Math.abs(label.dec_degrees - decDeg) < 1e-6, label.dec_degrees, decDeg);
    rec('scale≈63.211"/px', Math.abs(label.pixel_scale_arcsec - truthScaleArcsec) < 1e-3, label.pixel_scale_arcsec, truthScaleArcsec);
    rec('rotation≈155.65°', Math.abs(label.rotation_deg - truthRotDeg) < 1e-3, label.rotation_deg, truthRotDeg);
    rec('parity=1', label.parity === 1, label.parity, 1);
    // grade the recovered label against the pinned bundled truth via the REAL comparator
    const truth = await resolveTruth('sample_observation');
    const cmp = compareToTruth(
      { ra_hours: label.ra_hours, dec_degrees: label.dec_degrees,
        pixel_scale_arcsec: label.pixel_scale_arcsec, rotation_deg: label.rotation_deg, parity: label.parity },
      truth,
    );
    rec('compareToTruth=TRUE_POSITIVE', cmp.verdict === 'TRUE_POSITIVE', cmp.verdict, 'TRUE_POSITIVE');
  } finally {
    try { fs.unlinkSync(wcsPath); } catch { /* best-effort */ }
  }
  console.log('── astrometry_truth self-test (offline parse+adapt+compare round-trip) ──');
  for (const c of checks) {
    const g = typeof c.got === 'number' ? c.got.toFixed(6) : String(c.got);
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(28)} got=${g}`);
  }
  console.log(pass ? 'SELF-TEST: PASS (wiring is ready; end-to-end solve gated on the external install)'
                   : 'SELF-TEST: FAIL');
  return pass;
}

// ── shared: is the solve-field BINARY reachable? (honest through the WSL relay) ──
function solveFieldReachable(cfg) {
  const base = cfg.wslDistro ? ['wsl', ['-d', cfg.wslDistro, '-e', cfg.solveField, '--help']]
                             : [cfg.solveField, ['--help']];
  const res = spawnSync(base[0], base[1], { encoding: 'utf8', timeout: 30000 });
  // WSL relay quirk: `wsl -e <missing-binary>` still EXITS 0 and echoes the
  // command name in its `execvpe(...) failed` error, so neither res.status===0
  // nor a bare /solve-field/ match can be trusted through WSL — detect the
  // not-found signature and treat it as ABSENT (honest-or-absent: no false GREEN).
  const out = String(res.stdout) + String(res.stderr);
  const notFound = (res.error && res.error.code === 'ENOENT') ||
                   /execvpe\([^)]*\) failed|command not found/i.test(out);
  return { present: !notFound && (res.status === 0 || /solve-field/i.test(out)), errCode: res.error?.code ?? null };
}

/** Does a backend .cfg file exist? (WSL path → `test -f`; native → fs.existsSync.) */
function cfgFileExists(cfg, cfgPath) {
  if (!cfgPath) return false;
  if (cfg.wslDistro) {
    const r = spawnSync('wsl', ['-d', cfg.wslDistro, '-e', 'test', '-f', cfgPath], { timeout: 15000 });
    return r.status === 0;
  }
  return fs.existsSync(cfgPath);
}

/** Great-circle separation (deg) between two sky points given in DEGREES. */
function angularSepDeg(ra1, dec1, ra2, dec2) {
  const d = Math.PI / 180;
  const cs = Math.sin(dec1 * d) * Math.sin(dec2 * d) +
             Math.cos(dec1 * d) * Math.cos(dec2 * d) * Math.cos((ra1 - ra2) * d);
  return Math.acos(Math.min(1, Math.max(-1, cs))) / d;
}

// ── canary reference frames (bundled; known centres are the true field centres) ─
const REPO_ROOT = path.join(HERE, '..', '..');
const CANARY_REFS = {
  wide: {
    name: 'M66 (wide 2.2×3.9°)',
    frameAbs: path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit'),
    knownRaDeg: 170.120, knownDecDeg: 13.049,
    scaleLow: 3.0, scaleHigh: 4.5, scaleUnits: 'arcsecperpix', downsample: 2, cpulimit: 60, tolDeg: 1.0,
  },
  narrow: {
    name: 'IC443 (narrow 2.1×1.4°)',
    frameAbs: path.join(REPO_ROOT, 'Sample Files', 'rotating', 'ic443_13h_stacked.fit'),
    knownRaDeg: 94.518, knownDecDeg: 22.662,
    scaleLow: 1.2, scaleHigh: 4.5, scaleUnits: 'arcsecperpix', downsample: 2, cpulimit: 300, tolDeg: 1.0,
  },
};

/** Resolve the narrow (5200-only) cfg: explicit config, else auto-derived sibling. */
function resolveNarrowCfg(cfg) {
  if (cfg.backendConfigNarrow) return { path: cfg.backendConfigNarrow, auto: false };
  if (!cfg.backendConfig) return null;
  const join = cfg.wslDistro ? path.posix.join : path.join;
  const dn = cfg.wslDistro ? path.posix.dirname(cfg.backendConfig) : path.dirname(cfg.backendConfig);
  return { path: join(dn, 'astrometry_lite5200_only.cfg'), auto: true };
}

function tailLines(...blobs) {
  const raw = blobs.map((b) => String(b ?? '')).join('\n').split('\n').map((s) => s.trimEnd()).filter(Boolean);
  // Collapse consecutive duplicates — a corrupt index makes astrometry-engine spam the
  // SAME "Skipping un-parseable header line" hundreds of times; collapsing lets the
  // crash summary (engine failed / return value 134 = SIGABRT) survive into the tail.
  const collapsed = [];
  for (const ln of raw) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.text === ln) last.n++;
    else collapsed.push({ text: ln, n: 1 });
  }
  return collapsed.map((c) => (c.n > 1 ? `${c.text}  (×${c.n})` : c.text)).slice(-8).join('\n');
}

// ── --check-install (DEFAULT): CANARY-SOLVE every configured backend cfg ─────
// Precondition-audit finding #1. A real solve of a known-sky reference through each
// backend is the ONLY honest integrity check: it catches an interiorly-corrupt index
// (the engine core-dumps reading it, yet the file is present + full-size) and a
// transient oracle outage — both of which the old file-count reported GREEN.
async function checkInstallCanary(cfg, { json = false, keep = false } = {}) {
  const reach = solveFieldReachable(cfg);
  const narrow = resolveNarrowCfg(cfg);
  const matrix = [
    { key: 'lite   (pass-1 / backendConfig)', cfgPath: cfg.backendConfig, explicit: cfg.backendConfig != null, ref: CANARY_REFS.wide },
    { key: 'heavy  (pass-2 / backendConfigDeep)', cfgPath: cfg.backendConfigDeep, explicit: cfg.backendConfigDeep != null, ref: CANARY_REFS.wide },
    { key: 'narrow (5200-only)', cfgPath: narrow?.path ?? null, explicit: narrow ? !narrow.auto : false, ref: CANARY_REFS.narrow },
  ];

  if (!json) {
    console.log('── astrometry.net install CANARY (real solves — the honest integrity check) ──');
    console.log(`  solve-field : ${cfg.wslDistro ? `wsl -d ${cfg.wslDistro} -e ` : ''}${cfg.solveField}  → ${reach.present ? 'REACHABLE' : 'NOT REACHABLE'}${reach.errCode ? ` (${reach.errCode})` : ''}`);
  }
  const results = [];
  let binaryMissing = false;
  if (reach.present) {
    for (const m of matrix) {
      // configured?
      if (!m.cfgPath) { results.push({ cfg: m.key, verdict: 'SKIP', reason: 'not configured' }); continue; }
      if (!cfgFileExists(cfg, m.cfgPath)) {
        // explicit-but-absent = broken; auto-derived-and-absent = simply nothing to test
        results.push(m.explicit
          ? { cfg: m.key, verdict: 'FAIL', reason: `CFG-ABSENT: ${m.cfgPath}`, cfgPath: m.cfgPath }
          : { cfg: m.key, verdict: 'SKIP', reason: `no narrow cfg (auto sibling absent: ${m.cfgPath})` });
        continue;
      }
      if (!fs.existsSync(m.ref.frameAbs)) {
        results.push({ cfg: m.key, verdict: 'SKIP', reason: `reference frame absent: ${m.ref.name}`, cfgPath: m.cfgPath });
        continue;
      }
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrometry_canary_'));
      const wcsOut = path.join(workDir, 'solve.wcs');
      const solve = runSolveField({ ...cfg, backendConfig: m.cfgPath }, {
        frameAbs: m.ref.frameAbs, workDir, wcsOut, frameId: 'canary',
        scaleLow: m.ref.scaleLow, scaleHigh: m.ref.scaleHigh, scaleUnits: m.ref.scaleUnits,
        downsample: m.ref.downsample, cpulimit: m.ref.cpulimit,
      });
      if (solve.reason === 'SOLVE_FIELD_NOT_FOUND') { binaryMissing = true; if (!keep) fs.rmSync(workDir, { recursive: true, force: true }); break; }
      let r;
      if (!solve.ok) {
        // stdout first, stderr last: solve-field's error summary (engine failed / return
        // value 134 = SIGABRT from a corrupt-index stack-smash) lives on stderr — keep it in the tail.
        r = { cfg: m.key, verdict: 'FAIL', reason: 'NO_SOLVE', ref: m.ref.name, cfgPath: m.cfgPath,
              elapsed_s: solve.elapsed_s, solve_field_output_tail: tailLines(solve.stdout, solve.stderr) };
      } else {
        let center = null, sep = null, scale = null;
        try {
          const wcs = parseWcsFile(wcsOut);
          center = { ra_deg: wcs.crval1_deg, dec_deg: wcs.crval2_deg };
          sep = angularSepDeg(wcs.crval1_deg, wcs.crval2_deg, m.ref.knownRaDeg, m.ref.knownDecDeg);
          const det = wcs.cd[0] * wcs.cd[3] - wcs.cd[1] * wcs.cd[2];
          scale = Math.sqrt(Math.abs(det)) * 3600;
        } catch (e) { sep = Infinity; center = { parse_error: String(e?.message ?? e) }; }
        const within = sep <= m.ref.tolDeg;
        r = { cfg: m.key, verdict: within ? 'PASS' : 'FAIL', ref: m.ref.name, cfgPath: m.cfgPath,
              elapsed_s: solve.elapsed_s, center, center_sep_deg: sep, tol_deg: m.ref.tolDeg,
              scale_arcsec_px: scale };
        if (!within) r.reason = Number.isFinite(sep) ? `centre off by ${sep.toFixed(3)}° (> ${m.ref.tolDeg}° tol)` : 'unparseable .wcs';
      }
      results.push(r);
      if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  const anyPass = results.some((r) => r.verdict === 'PASS');
  const anyFail = results.some((r) => r.verdict === 'FAIL');
  // GREEN only when at least one cfg actually solved a known reference and none failed;
  // a binary miss, any FAIL, or nothing verifiable ⇒ NOT healthy (no false green).
  const green = reach.present && !binaryMissing && anyPass && !anyFail;

  if (json) {
    console.log(JSON.stringify({ reachable: reach.present, binary_missing: binaryMissing, results, green }, null, 2));
  } else {
    for (const r of results) {
      const head = `  [${r.verdict.padEnd(4)}] ${r.cfg.padEnd(34)}`;
      if (r.verdict === 'PASS') {
        console.log(`${head} ${r.ref} — Δcentre=${r.center_sep_deg.toFixed(3)}° (≤${r.tol_deg}°), scale=${r.scale_arcsec_px?.toFixed(3)}"/px, ${r.elapsed_s?.toFixed(1)}s`);
      } else if (r.verdict === 'SKIP') {
        console.log(`${head} ${r.reason}`);
      } else {
        console.log(`${head} ${r.ref ?? ''} — ${r.reason}`);
        if (r.solve_field_output_tail) console.log(r.solve_field_output_tail.split('\n').map((l) => `           │ ${l}`).join('\n'));
      }
    }
    if (binaryMissing) console.log('  solve-field became NOT runnable mid-canary — aborted.');
    console.log(green
      ? 'CANARY: GREEN — at least one backend solved a known reference within tolerance, none failed.'
      : 'CANARY: NOT GREEN — install is not verifiably healthy (see FAIL/SKIP above). Overnight truth ingestion is NOT safe to trust.');
  }
  return green;
}

// ── --check-install --fast: cheap presence + size sanity (NOT an integrity check) ─
function listIndexFiles(cfg) {
  if (!cfg.indexDir) return [];
  if (cfg.wslDistro) {
    const r = spawnSync('wsl', ['-d', cfg.wslDistro, '-e', 'sh', '-c',
      `find "${cfg.indexDir}" -name '*.fits' -printf '%s\\t%p\\n' 2>/dev/null`], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    return String(r.stdout).split('\n').filter(Boolean).map((ln) => {
      const [sz, ...rest] = ln.split('\t'); return { size: Number(sz), path: rest.join('\t') };
    }).filter((f) => Number.isFinite(f.size));
  }
  if (!fs.existsSync(cfg.indexDir)) return [];
  const out = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.fits')) out.push({ size: fs.statSync(p).size, path: p });
  } };
  walk(cfg.indexDir);
  return out;
}

const FITS_BLOCK = 2880; // one FITS record; anything below this is a definite truncation
function flagTruncation(files) {
  const truncated = files.filter((f) => f.size < FITS_BLOCK);   // zero-byte / sub-block = hard fail
  // per-series (dir + index-NNNN) robust-median outlier: a file << its siblings.
  const seriesKey = (p) => {
    const dir = p.replace(/[\\/][^\\/]*$/, '');
    const m = /(index-\d+)/.exec(p.replace(/^.*[\\/]/, ''));
    return `${dir}|${m ? m[1] : 'x'}`;
  };
  const groups = new Map();
  for (const f of files) { const k = seriesKey(f.path); (groups.get(k) ?? groups.set(k, []).get(k)).push(f); }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const suspect = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;                       // need siblings to compare
    const med = median(g.map((f) => f.size));
    for (const f of g) if (f.size >= FITS_BLOCK && f.size < med / 20) suspect.push({ ...f, series_median: med });
  }
  return { truncated, suspect };
}

function checkInstallFast(cfg) {
  const reach = solveFieldReachable(cfg);
  console.log('── astrometry.net install FAST probe (presence check ONLY — NOT an integrity check) ──');
  console.log(`  solve-field cmd : ${cfg.wslDistro ? `wsl -d ${cfg.wslDistro} -e ` : ''}${cfg.solveField}`);
  console.log(`  reachable       : ${reach.present ? 'YES' : 'NO'}${reach.errCode ? ` (${reach.errCode})` : ''}`);
  console.log(`  index dir (cfg) : ${cfg.indexDir ?? '(unset — set ASTROMETRY_INDEX_DIR)'}`);
  let hardTrunc = false;
  if (cfg.indexDir) {
    const files = listIndexFiles(cfg);
    console.log(`  index files     : ${files.length}`);
    if (files.length) {
      const { truncated, suspect } = flagTruncation(files);
      hardTrunc = truncated.length > 0;
      if (truncated.length) { console.log(`  TRUNCATED (<${FITS_BLOCK}B, definite corruption):`);
        for (const f of truncated) console.log(`    ! ${f.size}B  ${f.path}`); }
      if (suspect.length) { console.log('  SUSPECT-SMALL (<series_median/20 — possible truncation, heuristic):');
        for (const f of suspect) console.log(`    ? ${f.size}B (median ${f.series_median}B)  ${f.path}`); }
      if (!truncated.length && !suspect.length) console.log('  size sanity     : no zero-byte / grossly-undersized files');
    }
  }
  console.log(`  backend .cfg    : ${cfg.backendConfig ?? '(unset — solve-field default)'}`);
  console.log(`  deep .cfg (p2)  : ${cfg.backendConfigDeep ?? '(unset — single-pass)'}`);
  console.log(`  narrow .cfg     : ${cfg.backendConfigNarrow ?? '(unset)'}`);
  console.log('  NOTE: presence/size only. A full-size but INTERIORLY-CORRUPT index (engine core-dumps');
  console.log('        reading it) passes this — only --check-install (canary solve) catches that class.');
  return reach.present && !hardTrunc;
}

// ── labels.json merge (only when --out given) ───────────────────────────────
function mergeLabel(outPath, label) {
  let doc = { schema: 'validation-truth/1', labels: [] };
  if (fs.existsSync(outPath)) {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    doc = Array.isArray(parsed) ? { schema: 'validation-truth/1', labels: parsed } : parsed;
    if (!Array.isArray(doc.labels)) doc.labels = [];
  }
  doc.labels = doc.labels.filter((l) => !(l.frame_id === label.frame_id && l.source === 'astrometry_net'));
  doc.labels.push(label);
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const flags = new Set(['self-test', 'check-install', 'fast', 'cross-check', 'keep', 'json']);
      if (flags.has(k)) a[k] = true;
      else { a[k] = argv[++i]; }
    } else a._.push(t);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cfg = resolveConfig();

  if (a['self-test']) { process.exit((await selfTest()) ? 0 : 1); }
  if (a['check-install']) {
    const ok = a.fast ? checkInstallFast(cfg)
                      : await checkInstallCanary(cfg, { json: !!a.json, keep: !!a.keep });
    process.exit(ok ? 0 : 4);
  }

  const frame = a._[0];
  if (!frame) {
    console.error('usage: node tools/overnight/astrometry_truth.mjs <frame> [--frame-id id] [--out labels.json]\n' +
                  '       [--scale-low N --scale-high N] [--cross-check] [--self-test] [--check-install]');
    process.exit(1);
  }
  const frameAbs = path.resolve(frame);
  if (!fs.existsSync(frameAbs)) { console.error(`frame not found: ${frameAbs}`); process.exit(1); }
  const frameId = a['frame-id'] ?? path.basename(frameAbs).replace(/\.[^.]+$/, '');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrometry_'));
  const wcsOut = path.join(workDir, 'solve.wcs');

  // ── SCALE HINT resolution (bounded search prior; optional, honest-absent) ────
  // Precedence: an EXPLICIT --scale-low/--scale-high band is passed verbatim (as
  // before); otherwise a --pixel-scale (± --scale-tol, default ±25%) is expanded
  // into a band. Neither present ⇒ BLIND solve (byte-identical to the old path).
  const explicitLow = a['scale-low'] != null ? Number(a['scale-low']) : null;
  const explicitHigh = a['scale-high'] != null ? Number(a['scale-high']) : null;
  const tolArg = a['scale-tol'] != null ? Number(a['scale-tol']) : SCALE_HINT_DEFAULT_TOL;
  let band = null;              // { units, low, high, pixel_scale, tol } | null
  let hintSource = 'none';
  if (explicitLow != null && explicitHigh != null) {
    band = { units: a['scale-units'] ?? 'arcsecperpix', low: explicitLow, high: explicitHigh, pixel_scale: null, tol: null };
    hintSource = 'explicit-band';
  } else if (a['pixel-scale'] != null) {
    band = scaleHintBand(a['pixel-scale'], tolArg);
    if (band) { band.units = a['scale-units'] ?? band.units; hintSource = 'pixel-scale'; }
  }
  const scaleHint = band
    ? { used: true, source: hintSource, units: band.units, scale_low: band.low, scale_high: band.high, pixel_scale: band.pixel_scale, tol: band.tol }
    : { used: false, source: hintSource };

  const solveOpts = {
    frameAbs, workDir, wcsOut, frameId,
    scaleLow: band ? band.low : null,
    scaleHigh: band ? band.high : null,
    scaleUnits: band ? band.units : a['scale-units'],
    downsample: a.downsample != null ? Number(a.downsample) : 2,
    cpulimit: a.cpulimit != null ? Number(a.cpulimit) : 300,
  };
  // ── 2-PASS SOLVE (owner design: "light first → match=great; no-match → heavy") ──
  // PASS 1 uses the LITE (fast) backend cfg. On a GENUINE no-solve (binary present
  // but no .wcs) AND a deep cfg configured, escalate to PASS 2 = the LITE+HEAVY set.
  // Deterministic + config-driven; single-pass (byte-identical) when no deep cfg.
  let solve = runSolveField(cfg, solveOpts);
  let pass = 1;
  const escalated = solve.reason === 'NO_SOLVE' && cfg.backendConfigDeep != null;
  if (escalated) {
    try { fs.rmSync(wcsOut, { force: true }); } catch { /* best-effort */ }
    solve = runSolveField({ ...cfg, backendConfig: cfg.backendConfigDeep }, solveOpts);
    pass = 2;
  }

  if (solve.reason === 'SOLVE_FIELD_NOT_FOUND') {
    console.error(`solve-field not runnable via: ${solve.cmd}\n` +
      'Set ASTROMETRY_SOLVE_FIELD (and ASTROMETRY_WSL_DISTRO for a WSL install), or install per docs/OVERNIGHT_PIPELINE.md.');
    if (!a.keep) fs.rmSync(workDir, { recursive: true, force: true });
    process.exit(4);
  }
  if (!solve.ok) {
    console.error(`NO_SOLVE (${frameId}) in ${solve.elapsed_s.toFixed(1)}s${escalated ? ' after LITE→HEAVY escalation' : ''} — solve-field produced no .wcs.\n` +
      'Likely: index files do not cover this field scale (see docs/OVERNIGHT_PIPELINE.md index scoping), or an unsupported input format.');
    if (a.json) console.log(JSON.stringify({ frame_id: frameId, solved: false, pass, escalated, elapsed_s: solve.elapsed_s, scale_hint: scaleHint }, null, 2));
    if (!a.keep) fs.rmSync(workDir, { recursive: true, force: true });
    process.exit(2);
  }

  const label = labelFromWcs(wcsOut, frameId, `${solve.elapsed_s.toFixed(1)}s`);
  let exit = 0;
  const report = { frame_id: frameId, solved: true, pass, escalated, elapsed_s: solve.elapsed_s, scale_hint: scaleHint, label };

  if (a['cross-check']) {
    const truth = await resolveTruth(frameId, { fitsPath: /\.(fits?|fit)$/i.test(frameAbs) ? frameAbs : undefined });
    const cmp = compareToTruth(
      { ra_hours: label.ra_hours, dec_degrees: label.dec_degrees,
        pixel_scale_arcsec: label.pixel_scale_arcsec, rotation_deg: label.rotation_deg, parity: label.parity },
      truth,
    );
    report.cross_check = { against: truth ? truth.source : 'NO_TRUTH', ...cmp };
    if (cmp.verdict === 'FALSE_POSITIVE') exit = 3;
  }

  if (a.out) { mergeLabel(path.resolve(a.out), label); report.written_to = path.resolve(a.out); }
  if (!a.keep) fs.rmSync(workDir, { recursive: true, force: true });

  if (a.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`SOLVED ${frameId} in ${solve.elapsed_s.toFixed(1)}s (pass ${pass}${escalated ? ', LITE→HEAVY escalated' : ''}` +
                `${scaleHint.used ? `, scale-hint [${scaleHint.scale_low.toFixed(3)}, ${scaleHint.scale_high.toFixed(3)}] ${scaleHint.units}` : ', blind'})`);
    console.log(`  RA=${label.ra_hours.toFixed(6)}h  Dec=${label.dec_degrees.toFixed(4)}°  ` +
                `scale=${label.pixel_scale_arcsec.toFixed(4)}"/px  rot=${label.rotation_deg?.toFixed(2)}°  parity=${label.parity}`);
    if (report.cross_check) {
      const c = report.cross_check;
      console.log(`  cross-check vs ${c.against}: ${c.verdict}` +
                  (c.center_sep_deg != null ? `  Δcenter=${c.center_sep_deg.toFixed(3)}°` : '') +
                  (c.scale_err_frac != null ? `  Δscale=${(c.scale_err_frac * 100).toFixed(2)}%` : '') +
                  (c.reasons?.length ? `  [${c.reasons.join('; ')}]` : ''));
    }
    if (report.written_to) console.log(`  → merged into ${report.written_to}`);
  }
  process.exit(exit);
}

// Run only when invoked directly (not when imported by a unit test for the pure
// helpers, e.g. scaleHintBand / parseWcsFile).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
}
