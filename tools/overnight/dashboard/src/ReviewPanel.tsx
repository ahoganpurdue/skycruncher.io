import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getReport, type Report, type ReportFrame } from './api';

// MINIMAL review stub — the real results-viewer (item 2) will replace this.
// Reads last_run_report.json; honest-absent when no report exists yet.

function verdictClass(v: string | null | undefined): string {
  if (!v) return 'pending';
  if (v === 'TRUE_POSITIVE' || v === 'CONFIRMED') return 'ok';
  if (v.includes('FALSE') || v === 'FALSE_POSITIVE') return 'danger';
  if (v === 'NO_TRUTH' || v === 'NO_SOLVE') return 'pending';
  return 'warn';
}
function taxClass(t: string | undefined): string {
  if (t === 'ok') return 'ok';
  if (t === 'no-truth') return 'pending';
  return 'warn';
}

export default function ReviewPanel({ refreshKey }: { refreshKey: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [absent, setAbsent] = useState(false);

  const load = () => {
    setLoading(true);
    getReport().then((r) => { setReport(r); setAbsent(r === null); }).finally(() => setLoading(false));
  };
  useEffect(load, [refreshKey]);

  const frames: ReportFrame[] = report?.frames ?? [];

  return (
    <div className="panel">
      <h2>
        Review
        <span className="stub-tag">basic review — stub</span>
        <button className="mini" style={{ marginLeft: '0.5rem' }} onClick={load} disabled={loading}>
          <RefreshCw size={12} /> Reload
        </button>
      </h2>

      {absent && <div className="note">no run report yet — start a run to produce <span style={{ fontFamily: 'var(--font-mono)' }}>last_run_report.json</span>.</div>}

      {report && (
        <>
          <div className="note" style={{ marginBottom: '0.5rem' }}>
            run <span className="num">#{report.run_index ?? '—'}</span> · truth-mode {report.truth_mode ?? '—'} ·
            generated <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>{report.generated_at ?? '—'}</span>
          </div>
          {frames.length === 0
            ? <div className="note">report present but ran <span className="num">0</span> frames.</div>
            : (
              <div className="frames-wrap" style={{ maxHeight: '34vh' }}>
                <table>
                  <thead>
                    <tr><th>Frame</th><th>Taxonomy</th><th>Truth verdict</th></tr>
                  </thead>
                  <tbody>
                    {frames.map((f) => (
                      <tr key={f.id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>{f.id}</td>
                        <td><span className={`badge ${taxClass(f.taxonomy)}`}>{f.taxonomy ?? '--'}</span></td>
                        <td>
                          {f.truth_verdict
                            ? <span className={`badge ${verdictClass(f.truth_verdict)}`}>{f.truth_verdict}</span>
                            : <span className="sentinel">--</span>}
                          {f.truth_tier ? <span className="type-chip" style={{ marginLeft: 4 }}>{f.truth_tier}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </>
      )}
    </div>
  );
}
