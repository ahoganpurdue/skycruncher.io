# tools/seestar — Seestar S30 Pro probe + control lane

Zero-install, device-native control for a ZWO Seestar (S30 Pro target) over the LAN.
Plain Node (`net`/`dgram`/`http`/`fs`) — **no new deps**. This is the first OPERATE
increment of the telescope PLAN/OPERATE loop.

## Files
- `lib.mjs`   — shared: TCP probe, Alpaca UDP discovery, **Alpaca REST client** (`alpacaApi`/`alpacaValue`), generic HTTP, native 4700 JSON-RPC client, Sun ephemeris + angular-separation + alt/az math, and the **reliability helpers** (`retryWithBackoff`/`isTransientError`, `slewWatchdog`, `resolveSite`/`siteTrustedForVerdicts`/`pickCachedSite`, `planResume`).
- `lib.nodetest.mjs` — offline unit tests for the reliability helpers (built-in `node:test`, **no device required** — transport injected/mocked; named outside vitest's `*.test.*` glob so the vitest gate never collects it). Run: `node --test tools/seestar/lib.nodetest.mjs`.
- `probe.mjs` — LAN discovery (Alpaca broadcast + /24 TCP connect-scan + device inspect).
- `ctl.mjs`   — control CLI (`status`/`connect`/`disconnect`/`goto`/`solar`/`expose`/`stop`/`pull`/`suntest`/`sweep`), **Alpaca-first** with native fallback.

## Reliability (sequence riders — offline unit-tested in `lib.nodetest.mjs`)
- **Retry + resume** — sequence-critical Alpaca calls in `sweep` retry TRANSIENT transport
  errors (dropped WiFi: `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`timeout`/HTTP 5xx) with
  bounded exponential backoff (`--retries` default 4, `--retry-base-ms` default 500, x2, cap
  8000ms). Device-level ASCOM errors (`#1031` etc.) never retry-mask. A `sweep` checkpoints
  each completed pointing to `test_results/seestar/<sweep-id>.checkpoint.json`; `--resume`
  restarts from the last incomplete point (an ABORTed point re-runs). Checkpoint is keyed on
  device+exposure+site+count so a different sweep never resumes onto a stale one.
- **Slew watchdog** — `sweep` polls `slewing` after each slew; if the mount doesn't settle
  within `--slew-timeout` (default 120000ms) it **aborts the slew, logs LOUDLY, and fails
  that step honestly** (status `SLEW_TIMEOUT`) — it never fabricates a settled state (LAW 3).
- **Observer site ladder** — `--lat/--lon` (config) **>** live device GPS **>** device-gps-cached
  (last-known for THIS device serial, carries `fix_iso`) **>** absent. Explicit config always
  wins; a live device fix refreshes the per-serial cache (`site_cache.json`); the cache is
  keyed by device serial so it never crosses devices. Frames record `SITESRC` (+ `SITEFIX`
  when cached) provenance. **Honesty boundary:** cached/absent sites feed HINT-shaped consumers
  only (slew planning); `siteTrustedForVerdicts()` gates verdict products (ephemeris/alt-az
  science) to `config`/live `device-gps` — parallel to the trusted-clock gate. `sweep` REFUSES
  an absent site rather than fabricate one; no coordinate literal ever appears in product code.

## Transport (Alpaca-first, native fallback)
`ctl.mjs --transport auto` (default) uses the ASCOM **Alpaca REST** surface (`http://<ip>:32323/api/v1/...`)
when its management API answers, else falls back to native JSON-RPC on 4700. Override with
`--transport alpaca|native`. **RA is in HOURS on BOTH transports** (ASCOM convention == our internal
`crval` convention) — no unit conversion. Alpaca is standard clean-room HTTP against the public ASCOM
spec; no bundled GPL. The 15° Sun filter-confirm gate sits in the shared verb path, BEFORE transport
dispatch, so it applies to every transport identically.

**Live-confirmed 2026-07-17 (device 192.168.68.70, fw ManufacturerVersion 1.2.0-3):** Alpaca :32323
healthy — 7 devices (telescope/0, camera 0=tele 1=wide, focusers, filterwheel/0, switch/0); read-only
`status` returns telescope props (connected/tracking/slewing/atpark/ra/dec/alt/az), filterwheel
position, and honestly surfaces camera `#1031 not-connected` until `connect`. **Native :4700 is OPEN but
`get_device_state`/`get_view_state` TIMED OUT silently on this firmware** (likely phone-app-held session
or fw framing change) — native code is retained as a documented fallback, not debugged.

## Source docs (READ FIRST — our docs precede the web)
- `test_results/demo_2026-07-24/SEESTAR_CONTROL_API.md` — native 4700 JSON-RPC method vocabulary; device-native ASCOM Alpaca since fw `alpaca_v1.1.2-1`; `set_stack_setting` (save-each-frame) is API-settable; ruled hybrid (generic Alpaca primary + native 4700 for gaps).
- `test_results/telescope_workflow_2026-07-16/TELESCOPE_WORKFLOW_SPEC_DRAFT.md` — the PLAN/OPERATE loop; native Alpaca is the adopted hub; sun interlock via Meeus.
- `test_results/seestar_alpaca_research_2026-07-17/NOTES.md` — ports table; S30 Pro Alpaca REST on **:32323** (indi-seestar, Alpha, 48/52 GET on fw v1.1.2-1); **RA/Dec goto only, alt/az NOT exposed**; single-controller hazard; clock/site trust for FITS DATE-OBS.

## Ports
| Port | Proto | Use |
|---|---|---|
| 4700 | raw-TCP JSON-RPC | control + file listing (newline-framed `json\r\n`, incrementing id) |
| 32227 | UDP | ASCOM Alpaca discovery broadcast (`alpacadiscovery1`) |
| 4720 | UDP | native discovery (format undocumented; best-effort) |
| 80 | HTTP | single-file download |
| 445 | SMB | folder download / delete (Windows `robocopy \\<ip>\<share>`) |
| 32323 | HTTP (Alpaca REST) | S30 Pro native Alpaca surface (fw-dependent) |

## Verbs
| Verb | Flags | Alpaca | Native (fallback) |
|---|---|---|---|
| `status` | | telescope/filterwheel/camera props | `get_device_state` + `get_view_state` |
| `connect`/`disconnect` | | PUT `telescope/0/connected` | (n/a — app holds session) |
| `goto` | `--ra <h> --dec <deg> [--name N]` | connect→tracking→`slewtocoordinatesasync` (sync fallback) | `iscope_start_view` (goto + on-device solve) |
| `solar` | `--filter-confirmed [--lat --lon]` | `slewtocoordinatesasync` to Sun | `scope_goto` (raw, no solve) |
| `expose` | `--secs <n> [--gain g]` | (native) | set exposure+gain, `iscope_start_stack` |
| `stop` | | `abortslew` | `iscope_stop_view` |
| `pull` | | (native) | list eMMC frames + download newest → `D:\AstroLogic\intake\seestar_live_2026-07-17\` |

Common flags: `--transport auto\|alpaca\|native` · `--alpaca-port <n>` (default 32323) · `--host <ip>` · `--dry-run` (print the request, send nothing) · `--lat/--lon` (east-positive lon) · `--timeout <ms>`.

```
node tools/seestar/probe.mjs                        # scan the box /24
node tools/seestar/ctl.mjs status  --host 192.168.68.70          # read-only, safe
node tools/seestar/ctl.mjs connect --host 192.168.68.70
node tools/seestar/ctl.mjs goto --ra 18.615 --dec -13.78 --name M8 --dry-run
node tools/seestar/ctl.mjs solar --filter-confirmed --lat 40.5 --lon -75.1
node tools/seestar/ctl.mjs pull --host 192.168.68.70
```

## SAFETY RULES (enforced in code — non-negotiable)
1. **FILTER-CONFIRM gate** — any `goto`/`solar` within **15°** of the Sun REFUSES (exit 3) unless
   `--filter-confirmed` is passed explicitly. `solar` is 0° from the Sun, so it ALWAYS requires the flag.
   The flag is an assertion that a certified solar filter is fitted; the CLI cannot verify optics.
2. **Single-controller** — a banner prints on every `ctl` run: do NOT run the Seestar phone app while
   this CLI drives the scope. Native 4700 is single-owner; concurrent control desyncs device state.
3. **No alt/az forcing** — we only ever send RA/Dec targets. Firmware owns alt/az limits and slew safety.

## Storage
`pull` writes ONLY to `D:\AstroLogic\intake\seestar_live_2026-07-17\` (aborts if D: is absent).
**Never K:** — K: is a thin virtual disk (storage law).

## Honest status of the control surface
- **Verified working against the LIVE device (192.168.68.70, fw 1.2.0-3):** Alpaca-first auto-transport
  selection, read-only `status` (management description + telescope/filterwheel/camera props, camera
  `#1031` surfaced honestly). No slew was issued — motion verbs verified only via `--dry-run`.
- **Verified offline (no device):** probe (clean "no device" on an empty LAN), all safety gates
  (Sun refusal exit 3, transport-agnostic), dry-run plumbing for goto/solar/stop/connect (Alpaca +
  native), Sun ephemeris (~0.01° class), alt/az horizon warn.
- **NOT yet exercised live (needs owner-watched run):** Alpaca `connect`, `slewtocoordinatesasync`
  (incl. whether tracking-enable is required and whether async vs sync is accepted), `abortslew`.
  These are standard ASCOM against the public spec; the dry-run prints the exact request sequence.
- **Native 4700** — port OPEN but `get_device_state`/`get_view_state` TIMED OUT on fw 1.2.0-3 (phone-app
  session or fw framing). Left as a documented fallback; method names/param schemas remain community
  reverse-engineering (`seestar_alp`/`indi-seestar`), unconfirmed on S30 Pro.
- **`pull` download path** — native listing method + HTTP :80 path convention are device-specific and
  unconfirmed; `pull` tries listing methods in order and reports verbatim, and prints the RELIABLE
  Windows SMB fallback (`robocopy \\<ip>\<share>`) when HTTP can't resolve.

## Next increment (NOT tonight's scope) — elevation-ladder capture
A scheduler script (`ladder.mjs`, planned) will drive same-field repeat visits on a timer so a fixed
field is sampled across airmass as it transits (NOTES.md pseudocode): `goto` → wait-for-stack → `pull`
→ sleep(20min) → repeat, plus a few deliberately-chosen fields transiting at different altitudes.
Requires: NTP-synced PC clock + site set so FITS DATE-OBS/site are trusted (feeds `timestampTrusted`
/ ephemeris gates). Consumes a PLAN-mode SessionPlan (`tools/scope/session_plan.mjs`, rest-integration)
once the trees reconcile.
