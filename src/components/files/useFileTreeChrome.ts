// The file tree's smaller state clusters: the row tooltip, the search box, the
// embed-capability probe and the mount-only probes. `FileTree` calls these at
// the points its own hooks always ran, so the hook order is unchanged.
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EmbedCap } from "../../stores/drag/drag";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import { type TexCapability, getTexCapability } from "../../lib/viewers/tex/tex";
import { PLATFORM } from "../../lib/window/dragPlatform";
import { warmDragIcon } from "./fileTreeDrag";

/** The row tooltip and its vertical clamp; the dwell timer that opens it stays
 * with the row handlers. */
export function useFileTreeTooltip({ cancelTooltipTimer }: { cancelTooltipTimer: () => void }) {
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; entry: FileEntry } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // Vertical-only correction: a row near the bottom of a short docked viewer
  // (the side panel, a subwindow's file sidebar) still measures its anchor
  // against the WHOLE app window, so an unclamped `top: tooltip.rect.top`
  // could push the tooltip's body past the window's bottom edge. Horizontal
  // placement already picks a side with room (see the style below), so only
  // this axis needs correcting. Measured off `offsetHeight`, not the element's
  // current on-screen rect, so a stale shift from a previous tooltip can't
  // pollute the new measurement.
  const [tooltipShift, setTooltipShift] = useState(0);
  useLayoutEffect(() => {
    if (!tooltip) {
      setTooltipShift(0);
      return;
    }
    const el = tooltipRef.current;
    if (!el) {
      setTooltipShift(0);
      return;
    }
    const overflow = tooltip.rect.top + el.offsetHeight - (window.innerHeight - 8);
    setTooltipShift(overflow > 0 ? overflow : 0);
  }, [tooltip]);
  // Drop a pending dwell timer if the tree unmounts mid-hover, so it can't fire
  // a setState against a gone component.
  // Mount-only: `cancelTooltipTimer` reads a ref, so the first one serves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelTooltipTimer(), []);
  return { tooltip, setTooltip, tooltipRef, tooltipShift };
}

/** The in-tree search box: its query, its fold (host- or self-owned), mode, case and scope. */
export function useFileTreeSearch({
  searchOpenProp, onSearchOpenChange,
}: {
  searchOpenProp: boolean | undefined;
  onSearchOpenChange: ((open: boolean) => void) | undefined;
}) {
  // In-tree search: while `search` is non-empty the tree body is replaced by a
  // flat result list (FileTreeSearch). `searchMode` picks filename vs. content
  // search; `searchCase` only applies to content search (name search is fuzzy).
  // Both backends walk the canonical LOCAL path, so the search box is only shown
  // for a non-remote-source tree (see `remoteListing` in FileTree).
  const [search, setSearch] = useState("");
  // Search folds away and starts CLOSED: the box + mode pills cost two rows of
  // tree on every surface that renders FileTree (the side panel is the tight
  // one), and most sessions browse rather than search. Opening it is one click,
  // and closing clears the query so the tree comes straight back.
  const [searchOpenSelf, setSearchOpenSelf] = useState(false);
  // Who owns the fold: the side panel passes both halves and draws the toggle
  // in its own toolbar; a bare tree keeps the toggle (and the refresh button)
  // in the search row.
  const hostOwnsSearchChrome = onSearchOpenChange !== undefined;
  const searchOpen = hostOwnsSearchChrome ? !!searchOpenProp : searchOpenSelf;
  function setSearchOpen(open: boolean) {
    if (onSearchOpenChange) onSearchOpenChange(open);
    else setSearchOpenSelf(open);
  }
  // Closing must not leave a live query behind: `searching` already ignores it,
  // but the next open would silently repopulate the results view from a query
  // nobody typed now. This is an effect on the RESULT rather than a line in the
  // setter above, because the fold can also be closed from outside the tree
  // entirely — the side panel's toolbar owns that button and never calls in.
  useEffect(() => {
    if (!searchOpen) setSearch("");
  }, [searchOpen]);
  const [searchMode, setSearchMode] = useState<"name" | "content">("name");
  const [searchCase, setSearchCase] = useState(false);
  // Search scope: false (default) confines the search to the browsed folder
  // (`relPath`); true searches from the project root. Only meaningful in a
  // subfolder — at the root the two are identical.
  const [searchRoot, setSearchRoot] = useState(false);
  return { search, setSearch, hostOwnsSearchChrome, searchOpen, setSearchOpen, searchMode, setSearchMode, searchCase, setSearchCase, searchRoot, setSearchRoot };
}

/** Which listed extensions open as an embedded app, asked once per extension. */
export function useFileTreeEmbedCaps({
  entries, embedByExt, setEmbedByExt, projectId,
}: {
  entries: FileEntry[];
  embedByExt: Record<string, boolean>;
  setEmbedByExt: Dispatch<SetStateAction<Record<string, boolean>>>;
  projectId: string | null;
}) {
  // Resolve embed capability for any not-yet-known file extension in view. One
  // backend call per distinct extension; results cached in embedByExt.
  useEffect(() => {
    const unknown = new Map<string, string>(); // ext → a sample path
    for (const e of entries) {
      if (e.is_dir) continue;
      const ext = e.extension ?? "";
      if (!(ext in embedByExt) && !unknown.has(ext)) unknown.set(ext, e.path);
    }
    if (unknown.size === 0) return;
    let cancelled = false;
    (async () => {
      // Fire every distinct-extension capability probe concurrently rather than
      // awaiting each in series (Eff #8): the checks are independent, so the
      // batch finishes in roughly one round-trip instead of N.
      const results = await Promise.all(
        [...unknown].map(async ([ext, path]) => {
          try {
            const cap = await invoke<EmbedCap>("embed_capability", { path, handler: null, projectId });
            return [ext, cap.os_embeddable && cap.app_embeddable] as const;
          } catch {
            return [ext, false] as const;
          }
        }),
      );
      if (!cancelled) setEmbedByExt((m) => ({ ...m, ...Object.fromEntries(results) }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);
}

/** Mount-only work: the TeX toolchain probe, and Ctrl tracking for the native drag-out. */
export function useFileTreeMountProbes({
  setTexCap, setCtrlHeld,
}: {
  setTexCap: Dispatch<SetStateAction<TexCapability | null>>;
  setCtrlHeld: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    let cancelled = false;
    getTexCapability().then((cap) => { if (!cancelled) setTexCap(cap); });
    return () => { cancelled = true; };
    // `setTexCap` is FileTree's state setter, passed in: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track Ctrl so file rows can switch to native DnD (export/copy to browser or
  // an external app) while it's held. Also clear on blur/visibility loss so a
  // release that happens while another window has focus doesn't leave rows stuck
  // in native-drag mode.
  useEffect(() => {
    // Warm the native drag-out preview icon so its path is ready (sync-readable)
    // by the time the user starts a Ctrl-drag. Only the plugin path (Win/mac)
    // needs it — the Linux `start_file_drag` embeds the icon backend-side.
    if (PLATFORM !== "linux") void warmDragIcon();
    const sync = (e: KeyboardEvent) => {
      setCtrlHeld(e.ctrlKey);
    };
    const clear = () => setCtrlHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
    // `setCtrlHeld` is FileTree's state setter, passed in: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
