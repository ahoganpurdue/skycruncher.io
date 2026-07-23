/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAYOUT TREE — pure split/tab transforms for the ★ Replay Dashboard shell
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extends the layout model in docs/WORKSPACE_DASHBOARD_DESIGN.md ("v1 approved"):
 *
 *   LayoutNode = Split { direction, sizes[], children[] } | Leaf { tabs[], active }
 *
 * The workspace tree owns PLACEMENT only; the widget registry stays the single
 * source of widget identity. Every operation here is a pure tree transform —
 * unit-testable without a DOM (the design doc's "All operations are pure tree
 * transforms" law). Ids are supplied by the caller so transforms stay
 * deterministic (no Date.now / Math.random inside).
 */

/** A widget id from the registry (kept as a plain string — no import coupling). */
export type WidgetId = string;

export type SplitDirection = 'row' | 'col';

/** A tab group hosting one visible widget (of `tabs[active]`). */
export interface LeafNode {
    type: 'leaf';
    id: string;
    tabs: WidgetId[];
    active: number;
}

/** A recursive split; `sizes` are relative weights (any positive scale). */
export interface SplitNode {
    type: 'split';
    id: string;
    direction: SplitDirection;
    sizes: number[];
    children: LayoutNode[];
}

export type LayoutNode = LeafNode | SplitNode;

export function makeLeaf(id: string, tabs: WidgetId[], active = 0): LeafNode {
    return { type: 'leaf', id, tabs: [...tabs], active: clampIndex(active, tabs.length) };
}

function clampIndex(i: number, len: number): number {
    if (len <= 0) return 0;
    if (i < 0) return 0;
    if (i > len - 1) return len - 1;
    return i;
}

/** Find a leaf by id (depth-first). Returns null when absent. */
export function findLeaf(node: LayoutNode, leafId: string): LeafNode | null {
    if (node.type === 'leaf') return node.id === leafId ? node : null;
    for (const c of node.children) {
        const hit = findLeaf(c, leafId);
        if (hit) return hit;
    }
    return null;
}

/** Count leaves in a tree. */
export function countLeaves(node: LayoutNode): number {
    if (node.type === 'leaf') return 1;
    return node.children.reduce((n, c) => n + countLeaves(c), 0);
}

/** Map every leaf through `fn`, returning a NEW tree (structure preserved). */
function mapLeaves(node: LayoutNode, fn: (leaf: LeafNode) => LayoutNode): LayoutNode {
    if (node.type === 'leaf') return fn(node);
    return { ...node, children: node.children.map(c => mapLeaves(c, fn)) };
}

/**
 * Split a leaf in the given direction, placing `newWidget` in the fresh sibling.
 * The original leaf keeps its tabs; a new leaf (`newLeafId`) hosts the new widget.
 * `before=true` puts the new leaf first. Returns a NEW tree.
 *
 * `row` = side-by-side (a vertical divider); `col` = stacked (a horizontal
 * divider) — mirrors CSS flex-direction.
 */
export function splitLeaf(
    root: LayoutNode,
    leafId: string,
    direction: SplitDirection,
    newWidget: WidgetId,
    ids: { splitId: string; newLeafId: string },
    before = false,
): LayoutNode {
    return mapLeaves(root, (leaf) => {
        if (leaf.id !== leafId) return leaf;
        const fresh = makeLeaf(ids.newLeafId, [newWidget], 0);
        const children = before ? [fresh, leaf] : [leaf, fresh];
        return {
            type: 'split',
            id: ids.splitId,
            direction,
            sizes: [1, 1],
            children,
        };
    });
}

/**
 * Close a leaf. Its parent split collapses: a 2-child split becomes its
 * surviving child; an N>2 split drops the child and re-normalizes sizes. Closing
 * the ROOT leaf is a no-op (a dashboard always keeps at least one pane). Returns
 * a NEW tree.
 */
export function closeLeaf(root: LayoutNode, leafId: string): LayoutNode {
    if (root.type === 'leaf') return root; // never remove the last pane
    const pruned = pruneLeaf(root, leafId);
    return pruned ?? root;
}

/** Returns the node with the leaf removed, or null if the whole node vanished. */
function pruneLeaf(node: LayoutNode, leafId: string): LayoutNode | null {
    if (node.type === 'leaf') return node.id === leafId ? null : node;

    const kept: LayoutNode[] = [];
    const keptSizes: number[] = [];
    node.children.forEach((child, i) => {
        const res = pruneLeaf(child, leafId);
        if (res !== null) {
            kept.push(res);
            keptSizes.push(node.sizes[i] ?? 1);
        }
    });

    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]; // collapse single-child split
    return { ...node, children: kept, sizes: normalize(keptSizes) };
}

/** Replace the active tab's widget in a leaf (the swap-slot dropdown). NEW tree. */
export function swapWidget(root: LayoutNode, leafId: string, widget: WidgetId): LayoutNode {
    return mapLeaves(root, (leaf) => {
        if (leaf.id !== leafId) return leaf;
        const tabs = [...leaf.tabs];
        if (tabs.length === 0) return makeLeaf(leaf.id, [widget], 0);
        tabs[clampIndex(leaf.active, tabs.length)] = widget;
        return { ...leaf, tabs };
    });
}

/** Append a widget as a new tab and focus it (drag-onto-viz = tab group). NEW tree. */
export function addTab(root: LayoutNode, leafId: string, widget: WidgetId): LayoutNode {
    return mapLeaves(root, (leaf) => {
        if (leaf.id !== leafId) return leaf;
        const tabs = [...leaf.tabs, widget];
        return { ...leaf, tabs, active: tabs.length - 1 };
    });
}

/** Focus a tab index in a leaf. NEW tree. */
export function setActiveTab(root: LayoutNode, leafId: string, index: number): LayoutNode {
    return mapLeaves(root, (leaf) => {
        if (leaf.id !== leafId) return leaf;
        return { ...leaf, active: clampIndex(index, leaf.tabs.length) };
    });
}

/** Close a single tab; closing the last tab in a leaf closes the leaf. NEW tree. */
export function closeTab(root: LayoutNode, leafId: string, index: number): LayoutNode {
    const leaf = findLeaf(root, leafId);
    if (!leaf) return root;
    if (leaf.tabs.length <= 1) return closeLeaf(root, leafId);
    return mapLeaves(root, (l) => {
        if (l.id !== leafId) return l;
        const tabs = l.tabs.filter((_, i) => i !== index);
        const active = clampIndex(l.active >= index && l.active > 0 ? l.active - 1 : l.active, tabs.length);
        return { ...l, tabs, active };
    });
}

/**
 * Set the sizes of a split (drag-resize commits the new weights). Length must
 * match the child count or the update is ignored (defensive). NEW tree.
 */
export function resizeSplit(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
    if (root.type === 'leaf') return root;
    if (root.id === splitId) {
        if (sizes.length !== root.children.length) return root;
        return { ...root, sizes: normalize(sizes) };
    }
    return { ...root, children: root.children.map(c => resizeSplit(c, splitId, sizes)) };
}

/** Normalize weights to sum to 1; all-zero or invalid ⇒ equal split. */
function normalize(sizes: number[]): number[] {
    const clean = sizes.map(s => (Number.isFinite(s) && s > 0 ? s : 0));
    const sum = clean.reduce((a, b) => a + b, 0);
    if (sum <= 0) return sizes.map(() => 1 / sizes.length);
    return clean.map(s => s / sum);
}

/** Collect every leaf id (stable pane enumeration for keys / focus). */
export function leafIds(node: LayoutNode): string[] {
    if (node.type === 'leaf') return [node.id];
    return node.children.flatMap(leafIds);
}
