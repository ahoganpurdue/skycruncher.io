// ═══════════════════════════════════════════════════════════════════════════
// SEXTANT TERRAIN rung-1 — SILHOUETTE EXTRACTION (IMG_1653, the radio-towers frame)
// ═══════════════════════════════════════════════════════════════════════════
// Segment the sky/foreground boundary of the decoded preview and CLASSIFY the
// foreground into man-made towers (bright see-through lattice) vs vegetation
// (dark solid) vs terrain-ridge-like (dark solid AND ground-hugging). The DTM
// horizon knows only GROUND; towers+trees are +noise/inapplicable. This lane
// MEASURES what the frame's skyline actually is before any DTM match is claimed.
//
// Sky model: per-row median luminance (sky is >80% of pixels → row median ≈ sky
// brightness at that row, robust to the foreground). Foreground pixel =
//   DARK   : L < skyMed[y] - DARK_DROP            (trees, tower shadows)
//   BRIGHT : high local gradient AND L > skyMed[y] (illuminated lattice)
// Isolated stars (also high-gradient-bright) are removed by keeping only
// connected components above MIN_AREA. Per column: envelope = highest kept
// foreground pixel; fill = fraction of column below envelope that is foreground
// (solid terrain/tree ≈ high fill; see-through lattice ≈ low fill).
//
// EVIDENCE-ONLY: outputs pixel silhouette + per-column class + stats. Angular
// conversion + DTM match live in match_dtm.mjs. No location is claimed here.
//
// USAGE: node tools/sextant/terrain/extract_silhouette.mjs
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const IN_PNG = path.join(ROOT, 'test_results', 'cr2_inventory', 'IMG_1653.png');
const OUT_DIR = path.join(ROOT, 'test_results', 'sextant_terrain');

// tuning (documented, not calibrated — a first look)
const DARK_DROP = 28;   // luminance below row-sky-median → dark foreground
const GRAD_T = 34;      // Sobel magnitude → textured (lattice/edge)
const MIN_AREA = 120;   // connected-component px to keep (drops isolated stars)

function lumOf(data, i) { return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

function main() {
  const png = PNG.sync.read(fs.readFileSync(IN_PNG));
  const { width: W, height: H, data } = png;
  const L = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) L[y * W + x] = lumOf(data, (y * W + x) * 4);

  // per-row sky median (robust sky brightness at each row)
  const skyMed = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x += 2) row.push(L[y * W + x]);
    skyMed[y] = median(row);
  }

  // Sobel gradient magnitude
  const G = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = -L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1] + L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1];
    const gy = -L[i - W - 1] - 2 * L[i - W] - L[i - W + 1] + L[i + W - 1] + 2 * L[i + W] + L[i + W + 1];
    G[i] = Math.hypot(gx, gy) / 4;
  }

  // foreground candidate mask
  const fg0 = new Uint8Array(W * H); // 0 none, 1 dark, 2 bright-textured
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (L[i] < skyMed[y] - DARK_DROP) fg0[i] = 1;
    else if (G[i] > GRAD_T && L[i] > skyMed[y] - 4) fg0[i] = 2;
  }
  // dilate 3x3 (once) to bridge the see-through tower lattice into connected runs
  const fg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = fg0[y * W + x];
    if (v === 0) {
      for (let dy = -1; dy <= 1 && v === 0; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
        if (fg0[yy * W + xx]) { v = fg0[yy * W + xx]; break; }
      }
    }
    fg[y * W + x] = v;
  }

  // connected components (8-conn). Keep large blobs OR tall-thin structures
  // (towers are tall even when narrow); this drops small round stars.
  const lab = new Int32Array(W * H).fill(-1);
  const compArea = [];
  const compMinY = [], compMaxY = [];
  const stack = new Int32Array(W * H);
  let nComp = 0;
  for (let s = 0; s < W * H; s++) {
    if (fg[s] === 0 || lab[s] !== -1) continue;
    let sp = 0; stack[sp++] = s; lab[s] = nComp; let area = 0, minY = H, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp]; area++;
      const px = p % W, py = (p / W) | 0;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const xx = px + dx, yy = py + dy;
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        const q = yy * W + xx; if (fg[q] !== 0 && lab[q] === -1) { lab[q] = nComp; stack[sp++] = q; }
      }
    }
    compArea.push(area); compMinY.push(minY); compMaxY.push(maxY); nComp++;
  }
  const keep = new Uint8Array(nComp);
  for (let c = 0; c < nComp; c++) {
    const vext = compMaxY[c] - compMinY[c];
    keep[c] = (compArea[c] >= MIN_AREA || vext >= 45) && compArea[c] >= 40 ? 1 : 0;
  }

  // per-column envelope + classification
  const envRow = new Int32Array(W).fill(-1);   // highest kept-fg row (min y); -1 = pure sky
  const fillFrac = new Float32Array(W);
  const colClass = new Array(W).fill('sky');   // sky | tower | tree | mixed
  for (let x = 0; x < W; x++) {
    let top = -1, fgCount = 0, brightCount = 0, darkCount = 0;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      if (fg[i] !== 0 && keep[lab[i]]) {
        if (top === -1) top = y;
        fgCount++;
        if (fg[i] === 2) brightCount++; else darkCount++;
      }
    }
    envRow[x] = top;
    if (top === -1) { colClass[x] = 'sky'; fillFrac[x] = 0; continue; }
    fillFrac[x] = fgCount / (H - top);
    // classify by dominant fg kind in the column
    const br = brightCount / Math.max(1, fgCount);
    if (br > 0.55) colClass[x] = 'tower';       // predominantly bright lattice
    else if (br < 0.2) colClass[x] = 'tree';    // predominantly dark solid
    else colClass[x] = 'mixed';
  }

  // ── stats ────────────────────────────────────────────────────────────────
  const cols = { sky: 0, tower: 0, tree: 0, mixed: 0 };
  for (const c of colClass) cols[c]++;
  const fgCols = W - cols.sky;
  const envVals = [];
  for (let x = 0; x < W; x++) if (envRow[x] >= 0) envVals.push(envRow[x]);
  // envelope continuity: median |Δenvelope| between adjacent fg columns (terrain
  // ridge ≈ small/smooth; tower spikes ≈ large jumps)
  const jumps = [];
  for (let x = 1; x < W; x++) if (envRow[x] >= 0 && envRow[x - 1] >= 0) jumps.push(Math.abs(envRow[x] - envRow[x - 1]));
  const fillOfFg = [];
  for (let x = 0; x < W; x++) if (envRow[x] >= 0) fillOfFg.push(fillFrac[x]);

  const stats = {
    frame: { width: W, height: H, aspect: +(W / H).toFixed(4) },
    params: { DARK_DROP, GRAD_T, MIN_AREA },
    kept_components: keep.reduce((a, b) => a + b, 0),
    total_components: nComp,
    columns: cols,
    fg_column_fraction: +(fgCols / W).toFixed(4),
    envelope_row: {
      min: envVals.length ? Math.min(...envVals) : null,      // highest reach (tower tip) in px from top
      max: envVals.length ? Math.max(...envVals) : null,
      median: envVals.length ? median(envVals) : null,
      // as fraction of frame height from BOTTOM (1 = bottom edge, 0 = top)
      median_frac_from_bottom: envVals.length ? +(1 - median(envVals) / H).toFixed(4) : null,
      highest_frac_from_bottom: envVals.length ? +(1 - Math.min(...envVals) / H).toFixed(4) : null,
    },
    envelope_continuity_px: {
      median_adjacent_jump: jumps.length ? +median(jumps).toFixed(2) : null,
      note: 'terrain ridge → small smooth jumps; isolated tower spikes → large jumps interleaved with sky gaps',
    },
    fill_fraction_of_fg_columns: {
      median: fillOfFg.length ? +median(fillOfFg).toFixed(4) : null,
      note: 'solid terrain/tree → high fill; see-through lattice tower → low fill',
    },
    tower_vs_tree: {
      tower_cols: cols.tower, tree_cols: cols.tree, mixed_cols: cols.mixed,
      tower_fraction_of_fg: fgCols ? +(cols.tower / fgCols).toFixed(4) : null,
    },
  };

  // per-kept-component PCA axis (for vanishing-point / pointing geometry).
  // Towers are near-vertical elongated structures; their image-space axes
  // converge at the zenith projection.
  const remap = new Int32Array(nComp).fill(-1);
  let nk = 0; for (let c = 0; c < nComp; c++) if (keep[c]) remap[c] = nk++;
  const acc = Array.from({ length: nk }, () => ({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, minY: H, maxY: 0 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const m = y * W + x; if (fg[m] === 0) continue; const c = lab[m]; if (!keep[c]) continue;
    const a = acc[remap[c]]; a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y;
    if (y < a.minY) a.minY = y; if (y > a.maxY) a.maxY = y;
  }
  const components = acc.map((a) => {
    const mx = a.sx / a.n, my = a.sy / a.n;
    const cxx = a.sxx / a.n - mx * mx, cyy = a.syy / a.n - my * my, cxy = a.sxy / a.n - mx * my;
    // principal axis angle of the covariance (major eigenvector)
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const elong = l2 > 1e-6 ? Math.sqrt(l1 / l2) : Infinity;
    return { area: a.n, cx: +mx.toFixed(1), cy: +my.toFixed(1), vext: a.maxY - a.minY,
      axis_deg: +(theta * 180 / Math.PI).toFixed(2), elongation: +elong.toFixed(2),
      dx: Math.cos(theta), dy: Math.sin(theta) };
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  stats.n_axis_components = components.length;
  // silhouette JSON (per-column)
  const silhouette = { source: 'IMG_1653.png', width: W, height: H,
    envelope_row: Array.from(envRow), col_class: colClass, fill_frac: Array.from(fillFrac).map(v => +v.toFixed(3)),
    components };
  fs.writeFileSync(path.join(OUT_DIR, 'silhouette.json'), JSON.stringify(silhouette));
  fs.writeFileSync(path.join(OUT_DIR, 'silhouette_stats.json'), JSON.stringify(stats, null, 2));

  // overlay PNG: tint kept foreground, draw envelope, color by class
  const out = new PNG({ width: W, height: H });
  const CLASSCOL = { tower: [80, 160, 255], tree: [80, 255, 120], mixed: [255, 200, 60], sky: [0, 0, 0] };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, m = y * W + x;
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (fg[m] !== 0 && keep[lab[m]]) {
      const cc = CLASSCOL[colClass[x]] || [255, 0, 255];
      r = (r + cc[0] * 2) / 3; g = (g + cc[1] * 2) / 3; b = (b + cc[2] * 2) / 3;
    }
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
  }
  // draw envelope as a red line
  for (let x = 0; x < W; x++) {
    const yr = envRow[x]; if (yr < 0) continue;
    for (const dy of [-1, 0, 1]) { const yy = yr + dy; if (yy < 0 || yy >= H) continue; const i = (yy * W + x) * 4; out.data[i] = 255; out.data[i + 1] = 30; out.data[i + 2] = 30; }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'silhouette_overlay.png'), PNG.sync.write(out));

  console.log(JSON.stringify(stats, null, 2));
  console.log('\nwrote silhouette.json, silhouette_stats.json, silhouette_overlay.png to', path.relative(ROOT, OUT_DIR));
}

main();
