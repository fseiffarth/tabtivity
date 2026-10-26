// Types shared by `FileTree` and its hooks.
import type React from "react";
import type { FileEntry, InternalViewer } from "../../lib/viewers/fileUtils";

export type GitStatusMap = Record<string, string>;

/** Identity stamped on every `data-move-rel` drop target (see `moveTargetAttrs`). */
export type MoveTargetAttrs = { "data-move-root": string; "data-move-remote": "1" | undefined };

/** The tree's per-row handlers, behind ONE object per tree that never changes
 *  identity (`useRowActions`): the tree rebuilds its closures every render, and
 *  a fresh prop would void every row's memo. Each forwarder reads the latest. */
export interface RowActions {
  click: (ev: React.MouseEvent, entry: FileEntry) => void;
  open: (entry: FileEntry, ev: React.MouseEvent) => void;
  contextMenu: (ev: React.MouseEvent<HTMLDivElement>, entry: FileEntry) => void;
  dragStart: (ev: React.DragEvent<HTMLDivElement>, entry: FileEntry) => void;
  pointerDown: (ev: React.PointerEvent, entry: FileEntry, dragTarget: InternalViewer | "embed" | null) => void;
  mouseEnter: (ev: React.MouseEvent<HTMLDivElement>, entry: FileEntry) => void;
  mouseLeave: () => void;
  syncToLocal: (entry: FileEntry) => void;
  pushToHost: (entry: FileEntry) => void;
  openSyncMerge: (entry: FileEntry) => void;
  runShell: (ev: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) => void;
  runPython: (ev: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) => void;
  /** Right-click on ▶: the run-arguments popover. */
  openRunArgs: (ev: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) => void;
}
