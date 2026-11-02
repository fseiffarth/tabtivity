import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { inboxFileUrl, outboxFileUrl, sentName, viewerFileUrl, type OutboxFile } from "../api";
import { fileKey } from "../terminal/chatFiles";
import { ageLabel } from "../terminal/fileLabels";
import { formatBytes } from "../../../src/lib/formatBytes";
import { fileBadge, viewableFile } from "./InboxPreview";

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

export interface SentFile {
  file: OutboxFile;
  from: SentFrom;
}

/**
 * Every file this conversation carried, newest first: what the agent sent from
 * this tab (`OutboxFile.from_tab` — the gallery's other files belong to other
 * chats) and what the phone sent with the prompts shown (`leaves`, as
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
 * into In (what you sent into the tab), Out (what the agent sent out of it),
 * Changed and Named (the desktop's Files menu), each a grid of tiles: the
 * file's picture or badge, its name, when and how big. A tap opens the file
 * full screen (the chat's own viewer for its side), or saves bytes the phone
 * cannot show. The pictures stay where they were sent in the chat; this is the
 * way to one without scrolling the conversation for it. `more`: Diffs holds
 * changes this list cannot open, a deleted file or a worktree's.
 */
export function SentFilesIndex({ tabId, project, files, more = false, open, onToggle, onOpen }: {
  tabId: string;
  /** The project a changed or named file opens in. */
  project?: string;
  files: readonly SentFile[];
  more?: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: (row: SentFile) => void;
}) {
  const t = useT();
  const untested = isUntested("mobile.chat.sentIndex");
  const now = Math.floor(Date.now() / 1000);
  const urlOf = ({ file, from }: SentFile, download = false) => from === "agent"
    ? outboxFileUrl({ tab: tabId }, file, download)
    : from === "phone"
      ? inboxFileUrl(tabId, file.name, download)
      : viewerFileUrl({ files: project ?? "" }, file, download);
  return <nav className={`sent-index${open ? " open" : ""}`} aria-label={t("mobile.sentIndex.region")}>
    <button type="button" className="subagent-index-toggle" aria-expanded={open} aria-controls="mobile-sent-list" onClick={onToggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></svg>
      <span>{t("mobile.sentIndex.toggle", { count: files.length })}{untested && <em> · {t("mobile.focus.untested")}</em>}</span>
      <svg className={open ? "expanded" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div id="mobile-sent-list" className="sent-index-groups">
      {([
        ["phone", "mobile.sentIndex.in"], ["agent", "mobile.sentIndex.out"],
        ["changed", "mobile.sentIndex.changed"], ["named", "mobile.sentIndex.named"],
      ] as const).map(([side, heading]) => {
        const rows = files.filter((row) => row.from === side);
        if (rows.length === 0) return null;
        const title = t(heading, { count: rows.length });
        return <section key={side} aria-label={title}>
          <h3 className={`sent-index-head ${side}`}>{title}{(side === "changed" || side === "named") && isUntested("mobile.chat.changedFiles") && <em> · {t("mobile.focus.untested")}</em>}</h3>
          <ul className="sent-index-list">
            {rows.map((row) => {
              const { file, from } = row;
              const name = sentName(file);
              const content = <>
                <span className="sent-index-thumb">
                  {file.kind.startsWith("image/")
                    ? <img src={urlOf(row)} alt="" loading="lazy" decoding="async" />
                    : <span aria-hidden="true">{fileBadge(file.kind)}</span>}
                </span>
                <span className="sent-index-name">{name}</span>
                <small>{ageLabel(Math.max(0, now - file.modified))} · {formatBytes(file.size)}</small>
              </>;
              const label = `${t("mobile.outbox.open", { name })} · ${t(FROM_LABEL[from])}`;
              return <li key={file.name}>
                {viewableFile(file)
                  ? <button type="button" onClick={() => onOpen(row)} aria-label={label} title={name}>{content}</button>
                  : <a href={urlOf(row, true)} download={name} aria-label={label} title={name}>{content}</a>}
              </li>;
            })}
          </ul>
        </section>;
      })}
      {more && <small className="sent-index-more">{t("mobile.sentIndex.moreInDiffs")}</small>}
    </div>}
  </nav>;
}
