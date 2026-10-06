import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import {
  READER_STEP,
  composerHistory,
  mergeTranscript,
  readerReasonKey,
  readerRequest,
  type SessionTranscript,
} from "../../lib/agents/agentReader";
import { NO_LIVE, STOP_KEY, answerKeys, answerTextKeys, freeTextRow, readReaderLive, sameReaderLive, tabStepKeys, type ReaderLive } from "../../lib/agents/readerLive";
import { onSentPrompt } from "../../lib/agents/sentPrompts";
import { readerDraft, setReaderDraft } from "../../lib/agents/readerDrafts";
import { clearAgentTab, sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { isNewConversationCommand } from "../../lib/agents/typedClear";
import { submitScheduledAgentMessage } from "../../lib/agents/scheduledAgentInput";
import { agentFamily, agentInputWrites } from "../../../shared/agentComposer";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import { isClaudeCommand } from "../../lib/terminal/terminalControl";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { isInterruptInput, noteUserInput, useActivityStore } from "../../stores/activity";
import { useUse24h } from "../../lib/timeFormat";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore, useReaderChangesOpen } from "../../stores/agents/agentReader";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { TerminalReaderFacts } from "./TerminalReaderFacts";
import { TerminalReaderChanges, changesWidthStyle } from "./TerminalReaderChanges";
import { UntestedTag } from "../common/UntestedTag";
import { TabStatusMark } from "../tabs/TabLocalityBadges";
import { answerHtml, promptHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { chatDayLabel, chatMoment, chatTime, dayOpeners } from "../../../mobile-web/src/terminal/chatTimes";
import { bufferRows, sendToSubagent, type SubagentSendFailure } from "../../../mobile-web/src/terminal/subagentInput";
import { completedSlashCommand, forgetSlashCommand, readSlashCommands, rememberSlashCommand, slashSuggestions, type SlashSuggestion } from "../../../mobile-web/src/slashCommands";
import { ReaderSlashMenu } from "./ReaderSlashMenu";
import { compactTokens, openSubagent, openSubagentRunning, siblingPosition, stepSibling, subagentAtWork, workingElapsed, workingModelName, type SubagentStep } from "../../../mobile-web/src/terminal/subagents";
import { commandArgsInline, slashCommand, transcriptTurns, type TranscriptTurn } from "../../../mobile-web/src/terminal/transcriptTurns";
import { afterClear, clearMark } from "../../../mobile-web/src/terminal/clearedSession";
import type { AskedQuestion, RunningShell } from "../../../mobile-web/src/api";

/** How often a shown Reader asks for the transcript again. The backend
 * answers an unchanged file by its fingerprint, without a parse. */
const POLL_MS = 2000;
/** How long a sent prompt shows as sending while the transcript has not
 * recorded it yet — counted from the send, or from the last moment the agent
 * was seen working (a prompt queued behind a long turn is recorded only once
 * the CLI takes it up). */
const PENDING_MS = 60_000;
/** How soon after the pane's output the live screen is read again, and how
 * often regardless (the busy row's timer, a pane not created yet). */
const LIVE_SETTLE_MS = 250;
const LIVE_POLL_MS = 1500;
/** The phone's key pacing for a dialog answer: arrows apart, Enter later. */
const KEY_GAP_MS = 80;
const SUBMIT_GAP_MS = 200;
/** How long an answered dialog stays unclickable while the session redraws. */
const ANSWER_WAIT_MS = 3000;
const ENCODER = new TextEncoder();

async function typeKeys(ptyId: string, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1) {
    const bytes = ENCODER.encode(keys[index]);
    noteUserInput(ptyId, isInterruptInput(keys[index]));
    await writePtyInput(ptyId, bytes);
    if (index + 1 < keys.length) {
      await new Promise((resolve) => setTimeout(resolve, index + 2 === keys.length ? SUBMIT_GAP_MS : KEY_GAP_MS));
    }
  }
}

/** A shell command the agent waits on — or sent to the background, where it
 * runs on past the turn — as a line under its working row: what it does (the
 * agent's description, else the command), and on a click the whole command —
 * the terminal shows only its first rows. */
function RunningShellLine({ shell }: { shell: RunningShell }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const commandId = useId();
  const summary = shell.description || shell.command.split("\n", 1)[0];
  return (
    <div className="terminal-reader-shell">
      <button
        type="button"
        className="terminal-reader-working terminal-reader-shell-toggle"
        aria-expanded={open}
        aria-controls={commandId}
        title={t(open ? "terminal.reader.shellHide" : "terminal.reader.shellShow")}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="terminal-reader-shell-mark" aria-hidden="true">$</span>
        <span>{t(shell.background ? "terminal.reader.shellBackground" : "terminal.reader.shellWorking")}</span>
        <small className="terminal-reader-shell-summary">{summary}</small>
        <UntestedTag id="terminal.reader.shellWorking" />
        <span className={open ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
      </button>
      {open && (
        <pre id={commandId} className="terminal-reader-question-context terminal-reader-shell-command">
          {shell.command}{shell.cut && "…"}
        </pre>
      )}
    </div>
  );
}

/** The mark Claude Code asks agents to put on the option they would pick,
 * shown as a tag beside the label (the phone's `QuestionList` does the same). */
const RECOMMENDED = /\s+\(Recommended\)$/u;

/** The choice the session waits on, as buttons: what it was drawn onto (a
 * permission prompt's command or diff), an agent question's headers as chips,
 * its question, then one row per option. A click sends the arrow keys and
 * Enter a walked highlight would. A question that asks several has its
 * headers as steps: ←/→ and a click on one walk the dialog's tabs, so an
 * answer can be changed before Submit. Claude Code's "Type something." row
 * opens a field under it instead: its answer is words, sent as the phone's
 * are (`answerTextKeys`). */
function LiveQuestion({ live, answered, busy, onAnswer, onType, onStep }: {
  live: ReaderLive;
  /** A row was clicked and the session has not redrawn yet. */
  answered: boolean;
  /** Keys of any kind are on their way: nothing can be clicked. */
  busy: boolean;
  onAnswer: (index: number) => void;
  /** Answers the free-text row `index` with `text`. */
  onType: (index: number, text: string) => void;
  /** Walks the tab row from step `from` to step `to`. */
  onStep: (from: number, to: number) => void;
}) {
  const t = useT();
  /** The free-text row whose field is open, and what is typed in it. A field
   * belongs to the dialog step it was opened on. */
  const [typing, setTyping] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    setTyping(null);
    setTyped("");
  }, [live.signature]);
  const question = live.question;
  if (!question) return null;
  const sendTyped = (index: number) => {
    if (!typed.trim()) return;
    onType(index, typed);
  };
  const last = live.tabs.length - (live.tabSubmit ? 0 : 1);
  const stepped = last > 0;
  const focus = live.tabFocus;
  const tabClass = (answeredTab: boolean, index: number) =>
    [answeredTab && "answered", index === focus && "current"].filter(Boolean).join(" ") || undefined;
  return (
    <div className="terminal-reader-question" role="group" aria-label={t("terminal.reader.question")}>
      <small className="terminal-reader-question-head">{t("terminal.reader.question")}</small>
      {live.context.length > 0 && <pre className="terminal-reader-question-context">{live.context.join("\n")}</pre>}
      {live.tabs.length > 0 && !stepped && (
        <div className="terminal-reader-question-tabs">
          {live.tabs.map((tab, index) => (
            <span key={index} className={tab.answered ? "answered" : undefined}>{tab.answered && "✓ "}{tab.label}</span>
          ))}
        </div>
      )}
      {stepped && (
        <div className="terminal-reader-question-tabs stepped" role="toolbar" aria-label={t("terminal.reader.questionSteps")}>
          <button
            type="button"
            className="terminal-reader-question-step"
            aria-label={t("terminal.reader.questionPrevious")}
            title={t("terminal.reader.questionPrevious")}
            disabled={busy || focus === 0}
            onClick={() => (focus === null ? onStep(1, 0) : onStep(focus, focus - 1))}
          >←</button>
          {live.tabs.map((tab, index) => (
            <button
              key={index}
              type="button"
              className={tabClass(tab.answered, index)}
              aria-current={index === focus ? "step" : undefined}
              disabled={busy || focus === null || index === focus}
              onClick={() => focus !== null && onStep(focus, index)}
            >{tab.answered && "✓ "}{tab.label}</button>
          ))}
          {live.tabSubmit && (
            <button
              type="button"
              className={tabClass(false, live.tabs.length)}
              aria-current={focus === live.tabs.length ? "step" : undefined}
              disabled={busy || focus === null || focus === live.tabs.length}
              onClick={() => focus !== null && onStep(focus, live.tabs.length)}
            >{t("terminal.reader.questionSubmitStep")}</button>
          )}
          <button
            type="button"
            className="terminal-reader-question-step"
            aria-label={t("terminal.reader.questionNext")}
            title={t("terminal.reader.questionNext")}
            disabled={busy || focus === last}
            onClick={() => (focus === null ? onStep(0, 1) : onStep(focus, focus + 1))}
          >→</button>
          <UntestedTag id="terminal.reader.questionSteps" />
        </div>
      )}
      {live.ask.length > 0 && <p className="terminal-reader-question-ask">{live.ask.join("\n")}</p>}
      <div className="terminal-reader-options">
        {question.options.map((option) => {
          const recommended = RECOMMENDED.exec(option.label);
          const label = question.review ? t("terminal.reader.questionSubmitStep") : option.label;
          const freeText = !question.review && freeTextRow(option);
          const open = freeText && typing === option.index;
          return (
            <Fragment key={`${option.index}:${option.label}`}>
              <button
                type="button"
                className={option.index === question.current ? "terminal-reader-option current" : "terminal-reader-option"}
                aria-expanded={freeText ? open : undefined}
                disabled={busy}
                onClick={() => (freeText ? setTyping(open ? null : option.index) : onAnswer(option.index))}
              >
                <span className="terminal-reader-option-number">{option.number}</span>
                <span className="terminal-reader-option-label">
                  <span>
                    {recommended ? option.label.slice(0, recommended.index) : label}
                    {recommended && <em className="terminal-reader-recommended">{t("terminal.reader.recommended")}</em>}
                  </span>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
              {open && (
                <form
                  className="terminal-reader-question-type"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendTyped(option.index);
                  }}
                >
                  <input
                    autoFocus
                    type="text"
                    value={typed}
                    disabled={busy}
                    placeholder={t("mobile.question.typePlaceholder")}
                    aria-label={t("mobile.question.typePlaceholder")}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      setTyping(null);
                    }}
                  />
                  <button type="submit" className="file-viewer-zoom-btn file-viewer-zoom-text active" disabled={busy || !typed.trim()}>
                    {t("mobile.question.typeSend")}
                  </button>
                  <UntestedTag id="terminal.reader.freeText" />
                </form>
              )}
            </Fragment>
          );
        })}
      </div>
      {!!question.hidden && <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small>}
      {answered && <small className="terminal-reader-question-more" role="status">{t("terminal.reader.answering")}</small>}
    </div>
  );
}

/** A question the agent asked, kept in the chat once answered (the phone's
 * `AskedCard`): `LiveQuestion`'s card, its rows no longer buttons — the ones
 * the answer took ticked, an answer typed instead of picked as a row of its
 * own, and one turned down saying so. */
function AskedQuestions({ questions, time }: { questions: readonly AskedQuestion[]; time: ReactNode }) {
  const t = useT();
  return (
    <div className="terminal-reader-question asked" role="group" aria-label={t("mobile.transcript.asked")}>
      <small className="terminal-reader-question-head">{t("mobile.transcript.asked")} <UntestedTag id="mobile.focus.askedCard" /></small>
      {questions.map((asked, index) => {
        const typed = asked.answer !== undefined && !asked.options?.some((option) => option.chosen);
        return (
          <Fragment key={index}>
            {asked.header && <div className="terminal-reader-question-tabs"><span>{asked.header}</span></div>}
            <p className="terminal-reader-question-ask">{asked.question}</p>
            <div className="terminal-reader-options">
              {asked.options?.map((option, row) => {
                const recommended = RECOMMENDED.exec(option.label);
                return (
                  <div key={row} className={option.chosen ? "terminal-reader-option chosen" : "terminal-reader-option"}>
                    <span className="terminal-reader-option-number">{option.chosen ? "✓" : row + 1}</span>
                    <span className="terminal-reader-option-label">
                      <span>
                        {recommended ? option.label.slice(0, recommended.index) : option.label}
                        {recommended && <em className="terminal-reader-recommended">{t("terminal.reader.recommended")}</em>}
                      </span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </div>
                );
              })}
              {typed && (
                <div className="terminal-reader-option chosen">
                  <span className="terminal-reader-option-number">✓</span>
                  <span className="terminal-reader-option-label"><span>{asked.answer}</span></span>
                </div>
              )}
            </div>
            {asked.answer === undefined && <small className="terminal-reader-question-more">{t("mobile.transcript.notAnswered")}</small>}
          </Fragment>
        );
      })}
      {time}
    </div>
  );
}

interface PendingPrompt { id: number; text: string; sentAt: number }

/** One answer as formatted text (`answerHtml`, the phone's: formatting only,
 * nothing in it opens or loads). Memoized on the text, so a read that brings
 * a new turn does not re-render every answer above it. */
const AnswerText = memo(function AnswerText({ text }: { text: string }) {
  const html = useMemo(() => answerHtml(text), [text]);
  return <div className="markdown-body terminal-reader-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A prompt, formatted the same way (`promptHtml`: an answer's formatting,
 * its single line breaks kept) — a subagent's brief reads as written. */
const PromptText = memo(function PromptText({ text }: { text: string }) {
  const html = useMemo(() => promptHtml(text), [text]);
  return <div className="markdown-body terminal-reader-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** What a subagent's card or list row opens: its handle and what it says. */
type SubagentPick = Pick<TranscriptTurn, "subagent" | "text" | "role">;

function Turn({ turn, cutLabel, planLabel, agentLabel, use24h, onOpenAgent }: {
  turn: TranscriptTurn;
  cutLabel: string;
  planLabel: string;
  agentLabel: string;
  use24h: boolean;
  onOpenAgent: (turn: SubagentPick) => void;
}) {
  const moment = chatMoment(turn.stamp);
  const time = moment && <small className="terminal-reader-time">{chatTime(moment, use24h)}</small>;
  const cut = turn.cut && <small className="terminal-reader-cut">{cutLabel}</small>;
  if (turn.kind === "agent") {
    // The phone's `SubagentCard`: when it started, and a click opens its own
    // conversation. One that has reported back wears the tab strip's ✓ (where
    // its CLI records that). One whose CLI has not yet recorded where its
    // conversation lives cannot be opened yet.
    const openable = !!turn.subagent;
    return (
      <button type="button" className="terminal-reader-subagent" disabled={!openable} onClick={() => onOpenAgent(turn)}>
        <span className="terminal-reader-subagent-body">
          <small>{turn.role ?? agentLabel} <UntestedTag id="terminal.reader.subagents" /></small>
          <span>{turn.text}{turn.cut && "…"}</span>
          {time}
        </span>
        {turn.finished && <TabStatusMark stateClass="finished" />}
        {openable && <span className="terminal-reader-subagent-chevron" aria-hidden="true">›</span>}
      </button>
    );
  }
  if (turn.command) {
    const inline = commandArgsInline(turn.command.args);
    return <>
      <div className="terminal-reader-command" role="separator" data-prompt={turn.command.args ? `${turn.command.name} ${turn.command.args}` : turn.command.name}>
        <span>{inline && turn.command.args ? `${turn.command.name} ${turn.command.args}` : turn.command.name}</span>
      </div>
      {!inline && <div className="terminal-reader-turn user"><p>{turn.command.args}</p>{time}</div>}
    </>;
  }
  if (turn.kind === "prompt") {
    return <div className="terminal-reader-turn user" data-prompt={turn.text}><PromptText text={turn.text} />{cut}{time}</div>;
  }
  if (turn.questions) return <AskedQuestions questions={turn.questions} time={time} />;
  return (
    <div className={turn.plan ? "terminal-reader-turn agent plan" : "terminal-reader-turn agent"}>
      {turn.plan && <small className="terminal-reader-plan-head">{planLabel}</small>}
      <AnswerText text={turn.text} />
      {cut}
      {time}
    </div>
  );
}

/**
 * The Reader's composer, holding its own draft: a keystroke re-renders this
 * box, never the conversation above it — with a long chat that was every turn
 * and the facts row per key, on the one renderer thread typing waits for.
 * Mounted while steering holds the keyboard (drawn as nothing), so a draft
 * survives steering; an unsent draft is kept per tab (`readerDrafts`), so
 * it survives the Reader unmounting too — another tab shown, the switch
 * flipped. Sends through the prompt box's path (`sendSteeringPrompt`); ↑/↓
 * walk `history`; Esc is `onEscape`.
 *
 * With a Claude subagent open, `subagent`, the words go to it instead — through
 * Claude Code's own agent list (`subagentInput`), the one way it takes them —
 * and nothing goes anywhere when that subagent cannot be reached.
 */
/** Why a message to a subagent did not go, said in the composer. */
const SUBAGENT_SEND_FAILED: Record<SubagentSendFailure, TranslationKey> = {
  not_listed: "terminal.reader.subagentNotListed",
  ambiguous: "terminal.reader.subagentAmbiguous",
  not_opened: "terminal.reader.subagentNoWay",
  send_failed: "terminal.reader.sendFailed",
};

function ReaderComposer({ scope, tabKey, tabRef, ptyId, cli, subagent, history, focused, visible, steering, onEscape, onStatus }: {
  scope: string;
  tabKey: string;
  tabRef: RefObject<TabEntry | undefined>;
  /** The tab's CLI (`agentFamily`): whose commands the `/` menu offers. */
  cli: string;
  /** The pane the subagent's list is read off and walked in. */
  ptyId: string;
  /** The open subagent to write to: its description and type. */
  subagent?: { task: string; role?: string };
  history: readonly string[];
  focused: boolean;
  visible: boolean;
  steering: boolean;
  onEscape: () => void;
  onStatus: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => readerDraft(scope, tabKey));
  useEffect(() => setReaderDraft(scope, tabKey, draft), [scope, tabKey, draft]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Where the ↑/↓ walk stands in `history`, and the draft it set aside;
   * null while the composer holds the user's own draft. */
  const historyAt = useRef<number | null>(null);
  const setAsideDraft = useRef("");
  /** The `/` menu (`ReaderSlashMenu`): the commands sent to this CLI before,
   * the row ↑/↓ moved to (null before they were pressed) and whether Esc
   * closed it for the draft as it stands. */
  const [usedSlash, setUsedSlash] = useState(() => readSlashCommands(cli));
  useEffect(() => setUsedSlash(readSlashCommands(cli)), [cli]);
  const [slashAt, setSlashAt] = useState<number | null>(null);
  const [slashClosed, setSlashClosed] = useState(false);
  // Not over a recalled prompt: ↑/↓ there walk the history, not the menu.
  const slashMenu = useMemo(
    () => (slashClosed || historyAt.current !== null ? [] : slashSuggestions(draft, cli, usedSlash)),
    [slashClosed, draft, cli, usedSlash],
  );
  const editDraft = (next: string) => {
    setDraft(next);
    setSendError("");
    setSlashAt(null);
    setSlashClosed(false);
  };
  const pickSlash = (suggestion: SlashSuggestion) => {
    editDraft(suggestion.args ? `${suggestion.line} ` : suggestion.line);
    composerRef.current?.focus();
  };
  const forgetSlash = (line: string) => {
    forgetSlashCommand(cli, line);
    setUsedSlash(readSlashCommands(cli));
    setSlashAt(null);
  };

  // The keyboard goes to the composer whenever this pane is the focused one,
  // and back to it when steering lets go.
  useEffect(() => {
    if (focused && visible && !steering) composerRef.current?.focus();
  }, [focused, visible, steering]);

  const send = async () => {
    const current = tabRef.current;
    const text = draft.trim();
    if (!current || !text || sending) return;
    if (current.cmd === "codex" && text === "/status") {
      onStatus();
      setDraft("");
      setSendError("");
      historyAt.current = null;
      return;
    }
    setSending(true);
    setSendError("");
    try {
      // A prefix the CLI's popup completes (`/clea`) runs that command.
      const command = completedSlashCommand(text, cli, usedSlash) ?? text;
      // A new conversation goes in as the Clear key's does, so the window
      // knows of it at once: Codex's hook says so only with the next prompt.
      if (isNewConversationCommand(command)) {
        if (!(await clearAgentTab(scope, current))) {
          // Codex refuses one mid-turn, and says so only in its terminal.
          const busy = agentFamily(agentTabLabel(current)) === "codex" && !!useActivityStore.getState().busyByTab[ptyId];
          setSendError(t(busy ? "terminal.reader.clearBusy" : "terminal.reader.sendFailed"));
          return;
        }
      } else if (subagent && !/^\s*\//u.test(text)) {
        // Words go to the open subagent; a command stays the session's.
        const target = current.scheduleTargetId;
        if (!target) throw new Error("not an agent tab");
        const result = await sendToSubagent({
          rows: () => {
            const term = terminalFor(ptyId);
            return term ? bufferRows(term.buffer.active) : [];
          },
          // Its Esc hands the list's keyboard back: no turn is stopped.
          key: (key) => {
            noteUserInput(ptyId);
            return writePtyInput(ptyId, ENCODER.encode(key)).then(() => true, () => false);
          },
          command: (command) => typeKeys(ptyId, agentInputWrites(command)).then(() => true, () => false),
          type: () => submitScheduledAgentMessage(target, text, { whileBusy: true }).then(() => true, () => false),
        }, subagent);
        if (!result.ok) {
          setSendError(t(SUBAGENT_SEND_FAILED[result.reason]));
          return;
        }
      } else {
        // Shown as sending by the Reader's `onSentPrompt` listener.
        await sendSteeringPrompt(current, text);
      }
      // Offered again by the `/` menu, newest first.
      rememberSlashCommand(cli, command);
      setUsedSlash(readSlashCommands(cli));
      setDraft("");
      historyAt.current = null;
    } catch {
      setSendError(t("terminal.reader.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  /** ↑ on the composer's first line recalls the previous prompt, ↓ on its
   * last line the next one and, past the newest, the draft set aside — the
   * CLI's own input box, so a sent prompt can be edited and sent again. */
  const walkHistory = (e: KeyboardEvent<HTMLTextAreaElement>, step: -1 | 1): boolean => {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return false;
    const box = e.currentTarget;
    if (box.selectionStart !== box.selectionEnd) return false;
    const caret = box.selectionStart;
    if ((step < 0 ? draft.slice(0, caret) : draft.slice(caret)).includes("\n")) return false;
    const at = historyAt.current;
    if (step > 0 && at === null) return false;
    const next = (at ?? history.length) + step;
    if (next < 0) return history.length > 0;
    if (at === null) setAsideDraft.current = draft;
    if (next >= history.length) {
      historyAt.current = null;
      setDraft(setAsideDraft.current);
    } else {
      historyAt.current = next;
      setDraft(history[next]);
    }
    setSendError("");
    return true;
  };

  /** The `/` menu's keys: ↑/↓ move through its rows, Tab — or Enter once
   * the arrows picked a row — fills the box with it, Esc closes it. Enter
   * with no row picked still sends what was typed. */
  const slashKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (slashMenu.length === 0 || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (e.shiftKey) return false;
      const step = e.key === "ArrowUp" ? -1 : 1;
      const from = slashAt ?? (step > 0 ? -1 : slashMenu.length);
      setSlashAt((from + step + slashMenu.length) % slashMenu.length);
      return true;
    }
    if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && slashAt !== null)) {
      pickSlash(slashMenu[slashAt ?? 0]);
      return true;
    }
    if (e.key === "Escape") {
      setSlashClosed(true);
      setSlashAt(null);
      return true;
    }
    return false;
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashKey(e)) {
      e.preventDefault();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && walkHistory(e, e.key === "ArrowUp" ? -1 : 1)) {
      e.preventDefault();
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    }
  };

  if (steering) return null;
  return <>
    <div className="terminal-reader-composer">
      {slashMenu.length > 0 && <ReaderSlashMenu suggestions={slashMenu} at={slashAt} onPick={pickSlash} onForget={forgetSlash} />}
      <textarea
        ref={composerRef}
        value={draft}
        rows={2}
        placeholder={subagent ? t("terminal.reader.subagentPlaceholder") : t("terminal.reader.placeholder")}
        aria-label={subagent ? t("terminal.reader.subagentPlaceholder") : t("terminal.reader.placeholder")}
        onChange={(e) => editDraft(e.target.value)}
        onKeyDown={onComposerKey}
      />
      {historyAt.current !== null && <UntestedTag id="terminal.reader.history" />}
      {subagent && <UntestedTag id="terminal.reader.subagentInput" />}
      <button type="button" className="terminal-reader-send" disabled={!draft.trim() || sending} onClick={() => void send()}>
        {t("terminal.reader.send")}
      </button>
    </div>
    {sendError && <div className="terminal-reader-error" role="alert">{sendError}</div>}
  </>;
}

/**
 * The agent pane's Reader (`lib/agents/agentReader`): the stored conversation
 * as the phone's Focus Reader draws it — prompts on the right, answers on the
 * left as formatted text, slash commands as rules, a day chip where the day
 * changes — with a composer that sends through the prompt box's path
 * (`sendSteeringPrompt`, queued by the CLI while the agent works). Portaled
 * over the terminal, which keeps running and taking the PTY's output
 * underneath; the pane's own mouse handling leaves it alone
 * (`SIGN_IN_CARD_CLASS`). Reads only while the pane is shown.
 *
 * A subagent the agent spawned opens into its own conversation, as on the
 * phone (`mobile-web` `subagents.ts`), from its card in the chat — where it
 * shows when it started, and a ✓ once it has reported back — or from the
 * "Subagents" list over the session, which names them all. A bar above the
 * chat goes back up (Esc in the composer too) and steps between the
 * subagents beside it; while the open one is still at work its own working
 * row names its model. A prompt written there goes to that subagent on a
 * Claude tab (`ReaderComposer`); anywhere else prompts go to the session, and
 * sending one goes back to it.
 */
export function TerminalReaderView({ host, ptyId, scope, tabKey, cwd, visible, focused }: {
  host: HTMLElement;
  /** The pane's PTY: its live screen is read, answers and Stop typed into it. */
  ptyId: string;
  scope: string;
  tabKey: string;
  cwd: string | undefined;
  visible: boolean;
  focused: boolean;
}) {
  const t = useT();
  const tab = useTabsStore((state) => state.tabsByScope[scope]?.find((entry) => entry.key === tabKey));
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [limit, setLimit] = useState(READER_STEP);
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  const [readTick, setReadTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const keepFromBottom = useRef<number | null>(null);
  const version = useRef<string | undefined>();
  const pendingId = useRef(0);
  /** The subagents walked into from the session, outermost first; empty
   * while the session itself is shown. */
  const [subagentPath, setSubagentPath] = useState<readonly SubagentStep[]>([]);
  const [subagentListOpen, setSubagentListOpen] = useState(false);
  const subagentListId = useId();
  const openStep = subagentPath[subagentPath.length - 1];
  const subToken = openStep?.token;
  /** The last read of a subagent's conversation, and whose it is — a read
   * that belongs to another subagent is never drawn under this one's bar. */
  const [subRead, setSubRead] = useState<{ token: string; transcript: SessionTranscript } | null>(null);
  const [subLimit, setSubLimit] = useState(READER_STEP);
  /** Where to scroll once the conversation just gone back up to is drawn. */
  const restoreScroll = useRef<number | null>(null);

  const [live, setLive] = useState<ReaderLive>(NO_LIVE);
  /** When a read last saw the agent at work: a sent prompt waits from then. */
  const workingSeenAt = useRef(0);
  const [answered, setAnswered] = useState("");
  /** What `answered` waits on: a row's answer, or a walk along the tab row. */
  const [answeredBy, setAnsweredBy] = useState<"row" | "step">("row");
  const [picking, setPicking] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusRequest, setStatusRequest] = useState(0);
  const requestStatus = () => { setStatusOpen(true); setStatusRequest((request) => request + 1); };
  const closeStatus = () => setStatusOpen(false);
  /** Steering holds the keyboard (or its prompt box does): a composer on show
   * would take typing that goes to steering, so it stands aside — the Prompt
   * key (I) is how a prompt goes in then. */
  const steering = useKeyboardSteeringStore((state) => state.active || state.handedTo !== null);
  const agentLabel = tab ? agentTabLabel(tab) : "";
  const use24h = useUse24h();
  const modelsByTab = useAgentModelsStore((state) => state.byTab);
  const screenModels = useAgentModelsStore((state) => state.screenByTab);
  const modelTag = tab ? agentTabModelTag(scope, tab, modelsByTab, screenModels) : undefined;
  /** The working row's name for the agent, as the phone's says it: the model
   * the session prints, its first word (`Opus is working…`). */
  const workingModel = (live.status?.model ?? modelTag)?.trim().split(/\s+/)[0];
  const typeIntoPane = useCallback((keys: string[]) => typeKeys(ptyId, keys), [ptyId]);
  /** Esc in the composer, once no status panel or subagent is open: the key
   * the terminal would get — it stops the turn, closes the CLI's own menus —
   * typed into the session, the chat staying shown (the prompt strip's switch
   * is the way back to the terminal). */
  const pressEscape = useCallback(() => { void typeIntoPane(["\u001b"]).catch(() => {}); }, [typeIntoPane]);
  /** The Changes panel beside the chat (the prompt strip's Diffs switch). */
  const changesOpen = useReaderChangesOpen(tab?.cmd ?? "");
  const changesWidth = useAgentReaderStore((state) => state.changesWidth);
  /** The reasoning effort last seen: Claude Code prints it only on its busy
   * row, so the facts row also takes the one its transcript records (every
   * answer, and a `/effort`'s confirmation) and the one just picked there —
   * whichever changed last. */
  const [seenEffort, setSeenEffort] = useState<string | undefined>();
  const workingEffort = live.working?.effort;
  useEffect(() => { if (workingEffort) setSeenEffort(workingEffort); }, [workingEffort]);
  const recordedEffort = transcript?.available ? transcript.effort : undefined;
  useEffect(() => { if (recordedEffort) setSeenEffort(recordedEffort); }, [recordedEffort]);

  // The live screen: read on the pane's output (settled), and on a slow
  // clock for the busy row's timer and a terminal not created yet.
  useEffect(() => {
    if (!visible) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let subscribed: { dispose: () => void } | undefined;
    const read = () => {
      settle = undefined;
      const term = terminalFor(ptyId);
      if (!term) return;
      if (!subscribed) subscribed = term.onWriteParsed(() => { settle ??= setTimeout(read, LIVE_SETTLE_MS); });
      const next = readReaderLive(term.buffer.active, agentLabel, term.cols);
      if (next.working) workingSeenAt.current = Date.now();
      setLive((previous) => (sameReaderLive(previous, next) ? previous : next));
    };
    read();
    const clock = setInterval(read, LIVE_POLL_MS);
    return () => {
      clearInterval(clock);
      if (settle) clearTimeout(settle);
      subscribed?.dispose();
    };
  }, [visible, ptyId, agentLabel]);

  // An answered dialog is clickable again once it is redrawn as something
  // else, or — the keys did not land — after a short wait.
  useEffect(() => {
    if (!answered) return;
    if (live.signature !== answered) {
      setAnswered("");
      return;
    }
    const stuckTimer = setTimeout(() => setAnswered(""), ANSWER_WAIT_MS);
    return () => clearTimeout(stuckTimer);
  }, [answered, live.signature]);

  const answer = (index: number) => {
    const question = live.question;
    const option = question?.options.find((entry) => entry.index === index);
    if (!question || !option || answered) return;
    const keys = answerKeys(question, option);
    if (keys.length === 0) return;
    setAnswered(live.signature);
    setAnsweredBy("row");
    stuck.current = true;
    void typeKeys(ptyId, keys).catch(() => setAnswered(""));
  };
  /** Answers the free-text row with the words typed under it. */
  const answerText = (index: number, text: string) => {
    const question = live.question;
    const option = question?.options.find((entry) => entry.index === index);
    if (!question || !option || answered) return;
    const keys = answerTextKeys(question, option, text);
    if (keys.length === 0) return;
    setAnswered(live.signature);
    setAnsweredBy("row");
    stuck.current = true;
    void typeKeys(ptyId, keys).catch(() => setAnswered(""));
  };
  const step = (from: number, to: number) => {
    const keys = tabStepKeys(live, from, to);
    if (!live.question || keys.length === 0 || answered) return;
    setAnswered(live.signature);
    setAnsweredBy("step");
    void typeKeys(ptyId, keys).catch(() => setAnswered(""));
  };
  const stop = () => void typeKeys(ptyId, [STOP_KEY]).catch(() => {});
  const shownLive = picking ? NO_LIVE : live;

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const sessionId = tab?.sessionId;
  // A new session (a restart, a `/clear` the hook followed) is a new chat,
  // with subagents of its own.
  useEffect(() => {
    version.current = undefined;
    setTranscript(null);
    setSubagentPath([]);
    setSubagentListOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let busy = false;
    const read = async () => {
      const current = tabRef.current;
      if (busy || !current) return;
      const args = readerRequest(scope, current, cwd, version.current, limit);
      if (!args) {
        setTranscript({ available: false, reason: "no_session", entries: [], truncated: false });
        return;
      }
      busy = true;
      const next = await invoke<SessionTranscript>("agent_tab_transcript", args)
        .catch((): SessionTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
      busy = false;
      if (cancelled) return;
      if (!next.unchanged) version.current = next.version;
      setTranscript((previous) => mergeTranscript(previous, next));
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, scope, cwd, limit, sessionId, readTick]);

  // The open subagent's conversation, read as the session is: at once, then
  // every POLL_MS while shown — a subagent still at work keeps writing.
  useEffect(() => {
    if (!visible || !subToken) return;
    let cancelled = false;
    let busy = false;
    let subVersion: string | undefined;
    const read = async () => {
      const current = tabRef.current;
      if (busy || !current) return;
      const args = readerRequest(scope, current, cwd, subVersion, subLimit, subToken);
      if (!args) return;
      busy = true;
      const next = await invoke<SessionTranscript>("agent_tab_transcript", args)
        .catch((): SessionTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
      busy = false;
      if (cancelled) return;
      if (!next.unchanged) subVersion = next.version;
      setSubRead((previous) => ({
        token: subToken,
        transcript: mergeTranscript(previous?.token === subToken ? previous.transcript : null, next),
      }));
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, scope, cwd, subToken, subLimit, sessionId]);

  const storedEntries = useMemo(() => (transcript?.available ? transcript.entries : []), [transcript]);
  // A clear (`agentClearUndo`) empties the chat at once, before its card
  // offers it back: what is read now is the cleared conversation, every record
  // of it — no prompt has gone into the new one while the card stands. Codex
  // reads that session until its first prompt, so the mark outlives the card.
  const clearOffered = useAgentClearUndoStore((state) => !!state.cleared[ptyId]);
  const clearedAt = useAgentClearUndoStore((state) => state.marks[ptyId]);
  useEffect(() => {
    if (clearOffered && clearedAt === undefined && transcript) {
      useAgentClearUndoStore.getState().setMark(ptyId, clearMark(storedEntries));
    }
  }, [clearOffered, clearedAt, transcript, storedEntries, ptyId]);
  /** The new chat's records while the cleared one is still what is read. */
  const sinceClear = useMemo(() => afterClear(storedEntries, clearedAt ?? null), [storedEntries, clearedAt]);
  const entries = sinceClear ?? storedEntries;
  /** The open subagent's conversation, once read. */
  const subTranscript = subRead && subRead.token === subToken ? subRead.transcript : null;
  /** The conversation on screen — the session's, or the open subagent's —
   * which is where a card clicked in it was opened from. */
  const shownTranscript = openStep ? subTranscript : transcript;
  const levelEntries = useMemo(
    () => (openStep ? (subTranscript?.available ? subTranscript.entries : []) : entries),
    [openStep, subTranscript, entries],
  );
  /** Earlier turns to read in: none of the cleared conversation's. */
  const levelTruncated = !!shownTranscript?.available && shownTranscript.truncated && !(sinceClear && !openStep);
  const levelEntriesRef = useRef(levelEntries);
  levelEntriesRef.current = levelEntries;
  const turns = useMemo(() => transcriptTurns(levelEntries), [levelEntries]);
  const openers = useMemo(() => dayOpeners(turns.map((turn) => turn.stamp)), [turns]);
  const sessionAgents = useMemo(() => entries.filter((entry) => entry.kind === "agent"), [entries]);
  /** What ↑ in the composer walks: the session's prompts, as the CLI's box. */
  const history = useMemo(() => composerHistory(entries, pending.map((item) => item.text)), [entries, pending]);

  // Every prompt sent to this tab — this composer's or steering's prompt box —
  // shows as sending at once, the agent idle or at work (the CLI queues it).
  const sendTarget = tab?.scheduleTargetId;
  useEffect(() => {
    if (!sendTarget) return;
    return onSentPrompt(sendTarget, ({ text, sentAt }) => {
      pendingId.current += 1;
      const id = pendingId.current;
      setPending((items) => [...items, { id, text, sentAt }]);
      stuck.current = true;
      setReadTick((tick) => tick + 1);
      // It went to the session, never to a subagent: back to where it lands.
      setSubagentPath([]);
    });
  }, [sendTarget]);

  // A sent prompt shows until the transcript records it (by its words, at or
  // after the moment it went) or it has waited long enough to be let go.
  useEffect(() => {
    if (pending.length === 0) return;
    const now = Date.now();
    const waitingSince = (item: PendingPrompt) => Math.max(item.sentAt, workingSeenAt.current);
    // A bare `/prefix` is recorded as the command the CLI's popup completed
    // it to (`/clea` → `/clear`).
    const recorded = (item: PendingPrompt) => {
      const sent = item.text.trim();
      const prefix = /^\/[\w-]+$/u.test(sent) ? sent : null;
      return entries.some((entry) =>
        entry.kind === "prompt"
        && (entry.text.trim() === sent || (!!prefix && !!slashCommand(entry.text)?.name.startsWith(prefix)))
        && (!entry.at || Date.parse(entry.at) >= item.sentAt - 5_000));
    };
    const left = pending.filter((item) => now - waitingSince(item) < PENDING_MS && !recorded(item));
    if (left.length !== pending.length) {
      setPending(left);
      return;
    }
    // Nothing new may come in to look again: let the first one go on time.
    const due = Math.min(...left.map(waitingSince)) + PENDING_MS - now;
    const timer = setTimeout(() => setPending((items) => [...items]), due);
    return () => clearTimeout(timer);
  }, [entries, pending]);

  /** The prompt the answer at the top of the chat belongs to — the last one
   * that starts above the scroll position — while its bubble is scrolled off
   * the top, pinned there as on the phone's Focus Reader; empty while any
   * prompt bubble is in view (that one, or a newer one further down). Read
   * off the chat as drawn (`data-prompt`). */
  const [pinnedPrompt, setPinnedPrompt] = useState("");
  const pinnedPromptEl = useRef<HTMLElement | null>(null);
  const checkPinnedPrompt = useCallback(() => {
    const list = listRef.current;
    const prompts = list?.querySelectorAll<HTMLElement>("[data-prompt]") ?? [];
    const view = list?.getBoundingClientRect();
    const top = view?.top ?? 0;
    const bottom = view?.bottom ?? 0;
    let owner: HTMLElement | null = null;
    for (let i = prompts.length - 1; i >= 0; i--) {
      const box = prompts[i].getBoundingClientRect();
      // A bubble with no height is not laid out (a hidden pane), not scrolled
      // away; one wholly below the view is not read yet.
      if (box.height === 0 || box.top >= bottom) continue;
      owner = box.bottom <= top ? prompts[i] : null;
      break;
    }
    pinnedPromptEl.current = owner;
    setPinnedPrompt((owner?.dataset.prompt ?? "").trim());
  }, []);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    stuck.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    checkPinnedPrompt();
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (restoreScroll.current !== null) {
      // Back up a level: where it was scrolled, once it is drawn again.
      if (!shownTranscript) return;
      list.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    } else if (keepFromBottom.current !== null) {
      // Earlier turns came in above: the ones being read stay where they were.
      list.scrollTop = list.scrollHeight - list.clientHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (stuck.current) {
      list.scrollTop = list.scrollHeight;
    }
    checkPinnedPrompt();
  }, [turns, pending, live, shownTranscript, visible, checkPinnedPrompt]);

  const showEarlier = () => {
    const list = listRef.current;
    if (list) keepFromBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (openStep) {
      setSubLimit((current) => current + READER_STEP);
      return;
    }
    version.current = undefined;
    setLimit((current) => current + READER_STEP);
  };

  /** Opens a subagent from the conversation on screen, which it goes back up
   * to where it was scrolled. One opened from the list keeps the list open
   * for the way back. Its conversation opens on its newest turn. */
  const openAgent = useCallback((turn: SubagentPick, fromList = false) => {
    const token = turn.subagent;
    if (!token) return;
    const top = listRef.current?.scrollTop ?? 0;
    setSubagentPath((path) => openSubagent(path, { token, task: turn.text, role: turn.role }, levelEntriesRef.current, top));
    if (!fromList) setSubagentListOpen(false);
    setSubLimit(READER_STEP);
    keepFromBottom.current = null;
    stuck.current = true;
  }, []);
  const subagentUp = () => {
    if (!openStep) return;
    restoreScroll.current = openStep.scrollTop;
    keepFromBottom.current = null;
    stuck.current = false;
    setSubLimit(READER_STEP);
    setSubagentPath((path) => path.slice(0, -1));
  };
  const subagentSibling = (delta: number) => {
    keepFromBottom.current = null;
    stuck.current = true;
    setSubLimit(READER_STEP);
    setSubagentPath((path) => stepSibling(path, delta));
  };

  const now = new Date();
  const dayLabels = { today: t("mobile.transcript.today"), yesterday: t("mobile.transcript.yesterday") };
  const cutLabel = t("terminal.reader.cut");
  const planLabel = t("mobile.transcript.plan");
  const subagentLabel = t("terminal.reader.subagent");
  const empty = transcript?.available && turns.length === 0 && pending.length === 0 && !live.question && !live.working;
  /** Where the open subagent stands among its siblings, and the conversation
   * the bar goes back up to. */
  const position = openStep ? siblingPosition(openStep) : { index: -1, count: 0 };
  const backLabel = t("mobile.subagent.back", {
    name: subagentPath.length > 1 ? subagentPath[subagentPath.length - 2].task : t("mobile.subagent.main"),
  });
  // Only when those earlier turns hold a subagent: a long session that never
  // spawned one would otherwise show "Subagents (0+)".
  const moreEarlier = !!transcript?.available && transcript.truncated && !!transcript.agentsEarlier && !sinceClear;
  /** The open subagent at work — it has not reported back, and the session
   * is at work or it runs in the background — and the model its own
   * conversation names. */
  const subagentWorking = openSubagentRunning(subagentPath, entries, !!live.working);
  const subagentModel = workingModelName(subTranscript?.model);
  /** What the subagent's working row says beside its name, as the phone's
   * does: how long since it was spawned (its entry's stamp, else its own
   * first record's) and the tokens its newest request carried. */
  const subagentStart = openStep?.at ?? (subTranscript?.available && !subTranscript.truncated ? subTranscript.entries[0]?.at : undefined);
  const subagentTimed = subagentWorking && !!subagentStart;
  const [subagentNow, setSubagentNow] = useState(() => Date.now());
  // The elapsed time counts on by the second while the row is up.
  useEffect(() => {
    if (!subagentTimed || !visible) return;
    setSubagentNow(Date.now());
    const timer = window.setInterval(() => setSubagentNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subagentTimed, visible]);
  const subagentTokens = compactTokens(subTranscript?.tokens);
  const subagentFacts = [
    workingElapsed(subagentStart, subagentNow),
    subagentTokens && t("terminal.reader.workingTokens", { count: subagentTokens }),
  ].filter(Boolean).join(" · ");
  /** Subagents sent to the background still at work once the session's own
   * turn is over: the main conversation's working row stands for them. */
  const backgroundAtWork = openStep || live.working ? 0 : sessionAgents.filter((entry) => subagentAtWork(entry, false)).length;
  /** The shells the shown conversation runs, beside its working row. One it
   * waits on shows only while that row does — a call the CLI never answered
   * (killed mid-command) is not a shell at work; a background one shows while
   * the backend sees it still running, the agent at work or not. */
  const shellsWaited = openStep ? subagentWorking : !!live.working;
  const runningShells = shownTranscript?.available
    ? (shownTranscript.shells ?? []).filter((shell) => shell.background || shellsWaited)
    : [];

  return createPortal(<>
    <div
      className={`terminal-reader ${SIGN_IN_CARD_CLASS}${changesOpen && tab ? " with-changes" : ""}`}
      role="region"
      aria-label={t("terminal.reader.title")}
      style={changesOpen && tab ? changesWidthStyle(changesWidth) : undefined}
    >
      {openStep ? (
        <nav className="terminal-reader-subagent-bar" aria-label={subagentLabel}>
          <button type="button" className="terminal-reader-subagent-nav" onClick={subagentUp} aria-label={backLabel} title={`${backLabel} (Esc)`}>‹</button>
          <div className="terminal-reader-subagent-title">
            <small>{openStep.role ?? subagentLabel} <UntestedTag id="terminal.reader.subagents" /></small>
            <strong title={openStep.task}>{openStep.task || openStep.role}</strong>
          </div>
          {position.count > 1 && (
            <div className="terminal-reader-subagent-steps">
              <button type="button" className="terminal-reader-subagent-nav" disabled={position.index <= 0} onClick={() => subagentSibling(-1)} aria-label={t("mobile.subagent.previous")} title={t("mobile.subagent.previous")}>‹</button>
              <span>{t("mobile.subagent.position", { index: position.index + 1, count: position.count })}</span>
              <button type="button" className="terminal-reader-subagent-nav" disabled={position.index >= position.count - 1} onClick={() => subagentSibling(1)} aria-label={t("mobile.subagent.next")} title={t("mobile.subagent.next")}>›</button>
            </div>
          )}
        </nav>
      ) : transcript?.available && (sessionAgents.length > 0 || moreEarlier) && (
        // Every subagent of the session by name — "+" while earlier turns may
        // hold more, which the list's last row reads in.
        <nav className="terminal-reader-subagent-index" aria-label={t("mobile.subagent.indexRegion")}>
          <button
            type="button"
            className="terminal-reader-subagent-toggle"
            aria-expanded={subagentListOpen}
            aria-controls={subagentListId}
            onClick={() => setSubagentListOpen((open) => !open)}
          >
            <span>{t("mobile.subagent.index", { count: `${sessionAgents.length}${moreEarlier ? "+" : ""}` })}</span>
            <UntestedTag id="terminal.reader.subagents" />
            <span className={subagentListOpen ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
          </button>
          {subagentListOpen && (
            <div id={subagentListId} className="terminal-reader-subagent-list">
              {sessionAgents.map((entry, index) => (
                <button type="button" key={`${entry.at ?? ""}:${index}`} disabled={!entry.subagent} onClick={() => openAgent(entry, true)}>
                  <small>
                    {entry.role ?? subagentLabel}
                    {subagentAtWork(entry, !!live.working) && (
                      <span className="terminal-reader-working-dots" role="img" aria-label={t("terminal.reader.working")}><i /><i /><i /></span>
                    )}
                  </small>
                  <span>{entry.text}{entry.cut && "…"}</span>
                </button>
              ))}
              {moreEarlier && (
                <button type="button" className="terminal-reader-subagent-earlier" onClick={showEarlier}>
                  {t("mobile.subagent.earlier")}
                </button>
              )}
            </div>
          )}
        </nav>
      )}
      <div className="terminal-reader-stream">
        <div ref={listRef} className="terminal-reader-list" onScroll={onScroll}>
          {levelTruncated && (
            <button type="button" className="terminal-reader-earlier" onClick={showEarlier}>
              {t("terminal.reader.earlier")}
            </button>
          )}
          {openStep ? (
            !subTranscript ? <div className="terminal-reader-empty">{t("mobile.subagent.loading")}</div>
            : !subTranscript.available ? (
              <div className="terminal-reader-empty">
                <strong>{t("mobile.subagent.missing")}</strong>
                <p>{t("mobile.subagent.missingHint")}</p>
                <button type="button" className="terminal-reader-earlier" onClick={subagentUp}>{backLabel}</button>
              </div>
            )
            : turns.length === 0 && <div className="terminal-reader-empty">{t("mobile.subagent.empty")}</div>
          ) : <>
            {!transcript?.available && (
              <div className="terminal-reader-empty">{t(readerReasonKey(transcript))}</div>
            )}
            {empty && <div className="terminal-reader-empty">{t("terminal.reader.empty")}</div>}
          </>}
          {turns.map((turn, index) => {
            const moment = chatMoment(turn.stamp);
            return (
              <Fragment key={turn.key}>
                {openers.has(index) && moment && (
                  <div className="terminal-reader-day" role="separator">
                    <span>{chatDayLabel(moment, now, dayLabels)}</span>
                  </div>
                )}
                <Turn turn={turn} cutLabel={cutLabel} planLabel={planLabel} agentLabel={subagentLabel} use24h={use24h} onOpenAgent={openAgent} />
              </Fragment>
            );
          })}
          {!openStep && pending.map((item) => (
            <div key={item.id} className="terminal-reader-turn user pending" data-prompt={item.text}>
              <PromptText text={item.text} />
              {/* Queued behind a busy turn: Esc stops it and Claude sends the
                  queue at once. */}
              {live.working && isClaudeCommand(tab?.cmd) && (
                <small className="terminal-reader-pending-hint">
                  {t("terminal.reader.sendNowHint")}
                  <UntestedTag id="terminal.reader.sendNowHint" />
                </small>
              )}
              <small className="terminal-reader-time">{t("terminal.reader.sending")}</small>
            </div>
          ))}
          <LiveQuestion
            live={shownLive}
            answered={!!answered && answered === live.signature && answeredBy === "row"}
            busy={!!answered && answered === live.signature}
            onAnswer={answer}
            onType={answerText}
            onStep={step}
          />
          {openStep ? subagentWorking && (
            <div className="terminal-reader-working" role="status">
              <span className="terminal-reader-working-dots" aria-hidden="true"><i /><i /><i /></span>
              <span>{subagentModel ? t("terminal.reader.workingModel", { model: subagentModel }) : t("terminal.reader.working")}</span>
              {subagentFacts && <small>{subagentFacts} <UntestedTag id="terminal.reader.subagentWorkingFacts" /></small>}
              <UntestedTag id="terminal.reader.subagentWorking" />
              {/* Esc stops the session's turn: nothing to stop while only a
                  background subagent works on. */}
              {live.working && (
                <button type="button" className="terminal-reader-stop" onClick={stop} title={t("terminal.reader.stopHint")}>
                  {t("terminal.reader.stop")}
                </button>
              )}
            </div>
          ) : live.working && (
            <div className="terminal-reader-working" role="status">
              <span className="terminal-reader-working-dots" aria-hidden="true"><i /><i /><i /></span>
              <span>{workingModel ? t("terminal.reader.workingModel", { model: workingModel }) : t("terminal.reader.working")}</span>
              {(live.working.elapsed || live.working.tokens) && (
                <small>{[live.working.elapsed, live.working.tokens && t("terminal.reader.workingTokens", { count: live.working.tokens })].filter(Boolean).join(" · ")}</small>
              )}
              <button type="button" className="terminal-reader-stop" onClick={stop} title={t("terminal.reader.stopHint")}>
                {t("terminal.reader.stop")}
              </button>
            </div>
          )}
          {backgroundAtWork > 0 && (
            <div className="terminal-reader-working" role="status">
              <span className="terminal-reader-working-dots" aria-hidden="true"><i /><i /><i /></span>
              <span>{t("terminal.reader.backgroundSubagents", { count: backgroundAtWork })}</span>
              <UntestedTag id="terminal.reader.backgroundSubagents" />
            </div>
          )}
          {runningShells.map((shell, index) => (
            // Keyed by the call, not its place, so one that is open stays
            // open when a shell before it returns.
            <RunningShellLine key={`${shell.at ?? ""}:${shell.command}:${runningShells.slice(0, index).filter((other) => other.at === shell.at && other.command === shell.command).length}`} shell={shell} />
          ))}
        </div>
        {!openStep && pinnedPrompt && (
          <button
            type="button"
            className="terminal-reader-turn user terminal-reader-pinned-prompt"
            aria-label={t("mobile.focus.lastPrompt")}
            title={t("mobile.focus.lastPrompt")}
            onClick={() => pinnedPromptEl.current?.scrollIntoView({ block: "start", behavior: "smooth" })}
          >
            <span className="terminal-reader-pinned-prompt-text">{pinnedPrompt}</span>
            <UntestedTag id="terminal.reader.pinnedPrompt" />
          </button>
        )}
      </div>
      {tab && (
        <TerminalReaderFacts
          tab={tab}
          ptyId={ptyId}
          agentLabel={agentLabel}
          live={live}
          modelTag={modelTag}
          usage={transcript?.available && !sinceClear ? transcript.usage : undefined}
          visible={visible}
          path={tab.cwd || cwd}
          effort={seenEffort}
          onEffortPicked={setSeenEffort}
          typeKeys={typeIntoPane}
          onPicking={setPicking}
          statusOpen={statusOpen}
          statusRequest={statusRequest}
          onStatusRequest={requestStatus}
          onStatusClose={closeStatus}
        />
      )}
      <ReaderComposer
        scope={scope}
        tabKey={tabKey}
        tabRef={tabRef}
        ptyId={ptyId}
        cli={agentFamily(agentLabel)}
        subagent={openStep && isClaudeCommand(tab?.cmd) ? openStep : undefined}
        history={history}
        focused={focused}
        visible={visible}
        steering={steering}
        onEscape={statusOpen ? closeStatus : openStep ? subagentUp : pressEscape}
        onStatus={requestStatus}
      />
    </div>
    {changesOpen && tab && (
      <TerminalReaderChanges
        scope={scope}
        tab={tab}
        cwd={cwd}
        visible={visible}
        subagent={subToken}
        subagentTitle={openStep ? openStep.task || openStep.role : undefined}
        onClose={() => useAgentReaderStore.getState().setChanges(tab.cmd, false)}
      />
    )}
  </>, host);
}
