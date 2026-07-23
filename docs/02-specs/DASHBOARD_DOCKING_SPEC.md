<!-- ACTIVE: dockview adopted as the docking engine (Decisions 1+2); phased build per §8 -->
# Dashboard Docking — Drag-and-Drop, Tab Stacks, Pop-Out Windows — SPEC

This spec covers drag-and-drop docking, tab-stacking, and pop-out windows for the desktop
dashboard: rearranging modules by dragging, dragging one module onto another to form a tab
group, and pulling a widget out of the main window into its own OS window (including a second
monitor). It is the build-out delta against
[WORKSPACE_DASHBOARD_DESIGN.md](../WORKSPACE_DASHBOARD_DESIGN.md), which holds the original
intent and v1 architecture; this document holds the current measured state, the two settled
architecture decisions below, the pop-out design under measured Tauri constraints, and the
phased build gates (§8).

**Status: ACTIVE.** Decision 1 (adopt a docking library rather than extend the hand-rolled v1
layout tree) and Decision 2 (dockview-react as that library) are both settled; §9 items 4-5
remain open, proceeding on their recommended defaults unless revisited. Phase A (the pop-out
feasibility spike) is complete.

## 1. Scope, mapped to the original design
The build-out re-affirms the original design nearly 1:1: drag-out second window, tab groups
from overlapping widgets, named per-upload-type workspaces. What was never built is v2 (drag
ergonomics) and v3 (Tauri multi-window). This spec is the build order for those, with one
change of approach from the original design: adopt a maintained docking engine for the
in-window half instead of extending the hand-rolled v1 tree.

## 2. Measured state (file:line as of this revision)
The dashboard actually in use is not the component the original design built — this table
makes that gap explicit before build work starts.

| Surface | State | Evidence |
|---|---|---|
| **WidgetDock + ReplayDashboard** (the live dashboard) | LIVE, default-ON; CSS grid `repeat(auto-fill,minmax(280px,1fr))`; NO drag/resize/popout; persistence = enable/weight flags only, no positions | WidgetDock.tsx:196, :17; registry.ts:167,195,272; MainApp.tsx:216-246, :405 |
| **WorkspaceHost v1** (what the original design built) | Merged, flag-off, unmounted since; recursive Split/Leaf tree, tab bar + close, keyboard splits, Profile schema v1 in localStorage | WorkspaceHost.tsx:120-155; workspace_store.ts:36,55 |
| **WidgetShelf** `#/widgets` | LIVE standalone page, own React branch, renders any widget from a bare receipt JSON with zero wizard/session contact — the existence proof for pop-out rendering | main.tsx:19-31; WidgetShelf.tsx:232-241, :328 |

Widget contract: ~34 registered widgets, each a **pure function** — `dataSelector(receipt, events) → data`,
`Render({data})` (registry.ts:111-145). Two exceptions a popout must handle: `starplate_library`
(env/native-store-driven, already window-independent via invoke) and replay-aware widgets
(read `ReplayContext`, degrade honestly to null when absent — ReplayContext.tsx:54-60).

Tauri: v2.10.3, ONE window (tauri.conf.json:13-21). `src-tauri/capabilities/default.json` grants
`core:default` (that's where today's `invoke()` IPC permission comes from). No
`@tauri-apps/api/event` usage in the frontend at the time of writing — cross-window plumbing was
greenfield and is now spike-proven (§5).

## 3. Decision 1: the vehicle
The original design targeted WorkspaceHost; the dashboard actually in use is
WidgetDock/ReplayDashboard. No document had decided which one carries the drag/dock/pull-out
program. Options considered:

- **(i) Resurrect WorkspaceHost** and hand-build drag ergonomics on its tree. Cost: drag ghosting,
  5-zone drop-target math, tab reparenting/focus/z-order, sash resizing — the multi-week trap;
  teams building VS-Code-grade docking do this in-house at real cost, and we should not.
- **(ii) Adopt a docking library as the layout engine (adopted).** The docking surface replaces
  WidgetDock's grid when enabled (same mount points, flag-gated). WorkspaceHost's layout TREE is
  superseded; its Profile/named-workspace/typeMap concepts and keyboard-split grammar carry over
  (grammar reimplemented on the library API in Phase D). Honest cost: retires an already-merged
  v1 component; the tree and its unit tests remain in git history.
- **(iii) Bolt drag onto the live grid incrementally.** Dead end — grid drag doesn't compose into
  tab stacks or popout; work gets thrown away.

**Decision: (ii), adopted.**

## 4. Decision 2: the library

| Library | License | Maintenance | Dock / tab-stack / popout | Fit |
|---|---|---|---|---|
| **dockview-react** (adopted) | MIT | actively maintained (v7.0.2), very active, zero-dep core | dock / tab-stack (drop-on-center) / first-class popout (`addPopoutGroup`) + floating groups; `toJSON/fromJSON` incl. popout state | React ≥16.8 → our 18.2 clean; VS Code feel |
| flexlayout-react | ISC | active, Caplin (trading UIs) | dock / native tabsets / `enablePopout` | solid fallback; smaller surface |
| rc-dock | permissive (unverified) | latest major in alpha, small community | dock / tab-stack / popout | second-tier |
| golden-layout | MIT | stale on npm | dock / tab-stack / popout | ruled out — no first-class React |

Reality check: VS Code uses a bespoke in-house layout (no npm docking library); Theia/JupyterLab
use Lumino. dockview models the VS Code feel without their team size. Decisive shared caveat:
every library's popout rides `window.open` — see §5; the popout is ours to build regardless of
choice, so the library decision only buys the in-window ~90%.

**Decision: dockview-react, adopted.**

## 5. Popout — the hard part (built in-house, library-independent)
- **Confirmed on-box (Phase A): `window.open()` returns `null` — no window, ever**
  (tauri#14263 reproduced on our exact build). dockview's native popout is dead here; the
  WebviewWindow substitute below is mandatory — and now proven.
- **Tauri-native path — proven end-to-end (Phase A)**: `WebviewWindow` per popped panel; popout =
  the SAME SPA at `#/popout?panel=<widgetId>` mounting ONE panel through WidgetFrame. Measured on
  this box: popout opened, registry widget rendered LIVE data from the bridged receipt, CSP-clean,
  `getAllWebviewWindows()` enumerates both. Permissions (measured, additive capability file scoped
  to window labels `["main","popout-*"]` — the glob is REQUIRED or popouts get zero perms):
  `core:default` already covers listen/emit/emit-to; the only genuinely new ids are
  `core:webview:allow-create-webview-window` and `core:webview:allow-get-all-webviews` (exact id —
  NOT `…-webview-windows`; the build-time ACL codegen hard-fails on unknown ids and dumps the valid
  set). Note: any capability edit requires an app-crate rebuild (first cold build ~10-15 min; warm ~2 min).
- **State bridge**: `@tauri-apps/api/event` — main window is the single producer, `emit_to(label, …)`
  serialized `{receipt, events, replayFrame}`; popouts are subscribers only. Proven (Phase A): a
  1.05 MB receipt survived `emit_to`→serde→receive byte-perfect (sha256 match both ends + on-disk
  fixture). BroadcastChannel across Tauri webviews is measured available same-origin (this refuted
  an earlier assumption that it was unavailable) — permitted as supplementary only; the Tauri event
  bridge stays primary (typed, targeted, window-lifecycle-aware).
- localStorage is shared same-origin → prefs sync free; layout state has ONE writer (main window).
- Popout close → panel returns to the main layout (or an honest empty slot); main-window crash/restart
  → popouts reopen from persisted bounds (Phase C).
- **Browser tier: popout affordance ABSENT** (honest-or-absent — no degraded pop-up unless we decide
  otherwise; the original design's browser-popup tier stays a future item).

## 5b. Popout — Phase C second half: tear-off, multi-widget workspaces, shift-split
This phase adds three behaviors: (1) grab a widget by its header, drag past the window edge,
release, and it becomes an OS window at the drop point; (2) pop-out windows become full
recursive docking workspaces — own dockview surface, own splits/tabs, own ribbon, capable of
holding many widgets across panels and tabs; (3) shift-drag force-splits (never tabs) if
dockview's drag layer permits modifier reads. Built on the Phase C plumbing
(popout_bridge/popout_store/usePopoutManager/PopoutHost); render plane only.

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
solved here). Capture phase matters — it beats dockview's target-phase transfer-clear, so
the recorded drag survives to `dragend`.

**(2) Multi-widget popout workspaces.** The `#/popout` page is promoted from a single `WidgetFrame`
to a FULL `DockingSurface` instance — its own dockview tree, its own bottom ribbon (full registry),
its own splits/tabs — seeded with the one widget it was popped from and growing as chips are
dragged from the popout's own ribbon. The popout is `fillViewport` (window height)
so its surface is ALWAYS in view → its ribbon always renders. It stays a SUBSCRIBER (§5): the main
window's single-producer broadcast (`emit_to` {receipt,events,replayFrame}) reaches it, and every
docked widget in the popout reads that one bridged receipt through `DockingDataContext` — all widgets
subscribe identically, for free. The popout surface is `popoutEnabled={false}`: its own popout manager
is inert (it never spawns further OS windows — only the main window owns window lifecycle), so no popout button
and no tear-off inside a popout. **Per-window layout persistence** (Profile v2 additive — same schema
version 2, new keys, no bump): each popout persists to `popoutLayoutStorageKey(widgetId)` =
`skycruncher.docking.profile.popout.<widgetId>`, keyed by the SEED widget (windows are ephemeral —
`popout-<panelId>` regenerates each pop; the seed widget is the reproducible identity, matching how
popout_store keys bounds). A popout reopened for the same seed restores its full multi-widget tree.
Bookkeeping: a widget lives in EXACTLY ONE place — the main tree, or one named popout tree. Moving a
widget between windows in v1 is via the ribbon in each window (add on one side, drop-to-remove on the
other); cross-window DRAG is out of scope for now (Phase D).

**(3) Shift-split — dockview permits modifier reads via its public API.** Every drop
hook carries a live `nativeEvent: DragEvent` whose `.shiftKey` is populated on `dragover`
(component.api.d.ts: `onWillShowOverlay`/`onWillDrop`/`onDidDrop`; events.d.ts:24-38). Mechanism:
`api.onWillShowOverlay` fires per drop-zone for BOTH internal tab moves and external ribbon-chip drags
and exposes `nativeEvent` + `position` + `kind` + `preventDefault()`. We `preventDefault()` the
tab/center zone whenever shift is held (`shouldBlockTabDrop(kind, position, shiftKey)` = shift &&
(`kind==='tab'` || `position==='center'`)) — suppressing the tabbing overlay so only edge SPLIT zones
accept the drop. This is "shift = never tab," uniform across internal and external drags, using only
the public API (no dockview-internals patch). Defensive belt for ribbon chips: `onDidDrop` also remaps
a shift+center drop to a split via `splitDirectionForShift`. Scope note: a STRONGER
"center-drop auto-splits to a chosen side" (rather than "center disabled under shift") would need
`onWillDrop.preventDefault()` + a manual remove/re-add, which the API docstring flags as fragile
("unexpected behaviours"); not taken — overlay-suppression is the clean win.

**Verification.** Pure logic proven headless in vitest: `isOutsideWindow` bounds
math, `tearOffBounds` (size-from-persisted / position-from-drop), `popoutLayoutStorageKey` per-window
keying, `shouldBlockTabDrop` / `splitDirectionForShift`. A live-browser Playwright check
(`tools/e2e/verify_popout_surface.mjs`, ribbon-verify pattern) asserts the `#/popout?panel=…` page
mounts a full `DockingSurface` + `widget-ribbon` on a fresh Vite port. The `WebviewWindow` itself
(actual OS window, cross-monitor drop, bounds persistence) CANNOT be exercised headlessly — it is
enumerated in a two-monitor walkthrough: tear a header past each screen edge → window at the
drop point; drag 10+ chips into a popout across splits+tabs; shift-drag forbids tabbing; close/return
re-docks; reopen restores the popout's tree + bounds.

## 6. Chrome ownership — one LAW-3 enforcement point
Three layers, one owner each; no layer duplicates another's job:
- **Docking manager** (dockview): placement, sashes, tab bars, close, popout button.
- **WidgetFrame**: title, intent-help, weight badge, and the honest-or-absent empty-state taxonomy —
  SOLE owner. (WorkspaceHost's bespoke NOT-MEASURED div, WorkspaceHost.tsx:83-102, is the drift
  counter-example: it gets folded back, never repeated.)
- **ZoomPanViewport** (in flight per the widgets-zoom requirement): wheel/pinch zoom +
  pan/reset around the Render mount only. Composes unchanged inside docked panels and popout windows.
  WebGL widgets that own their wheel (flattening_cascade, lens_profile_3d) stay exempt.

## 6b. Widget ribbon — the add-widget palette
This phase adds a **collapsed-by-default scrolling ribbon** along the bottom of the screen,
from which widgets drag into the page — or into their own window.
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
  the original design (Phase D).
- Popout window bounds per workspace, restored on open (Phase C).
- Storage: localStorage now; migrate to the app's persistent local data directory via the
  already-shipped fs plugin if profiles outgrow it. All keys/labels/event names use the
  `skycruncher.*` prefix (brand-neutral).

## 8. Phasing + gates (each phase = its own increment, battery per GATES.md)
| Phase | Scope | Exit |
|---|---|---|
| **A — popout spike — done** | Verdicts: (a) WebviewWindow popout WORKS — live widget in a real second OS window; (b) event bridge byte-perfect (1.05 MB receipt, sha256 match); (c) `window.open` → null (tauri#14263 confirmed). Bonus: BroadcastChannel available. Evidence retained on a separate branch as a spike record. | Banked; §5 architecture proceeds as written |
| **B — in-window docking** | dockview mounted behind a default-OFF flag (zero DOM when off), drag-dock + tab stacks over the full registry, bottom widget ribbon (§6b, collapsed-default palette), Profile v2 persistence, WidgetFrame/Zoom composition per §6 | UI-touching → FULL browser e2e pair byte-identical + tsc/vitest + look-at-the-app walkthrough |
| **C1 — popout production (button-out)** | button-out (reliable); return-on-close; bounds persistence; single-widget popout via WidgetFrame | UI-touching → FULL browser e2e pair + tsc/vitest + walkthrough on 2 monitors |
| **C2 — popout second half (§5b)** | header/tab tear-off past the window edge → OS window at drop point; popouts promoted to FULL multi-widget DockingSurface workspaces (own tree/ribbon/splits/tabs, per-window Profile-v2 layout key); shift-drag force-split | same battery + two-monitor walkthrough (WebviewWindow items walkthrough-gated; pure logic + surface-mount headless-proven) |
| **D — parity + polish** | keyboard split grammar on dockview API; per-upload-type workspace auto-select; browser-tier decision executed | same battery |

Standing rules bind throughout: panels never feed the pipeline hot path (diag_prefs); weight tiers
keep gating render only; wizard untouched; status strings preserved; data collection never gated by
display.

## 9. Open questions
1. **Decision 1** — vehicle: (ii), adopted.
2. **Decision 2** — library: dockview-react, adopted.
3. Popout gesture: button-out before drag-out — done. Button-out shipped (C1);
   header/tab tear-off past the window edge shipped (C2, §5b); true drag-out realized via a
   capture-phase `dragend` outside-window predicate, no custom OS-drag layer needed.
4. When Phase B's flag is ON, should the docking surface **replace** the landing/post-solve dock grid
   at the same mounts (recommended), or live at a separate route until parity?
5. Browser tier: keep popout absent (recommended), or build the degraded popup?

## 10. Related + citations
[WORKSPACE_DASHBOARD_DESIGN.md](../WORKSPACE_DASHBOARD_DESIGN.md) (original spec + v1) ·
[DESKTOP_API_REMAP.md](DESKTOP_API_REMAP.md) (v3 dependency, re-cited) ·
[UI_STYLE_GUIDE.md](../UI_STYLE_GUIDE.md) · [WEBGPU_RENDER_PLAN.md](WEBGPU_RENDER_PLAN.md) §7 ·
the zoom/pan requirement for widgets referenced in §6.
Research sources: github.com/tauri-apps/tauri/issues/14263 (window.open blocked) ·
dockview.dev/docs/core/groups/popoutGroups (popout API, same-origin) ·
v2.tauri.app/reference/javascript/api/namespacewebviewwindow + v2.tauri.app/develop/calling-frontend
(WebviewWindow, emit_to/listen) · github.com/mathuo/dockview (v7.0.2, MIT) ·
github.com/caplin/FlexLayout · github.com/ok-very/autoart/issues/62 (Electron popout analog:
window registry + typed IPC + popout-mode SPA — the same shape with Tauri events replacing IPC).
