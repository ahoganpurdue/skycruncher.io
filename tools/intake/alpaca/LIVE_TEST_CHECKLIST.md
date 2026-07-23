# Seestar LIVE intake — owner runbook (run Wed/Thu before the Friday demo)

Goal: with the real Seestar S30 Pro powered on, confirm the watcher receives frames
over Alpaca and the Solve Queue solves them. Do this at least once before Friday so
the demo has a known-good path (and a known fallback).

Prereqs: PC and Seestar on the **same LAN / same `/24`** (e.g. `192.168.68.x`);
PC clock NTP-synced (a wrong clock poisons FITS `DATE-OBS` and downstream ephemeris
gates). Run everything from the repo root.

---

## STEP 1 — Put the Seestar in Station mode, then PROBE it (do this first)
Station mode = the scope joins your home WiFi instead of hosting its own AP:
1. Power on the Seestar. In the ZWO Seestar phone app: **Settings → Station Mode →
   join your home WiFi** (same network as the PC). Wait for it to reconnect.
2. **Close the phone app** (or at least stop it driving the scope) — the native
   control channel is single-owner; concurrent control desyncs device state.
3. Run the capabilities probe — this is the decision point for everything after it:
   ```
   node tools/intake/alpaca/alpaca_probe.mjs --discover
   ```
   (or `--host 192.168.68.<n>` if you already know the IP; find it with
   `node tools/seestar/probe.mjs`).

   **Read the verdict line:**
   - `control surface: NATIVE_GOTO` → the firmware exposes the Telescope (goto)
     surface. Good — the ingest watcher works AND the later control wave can use
     native Alpaca goto/slew directly.
   - `control surface: CAMERA_ONLY` → only the Camera is exposed. The watcher still
     ingests frames fine; the later control wave will need the seestar_alp bridge
     (native TCP 4700) for pointing. **Tell the team which one you got** — it decides
     the control-wave design.

   The full JSON report is written to `test_results/seestar/alpaca_capabilities_*.json`.

---

## STEP 2 — Start an imaging session on the scope
Use the phone app (or, later, the control wave) to slew to a target and begin an
exposure/stack — e.g. **M66** or any bright object currently up. Confirm frames are
being taken (the app shows a live/stacked image). Then close/park the app's control
so the watcher owns the camera.

> If you want the watcher itself to command exposures (no app), skip the app session
> and let drive mode do it (STEP 3, default). If the app is stacking, use `--watch`.

---

## STEP 3 — Run the watcher
Drive mode (watcher commands the exposures — no phone app):
```
node tools/intake/alpaca/alpaca_watcher.mjs --host 192.168.68.<n> \
     --exposure 10 --interval 2 --max-frames 10 --enqueue
```
Passive mode (the app / a session is already exposing):
```
node tools/intake/alpaca/alpaca_watcher.mjs --host 192.168.68.<n> --watch --enqueue
```

What SUCCESS looks like:
- One `[frame N] WxHxNP … → frame_000N.fits` line per frame, scrolling as frames land.
- Files appearing under `D:\AstroLogic\intake\<session-id>\` (flat FITS + `session.jsonl`).
- With `--enqueue`, the same frames appearing in `Sample Files\rotating\`.
- `SESSION DONE: N frame(s), 0 failed` when you stop it (Ctrl-C or `--max-frames`).

If the scope drops off WiFi mid-run: you'll see `⚠ frame FAILED … retrying` lines,
NOT a crash. Reconnect the scope and frames resume. Nothing is lost.

---

## STEP 4 — Solve the frames in the app
1. Launch SkyCruncher. Open the **Solve Queue**.
2. **Intake Folder** card → point it at either:
   - the watcher's session dir `D:\AstroLogic\intake\<session-id>\`, or
   - `Sample Files\rotating\` if you used `--enqueue`.
3. The queue enumerates the FITS and solves them **one at a time**; the dashboard
   lights up per solve.

---

## Troubleshooting
- **Probe says UNREACHABLE / no device**: scope not in Station mode, or not on this
  `/24`. Re-check WiFi; try `node tools/seestar/probe.mjs` to scan the subnet.
- **`imageready timeout`**: exposure longer than the wait window — raise `--exposure`
  to match, or the camera isn't actually exposing (start a session first, or use drive mode).
- **Frames land but the queue doesn't see them**: the Intake Folder lane is
  **non-recursive** — point it AT the session dir, not a parent.
- **Wrong timestamps**: sync the PC clock (NTP) before capturing.

---

## Friday demo flow (and fallbacks)
**Primary:** watcher running → frames appear live → Solve Queue solves them one at a
time → dashboard lights up. Narrate: "these frames are coming off the scope right now
over the LAN."

**Fallbacks (rehearse these — clouds / no scope happen):**
1. **Mock a live scope** on the demo laptop (no sky, no hardware) serving a real frame:
   ```
   node tools/intake/alpaca/mock_seestar.mjs --fits public/demo/seestar_m66_sample.fit
   node tools/intake/alpaca/alpaca_watcher.mjs --host 127.0.0.1 --exposure 2 --max-frames 3 --enqueue
   ```
   Identical downstream flow — frames appear, the queue solves them.
2. **Bundled Demo Frames** lane in the Solve Queue (`/demo` samples) — the existing
   "WATCH A LIVE SOLVE" affordance over banked frames. Zero dependency on scope or watcher.
