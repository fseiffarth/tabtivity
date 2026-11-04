import { create } from "zustand";

/**
 * Open/closed state for the box sheet (`BoxEditorDialog`), mounted once in
 * `AppShell` (the RemoteMachines host pattern) so it can be opened from any of
 * its doors — the box chip's menu ("Edit box…", "Edit boxes…") and the empty-box
 * line's "Add projects…" button — without prop-drilling.
 *
 * The sheet edits ONE box: `boxId` is that box and there is no create mode (a
 * box is born through the name prompt, `useQuickCreateBox`) and no way to swap
 * the target from inside the sheet, so a half-made draft is never discarded by
 * a click on another box.
 */
interface BoxEditorStore {
  open: boolean;
  /** The box being edited; null while the sheet is closed. */
  boxId: string | null;
  /** The box whose pill is being renamed inline, or null. Lifted out of
   *  `BoxScopeChip`'s state so a gesture elsewhere (the Alt-drag that just made
   *  a box) can put the new box's pill straight into rename. The pill row reads
   *  it; `startRename`/`stopRename` are the only writers. */
  renamingId: string | null;
  startRename: (boxId: string) => void;
  stopRename: () => void;
  openEditor: (boxId: string) => void;
  close: () => void;
}

export const useBoxEditorStore = create<BoxEditorStore>((set) => ({
  open: false,
  boxId: null,
  renamingId: null,
  startRename: (boxId) => set({ renamingId: boxId }),
  stopRename: () => set({ renamingId: null }),
  openEditor: (boxId) => set({ open: true, boxId }),
  close: () => set({ open: false, boxId: null }),
}));
