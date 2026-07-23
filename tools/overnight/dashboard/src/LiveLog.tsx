import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { openLogStream } from './api';

// Consumes the SSE log stream. Autoscrolls. Monospace. Shows the done event.
export default function LiveLog({ generation }: { generation: number }) {
  // `generation` bumps on each Start → re-open the stream fresh.
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState<number | null | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setLines([]);
    setDone(undefined);
    const close = openLogStream(
      (line) => setLines((prev) => [...prev, line]),
      (code) => setDone(code),
    );
    return close;
  }, [generation]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, done]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="panel">
      <h2><Terminal size={15} /> Live log <span className="count" style={{ marginLeft: 'auto' }}>{lines.length}</span></h2>
      <div className="log" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0 && done === undefined && <span className="empty">waiting for output…</span>}
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        {done !== undefined && (
          <div className="done">■ run ended{done != null ? ` (exit ${done})` : ''}</div>
        )}
      </div>
    </div>
  );
}
