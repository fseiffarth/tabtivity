import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { dirname } from "../../lib/paths";
import { formatBytes } from "../../lib/formatBytes";
import { openErrorText } from "../../lib/openExternal";
import { useWindowsStore } from "../../stores/windows";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../../lib/viewers/fileUtils";
import { FileViewerPane } from "../embed/FileViewerPane";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { UntestedTag } from "../common/UntestedTag";
import { ArrowUpRightIcon, CloseIcon, LinkIcon } from "../common/icons/Icon";
import type { ChatLink } from "../../../mobile-web/src/terminal/chatLinks";
import { chatMoment, chatTime } from "../../../mobile-web/src/terminal/chatTimes";

/** A file the conversation on screen names: a resolved path link, a picture
 * or PDF an answer shows, a file the phone sent into the inbox. */
export interface ReaderFile {
  entry: FileEntry;
  /** Its path as the list shows it (relative to the tab's folder). */
  label: string;
}

const NO_LINKS: readonly ChatLink[] = [];
/** Characters of a link's path and query a row shows before its middle goes. */
const LINK_REST_MAX = 56;

/** `text` cut to `max` characters by dropping its middle, so a path keeps its
 *  start (what it is) and its end (which one). */
function middle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * The Reader's Files tab, beside Chat and Diffs: the files the conversation
 * names (`TerminalReaderView`'s list, newest first) and the picked one in its
 * in-app viewer — the same `FileViewerPane` a viewer tab hosts — so a click in
 * the chat shows a file here instead of opening a tab. ↗ (Ctrl+click: a new
 * subwindow) still opens it as a tab. The Diffs tab's classes, one layout.
 *
 * Under the files, the web links the conversation names (`links`: exactly the
 * ones the Chat makes clickable). A link is open-only: a click hands its
 * address to `onOpenLink`, the Chat's own ask-then-open path. It is never
 * fetched, previewed or drawn as an `<a href>`, so nothing leaves the machine
 * before the user confirms.
 */
export function TerminalReaderFiles({ tabKey, files, links = NO_LINKS, picked, projectId, disabled, visible, scopeNote, use24h, onPick, onOpenTab, onOpenLink, onClose }: {
  /** The agent tab hosting this Reader. Each picked file keeps its scroll/zoom
   *  under `<tab>#<path>` (the tab's `texPanes`, the TeX workspace's sub-pane
   *  slot), so leaving to Chat or another tab and coming back reopens the
   *  PDF where the reader left it instead of at page 1. */
  tabKey?: string;
  files: readonly ReaderFile[];
  /** The links the conversation names; drawn only with `onOpenLink`. */
  links?: readonly ChatLink[];
  /** The file in the viewer; it stays there when another chat's list lacks it. */
  picked: FileEntry | null;
  projectId: string | null;
  disabled?: ReadonlySet<InternalViewer>;
  visible: boolean;
  /** Whose files these are, when not the session's own chat (a subagent's, an earlier chat's). */
  scopeNote?: string;
  use24h?: boolean;
  onPick: (entry: FileEntry) => void;
  onOpenTab: (entry: FileEntry, newSubwindow: boolean) => void;
  /** Open a link's address: the Chat's confirmation first, then the browser. */
  onOpenLink?: (url: string) => void;
  /** The pane's id, for keyboard steering's Inside target (`readerSteering`). */
  steerId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const viewer = picked ? internalViewerFor(picked, disabled) : null;
  const linkRows = onOpenLink ? links : NO_LINKS;
  const headed = files.length > 0 && linkRows.length > 0;
  return (
    <aside className={`terminal-changes terminal-changes-tab terminal-files ${SIGN_IN_CARD_CLASS}`} aria-label={t("terminal.readerFiles.title")} tabIndex={-1}>
      <header className="terminal-changes-head">
        <strong>{t("terminal.readerFiles.title")}</strong>
        <UntestedTag id="terminal.reader.files" />
        {picked && <small className="terminal-changes-path" title={picked.path}>{picked.name}</small>}
        {picked && viewer && (
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
        {(files.length > 0 || linkRows.length > 0) && (
          <div className="terminal-changes-files">
            {files.length > 0 && <>
              {headed && <div className="terminal-files-heading">{t("terminal.readerFiles.filesHeading")}</div>}
              <div className="terminal-files-group" role="listbox" aria-label={t("terminal.readerFiles.list")}>
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
            </>}
            {linkRows.length > 0 && onOpenLink && <>
              <div className="terminal-files-heading">
                {headed ? t("terminal.readerFiles.linksHeading") : null}
                <UntestedTag id="terminal.reader.links" />
              </div>
              <div className="terminal-files-group" role="listbox" aria-label={t("terminal.readerFiles.linksList")}>
                {linkRows.map((link) => {
                  const moment = chatMoment(link.at);
                  const who = t(link.from === "you" ? "terminal.readerFiles.linkFromYou" : "terminal.readerFiles.linkFromAgent");
                  return (
                    <button type="button" role="option" key={link.url} aria-selected={false}
                      className="terminal-files-link" title={`${link.url}\n${t("terminal.readerFiles.linkOpen")}`}
                      onClick={() => onOpenLink(link.url)}>
                      <span className="terminal-files-link-main">
                        <LinkIcon />
                        <strong>{link.host}</strong>
                        {link.rest && <span className="terminal-files-link-rest">{middle(link.rest, LINK_REST_MAX)}</span>}
                      </span>
                      <small className="terminal-files-link-meta">
                        {link.label && <span className="terminal-files-link-label">{link.label}</span>}
                        <span>{moment ? `${who} · ${chatTime(moment, use24h)}` : who}</span>
                      </small>
                    </button>
                  );
                })}
              </div>
            </>}
          </div>
        )}
        <div className="terminal-files-viewer">
          {!picked ? (
            <div className="terminal-reader-empty">{t(files.length ? "terminal.readerFiles.pick" : linkRows.length ? "terminal.readerFiles.onlyLinks" : "terminal.readerFiles.empty")}</div>
          ) : viewer ? (
            <FileViewerPane key={picked.path} viewer={viewer} path={picked.path} projectId={projectId} visible={visible}
              tabKey={tabKey ? `${tabKey}#${picked.path}` : undefined} />
          ) : (
            <ViewlessFile key={picked.path} entry={picked} projectId={projectId} />
          )}
        </div>
      </div>
    </aside>
  );
}

/** A file no in-app viewer shows (an STL the agent was asked to send): its
 *  name, folder and size, and the two ways out of the app the user picks —
 *  its own app (asked first, launchers refused: `openFile`) or the folder in
 *  the OS file manager. Never opened on the chat click alone. */
function ViewlessFile({ entry, projectId }: { entry: FileEntry; projectId: string | null }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const folder = dirname(entry.path);
  const fail = (path: string) => (err: unknown) => setError(openErrorText(err, path));
  return (
    <div className="terminal-reader-empty terminal-files-viewless">
      <UntestedTag id="terminal.reader.viewlessFiles" />
      <strong title={entry.path}>{entry.name}</strong>
      <small title={folder}>{folder} · {formatBytes(entry.size)}</small>
      <p>{t("terminal.readerFiles.noViewer")}</p>
      <div className="terminal-files-viewless-actions">
        <button type="button" className="terminal-reader-earlier"
          onClick={() => { setError(null); void useWindowsStore.getState().openFile(entry.path, undefined, projectId, "reader_files").catch(fail(entry.path)); }}>
          {t("terminal.readerFiles.openOutside")}
        </button>
        <button type="button" className="terminal-reader-earlier"
          onClick={() => { setError(null); void invoke("open_in_file_manager", { path: folder }).catch(fail(folder)); }}>
          {t("terminal.readerFiles.showFolder")}
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
