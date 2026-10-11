import { useEffect, useRef, type RefObject } from "react";
import { create } from "zustand";

/**
 * Proportional scroll-linking between two side-by-side viewer subwindows.
 *
 * When the user links two adjacent viewer subwindows (text/code/markdown/PDF)
 * via the divider button, scrolling one drives the other by RATIO — content
 * heights differ, so this mirrors `CompareView`'s 3-pane `syncFrom` rather than
 * copying a raw `scrollTop`. Links are keyed by **group id** (a subwindow), held
 * symmetrically (`links[a]=b` and `links[b]=a`), and are ephemeral: they live
 * only in memory and are pruned when either endpoint stops being a syncable
 * viewer (see `CenterPanel`), matching the ephemeral `fullscreenGroupId` model.
 *
 * Each mounted viewer registers a `ScrollHandle` for its group id (via the
 * `useScrollSync` hook) and reports its scroll ratio; the store forwards that
 * ratio to the linked partner's handle. Two guards break the feedback loop: a
 * module-level `suppress` flag for a synchronous bounce, and each pane's
 * remembered echo position for the asynchronous scroll event the mirrored write
 * fires (see `useScrollSync`).
 *
 * Links survive switching projects: `CenterPanel` prunes against the syncable
 * groups of EVERY scope's layout, so a pair in a project that is not showing
 * stays linked until one of its subwindows really goes away.
 */
export interface ScrollHandle {
  /** Scroll this pane to a normalized [0,1] ratio of its scrollable height. */
  applyRatio: (ratio: number) => void;
}

interface ScrollSyncState {
  /** Symmetric adjacency: `links[a] === b` iff a and b are linked. */
  links: Record<string, string>;
  /** Live per-group scroll handles. A plain Map (non-reactive) — only `links`
   *  drives re-renders (the divider button); scroll forwarding reads handles
   *  imperatively. */
  handles: Map<string, ScrollHandle>;
  isLinked: (a: string, b: string) => boolean;
  /** Link a↔b if unlinked, otherwise unlink them. */
  toggleLink: (a: string, b: string) => void;
  register: (groupId: string, h: ScrollHandle) => () => void;
  /** Push `groupId`'s current scroll ratio to its linked partner (if any). */
  report: (groupId: string, ratio: number) => void;
  /** Drop any link whose endpoints are no longer both valid syncable groups. */
  prune: (validGroups: Set<string>) => void;
}

// Re-entrancy guard: true while we're applying a ratio to a partner pane. A
// handler that scrolls synchronously in response (or a test that models the
// induced scroll inline) must NOT bounce back as a fresh `report`. Held only for
// the synchronous span of `applyRatio` (cleared in `finally`). The real,
// asynchronous scroll event the mirrored write triggers is NOT harmless: it
// reports the partner's position back as a ratio, and the partner's scrollTop
// has been rounded to a device pixel (and a PDF's scrollHeight shifts as its
// pages settle), so the originator is nudged by a pixel or so, which reports
// again, and so on — both panes creep along by themselves. `useScrollSync`
// swallows that echo instead.
let suppress = false;

export const useScrollSyncStore = create<ScrollSyncState>((set, get) => ({
  links: {},
  handles: new Map(),
  isLinked: (a, b) => get().links[a] === b,
  toggleLink: (a, b) =>
    set((s) => {
      const next = { ...s.links };
      if (next[a] === b) {
        delete next[a];
        delete next[b];
      } else {
        // A group links to at most one partner; drop any prior pairing on both
        // sides before forming the new one so `links` stays a clean matching.
        if (next[a]) delete next[next[a]];
        if (next[b]) delete next[next[b]];
        next[a] = b;
        next[b] = a;
      }
      return { links: next };
    }),
  register: (groupId, h) => {
    get().handles.set(groupId, h);
    return () => {
      // Only remove if it's still ours (a remount may have replaced it).
      if (get().handles.get(groupId) === h) get().handles.delete(groupId);
    };
  },
  report: (groupId, ratio) => {
    if (suppress) return;
    const partner = get().links[groupId];
    if (!partner) return;
    const handle = get().handles.get(partner);
    if (!handle) return;
    suppress = true;
    try {
      handle.applyRatio(ratio);
    } finally {
      suppress = false;
    }
  },
  prune: (validGroups) =>
    set((s) => {
      let changed = false;
      const next = { ...s.links };
      for (const [a, b] of Object.entries(s.links)) {
        if (!validGroups.has(a) || !validGroups.has(b)) {
          delete next[a];
          delete next[b];
          changed = true;
        }
      }
      return changed ? { links: next } : {};
    }),
}));

/**
 * Wire a viewer's scroll container into the scroll-sync store for `groupId`.
 *
 * Registers an `applyRatio` handle (which sets `scrollTop` on `elRef` while the
 * store's suppress guard is up) and returns an `onScroll` handler the caller
 * attaches to that same container. No-op when `groupId` is null/undefined (the
 * pane isn't placed in a syncable group) or the ref is empty. The handle is
 * re-registered whenever `groupId` changes.
 */
export function useScrollSync(
  groupId: string | null | undefined,
  elRef: RefObject<HTMLElement>,
): () => void {
  // Where the last mirrored write left this pane. The scroll event that write
  // fires later is the partner's own movement coming back, not the reader's, so
  // it is not reported (see the `suppress` note above).
  const echoTop = useRef<number | null>(null);
  useEffect(() => {
    if (!groupId) return;
    const handle: ScrollHandle = {
      applyRatio: (ratio) => {
        const el = elRef.current;
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) return;
        const before = el.scrollTop;
        el.scrollTop = ratio * max;
        // Read back: the engine clamps and rounds. An unchanged position fires
        // no scroll event, so there is no echo to wait for.
        echoTop.current = el.scrollTop !== before ? el.scrollTop : null;
      },
    };
    return useScrollSyncStore.getState().register(groupId, handle);
  }, [groupId, elRef]);

  // Stable onScroll: reads the live ref + groupId through a ref so attaching it
  // once (uncontrolled) still reports against the current group.
  const gidRef = useRef(groupId);
  gidRef.current = groupId;
  const onScrollRef = useRef(() => {
    const gid = gidRef.current;
    const el = elRef.current;
    if (!gid || !el) return;
    // Check for a partner BEFORE touching any geometry. `scrollHeight` and
    // `clientHeight` are layout-flushing reads: asking for either forces a
    // synchronous style+layout pass over the whole pane, and this handler runs
    // on EVERY scroll event of documents that are routinely tens of thousands
    // of nodes deep (a code file's gutter is one element per line, its
    // highlight <pre> one span per token). Linking two subwindows is the rare
    // case, so the common path was paying a full forced layout per wheel tick
    // only to discover in `report` that there is nobody to forward to — which
    // is what made scrolling a large .py or a long rendered .md crawl.
    const store = useScrollSyncStore.getState();
    const echo = echoTop.current;
    echoTop.current = null;
    if (!store.links[gid]) return;
    if (echo != null && Math.abs(el.scrollTop - echo) < 1) return;
    const max = el.scrollHeight - el.clientHeight;
    store.report(gid, max > 0 ? el.scrollTop / max : 0);
  });
  return onScrollRef.current;
}
