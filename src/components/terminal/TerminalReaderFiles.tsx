import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { basename, dirname } from "../../lib/paths";
import { formatBytes } from "../../lib/formatBytes";
import { openErrorText } from "../../lib/openExternal";
import { useWindowsStore } from "../../stores/windows";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../../lib/viewers/fileUtils";
import { FileViewerPane } from "../embed/FileViewerPane";
import { TexPdfHostContext, type TexPdfHost } from "../embed/fileViewer/texPdfHost";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { UntestedTag } from "../common/UntestedTag";
import { registerReaderInside, useSteeringInside } from "../../lib/agents/readerSteering";
import { largestScroller, scrollBox } from "../../lib/shortcuts/documentScroll";
import { decide, effectiveCursor, rowsOf } from "../../lib/terminal/readerFilesSteer";
import { ArrowUpRightIcon, CloseIcon, LinkIcon } from "../common/icons/Icon";
import { copyText } from "../../lib/terminal/copyText";
import type { ChatLink } from "../../../mobile-web/src/terminal/chatLinks";
import type { RunningShell } from "../../../mobile-web/src/api";
import { chatMoment, chatTime } from "../../../mobile-web/src/terminal/chatTimes";

/** How a file came into the conversation, the phone's Files groups
 * (`SentFilesIndex`) without its Changed one (that is the Diffs tab): the
 * agent sent it (a project-outbox file — a desktop send only names the
 * project file, so it lands in `named`), an answer names it, or a prompt of
 * yours carried it (an inbox attachment or a path you named). */
export type ReaderFileFrom = "agent" | "named" | "you";

/** A file the conversation on screen names: a resolved path link, a picture
 * or PDF an answer shows, a file the phone sent into the inbox. */
export interface ReaderFile {
  entry: FileEntry;
  /** Its path as the list shows it (relative to the tab's folder). */
  label: string;
  from: ReaderFileFrom;
}

/** The list's groups in drawing order, the agent's own work first (the
 * phone's order): heading and hint keys are the phone's. */
export const READER_FILE_GROUPS = [
  ["agent", "mobile.sentIndex.out", "mobile.sentIndex.outHint"],
  ["named", "mobile.sentIndex.named", "mobile.sentIndex.namedHint"],
  ["you", "mobile.sentIndex.in", "mobile.sentIndex.inHint"],
] as const;

/** `files` in group order, each group keeping its own order (newest first):
 *  the order the view draws and steering walks. */
export function groupReaderFiles(files: readonly ReaderFile[]): ReaderFile[] {
  return READER_FILE_GROUPS.flatMap(([from]) => files.filter((file) => file.from === from));
}

/** The list's entry for `path`, or one made from the path alone (a PDF a
 *  build just wrote, a source the conversation never named). */
function entryFor(files: readonly ReaderFile[], path: string): FileEntry {
  const known = files.find((file) => file.entry.path === path)?.entry;
  if (known) return known;
  const name = basename(path);
  return { name, path, is_dir: false, size: 0, extension: /\.[^./\\]+$/u.exec(name)?.[0].toLowerCase() ?? null, mime: null };
}

const NO_LINKS: readonly ChatLink[] = [];
const NO_SHELLS: readonly RunningShell[] = [];

/** A shell command as a row of the list: `key` is its steering / pick key. */
export interface ShellRow {
  shell: RunningShell;
  key: string;
}

/** `shells` (newest first) as rows. A key is the call's stamp and its place
 *  among the calls of that stamp counted from the oldest, so it stays put as
 *  newer commands arrive above it. It never collides with a path or a URL. */
export function shellRowsOf(shells: readonly RunningShell[]): ShellRow[] {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  for (let index = shells.length - 1; index >= 0; index -= 1) {
    const stamp = `shell:${shells[index].at ?? ""}`;
    const nth = seen.get(stamp) ?? 0;
    seen.set(stamp, nth + 1);
    keys[index] = `${stamp}#${nth}`;
  }
  return shells.map((shell, index) => ({ shell, key: keys[index] }));
}
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
 *
 * Under the links, every shell command the conversation ran (`shells`, newest
 * first: the transcript's `shellsRun`), running or done. A click shows the
 * whole command in the viewer half, with the agent's description and a Copy
 * button; nothing runs it.
 *
 * Under keyboard steering (`steerId`, Inside this view) the files, the links
 * and the commands are one walkable list with a cursor of its own
 * (`readerFilesSteer`): `o` opens the row, `v` shows the file or command here,
 * ←/→ scroll the viewer. Moving the cursor opens nothing.
 */
export function TerminalReaderFiles({ tabKey, files, links = NO_LINKS, shells = NO_SHELLS, picked, projectId, disabled, visible, scopeNote, use24h, onPick, onOpenTab, onOpenLink, steerId, onClose }: {
  /** The agent tab hosting this Reader. Each picked file keeps its scroll/zoom
   *  under `<tab>#<path>` (the tab's `texPanes`, the TeX workspace's sub-pane
   *  slot), so leaving to Chat or another tab and coming back reopens the
   *  PDF where the reader left it instead of at page 1. */
  tabKey?: string;
  files: readonly ReaderFile[];
  /** The links the conversation names; drawn only with `onOpenLink`. */
  links?: readonly ChatLink[];
  /** The shell commands the conversation ran, newest first. */
  shells?: readonly RunningShell[];
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
  const linkRows = onOpenLink ? links : NO_LINKS;
  const shellRows = useMemo(() => shellRowsOf(shells), [shells]);
  // The command shown in the viewer half, by row key; a file picked after it
  // takes the half back. One whose row is gone shows the file again.
  const [shellShown, setShellShown] = useState<string | null>(null);
  const shownShell = shellShown === null ? null : shellRows.find((row) => row.key === shellShown)?.shell ?? null;
  const file = shownShell ? null : picked;
  const viewer = file ? internalViewerFor(file, disabled) : null;
  const pick = (entry: FileEntry) => {
    setShellShown(null);
    onPick(entry);
  };
  const steering = useSteeringInside(steerId);
  // Grouped here so the drawn order and the steering walk are one order.
  const grouped = groupReaderFiles(files);
  const rows = rowsOf(grouped, linkRows, shellRows);
  // The cursor is a key (path / URL), so rows arriving above it do not move it;
  // one whose row vanished snaps back to the start (the shown file's row).
  const [cursorSet, setCursorSet] = useState<string | null>(null);
  const cursor = effectiveCursor(rows, cursorSet, picked?.path);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef({ files, rows, cursor, disabled, onPick: pick, onOpenTab, onOpenLink });
  liveRef.current = { files, rows, cursor, disabled, onPick: pick, onOpenTab, onOpenLink };
  // TeX ⇄ PDF in this one pane (`texPdfHost`): a build, a forward search or
  // Open PDF shows the PDF here, a reverse click or an error row the source at
  // its line. A file no viewer here shows answers false, so it opens as a tab.
  const texPdfHost = useMemo<TexPdfHost>(() => {
    const show = (path: string) => {
      const now = liveRef.current;
      const entry = entryFor(now.files, path);
      if (!internalViewerFor(entry, now.disabled)) return false;
      now.onPick(entry);
      return true;
    };
    return {
      showPdf: show,
      showSource(input, line, column, phrase) {
        if (!show(input)) return false;
        // Waits in the store for the editor this pick mounts (or the one shown).
        useEditorJumpStore.getState().applyJump(input, line, column, phrase);
        return true;
      },
    };
  }, []);

  useEffect(() => {
    if (!steerId || !visible) return;
    return registerReaderInside(steerId, {
      view: "files",
      key(action, e) {
        if (action === "work" || action === "agentPrompt") return "pass";
        if (action !== "up" && action !== "down" && action !== "left" && action !== "right" && action !== "viewOpen" && action !== "viewOpenAlt") {
          return "handled";
        }
        const now = liveRef.current;
        const result = decide(now.rows, now.cursor, action, { shift: e.shiftKey, repeat: e.repeat });
        if (result.cursor !== undefined) {
          // Written through so a second press before the re-render steps on.
          liveRef.current = { ...now, cursor: result.cursor };
          setCursorSet(result.cursor);
        }
        const path = result.row?.key;
        const target = now.files.find((f) => f.entry.path === path)?.entry;
        switch (result.effect) {
          case "out":
            return "leave";
          case "scroll": {
            const box = viewerRef.current ? largestScroller(viewerRef.current) : null;
            if (box && result.pages) scrollBox(box, result.pages);
            break;
          }
          case "show":
            if (target) now.onPick(target);
            break;
          case "showShell":
            if (result.row) setShellShown(result.row.key);
            break;
          case "openTab":
          case "openTabNew":
            // A file with no in-app viewer has no ↗ button either.
            if (target && internalViewerFor(target, now.disabled)) now.onOpenTab(target, result.effect === "openTabNew");
            break;
          case "openLink":
            if (result.row) now.onOpenLink?.(result.row.key);
            break;
        }
        return "handled";
      },
    });
  }, [steerId, visible]);

  // Keep the cursor's row on screen (nothing else happens when it moves).
  useEffect(() => {
    if (!steering || cursor === null) return;
    const row = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-steer-row]") ?? [])
      .find((el) => el.dataset.steerRow === cursor);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [steering, cursor]);
  return (
    <aside className={`terminal-changes terminal-changes-tab terminal-files ${SIGN_IN_CARD_CLASS}`} aria-label={t("terminal.readerFiles.title")} tabIndex={-1}>
      <header className="terminal-changes-head">
        <strong>{t("terminal.readerFiles.title")}</strong>
        <UntestedTag id="terminal.reader.files" />
        {(viewer === "tex" || viewer === "pdf") &&<UntestedTag id="terminal.reader.texPdf" />}
        {file && <small className="terminal-changes-path" title={file.path}>{file.name}</small>}
        {file && viewer && (
          <button type="button" className="terminal-changes-close terminal-files-open"
            onClick={(event) => onOpenTab(file, event.ctrlKey || event.metaKey)}
            title={t("terminal.readerFiles.openTab")} aria-label={t("terminal.readerFiles.openTab")}>
            <ArrowUpRightIcon />
          </button>
        )}
        <button type="button" className="terminal-changes-close" onClick={onClose} title={t("terminal.readerFiles.close")} aria-label={t("terminal.readerFiles.close")}>
          <CloseIcon />
        </button>
      </header>
      {scopeNote && <small className="terminal-changes-scope" title={scopeNote}>{scopeNote}</small>}
      <div className="terminal-changes-body" ref={bodyRef}>
        {(files.length > 0 || linkRows.length > 0 || shellRows.length > 0) && (
          <div className="terminal-changes-files">
            {READER_FILE_GROUPS.map(([from, heading, hint]) => {
              const group = grouped.filter((file) => file.from === from);
              if (group.length === 0) return null;
              const title = t(heading, { count: group.length });
              return <Fragment key={from}>
              <div className="terminal-files-heading" title={t(hint)}>
                {title}
                {from === grouped[0]?.from && <UntestedTag id="terminal.reader.fileGroups" />}
              </div>
              <div className="terminal-files-group" role="listbox" aria-label={title}>
                {group.map((row) => {
                  const active = file?.path === row.entry.path;
                  const here = steering && cursor === row.entry.path;
                  return (
                    <button type="button" role="option" key={row.entry.path} aria-selected={active}
                      className={[active && "active", here && "steer-cursor"].filter(Boolean).join(" ") || undefined}
                      aria-current={here || undefined} data-steer-row={row.entry.path} title={row.entry.path}
                      onClick={(event) => (event.ctrlKey || event.metaKey ? onOpenTab(row.entry, true) : pick(row.entry))}>
                      <span className="terminal-changes-path"><strong>{row.label}</strong></span>
                    </button>
                  );
                })}
              </div>
              </Fragment>;
            })}
            {linkRows.length > 0 && onOpenLink && <>
              <div className="terminal-files-heading">
                {t("terminal.readerFiles.linksHeading")}
                <UntestedTag id="terminal.reader.links" />
              </div>
              <div className="terminal-files-group" role="listbox" aria-label={t("terminal.readerFiles.linksList")}>
                {linkRows.map((link) => {
                  const moment = chatMoment(link.at);
                  const who = t(link.from === "you" ? "terminal.readerFiles.linkFromYou" : "terminal.readerFiles.linkFromAgent");
                  const here = steering && cursor === link.url;
                  return (
                    <button type="button" role="option" key={link.url} aria-selected={false}
                      className={here ? "terminal-files-link steer-cursor" : "terminal-files-link"}
                      aria-current={here || undefined} data-steer-row={link.url} title={`${link.url}\n${t("terminal.readerFiles.linkOpen")}`}
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
            {shellRows.length > 0 && <>
              <div className="terminal-files-heading">
                {t("terminal.readerFiles.shellsHeading", { count: shellRows.length })}
                <UntestedTag id="terminal.reader.shellsRun" />
              </div>
              <div className="terminal-files-group" role="listbox" aria-label={t("terminal.readerFiles.shellsList")}>
                {shellRows.map(({ shell, key }) => {
                  const moment = chatMoment(shell.at);
                  const active = shellShown === key && !!shownShell;
                  const here = steering && cursor === key;
                  return (
                    <button type="button" role="option" key={key} aria-selected={active}
                      className={["terminal-files-link", active && "active", here && "steer-cursor"].filter(Boolean).join(" ")}
                      aria-current={here || undefined} data-steer-row={key} title={t("terminal.readerFiles.shellShow")}
                      onClick={() => setShellShown(key)}>
                      <span className="terminal-files-link-main">
                        <span className="terminal-reader-shell-mark" aria-hidden="true">$</span>
                        <span className="terminal-files-shell-line">{shell.command.split("\n", 1)[0]}</span>
                      </span>
                      {(shell.description || moment || shell.background) && (
                        <small className="terminal-files-link-meta">
                          {shell.description && <span className="terminal-files-link-label">{shell.description}</span>}
                          {shell.background && <span>{t("terminal.readerFiles.shellBackground")}</span>}
                          {moment && <span>{chatTime(moment, use24h)}</span>}
                        </small>
                      )}
                    </button>
                  );
                })}
              </div>
            </>}
          </div>
        )}
        <div className="terminal-files-viewer" ref={viewerRef}>
          {shownShell ? (
            <ShellCommand shell={shownShell} use24h={use24h} />
          ) : !file ? (
            <div className="terminal-reader-empty">{t(files.length ? "terminal.readerFiles.pick"
              : linkRows.length ? "terminal.readerFiles.onlyLinks"
                : shellRows.length ? "terminal.readerFiles.onlyShells" : "terminal.readerFiles.empty")}</div>
          ) : viewer ? (
            <TexPdfHostContext.Provider value={texPdfHost}>
              <FileViewerPane key={file.path} viewer={viewer} path={file.path} projectId={projectId} visible={visible}
                tabKey={tabKey ? `${tabKey}#${file.path}` : undefined} />
            </TexPdfHostContext.Provider>
          ) : (
            <ViewlessFile key={file.path} entry={file} projectId={projectId} />
          )}
        </div>
      </div>
    </aside>
  );
}

/** A shell command picked in the list, whole: the agent's few words on it,
 *  when it ran, and the command line itself with a Copy button. Shown only —
 *  nothing here runs it. */
function ShellCommand({ shell, use24h }: { shell: RunningShell; use24h?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const moment = chatMoment(shell.at);
  return (
    <div className="terminal-files-shell">
      <div className="terminal-files-shell-head">
        <span className="terminal-reader-shell-mark" aria-hidden="true">$</span>
        <strong>{shell.description || t("terminal.readerFiles.shellTitle")}</strong>
        {moment && <small>{chatTime(moment, use24h)}</small>}
        {shell.background && <small>{t("terminal.readerFiles.shellBackground")}</small>}
        <button type="button" className="terminal-reader-earlier"
          onClick={() => { void copyText(shell.command).then(() => setCopied("done"), () => setCopied("failed")); }}>
          {t(copied === "done" ? "terminal.readerFiles.shellCopied" : "terminal.readerFiles.shellCopy")}
        </button>
      </div>
      <pre className="terminal-reader-question-context terminal-reader-shell-command">{shell.command}{shell.cut && "…"}</pre>
      {shell.cut && <small>{t("terminal.readerFiles.shellCut")}</small>}
      {copied === "failed" && <small role="alert">{t("terminal.readerFiles.shellCopyFailed")}</small>}
    </div>
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
