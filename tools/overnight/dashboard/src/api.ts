// PORT SEAM — to embed in the Tauri desktop app, swap these fetch() calls for
// Tauri invoke(); nothing else changes. Every backend call lives HERE; no
// component ever fetches directly. Keep the transport swappable.

export interface Frame {
  id: string;
  image_type: string;
  megapixels: number | null;
  eligible: boolean;
  skip_reason: string | null;
  truth_label: boolean;
}
export interface FramesResponse { frames: Frame[]; config_hash?: string; error?: string; }

export interface RunStatus {
  running: boolean;
  pid?: number;
  meta?: { pid: number; startedAt: string; frames: string[] | null; force: boolean } | null;
  checkpoint?: unknown | null;
}

export interface ReportFrame {
  id: string;
  taxonomy?: string;
  truth_verdict?: string | null;
  truth_tier?: string | null;
  forced_verdict?: string | null;
  [k: string]: unknown;
}
export interface Report {
  generated_at?: string;
  run_index?: number;
  truth_mode?: string;
  eligible?: number;
  ran_taxonomy_tally?: Record<string, number>;
  frames?: ReportFrame[];
  [k: string]: unknown;
}

async function j<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

export async function getFrames(): Promise<FramesResponse> {
  return j(await fetch('/api/frames'));
}

export async function startRun(frames: string[] | null, force = true): Promise<{ running?: boolean; pid?: number; error?: string }> {
  const r = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frames, force }),
  });
  return j(r); // 409 (busy) also returns JSON { error, running, pid }
}

export async function stopRun(): Promise<{ running: boolean }> {
  return j(await fetch('/api/stop', { method: 'POST' }));
}

export async function getStatus(): Promise<RunStatus> {
  return j(await fetch('/api/run/status'));
}

export async function getReport(): Promise<Report | null> {
  const r = await fetch('/api/report');
  if (r.status === 404) return null; // honest-absent
  return j(r);
}

/**
 * Open the live-log SSE stream. Replays the current run's buffered lines on
 * connect, streams new lines, and fires onDone when the child exits.
 * Returns a disposer to close the stream.
 */
export function openLogStream(onLine: (line: string) => void, onDone: (code: number | null) => void): () => void {
  const es = new EventSource('/api/run/stream');
  es.onmessage = (ev) => {
    try { const d = JSON.parse(ev.data); if (typeof d.line === 'string') onLine(d.line); } catch { /* ignore */ }
  };
  es.addEventListener('done', (ev) => {
    let code: number | null = null;
    try { code = JSON.parse((ev as MessageEvent).data).code ?? null; } catch { /* ignore */ }
    onDone(code);
  });
  es.onerror = () => { /* EventSource auto-reconnects; the server replays the buffer */ };
  return () => es.close();
}
