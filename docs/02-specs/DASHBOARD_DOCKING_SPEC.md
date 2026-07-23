<!-- ACTIVE · owner-ruled 2026-07-21: dockview APPROVED (Decisions 1+2) · Phase A spike first, per §8 -->
# Dashboard Docking Build-Out — drag-drop · tab stacks · pull-out windows — SPEC

*Owner directive 2026-07-21: "build out the desktop UI to actually and truly have the configurable
dashboard with drag and drop modules, drag to overlap to create tabs, pulling widgets/modules out of
the desktop window to create a second screen … Before we start on/do this work, we should have notes
about this in our documentation." Status: **DRAFT — awaiting owner rulings** (§9). This doc is the
BUILD-OUT DELTA against [WORKSPACE_DASHBOARD_DESIGN.md](../WORKSPACE_DASHBOARD_DESIGN.md) (owner
spec 2026-07-09, v1 APPROVED) — that doc holds the intent + v1 architecture; this one holds the
2026-07-21 measured state, two owner decisions, the popout architecture under measured Tauri
constraints, and phased gates.*

*Status: **ACTIVE** — owner ruled 2026-07-21 ("approved for dockview"): **Decision 1 = (ii)
adopt-engine** (WorkspaceHost v1 layout tree superseded; Profile/typeMap concepts + keyboard grammar
carry over) and **Decision 2 = dockview-react**. §9 items 3-5 proceed on their recommended defaults
unless the owner overrules. Phase A spike launched same day.*

## 1. The ask, mapped to the 2026-07-09 spec
The 2026-07-21 directive re-affirms the 2026-07-09 owner spec nearly 1:1 (drag-out second window ·
viz-on-viz tab group · named per-upload-type workspaces). What was never built is v2 (drag
ergonomics) and v3 (Tauri multi-window). This spec is the build order for those, with one change of
approach ruled below: adopt a maintained docking engine for the in-window half instead of extending
the hand-rolled v1 tree.

## 2. Measured state (2026-07-21 audit; file:line as of that date, worktree wt-cutover)
| Surface | State | Evidence |
|---|---|---|
| **WidgetDock + ReplayDashboard** (what the owner uses) | LIVE, default-ON; CSS grid `repeat(auto-fill,minmax(280px,1fr))`; NO drag/resize/popout; persistence = enable/weight flags only, no positions | WidgetDock.tsx:196, :17; registry.ts:167,195,272; MainApp.tsx:216-246, :405 |
| **WorkspaceHost v1** (what the 07-09 spec built) | MERGED @d0fce98, flag-off, UNMOUNTED since; recursive Split/Leaf tree, tab bar + close, keyboard splits, Profile schema v1 in localStorage | WorkspaceHost.tsx:120-155; workspace_store.ts:36,55 |
| **WidgetShelf** `#/widgets` | LIVE standalone page, own React branch, renders any widget from a bare receipt JSON with zero wizard/session contact — the existence proof for popout rendering | main.tsx:19-31; WidgetShelf.tsx:232-241, :328 |

Widget contract: ~34 registered widgets, each a **pure function** — `dataSelector(receipt, events) → data`,
`Render({data})` (registry.ts:111-145). Two exceptions a popout must handle: `starplate_library`
(env/native-store-driven, already window-independent via invoke) and replay-aware widgets
(read `ReplayContext`, degrade honestly to null when absent — ReplayContext.tsx:54-60).

Tauri: v2.10.3, ONE window (tauri.conf.json:13-21). ~~No capabilities dir~~ **CORRECTED by Phase A
(2026-07-21): `src-tauri/capabilities/default.json` EXISTS granting `core:default`** (that's where
today's `invoke()` IPC permission comes from; the original audit claim was wrong). No
`@tauri-apps/api/event` usage in the frontend — cross-window plumbing was greenfield and is now
spike-proven (§5).

## 3. DECISION 1 (owner): the vehicle
The 07-09 spec targets WorkspaceHost; the dashboard the owner actually uses is WidgetDock/ReplayDashboard.
No doc decides which carries the drag/dock/pull-out program. Options:

- **(i) Resurrect WorkspaceHost** and hand-build drag ergonomics on its tree. Cost: drag ghosting,
  5-zone drop-target math, tab reparenting/focus/z-order, sash resizing — the multi-week trap;
  VS Code-grade teams build this in-house, we should not.
- **(ii) Adopt a docking library as the layout engine (RECOMMENDED).** The docking surface replaces
  WidgetDock's grid when enabled (same mount points, flag-gated). WorkspaceHost's layout TREE is
  superseded; its Profile/named-workspace/typeMap concepts and keyboard-split grammar carry over
  (grammar reimplemented on the library API in Phase D). Honest cost: retires an approved-merged v1
  component → needs this explicit ruling; the tree + its unit tests stay in git history.
- **(iii) Bolt drag onto the live grid incrementally.** Dead end — grid drag doesn't compose into
  tab stacks or popout; work gets thrown away.

## 4. DECISION 2 (owner): the library
Researched 2026-07-21 (citations §10):

| Library | License | Maintenance | Dock / tab-stack / popout | Fit |
|---|---|---|---|---|
| **dockview-react** (RECOMMENDED) | MIT | v7.0.2 2026-06-22, very active, zero-dep core | ✅ / ✅ (drop-on-center) / ✅ first-class (`addPopoutGroup`) + floating groups; `toJSON/fromJSON` incl. popout state | React ≥16.8 → our 18.2 clean; VS Code feel |
| flexlayout-react | ISC | active 2025, Caplin (trading UIs) | ✅ / ✅ native tabsets / ✅ `enablePopout` | solid fallback; smaller surface |
| rc-dock | permissive (UNVERIFIED) | latest major in alpha, small community | ✅ / ✅ / ✅ | second-tier |
| golden-layout | MIT | stale npm (~2021) | ✅ / ✅ / ✅ | ruled out — no first-class React |

Reality check: VS Code uses a bespoke in-house layout (no npm docking lib); Theia/JupyterLab use
Lumino. dockview models the VS Code feel without their team size. **Decisive shared caveat: every
library's popout rides `window.open` — see §5; the popout is OURS to build regardless of choice, so
the library decision only buys the in-window ~90%.**

## 5. Popout — the hard part (build ours, library-independent)
- **CONFIRMED on-box (Phase A, 2026-07-21): `window.open()` returns `null` — no window, ever**
  (tauri#14263 reproduced on our exact build). dockview's native popout is dead here; the
  WebviewWindow substitute below is mandatory — and now PROVEN.
- **Tauri-native path — PROVEN end-to-end (Phase A)**: `WebviewWindow` per popped panel; popout =
  the SAME SPA at `#/popout?panel=<widgetId>` mounting ONE panel through WidgetFrame. Measured on
  this box: popout opened, registry widget rendered LIVE data from the bridged receipt, CSP-clean,
  `getAllWebviewWindows()` enumerates both. Permissions (measured, additive capability file scoped
  to window labels `["main","popout-*"]` — the glob is REQUIRED or popouts get zero perms):
  `core:default` already covers listen/emit/emit-to; the only genuinely new ids are
  `core:webview:allow-create-webview-window` and `core:webview:allow-get-all-webviews` (exact id —
  NOT `…-webview-windows`; the build-time ACL codegen hard-fails on unknown ids and dumps the valid
  set). Note: any capability edit = app-crate rebuild (first cold build ~10-15 min; warm ~2 min).
- **State bridge**: `@tauri-apps/api/event` — main window is the single producer, `emit_to(label, …)`
  serialized `{receipt, events, replayFrame}`; popouts are subscribers only. PROVEN (Phase A): a
  1.05 MB receipt survived `emit_to`→serde→receive byte-perfect (sha256 match both ends + on-disk
  fixture). BroadcastChannel across Tauri webviews: ~~unavailable~~ **MEASURED AVAILABLE
  same-origin (Phase A refuted the assumption)** — permitted as supplementary only; the Tauri event
  bridge stays primary (typed, targeted, window-lifecycle-aware).
- localStorage is shared same-origin → prefs sync free; layout state has ONE writer (main window).
- Popout close → panel returns to the main layout (or honest empty slot); main-window crash/restart
  → popouts reopen from persisted bounds (Phase C).
- **Browser tier: popout affordance ABSENT** (honest-or-absent — no degraded popup until the owner
  rules otherwise; the 07-09 spec's browser-popup tier stays future).

## 5b. Popout — Phase C second half: tear-off · multi-widget workspaces · shift-split (owner 2026-07-21)
Owner directive: (1) grab a widget BY ITS HEADER, drag past the window edge, release → it becomes an
OS window at the drop point; (2) popout windows become FULL recursive docking workspaces (own dockview
surface, own splits/tabs, own ribbon — "a side window with 13 widgets in panels and tabs"); (3)
shift-drag = force-split (never tab) if dockview's drag layer permits modifier reads. Built on the
Phase C plumbing (popout_bridge/popout_store/usePopoutManager/PopoutHost); RENDER PLANE only.

**(1) Tear-off gesture.** A capture-phase `dragend` listener on the main DockingSurface (desktop +
popout-enabled only). Drag start is captured through dockview's typed `api.onWillDragPanel`
(`TabDragEvent{ nativeEvent, panel }` — `panel.id` + `panel.params.widgetId`), recorded into a ref;
the dockview tab IS the panel header, so "grab by header" and "grab the tab" are the one gesture. On
`dragend` the release point (`DragEvent.screenX/screenY`, logical px) is tested against the main
window rect (`window.screenX/screenY/outerWidth/outerHeight`, logical px) by the pure predicate
`isOutsideWindow` (popout_bridge). Outside ⇒ `popOut(panelId, widgetId, {x,y})` — the panel leaves the
dock (never live in two windows, §5) and a `WebviewWindow` opens with its top-left at the drop point,
size from persisted bounds (`tearOffBounds`). Release INSIDE ⇒ untouched: dockview's own drop/snap-back
runs. Multi-monitor coordinates stay LOGICAL px (the existing Phase C DPI limitation is kept, not
solved tonight). Capture phase is load-bearing — it beats dockview's target-phase transfer-clear, so
the recorded drag survives to `dragend`.

**(2) Multi-widget popout workspaces.** The `#/popout` page is promoted from a single `WidgetFrame`
to a FULL `DockingSurface` instance — its own dockview tree, its own bottom ribbon (full registry),
its own splits/tabs — seeded with the one widget it was popped from and growing to a "13-widget"
workspace by dragging chips from the popout's own ribbon. The popout is `fillViewport` (window height)
so its surface is ALWAYS in view → its ribbon always renders. It stays a SUBSCRIBER (§5): the main
window's single-producer broadcast (`emit_to` {receipt,events,replayFrame}) reaches it, and every
docked widget in the popout reads that one bridged receipt through `DockingDataContext` — all widgets
subscribe identically, for free. The popout surface is `popoutEnabled={false}`: its own popout manager
is inert (it never spawns further OS windows — only main owns window lifecycle), so no popout button
and no tear-off inside a popout. **Per-window layout persistence** (Profile v2 ADDITIVE — same schema
version 2, new keys, no bump): each popout persists to `popoutLayoutStorageKey(widgetId)` =
`skycruncher.docking.profile.popout.<widgetId>`, keyed by the SEED widget (windows are ephemeral —
`popout-<panelId>` regenerates each pop; the seed widget is the reproducible identity, matching how
popout_store keys bounds). A popout reopened for the same seed restores its full multi-widget tree.
Bookkeeping: a widget lives in EXACTLY ONE place — the main tree, or one named popout tree. Moving a
widget between windows in v1 is via the ribbon in each window (add on one side, drop-to-remove on the
other); cross-window DRAG is out of scope (honest — Phase D).

**(3) Shift-split — dockview DOES permit modifier reads (verdict: CLEAN via public API).** Every drop
hook carries a live `nativeEvent: DragEvent` whose `.shiftKey` is populated on `dragover`
(component.api.d.ts: `onWillShowOverlay`/`onWillDrop`/`onDidDrop`; events.d.ts:24-38). Mechanism:
`api.onWillShowOverlay` fires per drop-zone for BOTH internal tab moves and external ribbon-chip drags
and exposes `nativeEvent` + `position` + `kind` + `preventDefault()`. We `preventDefault()` the
tab/center zone whenever shift is held (`shouldBlockTabDrop(kind, position, shiftKey)` = shift &&
(`kind==='tab'` || `position==='center'`)) — suppressing the tabbing overlay so only edge SPLIT zones
accept the drop. This is "shift = never tab", uniform across internal and external drags, using only
the public API (no dockview-internals patch). Defensive belt for ribbon chips: `onDidDrop` also remaps
a shift+center drop to a split via `splitDirectionForShift`. Scope note (honest): a STRONGER
"center-drop auto-splits to a chosen side" (rather than "center disabled under shift") would need
`onWillDrop.preventDefault()` + a manual remove/re-add, which the API docstring flags as fragile
("unexpected behaviours"); not taken — overlay-suppression is the clean win and matches the directive.

**Verification (per the ribbon saga).** Pure logic proven headless in vitest: `isOutsideWindow` bounds
math, `tearOffBounds` (size-from-persisted / position-from-drop), `popoutLayoutStorageKey` per-window
keying, `shouldBlockTabDrop` / `splitDirectionForShift`. A live-browser Playwright check
(`tools/e2e/verify_popout_surface.mjs`, ribbon-verify pattern) asserts the `#/popout?panel=…` page
mounts a full `DockingSurface` + `widget-ribbon` on a fresh Vite port. The `WebviewWindow` itself
(actual OS window, cross-monitor drop, bounds persistence) CANNOT be exercised headlessly — it is
enumerated in the owner 2-monitor walkthrough: tear a header past each screen edge → window at the
drop point; drag 10+ chips into a popout across splits+tabs; shift-drag forbids tabbing; ✕/return
re-docks; reopen restores the popout's tree + bounds.

## 6. Chrome ownership — one LAW-3 enforcement point
Three layers, one owner each; no layer duplicates another's job:
- **Docking manager** (dockview): placement, sashes, tab bars, close, popout button.
- **WidgetFrame**: title, intent-help, weight badge, and the honest-or-absent empty-state taxonomy —
  SOLE owner. (WorkspaceHost's bespoke NOT-MEASURED div, WorkspaceHost.tsx:83-102, is the drift
  counter-example: it gets folded back, never repeated.)
- **ZoomPanViewport** (in flight per the widgets-zoom directive 2026-07-21): wheel/pinch zoom +
  pan/reset around the Render mount only. Composes unchanged inside docked panels and popout windows.
  WebGL widgets that own their wheel (flattening_cascade, lens_profile_3d) stay exempt.

## 6b. Widget ribbon — the add-widget palette (owner 2026-07-21)
Owner directive: a **collapsed-by-default scrolling ribbon/docket along the bottom of the screen**
from which widgets drag-drop into the page — or into their own window.
- **Collapsed default**: a thin bottom strip (grab handle + widget count). Expands on click or
  hotkey; auto-collapses after a drag completes. State persisted `skycruncher.ribbon.collapsed`
  (default collapsed).
- **Content**: the full registry (~34) as chips — title, weight-tier badge, live/scaffold marker —
  horizontally scrollable. Wheel over the ribbon scrolls the ribbon (exempt from panel zoom
  semantics). Widgets whose selector currently yields null are still listed; dragged in, they render
  their honest empty state (AWAITING SOLVE / NOT MEASURED) — chips never show fake previews.
- **Drag in**: ribbon chip → dockview external-drag → drop to dock or into a tab stack. Drag a
  placed panel back onto the ribbon = remove from layout (an unplaced widget "lives" in the ribbon).
- **Drag to own window**: rides the popout rail — Phase C v1 gesture = drop onto a "new window"
  edge target; true drag-out-of-app-bounds is Phase C second half (custom OS-drag).
- **Perf**: collapsed ribbon costs zero widget render (chips are text/badges only); expanding never
  triggers data collection — weight rules apply only when a widget is PLACED.
- **Phasing**: ribbon is a **Phase B deliverable** — once the grid becomes a dockable canvas, the
  ribbon IS the add-widget affordance. Ribbon→new-window target lands with Phase C.

## 7. Persistence
- Layout per named workspace: dockview `toJSON` into **Profile schema v2** (extends workspace_store
  v1; versioned). A stale/failed layout blob resets LOUDLY to the default layout — never a silent
  partial render.
- Named workspaces mapped to upload type (CR2/FITS/ASDF) with auto-select — carried verbatim from
  the 07-09 owner spec (Phase D).
- Popout window bounds per workspace, restored on open (Phase C).
- Storage: localStorage now; migrate to `%LOCALAPPDATA%\io.skycruncher.app\` via the already-shipped
  fs plugin if profiles outgrow it. All keys/labels/event names `skycruncher.*` (brand-neutral).

## 8. Phasing + gates (each phase = its own increment, battery per GATES.md)
| Phase | Scope | Exit |
|---|---|---|
| **A — popout spike — ✅ DONE 2026-07-21** | Verdicts: (a) WebviewWindow popout WORKS — live widget in a real second OS window; (b) event bridge byte-perfect (1.05 MB receipt, sha256 match); (c) `window.open` → null (tauri#14263 confirmed). Bonus: BroadcastChannel available. Evidence: `test_results/dashboard_spike_2026-07-21/` (spike branch `spike/popout-webviewwindow` @28ccca35, unmerged by design; worktree wt-popoutspike retained as evidence) | ✅ banked; §5 architecture proceeds as written |
| **B — in-window docking** | dockview mounted behind a default-OFF flag (zero DOM when off), drag-dock + tab stacks over the full registry, bottom widget ribbon (§6b, collapsed-default palette), Profile v2 persistence, WidgetFrame/Zoom composition per §6 | UI-touching → FULL browser e2e pair byte-identical + tsc/vitest + owner look-at-the-app |
| **C1 — popout production (button-out)** | button-out (reliable); return-on-close; bounds persistence; single-widget popout via WidgetFrame | UI-touching → FULL browser e2e pair + tsc/vitest + owner walkthrough on 2 monitors |
| **C2 — popout second half (§5b)** | header/tab tear-off past the window edge → OS window at drop point; popouts promoted to FULL multi-widget DockingSurface workspaces (own tree/ribbon/splits/tabs, per-window Profile-v2 layout key); shift-drag force-split | same battery + owner 2-monitor walkthrough (WebviewWindow items walkthrough-gated; pure logic + surface-mount headless-proven) |
| **D — parity + polish** | keyboard split grammar on dockview API; per-upload-type workspace auto-select; browser-tier ruling executed | same battery |

Standing laws bind throughout: panels never feed the pipeline hot path (diag_prefs); weight tiers
keep gating render only; wizard untouched; status strings preserved; data collection never gated by
display.

## 9. Open questions for the owner sitting
1. **Decision 1** — vehicle: ~~recommend (ii)~~ **RULED (ii) — owner 2026-07-21.**
2. **Decision 2** — library: ~~recommend dockview-react~~ **RULED dockview-react — owner 2026-07-21.**
3. Popout gesture: ~~OK to ship **button-out before drag-out**?~~ **DONE — button-out shipped (C1),
   header/tab tear-off past the window edge shipped (C2, §5b); true drag-out realised via a
   capture-phase `dragend` outside-window predicate, no custom OS-drag layer needed.**
4. When Phase B's flag is ON, the docking surface **replaces** the landing/post-solve dock grid at
   the same mounts (recommended) vs living at a separate route until parity?
5. Browser tier: keep popout absent (recommended) vs build the degraded popup?

## 10. Related + citations
[WORKSPACE_DASHBOARD_DESIGN.md](../WORKSPACE_DASHBOARD_DESIGN.md) (owner spec + v1) ·
[DESKTOP_API_REMAP.md](DESKTOP_API_REMAP.md) (v3 dependency, re-cited) ·
[UI_STYLE_GUIDE.md](../UI_STYLE_GUIDE.md) · [WEBGPU_RENDER_PLAN.md](WEBGPU_RENDER_PLAN.md) §7 ·
widgets-zoom directive (memory 2026-07-21).
Research sources: github.com/tauri-apps/tauri/issues/14263 (window.open blocked) ·
dockview.dev/docs/core/groups/popoutGroups (popout API, same-origin) ·
v2.tauri.app/reference/javascript/api/namespacewebviewwindow + v2.tauri.app/develop/calling-frontend
(WebviewWindow, emit_to/listen) · github.com/mathuo/dockview (v7.0.2, MIT) ·
github.com/caplin/FlexLayout · github.com/ok-very/autoart/issues/62 (Electron popout analog:
window registry + typed IPC + popout-mode SPA — the same shape with Tauri events replacing IPC).
