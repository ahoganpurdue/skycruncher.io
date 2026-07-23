/**
 * TIME SLIDER — scrub + play/pause + speed control (★ Replay Dashboard).
 *
 * Presentational: it renders the scrub position, play/pause, restart, and the
 * speed picker (0.25× slow-mo … 16× sped-up per the owner spec). All timing
 * comes from `useReplayClock`; the position readout comes from the derived
 * ReplayFrame (elapsed / total). LIVE runs pin the scrub to the tail.
 */

import React from 'react';
import { REPLAY_SPEEDS, type ReplayClock } from './useReplayClock';

export const TimeSlider: React.FC<{
    clock: ReplayClock;
    bounds: { tStart: number; tEnd: number };
    elapsedMs: number;
    totalMs: number;
    live?: boolean;
    disabled?: boolean;
}> = ({ clock, bounds, elapsedMs, totalMs, live, disabled }) => {
    const atEnd = clock.t >= bounds.tEnd;
    return (
        <div className="flex items-center gap-3 flex-wrap px-3 py-2 border-t border-line bg-space-900/60" data-testid="replay-time-slider">
            <button
                type="button"
                onClick={clock.toggle}
                disabled={disabled}
                aria-label={clock.playing ? 'Pause' : 'Play'}
                data-testid="replay-playpause"
                className="px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest bg-accent-600 text-white disabled:opacity-40 hover:bg-accent-500"
            >
                {clock.playing ? '❚❚' : atEnd ? '↻' : '▶'}
            </button>
            <button
                type="button"
                onClick={clock.restart}
                disabled={disabled}
                aria-label="Restart"
                data-testid="replay-restart"
                className="px-2 py-1.5 rounded-md text-[11px] font-mono bg-space-800 text-text-secondary disabled:opacity-40 hover:text-text-primary"
            >
                ⏮
            </button>

            <input
                type="range"
                min={bounds.tStart}
                max={Math.max(bounds.tStart + 1, bounds.tEnd)}
                step={1}
                value={clock.t}
                disabled={disabled || live}
                onChange={e => clock.setT(Number(e.target.value))}
                data-testid="replay-scrub"
                aria-label="Scrub position"
                className="flex-1 min-w-[160px] accent-accent-500"
            />

            <span className="font-mono text-[10px] text-text-muted tabular-nums w-28 text-right">
                {(elapsedMs / 1000).toFixed(2)}s / {(totalMs / 1000).toFixed(2)}s
            </span>

            <div className="inline-flex rounded-md border border-line overflow-hidden" role="group" aria-label="Playback speed">
                {REPLAY_SPEEDS.map(s => (
                    <button
                        key={s}
                        type="button"
                        onClick={() => clock.setSpeed(s)}
                        disabled={disabled}
                        aria-pressed={clock.speed === s}
                        data-testid={`replay-speed-${s}`}
                        className={`px-2 py-1 text-[10px] font-mono ${
                            clock.speed === s ? 'bg-accent-600 text-white' : 'bg-space-800 text-text-secondary hover:text-text-primary'
                        }`}
                    >
                        {s}×
                    </button>
                ))}
            </div>

            {live && (
                <span className="font-mono text-[10px] text-solve uppercase tracking-widest" data-testid="replay-live-badge">
                    ● LIVE
                </span>
            )}
        </div>
    );
};
