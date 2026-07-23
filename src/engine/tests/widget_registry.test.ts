/**
 * WIDGET REGISTRY — Phase 1 unit tests (pure logic; node env, no DOM).
 *
 * Covers the render-layer contracts:
 *  - selector-null ⇒ NOT MEASURED signal (honest-or-absent, LAW 3)
 *  - weight-knob filtering (tier gates DISPLAY only)
 *  - flag-off gate (dock renders nothing) + persisted prefs round-trip
 *  - chart-token presence AND additivity of the src/index.css change
 *    (zero-regression proof: existing tokens + base rules intact)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    WIDGETS,
    WEIGHT_TIERS,
    allWidgetIds,
    tierAdmittedByLevel,
    selectWidgetsToRender,
    parseEnabledWidgets,
    getEnabledWidgets,
    setEnabledWidgets,
    getWidgetDockEnabled,
    setWidgetDockEnabled,
    getWeightLevel,
    setWeightLevel,
    getStoredWeightLevel,
    defaultWeightLevelForPhase,
    resolveInitialWeightLevel,
    countHiddenByTier,
    type WeightLevel,
} from '../ui/widgets/registry';
import { selectSolveSummary } from '../ui/widgets/widgets/SolveSummaryWidget';
import { selectDistortionCurves } from '../ui/widgets/widgets/DistortionCurvesWidget';
import { selectPsfField } from '../ui/widgets/widgets/PsfFieldWidget';

// ─── in-memory localStorage stub (node env has none) ───────────────────────

function installLocalStorage() {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

beforeEach(() => installLocalStorage());
afterEach(() => { delete (globalThis as any).localStorage; });

// ─── manifest integrity ────────────────────────────────────────────────────

describe('registry manifest', () => {
    it('registers the Phase-1 exemplars + Phase-2 data widgets + scaffolds with unique ids and valid tiers', () => {
        // Phase 1 exemplars come first, in order.
        expect(WIDGETS.slice(0, 3).map(w => w.id)).toEqual(['solve_summary', 'distortion_curves', 'psf_field']);
        // ids are unique across the whole registry.
        expect(new Set(allWidgetIds()).size).toBe(WIDGETS.length);
        for (const w of WIDGETS) {
            expect(typeof w.dataSelector).toBe('function');
            expect(typeof w.render).toBe('function');
            expect(WEIGHT_TIERS).toContain(w.weightTier);
            expect(w.title.length).toBeGreaterThan(0);
            expect(typeof w.intent).toBe('string');
            expect(w.intent.length).toBeGreaterThan(0);          // every widget states its purpose
        }
    });

    it('registers the Phase-2 data-backed widgets + all 9 scaffolds', () => {
        const ids = new Set(allWidgetIds());
        for (const id of [
            'forced_photometry_z', 'culling_waterfall', 'solve_timing_waterfall',
            'color_color_planckian', 'detection_density', 'bc_edge_recovery', 'distortion_cascade_2d',
        ]) expect(ids.has(id), `missing data widget ${id}`).toBe(true);
        for (const id of [
            'extinction_airmass', 'lp_gradient_map', 'rayleigh_mie', 'zodiacal_overlay', 'aod_haze',
            'per_rig_workbench_trend', 'stack_registration_residuals', 'sextant_confidence', 'bad_pixel_map',
        ]) expect(ids.has(id), `missing scaffold ${id}`).toBe(true);
    });

    it('covers all three tiers (stats/chart/heavy)', () => {
        const tiers = new Set(WIDGETS.map(w => w.weightTier));
        expect(tiers).toEqual(new Set(['stats', 'chart', 'heavy']));
    });

    it('registers the named-star overlay + the 3D cascade widgets (wired at the star-label wave)', () => {
        const byId = new Map(WIDGETS.map(w => [w.id, w]));
        expect(byId.get('star_labels')?.weightTier).toBe('chart');       // named-star overlay
        expect(byId.get('flattening_cascade')?.weightTier).toBe('heavy'); // cascade README wiring
        expect(byId.get('lens_profile_3d')?.weightTier).toBe('heavy');
        for (const id of ['star_labels', 'flattening_cascade', 'lens_profile_3d']) {
            expect(byId.get(id)?.intent.length ?? 0, `${id} needs an intent`).toBeGreaterThan(0);
        }
    });

    it('has the expected total widget count (10 phase-1/2 data + nebulosity_layers + star_labels + 2 cascade + starplate_library + solve_flowchart + solve_flowchart_webgpu + residual_quiver + psf_attribution + planetary_manifest + deep_confirm + replay_timeline + 3 greenfield + 9 scaffolds)', () => {
        // 27 → 31: consolidation delta (2026-07-12) registered residual_quiver +
        // psf_attribution + planetary_manifest + deep_confirm (previously step-local /
        // dashboard-card viewers, now pure receipt reads).
        // 31 → 34: greenfield solver-core widgets (2026-07-21) — greenfield_solve_stats
        // (chart) + greenfield_replay (heavy) + greenfield_sky_overlays (heavy), all pure
        // receipt reads over solution.greenfield_receipt (render plane; solve byte-identical).
        expect(WIDGETS.length).toBe(34);
    });

    it('registers the three greenfield solver-core widgets with the expected tiers', () => {
        const byId = new Map(WIDGETS.map(w => [w.id, w]));
        expect(byId.get('greenfield_solve_stats')?.weightTier).toBe('chart');
        expect(byId.get('greenfield_replay')?.weightTier).toBe('heavy');
        expect(byId.get('greenfield_sky_overlays')?.weightTier).toBe('heavy');
        for (const id of ['greenfield_solve_stats', 'greenfield_replay', 'greenfield_sky_overlays']) {
            expect((byId.get(id)?.intent.length ?? 0), `${id} needs an intent`).toBeGreaterThan(0);
        }
    });

    it('registers the ★ solve_flowchart widget (stats tier so it shows in the default dock)', () => {
        const byId = new Map(WIDGETS.map(w => [w.id, w]));
        expect(byId.get('solve_flowchart')?.weightTier).toBe('stats');
        expect((byId.get('solve_flowchart')?.intent.length ?? 0)).toBeGreaterThan(0);
    });

    it('registers the WebGPU flowchart TWIN (A/B experiment) with the IDENTICAL selector + matching stats tier', () => {
        const byId = new Map(WIDGETS.map(w => [w.id, w]));
        const svg = byId.get('solve_flowchart');
        const gpu = byId.get('solve_flowchart_webgpu');
        expect(gpu, 'twin must be registered').toBeDefined();
        expect(gpu?.weightTier).toBe('stats');                 // same tier as the original ⇒ default-visible together
        expect(gpu?.weightTier).toBe(svg?.weightTier);
        expect((gpu?.intent.length ?? 0)).toBeGreaterThan(0);
        expect(gpu?.title).toContain('WebGPU');                // clearly A/B-labelled
        // ZERO data divergence: the twin reuses the SAME selector reference.
        expect(gpu?.dataSelector).toBe(svg?.dataSelector);
        // …and the SVG original carries the A/B "(SVG)" label from its FPS wrapper.
        expect(svg?.title).toContain('SVG');
    });

    it('registers the replay_timeline widget (wave 3 — replay time-slice contract reference consumer)', () => {
        const byId = new Map(WIDGETS.map(w => [w.id, w]));
        expect(byId.get('replay_timeline')?.weightTier).toBe('chart');
        expect((byId.get('replay_timeline')?.intent.length ?? 0)).toBeGreaterThan(0);
    });
});

// ─── selectors: null ⇒ NOT MEASURED, present ⇒ data ────────────────────────

describe('dataSelectors are pure reads with honest absence', () => {
    it('solve_summary: null when no solution, data when present', () => {
        expect(selectSolveSummary(null)).toBeNull();
        expect(selectSolveSummary({})).toBeNull();
        expect(selectSolveSummary({ solution: null })).toBeNull();
        const d = selectSolveSummary({ solution: { ra_hours: 11.34, pixel_scale: 3.67, stars_matched: 272, confidence: 0.83 } });
        // [SAFETY CATCHER · 2.10.0] confirmStatus is additive: null when the receipt
        // carries no confirm_status block (honest absence).
        expect(d).toEqual({ raHours: 11.34, pixelScale: 3.67, starsMatched: 272, confidence: 0.83, confirmStatus: null });
        // …and surfaced (read, never re-derived) when the receipt has the verdict.
        const dc = selectSolveSummary({
            solution: { ra_hours: 11.34, pixel_scale: 3.67, stars_matched: 272, confidence: 0.83 },
            confirm_status: { status: 'CONFIRMED' },
        });
        expect(dc?.confirmStatus).toBe('CONFIRMED');
    });

    it('solve_summary: non-finite sub-values collapse to null (never a fake number)', () => {
        const d = selectSolveSummary({ solution: { ra_hours: 5, pixel_scale: NaN, stars_matched: undefined, confidence: 0.5 } });
        expect(d).toEqual({ raHours: 5, pixelScale: null, starsMatched: null, confidence: 0.5, confirmStatus: null });
    });

    it('distortion_curves: null when nothing chartable, data when a real fit exists', () => {
        expect(selectDistortionCurves(null)).toBeNull();
        expect(selectDistortionCurves({})).toBeNull();
        // hardware present but < 10 matches AND no vignette ⇒ nothing chartable
        expect(selectDistortionCurves({ hardware: { distortion_profile: { k1: 1e-3, k2: 0, k3: 0 }, fit_stats: { n_matches: 4, r_ref_px: 1800 }, vignette_v1: 0 } })).toBeNull();
        const d = selectDistortionCurves({ hardware: { distortion_profile: { k1: 1e-3, k2: 2e-6, k3: 0 }, fit_stats: { n_matches: 20, r_ref_px: 1800 }, vignette_v1: -0.1 } });
        expect(d).not.toBeNull();
        expect(d!.distortionMeasured).toBe(true);
        expect(d!.k1).toBeCloseTo(1e-3);
        expect(d!.v1).toBeCloseTo(-0.1);
    });

    it('distortion_curves: vignette alone is chartable even without a distortion fit', () => {
        const d = selectDistortionCurves({ hardware: { fit_stats: { n_matches: 0, r_ref_px: 0 }, vignette_v1: -0.2 } });
        expect(d).not.toBeNull();
        expect(d!.distortionMeasured).toBe(false);
        expect(d!.k1).toBe(0);
        expect(d!.v1).toBeCloseTo(-0.2);
    });

    it('psf_field: null on absence / NOT_MEASURED, data when measured', () => {
        expect(selectPsfField(null)).toBeNull();
        expect(selectPsfField({})).toBeNull();
        expect(selectPsfField({ psf_field: null })).toBeNull();
        expect(selectPsfField({ psf_field: { method: 'NOT_MEASURED', fwhm_median_maj_px: null } })).toBeNull();
        expect(selectPsfField({ psf_field: { method: 'WASM_LM_GAUSSIAN', fwhm_median_maj_px: null } })).toBeNull();
        const regions = Array.from({ length: 9 }, (_, i) => ({ n: i, fwhmMedianPx: 3 + i * 0.1, ellipticityMedian: 0.1 }));
        const d = selectPsfField({ psf_field: { method: 'WASM_LM_GAUSSIAN', fwhm_median_maj_px: 3.2, ellipticity_median: 0.12, n_fit: 200, regions, approximate: ['x'] } });
        expect(d).not.toBeNull();
        expect(d!.fwhmMedianMajPx).toBe(3.2);
        expect(d!.nFit).toBe(200);
        expect(d!.regions).toHaveLength(9);
        expect(d!.approximate).toEqual(['x']);
    });
});

// ─── weight-knob filtering (display only) ──────────────────────────────────

describe('weight-knob display filtering', () => {
    it('tierAdmittedByLevel respects the tier order', () => {
        expect(tierAdmittedByLevel('stats', 'stats')).toBe(true);
        expect(tierAdmittedByLevel('chart', 'stats')).toBe(false);
        expect(tierAdmittedByLevel('heavy', 'stats')).toBe(false);
        expect(tierAdmittedByLevel('chart', 'chart')).toBe(true);
        expect(tierAdmittedByLevel('heavy', 'chart')).toBe(false);
        expect(tierAdmittedByLevel('stats', 'heavy')).toBe(true);
        expect(tierAdmittedByLevel('heavy', 'heavy')).toBe(true);
    });

    it('selectWidgetsToRender includes tiers up to the knob level (nested stats⊆chart⊆heavy)', () => {
        const all = allWidgetIds();
        const sel = (level: WeightLevel) => selectWidgetsToRender(WIDGETS, { enabled: all, level });
        const statsSet = sel('stats'), chartSet = sel('chart'), heavySet = sel('heavy');
        // stats level admits only stats-tier widgets…
        expect(statsSet.every(w => w.weightTier === 'stats')).toBe(true);
        expect(statsSet.map(w => w.id)).toContain('solve_summary');
        // …chart admits stats+chart, never heavy…
        expect(chartSet.every(w => w.weightTier !== 'heavy')).toBe(true);
        expect(chartSet.length).toBeGreaterThan(statsSet.length);
        expect(chartSet.map(w => w.id)).toEqual(expect.arrayContaining(['distortion_curves', 'culling_waterfall', 'color_color_planckian']));
        // …heavy admits everything, and is a superset of chart.
        expect(heavySet.length).toBe(WIDGETS.length);
        expect(heavySet.map(w => w.id)).toEqual(expect.arrayContaining(['psf_field', 'detection_density', 'distortion_cascade_2d']));
        const chartIds = new Set(chartSet.map(w => w.id));
        expect(chartSet.every(w => chartIds.has(w.id))).toBe(true);
        expect(statsSet.every(w => chartIds.has(w.id))).toBe(true); // nesting
    });

    it('respects the enabled set independently of the weight level', () => {
        // psf_field enabled but knob at stats ⇒ hidden (tier not admitted)
        expect(selectWidgetsToRender(WIDGETS, { enabled: ['psf_field'], level: 'stats' })).toHaveLength(0);
        // ...visible once the knob reaches heavy
        expect(selectWidgetsToRender(WIDGETS, { enabled: ['psf_field'], level: 'heavy' }).map(w => w.id)).toEqual(['psf_field']);
        // disabling everything ⇒ nothing, at any level
        expect(selectWidgetsToRender(WIDGETS, { enabled: [], level: 'heavy' })).toHaveLength(0);
    });
});

// ─── flag-off gate + persisted prefs ───────────────────────────────────────

describe('dock flag + persisted prefs', () => {
    it('dock is DEFAULT ON, opt-out (flag="0" ⇒ renders nothing)', () => {
        expect(getWidgetDockEnabled()).toBe(true); // fresh storage, no key ⇒ on
        setWidgetDockEnabled(false);
        expect(getWidgetDockEnabled()).toBe(false); // explicit '0' opts out
        setWidgetDockEnabled(true);
        expect(getWidgetDockEnabled()).toBe(true);
    });

    it('getWidgetDockEnabled defaults ON when storage is unavailable', () => {
        delete (globalThis as any).localStorage;
        expect(getWidgetDockEnabled()).toBe(true);
        installLocalStorage();
    });

    it('parseEnabledWidgets: null passthrough, csv split, explicit-empty', () => {
        expect(parseEnabledWidgets(null)).toBeNull();
        expect(parseEnabledWidgets('a, b ,c')).toEqual(['a', 'b', 'c']);
        expect(parseEnabledWidgets('')).toEqual([]);
    });

    it('enabledWidgets falls back to defaults, then round-trips', () => {
        const defaults = allWidgetIds();
        expect(getEnabledWidgets(defaults)).toEqual(defaults); // nothing stored
        setEnabledWidgets(['solve_summary', 'psf_field']);
        expect(getEnabledWidgets(defaults)).toEqual(['solve_summary', 'psf_field']);
    });

    it('weight level defaults to stats and round-trips', () => {
        expect(getWeightLevel()).toBe('stats');
        setWeightLevel('heavy');
        expect(getWeightLevel()).toBe('heavy');
        setWeightLevel('chart');
        expect(getWeightLevel()).toBe('chart');
    });
});

// ─── per-phase weight defaults + discoverability hint (display-only) ────────

describe('weight-knob phase defaults + hidden-count hint', () => {
    it('getStoredWeightLevel returns null when unset/invalid, value when set', () => {
        expect(getStoredWeightLevel()).toBeNull();          // nothing stored
        localStorage.setItem('skycruncher.widgets.weight', 'garbage');
        expect(getStoredWeightLevel()).toBeNull();          // invalid ⇒ null (not a throw)
        setWeightLevel('chart');
        expect(getStoredWeightLevel()).toBe('chart');
    });

    it('defaultWeightLevelForPhase: landing→stats, post-solve→chart', () => {
        expect(defaultWeightLevelForPhase(false)).toBe('stats');
        expect(defaultWeightLevelForPhase(true)).toBe('chart');
    });

    it('resolveInitialWeightLevel: persisted choice always wins over the phase default', () => {
        // nothing stored ⇒ phase default applies
        expect(resolveInitialWeightLevel(false)).toBe('stats');
        expect(resolveInitialWeightLevel(true)).toBe('chart');
        // a stored choice wins in BOTH phases (even the cheap one over post-solve)
        setWeightLevel('stats');
        expect(resolveInitialWeightLevel(true)).toBe('stats');
        setWeightLevel('heavy');
        expect(resolveInitialWeightLevel(false)).toBe('heavy');
    });

    it('countHiddenByTier: counts only enabled, tier-hidden widgets; gates nothing', () => {
        const all = allWidgetIds();
        // At 'heavy' everything enabled is visible ⇒ nothing hidden.
        expect(countHiddenByTier(WIDGETS, { enabled: all, level: 'heavy' }).total).toBe(0);
        // At 'stats' every chart+heavy widget is hidden; totals match the tier census.
        const chartCount = WIDGETS.filter(w => w.weightTier === 'chart').length;
        const heavyCount = WIDGETS.filter(w => w.weightTier === 'heavy').length;
        const atStats = countHiddenByTier(WIDGETS, { enabled: all, level: 'stats' });
        expect(atStats.chart).toBe(chartCount);
        expect(atStats.heavy).toBe(heavyCount);
        expect(atStats.total).toBe(chartCount + heavyCount);
        // At 'chart', chart widgets are now visible; only heavy remain hidden.
        const atChart = countHiddenByTier(WIDGETS, { enabled: all, level: 'chart' });
        expect(atChart.chart).toBe(0);
        expect(atChart.heavy).toBe(heavyCount);
        // Disabled widgets are never counted (only ENABLED ones the knob hides).
        expect(countHiddenByTier(WIDGETS, { enabled: [], level: 'stats' }).total).toBe(0);
    });
});

// ─── index.css: new tokens present AND existing content intact ─────────────

describe('src/index.css chart tokens (additive)', () => {
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8');

    it('defines the new chart-grade tokens', () => {
        for (const t of [
            '--chart-cat-1:', '--chart-cat-6:',
            '--chart-seq-1:', '--chart-seq-5:',
            '--chart-axis:', '--chart-grid-subtle:', '--chart-zero:',
            '--chart-legend-text:', '--chart-tick-text:', '--chart-data-text:',
            '--chart-space-1:', '--chart-space-4:',
            '--chart-text-tick:', '--chart-text-readout:',
        ]) {
            expect(css, `missing token ${t}`).toContain(t);
        }
    });

    it('preserves existing @theme tokens through the --sc-* indirection (additive: resolved dark unchanged)', () => {
        // RESTYLE 2026-07-21: @theme colors now resolve through --sc-* custom
        // properties swapped by <html data-theme>. Dark is the DEFAULT and its
        // resolved values are byte-identical to the pre-restyle literals (proven
        // mechanically in the restyle handoff). This test proves BOTH halves of
        // the indirection so the invariant — resolved dark unchanged — still holds:
        // (a) @theme maps each color to its --sc-* indirection …
        expect(css).toContain('--color-space-950: var(--sc-page);');
        expect(css).toContain('--color-accent-400: var(--sc-accent);');
        expect(css).toContain('--color-solve: var(--sc-solve);');
        expect(css).toContain('--color-warn: var(--sc-warn);');
        expect(css).toContain('--color-text-primary: var(--sc-text);');
        // (b) … and the DARK swap carries the exact shipped hex (resolved = unchanged):
        expect(css).toContain('--sc-page:#05060a;');
        expect(css).toContain('--sc-accent:#38bdf8;');
        expect(css).toContain('--sc-solve:#34d399;');
        expect(css).toContain('--sc-warn:#fbbf24;');
        expect(css).toContain('--sc-text:#e8ecf4;');
        // ease stays literal (theme-independent):
        expect(css).toContain('--ease-instrument: cubic-bezier(0.2, 0, 0, 1);');
    });

    it('DARK (default) resolves every @theme color BYTE-IDENTICAL to the shipped World-1 hex (folded resolution proof)', () => {
        // Folded from prove_dark_identity.mjs (restyle evidence bank): the full
        // 28-color resolution proof, git-independent and re-run every vitest, so
        // the "shipped dark values never drift" identity survives the session.
        // EXPECTED_DARK = the canonical pre-restyle World-1 palette (literals that
        // used to live directly in @theme, now the target the swap must resolve to).
        const EXPECTED_DARK: Record<string, string> = {
            '--color-space-950': '#05060a', '--color-space-900': '#0a0c12',
            '--color-space-850': '#0e1118', '--color-space-800': '#131722',
            '--color-space-750': '#191e2b', '--color-space-700': '#212736',
            '--color-line-subtle': '#1c2230', '--color-line': '#2a3245',
            '--color-line-strong': '#3d4763',
            '--color-text-primary': '#e8ecf4', '--color-text-secondary': '#9aa5bd',
            '--color-text-muted': '#6a7792', '--color-text-faint': '#3d4763',
            '--color-accent-300': '#7dd3fc', '--color-accent-400': '#38bdf8',
            '--color-accent-500': '#0ea5e9', '--color-accent-600': '#0284c7',
            '--color-accent-glow': '#0ea5e91f',
            '--color-solve': '#34d399', '--color-solve-dim': '#34d3991a',
            '--color-warn': '#fbbf24', '--color-warn-dim': '#fbbf241a',
            '--color-danger': '#f87171', '--color-danger-dim': '#f871711a',
            '--color-pending': '#5d6880', '--color-info': '#818cf8',
            '--color-info-dim': '#818cf81a', '--color-data': '#c7d5f0',
        };
        // Parse the DARK swap block (:root, [data-theme="dark"] { … }) → --sc-* map.
        const darkStart = css.indexOf(':root, [data-theme="dark"]');
        expect(darkStart, 'dark swap block present').toBeGreaterThan(-1);
        const darkOpen = css.indexOf('{', darkStart);
        const darkClose = css.indexOf('}', darkOpen);
        const darkBody = css.slice(darkOpen + 1, darkClose);
        const swap: Record<string, string> = {};
        for (const m of darkBody.matchAll(/(--sc-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
            swap[m[1].trim()] = m[2].trim();
        }
        // Resolve each @theme color through the dark swap and assert the value.
        for (const [color, expected] of Object.entries(EXPECTED_DARK)) {
            const mapMatch = css.match(
                new RegExp(`${color}\\s*:\\s*var\\(\\s*(--sc-[a-z0-9-]+)\\s*\\)\\s*;`)
            );
            expect(mapMatch, `${color} maps to a --sc-* token in @theme`).not.toBeNull();
            const scName = mapMatch![1];
            expect(swap[scName], `${scName} present in dark swap`).toBeDefined();
            expect(swap[scName], `${color} → ${scName} must resolve to ${expected} in dark`).toBe(expected);
        }
        // Guard: every color the shipped palette knows is covered (no silent drop).
        expect(Object.keys(EXPECTED_DARK).length).toBe(28);
    });

    it('leaves existing base selectors/rules intact', () => {
        expect(css).toContain('background-color: var(--color-space-950);');
        expect(css).toContain(':focus-visible {');
        expect(css).toContain('@media (prefers-reduced-motion: reduce) {');
    });
});
