/**
 * Modal dialogs wear `DialogShell` (components/common/PromptDialogs.tsx): one
 * frame owning the backdrop, focus, Escape, the elevated layer, the title row
 * and the scroll frame. Each dialog that built `.modal-backdrop` itself got one
 * of those wrong somewhere: a black title on a dark theme, a press bubbling
 * through the backdrop into the host, a scrollbar cutting the rounded corner.
 *
 * A ratchet, not a sweep: the files below still build their own and may keep
 * doing so until they are touched. A file not on the list may not start, and
 * a file that moves to `DialogShell` leaves the list (the second test says so).
 */
import { describe, it, expect } from "vitest";

const SOURCES = import.meta.glob("../../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** A class string that holds `modal-backdrop` as a class of its own. */
const BUILDS_BACKDROP = /["'`](?:[^"'`\n]*\s)?modal-backdrop(?:["'`\s])/u;

const STILL_HAND_ROLLED = new Set([
  "agents/AgentScheduleDialog.tsx",
  "browser/BrowserDownloadDialog.tsx",
  "calendar/CalDavAccountDialog.tsx",
  "calendar/CalDavConflictDialog.tsx",
  "calendar/EventDialog.tsx",
  "calendar/IcsImportReviewDialog.tsx",
  "common/FolderPickerDialog.tsx",
  "common/HostKeyConfirmDialog.tsx",
  "common/HpcGuardDialog.tsx",
  "common/LocalLossDialog.tsx",
  "common/RemoteUsageWarningDialog.tsx",
  "common/ServerFilePicker.tsx",
  "common/StopProjectDialog.tsx",
  "common/SyncConfirmDialog.tsx",
  "embed/deck/IconPicker.tsx",
  "embed/pdf/PdfLinkDialog.tsx",
  "files/FileTree.tsx",
  "files/GitHistory.tsx",
  "files/ProjectFilesSettings.tsx",
  "files/SendToProjectDialog.tsx",
  "files/SetDefaultAppDialog.tsx",
  "files/importDrop.tsx",
  "header/AppTimerDisplay.tsx",
  "header/HelpAgentSetup.tsx",
  "layout/CommandPalette.tsx",
  "layout/DetachedCloseChoice.tsx",
  "layout/HowToStart.tsx",
  "layout/LessonsMenu.tsx",
  "layout/RemoteFeaturesPrompt.tsx",
  "layout/RootOverlay.tsx",
  "layout/SettingsPanel.tsx",
  "layout/ThemeCustomizer.tsx",
  "layout/VpnPasswordPrompt.tsx",
  "mail/MailAccountDialog.tsx",
  "mail/MailAiSettingsDialog.tsx",
  "mail/MailComposeDialog.tsx",
  "mail/MailEncryptionDialog.tsx",
  "mail/MailFiltersDialog.tsx",
  "mail/MailKeysDialog.tsx",
  "mail/MailMessageView.tsx",
  "mobile/MobileSetupGuide.tsx",
  "mobile/PairedDeviceDialog.tsx",
  "monitoring/GlobalMachineMonitorDialog.tsx",
  "projects/BigFolderExcludeDialog.tsx",
  "projects/BoxEditorDialog.tsx",
  "projects/ExtendToRemoteDialog.tsx",
  "projects/HpcPipelineWizard.tsx",
  "projects/ProjectDialog.tsx",
  "projects/ProjectExportDialog.tsx",
  "projects/ProjectImportBundleDialog.tsx",
  "projects/ProjectMigrationDialog.tsx",
  "projects/ProjectPill.tsx",
  "projects/ProjectSetExportDialog.tsx",
  "projects/ProjectSetImportDialog.tsx",
  "projects/PythonInterpreterWindow.tsx",
  "projects/RemoteConnectDialog.tsx",
  "projects/RemoteMachinesWindow.tsx",
  "projects/VmSettingsDialog.tsx",
  "stats/StatsRecap.tsx",
  "tabs/CustomAgentDialog.tsx",
  "terminal/TerminalLimitHandoff.tsx",
  "todo/TodoCardDialog.tsx",
]);

const handRolled = Object.entries(SOURCES)
  .filter(([path, source]) => !path.endsWith("common/PromptDialogs.tsx") && BUILDS_BACKDROP.test(source))
  .map(([path]) => path.replace("../../components/", ""));

describe("modal dialogs wear DialogShell", () => {
  it("no new component builds its own .modal-backdrop", () => {
    expect(handRolled.filter((path) => !STILL_HAND_ROLLED.has(path))).toEqual([]);
  });

  it("a component that moved to DialogShell has left the list", () => {
    expect([...STILL_HAND_ROLLED].filter((path) => !handRolled.includes(path))).toEqual([]);
  });
});
