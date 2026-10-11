import { useT } from "../../lib/i18n";
import { basename, dirname } from "../../lib/paths";
import { UntestedTag } from "../common/UntestedTag";
import { TextPromptDialog } from "../common/PromptDialogs";

/**
 * Renaming a file or folder, in Tabtivity's own chrome.
 *
 * Both file surfaces used to call `window.prompt()`, which WebKitGTK renders as
 * a bare browser alert headed with the page origin — "localhost:1420 says" in a
 * dev window, a blank system box in a packaged one. It ignores the theme, cannot
 * say what folder the file is in, and reports a failed rename by throwing the
 * typed name away.
 *
 * Shared rather than written twice: `FileTree` (the panel/Files-tab tree) and
 * `FileBrowser` (the middle file browser) both rename, and a rename that looks
 * and behaves differently depending on which pane you started it from is exactly
 * the drift the shared-viewer rule exists to stop.
 *
 * The chrome itself now lives in `TextPromptDialog` (`common/PromptDialogs`),
 * which the panel's other name prompts — New File, New Folder, New Presentation,
 * rename-session — also wear, so this dialog can no longer be the only gesture
 * in the panel that looks like Tabtivity.
 */
export function RenameDialog({
  entryName,
  isDir,
  folder,
  onCancel,
  onRename,
}: {
  /** Current name, pre-filled into the field. */
  entryName: string;
  /** Folders get the folder wording and no extension-aware selection. */
  isDir: boolean;
  /** Containing folder, named so the user can see *which* copy this is. */
  folder: string;
  onCancel: () => void;
  /** Performs the rename. Rejecting keeps the dialog open with the message on
   *  it; resolving leaves closing to the caller (which unmounts this). */
  onRename: (next: string) => Promise<void>;
}) {
  const t = useT();
  return (
    <TextPromptDialog
      title={
        <>
          {t(isDir ? "fileTree.renameFolderTitle" : "fileTree.renameFileTitle")} <UntestedTag id="renameDialog.1" />
        </>
      }
      body={
        <>
          <strong>{entryName}</strong> {t("fileTree.renameInPre")} <strong>{folder}</strong>{" "}
          {t("fileTree.renameToPost")}
        </>
      }
      label={t("fileTree.renameToPrompt")}
      initial={entryName}
      confirmLabel={t("common.rename")}
      // Selects the stem, not the extension: renaming a file almost never means
      // renaming ".tsx", so the suffix stays put while the part being changed is
      // already highlighted.
      selectStem={!isDir}
      unchanged={entryName}
      // A path separator would not rename but move — refused here rather than
      // left to the backend, so the message lands next to the field that caused
      // it.
      validate={(next) =>
        next.includes("/") || next.includes("\\") ? t("fileTree.invalidFileName") : null
      }
      onCancel={onCancel}
      onSubmit={onRename}
    />
  );
}

/** The containing folder's display name for `folder`, from an entry's absolute
 *  path — the project root falls back to a phrase rather than an empty string. */
export function containingFolderLabel(absPath: string, rootLabel: string): string {
  return basename(dirname(absPath)) || rootLabel;
}
