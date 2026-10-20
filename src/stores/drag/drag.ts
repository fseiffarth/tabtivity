import { create } from "zustand";
import type { DropEdge } from "../tabs";
import type { InternalViewer } from "../../lib/viewers/fileUtils";

/**
 * Result of the backend `embed_capability` check for a dragged file, prefetched
 * when a file drag starts. `null` while the query is in flight.
 */
export interface EmbedCap {
  os_embeddable: boolean;
  app_embeddable: boolean;
  resolved_exec: string | null;
}

/**
 * Pointer-driven drag state. Kept separate from the tabs store so the
 * high-frequency pointermove updates during a drag (coords, hover target) don't
 * churn the tab tree / re-render every subwindow. The tabs store is only
 * touched once, on the committed drop.
 *
 * Two drag kinds share this state:
 *  - "tab"  — an existing tab being reordered / moved / split (TabBar source).
 *  - "group" — a whole subwindow dragged by its tab bar's grip: rearranged in
 *             the layout like a tab (an edge moves it there, a bar or body
 *             merges its tabs in). It never pops out — the ⧉ button does that.
 *  - "file" — a file row dragged from the side-panel FileTree to open as an
 *             embedded tab (TODO Group K #40). A tab-bar drop adds the embed tab
 *             to that group; a subwindow-body edge drop carves out a NEW
 *             subwindow holding it (overGroup/edge, like tab drags). Capability
 *             is resolved at release time (embed vs external), not a drop gate.
 */
/** One file in a multi-file FileTree drag. `viewer` is the built-in viewer that
 *  should render it (resolved at drag start), else undefined → external embed. */
export interface FileDragItem {
  path: string;
  name: string;
  viewer?: InternalViewer;
}

export interface TabDrag {
  kind: "tab" | "group" | "file" | "link" | "detached";
  key: string; // the dragged tab's key (tab drags); "" for group/file/link/detached drags
  fromGroup: string; // group the tab started in, or the dragged group; "" for file drags
  label: string; // shown in the floating ghost
  pointerX: number;
  pointerY: number;
  // Edge-split target: a subwindow group + the edge the pointer is over.
  overGroup: string | null;
  edge: DropEdge | null;
  // Within-bar reorder target: a tab bar's group + the insertion slot.
  reorderGroup: string | null;
  reorderIndex: number | null;
  // ── File-drag payload (kind === "file") ──────────────────────────────────
  filePath?: string; // absolute path of the dragged file
  fileName?: string; // basename, used to label the embed tab
  fileExec?: string; // explicit handler hint, if any
  // When set, drop opens the file in the named built-in viewer (pdf/image/
  // markdown/text/tex) rather than the external embed path. See commitFileDrop.
  viewer?: InternalViewer;
  // Multi-file drag (dragging a selection from the FileTree). When present with
  // length > 1, commitFileDrop repeats each drop branch per file (one embed tab
  // each), and drag-to-move relocates every one. `filePath`/`fileName`/`viewer`
  // still describe the primary (first) file so single-file consumers keep
  // working; a length-1 array is equivalent to a plain single-file drag.
  files?: FileDragItem[];
  // Prefetched capability for this file (null while the query is in flight).
  embedCap?: EmbedCap | null;
  // ── Link-drag payload (kind === "link") ───────────────────────────────────
  // A file LINK dragged out of a viewer to set its session-only target
  // subwindow (#50). Carries the linking tab's key and the target file path +
  // viewer; on a subwindow drop CenterPanel records the route and opens it
  // there. linkTargetPath doubles as `filePath` so the existing ghost label and
  // open paths can reuse it.
  linkingTabKey?: string;
  linkTargetPath?: string;
  // ── Detached-window drag payload (kind === "detached") ────────────────────
  // #42: a whole popped-out subwindow being dragged back onto the main window.
  // Driven by pointer coords streamed from the detached window (which has the
  // pointer capture); on release over a group the main window docks the group via
  // attachGroup. Identifies the detached group to dock.
  detachedScope?: string;
  detachedGroupId?: string;
  // #42: set when a SINGLE tab (not the whole group) is being dragged out of a
  // popout. The host then docks just this tab into the main layout via
  // attachDetachedTab instead of re-attaching the whole group.
  detachedTabKey?: string;
  // #42: set when ONE PANE (inner group) of a MULTI-pane popout is being dragged
  // by its bar grip. The host then docks just this pane via attachDetachedPane —
  // never the whole popout, so its sibling panes stay floating.
  detachedPaneId?: string;
  // ── Content thumbnail (tab drags) ─────────────────────────────────────────
  // A clone of the dragged tab's live pane DOM, captured once at drag start, so
  // the floating ghost can preview the tab's CONTENT (not just its label). The
  // ghost mounts this node and scales it to `previewW`×`previewH` (the source
  // pane's measured size). Absent for file/link/detached drags.
  previewNode?: HTMLElement | null;
  previewW?: number;
  previewH?: number;
}

interface DragStore {
  drag: TabDrag | null;
  start: (
    d: Pick<
      TabDrag,
      | "key"
      | "fromGroup"
      | "label"
      | "pointerX"
      | "pointerY"
      | "previewNode"
      | "previewW"
      | "previewH"
    >,
  ) => void;
  startGroupDrag: (d: Pick<TabDrag, "fromGroup" | "label" | "pointerX" | "pointerY">) => void;
  startFileDrag: (
    d: Pick<TabDrag, "label" | "pointerX" | "pointerY"> & {
      filePath: string;
      fileName: string;
      fileExec?: string;
      viewer?: InternalViewer;
      files?: FileDragItem[];
    },
  ) => void;
  startLinkDrag: (
    d: Pick<TabDrag, "label" | "pointerX" | "pointerY"> & {
      linkingTabKey: string;
      linkTargetPath: string;
      viewer: InternalViewer;
    },
  ) => void;
  startDetachedDrag: (
    d: Pick<TabDrag, "label" | "pointerX" | "pointerY"> & {
      detachedScope: string;
      detachedGroupId: string;
      detachedTabKey?: string;
      detachedPaneId?: string;
    },
  ) => void;
  setEmbedCap: (cap: EmbedCap | null) => void;
  move: (x: number, y: number) => void;
  setTarget: (
    t: Pick<TabDrag, "overGroup" | "edge" | "reorderGroup" | "reorderIndex">,
  ) => void;
  end: () => void;
}

export const useDragStore = create<DragStore>((set) => ({
  drag: null,
  start: (d) =>
    set({
      drag: {
        kind: "tab",
        ...d,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
      },
    }),
  startGroupDrag: (d) =>
    set({
      drag: {
        kind: "group",
        key: "",
        ...d,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
      },
    }),
  startFileDrag: (d) =>
    set({
      drag: {
        kind: "file",
        key: "",
        fromGroup: "",
        label: d.label,
        pointerX: d.pointerX,
        pointerY: d.pointerY,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
        filePath: d.filePath,
        fileName: d.fileName,
        fileExec: d.fileExec,
        viewer: d.viewer,
        files: d.files,
        embedCap: null,
      },
    }),
  startLinkDrag: (d) =>
    set({
      drag: {
        kind: "link",
        key: "",
        fromGroup: "",
        label: d.label,
        pointerX: d.pointerX,
        pointerY: d.pointerY,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
        linkingTabKey: d.linkingTabKey,
        linkTargetPath: d.linkTargetPath,
        viewer: d.viewer,
        embedCap: null,
      },
    }),
  startDetachedDrag: (d) =>
    set({
      drag: {
        kind: "detached",
        key: "",
        fromGroup: "",
        label: d.label,
        pointerX: d.pointerX,
        pointerY: d.pointerY,
        overGroup: null,
        edge: null,
        reorderGroup: null,
        reorderIndex: null,
        detachedScope: d.detachedScope,
        detachedGroupId: d.detachedGroupId,
        detachedTabKey: d.detachedTabKey,
        detachedPaneId: d.detachedPaneId,
      },
    }),
  setEmbedCap: (cap) =>
    set((s) => (s.drag ? { drag: { ...s.drag, embedCap: cap } } : {})),
  move: (x, y) =>
    set((s) =>
      s.drag ? { drag: { ...s.drag, pointerX: x, pointerY: y } } : {},
    ),
  setTarget: (t) =>
    set((s) => (s.drag ? { drag: { ...s.drag, ...t } } : {})),
  end: () => set({ drag: null }),
}));
