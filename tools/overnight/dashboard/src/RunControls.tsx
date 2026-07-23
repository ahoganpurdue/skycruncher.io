import { Play, Square as StopIcon } from 'lucide-react';

interface Props {
  running: boolean;
  pid?: number;
  selectedCount: number;
  busy: boolean;         // a start/stop request is in flight
  onStart: () => void;
  onStop: () => void;
}

export default function RunControls({ running, pid, selectedCount, busy, onStart, onStop }: Props) {
  return (
    <div className="panel">
      <h2>Run control</h2>
      <div className="toolbar" style={{ marginBottom: '0.5rem' }}>
        <button className="primary" onClick={onStart} disabled={running || busy || selectedCount === 0}>
          <Play size={15} /> Start
        </button>
        <button className="danger" onClick={onStop} disabled={!running || busy}>
          <StopIcon size={15} /> Stop
        </button>

        <span className={`pill ${running ? 'running' : 'idle'}`} style={{ marginLeft: 'auto' }}>
          <span className="dot" />
          {running ? 'RUNNING' : 'IDLE'}
        </span>
      </div>

      <div className="note">
        {running
          ? <>run_pipeline.mjs --force · pid <span className="num">{pid ?? '—'}</span></>
          : selectedCount === 0
            ? 'select at least one frame to start a run.'
            : <><span className="count">{selectedCount}</span> frame(s) selected · will spawn <span style={{ fontFamily: 'var(--font-mono)' }}>run_pipeline.mjs --force --frames …</span></>}
      </div>
    </div>
  );
}
