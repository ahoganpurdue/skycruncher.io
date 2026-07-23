# tools/intake/alpaca — Seestar live-session frame intake (ASCOM Alpaca)

Receive and ingest frames from a ZWO Seestar (S30 Pro target) over the LAN via its
device-native **ASCOM Alpaca** REST surface (Station mode). Plain Node, **no new
deps**. This is the *intake* wave: get frames off the scope and into the Solve
Queue. Live device **control** (goto / capture / dither) is a separate follow-up
wave — this lane only reads frames.

Reuses the vetted Alpaca client + reliability helpers from the existing control
lane (`tools/seestar/lib.mjs`) and the FITS writer (`tools/stack/fits_io.mjs`).

## Files
- `alpaca_probe.mjs`   — one-shot, read-only capabilities probe. Enumerates the
  management API's configured devices + each device's interface surface and prints
  the verdict that decides the control-wave design: **NATIVE_GOTO** (Telescope
  device exposes slew) vs **CAMERA_ONLY** (needs the seestar_alp bridge for goto).
  Never connects, never slews, never exposes.
- `alpaca_watcher.mjs` — the live-session watcher. Connects the telephoto camera,
  acquires frames (drive mode = commands exposures; `--watch` = passive), writes
  each as FITS into the `D:\AstroLogic\intake` layout, appends an idempotent JSONL
  journal, and (with `--enqueue`) drops each frame into the Solve Queue.
- `mock_seestar.mjs`   — a minimal Alpaca server impersonating a Seestar, enough to
  drive the watcher + probe end-to-end **headlessly** (no device). Serves a
  deterministic synthetic star-field by default, or a real FITS via `--fits`.
- `alpaca_image.mjs`   — pure ASCOM image-wire codec (imagebytes / imagearray ↔
  Float32 planes), encode + decode, unit-tested round-trip.
- `alpaca_cycle.test.mjs` — the vitest gate (codec round-trip, watcher×mock full
  cycle, idempotency, device-vanish resilience, enqueue, probe verdict).
- `LIVE_TEST_CHECKLIST.md` — owner runbook for the live leg (Wed/Thu before Friday).

## Quick start (mock, no device)
```
# terminal 1 — fake a Seestar serving a real solvable frame:
node tools/intake/alpaca/mock_seestar.mjs --port 32323 --fits public/demo/seestar_m66_sample.fit

# terminal 2 — probe it, then ingest 3 frames:
node tools/intake/alpaca/alpaca_probe.mjs   --host 127.0.0.1
node tools/intake/alpaca/alpaca_watcher.mjs --host 127.0.0.1 --exposure 2 --max-frames 3 \
    --out-dir ./_alpaca_demo --session-id demo01 --enqueue --enqueue-dir "Sample Files/rotating"
```

## Live device
```
node tools/intake/alpaca/alpaca_probe.mjs   --discover                 # find + fingerprint the scope
node tools/intake/alpaca/alpaca_watcher.mjs --host 192.168.68.<n> --exposure 10 --enqueue
```
See `LIVE_TEST_CHECKLIST.md` for the full Station-mode procedure.

## Watcher modes
| Mode | Flag | Behaviour |
|---|---|---|
| drive | (default) | The watcher IS the controller: `startexposure` → poll `imageready` → download → repeat. **Single-controller** — do NOT run the Seestar phone app concurrently. |
| watch | `--watch` | Passive: never commands an exposure; downloads each NEW frame the device produces (dedup on the frame's `ServerTransactionID`). |

Key flags: `--exposure <s>` `--interval <s>` `--max-frames <n>` `--duration <s>`
`--out-dir <p>` `--session-id <id>` `--enqueue [--enqueue-dir <p>]` `--poll-ms <n>`
`--dry-run`.

## Guarantees
- **Idempotent** — re-running the same `--session-id` resumes the sequence from the
  journal, never re-downloads a known frame id, never clobbers an existing file.
- **Resilient** — a device that vanishes mid-session (dropped WiFi / powered off) is
  retried with bounded exponential backoff; the watcher logs LOUDLY and keeps going,
  never crashes, and records honest `status:"failed"` journal rows.
- **Honest-or-absent** (LAW 3) — pointing/exposure FITS cards (`OBJCTRA`/`OBJCTDEC`/
  `ALT_OBS`/`AZ_OBS`) are emitted only when the device actually returns them; unread
  values are simply absent, never fabricated.
- **Storage law** — writes only under `D:\AstroLogic\intake` by default (never K:, a
  thin virtual disk). Tests override `--out-dir` to a temp dir.

## Solve Queue integration (the contract)
The queue's **Intake Folder** lane (`src/engine/ui/dashboard/solve_queue/connectors.ts`,
`id: 'intake-dir'`) is purely filesystem-based: it enumerates the **immediate**
(non-recursive, flat) supported files of a re-mappable directory
(`.fits/.fit/.CR2/.raf/.xisf/.jpg/.png`) via `isSupportedFilename()`. **No manifest
is required**; a `<file>.provenance.json` sidecar is optional read-only metadata.

Two ways to feed it:
1. **Re-map** the Intake Folder card at the watcher's session dir
   (`<out-dir>/<session-id>/`) — frames land there flat, done.
2. **`--enqueue`** — the watcher additionally copies each frame (flat) into the
   queue's default intake lane (`--enqueue-dir`, default `Sample Files/rotating/`)
   with a `.provenance.json` sidecar, so the default lane picks it up with zero
   re-mapping.

## Journal (per session)
`<out-dir>/<session-id>/session.jsonl` — append-only: a `session_start` row, one
`frame` row per frame (`status:"ok"` with `seq`/`frame_id`/`file`/`bytes`/`sha256`/
geometry/pointing/`enqueued`, or `status:"failed"` with a reason), and a
`session_end` row. The journal is the idempotency ledger on re-run.

## Tests
```
npx vitest run tools/intake/alpaca/alpaca_cycle.test.mjs
```
All tests are asset-independent (synthetic frames) and deterministic.
