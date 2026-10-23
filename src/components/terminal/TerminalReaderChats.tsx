import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { modifierLabel } from "../../lib/shortcuts/shortcuts";
import { useUse24h } from "../../lib/timeFormat";
import { readerAgent } from "../../lib/agents/agentReader";
import {
  listChats,
  resumeAgentChat,
  useReaderChatsStore,
  type ResumeChatResult,
  type StoredChat,
} from "../../lib/agents/agentChats";
import { useActivityStore } from "../../stores/activity";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useProjectsStore } from "../../stores/projects";
import type { TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The prompt strip's Resume button and its drop-down (`lib/agents/agentChats`):
 * the earlier conversations of the folder the tab runs in, newest first, each
 * by its first prompt with its last one under it. A click (or Enter) opens one
 * in the chat view, read-only — the Reader is switched on for it — and the
 * Reader's bar steps through the rest; Resume (Ctrl+Enter) takes the tab onto
 * it. The filter narrows the rows read so far; older chats come a page at a
 * time. Opens over the terminal's top as the prompt trail's drop-down does.
 */

/** When a chat was last written, on the app's 12/24-hour clock: the time
 * today, "Yesterday" and the time, else the day (and the year, when not this
 * one). */
export function chatWhen(at: number, use24h: boolean, yesterday: string, now = new Date()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: !use24h });
  if (when.toDateString() === now.toDateString()) return time;
  const before = new Date(now);
  before.setDate(now.getDate() - 1);
  if (when.toDateString() === before.toDateString()) return `${yesterday} ${time}`;
  return when.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

const RESUME_ERROR: Record<Exclude<ResumeChatResult, "resumed">, TranslationKey> = {
  not_found: "terminal.chats.resumeGone",
  tab_not_ready: "terminal.chats.resumeNotReady",
  remote_tab: "terminal.chats.resumeRemote",
};

/** Resume `chat` in `tab`, saying in the window's toast why it did not go. */
export async function resumeChatWithToast(
  scope: string,
  tab: TabEntry,
  cwd: string | undefined,
  chat: StoredChat,
  t: ReturnType<typeof useT>,
): Promise<boolean> {
  const result = await resumeAgentChat(scope, tab, cwd, chat.id);
  if (result !== "resumed") useProjectsStore.setState({ switchToast: t(RESUME_ERROR[result]) });
  return result === "resumed";
}

export function TerminalReaderChats({ ptyId, scope, tab, cwd, onReturnFocus }: {
  ptyId: string;
  scope: string;
  tab: TabEntry;
  cwd: string | undefined;
  /** Hand the keyboard back to the terminal (the drop-down closed). */
  onReturnFocus: () => void;
}) {
  const t = useT();
  const use24h = useUse24h();
  const browsed = useReaderChatsStore((state) => state.byPty[ptyId]);
  const busy = useActivityStore((state) => !!state.busyByTab[ptyId]);
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<StoredChat[] | null>(null);
  const [next, setNext] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [resuming, setResuming] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /** The read a newer one replaced is dropped (reopened, or the tab moved). */
  const readSeq = useRef(0);

  const load = (offset: number) => {
    const seq = ++readSeq.current;
    setLoading(true);
    void listChats(scope, tabRef.current, cwd, offset).then((page) => {
      if (seq !== readSeq.current) return;
      setLoading(false);
      setNext(page.next);
      setChats((shown) => (offset === 0 ? page.chats : [...(shown ?? []), ...page.chats]));
    });
  };

  // Each opening reads the folder afresh: a chat may have been written since.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setSelected(0);
    load(0);
    filterRef.current?.focus({ preventScroll: true });
    // `load` reads through refs; the opening is what reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, tab.sessionId, cwd]);

  // A press outside the button and its drop-down closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (!chats || words.length === 0) return chats ?? [];
    return chats.filter((chat) => {
      const text = `${chat.title}\n${chat.last ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [chats, filter]);
  const at = Math.min(selected, Math.max(0, shown.length - 1));

  // No scrollIntoView: it may scroll `.center-pane` itself (see the strip).
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>("[aria-selected='true']");
    if (!open || !list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [open, at, shown]);

  const close = () => {
    setOpen(false);
    onReturnFocus();
  };
  /** Show `chat` in the chat view (the tab's own: back to it). */
  const browse = (chat: StoredChat) => {
    useReaderChatsStore.getState().browse(ptyId, chat, shown.length ? shown : chats ?? []);
    useAgentReaderStore.getState().set(readerAgent(tab), true);
    setOpen(false);
  };
  const resume = (chat: StoredChat) => {
    if (chat.current || busy || resuming) return;
    setResuming(true);
    void resumeChatWithToast(scope, tab, cwd, chat, t).then((done) => {
      setResuming(false);
      if (done) close();
    });
  };

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -8, PageDown: 8 };
    const row = shown[at];
    if (e.key in step) setSelected(Math.max(0, Math.min(shown.length - 1, at + step[e.key])));
    else if (e.key === "Enter" && row && (e.ctrlKey || e.metaKey)) resume(row);
    else if (e.key === "Enter" && row) browse(row);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();
  const yesterday = t("mobile.transcript.yesterday");

  return (
    <span ref={rootRef} className="reader-chats">
      <button
        type="button"
        className={open || browsed ? "prompt-strip-reader active" : "prompt-strip-reader"}
        onMouseDown={keepFocus}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("terminal.chats.hint")}
      >
        {t("terminal.chats.button")}
        <span className={open ? "reader-chats-caret open" : "reader-chats-caret"} aria-hidden="true">▴</span>
        <UntestedTag id="terminal.reader.chats" />
      </button>
      {open && (
        <div className="prompt-strip-panel reader-chats-panel" role="dialog" aria-label={t("terminal.chats.title")} onKeyDown={onKey}>
          <div className="reader-chats-head">
            <strong>{t("terminal.chats.title")}</strong>
            <input
              ref={filterRef}
              type="search"
              className="reader-chats-filter"
              value={filter}
              placeholder={t("terminal.chats.filter")}
              aria-label={t("terminal.chats.filter")}
              onChange={(e) => {
                setFilter(e.target.value);
                setSelected(0);
              }}
            />
          </div>
          {chats === null ? (
            <div className="reader-chats-empty">{t("terminal.chats.loading")}</div>
          ) : shown.length === 0 ? (
            <div className="reader-chats-empty">{t(filter.trim() ? "terminal.chats.noMatch" : "terminal.chats.empty")}</div>
          ) : (
            <ol ref={listRef} className="reader-chats-list" role="listbox" aria-label={t("terminal.chats.title")}>
              {shown.map((chat, index) => (
                <li
                  key={chat.id}
                  role="option"
                  aria-selected={index === at}
                  className={chat.current ? "reader-chats-row current" : "reader-chats-row"}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => browse(chat)}
                >
                  <span className="reader-chats-row-body">
                    <span className="reader-chats-row-title" title={chat.title}>{chat.title}</span>
                    {chat.last && <span className="reader-chats-row-last" title={chat.last}>{chat.last}</span>}
                  </span>
                  <span className="reader-chats-row-side">
                    {chat.current
                      ? <span className="reader-chats-badge">{t("terminal.chats.current")}</span>
                      : <small className="reader-chats-row-time">{chatWhen(chat.updated, use24h, yesterday)}</small>}
                    {!chat.current && (
                      <button
                        type="button"
                        className="reader-chats-resume"
                        disabled={busy || resuming}
                        title={t(busy ? "terminal.chats.resumeBusy" : "terminal.chats.resumeHint")}
                        onClick={(e) => {
                          e.stopPropagation();
                          resume(chat);
                        }}
                      >
                        {t("terminal.chats.resume")}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {next !== undefined && (
            <button type="button" className="reader-chats-more" disabled={loading} onClick={() => load(next)}>
              {t(loading ? "terminal.chats.loading" : "terminal.chats.more")}
            </button>
          )}
          <div className="prompt-strip-keys">{t("terminal.chats.keys", { modifier: modifierLabel() })}</div>
        </div>
      )}
    </span>
  );
}
