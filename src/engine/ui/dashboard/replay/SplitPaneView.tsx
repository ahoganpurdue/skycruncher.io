/**
 * SPLIT PANE VIEW — recursive H/V split + tab renderer (★ Replay Dashboard).
 *
 * Renders a LayoutNode tree: splits become flex rows/cols with draggable
 * dividers; leaves become tab groups whose active tab hosts a generic
 * `WidgetSlot`. Every mutation routes through `actions` (pure tree transforms
 * owned by ReplayDashboard) — this component holds NO layout state, only the
 * transient drag gesture. Hand-rolled, no docking dependency (WORKSPACE_DASHBOARD
 * v1: "hand-rolled layout tree + tabs + keyboard splits", clean seam for a lib later).
 */

import React, { useRef } from 'react';
import type { LayoutNode, SplitDirection } from './layout_tree';
import { WidgetSlot, widgetOptions, findManifest } from './WidgetSlot';

export interface PaneActions {
    split: (leafId: string, dir: SplitDirection) => void;
    close: (leafId: string) => void;
    swap: (leafId: string, widgetId: string) => void;
    addTab: (leafId: string) => void;
    setActive: (leafId: string, idx: number) => void;
    closeTab: (leafId: string, idx: number) => void;
    resize: (splitId: string, sizes: number[]) => void;
}

const PaneFrame: React.FC<{ leafId: string; tabs: string[]; active: number; actions: PaneActions; canClose: boolean }> = ({
    leafId, tabs, active, actions, canClose,
}) => {
    const activeWidget = tabs[active] ?? tabs[0];
    return (
        <div className="flex flex-col h-full min-h-0 min-w-0 border border-line rounded-lg overflow-hidden bg-space-850" data-testid={`pane-${leafId}`}>
            <header className="flex items-center gap-1 px-1.5 py-1 bg-space-900/70 border-b border-line shrink-0">
                <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
                    {tabs.map((wid, i) => {
                        const m = findManifest(wid);
                        return (
                            <span
                                key={wid + i}
                                className={`group flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono whitespace-nowrap cursor-pointer ${
                                    i === active ? 'bg-space-750 text-text-primary' : 'text-text-muted hover:text-text-secondary'
                                }`}
                                onClick={() => actions.setActive(leafId, i)}
                                data-testid={`pane-tab-${leafId}-${i}`}
                            >
                                {m?.title ?? wid}
                                {tabs.length > 1 && (
                                    <button
                                        type="button"
                                        aria-label="Close tab"
                                        className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-danger"
                                        onClick={e => { e.stopPropagation(); actions.closeTab(leafId, i); }}
                                    >×</button>
                                )}
                            </span>
                        );
                    })}
                </div>

                <div className="flex-1" />

                {/* Swap the active tab's widget — the registry-driven slot chooser. */}
                <select
                    value={activeWidget}
                    onChange={e => actions.swap(leafId, e.target.value)}
                    data-testid={`pane-swap-${leafId}`}
                    aria-label="Swap widget"
                    className="bg-space-800 border border-line rounded px-1 py-0.5 text-[10px] font-mono text-text-secondary max-w-[130px]"
                >
                    {widgetOptions().map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
                </select>

                <button type="button" aria-label="Add tab" title="Add tab" data-testid={`pane-addtab-${leafId}`}
                    className="px-1.5 text-text-muted hover:text-text-primary text-[12px] leading-none"
                    onClick={() => actions.addTab(leafId)}>＋</button>
                <button type="button" aria-label="Split right" title="Split right" data-testid={`pane-split-row-${leafId}`}
                    className="px-1 text-text-muted hover:text-accent-300 text-[11px] leading-none"
                    onClick={() => actions.split(leafId, 'row')}>⊟</button>
                <button type="button" aria-label="Split down" title="Split down" data-testid={`pane-split-col-${leafId}`}
                    className="px-1 text-text-muted hover:text-accent-300 text-[11px] leading-none rotate-90"
                    onClick={() => actions.split(leafId, 'col')}>⊟</button>
                {canClose && (
                    <button type="button" aria-label="Close pane" title="Close pane" data-testid={`pane-close-${leafId}`}
                        className="px-1.5 text-text-muted hover:text-danger text-[12px] leading-none"
                        onClick={() => actions.close(leafId)}>×</button>
                )}
            </header>
            <div className="flex-1 min-h-0 min-w-0">
                <WidgetSlot widgetId={activeWidget} />
            </div>
        </div>
    );
};

const Divider: React.FC<{ direction: SplitDirection; onDrag: (deltaFraction: number) => void; containerRef: React.RefObject<HTMLDivElement | null> }> = ({
    direction, onDrag, containerRef,
}) => {
    const row = direction === 'row';
    const onPointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const rect = containerRef.current?.getBoundingClientRect();
        const total = rect ? (row ? rect.width : rect.height) : 1;
        const startPos = row ? e.clientX : e.clientY;
        let last = startPos;
        const move = (ev: PointerEvent) => {
            const pos = row ? ev.clientX : ev.clientY;
            onDrag((pos - last) / (total || 1));
            last = pos;
        };
        const up = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            try { (e.target as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (
        <div
            role="separator"
            aria-orientation={row ? 'vertical' : 'horizontal'}
            onPointerDown={onPointerDown}
            data-testid="pane-divider"
            className={`shrink-0 bg-line hover:bg-accent-500 transition-colors ${row ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
        />
    );
};

export const SplitPaneView: React.FC<{ node: LayoutNode; actions: PaneActions; canClose?: boolean }> = ({ node, actions, canClose = false }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    if (node.type === 'leaf') {
        return <PaneFrame leafId={node.id} tabs={node.tabs} active={node.active} actions={actions} canClose={canClose} />;
    }

    const row = node.direction === 'row';
    const sizes = node.sizes.length === node.children.length ? node.sizes : node.children.map(() => 1 / node.children.length);

    const applyDrag = (i: number, deltaFraction: number) => {
        // Move `deltaFraction` of the container from child i+1 into child i.
        const next = [...sizes];
        const min = 0.05;
        const a = next[i] + deltaFraction;
        const b = next[i + 1] - deltaFraction;
        if (a < min || b < min) return;
        next[i] = a;
        next[i + 1] = b;
        actions.resize(node.id, next);
    };

    return (
        <div ref={containerRef} className={`flex ${row ? 'flex-row' : 'flex-col'} h-full min-h-0 min-w-0 gap-0`} data-testid={`split-${node.id}`} data-direction={node.direction}>
            {node.children.map((child, i) => (
                <React.Fragment key={child.id}>
                    <div className="min-h-0 min-w-0 flex" style={{ flexBasis: `${sizes[i] * 100}%`, flexGrow: 0, flexShrink: 1 }}>
                        <div className="w-full h-full p-1">
                            <SplitPaneView node={child} actions={actions} canClose />
                        </div>
                    </div>
                    {i < node.children.length - 1 && (
                        <Divider direction={node.direction} containerRef={containerRef} onDrag={d => applyDrag(i, d)} />
                    )}
                </React.Fragment>
            ))}
        </div>
    );
};
