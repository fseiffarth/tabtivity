import { useCallback, useEffect, useMemo, useState } from "react";
import {
  flushViewerState,
  pendingViewerState,
  persistedViewerState,
  useTabsStore,
  type ViewerState,
} from "../../../stores/tabs";
import { usePaneVisible } from "../../../lib/files/fileAccess";

/**
 * Persisted reader-position plumbing for an in-app viewer. Snapshots the tab's
 * saved `ViewerState` once (so the viewer restores scroll/zoom/pan from where the
 * reader left it on mount, rather than reacting to its own later writes) and
 * returns a stable `persist` that merges a patch back into the tab — flushed to
 * project.json by CenterPanel's debounced saveLayout, so the position survives an
 * Tabtivity restart. A no-op when `tabKey` is absent (e.g. tests).
 */
/**
 * A tab's persisted `ViewerState` seed, read once. Normally from `useTabsStore`
 * (the main window owns the layout store); in a DETACHED window that store has
 * no entry for the tab — its tabs render from a Tauri seed into local React
 * state, not the store — so fall back to the detached seed registry. Without
 * this fallback a detached editor loses per-tab scroll/zoom and the #45
 * autocomplete/spelling toggles, silently reverting to the per-type defaults.
 */
export function seedViewerState(tabKey: string | undefined): ViewerState | undefined {
  if (!tabKey) return undefined;
  // A TeX workspace sub-pane's key (`<tab>#<path>`) reads its entry in the
  // workspace tab's `texPanes`.
  const stored = persistedViewerState(useTabsStore.getState(), tabKey);
  // A position written since the last flush (performance plan §3.1) outranks
  // the store's: a viewer remounting (a sleeping PDF waking) restores it.
  const pending = pendingViewerState(tabKey);
  return pending ? { ...stored, ...pending } : stored;
}

export function useViewerState(tabKey: string | undefined) {
  const [initial] = useState<ViewerState | undefined>(() => seedViewerState(tabKey));
  const persist = useCallback(
    (patch: ViewerState) => {
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );
  // §3.1: a position is staged, not written, while the reader moves. Fold it
  // into the store when the pane leaves the screen and when the viewer unmounts
  // — the two moments after which nothing else would write it.
  const visible = usePaneVisible();
  useEffect(() => {
    if (!visible && tabKey) flushViewerState(tabKey);
  }, [visible, tabKey]);
  useEffect(
    () => () => {
      if (tabKey) flushViewerState(tabKey);
    },
    [tabKey],
  );
  // Stable object so consumers can list `viewPos` in effect/callback deps without
  // re-running every render (`initial` and `persist` are both stable).
  return useMemo(() => ({ initial, persist }), [initial, persist]);
}
