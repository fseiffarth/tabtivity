import { create } from "zustand";
import type { FileSource } from "../../lib/files/fileAccess";

/**
 * Ephemeral, non-persisted map of a viewer tab's resolved file source
 * (`"remote"` = read straight from the host over SFTP, `"local"` = the paired
 * local mirror copy, `"none"` = a local project / not applicable), keyed by tab
 * key. `FileViewerPane` publishes each viewer tab's source here so the tab strip
 * can render the Remote/Local badge on the tab itself instead of spending a
 * whole header row on it. Cleared when the viewer unmounts.
 */
/**
 * The Local/Remote switch a viewer tab exposes, mirrored out of `FileViewerPane`
 * (which owns the `sideOverride` state) so the tab strip's file-source badge can
 * be a *clickable* toggle — not just a read-only glyph — for a file that exists on
 * both sides of a remote project. Absent when switching doesn't apply (local
 * project, or a path with no counterpart on the other side). `remoteDisabled`
 * means the host has no such file, so the badge must not flip to remote.
 */
export interface FileSourceControls {
  current: "local" | "remote";
  set: (s: "local" | "remote") => void;
  remoteDisabled: boolean;
}

interface FileSourcesStore {
  byTab: Record<string, FileSource>;
  controlsByTab: Record<string, FileSourceControls>;
  setSource: (tabKey: string, source: FileSource) => void;
  clearSource: (tabKey: string) => void;
  setControls: (tabKey: string, controls: FileSourceControls) => void;
  clearControls: (tabKey: string) => void;
}

export const useFileSourcesStore = create<FileSourcesStore>((set) => ({
  byTab: {},
  controlsByTab: {},
  setSource: (tabKey, source) =>
    set((s) =>
      s.byTab[tabKey] === source ? s : { byTab: { ...s.byTab, [tabKey]: source } },
    ),
  clearSource: (tabKey) =>
    set((s) => {
      if (!(tabKey in s.byTab)) return s;
      const next = { ...s.byTab };
      delete next[tabKey];
      return { byTab: next };
    }),
  setControls: (tabKey, controls) =>
    set((s) => ({ controlsByTab: { ...s.controlsByTab, [tabKey]: controls } })),
  clearControls: (tabKey) =>
    set((s) => {
      if (!(tabKey in s.controlsByTab)) return s;
      const next = { ...s.controlsByTab };
      delete next[tabKey];
      return { byTab: s.byTab, controlsByTab: next };
    }),
}));
