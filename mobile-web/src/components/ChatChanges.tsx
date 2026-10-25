import { useEffect, useMemo, useRef, useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { parseUnifiedDiff } from "../../../src/lib/viewers/diff";
import { getChanges, type ChatChange, type ChatChanges as ChatChangesRead } from "../api";
import { chatMoment, chatTime } from "../terminal/chatTimes";
import { startVisiblePoll } from "../visiblePoll";

/** How often the open view asks again; an unmoved transcript answers
 * `unchanged`, so no diff crosses the link while nothing happens. */
const POLL_MS = 4000;

const KIND_KEYS: Record<ChatChange["kind"], TranslationKey> = {
  edit: "terminal.changes.kind.edit",
  add: "terminal.changes.kind.add",
  delete: "terminal.changes.kind.delete",
  write: "terminal.changes.kind.write",
};

const REASON_KEYS: Record<string, TranslationKey> = {
  files_off: "mobile.changes.filesOff",
  remote: "mobile.changes.remote",
  no_subagent: "terminal.changes.noSubagent",
  unsupported: "terminal.changes.unsupported",
};

/** A change's key, steady across reads: its time, file and how many earlier
 * changes share both. */
function changeKeys(list: readonly ChatChange[]): string[] {
  const seen = new Map<string, number>();
  return list.map((change) => {
    const base = `${change.at ?? ""}|${change.worktree?.label ?? ""}|${change.path}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}|${count}`;
  });
}

function fileOf(change: ChatChange): string {
  return change.worktree ? `${change.worktree.label}: ${change.path}` : change.path;
}

/** One change: its file, kind and time over its diff, folded until tapped. */
function ChangeCard({ change, open, fresh, onToggle }: { change: ChatChange; open: boolean; fresh: boolean; onToggle: () => void }) {
  const t = useT();
  const moment = chatMoment(change.at);
  // Without its final newline, which would parse as one more (empty) row.
  const lines = useMemo(
    () => (open ? parseUnifiedDiff(change.diff.replace(/\n$/u, "")).flatMap((file) => file.hunks).flatMap((hunk) => hunk.lines) : []),
    [open, change.diff],
  );
  return <li className={fresh ? "chat-change fresh" : "chat-change"}>
    <button className="chat-change-head" aria-expanded={open} onClick={onToggle} title={t(open ? "terminal.changes.collapse" : "terminal.changes.expand")}>
      <span className="chat-change-path">
        {change.worktree && <em>{change.worktree.label}</em>}
        <strong>{change.path}</strong>
      </span>
      <small>
        {t(KIND_KEYS[change.kind] ?? "terminal.changes.kind.edit")}
        {change.added > 0 && <b className="add"> +{change.added}</b>}
        {change.removed > 0 && <b className="del"> −{change.removed}</b>}
        {moment && <> · {chatTime(moment)}</>}
        {fresh && <i> · {t("terminal.changes.new")}</i>}
      </small>
    </button>
    {open && <div className="chat-change-diff">
      {change.moved_to && <small className="chat-change-note">{t("terminal.changes.moved", { path: change.moved_to })}</small>}
      {change.kind === "write" && <small className="chat-change-note">{t("terminal.changes.writeHint")}</small>}
      {lines.map((line, index) => line.type === "hunk" || line.type === "meta" || line.type === "nonewline"
        ? <div className="chat-diff-line note" key={index}><code>{line.text}</code></div>
        : <div className={`chat-diff-line ${line.type}`} key={index}>
          <span aria-hidden="true">{line.type === "add" ? line.newNo : line.oldNo}</span>
          <code>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}{line.text}</code>
        </div>)}
      {change.cut && <small className="chat-change-note">{t("terminal.changes.cut")}</small>}
    </div>}
  </li>;
}

/**
 * The chat screen's Diffs view, the desktop Reader's Diffs tab at phone
 * width: the files the conversation on screen (the session's, or the open
 * subagent's) changed, newest first, one unified diff per change
 * (`GET /api/v1/tabs/{id}/changes`). Read while shown; a change arriving
 * while it is shown stays folded and is marked new until opened.
 */
export function ChatChanges({ tabId, subagent, subagentTitle, visible, onClose }: {
  tabId: string;
  /** The open subagent's handle: its changes are read instead. */
  subagent?: string;
  subagentTitle?: string;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const readKey = `${tabId}|${subagent ?? ""}`;
  const [read, setRead] = useState<{ key: string; changes: ChatChangesRead } | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState("");
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  /** The keys of the first read: whatever comes later is new. */
  const firstKeys = useRef<{ key: string; keys: ReadonlySet<string> } | null>(null);
  const versionRef = useRef<{ key: string; version?: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    return startVisiblePoll((signal) => {
      const version = versionRef.current?.key === readKey ? versionRef.current.version : undefined;
      return getChanges(tabId, version, subagent, signal).then((answer) => {
        if (signal.aborted) return;
        setFailed(false);
        if (answer.unchanged) return;
        versionRef.current = { key: readKey, version: answer.version };
        setRead({ key: readKey, changes: answer });
      }, (reason: unknown) => {
        if (signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setFailed(true);
      });
    }, POLL_MS).stop;
  }, [visible, tabId, subagent, readKey]);

  const changes = read?.key === readKey ? read.changes : null;
  const list = useMemo(() => changes?.changes ?? [], [changes]);
  const keys = useMemo(() => changeKeys(list), [list]);
  if (changes?.available && firstKeys.current?.key !== readKey) firstKeys.current = { key: readKey, keys: new Set(keys) };
  const files = useMemo(() => [...new Set(list.map(fileOf))].sort(), [list]);
  const filter = files.includes(picked) ? picked : "";
  /** Newest first, narrowed to the picked file. */
  const cards = useMemo(
    () => list.map((change, index) => ({ change, key: keys[index] })).reverse().filter(({ change }) => !filter || fileOf(change) === filter),
    [list, keys, filter],
  );
  const known = firstKeys.current?.key === readKey ? firstKeys.current.keys : null;
  /** The newest change of the first read starts open; a later one folded. */
  const startsOpen = (key: string, index: number) => index === 0 && !!known?.has(key);
  const toggle = (key: string) => setToggled((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const untested = isUntested("mobile.focus.diffs");

  const body = !changes
    ? <div className="readable-empty"><strong>{t(failed ? "terminal.changes.unreadable" : "terminal.changes.loading")}</strong></div>
    : !changes.available
    ? <div className="readable-empty"><strong>{t(REASON_KEYS[changes.reason ?? ""] ?? "terminal.changes.unreadable")}</strong></div>
    : list.length === 0
    ? <div className="readable-empty"><strong>{t("terminal.changes.empty")}</strong>{!!changes.outside && <span>{t("mobile.changes.outside", { count: changes.outside })}</span>}</div>
    : <>
      <ol className="chat-changes-list">
        {cards.map(({ change, key }, index) => {
          const open = startsOpen(key, index) !== toggled.has(key);
          return <ChangeCard key={key} change={change} open={open}
            fresh={!!known && !known.has(key) && !toggled.has(key)} onToggle={() => toggle(key)} />;
        })}
      </ol>
      {changes.truncated && <small className="chat-change-note">{t("terminal.changes.truncated")}</small>}
      {!!changes.outside && <small className="chat-change-note">{t("mobile.changes.outside", { count: changes.outside })}</small>}
    </>;

  return <section className="readable-output chat-changes" aria-label={t("terminal.changes.title")} data-testid="chat-changes">
    <div className="chat-index chat-changes-head">
      <span className="chat-changes-title">
        <strong>{t("terminal.changes.title")}{untested && <em> · {t("mobile.focus.untested")}</em>}</strong>
        {list.length > 0 && <small>{t("terminal.changes.summary", { files: files.length, edits: list.length })}</small>}
      </span>
      {files.length > 1 && <select value={filter} onChange={(event) => setPicked(event.target.value)} aria-label={t("terminal.changes.files")}>
        <option value="">{t("terminal.changes.allFiles")}</option>
        {files.map((file) => <option key={file} value={file}>{file}</option>)}
      </select>}
      <button className="chat-changes-close" onClick={onClose} aria-label={t("terminal.changes.close")} title={t("terminal.changes.close")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
    {subagent && subagentTitle && <small className="chat-changes-scope">{t("terminal.changes.subagent", { name: subagentTitle })}</small>}
    {body}
  </section>;
}
