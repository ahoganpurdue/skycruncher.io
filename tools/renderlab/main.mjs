// main.mjs — Render Lab entry: WebGPU bootstrap, data load, modes, HUD, input.
//
// STANDALONE incubator (LAW 4): nothing in src/ imports this; the only repo
// dependency is apache-arrow from the root node_modules. Honest-or-absent
// (LAW 3): no adapter => visible fallback message; unmeasurable numbers => "--".

import { initWebGPU, GpuUnavailableError, GpuTimer } from './gpu.mjs';
import { loadStarplate } from './arrow_loader.mjs';
import { StarfieldRenderer } from './starfield.mjs';
import { QuiverRenderer } from './quiver.mjs';
import { SurfaceRenderer } from './surface.mjs';
import { loadReceipt, evaluateStages } from './cascade.mjs';

const DEG = Math.PI / 180;

// Data resolution order (vite publicDir serves the release folder root —
// see vite.config.mjs): the /data/ prefix is a belt-and-braces fallback for
// non-vite static servers where the lab dir itself is the web root.
const STARPLATE_URLS = ['/t0/allsky.arrow', '/data/t0/allsky.arrow'];

// Receipt for the CASCADE demo — /receipt.json is served by the vite
// middleware from tools/renderlab/data/receipt.json when the owner provides
// one (see README "DEMO 3 data"); the /data/ prefix again covers non-vite
// static servers. NEVER bundled, NEVER synthesized (LAW 3).
const RECEIPT_URLS = ['/receipt.json', '/data/receipt.json'];

// View starts on the M66 field — the pipeline's standing test field.
const state = {
  running: true,
  destroyed: false,
  mode: 'star', // 'star' | 'quiver' | 'cascade'
  view: { raDeg: 170.425, decDeg: 12.842 },
  fovDeg: 60,
  device: null,
  context: null,
  format: null,
  timer: null,
  star: null,       // StarfieldRenderer once the blob decodes
  starError: null,  // honest load-failure text
  plate: null,
  quiver: null,
  surface: null,       // SurfaceRenderer (CASCADE demo)
  receipt: null,       // parsed receipt JSON once loaded
  receiptUrl: null,
  cascade: null,       // evaluateStages() result
  cascadeError: null,  // honest receipt-load / eval failure text
  gridN: 96,
  encodeMs: null,
  frameMs: null,
  fps: null,
  frameCount: 0,
  fpsWindowStart: 0,
  rafId: 0,
};

const $ = (id) => document.getElementById(id);
const canvas = $('gpu-canvas');
const hud = $('hud');

function showFallback(reason) {
  $('fallback').hidden = false;
  $('fallback-reason').textContent = reason;
  canvas.style.display = 'none';
  $('controls').style.display = 'none';
  hud.style.display = 'none';
}

/* ── sizing ─────────────────────────────────────────────────────────────── */

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/** px per tangent-plane unit for the current zoom. */
function scalePx() {
  return (canvas.width / 2) / Math.tan((state.fovDeg / 2) * DEG);
}

/* ── input: drag pan + wheel zoom ───────────────────────────────────────── */

function setupInput() {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (ev) => {
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    if (state.mode === 'cascade') {
      // Orbit the shared surface camera (all four panes rotate together).
      if (state.surface) state.surface.orbit(ev.clientX - lastX, ev.clientY - lastY);
      lastX = ev.clientX;
      lastY = ev.clientY;
      return;
    }
    if (state.mode !== 'star') return;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const dx = (ev.clientX - lastX) * dpr;
    const dy = (ev.clientY - lastY) * dpr;
    lastX = ev.clientX;
    lastY = ev.clientY;
    const radPerPx = 1 / scalePx(); // small-angle: tangent-plane unit ~ rad
    const v = state.view;
    v.decDeg = Math.max(-89.5, Math.min(89.5, v.decDeg + (dy * radPerPx) / DEG));
    const cosDec = Math.max(Math.cos(v.decDeg * DEG), 0.02);
    v.raDeg = ((v.raDeg - (dx * radPerPx) / DEG / cosDec) % 360 + 360) % 360;
  });
  const endDrag = (ev) => {
    dragging = false;
    canvas.classList.remove('dragging');
    if (ev.pointerId !== undefined && canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (state.mode === 'cascade') {
      if (state.surface) state.surface.zoomBy(Math.exp(-ev.deltaY * 0.0012));
      return;
    }
    if (state.mode !== 'star') return;
    state.fovDeg = Math.max(0.1, Math.min(110, state.fovDeg * Math.exp(ev.deltaY * 0.0012)));
  }, { passive: false });
}

/* ── controls ───────────────────────────────────────────────────────────── */

function sliderToN(v) {
  // 0..300 -> 100..100,000 (log scale)
  return Math.round(100 * Math.pow(10, v / 100));
}

function setupControls() {
  const starBtn = $('mode-star');
  const quiverBtn = $('mode-quiver');
  const cascadeBtn = $('mode-cascade');
  const quiverControls = $('quiver-controls');
  const cascadeControls = $('cascade-controls');
  const starNote = $('star-note');
  const slider = $('nslider');
  const nval = $('nval');

  const setMode = (mode) => {
    state.mode = mode;
    starBtn.classList.toggle('active', mode === 'star');
    quiverBtn.classList.toggle('active', mode === 'quiver');
    cascadeBtn.classList.toggle('active', mode === 'cascade');
    quiverControls.hidden = mode !== 'quiver';
    cascadeControls.hidden = mode !== 'cascade';
    starNote.hidden = mode !== 'star';
    syncCascadeOverlay();
    if (mode === 'quiver' && state.quiver && state.quiver.count === 0) {
      state.quiver.regenerate(sliderToN(Number(slider.value)));
    }
  };
  starBtn.addEventListener('click', () => setMode('star'));
  quiverBtn.addEventListener('click', () => setMode('quiver'));
  cascadeBtn.addEventListener('click', () => setMode('cascade'));

  slider.addEventListener('input', () => {
    const n = sliderToN(Number(slider.value));
    nval.textContent = n.toLocaleString('en-US');
    if (state.quiver) state.quiver.regenerate(n);
  });
  nval.textContent = sliderToN(Number(slider.value)).toLocaleString('en-US');

  // CASCADE controls: fill/wire toggles + grid density.
  const fillBtn = $('surf-fill');
  const wireBtn = $('surf-wire');
  const gridSlider = $('gridslider');
  const gridVal = $('gridval');
  fillBtn.addEventListener('click', () => {
    if (!state.surface) return;
    state.surface.showFill = !state.surface.showFill;
    fillBtn.classList.toggle('active', state.surface.showFill);
  });
  wireBtn.addEventListener('click', () => {
    if (!state.surface) return;
    state.surface.showWire = !state.surface.showWire;
    wireBtn.classList.toggle('active', state.surface.showWire);
  });
  gridSlider.addEventListener('input', () => {
    const n = Number(gridSlider.value);
    state.gridN = n;
    gridVal.textContent = `${n}×${n}`;
    if (state.surface) {
      state.surface.setGrid(n);
      if (state.receipt) applyCascade();
      syncCascadeOverlay();
    }
  });
  gridVal.textContent = `${state.gridN}×${state.gridN}`;
}

/* ── CASCADE demo: receipt evaluation + honest-absent overlay ───────────── */

/** (Re)evaluate all four stages at state.gridN and upload the height fields. */
function applyCascade() {
  const res = evaluateStages(state.receipt, state.gridN);
  if (res.error) {
    state.cascade = null;
    state.cascadeError = res.error;
    return;
  }
  state.cascade = res;
  state.cascadeError = null;
  res.stages.forEach((st, i) => {
    if (st.status === 'measured') state.surface.setStage(i, st.heights);
    else state.surface.clearStage(i);
  });
}

/** Sync the 2×2 pane labels / NOT MEASURED tiles / missing-receipt panel. */
function syncCascadeOverlay() {
  const overlay = $('cascade-overlay');
  const missing = $('cascade-missing');
  if (state.mode !== 'cascade') {
    overlay.hidden = true;
    missing.hidden = true;
    return;
  }
  if (!state.cascade) {
    // Whole-demo honest-absent state: no receipt (or a receipt without frame
    // dims) — visible setup instructions instead of a blank/synthetic view.
    overlay.hidden = true;
    missing.hidden = false;
    $('cascade-missing-reason').textContent = state.cascadeError ?? 'receipt loading…';
    return;
  }
  missing.hidden = true;
  overlay.hidden = false;
  state.cascade.stages.forEach((st, i) => {
    const el = $(`pane-label-${i}`);
    if (st.status === 'measured') {
      el.classList.remove('absent');
      const peakLine = `peak ${st.peakPx.toFixed(2)} px @ (${st.peakAt[0].toFixed(0)}, ${st.peakAt[1].toFixed(0)})`;
      el.textContent = st.note ? `${st.label}\n${peakLine}\n${st.note}` : `${st.label}\n${peakLine}`;
    } else {
      el.classList.add('absent');
      el.textContent = `${st.label}\nNOT MEASURED — ${st.reason}`;
    }
  });
}

/* ── HUD (mono, honest numbers or "--") ─────────────────────────────────── */

const fmt = (v, digits = 2) => (v == null ? '--' : v.toFixed(digits));

function hudText() {
  const lines = [];
  lines.push('RENDER LAB · WebGPU incubator (standalone — not the shipping renderer)');
  if (state.mode === 'star') {
    lines.push('mode      STARFIELD');
    if (state.star) {
      const src = state.plate.release
        ? `${state.plate.release} · t0/allsky.arrow`
        : state.plate.url;
      lines.push(`stars     ${state.star.rows.toLocaleString('en-US')}  (${src})`);
      lines.push(`decode    ${fmt(state.plate.decodeMs, 1)} ms  fetch ${fmt(state.plate.fetchMs, 0)} ms  ${(state.plate.bytes / 1e6).toFixed(2)} MB`);
      lines.push(`recenter  ${fmt(state.star.lastRecenterMs, 1)} ms (f64 CPU pass, on >25° drift)`);
    } else if (state.starError) {
      lines.push('stars     LOAD FAILED — see below');
      lines.push(state.starError);
    } else {
      lines.push('stars     loading…');
    }
    const v = state.view;
    lines.push(`center    RA ${v.raDeg.toFixed(4)}°  DEC ${v.decDeg >= 0 ? '+' : ''}${v.decDeg.toFixed(4)}°`);
    lines.push(`fov       ${state.fovDeg.toFixed(2)}° across`);
  } else if (state.mode === 'quiver') {
    lines.push('mode      QUIVER — SYNTHETIC residual field (labeled; not real data)');
    if (state.quiver) {
      lines.push(`arrows    ${state.quiver.count.toLocaleString('en-US')}`);
      lines.push(`gen       ${fmt(state.quiver.lastGenMs, 1)} ms (CPU, on slider change)`);
    }
  } else {
    lines.push('mode      CASCADE — |displacement| surfaces from receipt-fitted models (display-only)');
    if (state.cascade) {
      lines.push(`receipt   ${state.receiptUrl}  eval ${fmt(state.cascade.evalMs, 1)} ms`);
      lines.push(`grid      ${state.gridN}×${state.gridN} per pane · frame ${state.cascade.frame.W}×${state.cascade.frame.H} px`);
      for (const st of state.cascade.stages) {
        const name = st.label.padEnd(12);
        lines.push(st.status === 'measured'
          ? `${name}peak ${st.peakPx.toFixed(2)} px (own-peak normalized)`
          : `${name}NOT MEASURED`);
      }
    } else if (state.cascadeError) {
      lines.push('receipt   ABSENT — see panel for the reason + setup steps');
    } else {
      lines.push('receipt   loading…');
    }
  }
  lines.push(`fps       ${fmt(state.fps, 1)}`);
  lines.push(`frame     ${fmt(state.frameMs, 2)} ms (rAF interval)`);
  lines.push(`encode    ${fmt(state.encodeMs, 2)} ms (CPU, encoder→submit)`);
  const gpuLabel = state.timer && state.timer.enabled
    ? `${fmt(state.timer.lastMs, 3)} ms (timestamp-query)`
    : '--  (timestamp-query unavailable on this adapter)';
  lines.push(`gpu pass  ${gpuLabel}`);
  if (state.mode === 'star') {
    lines.push('tint      ILLUSTRATIVE bp_rp ramp — not photometric');
  }
  return lines.join('\n');
}

/* ── frame loop ─────────────────────────────────────────────────────────── */

let lastFrameTs = 0;
let lastHudTs = 0;

function frame(ts) {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(frame);

  // rAF-interval frame time + windowed FPS (real, displayed as measured).
  if (lastFrameTs > 0) state.frameMs = ts - lastFrameTs;
  lastFrameTs = ts;
  state.frameCount++;
  if (ts - state.fpsWindowStart >= 1000) {
    state.fps = (state.frameCount * 1000) / (ts - state.fpsWindowStart);
    state.frameCount = 0;
    state.fpsWindowStart = ts;
  }

  resizeCanvas();
  const w = canvas.width;
  const h = canvas.height;

  const cascadeActive = state.mode === 'cascade' && !!state.surface;
  let active = null;
  if (state.mode === 'star') {
    active = state.star;
    if (state.star) state.star.updateView(state.view, scalePx(), w, h);
  } else if (state.mode === 'quiver') {
    active = state.quiver;
    if (state.quiver) state.quiver.update(w, h);
  } else if (cascadeActive) {
    state.surface.update(w, h);
  }

  const t0 = performance.now();
  const encoder = state.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: state.context.getCurrentTexture().createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 5 / 255, g: 6 / 255, b: 10 / 255, a: 1 }, // --space-950
    }],
    // Depth only exists on the cascade pass (its pipelines declare a depth
    // state; the star/quiver pipelines do not and never share this pass).
    depthStencilAttachment: cascadeActive ? state.surface.depthAttachment(w, h) : undefined,
    timestampWrites: state.timer.passTimestampWrites(),
  });
  if (cascadeActive) state.surface.draw(pass, w, h);
  else if (active) active.draw(pass);
  pass.end();
  state.timer.resolve(encoder);
  state.device.queue.submit([encoder.finish()]);
  state.encodeMs = performance.now() - t0;
  state.timer.collect();

  if (ts - lastHudTs > 250) {
    hud.textContent = hudText();
    lastHudTs = ts;
  }
}

/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  resizeCanvas();
  let gpu;
  try {
    gpu = await initWebGPU(canvas);
  } catch (err) {
    if (err instanceof GpuUnavailableError) {
      showFallback(`Reason: ${err.message}`);
      return;
    }
    showFallback(`WebGPU init threw unexpectedly: ${err.message}`);
    return;
  }

  state.device = gpu.device;
  state.context = gpu.context;
  state.format = gpu.format;
  state.timer = new GpuTimer(gpu.device, gpu.hasTimestamps);

  gpu.device.lost.then((info) => {
    if (!state.destroyed && info.reason !== 'destroyed') {
      state.running = false;
      showFallback(`GPU device lost: ${info.message || info.reason}`);
    }
  });

  state.quiver = new QuiverRenderer(gpu.device, gpu.format);
  state.surface = new SurfaceRenderer(gpu.device, gpu.format, state.gridN);

  setupInput();
  setupControls();
  state.fpsWindowStart = performance.now();
  state.rafId = requestAnimationFrame(frame);

  // Receipt load for CASCADE — async; on failure the demo renders its
  // honest-absent state with setup instructions, never synthetic surfaces.
  loadReceipt(RECEIPT_URLS).then(({ receipt, url }) => {
    if (!state.running) return;
    state.receipt = receipt;
    state.receiptUrl = url;
    applyCascade();
    syncCascadeOverlay();
  }).catch((err) => {
    state.cascadeError = String(err.message || err);
    syncCascadeOverlay();
  });

  // Starfield data load — async, after the loop starts so the HUD shows
  // progress. Failure is reported honestly in the HUD, never faked.
  try {
    const plate = await loadStarplate(STARPLATE_URLS);
    if (!state.running) return;
    state.plate = plate;
    state.star = new StarfieldRenderer(gpu.device, gpu.format, plate);
  } catch (err) {
    state.starError = String(err.message || err);
  }
}

boot();

/* ── graceful teardown on vite hot-reload ───────────────────────────────── */

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    state.running = false;
    state.destroyed = true;
    cancelAnimationFrame(state.rafId);
    try {
      if (state.device) state.device.destroy(); // guard: may never have booted
    } catch {
      /* already lost — nothing to release */
    }
  });
}
