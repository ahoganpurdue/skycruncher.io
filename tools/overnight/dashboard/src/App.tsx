import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar } from 'lucide-react';
import FramePicker from './FramePicker';
import RunControls from './RunControls';
import LiveLog from './LiveLog';
import ReviewPanel from './ReviewPanel';
import { getFrames, getStatus, startRun, stopRun, type Frame } from './api';

export default function App() {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [framesErr, setFramesErr] = useState<string | null>(null);
  const [framesLoading, setFramesLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [running, setRunning] = useState(false);
  const [pid, setPid] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [logGen, setLogGen] = useState(0);        // bump to re-open the log stream
  const [reviewKey, setReviewKey] = useState(0);  // bump to reload the report
  const wasRunning = useRef(false);

  // initial frame load
  useEffect(() => {
    getFrames()
      .then((r) => { setFrames(r.frames ?? []); setFramesErr(r.error ?? null); })
      .catch((e) => setFramesErr(String(e?.message || e)))
      .finally(() => setFramesLoading(false));
  }, []);

  // poll run status (drives the pill + pid; also detects a run finishing to
  // reload the review report). Deterministic 2s cadence — pure status read.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await getStatus();
        if (!alive) return;
        setRunning(s.running);
        setPid(s.pid);
        if (wasRunning.current && !s.running) setReviewKey((k) => k + 1); // just finished → refresh review
        wasRunning.current = s.running;
      } catch { /* transient */ }
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const onStart = useCallback(async () => {
    setBusy(true);
    try {
      const list = selected.size ? [...selected] : null;
      const r = await startRun(list, true);
      if (!r.error) { setRunning(true); setPid(r.pid); wasRunning.current = true; setLogGen((g) => g + 1); }
    } finally { setBusy(false); }
  }, [selected]);

  const onStop = useCallback(async () => {
    setBusy(true);
    try { await stopRun(); } finally { setBusy(false); }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <Radar size={20} color="var(--accent)" />
        <h1>Overnight Rig</h1>
        <span className="sub">run control · pick → start/stop → review</span>
        <span className="spacer" />
        <span className="sub">local · <span className="count">:5599</span></span>
      </header>

      <div className="grid">
        <div className="col">
          <FramePicker
            frames={frames} loading={framesLoading} error={framesErr}
            selected={selected} onChange={setSelected} disabled={running}
          />
        </div>
        <div className="col">
          <RunControls
            running={running} pid={pid} selectedCount={selected.size}
            busy={busy} onStart={onStart} onStop={onStop}
          />
          <LiveLog generation={logGen} />
          <ReviewPanel refreshKey={reviewKey} />
        </div>
      </div>
    </div>
  );
}
