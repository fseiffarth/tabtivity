import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { modifierLabel } from "../../lib/shortcuts/shortcuts";
import { useUse24h } from "../../lib/timeFormat";
import { buildPromptTrail, type TrailPrompt } from "../../lib/agents/prompt/trail";
import { useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { usePromptTrailStore } from "../../stores/agents/promptTrail";
import { useTabsStore } from "../../stores/tabs";
import { useMarkupLinksStore } from "../../stores/viewers/markupLinks";
import { usePaneTab } from "../tabs/paneTabContext";
import { UntestedTag } from "../common/UntestedTag";
import { TerminalReaderChats } from "./TerminalReaderChats";
import { chatsOffered } from "../../lib/agents/agentChats";
import { insertIntoReader } from "../../lib/terminal/terminalDrop";

/**
 * The strip docked under an agent pane's terminal: the last prompt of the
 * tab, one line, with ‹ › to step back through the earlier ones and a pop-up
 * over the terminal's bottom for the whole text and the list; the pane's
 * switches (Resume, Diffs, Chat/Terminal) at its right end.
 *
 * Agent TUIs repaint, fold and clear their own scrollback, so the prompt that
 * started a long turn is often nowhere on screen; the strip keeps it without
 * asking the CLI (`lib/agents/prompt/trail`). While the chat is shown the
 * prompt part stands down (the chat pins it itself): the chat reaches down
 * over the strip's row and its composer takes it, the switches staying where
 * they were, right of the text box (`onActionsWidth` is the room it leaves
 * them). A fixed one-line height in both, so neither a mode switch nor the
 * pop-up refits the terminal or moves a switch.
 */

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
  onActionsWidth,
  reader,
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
  /** The switches' width, whenever it changes. */
  onActionsWidth?: (width: number) => void;
  /** The Reader switch (`TerminalReaderView`), for an agent whose stored
   * conversation Tabtivity reads; absent for any other. `changes` is the
   * Diffs switch (`TerminalReaderChanges`), beside the chat or the terminal;
   * `cwd`, the pane's resolved folder, is whose earlier chats the Resume menu
   * lists (`TerminalReaderChats`). */
  reader?: { open: boolean; onToggle: () => void; changes?: { open: boolean; onToggle: () => void }; cwd?: string };
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
  const panelRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLSpanElement>(null);
  const onActionsWidthRef = useRef(onActionsWidth);
  onActionsWidthRef.current = onActionsWidth;
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
  // Measured, not guessed: which switches show (and their labels' language)
  // decides the room the composer leaves them.
  const hasMarkup = !!markupLink;
  const hasReader = !!reader;
  useEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    const report = () => onActionsWidthRef.current?.(actions.offsetWidth);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(actions);
    return () => observer.disconnect();
  }, [chatShown, hasMarkup, hasReader]);
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
  /** Over the chat: the picked prompt into its text box (at the caret), to
   * send again or edit; the box takes the keyboard. */
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
      className={chatShown ? "prompt-strip chat" : "prompt-strip"}
      style={chatShown ? undefined : { background, color: foreground }}
    >
      {!chatShown && <>
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
                ‹
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
                ›
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
              {copied ? "✓" : "⧉"}
            </button>
          </>
        )}
      </>}
      <span ref={actionsRef} className="prompt-strip-actions">
        {/* First of the switches, not in the prompt part: the list is offered
            over the chat too, and the row is the same in both modes. */}
        {current && (
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
        {reader?.changes && (
          <button
            type="button"
            className={reader.changes.open ? "prompt-strip-reader active" : "prompt-strip-reader"}
            onMouseDown={keepFocus}
            onClick={reader.changes.onToggle}
            aria-pressed={reader.changes.open}
            title={t(reader.changes.open ? "terminal.reader.changesHideHint" : "terminal.reader.changesHint")}
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
            {t(chatShown ? "terminal.promptStrip.keysChat" : "terminal.promptStrip.keys", { modifier: modifierLabel() })}
          </div>
        </div>
      )}
    </div>
  );
}
