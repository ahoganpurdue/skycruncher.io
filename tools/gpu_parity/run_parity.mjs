// GPU/CPU demosaic parity rail — measurement runner (MEASUREMENT, not a gate).
//
// Spawns its OWN vite dev server on a fresh strict port (never 3005/3199),
// curl-warms it, drives Playwright real Chrome (channel 'chrome', headless) to
// run BOTH real demosaic incumbents per fixture, then computes ULP-delta
// histograms + a decision-relevance probe on the returned Float32 buffers.
//
// Rerun:  node tools/gpu_parity/run_parity.mjs           (default port 3247)
//         GPU_PARITY_PORT=3251 node tools/gpu_parity/run_parity.mjs
//
// Writes: test_results/gpu_parity_<date>/{REPORT.md, results.json, adapter_info.json}
//
// Units under test (imported by the harness, NOT reimplemented here):
//   CPU  DemosaicEngine.demosaicBilinear  (float64 neighbor sums -> f32 store)
//   GPU  demosaic_bayer_param.wgsl via demosaicWebGPU (f32 throughout)

import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX_DIR = path.join(HERE, 'fixtures');
const PORT = parseInt(process.env.GPU_PARITY_PORT ?? '3247', 10);
if (PORT === 3005 || PORT === 3199) { console.error(`refusing reserved port ${PORT}`); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const HARNESS_URL = `${BASE}/tools/gpu_parity/harness/index.html`;
const HARNESS_TS = `${BASE}/tools/gpu_parity/harness/harness.ts`;

const DATE = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, 'test_results', `gpu_parity_${DATE}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (m) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);

// ── float32 ULP helpers ─────────────────────────────────────────────────────
// All demosaic outputs are >= 0 (Math.max(0, ...) on both paths), so the raw
// uint32 bit-pattern is monotonic in value and |u_a - u_b| is the ULP distance.
// (Near a clamp boundary one path can land on exactly 0 while the other lands on
// a tiny positive float -> uint32 distance explodes; we bucket those separately
// and ALSO report the physically meaningful absolute magnitude difference.)
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function ulpOf(a, b) {
  f32[0] = a; const ua = u32[0];
  f32[0] = b; const ub = u32[0];
  return Math.abs(ua - ub);
}

function b64ToFloat32(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function percentiles(sortedArr, ps) {
  const out = {};
  for (const p of ps) {
    if (sortedArr.length === 0) { out['p' + p] = null; continue; }
    const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
    out['p' + p] = sortedArr[idx];
  }
  return out;
}

// ── per-fixture comparison ──────────────────────────────────────────────────
function compare(cpu, gpu, width, height) {
  const nEl = width * height * 3;
  if (cpu.length !== nEl || gpu.length !== nEl) {
    throw new Error(`length mismatch: cpu=${cpu.length} gpu=${gpu.length} expected=${nEl}`);
  }
  // ULP buckets (element = one channel sample)
  const bucketEdges = [0, 1, 2, 3, 4, 8, 16, 64, 1024]; // "==0","==1","==2","==3","4-8",...,">1024"
  const mkBuckets = () => ({ '0': 0, '1': 0, '2': 0, '3': 0, '4-8': 0, '9-16': 0, '17-64': 0, '65-1024': 0, '>1024': 0 });
  const bump = (buckets, ulp) => {
    if (ulp === 0) buckets['0']++;
    else if (ulp === 1) buckets['1']++;
    else if (ulp === 2) buckets['2']++;
    else if (ulp === 3) buckets['3']++;
    else if (ulp <= 8) buckets['4-8']++;
    else if (ulp <= 16) buckets['9-16']++;
    else if (ulp <= 64) buckets['17-64']++;
    else if (ulp <= 1024) buckets['65-1024']++;
    else buckets['>1024']++;
  };

  const chNames = ['R', 'G', 'B'];
  const interior = { all: mkBuckets(), R: mkBuckets(), G: mkBuckets(), B: mkBuckets() };
  const border = { all: mkBuckets() };
  let interiorEl = 0, borderEl = 0;
  let maxUlp = 0, maxAbs = 0, maxUlpSmallRegion = 0;
  let interiorDifferEl = 0;         // absdiff > 0
  let interiorUlp1El = 0;           // ulp === 1 exactly
  let interiorPixels = 0, interiorPixelsDiffer = 0;
  let nanCount = 0;

  for (let y = 0; y < height; y++) {
    const isBorderRow = (y === 0 || y === height - 1);
    for (let x = 0; x < width; x++) {
      const isBorder = isBorderRow || x === 0 || x === width - 1;
      const base = (y * width + x) * 3;
      let pixelDiffers = false;
      for (let c = 0; c < 3; c++) {
        const a = cpu[base + c], b = gpu[base + c];
        if (Number.isNaN(a) || Number.isNaN(b)) { nanCount++; continue; }
        const ulp = ulpOf(a, b);
        const abs = Math.abs(a - b);
        if (isBorder) {
          borderEl++;
          bump(border.all, ulp);
        } else {
          interiorEl++;
          bump(interior.all, ulp);
          bump(interior[chNames[c]], ulp);
          if (abs > 0) { interiorDifferEl++; pixelDiffers = true; }
          if (ulp === 1) interiorUlp1El++;
          if (ulp > maxUlp) maxUlp = ulp;
          if (abs > maxAbs) maxAbs = abs;
          if (ulp <= 64 && ulp > maxUlpSmallRegion) maxUlpSmallRegion = ulp;
        }
      }
      if (!isBorder) { interiorPixels++; if (pixelDiffers) interiorPixelsDiffer++; }
    }
  }

  const pct = (n, d) => d > 0 ? +(100 * n / d).toFixed(4) : null;
  return {
    width, height,
    interior_elements: interiorEl,
    border_elements: borderEl,
    interior_pixels: interiorPixels,
    nan_count: nanCount,
    max_ulp: maxUlp,
    max_ulp_small_region: maxUlpSmallRegion, // excludes >64 clamp-boundary explosions
    max_abs_diff: maxAbs,
    interior_pct_differ_any: pct(interiorDifferEl, interiorEl),   // absdiff>0
    interior_pct_ulp_eq_1: pct(interiorUlp1El, interiorEl),       // the banked "1 ULP" metric
    interior_pct_pixels_differ: pct(interiorPixelsDiffer, interiorPixels),
    ulp_histogram_interior: interior,
    ulp_histogram_border: border.all,
  };
}

// ── decision-relevance probe ────────────────────────────────────────────────
// Cheap downstream-flavored stats: luminance percentiles + a star-candidate
// (local-max above shared threshold) count. Uses CPU's p99 as the SHARED
// threshold for both images so the ONLY thing that can move the candidate set
// is the ULP noise itself.
function luminance(rgb, width, height) {
  const L = new Float32Array(width * height);
  for (let i = 0, p = 0; i < rgb.length; i += 3, p++) {
    L[p] = (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
  }
  return L;
}
function starCandidates(L, width, height, thresh) {
  const set = new Set();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const v = L[p];
      if (v <= thresh) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (L[(y + dy) * width + (x + dx)] > v) { isMax = false; break; }
        }
      if (isMax) set.add(p);
    }
  }
  return set;
}
function decisionProbe(cpu, gpu, width, height) {
  const Lc = luminance(cpu, width, height);
  const Lg = luminance(gpu, width, height);
  // interior luminance sorted for percentiles
  const collect = (L) => {
    const a = [];
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) a.push(L[y * width + x]);
    a.sort((m, n) => m - n);
    return a;
  };
  const sc = collect(Lc), sg = collect(Lg);
  const pc = percentiles(sc, [50, 90, 99, 100]);
  const pg = percentiles(sg, [50, 90, 99, 100]);
  const thresh = pc.p99;                 // shared threshold from CPU
  const candC = starCandidates(Lc, width, height, thresh);
  const candG = starCandidates(Lg, width, height, thresh);
  // set diff
  let onlyC = 0, onlyG = 0;
  for (const p of candC) if (!candG.has(p)) onlyC++;
  for (const p of candG) if (!candC.has(p)) onlyG++;
  return {
    luminance_percentiles_cpu: pc,
    luminance_percentiles_gpu: pg,
    luminance_p99_abs_delta: Math.abs(pc.p99 - pg.p99),
    luminance_max_abs_delta: Math.abs(pc.p100 - pg.p100),
    star_candidate_threshold: thresh,
    star_candidates_cpu: candC.size,
    star_candidates_gpu: candG.size,
    star_candidates_only_in_cpu: onlyC,
    star_candidates_only_in_gpu: onlyG,
    star_candidate_set_identical: onlyC === 0 && onlyG === 0,
  };
}

// ── server lifecycle ────────────────────────────────────────────────────────
async function probe(url, ms = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}
async function spawnVite() {
  if (await probe(BASE)) throw new Error(`something already listening on ${PORT}; pick another GPU_PARITY_PORT`);
  log(`[server] spawning: npx vite --port ${PORT} --strictPort --host 127.0.0.1`);
  const out = fs.createWriteStream(path.join(OUT_DIR, 'vite_server.log'), { flags: 'a' });
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.pipe(out); proc.stderr.pipe(out);
  for (let i = 0; i < 90; i++) {
    if (await probe(BASE, 1000)) { log(`[server] up after ~${i + 1}s (pid ${proc.pid})`); return proc; }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`vite did not come up on :${PORT} within 90s (see vite_server.log)`);
}
function killVite(proc) {
  if (!proc) return;
  try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); log(`[server] killed vite pid ${proc.pid}`); }
  catch (e) { log(`[server] taskkill failed: ${e.message}`); }
}

// ── main ────────────────────────────────────────────────────────────────────
let viteProc = null, browser = null;
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'manifest.json'), 'utf8'));
  log(`[fixtures] ${manifest.fixtures.length} fixtures @ ${manifest.width}x${manifest.height} seed ${manifest.seed_hex}`);

  viteProc = await spawnVite();
  // curl-warm: force vite to transform the harness TS (cold optimize is slow)
  log('[warm] fetching harness html + ts to force optimize…');
  await probe(HARNESS_URL, 30000);
  await probe(HARNESS_TS, 30000);

  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`[browser:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e}`));

  log(`[page] goto ${HARNESS_URL}`);
  await page.goto(HARNESS_URL, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 120000 });
  const adapter = await page.evaluate(() => window.__adapterInfo);
  fs.writeFileSync(path.join(OUT_DIR, 'adapter_info.json'), JSON.stringify(adapter, null, 2));
  log(`[gpu] adapter.available=${adapter?.available} device=${adapter?.info?.device ?? adapter?.info?.description ?? '?'} vendor=${adapter?.info?.vendor ?? '?'} fallback=${adapter?.isFallbackAdapter}`);

  const results = { generated_utc: new Date().toISOString(), port: PORT, adapter, fixtures: [] };
  for (const fx of manifest.fixtures) {
    const buf = fs.readFileSync(path.join(FIX_DIR, fx.file));
    const raw = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    log(`[run] ${fx.name} (${raw.length} px)…`);
    const t0 = Date.now();
    const res = await page.evaluate((payload) => window.__runParity(payload), {
      raw: Array.from(raw), width: manifest.width, height: manifest.height, stride: manifest.stride,
    });
    const gpuUsed = res.gpuUsed;
    const cpu = b64ToFloat32(res.cpuB64);
    const gpu = b64ToFloat32(res.gpuB64);
    const cmp = compare(cpu, gpu, manifest.width, manifest.height);
    const dec = decisionProbe(cpu, gpu, manifest.width, manifest.height);
    log(`[run] ${fx.name}: gpuUsed=${gpuUsed} differ%=${cmp.interior_pct_differ_any} ulp1%=${cmp.interior_pct_ulp_eq_1} maxUlp(small)=${cmp.max_ulp_small_region} maxAbs=${cmp.max_abs_diff.toExponential(3)} starCandΔ=${dec.star_candidates_only_in_cpu + dec.star_candidates_only_in_gpu} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    results.fixtures.push({ name: fx.name, file: fx.file, md5: fx.md5, gpuUsed, comparison: cmp, decision_probe: dec });
  }

  results.console_tail = consoleLines.slice(-40);
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  log(`[out] results.json + adapter_info.json -> ${OUT_DIR}`);

  // Loud check: if GPU never actually ran, the whole comparison is CPU-vs-CPU.
  const anyGpu = results.fixtures.some(f => f.gpuUsed);
  if (!anyGpu) log('[WARN] gpuUsed=false for ALL fixtures — WebGPU did NOT dispatch; deltas are meaningless (CPU vs CPU). This is a FINDING.');

  fs.writeFileSync(path.join(OUT_DIR, '_ok'), 'ok');
  await browser.close(); browser = null;
  killVite(viteProc); viteProc = null;
  process.exit(0);
} catch (e) {
  log(`[FATAL] ${e && e.stack || e}`);
  try { if (browser) await browser.close(); } catch {}
  killVite(viteProc);
  process.exit(1);
}
