import { useMemo } from 'react';
import { Ban } from 'lucide-react';
import type { Frame } from './api';

interface Props {
  frames: Frame[];
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled: boolean;
}

// Distinct image types among ELIGIBLE frames → "select by type" buttons.
function eligibleTypes(frames: Frame[]): string[] {
  const s = new Set<string>();
  for (const f of frames) if (f.eligible) s.add(f.image_type);
  return [...s].sort();
}

export default function FramePicker({ frames, loading, error, selected, onChange, disabled }: Props) {
  const types = useMemo(() => eligibleTypes(frames), [frames]);
  const eligible = useMemo(() => frames.filter((f) => f.eligible), [frames]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  const selectAll = () => onChange(new Set(eligible.map((f) => f.id)));
  const clear = () => onChange(new Set());
  const selectType = (t: string) => {
    const next = new Set(selected);
    for (const f of eligible) if (f.image_type === t) next.add(f.id);
    onChange(next);
  };

  return (
    <div className="panel">
      <h2>
        Frames
        <span className="note" style={{ marginLeft: 'auto' }}>
          <span className="count">{eligible.length}</span> eligible · <span className="count">{selected.size}</span> selected
        </span>
      </h2>

      <div className="toolbar">
        <button className="mini" onClick={selectAll} disabled={disabled || !eligible.length}>Select all</button>
        <button className="mini" onClick={clear} disabled={disabled || !selected.size}>Clear</button>
        {types.map((t) => (
          <button key={t} className="mini" onClick={() => selectType(t)} disabled={disabled}>+ {t}</button>
        ))}
      </div>

      {error && <div className="reason">frames unavailable: {error}</div>}
      {loading && !frames.length && <div className="note">loading frames…</div>}
      {!loading && !frames.length && !error && <div className="note">no frames in the corpus manifest.</div>}

      {!!frames.length && (
        <div className="frames-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Frame</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>MP</th>
                <th>Truth</th>
              </tr>
            </thead>
            <tbody>
              {frames.map((f) => {
                const on = selected.has(f.id);
                return (
                  <tr key={f.id} className={f.eligible ? '' : 'skipped'}>
                    <td>
                      {f.eligible ? (
                        <label style={{ cursor: disabled ? 'not-allowed' : 'pointer', display: 'inline-flex' }}>
                          <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(f.id)} />
                        </label>
                      ) : (
                        <Ban size={14} color="var(--text-muted)" aria-label="skipped" />
                      )}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }}>
                      {f.id}
                      {!f.eligible && f.skip_reason && <div className="reason">{f.skip_reason}</div>}
                    </td>
                    <td><span className="type-chip">{f.image_type}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      {typeof f.megapixels === 'number'
                        ? <span className="num">{f.megapixels.toFixed(1)}</span>
                        : <span className="sentinel">--</span>}
                    </td>
                    <td>
                      {f.truth_label
                        ? <span className="badge ok">label</span>
                        : <span className="sentinel">--</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
