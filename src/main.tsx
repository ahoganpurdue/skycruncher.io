
import React from 'react'
import ReactDOM from 'react-dom/client'
import MainApp from './MainApp'
import './index.css'
import { initDesktopAutoUpdate } from './desktop/updater'
import { initDesktopWindowFit } from './desktop/window_fit'
import { migrateLegacyPersistKeys } from './engine/ui/persist_migration'
import { initTheme } from './engine/ui/theme/theme_state'

// One-time, non-destructive migration of legacy `astrologic.*` localStorage keys
// to the `skycruncher.*` namespace (SkyCruncher rename, LAW 6). Runs before the
// first render so every preference read sees the migrated value. No-op headless.
migrateLegacyPersistKeys()

// Stamp <html data-theme> from the persisted preference SYNCHRONOUSLY, before the
// first render, so a night/light user never sees a bright default-theme flash
// (render plane; presentation only — no data touched). Runs for every route.
initTheme()

// Read-only Widget Shelf (owner-requested receipt-drop viewer). Reached ONLY via
// the `#/widgets` hash — a fully separate top-level page that imports NOTHING from
// the wizard flow. Hash routing needs zero server/vite config (index.html always
// loads; the branch is client-side). Root with no hash → MainApp, unchanged. Lazy
// so the widget-registry graph stays off the normal app's boot path.
const WidgetShelf = React.lazy(() =>
  import('./engine/ui/widgets/WidgetShelf').then(m => ({ default: m.WidgetShelf }))
)

// Desktop test rail v0 (branch rail/desktop-v0, NEVER merges). Reached ONLY via the
// `#/testrail` hash — a self-driving measurement host that imports live src paths and
// drives the real webview→Rust seam + native wgpu demosaic. Lazy so it stays off the
// normal boot path.
const TestRailHost = React.lazy(() =>
  import('../tools/desktop_rail/webview/TestRailHost').then(m => ({ default: m.TestRailHost }))
)

// Popped-out dashboard widget (DASHBOARD_DOCKING_SPEC §5, Phase C). Reached ONLY
// via `#/popout?panel=<widgetId>&window=<label>` inside a Tauri WebviewWindow the
// main window opens. Mounts ONE registry widget through WidgetFrame from the
// bridged receipt — a subscriber-only page (no wizard/session contact). Lazy so
// the docking graph stays off the normal boot path.
const PopoutHost = React.lazy(() =>
  import('./engine/ui/widgets/docking/PopoutHost').then(m => ({ default: m.PopoutHost }))
)

function isWidgetShelfRoute(): boolean {
  const h = window.location.hash
  return h === '#/widgets' || h === '#widgets'
}
function isTestRailRoute(): boolean {
  const h = window.location.hash
  return h === '#/testrail' || h === '#testrail'
}
function isPopoutRouteHash(): boolean {
  const h = window.location.hash
  return h === '#/popout' || h.startsWith('#/popout?')
}

const Root: React.FC = () =>
  isTestRailRoute()
    ? <React.Suspense fallback={null}><TestRailHost /></React.Suspense>
    : isPopoutRouteHash()
      ? <React.Suspense fallback={null}><PopoutHost /></React.Suspense>
      : isWidgetShelfRoute()
        ? <React.Suspense fallback={null}><WidgetShelf /></React.Suspense>
        : <MainApp />

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)

// Desktop-only: clamp the fixed 1400×900 window down to the monitor work area on
// small laptop screens, then center (no-op in the browser via guard). Runs before
// the update check so the shell is on-screen while the (network) update resolves.
void initDesktopWindowFit()

// Desktop-only: check for an update on startup (no-op in the browser via guard).
void initDesktopAutoUpdate()
