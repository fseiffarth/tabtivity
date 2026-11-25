import { createContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { sentName, viewerFileUrl, type OutboxFile, type ViewerScope } from "../api";
import { useTapHolds } from "../newTabDefault";
import { shareAs, shareSize, useOutboxShare } from "../outboxShare";
import { openingOutsideStrands } from "../platform";
import { fileKey } from "../terminal/chatFiles";
import { ageLabel } from "../terminal/fileLabels";
import { formatBytes } from "../../../src/lib/formatBytes";
import { openableFile } from "./InboxPreview";
import { CAPTION_CHARS, FileName, FileNameCover } from "./FileName";
import { OptionSheet, type SheetOption } from "./OptionSheet";
import { ShareSizeSheet } from "./ShareSizeSheet";

/** How a file came into the conversation: the agent sent it (`tabtivity-send`
 * from this tab, the project outbox), the phone did (a prompt's inbox
 * reference), or it is a project file the agent changed or named in an answer
 * (`chatFiles`), which opens as the 📁 library does. */
export type SentFrom = "agent" | "phone" | "changed" | "named";

const FROM_LABEL = {
  agent: "mobile.sentIndex.fromAgent",
  phone: "mobile.sentIndex.fromYou",
  changed: "mobile.sentIndex.fromChanged",
  named: "mobile.sentIndex.fromNamed",
} as const;

/** The list's groups, the agent's own work first: what it sent you, what it
 * changed, what its answers mention, then what you sent it. */
const GROUPS = [
  ["agent", "mobile.sentIndex.out", "mobile.sentIndex.outHint"],
  ["changed", "mobile.sentIndex.changed", "mobile.sentIndex.changedHint"],
  ["named", "mobile.sentIndex.named", "mobile.sentIndex.namedHint"],
  ["phone", "mobile.sentIndex.in", "mobile.sentIndex.inHint"],
] as const;

export interface SentFile {
  file: OutboxFile;
  from: SentFrom;
}

/**
 * Every file this conversation carried, newest first: what the agent sent from
 * this tab (`OutboxFile.from_tab` — the gallery's other files belong to other
 * chats; the caller passes only the ones the chat posts, so an earlier
 * conversation's sends stay out) and what the phone sent with the prompts shown (`leaves`, as
 * `inboxLeaves` read them), then the project files it changed and its answers
 * name (`changed`, `named`). A leaf the desktop has not described yet, or no
 * longer holds, is left out — the list names files that can be opened. A file
 * stands once, sent before changed before named.
 */
export function sentFiles(
  outbox: readonly OutboxFile[],
  leaves: readonly string[],
  inbox: ReadonlyMap<string, OutboxFile | null>,
  changed: readonly OutboxFile[] = [],
  named: ReadonlyMap<string, OutboxFile> = new Map(),
): SentFile[] {
  const rows: SentFile[] = outbox.filter((file) => file.from_tab).map((file) => ({ file, from: "agent" }));
  for (const leaf of leaves) {
    const file = inbox.get(leaf);
    if (file) rows.push({ file, from: "phone" });
  }
  const seen = new Set(rows.flatMap(({ file }) => (file.file_row ? [fileKey(file.file_row)] : [])));
  const addRow = (file: OutboxFile, from: SentFrom) => {
    if (!file.file_row || seen.has(fileKey(file.file_row))) return;
    seen.add(fileKey(file.file_row));
    rows.push({ file, from });
  };
  for (const file of changed) addRow(file, "changed");
  for (const file of named.values()) addRow(file, "named");
  return rows.sort((a, b) => b.file.modified - a.file.modified || sentName(a.file).localeCompare(sentName(b.file)));
}

/**
 * The conversation's files, beside the subagent index in the sticky strip over
 * the chat: shut, one chip with the count; open, the strip's full width split
 * into groups (`GROUPS`) — sent by the agent, changed by it, mentioned in its
 * answers (the desktop's Files menu), sent by you — each headed by a line
 * saying what it holds, its tiles rimmed in its colour, a grid of tiles: the
 * file's picture with its name under it — or, for a file with no picture, the
 * name itself as the cover (`FileNameCover`) — then when and how big. A tap opens the file
 * full screen (the chat's own viewer for its side), or saves bytes the phone
 * cannot show; a hold asks what to do with it (`SentFileSheet`). The pictures
 * stay where they were sent in the chat; this is the way to one without
 * scrolling the conversation for it. `more`: Diffs holds changes this list
 * cannot open, a deleted file or a worktree's.
 */
export function SentFilesIndex({ tabId, project, files, more = false, open, onToggle, onOpen, onRemove }: {
  tabId: string;
  /** The project a changed or named file opens in. */
  project?: string;
  files: readonly SentFile[];
  more?: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: (row: SentFile) => void;
  onRemove?: (row: SentFile) => Promise<void>;
}) {
  const t = useT();
  const untested = isUntested("mobile.chat.sentIndex");
  return <nav className={`sent-index${open ? " open" : ""}`} aria-label={t("mobile.sentIndex.region")}>
    <button type="button" className="subagent-index-toggle" aria-expanded={open} aria-controls="mobile-sent-list" onClick={onToggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></svg>
      <span>{t("mobile.sentIndex.toggle", { count: files.length })}{untested && <em> · {t("mobile.focus.untested")}</em>}</span>
      <svg className={open ? "expanded" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <SentFilesGroups id="mobile-sent-list" tabId={tabId} project={project} files={files} more={more} onOpen={onOpen} onRemove={onRemove} />}
  </nav>;
}

/**
 * The conversation's files in their groups (`GROUPS`), each headed by a line
 * saying what it holds, its tiles rimmed in its colour — the open chat strip
 * (`SentFilesIndex`) and a tab card's Files sheet (`TabFilesSheet`) alike. A
 * tile the phone can show opens through `onOpen`; anything else saves. A hold
 * (or a right-click) on any tile opens its menu (`SentFileSheet`): Save,
 * Share, and — for a file the agent or the phone sent, where the caller passes
 * `onRemove` — Delete.
 */
export function SentFilesGroups({ id, tabId, project, files, more = false, onOpen, onRemove }: {
  id?: string;
  tabId: string;
  project?: string;
  files: readonly SentFile[];
  more?: boolean;
  onOpen: (row: SentFile) => void;
  /** Deletes a file the agent sent (its outbox copy) or the phone sent (its
   * inbox file) and drops the row. Left out where deleting is not offered. */
  onRemove?: (row: SentFile) => Promise<void>;
}) {
  const t = useT();
  const press = useTapHolds();
  const menu = useSentFileMenu({ tabId, project, onRemove });
  const now = Math.floor(Date.now() / 1000);
  const scopeOf = (row: SentFile) => sentScope(row, tabId, project);
  const urlOf = (row: SentFile, download = false) => viewerFileUrl(scopeOf(row), row.file, download);
  return <div id={id} className="sent-index-groups">
    {GROUPS.map(([side, heading, hint]) => {
      const rows = files.filter((row) => row.from === side);
      if (rows.length === 0) return null;
      const title = t(heading, { count: rows.length });
      return <section key={side} className={`sent-index-group ${side}`} aria-label={title}>
        <h3 className="sent-index-head">{title}{(side === "changed" || side === "named") && isUntested("mobile.chat.changedFiles") && <em> · {t("mobile.focus.untested")}</em>}</h3>
        <p className="sent-index-hint">{t(hint)}</p>
        <ul className="sent-index-list">
          {rows.map((row) => {
            const { file, from } = row;
            const name = sentName(file);
            // A picture keeps its square, its name under it on up to two
            // lines; anything else has no picture to show, so its name
            // takes the square instead of one glyph and a cut-off line.
            const content = <>
              {file.kind.startsWith("image/")
                ? <>
                  <span className="sent-index-thumb"><img src={urlOf(row)} alt="" loading="lazy" decoding="async" /></span>
                  <FileName name={name} max={CAPTION_CHARS} className="sent-index-name" />
                </>
                : <FileNameCover name={name} className="sent-index-thumb" nameClass="sent-index-name" />}
              <small>{ageLabel(Math.max(0, now - file.modified))} · {formatBytes(file.size)}</small>
            </>;
            const label = `${t("mobile.outbox.open", { name })} · ${t(FROM_LABEL[from])}`;
            // A tap opens (or, for bytes the phone cannot show, the link
            // saves them); a hold asks what to do with the file instead.
            const hold = press(() => { if (openableFile(file)) onOpen(row); }, () => menu.hold(row));
            return <li key={file.name}>
              {openableFile(file)
                ? <button type="button" {...hold} aria-label={label} aria-haspopup="dialog" title={name}>{content}</button>
                : <a href={urlOf(row, true)} download={name} {...hold} aria-label={label} title={name}>{content}</a>}
            </li>;
          })}
        </ul>
      </section>;
    })}
    {more && <small className="sent-index-more">{t("mobile.sentIndex.moreInDiffs")}</small>}
    {menu.sheet}
  </div>;
}

/** What a hold on one of the conversation's file cards calls, provided over
 * the chat (`useSentFileMenu`): the agent's posts (`OutboxPost`), a prompt's
 * cards and an answer's (`InboxAlbum` through `AnswerAlbum`). None outside
 * the phone's chat — the desktop Chat's albums hold nothing. */
export const SentFileHold = createContext<((row: SentFile) => void) | null>(null);

/**
 * The hold menu for a conversation's files: `hold(row)` from a card, `sheet`
 * drawn once beside them. Delete is offered for what the agent sent and what
 * the phone sent, when `onRemove` is given; a project file the agent changed
 * or named is never deleted from the phone.
 */
export function useSentFileMenu({ tabId, project, onRemove }: {
  tabId: string;
  project?: string;
  onRemove?: (row: SentFile) => Promise<void>;
}): { hold: (row: SentFile) => void; sheet: ReactNode } {
  const [held, setHeld] = useState<SentFile | null>(null);
  const deletable = held && (held.from === "agent" || held.from === "phone");
  const sheet = held && createPortal(<SentFileSheet key={`${held.from}:${held.file.name}`} row={held} scope={sentScope(held, tabId, project)}
    onRemove={deletable ? onRemove : undefined} onClose={() => setHeld(null)} />, document.body);
  return { hold: setHeld, sheet };
}

/** Where a row's bytes are read from: the tab's outbox for what the agent
 * sent, its project inbox for what the phone sent, the project's tree (by the
 * file's sealed ref) for what it changed or named. */
function sentScope({ from }: SentFile, tabId: string, project: string | undefined): ViewerScope {
  return from === "agent" ? { tab: tabId } : from === "phone" ? { inbox: tabId } : { files: project ?? "" };
}

/**
 * What can be done with one file of the conversation, asked by a hold on its
 * card (a tap already opens it): Save (a download — not in the installed app
 * on an iPhone or iPad, where Share's sheet holds Save to Files), Share
 * through the phone's share sheet, and Delete (`onRemove`) — for a file the
 * agent sent its outbox copy, for one the phone sent its inbox file; the
 * project's own files are not touched. Delete asks once more in the same
 * sheet. Portaled to the body: the strip and bubbles it is drawn from sit in
 * the chat's sticky stacking contexts.
 */
function SentFileSheet({ row, scope, onRemove, onClose }: {
  row: SentFile;
  scope: ViewerScope;
  onRemove?: (row: SentFile) => Promise<void>;
  onClose: () => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const t = useT();
  const sharing = useOutboxShare(scope);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const { file, from } = row;
  const name = sentName(file);
  const strands = openingOutsideStrands();
  const shareReady = sharing.ready === file.name;
  const remove = async () => {
    if (!onRemove) return;
    setDeleting(true);
    setFailed(false);
    try {
      await onRemove(row);
      onClose();
    } catch {
      // The file is still there: say so and leave the menu up.
      setFailed(true);
      setAsking(false);
    } finally {
      setDeleting(false);
    }
  };
  const save = () => {
    const link = document.createElement("a");
    link.href = viewerFileUrl(scope, file, true);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    onClose();
  };
  const options: SheetOption[] = asking
    ? [
      { key: "confirm", label: t("mobile.outbox.deleteYes"), current: false, danger: true, section: "act" },
      { key: "cancel", label: t("mobile.outbox.deleteNo"), current: false, section: "cancel" },
    ]
    : [
      ...(!strands ? [{ key: "save", label: t("mobile.outbox.save"), current: false }] : []),
      ...(shareAs(file) && shareSize(scope, file.size)
        ? [{
          key: "share",
          label: t(shareReady ? "mobile.outbox.shareReady" : strands ? "mobile.outbox.saveOrShare" : "mobile.outbox.share"),
          current: false,
          pending: sharing.busy === file.name,
        }]
        : []),
      ...(onRemove ? [{ key: "delete", label: t("mobile.outbox.deleteYes"), current: false, danger: true, section: "delete" }] : []),
    ];
  const pick = (key: string) => {
    if (key === "save") save();
    else if (key === "share") void sharing.share(file);
    else if (key === "delete") { setFailed(false); setAsking(true); }
    else if (key === "confirm") void remove();
    else if (key === "cancel") setAsking(false);
  };
  const note = asking
    ? { text: t("mobile.outbox.deleteAsk", { name }) }
    : failed
      ? { text: t("mobile.outbox.deleteError"), error: true }
      : sharing.failed === file.name ? { text: t("mobile.outbox.shareError"), error: true } : undefined;
  const untested = isUntested("mobile.chat.fileHold");
  return <>
    <OptionSheet
      title={name}
      subtitle={<>{t(FROM_LABEL[from])} · {ageLabel(Math.max(0, now - file.modified))} · {formatBytes(file.size)}{untested && <> · {t("mobile.focus.untested")}</>}</>}
      note={note}
      options={options}
      waiting=""
      busy={deleting}
      onPick={pick}
      onClose={asking ? () => setAsking(false) : onClose}
    />
    <ShareSizeSheet files={sharing.asking} onShare={sharing.confirm} onClose={sharing.cancel} />
  </>;
}
