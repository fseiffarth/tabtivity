import { useT } from "../../lib/i18n";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../../lib/viewers/fileUtils";
import { FileViewerPane } from "../embed/FileViewerPane";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { UntestedTag } from "../common/UntestedTag";
import { ArrowUpRightIcon, CloseIcon } from "../common/icons/Icon";

/** A file the conversation on screen names: a resolved path link, a picture
 * or PDF an answer shows, a file the phone sent into the inbox. */
export interface ReaderFile {
  entry: FileEntry;
  /** Its path as the list shows it (relative to the tab's folder). */
  label: string;
}

/**
 * The Reader's Files tab, beside Chat and Diffs: the files the conversation
 * names (`TerminalReaderView`'s list, newest first) and the picked one in its
 * in-app viewer — the same `FileViewerPane` a viewer tab hosts — so a click in
 * the chat shows a file here instead of opening a tab. ↗ (Ctrl+click: a new
 * subwindow) still opens it as a tab. The Diffs tab's classes, one layout.
 */
export function TerminalReaderFiles({ files, picked, projectId, disabled, visible, scopeNote, onPick, onOpenTab, onClose }: {
  files: readonly ReaderFile[];
  /** The file in the viewer; it stays there when another chat's list lacks it. */
  picked: FileEntry | null;
  projectId: string | null;
  disabled?: ReadonlySet<InternalViewer>;
  visible: boolean;
  /** Whose files these are, when not the session's own chat (a subagent's, an earlier chat's). */
  scopeNote?: string;
  onPick: (entry: FileEntry) => void;
  onOpenTab: (entry: FileEntry, newSubwindow: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const viewer = picked ? internalViewerFor(picked, disabled) : null;
  return (
    <aside className={`terminal-changes terminal-changes-tab terminal-files ${SIGN_IN_CARD_CLASS}`} aria-label={t("terminal.readerFiles.title")} tabIndex={-1}>
      <header className="terminal-changes-head">
        <strong>{t("terminal.readerFiles.title")}</strong>
        <UntestedTag id="terminal.reader.files" />
        {picked && <small className="terminal-changes-path" title={picked.path}>{picked.name}</small>}
        {picked && (
          <button type="button" className="terminal-changes-close terminal-files-open"
            onClick={(event) => onOpenTab(picked, event.ctrlKey || event.metaKey)}
            title={t("terminal.readerFiles.openTab")} aria-label={t("terminal.readerFiles.openTab")}>
            <ArrowUpRightIcon />
          </button>
        )}
        <button type="button" className="terminal-changes-close" onClick={onClose} title={t("terminal.readerFiles.close")} aria-label={t("terminal.readerFiles.close")}>
          <CloseIcon />
        </button>
      </header>
      {scopeNote && <small className="terminal-changes-scope" title={scopeNote}>{scopeNote}</small>}
      <div className="terminal-changes-body">
        {files.length > 0 && (
          <div className="terminal-changes-files" role="listbox" aria-label={t("terminal.readerFiles.list")}>
            {files.map((file) => {
              const active = picked?.path === file.entry.path;
              return (
                <button type="button" role="option" key={file.entry.path} aria-selected={active}
                  className={active ? "active" : undefined} title={file.entry.path}
                  onClick={(event) => (event.ctrlKey || event.metaKey ? onOpenTab(file.entry, true) : onPick(file.entry))}>
                  <span className="terminal-changes-path"><strong>{file.label}</strong></span>
                </button>
              );
            })}
          </div>
        )}
        <div className="terminal-files-viewer">
          {!picked ? (
            <div className="terminal-reader-empty">{t(files.length ? "terminal.readerFiles.pick" : "terminal.readerFiles.empty")}</div>
          ) : viewer ? (
            <FileViewerPane key={picked.path} viewer={viewer} path={picked.path} projectId={projectId} visible={visible} />
          ) : (
            <div className="terminal-reader-empty">{t("terminal.readerFiles.noViewer")}</div>
          )}
        </div>
      </div>
    </aside>
  );
}
