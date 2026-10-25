import { Fragment, createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import {
  READER_STEP,
  composerHistory,
  mergeTranscript,
  readerAgent,
  readerReasonKey,
  readerRequest,
  type SessionTranscript,
} from "../../lib/agents/agentReader";
import { watchedReads } from "../../lib/agents/transcriptWatch";
import { NO_LIVE, STOP_KEY, answerKeys, answerTextKeys, freeTextRow, readReaderLive, sameReaderLive, tabStepKeys, UNNUMBERED, type ReaderLive } from "../../lib/agents/readerLive";
import { isAiOffRefusal } from "../../lib/aiSwitch";
import { forgetSentPrompts, onSentPrompt, useSentPrompts, type SentPrompt } from "../../lib/agents/sentPrompts";
import { readerDraft, setReaderDraft } from "../../lib/agents/readerDrafts";
import { DraftUndo, caretAfterSwap } from "../../lib/agents/draftUndo";
import { actionMatches } from "../../lib/shortcuts/shortcuts";
import { useShortcutOverrides } from "../../lib/shortcuts/shortcutHint";
import { clearAgentTab, sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import { isNewConversationCommand } from "../../lib/agents/typedClear";
import { SessionPickerOpenError, submitScheduledAgentMessage } from "../../lib/agents/scheduledAgentInput";
import { agentFamily, agentInputWrites } from "../../../shared/agentComposer";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import { isClaudeCommand } from "../../lib/terminal/terminalControl";
import { terminalFor, watchTerminal } from "../../lib/terminal/terminalRegistry";
import { noteUserInput, useActivityStore } from "../../stores/activity";
import { typePaneKeys } from "../../lib/agents/paneKeys";
import { noteInputFrom } from "../../lib/agents/inputFrom";
import { useUse24h } from "../../lib/timeFormat";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { hostTabCwd, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { usePaneTab } from "../tabs/paneTabContext";
import { withAssistantPromptTarget } from "../../lib/assistant";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { TerminalReaderFacts } from "./TerminalReaderFacts";
import { STATUS_AGENTS, type ReaderPanel } from "./TerminalReaderStatus";
import { CONTEXT_AGENTS } from "./TerminalReaderContext";
import { TerminalReaderChanges } from "./TerminalReaderChanges";
import { ReaderToolbarNavigation, type ReaderToolbarFile } from "./ReaderToolbarNavigation";
import { chatWhen, resumeChatWithToast } from "./TerminalReaderChats";
import { chatPosition, stepChat, useReaderChatsStore } from "../../lib/agents/agentChats";
import { UntestedTag } from "../common/UntestedTag";
import { ReaderAnswerAlbum, ReaderAnswerFilesContext, useReaderAnswerFiles } from "./ReaderAnswerFiles";
import { ReaderInboxContext, ReaderPromptBody, useDrawsInbox, useReaderInbox } from "./ReaderInbox";
import { PathLinkHint, type PathLinkHover } from "./PathLinkHint";
import { PATH_LINK_ATTR, findPathCandidates, isLinkable, linkPathsInHtml, openPathLink, resolvePathCandidates, unknownPaths } from "../../lib/terminal/pathLinks";
import { usePathLinkContext } from "../../lib/terminal/usePathLinkContext";
import { relativePathWithin } from "../../lib/paths";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import { TabStatusMark } from "../tabs/TabLocalityBadges";
import { answerHtml, promptHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { chatDayLabel, chatMoment, chatTime, dayOpeners } from "../../../mobile-web/src/terminal/chatTimes";
import { bufferRows, sendToSubagent, type SubagentSendFailure } from "../../../mobile-web/src/terminal/subagentInput";
import { pullQueuedPrompts, queuedHintShown } from "../../../mobile-web/src/terminal/queuePull";
import { completedSlashCommand, draftPrefix, draftPrefixes, forgetSlashCommand, readSlashCommands, rememberSlashCommand, slashSuggestions, toggleDraftPrefix, type SlashSuggestion } from "../../../mobile-web/src/slashCommands";
import { COMMIT_PROMPTS, type CommitChoice } from "../../../mobile-web/src/terminal/commitPrompts";
import { ReaderSlashMenu } from "./ReaderSlashMenu";
import { ReaderComposerChips } from "./ReaderComposerChips";
import { useReaderVoice } from "./ReaderVoice";
import { useReaderReadAloud } from "./ReaderReadAloud";
import { useAgentTurn } from "../../lib/voice/agentTurn";
import { useExperimental } from "../../lib/experimental";
import { useSettingsStore } from "../../stores/settings";
import { questionSpeech, voicePick } from "../../../mobile-web/src/handsFree";
import { sanitizeVoiceTranscript, spokenSend } from "../../../shared/voice";
import { insertIntoReader, onReaderInsert, pasteClipboardImage } from "../../lib/terminal/terminalDrop";
import { compactTokens, inWorkflow, openSubagent, openSubagentRunning, siblingPosition, stepSibling, subagentAtWork, workingElapsed, workingModelName, type SubagentStep } from "../../../mobile-web/src/terminal/subagents";
import { commandArgsInline, slashCommand, transcriptTurns, type TranscriptTurn } from "../../../mobile-web/src/terminal/transcriptTurns";
import { afterClear, clearMark } from "../../../mobile-web/src/terminal/clearedSession";
import { recordsPrompt } from "../../../mobile-web/src/terminal/pendingPrompts";
import type { AskedQuestion, RunningShell, TranscriptEntry } from "../../../mobile-web/src/api";
import type { UntestedId } from "../../lib/untested";

/** How long a sent prompt shows as sending while the transcript has not
 * recorded it yet — counted from the send, or from the last moment the agent
 * was seen working (a prompt queued behind a long turn is recorded only once
 * the CLI takes it up). */
const PENDING_MS = 60_000;
/** How soon after the pane's output the live screen is read again, and how
 * often regardless (the busy row's timer, a pane not created yet). */
const LIVE_SETTLE_MS = 250;
const LIVE_POLL_MS = 1500;
/** How long an answered dialog stays unclickable while the session redraws. */
const ANSWER_WAIT_MS = 3000;
/** How long the dialog an answer brought up stays unclickable. A CLI asks
 * its next question at once and in the same place — Codex's "Hooks need
 * review" under its folder question, both with their first row first — so the
 * second click of a double-click, meant for the answered row, took the new
 * dialog's first row (`Review hooks`) unseen. */
const NEXT_DIALOG_HOLD_MS = 600;
/** How long the screen must show something the Reader cannot read
 * (`ReaderLive.stray`) before the chat points at the terminal: a CLI starting
 * up, a picker answered from the composer or a redraw passes through such a
 * screen for a moment. */
const STRAY_MS = 3000;
const ENCODER = new TextEncoder();


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

/** The reader's answer rows that can be picked right now. */
const OPTION_BUTTONS = "button.terminal-reader-option:not(:disabled)";

/** Moves the keyboard from the composer onto the open question's rows: the
 * row the CLI has highlighted, else the first. False when none can be picked. */
function focusQuestionOption(from: Element): boolean {
  const root = from.closest(".terminal-reader");
  const rows = root ? Array.from(root.querySelectorAll<HTMLButtonElement>(OPTION_BUTTONS)) : [];
  const row = rows.find((candidate) => candidate.classList.contains("current")) ?? rows[0];
  row?.focus();
  return !!row;
}

/** ↑/↓ (Home/End) walk focus over the answer rows, Enter or Space picks the
 * focused one; ↑ off the first row goes back to the composer. */
function walkQuestionOptions(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  // The free-text row's field keeps its own caret keys.
  if (!(event.target instanceof HTMLButtonElement)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(OPTION_BUTTONS));
  const at = rows.indexOf(event.target);
  if (at < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0
    : event.key === "End" ? rows.length - 1
    : at + (event.key === "ArrowUp" ? -1 : 1);
  if (next < 0) {
    event.currentTarget.closest(".terminal-reader")?.querySelector<HTMLTextAreaElement>(".terminal-reader-composer textarea")?.focus();
    return;
  }
  rows[Math.min(next, rows.length - 1)]?.focus();
}

/** The choice the session waits on, as buttons: what it was drawn onto (a
 * permission prompt's command or diff), an agent question's headers as chips,
 * its question, then one row per option. A click sends the arrow keys and
 * Enter a walked highlight would. A question that asks several has its
 * headers as steps: ←/→ and a click on one walk the dialog's tabs, so an
 * answer can be changed before Submit. Claude Code's "Type something." row
 * opens a field under it instead: its answer is words, sent as the phone's
 * are (`answerTextKeys`). */
function LiveQuestion({ live, answered, failure, busy, onAnswer, onType, onStep }: {
  live: ReaderLive;
  /** A row was clicked and the session has not redrawn yet. */
  answered: boolean;
  /** The last answer's keys never reached the session, and why. */
  failure: "aiOff" | "write" | null;
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
      <small className="terminal-reader-question-head">{t("terminal.reader.question")} <UntestedTag id="terminal.reader.questionKeys" /></small>
      {question.source === "opencode" && <UntestedTag id="agents.opencode.questions" />}
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
      <div className="terminal-reader-options" onKeyDown={walkQuestionOptions}>
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
                <span className="terminal-reader-option-number">{option.number !== UNNUMBERED && option.number}</span>
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
      {question.options.some((option) => option.keys) && <UntestedTag id="terminal.reader.codexHooksPage" />}
      {!!question.hidden && <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small>}
      {answered && <small className="terminal-reader-question-more" role="status">{t("terminal.reader.answering")}</small>}
      {failure && <small className="terminal-reader-question-more" role="alert">{t(failure === "aiOff" ? "terminal.reader.answerAiOff" : "terminal.reader.answerFailed")}</small>}
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

/** The chat's path links (`lib/terminal/pathLinks`): every path-shaped word
 * the shown conversation holds, looked up once — the file it opens, or null.
 * A turn is drawn only once its words are in here (see the reads), and a word
 * once looked up keeps its answer, so a shown bubble never gains or loses a
 * link afterwards. */
const PathLinksContext = createContext<ReadonlyMap<string, FileEntry | null>>(new Map());

/** One answer as formatted text (`answerHtml`, the phone's: formatting only,
 * nothing in it opens or loads), its file paths made links and the pictures
 * and PDFs among them drawn under it (`ReaderAnswerFiles`). Memoized on the
 * text, so a read that brings a new turn does not re-render every answer
 * above it. */
const AnswerText = memo(function AnswerText({ text }: { text: string }) {
  const links = useContext(PathLinksContext);
  const html = useMemo(() => linkPathsInHtml(answerHtml(text), links), [text, links]);
  return (
    <>
      <div className="markdown-body terminal-reader-md" dangerouslySetInnerHTML={{ __html: html }} />
      <ReaderAnswerAlbum text={text} />
    </>
  );
});

/** A prompt, formatted the same way (`promptHtml`: an answer's formatting,
 * its single line breaks kept) — a subagent's brief reads as written. A
 * prompt still sending is drawn `unlinked`: its paths are looked up only with
 * the record, and its bubble must not restyle when that arrives. */
const PromptText = memo(function PromptText({ text, unlinked = false }: { text: string; unlinked?: boolean }) {
  const links = useContext(PathLinksContext);
  const html = useMemo(() => (unlinked ? promptHtml(text) : linkPathsInHtml(promptHtml(text), links)), [text, links, unlinked]);
  return <div className="markdown-body terminal-reader-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** What a subagent's card or list row opens: its handle and what it says. */
type SubagentPick = Pick<TranscriptTurn, "subagent" | "text" | "role" | "workflow">;

function Turn({ turn, cutLabel, planLabel, agentLabel, use24h, onOpenAgent }: {
  turn: TranscriptTurn;
  cutLabel: string;
  planLabel: string;
  agentLabel: string;
  use24h: boolean;
  onOpenAgent: (turn: SubagentPick) => void;
}) {
  const withFiles = useDrawsInbox(turn.text);
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
    return (
      <div className={withFiles ? "terminal-reader-turn user with-files" : "terminal-reader-turn user"} data-prompt={turn.text}>
        <ReaderPromptBody text={turn.text}>{(words) => <PromptText text={words} />}</ReaderPromptBody>
        {cut}{time}
      </div>
    );
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
 * walk `history`; Esc is `onEscape`. ↑ in the empty box while Claude shows
 * prompts sent from here as queued takes them back out of its queue to be
 * edited (`queuePull`), and `onPulled` drops their bubbles; `pullRef` is the
 * same for the sending bubble's Cancel and edit.
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

/** What the Reader hands its composer for voice (docs/desktop_voice_plan.md
 * step 4): read-aloud lives with the conversation, the mic with the composer. */
interface ReaderVoiceLoop {
  /** The hands-free loop is on: the experimental flag and its chip. */
  handsFree: boolean;
  /** Read-aloud owes or is saying an answer (`useReaderReadAloud`). */
  reading: boolean;
  /** The newest answer's key in the conversation. */
  lastAnswer: string | null;
  /** Answers the question on screen when an utterance picks one of its rows. */
  pick: (utterance: string) => boolean;
  stopReading: () => void;
  /** Why read-aloud could not speak, if it could not. */
  readProblem: TranslationKey | null;
  /** The mic listens (or not); `speakOver`: read-aloud may speak over it. */
  onListening: (listening: boolean, speakOver: boolean) => void;
  /** The read-aloud and hands-free chips, for the chip row's end. */
  chips: ReactNode;
}

function ReaderComposer({ scope, tabKey, tabRef, ptyId, cli, subagent, history, queued, focused, visible, acceptInserts = visible, onReveal, steering, questionOpen, suggestion, chipSlot, actionSlot, voiceLoop, onEscape, onStatus, onPulled, pullRef }: {
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
  /** Prompts sent to the session while Claude works, still drawn as sending. */
  queued: readonly SentPrompt[];
  focused: boolean;
  visible: boolean;
  acceptInserts?: boolean;
  onReveal?: () => void;
  steering: boolean;
  /** A dialog waits on an answer: ↑/↓ in an empty composer walk its rows. */
  questionOpen: boolean;
  /** Claude's own suggestion for the next message, read off its empty box. */
  suggestion: string;
  /** The facts row's end, where the chip row goes; over the text box without it. */
  chipSlot: HTMLElement | null;
  actionSlot?: HTMLElement | null;
  voiceLoop: ReaderVoiceLoop;
  onEscape: () => void;
  onStatus: (panel: ReaderPanel) => void;
  /** These of `queued` left Claude's queue for the composer. */
  onPulled: (ids: number[]) => void;
  /** Set to what takes `queued` back into the box, whatever it holds. */
  pullRef: MutableRefObject<(() => void) | null>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => readerDraft(scope, tabKey));
  useEffect(() => setReaderDraft(scope, tabKey, draft), [scope, tabKey, draft]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const pulling = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  /** Ctrl+Z / Ctrl+Shift+Z (`editorUndo`/`editorRedo`): the composer's own
   * history, since React setting the value loses the box's. `draftRef` is
   * the text a change replaces; `caretAt` where an undo puts the caret. */
  const undo = useRef(new DraftUndo());
  const draftRef = useRef(draft);
  const caretAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    draftRef.current = draft;
    if (caretAt.current !== null) composerRef.current?.setSelectionRange(caretAt.current, caretAt.current);
    caretAt.current = null;
  }, [draft]);
  // Three lines until the text needs more: the box grows with it (upward, the
  // composer stays on the pane's last row) up to its CSS max-height.
  useLayoutEffect(() => {
    const box = composerRef.current;
    if (!box) return;
    box.style.height = "auto";
    if (box.scrollHeight > box.clientHeight) box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [draft]);
  const shortcutOverrides = useShortcutOverrides();
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
  const editDraft = (next: string, typing = false) => {
    undo.current.record(draftRef.current, next, typing);
    draftRef.current = next;
    setDraft(next);
    setSendError("");
    setSlashAt(null);
    setSlashClosed(false);
  };
  const pickSlash = (suggestion: SlashSuggestion) => {
    editDraft(suggestion.args ? `${suggestion.line} ` : suggestion.line);
    composerRef.current?.focus();
  };
  /** Claude Code's prompt suggestion, as its own CLI shows it: dimmed in the
   * empty box (the placeholder), taken into it by Tab or →, so the user still
   * sends, edits or ignores it. */
  const shownSuggestion = suggestion && !subagent && !sending ? suggestion : "";
  const suggestionKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!shownSuggestion || draft || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return false;
    if (e.key !== "Tab" && e.key !== "ArrowRight") return false;
    editDraft(shownSuggestion);
    caretAt.current = shownSuggestion.length;
    return true;
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

  // Files dropped onto the pane (`lib/terminal/terminalDrop`) land here while
  // the Reader is up: at the cursor when the box has focus, else at the end.
  useEffect(() => acceptInserts ? onReaderInsert(ptyId, (text) => {
    revealRef.current?.();
    const box = composerRef.current;
    const focusedBox = box !== null && document.activeElement === box;
    const current = draftRef.current;
    const at = focusedBox ? box.selectionEnd : current.length;
    const before = current.slice(0, at);
    const next = `${before}${before && !/\s$/.test(before) ? " " : ""}${text}${current.slice(at)}`;
    undo.current.record(current, next, false);
    draftRef.current = next;
    setDraft(next);
    setSendError("");
    box?.focus();
  }) : undefined, [ptyId, acceptInserts]);

  // A paste that finds no text on the clipboard may be an image (a
  // screenshot): it lands like a dropped file, an inbox `@` reference typed at
  // the caret through the insert above. `pastedImage` is that reference, for
  // the pill while the draft still holds it.
  const [pastedImage, setPastedImage] = useState("");
  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    void pasteClipboardImage(ptyId, true).then(({ text, error }) => {
      if (text && insertIntoReader(ptyId, text)) setPastedImage(text.trim());
      if (error) setSendError(t(error));
    });
  };

  /** The pane's screen and keyboard, for the walks that read Claude's own. */
  const paneRows = () => {
    const term = terminalFor(ptyId);
    return term ? bufferRows(term.buffer.active) : [];
  };
  const paneKey = (key: string) => {
    noteUserInput(ptyId);
    return writePtyInput(ptyId, ENCODER.encode(key)).then(() => true, () => false);
  };

  /** A dictated segment (`useReaderVoice`) joins the draft as typed text
   * would, undoable; one that ends in the spoken send ("go on" / "los")
   * sends the draft without those words. */
  const dictated = (heard: string) => {
    const clean = sanitizeVoiceTranscript(heard);
    if (!clean) return;
    const current = draftRef.current;
    const next = `${current}${current && !/\s$/.test(current) ? " " : ""}${clean}`;
    const spoken = spokenSend(next);
    editDraft(spoken ?? next);
    if (spoken !== null) void send();
  };
  const voice = useReaderVoice({
    tabKey,
    ptyId,
    visible,
    disabled: sending,
    handsFree: voiceLoop.handsFree,
    reading: voiceLoop.reading,
    questionOpen,
    lastAnswer: voiceLoop.lastAnswer,
    onText: dictated,
    onSend: () => void send(),
    hasDraft: () => draftRef.current.trim() !== "",
    pick: voiceLoop.pick,
    readProblem: voiceLoop.readProblem,
  });
  const { onListening } = voiceLoop;
  useEffect(() => onListening(voice.listening, voice.speakOver), [onListening, voice.listening, voice.speakOver]);

  const send = async () => {
    const current = tabRef.current;
    // The ref, not the state: a spoken send calls this in the same tick the
    // dictated words went into the draft.
    const text = draftRef.current.trim();
    if (!current || !text || sending) return;
    // Any send stops the voice reading the last answer.
    voiceLoop.stopReading();
    const panel = STATUS_AGENTS[current.cmd] && text === "/status" ? "status"
      : CONTEXT_AGENTS[current.cmd] && text === "/context" ? "context" : null;
    if (panel) {
      onStatus(panel);
      setDraft("");
      undo.current.clear();
      setSendError("");
      historyAt.current = null;
      return;
    }
    setSending(true);
    setSendError("");
    noteInputFrom(ptyId, "desktop");
    try {
      // A prefix the CLI's popup completes (`/clea`) runs that command.
      const command = completedSlashCommand(text, cli, usedSlash) ?? text;
      // A new conversation goes in as the Clear key's does, so the window
      // knows of it at once: Codex's hook says so only with the next prompt.
      if (isNewConversationCommand(command)) {
        if (!(await startNewConversation(current))) return;
      } else if (subagent && !/^\s*\//u.test(text)) {
        // Words go to the open subagent; a command stays the session's.
        const target = current.scheduleTargetId;
        if (!target) throw new Error("not an agent tab");
        const result = await sendToSubagent({
          rows: paneRows,
          // Its Esc hands the list's keyboard back: no turn is stopped.
          key: paneKey,
          command: (command) => typePaneKeys(ptyId, agentInputWrites(command)).then(() => true, () => false),
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
      // Words still on their way from the mic must not land in the emptied draft.
      voice.end();
      // Offered again by the `/` menu, newest first.
      rememberSlashCommand(cli, command);
      setUsedSlash(readSlashCommands(cli));
      setDraft("");
      undo.current.clear();
      historyAt.current = null;
    } catch (error) {
      setSendError(sendFailure(error));
    } finally {
      setSending(false);
    }
  };

  /** `/clear` into the tab; false, with the reason said, when it did not go in. */
  const startNewConversation = async (current: TabEntry): Promise<boolean> => {
    if (await clearAgentTab(scope, current)) return true;
    // Codex refuses one mid-turn, and says so only in its terminal.
    const busy = agentFamily(agentTabLabel(current)) === "codex" && !!useActivityStore.getState().busyByTab[ptyId];
    setSendError(t(busy ? "terminal.reader.clearBusy" : "terminal.reader.sendFailed"));
    return false;
  };
  const sendFailure = (error: unknown) =>
    t(error instanceof SessionPickerOpenError ? "terminal.reader.sendPickerOpen" : "terminal.reader.sendFailed");

  /** The chip row (`ReaderComposerChips`): Plan / Goal only lead the draft,
   * as the phone's do; Clear and Commit act at once and leave the draft alone. */
  const prefixCommands = draftPrefixes(cli);
  const togglePrefix = (command: string) => {
    editDraft(toggleDraftPrefix(draftRef.current, command, prefixCommands));
    composerRef.current?.focus();
  };
  const runChip = async (action: (current: TabEntry) => Promise<unknown>) => {
    const current = tabRef.current;
    if (!current || sending) return;
    setSending(true);
    setSendError("");
    try {
      await action(current);
    } catch (error) {
      setSendError(sendFailure(error));
    } finally {
      setSending(false);
    }
  };
  const clearChat = () => void runChip(startNewConversation);
  // Shown as sending by the Reader's `onSentPrompt` listener, like any prompt.
  const commit = (choice: CommitChoice) => void runChip((current) => sendSteeringPrompt(current, COMMIT_PROMPTS[choice]));

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
    const text = next >= history.length ? setAsideDraft.current : history[next];
    historyAt.current = next >= history.length ? null : next;
    undo.current.record(draft, text, false);
    setDraft(text);
    setSendError("");
    return true;
  };

  /** The queued prompts come back into the composer, after what it holds,
   * out of Claude's queue — so they are never sent as they were — and their
   * bubbles go. */
  const pullQueued = () => {
    if (pulling.current || queued.length === 0 || subagent || sending) return;
    pulling.current = true;
    const taken = [...queued];
    void pullQueuedPrompts({ rows: paneRows, key: paneKey }, taken.map((item) => item.text)).then((result) => {
      if (!result.ok) {
        setSendError(t("terminal.reader.pullFailed"));
        return;
      }
      if (result.pulled > 0) onPulled(taken.slice(taken.length - result.pulled).map((item) => item.id));
      const current = draftRef.current;
      const next = current ? `${current}\n${result.text}` : result.text;
      historyAt.current = null;
      editDraft(next);
      caretAt.current = next.length;
      if (!result.cleared) setSendError(t("terminal.reader.pullLeftover"));
      composerRef.current?.focus();
    }).finally(() => { pulling.current = false; });
  };
  pullRef.current = pullQueued;
  /** ↑ in the empty box while Claude says messages wait in its queue. */
  const pullKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return false;
    if (draft || historyAt.current !== null || queued.length === 0 || subagent || sending) return false;
    if (pulling.current) return true;
    if (!queuedHintShown(paneRows())) return false;
    pullQueued();
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

  /** Undo (or redo) the composer's last change, the caret after it. */
  const swapDraft = (redo: boolean) => {
    const next = redo ? undo.current.redo(draft) : undo.current.undo(draft);
    if (next === null) return;
    caretAt.current = caretAfterSwap(draft, next);
    historyAt.current = null;
    setDraft(next);
    setSendError("");
    setSlashAt(null);
    setSlashClosed(false);
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const redo = actionMatches("editorRedo", shortcutOverrides, e);
    if (!e.nativeEvent.isComposing && (redo || actionMatches("editorUndo", shortcutOverrides, e))) {
      e.preventDefault();
      swapDraft(redo);
    } else if (!e.nativeEvent.isComposing && actionMatches("readerDictate", shortcutOverrides, e)) {
      e.preventDefault();
      voice.toggle();
    } else if (!e.nativeEvent.isComposing && actionMatches("readerStopSpeaking", shortcutOverrides, e)) {
      // The voice stops, never the agent's turn; a send window is cancelled.
      e.preventDefault();
      voice.cancelSend();
      voiceLoop.stopReading();
    } else if (slashKey(e) || suggestionKey(e)) {
      e.preventDefault();
    } else if (questionOpen && !draft && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && focusQuestionOption(e.currentTarget)) {
      e.preventDefault();
    } else if (e.key === "ArrowUp" && pullKey(e)) {
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
  const chips = <ReaderComposerChips
    prefixes={prefixCommands}
    active={draftPrefix(draft, prefixCommands)}
    disabled={sending}
    onPrefix={togglePrefix}
    onClear={clearChat}
    onCommit={commit}
    actionSlot={actionSlot}
    extra={voice.button ? voiceLoop.chips : null}
  />;
  return <>
    <div className="terminal-reader-composer">
      {slashMenu.length > 0 && <ReaderSlashMenu suggestions={slashMenu} at={slashAt} onPick={pickSlash} onForget={forgetSlash} />}
      {chipSlot ? createPortal(chips, chipSlot) : chips}
      {voice.strip}
      <div className={voice.button ? "terminal-reader-input with-mic" : "terminal-reader-input"}>
        <textarea
          ref={composerRef}
          value={draft}
          rows={3}
          placeholder={subagent ? t("terminal.reader.subagentPlaceholder")
            : shownSuggestion ? t("terminal.reader.suggestionPlaceholder", { text: shownSuggestion })
            : t("terminal.reader.placeholder")}
          aria-label={subagent ? t("terminal.reader.subagentPlaceholder")
            : shownSuggestion ? `${t("terminal.reader.suggestion")}: ${shownSuggestion}`
            : t("terminal.reader.placeholder")}
          onChange={(e) => editDraft(e.target.value, true)}
          onKeyDown={onComposerKey}
          onPaste={onComposerPaste}
        />
        {shownSuggestion && !draft && <span className="terminal-reader-suggestion-tag"><UntestedTag id="terminal.reader.promptSuggestion" /></span>}
        {voice.button}
        <button
          type="button"
          className="terminal-reader-send"
          disabled={!draft.trim() || sending}
          onClick={() => void send()}
          aria-label={t("terminal.reader.send")}
          title={t("terminal.reader.send")}
        >
          {/* The phone composer's paper plane (`.send-icon`). */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 4 16 8-16 8 3-8-3-8Z" />
            <path d="M7 12h13" />
          </svg>
        </button>
      </div>
      {pastedImage && draft.includes(pastedImage) && <UntestedTag id="terminal.paste.image" />}
      {historyAt.current !== null && <UntestedTag id="terminal.reader.history" />}
      {undo.current.canUndo() && <UntestedTag id="terminal.reader.undo" />}
      {subagent && <UntestedTag id="terminal.reader.subagentInput" />}
    </div>
    {sendError && (actionSlot && !visible
      ? createPortal(<span className="reader-toolbar-error" role="alert">{sendError}</span>, actionSlot)
      : <div className="terminal-reader-error" role="alert">{sendError}</div>)}
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
 *
 * An earlier chat of the tab's folder picked in the prompt strip's Resume menu
 * (`lib/agents/agentChats`) is shown in place of the session's, read-only: a
 * bar names it, steps to the chats beside it and goes back (Esc), and where
 * the composer stands a footer offers to resume it in the tab. Its subagents
 * open as the session's do; nothing live — the screen's dialogs, the working
 * row, sending prompts — is drawn under it, since none of that is its.
 */
export function TerminalReaderView({ host, ptyId, scope, tabKey, cwd, localOnly = false, visible, focused, shown = true, changesOpen = false, onShowChat, navigationSlot, actionSlot }: {
  host: HTMLElement;
  /** The pane's PTY: its live screen is read, answers and Stop typed into it. */
  ptyId: string;
  scope: string;
  tabKey: string;
  cwd: string | undefined;
  /** The pane runs on this machine (`TerminalView`'s `localOnly`). */
  localOnly?: boolean;
  visible: boolean;
  focused: boolean;
  /** Keep the draft mounted while the terminal or the full-width Diffs tab is selected. */
  shown?: boolean;
  /** This pane's Diffs tab is selected (`TerminalView`'s own, never another
   * pane's): the chat stays mounted under it, hidden. */
  changesOpen?: boolean;
  /** Select this pane's Chat tab — leaving Diffs, or the terminal. */
  onShowChat?: () => void;
  navigationSlot?: HTMLElement | null;
  actionSlot?: HTMLElement | null;
}) {
  const t = useT();
  // A Tabby chat with its window-local prompt target: the composer, the
  // sending marks and the model/effort chips all go through it.
  const paneTab = usePaneTab(scope, tabKey);
  const tab = useMemo(() => withAssistantPromptTarget(scope, paneTab), [scope, paneTab]);
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [limit, setLimit] = useState(READER_STEP);
  // Every prompt sent to this tab — this composer's or steering's prompt box —
  // shows as sending at once, the agent idle or at work (the CLI queues it).
  // Kept outside the Reader, which is unmounted while the pane shows its
  // terminal: a prompt still queued shows again when the chat comes back.
  const sendTarget = tab?.scheduleTargetId;
  const pending = useSentPrompts(sendTarget);
  const [pendingTick, setPendingTick] = useState(0);
  /** A sent prompt was let go without the stored conversation recording it
   * (a store the Reader cannot read, a CLI that kept the turn elsewhere): the
   * turn is only in the terminal. The entry count at that moment — the
   * notice stays until the conversation gains a turn. */
  const [unrecordedAt, setUnrecordedAt] = useState<number | null>(null);
  const [readTick, setReadTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const keepFromBottom = useRef<number | null>(null);
  const version = useRef<string | undefined>();
  /** The subagents walked into from the session, outermost first; empty
   * while the session itself is shown. */
  const [subagentPath, setSubagentPath] = useState<readonly SubagentStep[]>([]);
  const [subagentListOpen, setSubagentListOpen] = useState(false);
  const subagentListId = useId();
  /** The top bar's Workspaces list: the session's Claude `Workflow` runs. */
  const [workflowListOpen, setWorkflowListOpen] = useState(false);
  const workflowListId = useId();
  const toolbarMenuOpen = subagentListOpen || workflowListOpen;
  useEffect(() => {
    if (!toolbarMenuOpen || !navigationSlot) return;
    const closeAll = () => {
      setSubagentListOpen(false);
      setWorkflowListOpen(false);
    };
    const away = (event: PointerEvent) => {
      const menu = navigationSlot.querySelector(".terminal-reader-subagent-index:has(> [aria-expanded=\"true\"])");
      if (!menu?.contains(event.target as Node)) closeAll();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const toggle = navigationSlot.querySelector<HTMLButtonElement>(".terminal-reader-subagent-toggle[aria-expanded=\"true\"]");
      closeAll();
      toggle?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [toolbarMenuOpen, navigationSlot]);
  const openStep = subagentPath[subagentPath.length - 1];
  const subToken = openStep?.token;
  /** The last read of a subagent's conversation, and whose it is — a read
   * that belongs to another subagent is never drawn under this one's bar. */
  const [subRead, setSubRead] = useState<{ token: string; transcript: SessionTranscript } | null>(null);
  const [subLimit, setSubLimit] = useState(READER_STEP);
  /** Where to scroll once the conversation just gone back up to is drawn. */
  const restoreScroll = useRef<number | null>(null);
  /** The earlier chat shown instead of the session's, if one is. */
  const browsed = useReaderChatsStore((state) => state.byPty[ptyId]);
  const chatId = browsed?.chat.id;
  const regionRef = useRef<HTMLDivElement>(null);

  const [live, setLive] = useState<ReaderLive>(NO_LIVE);
  /** When a read last saw the agent at work: a sent prompt waits from then. */
  const workingSeenAt = useRef(0);
  const [answered, setAnswered] = useState("");
  /** Why the last answer's keys did not reach the session: the AI switch (⏻)
   * refuses typing into an agent, or the write itself failed. */
  const [answerFailure, setAnswerFailure] = useState<"aiOff" | "write" | null>(null);
  /** What `answered` waits on: a row's answer, or a walk along the tab row. */
  const [answeredBy, setAnsweredBy] = useState<"row" | "step">("row");
  /** The dialog drawn in place of an answered one, while it is held
   * (`NEXT_DIALOG_HOLD_MS`). */
  const [heldSignature, setHeldSignature] = useState("");
  const [picking, setPicking] = useState(false);
  const [statusOpen, setStatusOpen] = useState<ReaderPanel | null>(null);
  /** The facts row's end, where the composer's chips go while it shows. */
  const [chipSlot, setChipSlot] = useState<HTMLDivElement | null>(null);
  const [statusRequest, setStatusRequest] = useState(0);
  const requestStatus = (panel: ReaderPanel) => { setStatusOpen(panel); setStatusRequest((request) => request + 1); };
  const closeStatus = () => setStatusOpen(null);
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
  const typeIntoPane = useCallback((keys: string[]) => typePaneKeys(ptyId, keys), [ptyId]);
  /** Esc in the composer, once no status panel or subagent is open: the key
   * the terminal would get — it stops the turn, closes the CLI's own menus —
   * typed into the session, the chat staying shown (the prompt strip's switch
   * is the way back to the terminal). */
  const pressEscape = useCallback(() => { void typeIntoPane(["\u001b"]).catch(() => {}); }, [typeIntoPane]);
  /** The reasoning effort last seen: Claude Code prints it only on its busy
   * row, so the facts row also takes the one its transcript records (every
   * answer, and a `/effort`'s confirmation) and the one just picked there —
   * whichever changed last. */
  const [seenEffort, setSeenEffort] = useState<string | undefined>();
  const workingEffort = live.working?.effort;
  useEffect(() => { if (workingEffort) setSeenEffort(workingEffort); }, [workingEffort]);
  const recordedEffort = transcript?.available ? transcript.effort : undefined;
  useEffect(() => { if (recordedEffort) setSeenEffort(recordedEffort); }, [recordedEffort]);

  // The live screen: read on the pane's output (settled). The slow clock runs
  // only while the pane has no terminal yet (it builds its xterm on first
  // show); once one exists its own write event drives every read — the busy
  // row's timer is repainted — and the registry says when the terminal is
  // built, swapped under the Reader (a respawn) or retired.
  useEffect(() => {
    if (!visible) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let subscribed: { term: NonNullable<ReturnType<typeof terminalFor>>; dispose: () => void } | undefined;
    let clock: ReturnType<typeof setInterval> | undefined;
    const read = () => {
      settle = undefined;
      const term = terminalFor(ptyId);
      if (!term) {
        subscribed?.dispose();
        subscribed = undefined;
        clock ??= setInterval(read, LIVE_POLL_MS);
        return;
      }
      if (clock) {
        clearInterval(clock);
        clock = undefined;
      }
      if (subscribed?.term !== term) {
        subscribed?.dispose();
        const writes = term.onWriteParsed(() => { settle ??= setTimeout(read, LIVE_SETTLE_MS); });
        subscribed = { term, dispose: () => writes.dispose() };
      }
      const next = readReaderLive(term.buffer.active, agentLabel, term.cols);
      if (next.working) workingSeenAt.current = Date.now();
      setLive((previous) => (sameReaderLive(previous, next) ? previous : next));
    };
    read();
    const unwatch = watchTerminal(ptyId, read);
    return () => {
      unwatch();
      if (clock) clearInterval(clock);
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
      if (live.question) setHeldSignature(live.signature);
      return;
    }
    const stuckTimer = setTimeout(() => setAnswered(""), ANSWER_WAIT_MS);
    return () => clearTimeout(stuckTimer);
  }, [answered, live.signature]);
  useEffect(() => {
    if (!heldSignature) return;
    const holdTimer = setTimeout(() => setHeldSignature(""), NEXT_DIALOG_HOLD_MS);
    return () => clearTimeout(holdTimer);
  }, [heldSignature]);
  /** The dialog on screen takes no answer: one is on its way, or it has just
   * replaced the one answered. */
  const held = (!!answered && answered === live.signature) || (!!heldSignature && heldSignature === live.signature);

  const answerFailed = (error: unknown) => {
    setAnswered("");
    setAnswerFailure(isAiOffRefusal(error) ? "aiOff" : "write");
  };
  useEffect(() => setAnswerFailure(null), [live.signature]);

  const answer = (index: number) => {
    const question = live.question;
    const option = question?.options.find((entry) => entry.index === index);
    if (!question || !option || answered || held) return;
    const keys = answerKeys(question, option);
    if (keys.length === 0) return;
    setAnswered(live.signature);
    setAnswerFailure(null);
    setAnsweredBy("row");
    stuck.current = true;
    void typePaneKeys(ptyId, keys).catch(answerFailed);
  };
  /** Answers the free-text row with the words typed under it. */
  const answerText = (index: number, text: string) => {
    const question = live.question;
    const option = question?.options.find((entry) => entry.index === index);
    if (!question || !option || answered || held) return;
    const keys = answerTextKeys(question, option, text);
    if (keys.length === 0) return;
    setAnswered(live.signature);
    setAnswerFailure(null);
    setAnsweredBy("row");
    stuck.current = true;
    void typePaneKeys(ptyId, keys).catch(answerFailed);
  };
  const step = (from: number, to: number) => {
    const keys = tabStepKeys(live, from, to);
    if (!live.question || keys.length === 0 || answered || held) return;
    setAnswered(live.signature);
    setAnswerFailure(null);
    setAnsweredBy("step");
    void typePaneKeys(ptyId, keys).catch(answerFailed);
  };
  const stop = () => void typePaneKeys(ptyId, [STOP_KEY]).catch(() => {});
  const shownLive = picking ? NO_LIVE : live;
  /** The terminal has shown something the chat cannot draw for `STRAY_MS`:
   * the chat says so and offers the way to it. Not while a picker the facts
   * row opened or an answer is on screen — the Reader put those there. */
  const strayNow = live.stray && !picking && !answered;
  const [strayShown, setStrayShown] = useState(false);
  useEffect(() => {
    if (!strayNow || !visible) {
      setStrayShown(false);
      return;
    }
    const timer = setTimeout(() => setStrayShown(true), STRAY_MS);
    return () => clearTimeout(timer);
  }, [strayNow, visible]);
  const openTerminal = () => { if (tab) useAgentReaderStore.getState().set(readerAgent(tab), false); };

  const tabRef = useRef(tab);
  tabRef.current = tab;
  const sessionId = tab?.sessionId;

  // Path links: the paths a read brings are looked up before it is drawn
  // (`learnPaths`), each once (`PathLinksContext`).
  const projectId = scope === "root" ? null : scope;
  // The folder the agent runs in: the spawn's resolved cwd (a local tab of a
  // remote project runs in its local mirror), not the stored `tab.cwd`, which
  // for such a project names its state folder.
  const tabDir = cwd || tab?.cwd || "";
  // What the facts row shows: a tab that runs on a host is in that host's
  // project folder, which `tabDir` (the state folder the backend resolves to
  // it) is not.
  const hostDir = useProjectsStore((s) =>
    !tab || localOnly ? null : hostTabCwd(tab, s.projects.find((p) => p.id === projectId)));
  const pathContext = usePathLinkContext(projectId, tabDir, localOnly);
  const pathContextRef = useRef(pathContext);
  pathContextRef.current = pathContext;
  const [pathLinks, setPathLinks] = useState<ReadonlyMap<string, FileEntry | null>>(() => new Map());
  const pathLinksRef = useRef(pathLinks);
  const [pathHover, setPathHover] = useState<PathLinkHover | null>(null);
  const learnPaths = useCallback(async (entries: readonly { text: string }[]) => {
    const ask = unknownPaths(entries.map((entry) => entry.text), pathLinksRef.current);
    if (!ask.length) return;
    const ctx = pathContextRef.current;
    const found = ctx.bases.length ? await resolvePathCandidates(ctx.bases, ask) : new Map<string, FileEntry>();
    const next = new Map(pathLinksRef.current);
    for (const path of ask) {
      const entry = found.get(path);
      next.set(path, entry && isLinkable(entry, ctx.projectDir, ctx.disabled) ? entry : null);
    }
    pathLinksRef.current = next;
    setPathLinks(next);
  }, []);
  const pathLinkAt = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>(`[${PATH_LINK_ATTR}]`) : null;
  // Ctrl (⌘) + click or Enter opens the file in a new subwindow.
  const openPathAt = (el: HTMLElement, newSubwindow: boolean) => {
    const entry = pathLinksRef.current.get(el.getAttribute(PATH_LINK_ATTR) ?? "");
    if (!entry) return;
    const ctx = pathContextRef.current;
    setPathHover(null);
    openPathLink(
      entry,
      { line: Number(el.dataset.line) || undefined, column: Number(el.dataset.column) || undefined },
      { scope, projectId, projectDir: ctx.projectDir, cwd: tabDir, disabled: ctx.disabled, t, newSubwindow },
    );
  };
  const onPathClick = (event: ReactMouseEvent) => {
    const el = pathLinkAt(event.target);
    if (!el) return;
    event.preventDefault();
    openPathAt(el, event.ctrlKey || event.metaKey);
  };
  const onPathKey = (event: KeyboardEvent) => {
    const el = event.key === "Enter" ? pathLinkAt(event.target) : null;
    if (!el) return;
    event.preventDefault();
    openPathAt(el, event.ctrlKey || event.metaKey);
  };
  const onPathOver = (event: ReactMouseEvent) => {
    const el = pathLinkAt(event.target);
    const entry = el ? pathLinksRef.current.get(el.getAttribute(PATH_LINK_ATTR) ?? "") : null;
    if (!el || !entry) return;
    const rect = el.getBoundingClientRect();
    setPathHover({
      left: rect.left,
      top: rect.top,
      name: relativePathWithin(pathContextRef.current.projectDir || tabDir, entry.path) || entry.path,
      line: Number(el.dataset.line) || undefined,
      isDir: entry.is_dir,
    });
  };
  const onPathOut = (event: ReactMouseEvent) => {
    const el = pathLinkAt(event.target);
    if (el && pathLinkAt(event.relatedTarget) !== el) setPathHover(null);
  };
  // A new session (a restart, a `/clear` the hook followed) is a new chat,
  // with subagents of its own — and so is an earlier chat opened, or left.
  useEffect(() => {
    version.current = undefined;
    setTranscript(null);
    setSubagentPath([]);
    setSubagentListOpen(false);
    setLimit(READER_STEP);
    stuck.current = true;
  }, [sessionId, chatId]);
  // An earlier chat takes the keyboard for its bar (Esc goes back): the
  // composer is not there to hold it.
  useEffect(() => {
    if (chatId && visible) regionRef.current?.focus({ preventScroll: true });
  }, [chatId, visible]);

  // Read at once, then whenever the backend's watch on the transcript says it
  // changed (`watchedReads`), with a slow backstop — or every 2 s while the
  // read cannot be watched (nothing on disk yet).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const stop = watchedReads(async (watch) => {
      const current = tabRef.current;
      if (!current) return false;
      const args = readerRequest(scope, current, cwd, version.current, limit, undefined, chatId);
      if (!args) {
        setTranscript({ available: false, reason: "no_session", entries: [], truncated: false });
        return false;
      }
      const next = await invoke<SessionTranscript>("agent_tab_transcript", { ...args, watch })
        .catch((): SessionTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
      await learnPaths(next.entries);
      if (cancelled) return next.watched === true;
      if (!next.unchanged) version.current = next.version;
      setTranscript((previous) => mergeTranscript(previous, next));
      return next.watched === true;
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, scope, cwd, limit, sessionId, chatId, readTick, learnPaths]);

  // The open subagent's conversation, read as the session is: at once, then
  // on each change while shown — a subagent still at work keeps writing.
  useEffect(() => {
    if (!visible || !subToken) return;
    let cancelled = false;
    let subVersion: string | undefined;
    const stop = watchedReads(async (watch) => {
      const current = tabRef.current;
      if (!current) return false;
      const args = readerRequest(scope, current, cwd, subVersion, subLimit, subToken, chatId);
      if (!args) return false;
      const next = await invoke<SessionTranscript>("agent_tab_transcript", { ...args, watch })
        .catch((): SessionTranscript => ({ available: false, reason: "read_failed", entries: [], truncated: false }));
      await learnPaths(next.entries);
      if (cancelled) return next.watched === true;
      if (!next.unchanged) subVersion = next.version;
      setSubRead((previous) => ({
        token: subToken,
        transcript: mergeTranscript(previous?.token === subToken ? previous.transcript : null, next),
      }));
      return next.watched === true;
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, scope, cwd, subToken, subLimit, sessionId, chatId, learnPaths]);

  const storedEntries = useMemo(() => (transcript?.available ? transcript.entries : []), [transcript]);
  // A clear (`agentClearUndo`) empties the chat at once, before its card
  // offers it back: what is read now is the cleared conversation, every record
  // of it — no prompt has gone into the new one while the card stands. Codex
  // reads that session until its first prompt, so the mark outlives the card.
  const clearOffered = useAgentClearUndoStore((state) => !!state.cleared[ptyId]);
  const clearedAt = useAgentClearUndoStore((state) => state.marks[ptyId]);
  useEffect(() => {
    if (clearOffered && clearedAt === undefined && transcript && !chatId) {
      useAgentClearUndoStore.getState().setMark(ptyId, clearMark(storedEntries));
    }
  }, [clearOffered, clearedAt, transcript, storedEntries, ptyId, chatId]);
  /** The new chat's records while the cleared one is still what is read. */
  const sinceClear = useMemo(
    () => (chatId ? null : afterClear(storedEntries, clearedAt ?? null)),
    [storedEntries, clearedAt, chatId],
  );
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
  // The files the phone sent into the project inbox, drawn in their prompts'
  // bubbles as on the phone (`ReaderInbox`).
  const promptTexts = useMemo(() => turns.filter((turn) => turn.kind === "prompt").map((turn) => turn.text), [turns]);
  const openInboxRef = useRef<(entry: FileEntry) => void>(() => undefined);
  openInboxRef.current = (entry) => {
    const ctx = pathContextRef.current;
    openPathLink(entry, {}, { scope, projectId, projectDir: ctx.projectDir, cwd: tabDir, disabled: ctx.disabled, t });
  };
  const openInboxEntry = useCallback((entry: FileEntry) => openInboxRef.current(entry), []);
  const settleInbox = useCallback(() => {
    const list = listRef.current;
    if (list && stuck.current) list.scrollTop = list.scrollHeight;
  }, []);
  const readerInbox = useReaderInbox({
    projectId, projectDir: pathContext.projectDir, disabled: pathContext.disabled,
    texts: promptTexts, enabled: visible, openEntry: openInboxEntry, settle: settleInbox,
  });
  // The pictures and PDFs the answers name, drawn under them (`ReaderAnswerFiles`).
  const answerTexts = useMemo(() => turns.filter((turn) => turn.kind === "answer" && !turn.questions).map((turn) => turn.text), [turns]);
  const answerFiles = useReaderAnswerFiles({
    projectId, disabled: pathContext.disabled, texts: answerTexts, links: pathLinks,
    enabled: visible, openEntry: openInboxEntry, settle: settleInbox,
  });
  const openers = useMemo(() => dayOpeners(turns.map((turn) => turn.stamp)), [turns]);

  // Voice (docs/desktop_voice_plan.md step 4): read-aloud speaks the session's
  // new answer once its turn ends; hands-free (experimental) loops the mic
  // around it. Both speak the session's conversation, not an open subagent's.
  const voiceSettings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const handsFreeFlag = useExperimental("voice_hands_free");
  const readAloudOn = voiceSettings?.voice_read_aloud ?? false;
  const handsFreeOn = handsFreeFlag && (voiceSettings?.voice_hands_free_on ?? false);
  const sessionTurns = useMemo(() => transcriptTurns(entries), [entries]);
  const lastAnswer = useMemo(() => {
    for (let index = sessionTurns.length - 1; index >= 0; index -= 1) if (sessionTurns[index].kind === "answer") return sessionTurns[index].key;
    return null;
  }, [sessionTurns]);
  const [voiceListening, setVoiceListening] = useState({ on: false, over: false });
  const onVoiceListening = useCallback((on: boolean, over: boolean) => {
    setVoiceListening((prev) => (prev.on === on && prev.over === over ? prev : { on, over }));
  }, []);
  const agentTurn = useAgentTurn(ptyId, readAloudOn || handsFreeOn);
  const readAloud = useReaderReadAloud({
    readId: ptyId,
    enabled: readAloudOn,
    visible,
    listening: voiceListening.on && !voiceListening.over,
    turns: sessionTurns,
    turnEnd: agentTurn.endKey,
    working: agentTurn.working,
  });
  /** Hands-free: a settled utterance that picks a row of the dialog on screen
   * answers it as a click would. */
  const pickByVoice = (utterance: string) => {
    const question = live.question;
    if (!question || answered || held || picking) return false;
    const option = voicePick(utterance, question);
    if (!option) return false;
    answer(option.index);
    return true;
  };
  const pickRef = useRef(pickByVoice);
  pickRef.current = pickByVoice;
  const pickVoice = useCallback((utterance: string) => pickRef.current(utterance), []);
  // Hands-free with read-aloud: a dialog waiting on the user is read out, its
  // rows by number, once per dialog, so it can be answered by voice.
  const spokenQuestion = useRef("");
  useEffect(() => {
    if (!live.question || picking) {
      spokenQuestion.current = "";
      return;
    }
    if (!handsFreeOn || !readAloudOn || !visible || held || spokenQuestion.current === live.signature) return;
    spokenQuestion.current = live.signature;
    readAloud.say(`question:${live.signature}`, questionSpeech(live.ask, live.question));
  }, [live.question, live.signature, live.ask, picking, handsFreeOn, readAloudOn, visible, held, readAloud]);
  const voiceChips = <>
    <button
      type="button"
      className={`terminal-reader-chip${readAloudOn ? " active" : ""}`}
      aria-pressed={readAloudOn}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (readAloudOn) readAloud.stop();
        void updateSettings({ voice_read_aloud: !readAloudOn });
      }}
      title={t("terminal.reader.voice.readAloudHint")}
    >
      {t("terminal.reader.voice.readAloud")} <UntestedTag id="terminal.reader.voice.readAloud" />
    </button>
    {handsFreeFlag && (
      <button
        type="button"
        className={`terminal-reader-chip${handsFreeOn ? " active" : ""}`}
        aria-pressed={handsFreeOn}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void updateSettings({ voice_hands_free_on: !handsFreeOn })}
        title={t("terminal.reader.voice.handsFreeHint")}
      >
        {t("terminal.reader.voice.handsFree")} <UntestedTag id="terminal.reader.voice.handsFree" />
      </button>
    )}
  </>;
  const voiceLoop: ReaderVoiceLoop = {
    handsFree: handsFreeOn,
    reading: readAloud.owed,
    lastAnswer,
    pick: pickVoice,
    stopReading: readAloud.stop,
    readProblem: readAloud.problem,
    onListening: onVoiceListening,
    chips: voiceChips,
  };
  const sessionAgents = useMemo(() => entries.filter((entry) => entry.kind === "agent"), [entries]);
  /** What ↑ in the composer can take back out of Claude's queue: the prompts
   * still sending while its turn runs. */
  const queuedPrompts = useMemo(
    () => (live.working && isClaudeCommand(tab?.cmd) ? pending : []),
    [live.working, tab?.cmd, pending],
  );
  const dropPending = useCallback((ids: number[]) => {
    if (sendTarget) forgetSentPrompts(sendTarget, ids);
  }, [sendTarget]);
  /** The composer's pull, for the last sending bubble's Cancel and edit. */
  const pullQueued = useRef<(() => void) | null>(null);
  /** What ↑ in the composer walks: the session's prompts, as the CLI's box. */
  const history = useMemo(() => composerHistory(entries, pending.map((item) => item.text)), [entries, pending]);

  // A prompt sent while the chat shows scrolls it to the bottom.
  useEffect(() => {
    if (!sendTarget) return;
    return onSentPrompt(sendTarget, () => {
      stuck.current = true;
      setReadTick((tick) => tick + 1);
      // It went to the session, never to a subagent or an earlier chat: back
      // to where it lands.
      setSubagentPath([]);
      useReaderChatsStore.getState().back(ptyId);
    });
  }, [sendTarget, ptyId]);

  // A sent prompt shows until the transcript records it (by its words — a
  // long one's opening, the record cut at its bound — at or after the moment
  // it went) or it has waited long enough to be let go. Only while shown: a
  // hidden pane's screen is not read, so the agent may be at work unseen.
  useEffect(() => {
    if (pending.length === 0 || !visible || !sendTarget) return;
    const now = Date.now();
    const waitingSince = (item: SentPrompt) => Math.max(item.sentAt, workingSeenAt.current);
    // A bare `/prefix` is recorded as the command the CLI's popup completed
    // it to (`/clea` → `/clear`).
    const recorded = (item: SentPrompt) => {
      const sent = item.text.trim();
      const prefix = /^\/[\w-]+$/u.test(sent) ? sent : null;
      return entries.some((entry) =>
        entry.kind === "prompt"
        && (recordsPrompt(entry, sent) || (!!prefix && !!slashCommand(entry.text)?.name.startsWith(prefix)))
        && (!entry.at || Date.parse(entry.at) >= item.sentAt - 5_000));
    };
    const left = pending.filter((item) => now - waitingSince(item) < PENDING_MS && !recorded(item));
    if (left.length !== pending.length) {
      const gone = pending.filter((item) => !left.includes(item));
      if (gone.some((item) => !recorded(item))) setUnrecordedAt(entries.length);
      forgetSentPrompts(sendTarget, gone.map((item) => item.id));
      return;
    }
    // Nothing new may come in to look again: let the first one go on time.
    const due = Math.min(...left.map(waitingSince)) + PENDING_MS - now;
    const timer = setTimeout(() => setPendingTick((tick) => tick + 1), due);
    return () => clearTimeout(timer);
  }, [entries, pending, visible, sendTarget, pendingTick]);
  useEffect(() => {
    if (unrecordedAt !== null && entries.length > unrecordedAt) setUnrecordedAt(null);
  }, [entries.length, unrecordedAt]);
  const unrecorded = unrecordedAt !== null;

  /** The prompt the answer at the top of the chat belongs to — the last one
   * that starts above the scroll position — while its bubble is scrolled off
   * the top, pinned there as on the phone's Focus Reader; empty while any
   * prompt bubble is in view (that one, or a newer one further down). Read
   * off the chat as drawn (`data-prompt`), with the bubble's own time. */
  const [pinnedPrompt, setPinnedPrompt] = useState("");
  const [pinnedTime, setPinnedTime] = useState("");
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
    setPinnedTime(owner?.querySelector(":scope > .terminal-reader-time")?.textContent ?? "");
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
  }, [turns, pending, live, strayShown, unrecorded, shownTranscript, visible, checkPinnedPrompt]);

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
    setSubagentPath((path) => openSubagent(path, { token, task: turn.text, role: turn.role, ...(turn.workflow ? { workflow: true } : {}) }, levelEntriesRef.current, top));
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
  const empty = transcript?.available && turns.length === 0 && pending.length === 0 && !unrecorded && !live.question && !live.working;
  /** Where the open subagent stands among its siblings, and the conversation
   * the bar goes back up to. */
  const position = openStep ? siblingPosition(openStep) : { index: -1, count: 0 };
  const backLabel = t("mobile.subagent.back", {
    name: subagentPath.length > 1 ? subagentPath[subagentPath.length - 2].task : t("mobile.subagent.main"),
  });
  /** The session's subagents only earlier turns hold, counted with the
   * listed ones; none for a long session that never spawned one. */
  const agentsEarlier = transcript?.available && transcript.truncated && !sinceClear ? transcript.agentsEarlier ?? 0 : 0;
  const moreEarlier = agentsEarlier > 0;
  /** The open subagent at work — it has not reported back, and the session
   * is at work or it runs in the background — and the model its own
   * conversation names. */
  const subagentWorking = openSubagentRunning(subagentPath, entries, !browsed && !!live.working);
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
  const backgroundAtWork = browsed || openStep || live.working ? 0 : sessionAgents.filter((entry) => subagentAtWork(entry, false)).length;
  /** The shells the shown conversation runs, beside its working row. One it
   * waits on shows only while that row does — a call the CLI never answered
   * (killed mid-command) is not a shell at work; a background one shows while
   * the backend sees it still running, the agent at work or not. */
  const shellsWaited = openStep ? subagentWorking : !!live.working;
  const runningShells = shownTranscript?.available && !browsed
    ? (shownTranscript.shells ?? []).filter((shell) => shell.background || shellsWaited)
    : [];

  /** Where the earlier chat shown stands among the menu's, and the ways
   * along them, back to the session and onto it in the tab. */
  const chatAt = browsed ? chatPosition(browsed) : { index: -1, count: 0 };
  const chatBack = () => useReaderChatsStore.getState().back(ptyId);
  const chatStep = (delta: number) => {
    const next = browsed && stepChat(browsed, delta);
    if (!browsed || !next) return;
    restoreScroll.current = null;
    useReaderChatsStore.getState().browse(ptyId, next, browsed.list);
  };
  const [resumingChat, setResumingChat] = useState(false);
  const resumeChat = () => {
    if (!browsed || !tab || resumingChat || live.working) return;
    setResumingChat(true);
    void resumeChatWithToast(scope, tab, cwd, browsed.chat, t).finally(() => setResumingChat(false));
  };
  const resumeLabel = t(live.working ? "terminal.chats.resumeBusy" : "terminal.chats.resumeHint");
  const onRegionKey = (event: KeyboardEvent) => {
    if (!browsed || event.key !== "Escape") return;
    event.preventDefault();
    if (openStep) subagentUp();
    else chatBack();
  };

  /** A list of the session's `agent` entries under a toggle: the chat's own
   * Subagents index, or in the top bar Subagents and Workspaces (Claude
   * `Workflow` runs, the orchestrations) side by side. A pick opens it in the
   * chat; from the top bar it also brings the chat back over Diffs or the
   * terminal. */
  const agentMenu = ({ list, earlier, label, region, untestedId, open, setOpen, listId }: {
    list: readonly TranscriptEntry[];
    /** Agents only earlier turns hold: counted, and read in by the last row. */
    earlier: number;
    label: string;
    region: string;
    untestedId: UntestedId;
    open: boolean;
    setOpen: (update: (open: boolean) => boolean) => void;
    listId: string;
  }) => (
    <nav className="terminal-reader-subagent-index" aria-label={region}>
      <button
        type="button"
        className="terminal-reader-subagent-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(() => true); }
        }}
        onClick={() => {
          setOpen((was) => !was);
          // One list open at a time in the top bar.
          if (navigationSlot) (setOpen === setSubagentListOpen ? setWorkflowListOpen : setSubagentListOpen)(false);
        }}
      >
        <span>{label}</span>
        <UntestedTag id={untestedId} />
        <span className={open ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={listId} className="terminal-reader-subagent-list" onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          if (!buttons.length) return;
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}>
          {list.map((entry, index) => (
            <button type="button" key={`${entry.at ?? ""}:${index}`} disabled={!entry.subagent} onClick={() => { openAgent(entry, true); if (navigationSlot) { setOpen(() => false); onShowChat?.(); } }}>
              <small>
                {entry.role ?? subagentLabel}
                {subagentAtWork(entry, !!live.working) && (
                  <span className="terminal-reader-working-dots" role="img" aria-label={t("terminal.reader.working")}><i /><i /><i /></span>
                )}
              </small>
              <span>{entry.text}{entry.cut && "…"}</span>
            </button>
          ))}
          {earlier > 0 && (
            <button type="button" className="terminal-reader-subagent-earlier" onClick={showEarlier}>
              {t("mobile.subagent.earlier")}
            </button>
          )}
        </div>
      )}
    </nav>
  );
  /** In the top bar the orchestrations have their own Workspaces list. */
  const plainAgents = navigationSlot ? sessionAgents.filter((entry) => !entry.workflow) : sessionAgents;
  const workflowRuns = navigationSlot ? sessionAgents.filter((entry) => entry.workflow) : [];
  const subagentsMenu = transcript?.available && (plainAgents.length > 0 || moreEarlier) ? agentMenu({
    list: plainAgents, earlier: agentsEarlier,
    label: t("mobile.subagent.index", { count: plainAgents.length + agentsEarlier }), region: t("mobile.subagent.indexRegion"),
    untestedId: "terminal.reader.subagents", open: subagentListOpen, setOpen: setSubagentListOpen, listId: subagentListId,
  }) : null;
  const workspacesMenu = transcript?.available && workflowRuns.length > 0 ? agentMenu({
    list: workflowRuns, earlier: 0,
    label: t("terminal.reader.workspaces", { count: workflowRuns.length }), region: t("terminal.reader.workspacesRegion"),
    untestedId: "terminal.reader.topbar", open: workflowListOpen, setOpen: setWorkflowListOpen, listId: workflowListId,
  }) : null;
  // Scanned once per conversation or link change, not on every live-screen
  // render (each settled write of the pane re-renders the Reader).
  const toolbarFiles = useMemo(() => {
    if (!navigationSlot) return [];
    const found = new Map<string, ReaderToolbarFile>();
    for (const entry of levelEntries) for (const candidate of findPathCandidates(entry.text)) {
      const file = pathLinks.get(candidate.path);
      if (file && !file.is_dir) found.set(file.path, {
        path: file.path, label: relativePathWithin(tabDir, file.path) || file.path,
        open: () => openInboxEntry(file),
      });
    }
    if (readerInbox) for (const file of readerInbox.files.values()) if (file) {
      const path = `inbox:${file.name}`;
      if (![...found.values()].some((entry) => entry.path.endsWith(file.name))) {
        found.set(path, { path, label: file.name, open: () => readerInbox.open(file) });
      }
    }
    return [...found.values()];
  }, [navigationSlot, levelEntries, pathLinks, tabDir, openInboxEntry, readerInbox]);

  return createPortal(<>
    <div
      ref={regionRef}
      className={`terminal-reader ${SIGN_IN_CARD_CLASS}${browsed ? " browsing" : ""}${actionSlot ? " has-topbar" : ""}`}
      hidden={!shown || changesOpen}
      role="region"
      aria-label={t("terminal.reader.title")}
      tabIndex={browsed ? -1 : undefined}
      onKeyDown={onRegionKey}
    >
      {browsed && !openStep && (
        <nav className="terminal-reader-subagent-bar terminal-reader-chat-bar" aria-label={t("terminal.chats.earlier")}>
          <button type="button" className="terminal-reader-subagent-nav" onClick={chatBack} aria-label={t("terminal.chats.back")} title={`${t("terminal.chats.back")} (Esc)`}>‹</button>
          <div className="terminal-reader-subagent-title">
            <small>
              {t("terminal.chats.earlierWhen", { when: chatWhen(browsed.chat.updated, use24h, t("mobile.transcript.yesterday")) })}
              {" "}<UntestedTag id="terminal.reader.chats" />
            </small>
            <strong title={browsed.chat.title}>{browsed.chat.title}</strong>
          </div>
          {chatAt.count > 1 && chatAt.index >= 0 && (
            <div className="terminal-reader-subagent-steps">
              <button type="button" className="terminal-reader-subagent-nav" disabled={chatAt.index <= 0} onClick={() => chatStep(-1)} aria-label={t("terminal.chats.newer")} title={t("terminal.chats.newer")}>‹</button>
              <span>{t("mobile.subagent.position", { index: chatAt.index + 1, count: chatAt.count })}</span>
              <button type="button" className="terminal-reader-subagent-nav" disabled={chatAt.index >= chatAt.count - 1} onClick={() => chatStep(1)} aria-label={t("terminal.chats.older")} title={t("terminal.chats.older")}>›</button>
            </div>
          )}
          <button type="button" className="terminal-reader-chat-resume" disabled={!!live.working || resumingChat} onClick={resumeChat} title={resumeLabel}>
            {t("terminal.chats.resume")}
          </button>
        </nav>
      )}
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
      ) : !navigationSlot && subagentsMenu}
      <div className="terminal-reader-stream">
        <PathLinksContext.Provider value={pathLinks}>
        <ReaderInboxContext.Provider value={readerInbox}>
        <ReaderAnswerFilesContext.Provider value={answerFiles}>
        <div
          ref={listRef}
          className="terminal-reader-list"
          onScroll={() => { onScroll(); setPathHover(null); }}
          onClick={onPathClick}
          onKeyDown={onPathKey}
          onMouseOver={onPathOver}
          onMouseOut={onPathOut}
        >
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
          {!openStep && !browsed && pending.map((item, index) => (
            <div key={item.id} className="terminal-reader-turn user pending" data-prompt={item.text}>
              <PromptText text={item.text} unlinked />
              {/* Queued behind a busy turn: Esc stops it and Claude sends the
                  queue at once; ↑ in the empty composer takes it back. Both
                  act on the whole queue, so their buttons go under the last. */}
              {live.working && isClaudeCommand(tab?.cmd) && (
                <small className="terminal-reader-pending-hint">
                  {t("terminal.reader.sendNowHint")}
                  <UntestedTag id="terminal.reader.sendNowHint" />
                  <UntestedTag id="terminal.reader.queuePull" />
                </small>
              )}
              {live.working && isClaudeCommand(tab?.cmd) && index === pending.length - 1 && (
                <div className="terminal-reader-queued-actions">
                  <button type="button" className="terminal-reader-stop" onClick={pressEscape} title={t("terminal.reader.sendNowTitle")}>
                    {t("terminal.reader.sendNow")}
                  </button>
                  <button type="button" className="terminal-reader-stop" onClick={() => pullQueued.current?.()} title={t("terminal.reader.cancelEditTitle")}>
                    {t("terminal.reader.cancelEdit")}
                  </button>
                  <UntestedTag id="terminal.reader.queuedActions" />
                </div>
              )}
              <small className="terminal-reader-time">{t("terminal.reader.sending")}</small>
            </div>
          ))}
          <LiveQuestion
            live={browsed ? NO_LIVE : shownLive}
            answered={!!answered && answered === live.signature && answeredBy === "row"}
            failure={answerFailure}
            busy={held}
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
          ) : !browsed && live.working && (
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
          {strayShown && !browsed && !openStep && live.screen.length > 0 && (
            <pre className="terminal-reader-question-context terminal-reader-stray-screen">{live.screen.join("\n")}</pre>
          )}
          {(strayShown || unrecorded) && !browsed && !openStep && (
            <div className="terminal-reader-working terminal-reader-stray" role="status">
              <span>{t(strayShown ? "terminal.reader.stray" : "terminal.reader.unrecorded")}</span>
              <button type="button" className="terminal-reader-stop" onClick={openTerminal} title={t("terminal.reader.strayOpenHint")}>
                {t("terminal.reader.strayOpen")}
              </button>
              {strayShown ? <UntestedTag id="terminal.reader.stray" /> : <UntestedTag id="terminal.reader.unrecorded" />}
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
        </ReaderAnswerFilesContext.Provider>
        </ReaderInboxContext.Provider>
        </PathLinksContext.Provider>
        <PathLinkHint hover={visible ? pathHover : null} />
        {!openStep && pinnedPrompt && (
          <button
            type="button"
            className="terminal-reader-turn user terminal-reader-pinned-prompt"
            aria-label={t("mobile.focus.lastPrompt")}
            title={t("mobile.focus.lastPrompt")}
            onClick={() => pinnedPromptEl.current?.scrollIntoView({ block: "start", behavior: "smooth" })}
          >
            <span className="terminal-reader-pinned-prompt-text">{pinnedPrompt}</span>
            {pinnedTime && <small className="terminal-reader-time">{pinnedTime}</small>}
            <UntestedTag id="terminal.reader.pinnedPrompt" />
          </button>
        )}
      </div>
      {tab && !browsed && (
        <TerminalReaderFacts
          tab={tab}
          ptyId={ptyId}
          agentLabel={agentLabel}
          live={live}
          modelTag={modelTag}
          usage={transcript?.available && !sinceClear ? transcript.usage : undefined}
          contextCard={transcript?.available && !sinceClear ? transcript.contextCard : undefined}
          visible={visible}
          path={hostDir ?? tabDir}
          effort={seenEffort}
          onEffortPicked={setSeenEffort}
          typeKeys={typeIntoPane}
          onPicking={setPicking}
          statusOpen={statusOpen}
          statusRequest={statusRequest}
          onStatusRequest={requestStatus}
          onStatusClose={closeStatus}
          chipSlot={setChipSlot}
        />
      )}
      {browsed ? (
        <div className="terminal-reader-chat-foot" role="note">
          <span>{t("terminal.chats.readOnly")}</span>
          <button type="button" className="terminal-reader-earlier" onClick={chatBack}>{t("terminal.chats.back")}</button>
          <button type="button" className="terminal-reader-chat-resume" disabled={!!live.working || resumingChat} onClick={resumeChat} title={resumeLabel}>
            {t("terminal.chats.resumeHere")}
          </button>
        </div>
      ) : <ReaderComposer
        scope={scope}
        tabKey={tabKey}
        tabRef={tabRef}
        ptyId={ptyId}
        cli={agentFamily(agentLabel)}
        subagent={openStep && isClaudeCommand(tab?.cmd) && !inWorkflow(subagentPath) ? openStep : undefined}
        history={history}
        queued={queuedPrompts}
        focused={focused}
        visible={visible && shown && !changesOpen}
        acceptInserts={visible && shown}
        onReveal={onShowChat}
        steering={steering}
        questionOpen={!!shownLive.question}
        suggestion={shownLive.suggestion}
        chipSlot={actionSlot ? null : chipSlot}
        actionSlot={actionSlot}
        voiceLoop={voiceLoop}
        onEscape={statusOpen ? closeStatus : openStep ? subagentUp : pressEscape}
        onStatus={requestStatus}
        onPulled={dropPending}
        pullRef={pullQueued}
      />}
    </div>
    {/* The conversation's menus only over Chat or Diffs: in Terminal the
        transcript and the live screen are not read, so they would go stale. */}
    {navigationSlot && shown && createPortal(<>
      {subagentsMenu}
      {workspacesMenu}
      <ReaderToolbarNavigation files={toolbarFiles} />
    </>, navigationSlot)}
    {changesOpen && shown && tab && (
      <TerminalReaderChanges
        scope={scope}
        tab={tab}
        cwd={cwd}
        visible={visible}
        subagent={subToken}
        subagentTitle={openStep ? openStep.task || openStep.role : undefined}
        chat={chatId}
        chatTitle={browsed?.chat.title}
        onClose={() => onShowChat?.()}
      />
    )}
  </>, host);
}
