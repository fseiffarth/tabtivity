// Pure viewer-state helpers and the popout seed registry. The pending-position
// stage that writes the store stays in `stores/tabs.ts`.

import type { ViewerState } from "./types";

// Detached windows render their tabs from a Tauri-event SEED into local React
// state; those tabs never enter `useTabsStore` (the main window owns the layout
// store — see DetachedApp/jumpToSource). Viewer hooks seed their per-tab state
// (scroll/zoom + the #45 autocomplete/grammar overrides) from
// `useTabsStore`, so in a detached window that probe misses and the editor falls
// back to the per-type default — e.g. a per-tab autocomplete toggle silently
// reverts to off. This per-window registry lets those hooks recover a detached
// tab's seeded `viewerState` by key. Populated by DetachedApp from each seed;
// lives only in the detached window's heap (no-op/empty in the main window).
const detachedViewerState = new Map<string, ViewerState>();

/** Register (or clear, when `vs` is undefined) a detached tab's seeded
 *  `viewerState` so viewer hooks can read it when `useTabsStore` has no entry. */
export function setDetachedViewerState(key: string, vs: ViewerState | undefined): void {
  if (vs) detachedViewerState.set(key, vs);
  else detachedViewerState.delete(key);
}

/** A detached tab's seeded `viewerState`, or undefined. See {@link setDetachedViewerState}. */
export function getDetachedViewerState(key: string): ViewerState | undefined {
  return detachedViewerState.get(key);
}

// ── TeX workspace sub-panes ─────────────────────────────────────────────────
// A TeX workspace's non-main panes write their view state under
// `<tab key>#<path>`; it lives in the workspace tab's `texPanes[path]`. Tab
// keys (`nextKey`) never hold a `#`, so the first one splits.

/** Most sub-pane entries one workspace tab keeps (`ViewerState.texPanes`). */
export const TEX_PANES_CAP = 32;

/** `<tab key>#<path>` → its parts; null for a plain tab key. */
export function splitSubPaneKey(key: string): { tab: string; sub: string } | null {
  const i = key.indexOf("#");
  return i > 0 ? { tab: key.slice(0, i), sub: key.slice(i + 1) } : null;
}

/** The part of a tab's `vs` that `sub` names: the tab's own (null), or a sub-pane's. */
export function pickViewerState(vs: ViewerState | undefined, sub: string | null): ViewerState | undefined {
  return sub === null ? vs : vs?.texPanes?.[sub];
}

/**
 * `vs` with `patch` merged in — into the tab's own fields (`sub` null) or
 * sub-pane `sub`'s entry — or `vs` itself when nothing changes. A written
 * sub-pane moves to the end of `texPanes`; past `TEX_PANES_CAP` the oldest go.
 */
export function withViewerPatch(
  vs: ViewerState | undefined,
  sub: string | null,
  patch: ViewerState,
): ViewerState | undefined {
  if (sub === null) return viewerStateChanged(vs, patch) ? { ...vs, ...patch } : vs;
  const panes = vs?.texPanes ?? {};
  const cur = panes[sub];
  if (!viewerStateChanged(cur, patch)) return vs;
  const next: Record<string, ViewerState> = {};
  for (const [p, v] of Object.entries(panes)) if (p !== sub) next[p] = v;
  next[sub] = { ...cur, ...patch };
  const paths = Object.keys(next);
  for (const p of paths.slice(0, Math.max(0, paths.length - TEX_PANES_CAP))) delete next[p];
  return { ...vs, texPanes: next };
}

/** Whether a `viewerState` merge of `patch` over `cur` changes anything —
 *  shallow over the union of keys; arrays/objects compare by reference, which is
 *  right: viewers hand in a fresh ref precisely when such a field changed. */
export function viewerStateChanged(cur: ViewerState | undefined, patch: ViewerState): boolean {
  const c = (cur ?? {}) as Record<string, unknown>;
  const p = patch as Record<string, unknown>;
  return Object.keys(p).some((k) => c[k] !== p[k]);
}
