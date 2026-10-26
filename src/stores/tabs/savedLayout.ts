// The persisted layout: tree (de)serialization, saved-record checks, pruning,
// popout/hidden docking. Pure. Moved out of `stores/tabs.ts`.

import type {
  DetachedGroup,
  HiddenGroup,
  LayoutNode,
  SavedLayoutTree,
  SavedTabEntry,
  WindowBounds,
} from "./types";
import { nextGroupId, nextSplitId } from "./ids";
import { FILES_TAB_CMD, cmdToKind, isRestorableTab } from "./tabKinds";

// ── Tree (de)serialization ──────────────────────────────────────────────────

export function serializeTree(node: LayoutNode | null): SavedLayoutTree | null {
  if (!node) return null;
  if (node.type === "group") {
    return {
      type: "group",
      tabKeys: [...node.tabKeys],
      activeKey: node.activeKey,
      // Persist the per-subwindow file viewer (open flag + width + browsed
      // folder) so it comes back on restart.
      ...(node.filesOpen ? { filesOpen: true } : {}),
      ...(node.filesWidth != null ? { filesWidth: node.filesWidth } : {}),
      ...(node.filesFolder ? { filesFolder: node.filesFolder } : {}),
    };
  }
  return {
    type: "split",
    dir: node.dir,
    sizes: [...node.sizes],
    children: node.children
      .map(serializeTree)
      .filter((c): c is SavedLayoutTree => c != null),
  };
}

/**
 * Whether a persisted layout node has the shape `deserializeTree` reads: a
 * group with a `tabKeys` string array, or a split with a known `dir`, a
 * `children` array and a `sizes` array. Only the node itself is checked —
 * each child is checked as it is visited, so one malformed subtree drops
 * alone. A `sizes` array whose entries are not usable fractions is tolerated
 * here and replaced by an even split there.
 */
function isSavedLayoutNode(node: unknown): node is SavedLayoutTree {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  if (n.type === "group") {
    return (
      Array.isArray(n.tabKeys) &&
      n.tabKeys.every((k) => typeof k === "string") &&
      (n.activeKey == null || typeof n.activeKey === "string")
    );
  }
  if (n.type === "split") {
    return (
      (n.dir === "row" || n.dir === "column") &&
      Array.isArray(n.children) &&
      Array.isArray(n.sizes)
    );
  }
  return false;
}

/** #42: a group restored from the saved tree that was tagged `detached`. */
export interface RespawnTarget {
  id: string; // the FRESH group id minted during deserialize
  bounds?: WindowBounds;
  // The popout's persisted per-window zoom (see DetachedGroup.zoom), carried so
  // the respawn re-detaches it at the zoom it was left at. Undefined = 100%.
  zoom?: number;
}

/**
 * Rebuild a layout tree from a serialized tree, remapping saved tab keys to the
 * freshly-minted keys. Drops keys not in `keyMap`. Returns null if nothing left.
 *
 * #42: when a group node is tagged `detached`, its freshly-minted id (+ bounds)
 * is pushed onto `detachedOut` so the caller can re-open it as a floating popout
 * after the layout is live (loadFromLayout). The node is still built into the
 * tree (docked) so its tabs mount and spawn their PTYs before the re-detach.
 *
 * A `hidden`-tagged node works the same way but pushes its fresh id onto
 * `hiddenOut`; the caller then strips it from the built tree into
 * `hiddenGroupsByScope` (see loadFromLayout).
 *
 * The tree is read from disk (and, since H1, from the shared workspace), so
 * its shape is checked, not assumed: a node that is not a well-formed group or
 * split (see `isSavedLayoutNode`) builds nothing, like a group whose tabs are
 * all gone, and the caller falls back to one group holding every tab.
 */
/** A group or split restored from the saved tree that was tagged `hidden`. */
export interface HiddenTarget {
  id: string; // the FRESH node id minted during deserialize
  name?: string;
}

function hiddenTarget(id: string, saved: SavedLayoutTree): HiddenTarget {
  // Read from disk, so the name's type is checked, not assumed.
  const name = typeof saved.hiddenName === "string" ? saved.hiddenName.trim() : "";
  return name ? { id, name } : { id };
}

export function deserializeTree(
  saved: SavedLayoutTree,
  keyMap: Map<string, string>,
  detachedOut?: RespawnTarget[],
  hiddenOut?: HiddenTarget[],
): LayoutNode | null {
  if (!isSavedLayoutNode(saved)) return null;
  if (saved.type === "group") {
    const tabKeys = saved.tabKeys
      .map((k) => keyMap.get(k))
      .filter((k): k is string => k != null);
    if (tabKeys.length === 0) return null;
    const activeKey =
      (saved.activeKey != null ? keyMap.get(saved.activeKey) : null) ??
      tabKeys[0] ??
      null;
    const id = nextGroupId();
    if (saved.detached && detachedOut) {
      detachedOut.push({ id, bounds: saved.bounds, zoom: saved.zoom });
    }
    if (saved.hidden && hiddenOut) {
      hiddenOut.push(hiddenTarget(id, saved));
    }
    return {
      type: "group",
      id,
      tabKeys,
      activeKey,
      ...(saved.filesOpen ? { filesOpen: true } : {}),
      ...(typeof saved.filesWidth === "number" && Number.isFinite(saved.filesWidth)
        ? { filesWidth: saved.filesWidth }
        : {}),
      ...(typeof saved.filesFolder === "string" && saved.filesFolder ? { filesFolder: saved.filesFolder } : {}),
    };
  }
  const children = saved.children
    .map((c) => deserializeTree(c, keyMap, detachedOut, hiddenOut))
    .filter((c): c is LayoutNode => c != null);
  if (children.length === 0) return null;
  if (children.length === 1) {
    // Collapsed to a single child. If this split was a detached (multi-pane)
    // popout, the survivor inherits the respawn so the popout still re-opens.
    if (saved.detached && detachedOut) {
      detachedOut.push({ id: children[0].id, bounds: saved.bounds, zoom: saved.zoom });
    }
    // Likewise inherit a hidden tag so the survivor is parked, not docked live.
    if (saved.hidden && hiddenOut) {
      hiddenOut.push(hiddenTarget(children[0].id, saved));
    }
    return children[0];
  }
  // Align sizes to surviving children where possible, else even split.
  let sizes: number[];
  const savedSizesUsable =
    saved.sizes.length === children.length &&
    saved.sizes.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
  if (savedSizesUsable) {
    const total = saved.sizes.reduce((a, b) => a + b, 0) || 1;
    sizes = saved.sizes.map((x) => x / total);
  } else {
    sizes = children.map(() => 1 / children.length);
  }
  const id = nextSplitId();
  // #42: a tagged split is a multi-pane popout — collect ONE respawn target for
  // the whole subtree (its children aren't individually tagged) so the respawn
  // path re-detaches the entire split as a single floating window.
  if (saved.detached && detachedOut) {
    detachedOut.push({ id, bounds: saved.bounds, zoom: saved.zoom });
  }
  // A hidden split is parked whole by its root id (same one-target logic).
  if (saved.hidden && hiddenOut) {
    hiddenOut.push(hiddenTarget(id, saved));
  }
  return { type: "split", id, dir: saved.dir, children, sizes };
}

/**
 * Whether a persisted tab record has the shape a restore reads: the three
 * fields every stored record carries (`schema::project::TabEntry`) as strings,
 * `key` a string when present (the backend defaults it — a restore re-mints
 * it anyway), and the optional fields the restorable probe and `loadFromLayout` look at
 * with their declared types. Anything else on the record rides along as is,
 * exactly as it does through a `load_tab_session` restore.
 */
export function isSavedTabEntry(value: unknown): value is SavedTabEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  const optString = (v: unknown) => v === undefined || v === null || typeof v === "string";
  return (
    optString(t.key) &&
    typeof t.label === "string" &&
    typeof t.cmd === "string" &&
    typeof t.cwd === "string" &&
    optString(t.kind) &&
    optString(t.type) &&
    optString(t.sessionId) &&
    optString(t.viewer) &&
    (t.localLaunch === undefined || t.localLaunch === null ||
      (typeof t.localLaunch === "object" && !Array.isArray(t.localLaunch))) &&
    (t.resumeArgs === undefined || t.resumeArgs === null ||
      (Array.isArray(t.resumeArgs) && t.resumeArgs.every((a) => typeof a === "string")))
  );
}

/**
 * The restorable tabs of a saved `tabLayout`, read from `unknown`: records
 * that fail `isSavedTabEntry` are dropped, the rest go through
 * `isRestorableTab` with every field it weighs (`resumeArgs` and
 * `localLaunch` included — a copy that left one out silently dropped such
 * tabs). Every restore path filters through here.
 */
export function restorableSavedTabs(raw: unknown): SavedTabEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSavedTabEntry).filter((tab) =>
    isRestorableTab({
      kind: tab.kind ?? cmdToKind(tab.cmd || (tab.type === "files" ? FILES_TAB_CMD : "")),
      cmd: tab.cmd,
      sessionId: tab.sessionId,
      resumeArgs: tab.resumeArgs,
      viewer: tab.viewer,
      localLaunch: tab.localLaunch,
    }),
  );
}

/** A saved `tabGroups` tree read from `unknown`: the tree when its root is a
 *  well-formed node (`deserializeTree` checks each child as it goes), else
 *  undefined — the restore then puts every tab in one group. */
export function savedLayoutTreeOf(raw: unknown): SavedLayoutTree | undefined {
  return isSavedLayoutNode(raw) ? raw : undefined;
}

/**
 * Drop every tab key not in `keep` from a serialized layout tree, collapsing
 * groups/splits that empty out. Returns null when nothing survives. Used when
 * persisting so the on-disk tree never references tabs we won't restore.
 */
export function pruneSavedTree(
  tree: SavedLayoutTree | null,
  keep: Set<string>,
): SavedLayoutTree | null {
  if (!tree) return null;
  if (tree.type === "group") {
    const tabKeys = tree.tabKeys.filter((k) => keep.has(k));
    if (tabKeys.length === 0) return null;
    const activeKey =
      tree.activeKey && tabKeys.includes(tree.activeKey)
        ? tree.activeKey
        : tabKeys[0];
    // #42: carry the detached tag + bounds through pruning. withDetachedDocked
    // sets these so restore re-opens the group as a floating popout; dropping
    // them here would persist the group as a plain docked node and the popout
    // would restore inside the main panel instead.
    return {
      type: "group",
      tabKeys,
      activeKey,
      ...(tree.detached ? { detached: true, bounds: tree.bounds } : {}),
      // Carry the hidden tag through pruning so a hidden group stays parked on
      // restore rather than docking live (mirrors the detached tag).
      ...(tree.hidden ? { hidden: true, ...(tree.hiddenName ? { hiddenName: tree.hiddenName } : {}) } : {}),
      // Carry the per-subwindow file viewer through pruning (same rationale).
      ...(tree.filesOpen ? { filesOpen: true } : {}),
      ...(tree.filesWidth != null ? { filesWidth: tree.filesWidth } : {}),
      ...(tree.filesFolder ? { filesFolder: tree.filesFolder } : {}),
    };
  }
  const kept = tree.children
    .map((c, i) => ({ child: pruneSavedTree(c, keep), size: tree.sizes[i] ?? 1 }))
    .filter((e): e is { child: SavedLayoutTree; size: number } => e.child != null);
  if (kept.length === 0) return null;
  // #42: carry a multi-pane popout's detached tag + bounds through pruning, just
  // like the group branch — else the split would persist as a plain docked node
  // and the popout would restore inside the main panel.
  const tag = tree.detached
    ? { detached: true as const, bounds: tree.bounds }
    : tree.hidden
      ? { hidden: true as const, ...(tree.hiddenName ? { hiddenName: tree.hiddenName } : {}) }
      : {};
  if (kept.length === 1) {
    // Collapsed to a single surviving child: it inherits the popout's detached
    // tag (so it respawns floating) or the hidden tag (so it stays parked).
    return tree.detached || tree.hidden ? { ...kept[0].child, ...tag } : kept[0].child;
  }
  const total = kept.reduce((a, e) => a + e.size, 0) || 1;
  return {
    type: "split",
    dir: tree.dir,
    children: kept.map((e) => e.child),
    sizes: kept.map((e) => e.size / total),
    ...tag,
  };
}

/**
 * #42: build the saved layout tree that should be PERSISTED for a scope that has
 * detached groups. Each detached group's serialized subtree is appended to the
 * in-window tree as a sibling (row split) — so `project.json` always reflects "if
 * you restarted now, this group would dock here" and the tabs survive even if
 * respawn is unavailable — but its root group is TAGGED `detached: true` (with its
 * last-known `bounds`). On restore, a tagged group is re-opened as a floating
 * popout at `bounds` rather than docked (see loadFromLayout). With no detached
 * groups it returns the in-window tree unchanged.
 *
 * Pure: takes the serialized in-window tree + the scope's detached groups,
 * returns a serialized tree. Pruning to `keep` is the caller's job.
 */
export function withDetachedDocked(
  inWindow: SavedLayoutTree | null,
  detached: DetachedGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const d of detached ?? []) {
    const t = serializeTree(d.subtree);
    if (!t) continue;
    // Tag the popout's root (a single GroupNode, or a SplitNode for a multi-pane
    // popout) so restore respawns the WHOLE subtree as one floating window rather
    // than docking it into the main panel. `detachGroup` re-detaches either shape
    // by the tagged node's id (see deserializeTree → pendingRespawn).
    docked.push({ ...t, detached: true, bounds: d.bounds, zoom: d.zoom });
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}

/**
 * Fold a scope's HIDDEN groups back into its serialized tree, each tagged
 * `hidden: true`, so a restart persists them (their tabs survive) and restore
 * re-parks them into `hiddenGroupsByScope` rather than docking them live. Mirrors
 * `withDetachedDocked`, minus bounds (a hidden group has no OS window).
 */
export function withHiddenDocked(
  inWindow: SavedLayoutTree | null,
  hidden: HiddenGroup[] | undefined,
): SavedLayoutTree | null {
  const docked: SavedLayoutTree[] = [];
  for (const h of hidden ?? []) {
    const t = serializeTree(h.subtree);
    if (!t) continue;
    docked.push({ ...t, hidden: true, ...(h.name ? { hiddenName: h.name } : {}) });
  }
  if (docked.length === 0) return inWindow;
  const all = inWindow ? [inWindow, ...docked] : docked;
  if (all.length === 1) return all[0];
  return {
    type: "split",
    dir: "row",
    children: all,
    sizes: all.map(() => 1 / all.length),
  };
}
