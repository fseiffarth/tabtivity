import { create } from "zustand";

/**
 * Open/closed state for the Box editor dialog (`BoxEditorDialog`), mounted once
 * in `AppShell` (the RemoteMachines host pattern) so it can be opened from any
 * of its four doors — the box chip's menu, a pill's Boxes group, the multi-select
 * "Box these…" action, and the switcher's "+" menu — without prop-drilling.
 *
 * `boxId: null` is CREATE mode (a new box, `initialMemberIds` pre-checked);
 * a non-null `boxId` edits that box. The dialog itself carries a box selector,
 * so an editor opened on one box can move to another without a round trip here.
 */
interface BoxEditorStore {
  open: boolean;
  /** Box being edited, or null for create mode. */
  boxId: string | null;
  /** Pre-checked member ids when opening in create mode. */
  initialMemberIds: string[];
  /** The box whose pill is being renamed inline, or null. Lifted out of
   *  `BoxScopeChip`'s state so a gesture elsewhere (the Alt-drag that just made
   *  a box) can put the new box's pill straight into rename. The pill row reads
   *  it; `startRename`/`stopRename` are the only writers. */
  renamingId: string | null;
  startRename: (boxId: string) => void;
  stopRename: () => void;
  openEditor: (boxId: string | null) => void;
  openCreate: (memberIds?: string[]) => void;
  close: () => void;
}

export const useBoxEditorStore = create<BoxEditorStore>((set) => ({
  open: false,
  boxId: null,
  initialMemberIds: [],
  renamingId: null,
  startRename: (boxId) => set({ renamingId: boxId }),
  stopRename: () => set({ renamingId: null }),
  openEditor: (boxId) => set({ open: true, boxId, initialMemberIds: [] }),
  openCreate: (memberIds = []) => set({ open: true, boxId: null, initialMemberIds: memberIds }),
  close: () => set({ open: false, boxId: null, initialMemberIds: [] }),
}));
