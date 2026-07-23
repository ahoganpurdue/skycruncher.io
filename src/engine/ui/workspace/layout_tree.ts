/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WORKSPACE LAYOUT TREE — pure, DOM-free tree model + transforms (v1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Workspace Dashboard (docs/WORKSPACE_DASHBOARD_DESIGN.md) is a serializable
 * JSON tree whose leaves are widget IDs from the phase-1 registry
 * (`src/engine/ui/widgets/registry.ts`). The registry stays the single source of
 * widget IDENTITY; this module owns PLACEMENT only.
 *
 * Every transform here is a PURE function `tree -> tree` — no DOM, no storage,
 * no mutation of its inputs — so the whole interaction grammar is unit-testable
 * in the node vitest environment (mirrors the registry's pure-logic discipline).
 *
 * Spec shape (owner):
 *   LayoutNode = Split { direction:'row'|'col', sizes:number[], children:[] }
 *              | Leaf  { tabs: WidgetId[], active:number }
 * v1 ADDITIONS (necessary, minimal, documented): every node carries a stable
 *   `id` (addressing target for focus + transforms + React keys) and a `kind`
 *   discriminant (clean TS discriminated union). The conceptual owner shape is
 *   otherwise preserved verbatim.
 */

// ─── ids ────────────────────────────────────────────────────────────────────

let __nodeCounter = 0;

/** Mint a fresh, process-unique node id. Deterministic within a session. */
export function nextNodeId(prefix = 'ws'): string {
    __nodeCounter += 1;
    return `${prefix}-${__nodeCounter}`;
}

/** Reset the id counter — TEST HOOK ONLY (keeps structural assertions stable). */
export function __resetNodeIds(): void { __nodeCounter = 0; }

// ─── types ──────────────────────────────────────────────────────────────────

export type WidgetId = string;
export type SplitDirection = 'row' | 'col';

/** A container that tiles its children along one axis; `sizes` ∥ `children`. */
export interface SplitNode {
    kind: 'split';
    id: string;
    direction: SplitDirection;
    /** Normalized fractions (sum ≈ 1), one per child, parallel to `children`. */
    sizes: number[];
    children: LayoutNode[];
}

/** A pane holding a tab-group of widgets; `active` indexes into `tabs`. */
export interface LeafNode {
    kind: 'leaf';
    id: string;
    tabs: WidgetId[];
    active: number;
}

export type LayoutNode = SplitNode | LeafNode;

export const isSplit = (n: LayoutNode): n is SplitNode => n.kind === 'split';
export const isLeaf = (n: LayoutNode): n is LeafNode => n.kind === 'leaf';

// ─── constructors ────────────────────────────────────────────────────────────

export function makeLeaf(tabs: WidgetId[] = [], opts?: { id?: string; active?: number }): LeafNode {
    const active = opts?.active ?? 0;
    return {
        kind: 'leaf',
        id: opts?.id ?? nextNodeId('leaf'),
        tabs: [...tabs],
        active: clampActive(active, tabs.length),
    };
}

export function makeSplit(
    direction: SplitDirection,
    children: LayoutNode[],
    opts?: { id?: string; sizes?: number[] },
): SplitNode {
    const sizes = opts?.sizes && opts.sizes.length === children.length
        ? normalizeSizes(opts.sizes)
        : evenSizes(children.length);
    return { kind: 'split', id: opts?.id ?? nextNodeId('split'), direction, sizes, children };
}

// ─── size helpers ─────────────────────────────────────────────────────────────

function evenSizes(n: number): number[] {
    if (n <= 0) return [];
    return Array.from({ length: n }, () => 1 / n);
}

/** Normalize to sum 1; a degenerate (≤0 sum / wrong length) input → even split. */
export function normalizeSizes(sizes: number[]): number[] {
    const clean = sizes.map(s => (Number.isFinite(s) && s > 0 ? s : 0));
    const sum = clean.reduce((a, b) => a + b, 0);
    if (sum <= 0) return evenSizes(sizes.length);
    return clean.map(s => s / sum);
}

function clampActive(active: number, len: number): number {
    if (len <= 0) return 0;
    if (!Number.isFinite(active)) return 0;
    return Math.min(Math.max(0, Math.floor(active)), len - 1);
}

// ─── lookup ───────────────────────────────────────────────────────────────────

/** Depth-first find of a node by id (returns the node in the given tree). */
export function findNode(root: LayoutNode, id: string): LayoutNode | null {
    if (root.id === id) return root;
    if (isSplit(root)) {
        for (const c of root.children) {
            const hit = findNode(c, id);
            if (hit) return hit;
        }
    }
    return null;
}

/** All leaves, left-to-right / depth-first (focus-order). */
export function collectLeaves(root: LayoutNode): LeafNode[] {
    if (isLeaf(root)) return [root];
    return root.children.flatMap(collectLeaves);
}

/** Map a node in the tree through `fn`, returning a NEW tree (pure). */
function mapNode(root: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
    if (root.id === id) return fn(root);
    if (isSplit(root)) {
        return { ...root, children: root.children.map(c => mapNode(c, id, fn)) };
    }
    return root;
}

// ─── pruning / collapse ────────────────────────────────────────────────────────

/**
 * Remove empty leaves and unwrap single-child splits, renormalizing sizes to the
 * survivors. Returns null when the whole subtree should disappear. This is the
 * one place the collapse invariants are enforced.
 */
function prune(node: LayoutNode): LayoutNode | null {
    if (isLeaf(node)) return node.tabs.length === 0 ? null : node;
    const survivors: { node: LayoutNode; size: number }[] = [];
    node.children.forEach((c, i) => {
        const pruned = prune(c);
        if (pruned) survivors.push({ node: pruned, size: node.sizes[i] ?? 0 });
    });
    if (survivors.length === 0) return null;
    if (survivors.length === 1) return survivors[0].node;   // unwrap
    return {
        ...node,
        children: survivors.map(s => s.node),
        sizes: normalizeSizes(survivors.map(s => s.size)),
    };
}

/** Prune a root; a fully-collapsed tree becomes a single canonical empty leaf. */
function pruneRoot(node: LayoutNode): LayoutNode {
    return prune(node) ?? makeLeaf([]);
}

// ─── transforms (all pure: tree -> tree) ───────────────────────────────────────

/** Map an arrow key to a split direction + insertion side (v1 keyboard grammar). */
export function directionForArrow(
    key: string,
): { direction: SplitDirection; insertBefore: boolean } | null {
    switch (key) {
        case 'ArrowUp': return { direction: 'col', insertBefore: true };
        case 'ArrowDown': return { direction: 'col', insertBefore: false };
        case 'ArrowLeft': return { direction: 'row', insertBefore: true };
        case 'ArrowRight': return { direction: 'row', insertBefore: false };
        default: return null;
    }
}

/**
 * Split a leaf in `direction`, wrapping it in a new Split alongside a NEW leaf
 * (holding `newTabs`, possibly empty). v1 policy: WRAP-ALWAYS (nested splits over
 * flattening same-direction parents — visually identical under flex; flattening
 * is a documented v2 nicety). 50/50 sizes.
 */
export function splitLeaf(
    root: LayoutNode,
    leafId: string,
    direction: SplitDirection,
    opts?: { newTabs?: WidgetId[]; insertBefore?: boolean; newLeafId?: string; splitId?: string },
): LayoutNode {
    const target = findNode(root, leafId);
    if (!target || !isLeaf(target)) return root;
    return mapNode(root, leafId, existing => {
        const fresh = makeLeaf(opts?.newTabs ?? [], { id: opts?.newLeafId });
        const kids = opts?.insertBefore ? [fresh, existing] : [existing, fresh];
        return makeSplit(direction, kids, { id: opts?.splitId, sizes: [0.5, 0.5] });
    });
}

/** Append a widget as a new tab on a leaf, optionally activating it. */
export function addWidget(
    root: LayoutNode,
    leafId: string,
    widgetId: WidgetId,
    opts?: { activate?: boolean },
): LayoutNode {
    const target = findNode(root, leafId);
    if (!target || !isLeaf(target)) return root;
    return mapNode(root, leafId, n => {
        const leaf = n as LeafNode;
        const tabs = [...leaf.tabs, widgetId];
        const active = opts?.activate ? tabs.length - 1 : clampActive(leaf.active, tabs.length);
        return { ...leaf, tabs, active };
    });
}

/** Set the active tab index on a leaf (clamped to a valid range). */
export function setActiveTab(root: LayoutNode, leafId: string, index: number): LayoutNode {
    return mapNode(root, leafId, n => {
        if (!isLeaf(n)) return n;
        return { ...n, active: clampActive(index, n.tabs.length) };
    });
}

/**
 * Close a tab on a leaf. Adjusts `active`, then collapses empty leaves and
 * single-child splits. A fully-emptied tree collapses to one empty leaf.
 */
export function closeTab(root: LayoutNode, leafId: string, tabIndex: number): LayoutNode {
    const target = findNode(root, leafId);
    if (!target || !isLeaf(target) || tabIndex < 0 || tabIndex >= target.tabs.length) return root;
    const removed = mapNode(root, leafId, n => {
        const leaf = n as LeafNode;
        const tabs = leaf.tabs.filter((_, i) => i !== tabIndex);
        let active = leaf.active;
        if (tabIndex < active) active -= 1;
        return { ...leaf, tabs, active: clampActive(active, tabs.length) };
    });
    return pruneRoot(removed);
}

/**
 * Move a widget tab from one leaf to another (the drop-viz-on-viz = tab group
 * operation, and the drag-out target once wired). Same-leaf move = reorder.
 * The source leaf collapses if it empties.
 */
export function moveTabToLeaf(
    root: LayoutNode,
    fromLeafId: string,
    tabIndex: number,
    toLeafId: string,
    opts?: { toIndex?: number },
): LayoutNode {
    const from = findNode(root, fromLeafId);
    const to = findNode(root, toLeafId);
    if (!from || !isLeaf(from) || !to || !isLeaf(to)) return root;
    if (tabIndex < 0 || tabIndex >= from.tabs.length) return root;
    const widget = from.tabs[tabIndex];

    if (fromLeafId === toLeafId) {
        // reorder within the same leaf
        return mapNode(root, fromLeafId, n => {
            const leaf = n as LeafNode;
            const rest = leaf.tabs.filter((_, i) => i !== tabIndex);
            const insertAt = clampInsert(opts?.toIndex ?? rest.length, rest.length);
            const tabs = [...rest.slice(0, insertAt), widget, ...rest.slice(insertAt)];
            return { ...leaf, tabs, active: insertAt };
        });
    }

    // remove from source, add to destination
    let next = mapNode(root, fromLeafId, n => {
        const leaf = n as LeafNode;
        const tabs = leaf.tabs.filter((_, i) => i !== tabIndex);
        let active = leaf.active;
        if (tabIndex < active) active -= 1;
        return { ...leaf, tabs, active: clampActive(active, tabs.length) };
    });
    next = mapNode(next, toLeafId, n => {
        const leaf = n as LeafNode;
        const insertAt = clampInsert(opts?.toIndex ?? leaf.tabs.length, leaf.tabs.length);
        const tabs = [...leaf.tabs.slice(0, insertAt), widget, ...leaf.tabs.slice(insertAt)];
        return { ...leaf, tabs, active: insertAt };
    });
    return pruneRoot(next);
}

function clampInsert(i: number, len: number): number {
    if (!Number.isFinite(i)) return len;
    return Math.min(Math.max(0, Math.floor(i)), len);
}

/**
 * Set the sizes of a split (absolute, renormalized to sum 1). A length mismatch
 * or all-zero input is ignored (returns the tree unchanged) — never produces an
 * invalid split.
 */
export function resizeSplit(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
    const target = findNode(root, splitId);
    if (!target || !isSplit(target) || sizes.length !== target.children.length) return root;
    const norm = normalizeSizes(sizes);
    if (norm.some(s => !Number.isFinite(s))) return root;
    return mapNode(root, splitId, n => (isSplit(n) ? { ...n, sizes: norm } : n));
}

// ─── invariants (test + runtime guard) ─────────────────────────────────────────

const SIZE_EPSILON = 1e-6;

/**
 * The ALWAYS-TRUE structural invariant (holds after EVERY transform, including
 * splitLeaf). Empty list ⇒ well-formed.
 *   - no split with < 2 children (single-child splits must be unwrapped)
 *   - split sizes parallel to children AND summing to ~1, all > 0
 *   - leaf `active` in range for a non-empty leaf; 0 for an empty leaf
 *
 * NOTE: an EMPTY leaf is NOT a violation — a freshly split pane is a legitimate,
 * honest "empty pane" awaiting a widget (Law 3: it renders NOT MEASURED, never a
 * fake). Empty panes are pruned only by the collapse-on-close/move operations
 * (`closeTab` / `moveTabToLeaf`), which additionally satisfy {@link hasEmptyLeaves}
 * ⇒ false. Use that helper where post-collapse emptiness matters.
 */
export function treeInvariantViolations(root: LayoutNode): string[] {
    const out: string[] = [];
    const walk = (n: LayoutNode) => {
        if (isLeaf(n)) {
            if (n.tabs.length === 0) { if (n.active !== 0) out.push(`empty leaf ${n.id} active ≠ 0`); }
            else if (n.active < 0 || n.active >= n.tabs.length) out.push(`leaf ${n.id} active ${n.active} out of range`);
            return;
        }
        if (n.children.length < 2) out.push(`split ${n.id} has ${n.children.length} child(ren)`);
        if (n.sizes.length !== n.children.length) out.push(`split ${n.id} sizes/children mismatch`);
        const sum = n.sizes.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > SIZE_EPSILON) out.push(`split ${n.id} sizes sum ${sum} ≠ 1`);
        if (n.sizes.some(s => s <= 0)) out.push(`split ${n.id} has a non-positive size`);
        n.children.forEach(walk);
    };
    walk(root);
    return out;
}

/** Convenience boolean form of {@link treeInvariantViolations}. */
export function isWellFormed(root: LayoutNode): boolean {
    return treeInvariantViolations(root).length === 0;
}

/** Any empty (widget-less) leaf anywhere in the tree. */
export function hasEmptyLeaves(root: LayoutNode): boolean {
    return collectLeaves(root).some(l => l.tabs.length === 0);
}
