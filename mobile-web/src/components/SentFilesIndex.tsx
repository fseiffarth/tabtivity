import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { inboxFileUrl, outboxFileUrl, sentName, type OutboxFile } from "../api";
import { ageLabel, sizeLabel } from "../terminal/fileLabels";
import { fileBadge, viewableFile } from "./InboxPreview";

/** Who put a file into the conversation: the agent (`tabtivity-send` from this
 * tab, the project outbox) or the phone (a prompt's inbox reference). */
export type SentFrom = "agent" | "phone";

export interface SentFile {
  file: OutboxFile;
  from: SentFrom;
}

/**
 * Every file this conversation carried, newest first: what the agent sent from
 * this tab (`OutboxFile.from_tab` — the gallery's other files belong to other
 * chats) and what the phone sent with the prompts shown (`leaves`, as
 * `inboxLeaves` read them). A leaf the desktop has not described yet, or no
 * longer holds, is left out — the list names files that can be opened.
 */
export function sentFiles(outbox: readonly OutboxFile[], leaves: readonly string[], inbox: ReadonlyMap<string, OutboxFile | null>): SentFile[] {
  const rows: SentFile[] = outbox.filter((file) => file.from_tab).map((file) => ({ file, from: "agent" }));
  for (const leaf of leaves) {
    const file = inbox.get(leaf);
    if (file) rows.push({ file, from: "phone" });
  }
  return rows.sort((a, b) => b.file.modified - a.file.modified || sentName(a.file).localeCompare(sentName(b.file)));
}

/**
 * The conversation's files as a list, beside the subagent index in the sticky
 * strip over the chat: shut, one chip with the count; open, a row per file —
 * its picture or badge, its name, who sent it, when and how big. A tap opens
 * the file full screen (the chat's own viewer for its side), or saves bytes
 * the phone cannot show. The pictures stay where they were sent in the chat;
 * this is the way to one without scrolling the conversation for it.
 */
export function SentFilesIndex({ tabId, files, open, onToggle, onOpen }: {
  tabId: string;
  files: readonly SentFile[];
  open: boolean;
  onToggle: () => void;
  onOpen: (row: SentFile) => void;
}) {
  const t = useT();
  const untested = isUntested("mobile.chat.sentIndex");
  const now = Math.floor(Date.now() / 1000);
  const urlOf = ({ file, from }: SentFile, download = false) => from === "agent"
    ? outboxFileUrl({ tab: tabId }, file.name, download)
    : inboxFileUrl(tabId, file.name, download);
  return <nav className={`sent-index${open ? " open" : ""}`} aria-label={t("mobile.sentIndex.region")}>
    <button type="button" className="subagent-index-toggle" aria-expanded={open} aria-controls="mobile-sent-list" onClick={onToggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></svg>
      <span>{t("mobile.sentIndex.toggle", { count: files.length })}{untested && <em> · {t("mobile.focus.untested")}</em>}</span>
      <svg className={open ? "expanded" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <ul id="mobile-sent-list" className="sent-index-list">
      {files.map((row) => {
        const { file, from } = row;
        const name = sentName(file);
        const content = <>
          {file.kind.startsWith("image/")
            ? <img className="sent-index-thumb" src={urlOf(row)} alt="" loading="lazy" decoding="async" />
            : <span className="sent-index-thumb" aria-hidden="true">{fileBadge(file.kind)}</span>}
          <span className="sent-index-text">
            <strong>{name}</strong>
            <small><b className={from}>{t(from === "agent" ? "mobile.sentIndex.fromAgent" : "mobile.sentIndex.fromYou")}</b> · {ageLabel(Math.max(0, now - file.modified))} · {sizeLabel(file.size)}</small>
          </span>
        </>;
        const label = t("mobile.outbox.open", { name });
        return <li key={`${from}:${file.name}`}>
          {viewableFile(file)
            ? <button type="button" onClick={() => onOpen(row)} aria-label={label} title={name}>{content}</button>
            : <a href={urlOf(row, true)} download={name} aria-label={label} title={name}>{content}</a>}
        </li>;
      })}
    </ul>}
  </nav>;
}
