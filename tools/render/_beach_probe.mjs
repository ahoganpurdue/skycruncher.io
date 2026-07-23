// Diagnostic-only probe (tools/render lane, additive). Decode beach CR2 via the
// engine decode path and dump value domain + WB/black/white contract fields, so
// the as-shot render is built on MEASURED values (no invented multipliers).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEngine, terminateEngineDecodeWorkers } from '../psf/decode_engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');

function pct(arr, ps) {
  const s = Float32Array.from(arr).filter(Number.isFinite).sort();
  return ps.map(p => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))] ?? 0);
}

const t0 = Date.now();
const dec = await decodeEngine(FILE);
const { w, h, rgb16, meta, arm, rawler } = dec;
console.log(`arm=${arm} dims=${w}x${h} rgb16.len=${rgb16.length} decode_s=${((Date.now()-t0)/1000).toFixed(1)}`);

// per-channel raw-ADU stats on a stride subsample
const n = w * h;
const stride = Math.max(1, Math.floor(n / 200000));
const ch = [[], [], []];
for (let p = 0; p < n; p += stride) { const b = p*3; ch[0].push(rgb16[b]); ch[1].push(rgb16[b+1]); ch[2].push(rgb16[b+2]); }
for (let c = 0; c < 3; c++) {
  const [p01, p50, p99, p999, p9999] = pct(ch[c], [0.01, 0.5, 0.99, 0.999, 0.9999]);
  const mx = ch[c].reduce((a,b)=>Math.max(a,b),0);
  console.log(`ch${c} raw-ADU: p1=${p01} p50=${p50} p99=${p99} p99.9=${p999} p99.99=${p9999} max=${mx}`);
}
console.log('rawler payload:', JSON.stringify(rawler, null, 2));
console.log('meta keys:', Object.keys(meta || {}).sort().join(', '));
console.log('meta.wb_coeffs =', JSON.stringify(meta?.wb_coeffs));
console.log('meta.blacklevel_bayer =', JSON.stringify(meta?.blacklevel_bayer));
console.log('meta.whitelevel =', JSON.stringify(meta?.whitelevel));
console.log('meta.cfa_pattern_active =', JSON.stringify(meta?.cfa_pattern_active));
console.log('meta.crop_area =', JSON.stringify(meta?.crop_area));
console.log('meta.active_area =', JSON.stringify(meta?.active_area));
console.log('meta.model =', JSON.stringify(meta?.clean_model ?? meta?.model));
terminateEngineDecodeWorkers();
setTimeout(() => process.exit(0), 200);
