import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useT } from "../../lib/i18n";
import { modifierLabel } from "../../lib/shortcuts/shortcuts";
import { useUse24h } from "../../lib/timeFormat";
import { buildPromptTrail, type TrailPrompt } from "../../lib/agents/prompt/trail";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { usePromptTrailStore } from "../../stores/agents/promptTrail";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useMarkupLinksStore } from "../../stores/viewers/markupLinks";
import { usePaneTab } from "../tabs/paneTabContext";
import { UntestedTag } from "../common/UntestedTag";
import { TerminalReaderChats } from "./TerminalReaderChats";
import { ReaderScheduleButton } from "./ReaderScheduleButton";
import { chatsOffered } from "../../lib/agents/agentChats";
import { insertIntoReader } from "../../lib/terminal/terminalDrop";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "../common/icons/Icon";
import { readerAgent, readerRequest, type SessionTranscript } from "../../lib/agents/agentReader";
import { exportFileName, promptsMarkdown, sessionHtml, sessionMarkdown, trailPrompts, transcriptPrompts, type ExportWords } from "../../lib/agents/prompt/export";
import { projectIdOfScope } from "../../lib/terminal/ptyId";
import { useProjectsStore } from "../../stores/projects";
import { hostTabId } from "../../stores/tabs/tabLocation";

/** The most entries one export reads: the backend's own cap
 * (`agent_transcript::MAX_LIMIT`). */
const EXPORT_LIMIT = 1000;

/** Prompt history under a terminal; readable agents use the same controls
 * as a top toolbar with resource/action slots and Chat / Diffs / Terminal tabs.
 * Popups remain local to the pane and never resize the running terminal. */

/** Scopes whose history this window already asked for. */
const historyAsked = new Set<string>();

/** A prompt's time on the app's 12/24-hour clock (`lib/timeFormat`: the
 * setting, else the OS) — the webview's locale is not the desktop's. */
function clockTime(at: number, use24h: boolean): string {
  const when = new Date(at);
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: !use24h })
    : when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: !use24h });
}

/**
 * The switch for the chat in the side panel (`reader_side_chat`, remembered),
 * beside the view tabs and drawn as one of them: pressed, Diffs, Data and
 * Terminal put the tab's conversation in the side panel
 * (`components/layout/ReaderSideChat`); on Chat it stays where it is, so the
 * switch is left out there and returns once another view is picked.
 */
function SideChatSwitch() {
  const t = useT();
  const on = useSettingsStore((s) => s.settings?.reader_side_chat ?? false);
  return (
    <span className="reader-side-chat-switch">
      <button
        type="button"
        aria-pressed={on}
        aria-label={t("terminal.reader.sideChat")}
        title={t(on ? "terminal.reader.sideChatOff" : "terminal.reader.sideChatOn")}
        onClick={() => {
          const now = useSettingsStore.getState().settings?.reader_side_chat ?? false;
          void useSettingsStore.getState().updateSettings({ reader_side_chat: !now });
        }}
      >
        {/* A window with its right column filled: the chat beside. */}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M15 5v14" />
          <path d="M17.5 9h1M17.5 12h1M17.5 15h1" />
        </svg>
      </button>
      <UntestedTag id="terminal.reader.sideChat" />
    </span>
  );
}

/** A prompt as one line: its lines joined with a return mark. */
function oneLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).join(" ⏎ ");
}

function sameEntry(a: TrailPrompt, b: { at: number; text: string }): boolean {
  return a.at === b.at && a.text === b.text;
}

export function TerminalPromptStrip({
  ptyId,
  scope,
  tabKey,
  background,
  foreground,
  onReturnFocus,
  chatShown = false,
  reader,
  topBar = false,
  navigationSlot,
  actionSlot,
}: {
  ptyId: string;
  scope: string;
  tabKey: string;
  /** The terminal's own ground and ink, so the strip reads as its top row. */
  background: string;
  foreground: string;
  /** Hand the keyboard back to the terminal (the drop-down closed). */
  onReturnFocus: () => void;
  /** The Reader covers the terminal: the prompt part is left out. */
  chatShown?: boolean;
  /** Desktop Reader navigation lives above the pane, leaving the composer full width. */
  topBar?: boolean;
  navigationSlot?: (slot: HTMLSpanElement | null) => void;
  actionSlot?: (slot: HTMLSpanElement | null) => void;
  /** The Reader switch (`TerminalReaderView`), for an agent whose stored
   * conversation Tabtivity reads; absent for any other. `changes` is the
   * Diffs switch (`TerminalReaderChanges`), beside the chat or the terminal;
   * `cwd`, the pane's resolved folder, is whose earlier chats the Resume menu
   * lists (`TerminalReaderChats`). */
  /** `onHost`: the CLI of a tab that runs on a remote project's host, whose
   * copy of the conversation the chat reads (unset for a tab that runs here).
   * `sideChat`: the pane may put its chat in the side panel, so the top bar
   * offers the switch for it (`SideChatSwitch`). */
  reader?: { open: boolean; onToggle: () => void; changes?: { open: boolean; onToggle: () => void; empty?: boolean }; files?: { open: boolean; onToggle: () => void; empty?: boolean }; cwd?: string; onHost?: string; sideChat?: boolean };
}) {
  const t = useT();
  const use24h = useUse24h();
  const tab = usePaneTab(scope, tabKey);
  const history = useAgentPromptsStore((state) => state.historyByProject[scope]);
  const typed = usePromptTrailStore((state) => state.typedByPty[ptyId]);
  const trail = useMemo(() => (tab ? buildPromptTrail(history ?? [], typed ?? [], tab) : []), [history, typed, tab]);
  // A PDF whose marks this tab is working on (`stores/viewers/markupLinks`):
  // one click back to it, as its markup strip's Go to tab came here.
  const markupLink = useMarkupLinksStore((state) => state.byPty[ptyId]);
  // The prompt picked with ‹ ›, by identity so a new prompt does not move
  // it; none = follow the newest.
  const [picked, setPicked] = useState<{ at: number; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The last export's outcome, shown in the panel's footer for a moment. */
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  // The host a remote project's tab runs on, whose copy of the conversation
  // the export reads (as the Reader reads it).
  const remoteHost = useProjectsStore((s) =>
    !tab || !reader?.onHost ? null : hostTabId(tab, s.projects.find((p) => p.id === projectIdOfScope(scope))));
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (history || historyAsked.has(scope)) return;
    historyAsked.add(scope);
    void useAgentPromptsStore.getState().loadHistory(scope).catch(() => historyAsked.delete(scope));
  }, [history, scope]);

  const found = picked ? trail.findIndex((entry) => sameEntry(entry, picked)) : -1;
  const index = found >= 0 ? found : trail.length - 1;
  const current = index >= 0 ? trail[index] : undefined;

  // No scrollIntoView and no scrolling focus: either may scroll `.center-pane`
  // itself, which displaces the whole pane (styles/subwindows.css).
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>("[aria-selected='true']");
    if (!open || !list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [open, index]);
  useEffect(() => {
    if (!exportNote) return;
    const timer = setTimeout(() => setExportNote(null), exportNote.ok ? 4000 : 8000);
    return () => clearTimeout(timer);
  }, [exportNote]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const pick = (at: number) => {
    if (!trail.length) return;
    const next = Math.max(0, Math.min(trail.length - 1, at));
    setPicked(next === trail.length - 1 ? null : trail[next]);
  };
  const close = () => {
    setOpen(false);
    onReturnFocus();
  };
  const copy = () => {
    if (!current) return;
    const done = () => setCopied(true);
    invoke("copy_text_to_clipboard", { text: current.text })
      .then(done)
      .catch(() => navigator.clipboard?.writeText(current.text).then(done))
      .catch(() => {});
  };
  /** The tab's stored conversation, read whole (up to the backend's cap) —
   * null for an agent whose transcript is not read, or none recorded yet. */
  const readSession = async (): Promise<SessionTranscript | null> => {
    if (!reader || !tab) return null;
    const args = readerRequest(scope, tab, reader.cwd, undefined, EXPORT_LIMIT, undefined, undefined, remoteHost);
    if (!args) return null;
    const read = await invoke<SessionTranscript>("agent_tab_transcript", args).catch(() => null);
    return read?.available ? read : null;
  };
  /** Save the whole session, or only the user's prompts, as Markdown where
   * the user picks. The prompts come from the transcript when it is read
   * and holds any (with their line breaks, where the history folds them to
   * one line), else from this panel's own list. */
  const exportAs = async (what: "session" | "chat" | "prompts") => {
    if (exporting) return;
    setExporting(true);
    try {
      const session = await readSession();
      if (what !== "prompts" && !session) {
        setExportNote({ ok: false, text: t("terminal.promptStrip.exportNoSession") });
        return;
      }
      const label = tab?.label;
      const words: ExportWords = {
        title: t(what === "prompts" ? "terminal.promptStrip.exportPromptsTitle" : "terminal.promptStrip.exportSessionTitle", { tab: label || t("terminal.promptStrip.label") }),
        you: t("terminal.promptStrip.exportYou"),
        agent: t("terminal.promptStrip.exportAgent"),
        plan: t("terminal.promptStrip.exportPlan"),
        subagent: t("terminal.promptStrip.exportSubagent"),
        interrupted: t("terminal.promptStrip.exportInterrupted"),
        cut: t("terminal.promptStrip.exportCut"),
        earlier: t("terminal.promptStrip.exportEarlier", { n: EXPORT_LIMIT }),
      };
      const read = session ? transcriptPrompts(session.entries) : [];
      const text = what === "chat" && session
        ? sessionHtml(session.entries, { words, use24h, truncated: session.truncated })
        : what === "session" && session
        ? sessionMarkdown(session.entries, { words, use24h, truncated: session.truncated })
        : read.length
          ? promptsMarkdown(read, { words, use24h, truncated: session?.truncated })
          : promptsMarkdown(trailPrompts(trail), { words, use24h });
      const path = await saveDialog({
        defaultPath: exportFileName(label, what),
        filters: what === "chat" ? [{ name: "HTML", extensions: ["html"] }] : [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof path !== "string") return;
      await invoke("agent_session_export_write", { path, content: text });
      setExportNote({ ok: true, text: t("terminal.promptStrip.exported", { path }) });
    } catch (err) {
      setExportNote({ ok: false, text: t("terminal.promptStrip.exportFailed", { error: String(err) }) });
    } finally {
      setExporting(false);
      panelRef.current?.focus({ preventScroll: true });
    }
  };
  /** Over Chat, Diffs or Data: the picked prompt into the Reader's text box
   * (at the caret), to send again or edit; the box takes the keyboard and
   * the view stays. */
  const reuse = () => {
    if (!current) return;
    setOpen(false);
    if (!insertIntoReader(ptyId, current.text)) onReturnFocus();
  };
  const onPanelKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -5, PageDown: 5 };
    if (e.key in step) pick(index + step[e.key]);
    else if (e.key === "Home") pick(0);
    else if (e.key === "End") pick(trail.length - 1);
    else if (e.key === "Enter" && chatShown) reuse();
    else if (e.key === "Escape" || e.key === "Enter") close();
    else if (e.key === "c" && (e.ctrlKey || e.metaKey)) copy();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Buttons keep the terminal's focus: stepping back must not steal the keys
  // the user is typing the next prompt with.
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

  // Nothing to put under a chat that has no switches (Tabby, docked columns).
  if (chatShown && !markupLink && !reader) return null;

  return (
    <div
      className={`prompt-strip${chatShown ? " chat" : ""}${topBar ? " reader-topbar" : ""}`}
      style={chatShown || topBar ? undefined : { background, color: foreground }}
    >
      {!chatShown && !topBar && <>
        <span className="prompt-strip-label">
          {t("terminal.promptStrip.label")}
          <UntestedTag id="terminal.promptStrip" />
        </span>
        <button
          type="button"
          className="prompt-strip-text"
          onMouseDown={keepFocus}
          onClick={() => (open ? close() : setOpen(true))}
          disabled={!current}
          title={current?.text}
        >
          {current ? oneLine(current.text) : t("terminal.promptStrip.none")}
        </button>
        {current && (
          <>
            {current.source === "typed" && (
              <span className="prompt-strip-typed" title={t("terminal.promptStrip.typedHint")}>≈</span>
            )}
            <span className="prompt-strip-time">{clockTime(current.at, use24h)}</span>
            <span className="prompt-strip-nav">
              <button
                type="button"
                className="prompt-strip-btn"
                onMouseDown={keepFocus}
                onClick={() => pick(index - 1)}
                disabled={index <= 0}
                aria-label={t("terminal.promptStrip.older")}
                title={t("terminal.promptStrip.older")}
              >
                <ChevronLeftIcon />
              </button>
              <span className="prompt-strip-count">{t("terminal.promptStrip.count", { n: index + 1, total: trail.length })}</span>
              <button
                type="button"
                className="prompt-strip-btn"
                onMouseDown={keepFocus}
                onClick={() => pick(index + 1)}
                disabled={index >= trail.length - 1}
                aria-label={t("terminal.promptStrip.newer")}
                title={t("terminal.promptStrip.newer")}
              >
                <ChevronRightIcon />
              </button>
            </span>
            <button
              type="button"
              className="prompt-strip-btn"
              onMouseDown={keepFocus}
              onClick={copy}
              aria-label={t("terminal.promptStrip.copy")}
              title={t(copied ? "terminal.promptStrip.copied" : "terminal.promptStrip.copy")}
            >
              {copied ? <CheckIcon /> : "⧉"}
            </button>
          </>
        )}
      </>}
      <span className="prompt-strip-actions">
        {/* First of the switches, not in the prompt part: the list is offered
            over the chat too, and the row is the same in both modes. */}
        {/* Over the chat a labelled pill like Resume beside it; under the
            terminal the prompt text sits right beside it, so a caret will do. */}
        {(current || topBar) && (chatShown || topBar) && (
          <button
            type="button"
            className={open ? "prompt-strip-reader active" : "prompt-strip-reader"}
            onMouseDown={keepFocus}
            onClick={() => (open ? close() : setOpen(true))}
            disabled={!current}
            aria-expanded={open}
            title={t(open ? "terminal.promptStrip.collapse" : "terminal.promptStrip.expand")}
          >
            {t("terminal.promptStrip.history")}
            <span className={open ? "reader-chats-caret open" : "reader-chats-caret"} aria-hidden="true">▴</span>
          </button>
        )}
        {current && !chatShown && !topBar && (
          <button
            type="button"
            className="prompt-strip-btn"
            onMouseDown={keepFocus}
            onClick={() => (open ? close() : setOpen(true))}
            aria-expanded={open}
            aria-label={t(open ? "terminal.promptStrip.collapse" : "terminal.promptStrip.expand")}
            title={t(open ? "terminal.promptStrip.collapse" : "terminal.promptStrip.expand")}
          >
            {open ? "▾" : "▴"}
          </button>
        )}
        {markupLink && (
          <button
            type="button"
            className="prompt-strip-reader prompt-strip-markup"
            onMouseDown={keepFocus}
            onClick={() => useTabsStore.getState().setActive(markupLink.tabKey)}
            title={`${t("terminal.promptStrip.markupHint")} — ${markupLink.name}`}
          >
            <span>{t("terminal.promptStrip.markup", { name: markupLink.name })}</span>
            <UntestedTag id="desktop.markup.link" />
          </button>
        )}
        {reader && chatsOffered(scope, tab) && (
          <TerminalReaderChats ptyId={ptyId} scope={scope} tab={tab} cwd={reader.cwd} onReturnFocus={onReturnFocus} />
        )}
        {topBar && reader && tab && (tab.kind === "agent" || tab.kind === "local_agent") && (
          <ReaderScheduleButton scope={scope} tab={tab} />
        )}
        {topBar && <>
          <span className="reader-topbar-navigation" ref={navigationSlot} />
          <span className="reader-topbar-actions" ref={actionSlot} />
        </>}
        {topBar && reader ? <>
          <div className="reader-view-tabs" role="tablist" aria-label={t("terminal.reader.views")} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
          }}>
            {/* Chat and Terminal share one pill: picked, a click flips it to
                the other; from Diffs or Data, a click comes back to it. */}
            <button type="button" role="tab" className="reader-view-flip"
              aria-selected={!reader.changes?.open && !reader.files?.open}
              tabIndex={!reader.changes?.open && !reader.files?.open ? 0 : -1}
              title={reader.changes?.open || reader.files?.open ? undefined : t(reader.open ? "terminal.reader.showTerminalHint" : "terminal.reader.showReaderHint")}
              onClick={() => {
                if (reader.changes?.open || reader.files?.open) {
                  if (reader.changes?.open) reader.changes.onToggle();
                  if (reader.files?.open) reader.files.onToggle();
                  return;
                }
                reader.onToggle();
              }}>
              <span className="prompt-strip-mode">
                <span aria-hidden={!reader.open}>{t("terminal.reader.showReader")}</span>
                <span aria-hidden={reader.open}>{t("terminal.reader.showTerminal")}</span>
              </span>
              <span className="reader-view-flip-mark" aria-hidden="true">⇄</span>
            </button>
            {reader.changes && <button type="button" role="tab" aria-selected={reader.changes.open}
              tabIndex={reader.changes.open ? 0 : -1}
              disabled={!reader.changes.open && reader.changes.empty}
              title={!reader.changes.open && reader.changes.empty ? t("terminal.reader.changesNone") : undefined}
              onClick={() => { if (!reader.changes?.open) reader.changes?.onToggle(); }}>
              {t("terminal.reader.changes")}
            </button>}
            {reader.files && <button type="button" role="tab" aria-selected={reader.files.open}
              tabIndex={reader.files.open ? 0 : -1}
              disabled={!reader.files.open && reader.files.empty}
              title={!reader.files.open && reader.files.empty ? t("terminal.reader.filesNone") : undefined}
              onClick={() => { if (!reader.files?.open) reader.files?.onToggle(); }}>
              {t("terminal.reader.filesTab")}
              <UntestedTag id="terminal.reader.files" />
            </button>}
            <UntestedTag id="terminal.reader.topbar" />
            <UntestedTag id="terminal.reader.flipPill" />
            {reader.onHost === "claude" && <UntestedTag id="terminal.reader.hostTab" />}
            {tab?.kind === "local_agent" && readerAgent(tab) === "claude" && <UntestedTag id="terminal.reader.localClaude" />}
            {reader.onHost === "codex" && <UntestedTag id="terminal.reader.hostTab.codex" />}
            {reader.onHost === "agy" && <UntestedTag id="terminal.reader.hostTab.agy" />}
            {reader.onHost === "muse" && <UntestedTag id="terminal.reader.hostTab.muse" />}
            {reader.onHost === "copilot" && <UntestedTag id="terminal.reader.hostTab.copilot" />}
            {reader.onHost === "opencode" && <UntestedTag id="terminal.reader.hostTab.opencode" />}
          </div>
          {/* On Chat the chat stays where it is, so the switch has nothing to do. */}
          {reader.sideChat && !(reader.open && !reader.changes?.open && !reader.files?.open) && <SideChatSwitch />}
        </> : <>
        {reader?.changes && (
          <button
            type="button"
            className={reader.changes.open ? "prompt-strip-reader active" : "prompt-strip-reader"}
            onMouseDown={keepFocus}
            onClick={reader.changes.onToggle}
            aria-pressed={reader.changes.open}
            disabled={!reader.changes.open && reader.changes.empty}
            title={t(reader.changes.open ? "terminal.reader.changesHideHint" : !reader.changes.empty ? "terminal.reader.changesHint" : "terminal.reader.changesNone")}
          >
            {t("terminal.reader.changes")}
            <UntestedTag id="terminal.reader.changes" />
          </button>
        )}
        {reader && (
          <button
            type="button"
            className={reader.open ? "prompt-strip-reader active" : "prompt-strip-reader"}
            onMouseDown={keepFocus}
            onClick={reader.onToggle}
            aria-pressed={reader.open}
            title={t(reader.open ? "terminal.reader.showTerminalHint" : "terminal.reader.showReaderHint")}
          >
            {/* Both labels laid over each other, the other one hidden: the
                switch keeps its width, so it never shifts under the pointer. */}
            <span className="prompt-strip-mode">
              <span aria-hidden={reader.open}>{t("terminal.reader.showReader")}</span>
              <span aria-hidden={!reader.open}>{t("terminal.reader.showTerminal")}</span>
            </span>
            <UntestedTag id="terminal.reader" />
            {tab?.kind === "local_agent" && <UntestedTag id="terminal.reader.localOpenCode" />}
            {tab?.cmd === "agy" && <UntestedTag id="terminal.reader.antigravity" />}
          </button>
        )}
        </>}
      </span>
      {open && current && (
        <div
          ref={panelRef}
          className="prompt-strip-panel"
          role="dialog"
          aria-label={t("terminal.promptStrip.label")}
          tabIndex={-1}
          onKeyDown={onPanelKey}
        >
          <div className="prompt-strip-full">{current.text}</div>
          {trail.length > 1 && (
            <ol ref={listRef} className="prompt-strip-list" role="listbox" aria-label={t("terminal.promptStrip.all")}>
              {trail
                .map((entry, i) => ({ entry, i }))
                .reverse()
                .map(({ entry, i }) => (
                  <li
                    key={`${entry.at}|${i}`}
                    role="option"
                    aria-selected={i === index}
                    className="prompt-strip-row"
                    onClick={() => pick(i)}
                    onDoubleClick={chatShown ? reuse : undefined}
                    title={entry.text}
                  >
                    <span className="prompt-strip-row-time">{clockTime(entry.at, use24h)}</span>
                    <span className="prompt-strip-row-text">{oneLine(entry.text)}</span>
                    {entry.source === "typed" && <span className="prompt-strip-typed">≈</span>}
                  </li>
                ))}
            </ol>
          )}
          <div className="prompt-strip-keys">
            <span className={exportNote ? (exportNote.ok ? "prompt-strip-note" : "prompt-strip-note error") : undefined} role={exportNote ? "status" : undefined}>
              {exportNote?.text ?? t(chatShown ? "terminal.promptStrip.keysChat" : "terminal.promptStrip.keys", { modifier: modifierLabel() })}
            </span>
            <span className="prompt-strip-export">
              <UntestedTag id="terminal.promptStrip.export" />
              {reader && (
                <button type="button" className="prompt-strip-reader prompt-strip-export-btn" onMouseDown={keepFocus} disabled={exporting}
                  onClick={() => void exportAs("session")} title={t("terminal.promptStrip.exportSessionHint")}>
                  {t("terminal.promptStrip.exportSession")}
                </button>
              )}
              {reader && (
                <button type="button" className="prompt-strip-reader prompt-strip-export-btn" onMouseDown={keepFocus} disabled={exporting}
                  onClick={() => void exportAs("chat")} title={t("terminal.promptStrip.exportChatHint")}>
                  {t("terminal.promptStrip.exportChat")}
                </button>
              )}
              <button type="button" className="prompt-strip-reader prompt-strip-export-btn" onMouseDown={keepFocus} disabled={exporting}
                onClick={() => void exportAs("prompts")} title={t("terminal.promptStrip.exportPromptsHint")}>
                {t("terminal.promptStrip.exportPrompts")}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
