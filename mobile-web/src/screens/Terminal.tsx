import { NAMES } from "../../../src/lib/brand";
import { translate, useI18nStore, useT, type TranslationKey } from "../../../src/lib/i18n";
import { AgentStatusMark } from "../components/AgentStatusPill";
import { useMessageMenu, type HoldHandlers } from "../components/MessageMenu";
import { useChatLinks, type LinkHandlers } from "../components/LinkSheet";
import { OptionSheet, type SheetOption } from "../components/OptionSheet";
import { QuestionRows } from "../components/QuestionRows";
import { SpeechLangSheet, speechLangSummary } from "../components/SpeechLangPicker";
import { OutboxGallery } from "../components/OutboxGallery";
import { OutboxViewer, type MarkupNewTab, type MarkupSend, type MarkupTarget } from "../components/OutboxViewer";
import type { AgentSignal } from "../markup/submitState";
import { useMarkupAsks } from "../markup/questions";
import { OutboxPost } from "../components/OutboxPost";
import { SentFilesIndex, sentFiles, type SentFile } from "../components/SentFilesIndex";
import { ComposerThumb, InboxAlbum, leafName } from "../components/InboxPreview";
import { ProjectFiles } from "../components/ProjectFiles";
import { Fragment, memo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { phoneTerminalTheme } from "../theme";
import {
  ANY_FILE_ACCEPT,
  ApiError,
  api,
  attachDesktopImage,
  closeTab,
  deleteOutboxFile,
  getAgentStatus,
  getSchedules,
  getTranscript,
  inboxFileUrl,
  listDesktopImages,
  listOutbox,
  MAX_INBOX_FILE,
  openSignInTab,
  pickPhoneFiles,
  recoverSession,
  refreshProjectFile,
  editHeldPrompt,
  holdPrompt,
  reportSentPrompt,
  sentName,
  undoClear,
  uploadToInbox,
  type DesktopImage,
  type OutboxFile,
  type PhoneMarkupFile,
  type ViewerScope,
  type ProjectDetail,
  type SessionTranscript,
  type AskedQuestion,
  type TabRow,
  type TranscriptEntry,
} from "../api";
import { describeFailure } from "../connection";
import { DRAFT_SAVE_DELAY, readDraft, writeDraft } from "../drafts";
import { OUTBOX_POLL, sameOutbox } from "../outbox";
import { readFlag, readTerminalView, writeFlag, writeTerminalView, type TerminalViewChoice } from "../prefs";
import { readSpeechLang, speechTag, type SpeechLang } from "../speechLang";
import { TERMINAL_PROTOCOL, TERMINAL_SIZE } from "../terminal/protocol";
import { dedentRows, readableRange, readableScreen, readableText, type ReadableLine } from "../terminal/readableScreen";
import {
  absorbHistory,
  emptyHistory,
  lastHistoryText,
  shiftHistory,
  type HistoryChunk,
} from "../terminal/readableHistory";
import { type TerminalEvent } from "../terminal/protocol";
import { createVisibilityReporter } from "../terminal/visibility";
import { installTerminalTouchScroll } from "../terminal/touchScroll";
import { installWideOutputHint, type WideOutputHint } from "../terminal/wideOutput";
import { inputFrameStart, sessionStatus, statusFrameLines, type SessionStatus } from "../terminal/statusLine";
import { sessionLimits } from "../terminal/sessionUsage";
import { installFocusSwipe } from "../terminal/focusSwipe";
import {
  freeTextRow,
  freeTextWrites,
  mergeSelectRows,
  questionTabKeys,
  readReviewStep,
  readSelectPrompt,
  revealSelectRow,
  sameSelectStep,
  selectKeys,
  selectMoveKeys,
  selectSignature,
  type QuestionTab,
  type SelectOption,
  type SelectPrompt,
  type SelectStep,
} from "../terminal/selectPrompt";
import { NO_QUESTION_PARTS, questionParts, type QuestionParts } from "../terminal/questionParts";
import {
  isOpenCodeTab,
  openCodePickKeys,
  readOpenCodePicker,
  OPENCODE_MODEL_KEYS,
} from "../terminal/openCodeMini";
import {
  antigravityEffortKeys,
  isAntigravityTab,
  readAntigravityEffort,
  readAntigravityPicker,
  type AntigravityEffort,
} from "../terminal/antigravity";
import { isCursorTab, readCursorPicker } from "../terminal/cursorAgent";
import { currentMode, modeChoices, modeFixed, shiftTabKey } from "../terminal/agentModes";
import { agentFamily, agentInputWrites, bracketsAgentMessage } from "../terminal/composer";
import { COMMIT_CHOICES, COMMIT_PROMPTS, type CommitChoice } from "../terminal/commitPrompts";
import { agentWork } from "../terminal/agentBusy";
import { chatTurns, isLiveEcho } from "../terminal/chatTurns";
import { answerHtml, promptHtml } from "../terminal/answerMarkdown";
import { chatDayLabel, chatMoment, chatTime, dayOpeners } from "../terminal/chatTimes";
import { commandArgsInline, slashCommand, transcriptTurns, type SlashCommand, type TranscriptTurn } from "../terminal/transcriptTurns";
import { bufferRows, sendToSubagent, type SubagentSendFailure } from "../terminal/subagentInput";
import { compactTokens, openSubagent, openSubagentRunning, siblingPosition, stepSibling, workingElapsed, workingModelName, type SubagentStep } from "../terminal/subagents";
import { MAX_PENDING, arrivedPending, pendingPrompt, reworded, withPending, type PendingPrompt } from "../terminal/pendingPrompts";
import { outboxPosts, type OutboxPost as ChatPost } from "../terminal/outboxPosts";
import { inboxLeaves, useInboxFiles, withoutInboxReferences } from "../terminal/inboxRefs";
import { afterClear, clearMark, type ClearMark } from "../terminal/clearedSession";
import { onHeldPatched, patchHeld, readHeld, stillHeld, writeHeld } from "../terminal/heldPrompts";
import { ageLabel, sizeLabel } from "../terminal/fileLabels";
import { resetCountdown, resetText, StatusSheet } from "./StatusSheet";
import { SignInSheet } from "./SignInSheet";
import { copiedSignIn, hasSignInTab, osc52Text, readHiddenSignIn, readSignedOut, readSignIn, signInAlternate, signInCommand, signInDone, type SignIn } from "../terminal/signIn";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";
import { isUntested } from "../../../src/lib/untested";
import { draftPrefix, draftPrefixes, forgetSlashCommand, readSlashCommands, rememberSlashCommand, slashCli, slashSuggestions, toggleDraftPrefix, type SlashSuggestion } from "../slashCommands";
import {
  onDeviceSpeechAsked,
  prepareOnDeviceSpeech,
  speechRecognitionConstructor,
  speechRecognitionSupported,
  advanceDictation,
  DICTATION_START,
  dictationPreview,
  readDictation,
  spokenSend,
  settleDictation,
  type DictationProgress,
} from "../voiceInput";
import { startDictation, type DictationSession } from "../voiceSession";
import { speak, speechOutputSupported, spokenText, stopSpeaking, unlockSpeech } from "../speechOutput";

/** A line the dictation strip shows: a key, not a sentence, so switching the
 * language retranslates what is already on screen. */
/** The microphone's level goes straight onto the dictate button as a CSS
 * variable: it changes a dozen times a second, and nothing else reads it. */
function paintMicLevel(button: HTMLElement | null, level: number | null) {
  if (level === null) button?.style.removeProperty("--mic-level");
  else button?.style.setProperty("--mic-level", level.toFixed(2));
}

type VoiceNote = { key: TranslationKey; language?: string };
const PING_INTERVAL = 20_000;
/** Floor between two rebuilds of the reading view. */
const READABLE_INTERVAL = 120;
/** Two missed pongs. A half-open TCP connection — routine on cellular — leaves
 * `readyState` at OPEN indefinitely, so the socket looked connected and every
 * keystroke was silently buffered into a dead link. */
const PONG_GRACE = PING_INTERVAL * 2 + 5_000;
/** How long a pong may take after the page comes back into view. A locked
 * phone keeps its socket in the OPEN state whether or not the link behind it
 * survived, so a reader who unlocked and typed was writing into a dead link
 * for up to PONG_GRACE — the composer looked connected and nothing arrived —
 * and only leaving the tab and reopening it reconnected. On resume the link
 * is asked to prove itself within this much, and closed (which reconnects)
 * if it does not. */
const RESUME_GRACE = 4_000;
/** How long an input frame may wait for the desktop's `ack` before the words
 * in it count as lost. Longer than a round trip on a poor cellular link,
 * well short of PONG_GRACE: the ack is what tells a prompt "sent" from a
 * prompt buffered into a half-open socket, and a reader should learn which
 * within seconds, not after the next missed pong. */
const ACK_DEADLINE = 5_000;
/** How long the pong asked for at an overdue ack may take before the frames
 * it would vouch for count as lost (see `armAck`). */
const ACK_PROBE_GRACE = 4_000;
/** Bytes the browser may hold unsent before the link counts as stalled. The
 * phone's frames are keystrokes and prompts; this much sitting in the socket's
 * buffer is a link that has stopped taking anything. */
const STALLED_BYTES = 64 * 1024;
/** How often Focus re-reads the stored session while it is in view. The read
 * carries the last fingerprint, so an unchanged transcript costs one small
 * request and no turns cross the link. */
const TRANSCRIPT_POLL = 5_000;
/** How long after the screen last changed the stored session is re-read: the
 * agent writes an answer to its transcript as it prints it, so a change on
 * screen is the earliest sign that the file has moved. */
const TRANSCRIPT_SETTLE = 1_200;
/** How long a fresh tab's Focus chat waits on its CLI to start (or to record
 * the session a prompt from here began) before it shows the screen instead. */
const STARTING_GRACE = 30_000;
/** Turns fetched at first, and added per "Show earlier turns" tap. */
const TRANSCRIPT_STEP = 120;
/** A left→right swipe starting in this share of the screen, from the left,
 * opens the project's files; one starting further right, the status line. */
const FILES_SWIPE_ZONE = 1 / 3;

/** An agent TUI parses one stdin chunk as one key event: a chunk that opens with
 * a control byte is read as that keypress and the remainder is dropped, so
 * `Ctrl-A Ctrl-K <text> CR` in a single frame arrived as a bare submit with no
 * text at all. `agentInputWrites` splits a message into the pieces; these gaps
 * keep the TUI's reads from coalescing them back into one chunk — the same
 * shape the desktop uses when it types a command into an agent tab.
 *
 * They are best-effort, and that is why the submit does not depend on them: a
 * phone's link can hold the text frame back and deliver it together with the
 * carriage return, and a Codex TUI reads that one chunk as a paste and never
 * submits. Bracketed paste is what closes the message unambiguously; the gaps
 * only still carry sessions whose pane has the mode off. */
const AGENT_KEY_GAP = 80;
const AGENT_SUBMIT_GAP = 200;
/** How long a key walking Claude's agent list is given to show on the phone's
 * screen, which redraws only once the desktop's frames have crossed the link. */
const SUBAGENT_WALK = { waitMs: 3000, pollMs: 80 };
/** Why a message to a subagent did not go, said under the composer. */
const SUBAGENT_SEND_FAILED: Record<SubagentSendFailure, TranslationKey> = {
  not_listed: "mobile.subagent.notListed",
  ambiguous: "mobile.subagent.ambiguous",
  not_opened: "mobile.subagent.noWay",
  send_failed: "mobile.subagent.noWay",
};
/** The key every supported agent CLI reads as "stop this turn" (its spinner
 * row says `esc to interrupt`), and how long the message held back behind it
 * waits: a lone Esc followed at once by text is read as Alt+key, and the turn
 * needs a moment to wind down before the CLI takes a new prompt. */
const AGENT_INTERRUPT = "\u001b";
const AGENT_INTERRUPT_GAP = 400;
/** How long Send is held before it interrupts the agent instead of queueing. */
const SEND_HOLD_MS = 450;

/** What the new-conversation button types. Every supported scrollback agent
 * reads `/clear` as "start a new chat" — Codex too, since it grew the command.
 * Codex's own `/new` is no longer a one-keystroke act: from 0.156 it opens a
 * "Where should the new conversation run?" picker, which the button's single
 * Enter leaves waiting on the desktop (2026-09-23). */
const NEW_CONVERSATION_COMMAND = "/clear";
/** The Commit chip's sheet rows, by the prompt each sends. */
const COMMIT_LABELS: Record<CommitChoice, TranslationKey> = { own: "mobile.commit.own", state: "mobile.commit.state", split: "mobile.commit.split" };
const COMMIT_HINTS: Record<CommitChoice, TranslationKey> = { own: "mobile.commit.ownHint", state: "mobile.commit.stateHint", split: "mobile.commit.splitHint" };
const CLEAR_COMMAND = /^\s*\/clear\b/u;
const SLASH_COMMAND = /^\s*\//u;
/** A slash command owns a turn of the agent's own: `/clear` redraws and has
 * Claude run its session hooks, `/model` swaps the model or opens a picker —
 * and while it does, stdin may go unread. A message typed then reached it in
 * one read, text and CR together: a paste, whose CR is a new line, not a
 * submit — after a `/clear` the prompt sat unsent in the agent's composer. So
 * the next message after any command (and after an Undo the desktop typed)
 * waits until the screen has been quiet for COMMAND_SETTLE_QUIET, at least
 * COMMAND_SETTLE_MIN after the command and at most COMMAND_SETTLE_MAX — the
 * desktop's scheduled prefaces settle the same way (`AgentScheduleHost`). */
const COMMAND_SETTLE_MIN = 1_200;
const COMMAND_SETTLE_QUIET = 700;
const COMMAND_SETTLE_MAX = 6_000;
const COMMAND_SETTLE_POLL = 150;
/** How long an Undo that found no clear recorded yet waits before its one
 * retry: the desktop's hook writes the record as Claude starts the new chat. */
const UNDO_CLEAR_RETRY = 1_200;
/** When the Reader reads the session again after an Undo: a relaunched agent
 * takes a few seconds to come back onto the conversation it resumes. */
const UNDO_RELOADS = [2_000, 5_000, 10_000];
/** The longest the Undo chip shows its progress after the desktop took it. */
const UNDO_SETTLE_MAX = 12_000;
const CODEX_AGENT = /codex/iu;

/** Session lines the phone keeps. Matches the desktop sidecar's replay depth
 * (`pty_bridge::MOBILE_SCROLLBACK_LINES`) and the tmux `history-limit` Tabtivity
 * sets on its sessions — the three are one number by design, so what tmux
 * retains is what the replay carries and what this buffer can hold. */
const PHONE_SCROLLBACK = 10_000;
/** Rows past the live screen the per-frame tail rebuild re-reads. The screen
 * itself can still be repainted by the program; the margin is slack so the
 * history absorbs nothing a repaint could reach. */
const TAIL_MARGIN = 8;
/** Frozen history chunks each "Show earlier output" tap reveals (×400 lines). */
const REVEAL_CHUNKS = 2;
/** How far from its own bottom a scroller still counts as showing the newest
 * output. Terminal view needs only the rounding slack of one fractional cell
 * height; the reading view re-wraps, so it keeps the wider window a reader's
 * own scroll already uses there. */
const NEWEST_SLACK = 4;

/** How long the model sheet waits for the session to draw the picker `/model`
 * opens. Past it the sheet steps aside: the dialog — or the reason there is
 * none — is in the session output, and the arrow keys still answer it. */
const MODEL_PICKER_WAIT = 6_000;
/** How long after asking a CLI for its sign-in link (`askForLink`) its
 * clipboard copy is taken as the answer. */
const LINK_WAIT_MS = 5_000;
/** `hiddenSignIn`'s value once the reader hid the hidden-link notice. */
const HIDDEN_LINK = "\u0000hidden-link";
/** How long the sheet waits, after a tap, for the step *after* the one it
 * answered: Codex follows the model list with a reasoning-level list, and that
 * one is drawn only once the session has read the Enter. Past it the dialog is
 * done and the sheet steps aside. */
const SELECT_NEXT_WAIT = 700;
/** Time given to a Shift+Tab before the redrawn status line is read back. One
 * reading-view rebuild (READABLE_INTERVAL) plus the TUI's own repaint. */
const MODE_SETTLE = 340;
/** Shift+Tab presses one mode switch may cost. Longer than either CLI's cycle,
 * so a mode that is genuinely offered is always reached — and a mode that is
 * not ends the walk where it started. */
const MODE_CYCLE_LIMIT = 6;

/** Why a phone file did not reach the project inbox, by the desktop's code. */
const UPLOAD_FAILURES: Record<string, TranslationKey> = {
  file_too_large: "mobile.sendToDesktop.tooLarge",
  empty_file: "mobile.sendToDesktop.empty",
  inbox_full: "mobile.projectInbox.full",
  project_unavailable: "mobile.projectInbox.unavailable",
  tab_not_found: "mobile.inbox.failed.tabGone",
  timeout: "mobile.sendToDesktop.timeout",
  offline: "mobile.sendToDesktop.offline",
  // The desktop's own refusals when the file comes from its side.
  image_not_found: "mobile.inbox.failed.imageGone",
  no_clipboard_image: "mobile.inbox.failed.clipboardGone",
  project_ineligible: "mobile.projectInbox.notShared",
  desktop_unavailable: "mobile.inbox.failed.desktopDown",
};

/** Why the desktop could not say what it has to attach. */
const DESKTOP_LIST_FAILURES: Record<string, TranslationKey> = {
  desktop_unavailable: "mobile.desktopImages.failed.desktopDown",
  tab_not_found: "mobile.desktopImages.failed.tabGone",
  project_ineligible: "mobile.desktopImages.failed.notShared",
  timeout: "mobile.desktopImages.failed.timeout",
  offline: "mobile.desktopImages.failed.offline",
};

/** A file on its way into the project inbox — from the phone, or copied on
 * the desktop's side — one that landed, or one that did not make it. A
 * landed one waits beside the composer with its `@` reference until the
 * message goes: writing the reference into the draft while the reader types
 * would pull the text out from under their keyboard. */
interface InboxUpload {
  id: number;
  name: string;
  /** Where the bytes come from; a desktop copy never leaves the desktop. */
  source: "phone" | "desktop";
  /** The desktop's project-relative reference, once the file has landed. */
  reference?: string;
  /** Why it did not land, said after its name. */
  failure?: TranslationKey;
  /** The phone's own copy of a picture (an object URL), shown while it
   * travels and after; the inbox's copy stands in for the others. */
  preview?: string;
}

/** The inbox leaf a landed file's reference names. */
const leafOfReference = (reference: string) => reference.slice(reference.lastIndexOf("/") + 1);

/** A stored draft as the composer shows it: the inbox references it carried
 * (`withAttachments` folded them in when the screen went away) lifted back
 * out as landed files beside the draft, not as `@` text in it. */
function liftedDraft(stored: string): { text: string; uploads: InboxUpload[] } {
  const leaves = inboxLeaves(stored);
  if (leaves.length === 0) return { text: stored, uploads: [] };
  const lifted = withoutInboxReferences(stored);
  return {
    text: lifted && /\s$/u.test(stored) ? `${lifted} ` : lifted,
    // Negative ids: never one `uploadSeq` hands out.
    uploads: leaves.map((leaf, index) => ({ id: -1 - index, name: leafName(leaf), source: "phone", reference: `${NAMES.inboxDir}/${leaf}` })),
  };
}

/** Whether a file is still on its way — Send waits for it. */
const uploadInFlight = (upload: InboxUpload) => !upload.failure && upload.reference === undefined;

/** The draft with the landed files' `@` references after it — what Send
 * sends, and what the draft store keeps when the screen goes away. */
function withAttachments(text: string, uploads: readonly InboxUpload[]): string {
  const references = uploads.flatMap((upload) => upload.reference === undefined || upload.failure ? [] : [`@${upload.reference}`]);
  if (references.length === 0) return text;
  return `${text}${text && !/\s$/u.test(text) ? " " : ""}${references.join(" ")} `;
}

/** How often an agent tab re-reads its CLI's usage panel for the facts row's
 * 5h/week figures. The desktop answers from a 60 s cache and otherwise runs
 * the CLI once (`services::agent_usage`), so this stays well above that. */
const LIMITS_POLL = 120_000;

/** Whether two reads of the stored session carry the same turns, so an
 * unchanged answer does not repaint the view. */
function sameTranscript(a: SessionTranscript, b: SessionTranscript): boolean {
  return a.available === b.available && a.truncated === b.truncated && a.agentsEarlier === b.agentsEarlier && a.version === b.version
    && a.entries.length === b.entries.length
    && a.entries.every((entry, index) => entry.kind === b.entries[index].kind && entry.text === b.entries[index].text && entry.cut === b.entries[index].cut
      // A subagent's handle can arrive after its entry did.
      && entry.subagent === b.entries[index].subagent && entry.role === b.entries[index].role);
}

/** "Screenshots · 3 min ago · 1.2 MB", or "Clipboard · 1920×1080". */
function desktopImageDescription(image: DesktopImage) {
  return [
    image.source,
    image.age_secs != null ? ageLabel(image.age_secs) : "",
    image.size != null ? sizeLabel(image.size) : "",
    image.width != null && image.height != null ? `${image.width}×${image.height}` : "",
  ].filter(Boolean).join(" · ");
}

/** One logical line of the session, with the colours the program actually
 * emitted. Style is never inferred from the text — see `readableScreen`.
 *
 * `plain` keeps the emphasis and drops the palette, for the one place the
 * phone shows a line as its own text rather than as the screen: a dialog's
 * question, whose rows below it are already the phone's list (`QuestionList`).
 * A TUI paints a dialog in its own theme — Codex draws its question on a
 * near-white card — and that card transplanted into this dark view is a white
 * slab with the reading view's own type inside it. */
const ReadableRow = memo(function ReadableRow({ line, plain }: { line: ReadableLine; plain?: boolean }) {
  if (line.spans.length === 0) return <div className="readable-blank" aria-hidden="true" />;
  return <div className="readable-line">{line.spans.map((span, index) => (
    span.className || (!plain && (span.color || span.background))
      ? <span key={index} className={span.className} style={plain ? undefined : { color: span.color, background: span.background }}>{span.text}</span>
      : <span key={index}>{span.text}</span>
  ))}</div>;
});

/** More new answers than this at once is a session that was swapped in or
 * caught up on, not one that is talking: read-aloud leaves those to the eye. */
const MAX_SPOKEN_AT_ONCE = 3;

/** A block of session lines. On an agent tab they read as a chat: the
 * agent's turns on the left as printed, each prompt the user submitted as a
 * bubble on the right — the TUI's own echo of it, see `chatTurns`. A shell has
 * no turns and paints flat. Memoized on the `lines` reference: a frozen
 * history chunk and the open chunk keep theirs, so the per-frame rebuild of
 * the live tail costs nothing for however much history is on screen. */
const ReadableTurns = memo(function ReadableTurns({ lines, chat, agent, promptLabel, columns = 0 }: {
  lines: readonly ReadableLine[];
  chat: boolean;
  agent?: string;
  promptLabel: string;
  /** The pane's width, for a CLI that wrapped its own rows against it. */
  columns?: number;
}) {
  const { hold, menu } = useMessageMenu();
  if (!chat) return <>{lines.map((line) => <ReadableRow key={line.key} line={line} />)}</>;
  return <>{chatTurns(lines, agent, columns).map((turn) => {
    const shown = turn.role === "user" ? (turn.prompt ?? turn.lines) : (turn.answer ?? turn.lines);
    const rows = shown.map((line) => <ReadableRow key={line.key} line={line} />);
    // A message is a bubble — a prompt or an answer; tool output and raw
    // screen rows are not one, and a hold on them opens nothing.
    const press = turn.role === "user" || turn.answer ? hold(`screen:${turn.key}`, () => readableText(shown)) : undefined;
    const command = turn.role === "user" ? slashCommand(readableText(shown)) : null;
    if (command) return <Fragment key={turn.key}><CommandDivider command={command} label={promptLabel} press={press} /></Fragment>;
    return turn.role === "user"
      ? <div key={turn.key} className="readable-turn user" role="group" aria-label={promptLabel} data-prompt={readableText(shown)} {...press}>{rows}</div>
      : <div key={turn.key} className={turn.answer ? "readable-turn agent answer" : "readable-turn agent"} {...press}>{rows}</div>;
  })}{menu}</>;
});

/** A slash command the reader sent (`slashCommand`): the command itself is
 * a turn of the CLI's own dial, so its name reads as a rule across the chat.
 * A one-word setting rides on the rule (`/model opus`); the text of a `/goal`
 * or `/plan` is the reader's own words, so it follows as an ordinary prompt
 * bubble. Both keep the prompt's hold menu. */
function CommandDivider({ command, label, press }: {
  command: SlashCommand;
  label: string;
  press?: HoldHandlers;
}) {
  const inline = commandArgsInline(command.args);
  return <>
    <div className="readable-command" role="separator" aria-label={label} data-prompt={command.args ? `${command.name} ${command.args}` : command.name} {...press}>
      <span className="readable-command-text">{inline && command.args ? `${command.name} ${command.args}` : command.name}</span>
    </div>
    {!inline && <div className="readable-turn user command-args" role="group" aria-label={label} {...press}>
      <p className="transcript-text">{command.args}</p>
    </div>}
  </>;
}

/** One answer of the stored session as formatted text (`answerHtml`: the
 * formatting only — nothing in it loads, and a link opens only through the
 * confirmation `links` puts up). Memoized on the text, so a poll that brings
 * a new turn does not re-render every answer above it. */
const AnswerText = memo(function AnswerText({ text, links }: { text: string; links: LinkHandlers }) {
  const html = useMemo(() => answerHtml(text), [text]);
  return <div className="transcript-md" {...links} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** A prompt of the stored session, formatted the same way (`promptHtml`:
 * an answer's formatting, its single line breaks kept). */
const PromptText = memo(function PromptText({ text, links }: { text: string; links: LinkHandlers }) {
  const html = useMemo(() => promptHtml(text), [text]);
  return <div className="transcript-md" {...links} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Where a prompt bubble's inbox files come from and go to. */
interface ChatInbox {
  tabId: string;
  files: ReadonlyMap<string, OutboxFile | null>;
  onOpen: (file: OutboxFile) => void;
  onSettle?: () => void;
}

/** A prompt's words, with the files it sent from the phone drawn above them
 * as pictures — a messenger's picture with its caption — and their `@`
 * references left out of the words. Both follow from the text alone, so a
 * shown bubble keeps its shape. */
function PromptBody({ text, links, inbox }: { text: string; links: LinkHandlers; inbox?: ChatInbox }) {
  const leaves = useMemo(() => inbox ? inboxLeaves(text) : [], [inbox, text]);
  if (!inbox || leaves.length === 0) return <PromptText text={text} links={links} />;
  const words = withoutInboxReferences(text);
  return <>
    <InboxAlbum tabId={inbox.tabId} leaves={leaves} files={inbox.files} onOpen={inbox.onOpen} onSettle={inbox.onSettle} />
    {words && <PromptText text={words} links={links} />}
  </>;
}

/** A subagent the agent spawned, in its place in the chat: what it was sent
 * to do under its kind, when it started, a tap away from its own
 * conversation. Not a bubble — the agent did not say it — but a card on the
 * agent's side. One that has reported back wears the tab cards' ✓ (where its
 * CLI records that). One whose CLI has not yet recorded where its
 * conversation lives cannot be opened yet. */
function SubagentCard({ turn, label, untested, time, onOpen }: {
  turn: TranscriptTurn;
  label: string;
  untested: string;
  time?: ReactNode;
  onOpen?: (turn: TranscriptTurn) => void;
}) {
  const openable = !!turn.subagent && !!onOpen;
  return <button type="button" className="transcript-agent" disabled={!openable} aria-label={`${label}: ${turn.role ? `${turn.role} · ` : ""}${turn.text}`} onClick={() => onOpen?.(turn)}>
    <svg className="transcript-agent-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v7a4 4 0 0 0 4 4h7m-3-3 3 3-3 3" /></svg>
    <span className="transcript-agent-body">
      <small>{turn.role ?? label}{untested && <em> · {untested}</em>}</small>
      <span>{turn.text}{turn.cut && "…"}</span>
      {time}
    </span>
    {turn.finished && <AgentStatusMark status="done" />}
    {openable && <svg className="transcript-agent-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>}
  </button>;
}

/** The prompts and answers of the stored session (`api.getTranscript`), laid
 * out the same way as the screen's chat — bubbles on the right for the
 * reader's own prompts, the agent's answers on the left — from the record the
 * agent itself keeps, which reaches back past the pane's scrollback and
 * carries no tool status. `cut` marks text the desktop bounded. A plan the
 * agent put up for approval is an answer bubble headed and outlined as the
 * plan. A subagent the agent spawned is a card (`SubagentCard`) that opens
 * its conversation.
 * As in a messenger, each bubble carries its time in the corner and a day
 * chip opens each day (`chatTimes`); a record with no stamp has neither.
 * What the agent sent to the phone sits after the record it followed
 * (`outboxPosts`), as picture messages.
 * `part` draws only the settled chat or only the prompts the desktop still
 * holds (`queued`), so the agent at work can be drawn between the two; both
 * halves key and date their bubbles from the whole of `entries`. */
const TranscriptTurns = memo(function TranscriptTurns({ entries, part, cutLabel, promptLabel, planLabel = "", planUntested = "", agentLabel = "", agentUntested = "", onOpenAgent, onResend, onEdit, posts, renderPost, inbox }: {
  entries: SessionTranscript["entries"];
  part?: "settled" | "queued";
  cutLabel: string;
  promptLabel: string;
  /** The heading over a plan's bubble, and its untested mark. */
  planLabel?: string;
  planUntested?: string;
  agentLabel?: string;
  agentUntested?: string;
  onOpenAgent?: (turn: TranscriptTurn) => void;
  /** Send a prompt the link lost once more, by its pending id. */
  onResend?: (pending: number) => void;
  /** Rewrite a prompt the desktop still holds, by its pending id. */
  onEdit?: (pending: number) => void;
  /** The agent's files to draw after each record, by its index. */
  posts?: ReadonlyMap<number, readonly ChatPost[]>;
  renderPost?: (post: ChatPost) => ReactNode;
  /** The files a prompt sent into the project inbox, shown in its bubble as
   * pictures in place of their `@` references (`InboxAlbum`). */
  inbox?: ChatInbox;
}) {
  // One bubble per record, keyed by its time (`transcriptTurns`).
  const turns = useMemo(() => transcriptTurns(entries), [entries]);
  const { hold, menu } = useMessageMenu();
  const { links, sheet: linkSheet } = useChatLinks();
  const t = useT();
  // A messenger's day chip over the first message of each day (`dayOpeners`).
  const openers = useMemo(() => dayOpeners(turns.map((turn) => turn.stamp)), [turns]);
  const now = new Date();
  const dayLabels = { today: t("mobile.transcript.today"), yesterday: t("mobile.transcript.yesterday") };
  const timesUntested = isUntested("mobile.transcript.times");
  return <>{turns.map((turn, index) => {
    if (part && (part === "queued") !== (turn.queued === true)) return null;
    const moment = chatMoment(turn.stamp);
    const time = moment && <small className="transcript-time">{chatTime(moment)}</small>;
    return <Fragment key={turn.key}>
    {openers.has(index) && moment && <div className="transcript-day" role="separator">
      <span>{chatDayLabel(moment, now, dayLabels)}{timesUntested && <em> · {t("mobile.focus.untested")}</em>}</span>
    </div>}
    {turn.kind === "agent"
      ? <SubagentCard turn={turn} label={agentLabel} untested={agentUntested} time={time} onOpen={onOpenAgent} />
      : turn.questions
      ? <AskedCard questions={turn.questions} label={t("mobile.transcript.asked")} notAnswered={t("mobile.transcript.notAnswered")} untested={isUntested("mobile.focus.askedCard") ? t("mobile.focus.untested") : ""} time={time} press={hold(turn.key, () => turn.text)} />
      : turn.command
      ? <CommandDivider command={turn.command} label={promptLabel} press={hold(turn.key, () => turn.text)} />
      : turn.kind === "prompt"
      ? <div className={inbox && inboxLeaves(turn.text).length > 0 ? "readable-turn user with-files" : "readable-turn user"} role="group" aria-label={promptLabel} data-prompt={turn.text} data-send-failed={turn.failed || undefined} {...hold(turn.key, () => turn.text, turn.held && onEdit && turn.pending !== undefined ? onEdit.bind(null, turn.pending) : undefined)}>
          <PromptBody text={turn.text} links={links} inbox={inbox} />
          {turn.cut && <small className="transcript-cut">{cutLabel}</small>}
          {time}
          {/* The link never acknowledged this prompt's frames: it stays where
              it is, says so, and offers to go again (a shown bubble never
              changes or moves). While the resend waits it says that. */}
          {turn.retrying
            ? <small className="transcript-send-state" role="status">{t("mobile.transcript.sendingAgain")}</small>
            : turn.failed && <small className="transcript-send-state failed" role="alert">
                {t("mobile.transcript.notDelivered")}
                {onResend && turn.pending !== undefined && <button type="button" onClick={() => onResend(turn.pending as number)}>{t("mobile.transcript.resend")}</button>}
                {isUntested("mobile.link.ack") && <em>{t("mobile.newTab.untested")}</em>}
              </small>}
        </div>
      : <div className={turn.plan ? "readable-turn agent answer plan" : "readable-turn agent answer"} role={turn.plan ? "group" : undefined} aria-label={turn.plan ? planLabel : undefined} {...hold(turn.key, () => turn.text)}>
          {turn.plan && <small className="transcript-plan-head">{planLabel}{planUntested && <em> · {planUntested}</em>}</small>}
          <AnswerText text={turn.text} links={links} />
          {turn.cut && <small className="transcript-cut">{cutLabel}</small>}
          {time}
        </div>}
    {renderPost && posts?.get(turn.index)?.map((post) => <Fragment key={post.key}>{renderPost(post)}</Fragment>)}
  </Fragment>;
  })}{menu}{linkSheet}</>;
});

/** The stored preference key for a tab: the agent behind it, or the shell. */
function viewAgentOf(tab: TabRow): string {
  return tab.kind === "agent" ? (tab.agent_label ?? "agent") : "shell";
}

/** The view a tab opens in: the reader's last choice for its agent, else Focus
 * on an agent tab — the stored session is the one reading of it that holds
 * whole turns — and Terminal on a shell. A Focus nobody chose hands over to
 * Terminal once the session turns out not to read (see `viewChosen`). */
function initialView(tab: TabRow): TerminalViewChoice {
  return readTerminalView(viewAgentOf(tab)) ?? (tab.kind === "agent" ? "focus" : "terminal");
}

/** Why an agent tab's stored session is not shown, for the dimmed toggle. */
function noSessionReason(transcript: SessionTranscript | null): TranslationKey {
  if (!transcript) return "mobile.focus.sessionLoading";
  switch (transcript.reason) {
    case "unsupported": return "mobile.focus.sessionUnsupported";
    case "no_session": return "mobile.focus.sessionNoId";
    case "no_transcript": return "mobile.focus.sessionMissing";
    default: return "mobile.focus.sessionUnreadable";
  }
}

/**
 * The question the session is waiting on, as a phone list: the dialog's own
 * rows in its own order, laid out as the model and mode sheets lay theirs out
 * (`OptionSheet`), each a tap that answers it. It sits inline in the reading view rather than in a sheet — the question
 * is part of the conversation, and a modal over it would hide what it asks.
 *
 * Like `OptionSheet` it renders what the caller resolved and reports taps
 * back: no parsing, no keystrokes. The row the dialog highlights is marked as
 * the one Enter would take, not as an answer already given.
 */
/** The mark Claude Code asks agents to put on the option they would pick. It
 * is shown as a tag beside the label rather than as part of it. */
const RECOMMENDED = /\s+\((Recommended)\)$/u;

function QuestionList({ prompt, tabs, tabFocus, tabSubmit, question, sent, sendingLabel, onPick, onType, onStep }: {
  prompt: SelectPrompt;
  /** The headers of the questions the dialog asks (`readQuestionTabs`). */
  tabs: readonly QuestionTab[];
  /** The step of `tabs` on screen — `tabs.length` for Submit, null when the
   * row does not say (`questionTabFocus`). */
  tabFocus: number | null;
  /** Whether the tab row ends in a Submit step. */
  tabSubmit: boolean;
  /** The dialog's own question — the lines `prompt.question` points at. It is
   * the list's heading here, so it is shown in the reading view's own voice
   * (`plain`): a TUI paints its dialog in its own theme, and Codex's light
   * card dropped into this dark view is a white slab. */
  question: readonly ReadableLine[];
  /** The printed number of the row a tap answered with, while the session has
   * not redrawn yet: that row says so, and no row can be tapped again. */
  sent?: number;
  sendingLabel: string;
  onPick: (option: SelectOption) => void;
  /** The free-text row (`freeTextRow`) answered with the words typed under it. */
  onType: (option: SelectOption, text: string) => void;
  /** Walks the dialog's tab row from step `from` to step `to`. */
  onStep: (from: number, to: number) => void;
}) {
  const t = useT();
  /** A question that asks several: its headers are steps of the dialog's tab
   * row, walked with ←/→ or a tap, so an answer can be changed before Submit. */
  const last = tabs.length - (tabSubmit ? 0 : 1);
  const stepped = last > 0;
  const busy = sent !== undefined;
  const stepClass = (answered: boolean, index: number) =>
    [answered && "answered", index === tabFocus && "current"].filter(Boolean).join(" ") || undefined;
  return <>
    {tabs.length > 0 && !stepped && <div className="question-tabs">
      {tabs.map((tab, index) => <span key={index} className={tab.answered ? "answered" : undefined}>{tab.answered && "✓ "}{tab.label}</span>)}
    </div>}
    {stepped && <div className="question-tabs stepped" role="toolbar" aria-label={t("terminal.reader.questionSteps")}>
      <button className="question-step" aria-label={t("terminal.reader.questionPrevious")} disabled={busy || tabFocus === 0}
        onClick={() => (tabFocus === null ? onStep(1, 0) : onStep(tabFocus, tabFocus - 1))}>←</button>
      {tabs.map((tab, index) => <button key={index} className={stepClass(tab.answered, index)} aria-current={index === tabFocus ? "step" : undefined}
        disabled={busy || tabFocus === null || index === tabFocus}
        onClick={() => tabFocus !== null && onStep(tabFocus, index)}>{tab.answered && "✓ "}{tab.label}</button>)}
      {tabSubmit && <button className={stepClass(false, tabs.length)} aria-current={tabFocus === tabs.length ? "step" : undefined}
        disabled={busy || tabFocus === null || tabFocus === tabs.length}
        onClick={() => tabFocus !== null && onStep(tabFocus, tabs.length)}>{t("terminal.reader.questionSubmitStep")}</button>}
      <button className="question-step" aria-label={t("terminal.reader.questionNext")} disabled={busy || tabFocus === last}
        onClick={() => (tabFocus === null ? onStep(0, 1) : onStep(tabFocus, tabFocus + 1))}>→</button>
      {isUntested("mobile.question.steps") && <em>{t("mobile.focus.untested")}</em>}
    </div>}
    {question.length > 0 && <div className="question-ask">
      {question.map((line) => <ReadableRow key={line.key} line={line} plain />)}
    </div>}
    <QuestionRows
      rows={prompt.options.map((option) => ({
        key: option.number,
        label: option.label,
        ...(prompt.review ? { title: t("terminal.reader.questionSubmitStep") } : {}),
        description: option.description,
        current: option.index === prompt.current,
        freeText: freeTextRow(option),
        pending: sent === option.number,
      }))}
      disabled={sent !== undefined}
      sendingLabel={sendingLabel}
      onPick={(row) => { const option = prompt.options.find((entry) => entry.number === row.key); if (option) onPick(option); }}
      onType={(row, text) => { const option = prompt.options.find((entry) => entry.number === row.key); if (option) onType(option, text); }}
      typeNote={isUntested("mobile.question.freeText") && <em>{t("mobile.focus.untested")}</em>}
    />
  </>;
}

/**
 * A question the agent asked, kept in the chat once it is answered: the card
 * the live one was (`QuestionList`), its rows no longer taps — the ones the
 * answer took ticked, an answer typed instead of picked as a row of its own,
 * and a question turned down saying so. It is one record, so it is drawn once
 * and never changes.
 */
function AskedCard({ questions, label, notAnswered, untested, time, press }: {
  questions: readonly AskedQuestion[];
  label: string;
  notAnswered: string;
  untested: string;
  time: ReactNode;
  press: HoldHandlers;
}) {
  return <div className="transcript-screen transcript-asked" role="group" aria-label={label} {...press}>
    <small>{label}{untested && <> · {untested}</>}</small>
    {questions.map((asked, index) => {
      const typed = asked.answer !== undefined && !asked.options?.some((option) => option.chosen);
      return <Fragment key={index}>
        {asked.header && <div className="question-tabs"><span>{asked.header}</span></div>}
        <div className="question-ask"><div className="readable-line">{asked.question}</div></div>
        <ul className="option-list question-list asked-list">
          {asked.options?.map((option, row) => {
            const recommended = RECOMMENDED.exec(option.label);
            return <li key={row} className={option.chosen ? "chosen" : undefined}>
              <span>
                <strong>{recommended ? option.label.slice(0, recommended.index) : option.label}{recommended && <em className="question-recommended">{recommended[1]}</em>}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
              {option.chosen && <span className="asked-check" aria-hidden="true">✓</span>}
            </li>;
          })}
          {typed && <li className="chosen"><span><strong>{asked.answer}</strong></span><span className="asked-check" aria-hidden="true">✓</span></li>}
        </ul>
        {asked.answer === undefined && <small className="asked-none">{notAnswered}</small>}
      </Fragment>;
    })}
    {time}
  </div>;
}

/** `pickModel`: the tab card's model was tapped, so the session opens with its
 * model picker already up — once, as soon as the session has drawn.
 * `subagent`: one was picked off the tab card's subagent list, so the session
 * opens in Focus on that subagent's own conversation. */
export function Terminal({ tab, project, back, pickModel = false, subagent, signInTab: openedToSignIn = false, openTab }: {
  tab: TabRow;
  /** The project the tab belongs to, for the files drawer a swipe from the
   * left of the output opens (`ProjectFiles`). */
  project?: string;
  back: () => void;
  pickModel?: boolean;
  subagent?: SubagentStep;
  /** The tab exists only to sign its CLI in (`src/lib/agents/signInLaunch.ts`):
   * the sign-in sheet is up from the start. The row says so too
   * (`TabRow.sign_in`), for a sign-in tab reached any other way. */
  signInTab?: boolean;
  /** Shows another tab of the same project in place of this one. */
  openTab?: (tab: TabRow, opts?: { signIn?: boolean }) => void;
}) {
  // From the tab list, or after the PWA reloaded on the way back from the
  // sign-in page, only the row knows — and without it the sheet lost its
  // retry, its other way in and the Done that closes the tab.
  const signInTab = openedToSignIn || tab.sign_in === true;
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const wideHint = useRef<HTMLDivElement>(null);
  const readableHost = useRef<HTMLElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** Re-reads the emulated screen on demand — used when Focus is opened, so the
   * reading view is current instead of waiting for the next output byte. */
  const refreshReadable = useRef<() => void>(() => {});
  /** Hands bytes to the socket. `prompt` tags the frame with the pending
   * bubble it belongs to, so a lost frame marks that bubble and not the
   * composer's generic notice. */
  const write = useRef<(value: string, prompt?: number) => boolean>(() => false);
  const recognition = useRef<DictationSession>();
  const dictateButton = useRef<HTMLButtonElement>(null);
  const connectedRef = useRef(false);
  const voiceRequest = useRef(0);
  const voiceProgress = useRef<DictationProgress>(DICTATION_START);
  const copiedTimer = useRef<number>();
  const sendTimers = useRef<number[]>([]);
  /** When this screen last sent a slash command, and last drew output from
   * the pane: what `sendAgentText` waits on before typing after a command. */
  const commandSentAt = useRef(0);
  const lastOutputAt = useRef(0);
  /** Messages waiting for a command to settle, in the order they were sent. */
  const settleQueue = useRef<{ writes: string[]; prompt?: number; settles: boolean }[]>([]);
  /** Whether the attached pane has bracketed paste on right now. xterm tracks
   * the mode from the same stream it renders, and tmux forwards the pane's
   * DECSET 2004 to every client, so the phone knows what the agent supports
   * without asking the desktop. */
  const bracketedPaste = useRef<() => boolean>(() => false);
  /** The bottom rows of the attached screen as drawn: Claude's agent list
   * is walked by them (`subagentInput`). */
  const screenRows = useRef<() => string[]>(() => []);
  const [viewportHeight, setViewportHeight] = useState<number>();
  const [connected, setConnected] = useState(false);
  const [stoppedReason, setStoppedReason] = useState("");
  const [altScreen, setAltScreen] = useState(false);
  /** The alternate screen's visible frame, on an agent tab. It is not session
   * output — it is repainted whole and has no scrollback behind it — so it
   * reaches neither the reading view nor the history; it is read for the two
   * facts only the live screen carries: the choice the session is waiting on,
   * and whether its turn is still running. */
  const [altFrame, setAltFrame] = useState<ReadableLine[]>([]);
  const [ctrl, setCtrl] = useState(false);
  /** The Ctrl / Esc / Tab … key row under the composer, folded away until
   * the composer's keys button opens it. Folding it drops a held Ctrl, which
   * would otherwise wait unseen on the next key. */
  const [keysShown, setKeysShown] = useState(false);
  const toggleKeys = () => {
    if (keysShown) setCtrl(false);
    setKeysShown(!keysShown);
  };
  const [sendFailed, setSendFailed] = useState(false);
  /** `initialView`: the reader's choice for this agent, else Focus on an
   * agent tab and Terminal on a shell. */
  // A subagent picked off the card is read in Focus, whatever the reader's
  // choice — without making it their choice.
  const subagentTab = useRef(subagent && tab.kind === "agent" ? tab.id : null);
  const [view, setView] = useState<TerminalViewChoice>(() => subagentTab.current === tab.id ? "focus" : initialView(tab));
  /** Whether `view` is the reader's own choice. Only a default Focus falls
   * back to Terminal when the stored session does not read; a Focus the
   * reader picked stays, reading the screen instead. */
  const viewChosen = useRef(readTerminalView(viewAgentOf(tab)) !== null);
  const chooseView = (next: TerminalViewChoice) => {
    viewChosen.current = true;
    setView(next);
    writeTerminalView(viewAgentOf(tab), next);
  };
  /** The composer's text, restored from the phone's own store (`drafts.ts`):
   * leaving for the tab list unmounts this screen and the phone cold-starts the
   * PWA whenever it likes, and a message half-typed on the way to the desk was
   * gone by the time the reader came back to finish it. */
  const [draft, setDraft] = useState(() => liftedDraft(readDraft(tab.id)).text);
  /** The draft as it stands, for the two writers below — neither of them may
   * re-subscribe per keystroke. */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** The files beside the composer (`uploads` below), for the same writers. */
  const uploadsRef = useRef<InboxUpload[]>([]);
  /** A held prompt being rewritten in the composer (`startEdit`), by its
   * pending id, with the draft it pushed aside. The composer's text is then
   * the prompt's, not the tab's draft: the draft store keeps `before`. */
  const [editing, setEditing] = useState<{ id: number; before: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** What the draft store keeps for this tab: never a held prompt's words
   * mid-edit, which a later Send would otherwise deliver a second time. */
  const savedDraft = () => editingRef.current?.before ?? withAttachments(draftRef.current, uploadsRef.current);
  /** An edit is on its way to the desktop. */
  const [editSending, setEditSending] = useState(false);
  /** The composer grows with its draft, line by line, up to the CSS
   * max-height, then scrolls; an emptied draft drops it back to one line. */
  useLayoutEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);
  const [lines, setLines] = useState<ReadableLine[]>([]);
  const [clipped, setClipped] = useState(false);
  /** The screen the live readers look at: the scrollback's tail, or — while a
   * fullscreen agent draws on the alternate screen — the frame it is holding.
   * Everything read off the screen rather than out of the stored session (the
   * status facts, the model picker, the question waiting on the reader,
   * whether the turn is still running) reads this. The reading view and the
   * history never do: an alternate screen has no scrollback to grow them
   * from. */
  const liveScreen = useMemo(() => (altScreen ? altFrame : lines), [altScreen, altFrame, lines]);
  /** The browser sign-in an agent is waiting on (`signIn.ts`): a notice over
   * the composer, and the sheet that finishes it from the phone. A notice the
   * reader hid stays hidden for that link only — a retry prints a new one. */
  const screenSignIn = useMemo(() => (tab.kind === "agent" ? readSignIn(liveScreen) : null), [tab.kind, liveScreen]);
  const [signInSheet, setSignInSheet] = useState(signInTab);
  const [hiddenSignIn, setHiddenSignIn] = useState("");
  /** A sign-in whose page went to the desktop's browser with no link on
   * screen (`readHiddenSignIn`): the link the CLI copied when the phone asked
   * for it, and when it asked — an OSC 52 copy counts only as that answer. */
  const [copiedLink, setCopiedLink] = useState<SignIn | null>(null);
  const linkAsked = useRef(0);
  const linkTimer = useRef(0);
  const [linkAsking, setLinkAsking] = useState(false);
  const [linkMissing, setLinkMissing] = useState(false);
  /** The absorbed earlier output, republished for render whenever it grows.
   * The log itself lives in a ref inside the terminal effect; this is only the
   * render snapshot (chunk references are stable, so revealing is cheap). */
  const [earlier, setEarlier] = useState<{ chunks: HistoryChunk[]; open: ReadableLine[]; dropped: boolean }>(
    { chunks: [], open: [], dropped: false },
  );
  /** How many frozen chunks are revealed above the open chunk + tail. */
  const [revealed, setRevealed] = useState(1);
  /** Scroll position captured when revealing, so prepended lines do not shove
   * the text the reader was looking at (WebKit has no overflow-anchor). */
  const revealAnchor = useRef<{ height: number; top: number }>();
  const [atBottom, setAtBottom] = useState(true);
  /** `atBottom`, readable from a callback that must not resubscribe to see it
   * change — the reading view's resize observer below. */
  const atBottomRef = useRef(true);
  const followReadable = (value: boolean) => {
    atBottomRef.current = value;
    setAtBottom(value);
  };
  /** The prompt the answer at the top of Focus belongs to — the last one
   * that starts above the scroll position — while its bubble is scrolled off
   * the top, pinned there so that answer is read against the question that
   * asked for it; empty while any prompt bubble is in view, that one or a
   * newer one further down (the reader already shows a prompt, and a pinned
   * older one would read as the question to the answer below it). Read off
   * the chat as drawn (`data-prompt`), so the stored session and the screen
   * reading pin alike. The subagent index sticks over the top of the chat:
   * a bubble behind it is out of sight too, and the pin sits under it
   * (`pinnedTop`, px below the view's top) — drawn over it, it was hidden. */
  const [pinnedPrompt, setPinnedPrompt] = useState("");
  const [pinnedTop, setPinnedTop] = useState(0);
  const pinnedPromptEl = useRef<HTMLElement | null>(null);
  const checkPinnedPrompt = useCallback(() => {
    const stream = readableHost.current;
    const prompts = stream?.querySelectorAll<HTMLElement>("[data-prompt]") ?? [];
    const view = stream?.getBoundingClientRect();
    const index = stream?.querySelector<HTMLElement>(":scope > .chat-index");
    const top = Math.max(view?.top ?? 0, index?.getBoundingClientRect().bottom ?? 0);
    const bottom = view?.bottom ?? 0;
    setPinnedTop(top - (view?.top ?? 0));
    let owner: HTMLElement | null = null;
    for (let i = prompts.length - 1; i >= 0; i--) {
      const box = prompts[i].getBoundingClientRect();
      // A bubble with no height is one not laid out (a hidden page), not one
      // scrolled away; one wholly below the view is not read yet.
      if (box.height === 0 || box.top >= bottom) continue;
      owner = box.bottom <= top ? prompts[i] : null;
      break;
    }
    pinnedPromptEl.current = owner;
    setPinnedPrompt((owner?.dataset.prompt ?? "").trim());
  }, []);
  /** Whether Terminal view is panned to the newest rows. Kept from the box's
   * own scroll events rather than measured when it is wanted: a resize is the
   * moment the answer is needed and the moment it is already gone, because
   * shrinking the box raises its maximum scroll offset without moving
   * `scrollTop` — the bottom slides under the composer and the box reads as
   * scrolled up ever after. */
  const atNewest = useRef(true);
  const [lastSent, setLastSent] = useState("");
  /** The CLI this tab runs, as the composer's `/` menu keys its store, and the
   * slash commands this phone has sent that CLI before (`slashCommands.ts`). */
  const slashCliKey = slashCli(tab.agent_label ?? tab.label);
  const hiddenLink = useMemo(
    () => (tab.kind === "agent" && !screenSignIn ? readHiddenSignIn(liveScreen, slashCliKey) : null),
    [tab.kind, screenSignIn, liveScreen, slashCliKey],
  );
  // The copied link lives as long as the page the CLI copied it from.
  const signIn = screenSignIn ?? (hiddenLink ? copiedLink : null);
  /** The session saying its sign-in went through, and a session asking for
   * one — a failed turn's "Not logged in", a start screen's login choice —
   * which the notice over the composer then offers to sign in for. */
  const signedIn = useMemo(() => (tab.kind === "agent" ? signInDone(liveScreen) : false), [tab.kind, liveScreen]);
  const signedOut = useMemo(
    () => (tab.kind === "agent" && !signInTab && !signIn && !hiddenLink ? readSignedOut(liveScreen) : false),
    [tab.kind, signInTab, signIn, hiddenLink, liveScreen],
  );
  const [signedOutHidden, setSignedOutHidden] = useState(false);
  const [openingSignIn, setOpeningSignIn] = useState(false);
  const [signInError, setSignInError] = useState("");
  const signInKeys = useRef<Record<string, string>>({});
  // A sign-in tab whose sheet the reader closed brings it back with the news.
  useEffect(() => { if (signInTab && signedIn) setSignInSheet(true); }, [signInTab, signedIn]);
  const [usedSlash, setUsedSlash] = useState(() => readSlashCommands(slashCliKey));
  const [copied, setCopied] = useState(false);
  const [voiceAvailable] = useState(() => speechRecognitionSupported());
  const [speechAvailable] = useState(() => speechOutputSupported());
  const [listening, setListening] = useState(false);
  const [preparingVoice, setPreparingVoice] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceNote | null>(null);
  const [voiceFailure, setVoiceFailure] = useState<VoiceNote | null>(null);
  /** Whether the model sheet is up. It opens on the tap that sends `/model`,
   * before the session has drawn the picker it lists. */
  const [modelSheet, setModelSheet] = useState(false);
  /** The step a tap answered, while the session is still painting it. A
   * multi-step dialog draws its next list in the same place, so the sheet
   * holds until what is on screen is a *different* list (`sameSelectStep`) —
   * or until nothing is, which is where the dialog ends. */
  const [answered, setAnswered] = useState<SelectStep | null>(null);
  /** Every row of the step on screen seen since the sheet opened. A windowed
   * picker (Claude Code's, at 24 lines, draws three of its five models) is
   * only ever a slice, so the list is what the slices add up to. */
  const [knownStep, setKnownStep] = useState<SelectStep | null>(null);
  /** The walk that makes a windowed picker draw the rows it hides: the row the
   * highlight started on, and the row the last arrow keys were sent to. The
   * highlight goes back where it was once every row is listed. */
  const [reveal, setReveal] = useState<{ origin: number; target: number } | null>(null);
  /** A walk whose keys never showed on screen is not tried again until the
   * sheet reopens; the rows already seen stay listed. */
  const revealStuck = useRef(false);
  /** Antigravity keeps the model and its effort on one dialog, and draws the
   * effort slider only for the row its highlight is on: the model a tap chose,
   * while the highlight is still walking there. Nothing is accepted until the
   * walk lands and the effort it then offers has been read. */
  const [effortFor, setEffortFor] = useState<{ number: number; label: string } | null>(null);
  /** The model the sheet is asking the effort for, once the walk has landed. */
  const [effortStep, setEffortStep] = useState<string | null>(null);
  const [modeSheet, setModeSheet] = useState(false);
  /** The status chip's sheet: the session's state and the CLI's own usage
   * panel. Opening it asks the desktop, which may run the CLI once. */
  const [statusSheet, setStatusSheet] = useState(false);
  /** The account's session (5h) and weekly windows, read off the same usage
   * panel the status sheet shows — the facts row prints them beside the
   * context figure. Empty until a read answers or for a CLI without one. */
  const [limits, setLimits] = useState<LimitMeters>({});
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const [limitsReadAt, setLimitsReadAt] = useState(() => Date.now());
  const rememberLimits = useCallback((next: LimitMeters) => {
    setLimits(next);
    setLimitsReadAt(Date.now());
  }, []);
  /** The composer's **+**: a phone file into the project inbox, an image
   * already on the desktop, or an `@`. */
  const [addSheet, setAddSheet] = useState(false);
  /** The Commit chip's sheet: commit everything, or split it up. */
  const [commitSheet, setCommitSheet] = useState(false);
  /** The "From the desktop" list: `null` while the desktop is being asked. */
  const [desktopSheet, setDesktopSheet] = useState(false);
  const [desktopImages, setDesktopImages] = useState<DesktopImage[] | null>(null);
  const [desktopFailure, setDesktopFailure] = useState<TranslationKey | "">("");
  const [uploads, setUploads] = useState<InboxUpload[]>(() => liftedDraft(readDraft(tab.id)).uploads);
  uploadsRef.current = uploads;
  // A picture's own copy is let go once its file leaves the composer.
  const previewUrls = useRef(new Set<string>());
  useEffect(() => {
    const live = new Set(uploads.flatMap((upload) => upload.preview ? [upload.preview] : []));
    for (const url of previewUrls.current) if (!live.has(url)) URL.revokeObjectURL?.(url);
    previewUrls.current = live;
  }, [uploads]);
  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL?.(url);
  }, []);
  const uploading = uploads.some(uploadInFlight);
  const attached = uploads.some((upload) => upload.reference !== undefined && !upload.failure);
  /** The pictures the agent left in the project's `.tabtivity/outbox/` for this
   * phone (the desktop's `outbox.rs`), newest first — the gallery beside the
   * tab name, and the one way an image reaches the phone from a session: a
   * terminal carries none, and Focus classifies nothing, so a path printed
   * by the agent is never guessed at. */
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
  /** This screen reads the project's outbox through its own tab — the project
   * screen reads the same files through the project (`OutboxScope`). */
  const outboxScope = useMemo(() => ({ tab: tab.id }), [tab.id]);
  /** The pictures among them, which the full-screen viewer steps through. */
  const outboxPictures = useMemo(() => outbox.filter((file) => file.kind.startsWith("image/")), [outbox]);
  /** Whether the gallery sheet is up (the button beside the tab name). */
  const [gallery, setGallery] = useState(false);
  /** The picture open full-screen. */
  const [outboxOpen, setOutboxOpen] = useState<OutboxFile | null>(null);
  /** A file the reader sent, opened from its prompt's bubble. */
  const [inboxOpen, setInboxOpen] = useState<OutboxFile | null>(null);
  /** A project file the agent's markup question is about, opened from the
   * Focus banner: its row, its folder trail (the layer's key) and its
   * folder's token (Reload lists it again). */
  const [askedFile, setAskedFile] = useState<{ file: OutboxFile; place: string; folder?: string } | null>(null);
  /** The stored session behind an agent tab (`getTranscript`): `null` until
   * the first read answers. Focus reads from it whenever it is available and
   * the reader has not switched the view to the screen. */
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  /** Prompts the composer sent that the stored session does not hold yet,
   * shown as the reader's bubbles at the end of the session chat. Those the
   * desktop still holds come back with the tab (`heldPrompts.ts`). */
  const [pending, setPending] = useState<PendingPrompt[]>(() => readHeld(tab.id));
  const pendingId = useRef(0);
  /** Where the stored session stood when this phone cleared it
   * (`clearedSession.ts`): until the new chat has a transcript of its own, what
   * the desktop answers with is the conversation just cleared. */
  const [clearedAt, setClearedAt] = useState<ClearMark | null>(null);
  /** A clear from here that can still be taken back: the Clear chip reads
   * Undo until the new chat is given a prompt (Claude only — the desktop
   * types the resume of the conversation cleared, `undoClear`). */
  const [undoable, setUndoable] = useState(false);
  /** A `/clear` sent while the agent was in a turn: the CLI queues it behind
   * the turn (Claude) — the chat on screen is not cleared yet, and its prompt
   * would be what an Undo then left behind. It starts over at the turn's end. */
  const [clearQueued, setClearQueued] = useState(false);
  /** What became of the last edit of a held prompt, shown under the composer. */
  const [editNote, setEditNote] = useState<TranslationKey | "">("");
  /** A message on its way to the open subagent, and why the last one did not
   * get there. */
  const [subagentSending, setSubagentSending] = useState(false);
  const [subagentNote, setSubagentNote] = useState<TranslationKey | "">("");
  /** Why the last Undo did nothing, shown under the composer. */
  const [undoNote, setUndoNote] = useState<TranslationKey | "">("");
  /** An Undo on its way: "asking" until the desktop takes it, then the
   * clear's mark it waits to read back (UNDO_SETTLE_MAX at most). Meanwhile
   * the chip and an empty chat say so. */
  const [undoing, setUndoing] = useState<false | "asking" | { mark: ClearMark | null }>(false);
  /** Which Undo the settle timer belongs to, so an old one ends no newer. */
  const undoRun = useRef(0);
  /** Bumped to make the Reader read the stored session again at once. */
  const [transcriptReload, setTranscriptReload] = useState(0);
  /** The new-conversation button was tapped while Codex worked — Codex refuses
   * `/clear` then, and says so only on the desktop's screen. */
  const [clearRefused, setClearRefused] = useState(false);
  const liveBusy = useMemo(() => agentWork(liveScreen) !== null, [liveScreen]);
  /** The agent is in a turn — by its screen, or by the desktop's word — so a
   * prompt sent now is held for its next idle point (`holdDraft`). */
  const agentAtWork = tab.kind === "agent" && (liveBusy || tab.agent_status === "working");
  // Once the turn is over the button works again; the note goes with it.
  useEffect(() => { if (clearRefused && !liveBusy) setClearRefused(false); }, [clearRefused, liveBusy]);
  const [focusSource, setFocusSource] = useState<"session" | "screen">("session");
  const [readAloud, setReadAloud] = useState(() => readFlag("focusReadAloud"));
  const [voiceRemote, setVoiceRemote] = useState(() => readFlag("voiceRemote"));
  /** Only a phone with an on-device recognizer for the dictation language has
   * anything to choose. Android's Chrome has the API but no model, so `available`
   * existing is not enough: without the probe the menu offered a choice the
   * phone ignored, dictating with its speech service either way. */
  const [voiceLocalOffered, setVoiceLocalOffered] = useState(false);
  /** The language read-aloud and dictation use, and whether its picker is
   * open. Only the picker reads this state — the speaking and listening sites
   * ask `speechTag()` for the stored value at the moment they need it, so a
   * change reaches them without a re-render of anything. */
  const [speechLang, setSpeechLang] = useState<SpeechLang>(() => readSpeechLang());
  const [speechLangSheet, setSpeechLangSheet] = useState(false);
  useEffect(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition?.available || !onDeviceSpeechAsked(Recognition)) {
      setVoiceLocalOffered(false);
      return;
    }
    let live = true;
    Recognition.available({ langs: [speechTag()], processLocally: true, quality: "dictation" })
      .then((availability) => { if (live) setVoiceLocalOffered(availability !== "unavailable"); })
      .catch(() => { if (live) setVoiceLocalOffered(false); });
    return () => { live = false; };
  }, [speechLang]);
  /** Whether the list under the Focus button is open: where an agent tab's
   * Focus reads from, the stored session or the screen. A dimmed Session row
   * says why it cannot be read — a phone shows no tooltip. */
  const [focusMenu, setFocusMenu] = useState(false);
  /** Whether Focus shows the strip with the rows the agent draws under its
   * input box (cwd, model, mode, context…). A left→right swipe opens it, a
   * right→left swipe or its ✕ closes it; never persisted. */
  const [statusStrip, setStatusStrip] = useState(false);
  /** The project's name while the desktop's "Project files on the phone"
   * switch is on for it (`detail.files`) — null while off, or unknown. */
  const [filesLabel, setFilesLabel] = useState<string | null>(null);
  /** The files drawer, the project screen's own, opened here by a left→right
   * swipe that starts in the left third of the output (or anywhere on it
   * when there is no status line to show). */
  const [filesOpen, setFilesOpen] = useState(false);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  /** Turns asked for; grows with "Show earlier turns". */
  const [transcriptLimit, setTranscriptLimit] = useState(TRANSCRIPT_STEP);
  /** The subagents walked into from the stored session (`subagents.ts`),
   * outermost first; empty while the session itself is read. */
  const [subagentPath, setSubagentPath] = useState<readonly SubagentStep[]>(() => subagent && tab.kind === "agent" ? [subagent] : []);
  const [subagentListOpen, setSubagentListOpen] = useState(false);
  /** Whether the chat's file list is open. The strip holds one open list at
   * a time: the subagents' or the files'. */
  const [sentListOpen, setSentListOpen] = useState(false);
  const openStep = subagentPath[subagentPath.length - 1];
  /** The last read of a subagent's conversation, and whose it is — a read
   * that belongs to another subagent is never drawn under this one's bar. */
  const [subRead, setSubRead] = useState<{ token: string; transcript: SessionTranscript } | null>(null);
  const [subLimit, setSubLimit] = useState(TRANSCRIPT_STEP);
  /** Where to scroll once the conversation just gone back up to is drawn. */
  const restoreScroll = useRef<number | null>(null);
  /** Bumped by every change of the screen: the settle timer re-reads the
   * session after it. */
  const [screenTick, setScreenTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The same drop, restricted to pictures and videos: an `accept` of media
   * types is what makes Android open the photo picker (and iOS the library)
   * instead of the file chooser `ANY_FILE_ACCEPT` lands in. */
  const galleryInput = useRef<HTMLInputElement>(null);
  /** Bumped when the tab changes so a late upload result lands nowhere. */
  const uploadRun = useRef(0);
  const uploadSeq = useRef(0);
  /** The reading view as it stood when a composer sheet opened. While the
   * sheet is up the session repaints under it — the `/model` picker, a status
   * line per Shift+Tab — and that churn is the sheet's *input*, not something
   * to read: the sheet lists the picker and confirms the walk from the live
   * `lines`; what is painted behind it stays still. */
  const [frozenLines, setFrozenLines] = useState<ReadableLine[] | null>(null);
  const linesRef = useRef<ReadableLine[]>([]);
  linesRef.current = lines;
  /** The pane's width in columns, as the session sees it. A CLI that wraps its
   * own output — OpenCode does — wrapped it against exactly this, which is
   * what lets the reading view put those rows back together and re-wrap them
   * at the phone's width. Carried in a ref: it changes with the pane, not with
   * the frame, and every reader of it re-runs on `lines` anyway. */
  const paneColumns = useRef(0);
  /** The mode a Shift+Tab walk is currently trying to reach. */
  const [switching, setSwitching] = useState("");
  /** A mode the walk went a full cycle without reaching. */
  const [switchFailed, setSwitchFailed] = useState("");
  /** Whether the picker was ever on screen while the model sheet was open —
   * only then does its disappearance mean the dialog is done. */
  const sawPicker = useRef(false);
  /** Cancels an in-flight mode walk when the tab changes or the user picks
   * again; the walk reads the status line between presses. */
  const modeWalk = useRef(0);
  const statusRef = useRef<SessionStatus | null>(null);

  useEffect(() => {
    setView(subagentTab.current === tab.id ? "focus" : initialView(tab));
    viewChosen.current = readTerminalView(viewAgentOf(tab)) !== null;
    // The draft is the tab's, not the screen's: this tab's own half-typed
    // message, which is nothing at all for most of them (`drafts.ts`).
    const lifted = liftedDraft(readDraft(tab.id));
    setDraft(lifted.text);
    setTranscript(null);
    // What the desktop still holds for this tab is still the reader's.
    const held = readHeld(tab.id);
    pendingId.current = held.reduce((last, prompt) => Math.max(last, prompt.id), pendingId.current);
    setPending(held);
    setEditing(null);
    setEditNote("");
    setClearedAt(null);
    setClearQueued(false);
    setClearRefused(false);
    setUndoable(false);
    setUndoNote("");
    setFocusSource("session");
    setFocusMenu(false);
    setStatusStrip(false);
    setTranscriptLimit(TRANSCRIPT_STEP);
    setLines([]);
    setClipped(false);
    setEarlier({ chunks: [], open: [], dropped: false });
    setRevealed(1);
    followReadable(true);
    atNewest.current = true;
    setLastSent("");
    setCopied(false);
    setStoppedReason("");
    setAltScreen(false);
    setAltFrame([]);
    setCtrl(false);
    setSendFailed(false);
    setModelSheet(false);
    setModeSheet(false);
    setStatusSheet(false);
    setLimits({});
    setAddSheet(false);
    setDesktopSheet(false);
    setUploads(lifted.uploads);
    uploadRun.current += 1;
    setSwitching("");
    setSwitchFailed("");
    setAnswered(null);
    setKnownStep(null);
    setReveal(null);
    sawPicker.current = false;
    // Dictation belongs to the tab it was started in. Its recognizer is aborted
    // by the effect beside `startVoice` with the handlers detached first, so no
    // `onend` ever arrives to take the old tab's words and "listening" down.
    voiceProgress.current = DICTATION_START;
    setVoicePreview("");
    setVoiceStatus(null);
    setVoiceFailure(null);
    setListening(false);
    setPreparingVoice(false);
    return () => {
      window.clearTimeout(copiedTimer.current);
      sendTimers.current.forEach(window.clearTimeout);
      sendTimers.current = [];
      settleQueue.current = [];
      commandSentAt.current = 0;
      // Abandons a mode walk still waiting between two Shift+Tabs.
      modeWalk.current += 1;
    };
  }, [tab.id]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncHeight = () => setViewportHeight(viewport.height);
    syncHeight();
    viewport.addEventListener("resize", syncHeight);
    return () => viewport.removeEventListener("resize", syncHeight);
  }, []);

  // The one full-bleed screen has to be the one screen the *document* cannot
  // scroll. `body` keeps a 100dvh floor for the scrolling sections while this
  // screen is sized to the visual viewport, so the document is taller than what
  // is on glass — and everything a phone does about that is a scroll that takes
  // the header with it. Three ways in practice: arriving from the bottom of a
  // long project screen, or from far down the agents list, keeps that scroll
  // offset; focusing the composer makes the browser
  // scroll the header away to seat the keyboard; and an agent tab has its own
  // way in, because `addContext` and the two attach paths focus the composer
  // *for* the reader, so the scroll arrives unasked after a tap on the ＋ sheet.
  // The header carries the back chevron, and the body below it eats
  // vertical drags (`touch-action:none` plus the drag handler in
  // terminal/touchScroll.ts), so once it is off screen there is no way back to
  // the project at all. Take the overflow away for as long as the terminal is
  // mounted — and pull the page back up first, since hiding the overflow under a
  // scrolled document leaves it scrolled, which is the same trap with no scroll
  // bar left to escape it.
  useLayoutEffect(() => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    document.body.classList.add("terminal-open");
    return () => document.body.classList.remove("terminal-open");
  }, []);


  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({
      // The rendered terminal is an output and scroll surface. Text always
      // comes from the native composer below, which is more reliable on phone
      // keyboards and keeps accidental taps from editing a live agent prompt.
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      fontSize: 14,
      scrollback: PHONE_SCROLLBACK,
      theme: phoneTerminalTheme(),
    });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); fit.fit();
    // A theme picked while the terminal is open repaints it too.
    const themeWatch = new MutationObserver(() => { term.options.theme = phoneTerminalTheme(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setCopiedLink(null);
    setLinkAsking(false);
    setLinkMissing(false);
    linkAsked.current = 0;
    // A clipboard copy the session makes is read only as the sign-in link the
    // phone just asked for (`askForLink`); any other copy stays on the desktop.
    // Guarded like the trim emitter below: a stand-in terminal has no parser.
    term.parser?.registerOscHandler(52, (data) => {
      if (Date.now() - linkAsked.current > LINK_WAIT_MS) return true;
      const link = copiedSignIn(osc52Text(data) ?? "");
      if (link) {
        linkAsked.current = 0;
        setLinkAsking(false);
        setCopiedLink(link);
        setSignInSheet(true);
      }
      return true;
    });
    bracketedPaste.current = () => term.modes.bracketedPasteMode === true;
    screenRows.current = () => bufferRows(term.buffer.active);
    // The history log needs to know when xterm trims scrollback (row indices
    // shift), and xterm has no public event for it — so this rides the internal
    // buffer list's own trim emitter, guarded: when a future xterm renames it,
    // the view falls back to the bounded whole-screen rebuild instead of
    // showing wrong lines.
    const history = emptyHistory();
    type TrimEvent = (listener: (amount: number) => void) => { dispose(): void };
    const trimEventOf = () => (term as unknown as {
      _core?: { _bufferService?: { buffers?: { normal?: { lines?: { onTrim?: TrimEvent } } } } };
    })._core?._bufferService?.buffers?.normal?.lines?.onTrim;
    let trimWatch: { dispose(): void } | undefined;
    // `term.reset()` — the replay boundary below — builds a *new* normal
    // buffer, and a listener on the old one's trim emitter then never fires
    // again. Left as it was, the first reconnect silently detached the log from
    // trims: once the 10k scrollback filled, `history.end` stopped following the
    // buffer and the absorbed rows drifted onto the wrong lines. Re-armed after
    // every reset instead.
    const watchTrim = () => {
      trimWatch?.dispose();
      const trimEvent = trimEventOf();
      trimWatch = typeof trimEvent === "function"
        ? trimEvent((amount) => shiftHistory(history, amount))
        : undefined;
    };
    watchTrim();
    const resetHistory = () => {
      history.chunks = [];
      history.open = [];
      history.end = 0;
      history.droppedLines = 0;
      history.lost = false;
      setEarlier({ chunks: [], open: [], dropped: false });
    };
    let readableFrame = 0;
    let readableScrollFrame = 0;
    let readableTimer = 0;
    let lastReadable = 0;
    const renderReadable = () => {
      const buffer = term.buffer?.active;
      if (!buffer) return;
      paneColumns.current = term.cols;
      const stream = readableHost.current;
      // The reading view is unmounted in Terminal view. A shell tab has no
      // other reader of these lines, so re-reading the screen there is pure
      // waste on a phone battery — but an agent tab's model and mode facts still do:
      // the mode walk confirms every Shift+Tab against the redrawn status line
      // and the model sheet lists the picker, both from `lines`. Left stale in
      // Terminal view, a walk pressed its full lap and reported a failure on a
      // session that had switched on the second press. The lazy history keeps
      // this to the live tail, so the rebuild is cheap; only the scroll follow
      // needs the stream.
      if (!stream && tab.kind !== "agent") return;
      lastReadable = Date.now();
      const followOutput = stream != null && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
      // The alternate screen has no scrollback, so the reading view would show
      // only the visible frame, rebuild it on every redraw, and lose the lot
      // when the program exits. Say so instead of showing a collapsing view —
      // and never absorb its frames into the history: they are a full-screen
      // program's repaints, not session output.
      const alternate = buffer.type === "alternate";
      setAltScreen(alternate);
      if (alternate) {
        // An agent CLI can draw its whole session here — Claude Code does under
        // `"tui": "fullscreen"`, OpenCode's full TUI always — and then a
        // question it is waiting on sits on this frame and nowhere else: the
        // stored session only grows at message boundaries, and there is no
        // scrollback the reading view could grow from. So the frame is read for
        // the live readers, and still absorbed nowhere.
        if (tab.kind === "agent") setAltFrame(readableScreen(buffer).lines);
        return;
      }
      setAltFrame((held) => (held.length > 0 ? [] : held));
      if (trimWatch) {
        // Rows that left the tail window are converted once and kept; only the
        // tail — the live screen plus a margin — is re-read per frame.
        const grew = absorbHistory(buffer, history, term.rows + TAIL_MARGIN);
        const tail = readableRange(buffer, history.end, buffer.length, lastHistoryText(history));
        while (tail.length > 0 && tail[tail.length - 1].text === "") tail.pop();
        setLines(tail);
        if (grew) {
          setEarlier({
            chunks: [...history.chunks],
            open: history.open,
            dropped: history.droppedLines > 0 || history.lost,
          });
        }
        setClipped(false);
      } else {
        const screen = readableScreen(buffer);
        setLines(screen.lines);
        setClipped(screen.clipped);
      }
      if (stream && followOutput) {
        cancelAnimationFrame(readableScrollFrame);
        readableScrollFrame = requestAnimationFrame(() => {
          stream.scrollTo({ top: stream.scrollHeight });
          followReadable(true);
        });
      }
    };
    // A busy agent repaints many times a second. Rebuilding the reading view on
    // every one of those frames burned battery and made the text jitter under a
    // reader's eyes without adding anything they could follow.
    const updateReadable = () => {
      if (readableTimer) return;
      const wait = Math.max(0, READABLE_INTERVAL - (Date.now() - lastReadable));
      readableTimer = window.setTimeout(() => {
        readableTimer = 0;
        cancelAnimationFrame(readableFrame);
        readableFrame = requestAnimationFrame(() => {
          renderReadable();
          // The tick's one reader is the session settle read, which only an
          // agent tab has (`sessionFocus`). On a shell tab in Terminal view
          // `renderReadable` changes no state, so bumping it anyway re-rendered
          // this whole screen ~8×/s for as long as a command streamed.
          if (tab.kind === "agent") setScreenTick((tick) => tick + 1);
        });
      }, wait);
    };
    refreshReadable.current = updateReadable;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let lastPong = 0;
    /** Pongs received on the current socket — what the resume check compares,
     * since two timestamps in one millisecond would read as no pong. */
    let pongs = 0;
    /** Binary input frames sent on the current socket. The desktop counts the
     * ones it wrote to the PTY the same way and acks each by that ordinal, so
     * nothing has to ride on a raw keystroke frame. */
    let inputFrames = 0;
    /** Frames the desktop has not acked yet, by ordinal: when they went, and
     * the pending bubble they carry a piece of. One past its deadline stays
     * here, `late`, until its socket goes: an ack that comes after all still
     * takes the marker back down. */
    const unacked = new Map<number, { at: number; prompt?: number; late?: boolean }>();
    let ackTimer = 0;
    /** `inputFrames` at each ping still waiting for its pong. The desktop
     * reads the socket in order, so a pong vouches for every frame sent
     * before its ping — which is also all a sidecar that predates the ack
     * says about them. */
    const pingMarks: number[] = [];
    /** Whether an interruption notice is already on screen for this outage:
     * one line per outage, not one per reconnect attempt. */
    let interrupted = false;
    const markPrompt = (id: number, state: { failed: boolean; retrying: boolean }) => {
      setPending((current) => current.map((prompt) => prompt.id === id ? { ...prompt, ...state } : prompt));
    };
    /** Give up on every unacked frame older than `olderThan`: its bubble is
     * marked not delivered, or, for a keystroke with no bubble, the
     * composer's notice goes up. `lost` (a close, a replay) also forgets
     * them — no ack can come for them any more. */
    const failUnacked = (olderThan: number, lost = false) => {
      const failed = new Set<number>();
      let bare = false;
      for (const [seq, entry] of unacked) {
        if (entry.at > olderThan) continue;
        if (lost) unacked.delete(seq);
        if (entry.late) continue;
        entry.late = true;
        if (entry.prompt === undefined) bare = true;
        else failed.add(entry.prompt);
      }
      for (const id of failed) markPrompt(id, { failed: true, retrying: false });
      if (bare) setSendFailed(true);
    };
    /** Everything up to the `seq`-th frame reached the PTY (frames are
     * ordered). A bubble whose last frame is in clears its marker, and so
     * does the composer's notice once no late keystroke is left. */
    const acked = (seq: number) => {
      const delivered = new Set<number>();
      let bare = false;
      for (const [frame, entry] of unacked) {
        if (frame > seq) continue;
        unacked.delete(frame);
        if (entry.prompt !== undefined) delivered.add(entry.prompt);
        else if (entry.late) bare = true;
      }
      const waiting = [...unacked.values()];
      for (const id of delivered) {
        if (!waiting.some((entry) => entry.prompt === id)) markPrompt(id, { failed: false, retrying: false });
      }
      if (bare && !waiting.some((entry) => entry.late && entry.prompt === undefined)) setSendFailed(false);
    };
    const sendPing = (socket: WebSocket) => {
      pingMarks.push(inputFrames);
      socket.send(JSON.stringify({ type: "ping" }));
    };
    /** An overdue ack is not yet a lost frame: a late ack (behind a burst of
     * output) or a desktop that predates acks left the marker flickering up on
     * every prompt and the composer's notice up after every keystroke. Past
     * the deadline the link is asked for a pong — which vouches for every
     * frame sent before its ping — and only what that has not cleared within
     * ACK_PROBE_GRACE counts as lost. */
    const armAck = () => {
      if (ackTimer || ![...unacked.values()].some((entry) => !entry.late)) return;
      ackTimer = window.setTimeout(() => {
        const overdue = Date.now() - ACK_DEADLINE;
        const socket = ws;
        if (socket?.readyState === WebSocket.OPEN && [...unacked.values()].some((entry) => !entry.late && entry.at <= overdue)) {
          sendPing(socket);
          ackTimer = window.setTimeout(() => {
            ackTimer = 0;
            failUnacked(overdue);
            armAck();
          }, ACK_PROBE_GRACE);
          return;
        }
        ackTimer = 0;
        failUnacked(overdue);
        armAck();
      }, ACK_DEADLINE);
    };
    // Returns whether the bytes were handed to an open socket that is still
    // taking them. Callers that confirm something to the user must not claim
    // success on a `false`; the ack is what confirms delivery.
    write.current = (value, prompt) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      // Buffered bytes the socket is not draining are the earliest sign of a
      // stalled link — earlier than the missed pongs that would close it.
      if (ws.bufferedAmount > STALLED_BYTES) return false;
      ws.send(new TextEncoder().encode(value));
      inputFrames += 1;
      unacked.set(inputFrames, { at: Date.now(), prompt });
      armAck();
      return true;
    };
    // tmux sizes a window to its widest client and pans every narrower one
    // across it. Adopting the window geometry the server reports is what keeps
    // the phone from receiving a silently cropped, cursor-following slice; the
    // offscreen emulator's column count never had to match the physical screen.
    let windowSize: { cols: number; rows: number } | undefined;
    let wide: WideOutputHint | undefined;
    let anchorFrame = 0;
    // The screen is as tall as the desktop window, so on a phone its last rows
    // — the live prompt and the newest output — sit below the fold. Show that
    // end of it; the rows above are one drag away (terminal/touchScroll.ts).
    // Deferred a frame because xterm sizes the screen element on its own
    // render, after this returns.
    const anchorNewest = () => {
      cancelAnimationFrame(anchorFrame);
      anchorFrame = requestAnimationFrame(() => {
        const box = host.current;
        if (box) box.scrollTop = box.scrollHeight;
        atNewest.current = true;
        wide?.sync();
      });
    };
    const applySize = () => {
      const rows = term.rows;
      if (windowSize) {
        if (term.cols !== windowSize.cols || term.rows !== windowSize.rows) {
          term.resize(windowSize.cols, windowSize.rows);
        }
      } else {
        fit.fit();
        // Without a window frame the fitted size is what goes to the desktop,
        // and a size outside the protocol's bounds is answered with a close
        // that never retries. A landscape phone with its keyboard up fits fewer
        // rows than the floor; clamp to what the desktop accepts.
        const cols = Math.min(TERMINAL_SIZE.maxCols, Math.max(TERMINAL_SIZE.minCols, term.cols));
        const rows = Math.min(TERMINAL_SIZE.maxRows, Math.max(TERMINAL_SIZE.minRows, term.rows));
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      }
      // A changed row count moves the view, and so does a box that was showing
      // the newest rows before this resize — the keyboard opening and the
      // composer growing both shrink it, and without this the live prompt and
      // the newest output slide under the composer and stay there. A reader
      // panned up into the screen keeps their place through either.
      if (term.rows !== rows || atNewest.current) anchorNewest();
      wide?.sync();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    /** The desktop said the session lapsed (`session_expired`): the next
     * connect renews it first — the device key signs a fresh challenge, no
     * PIN — since the upgrade would only meet a 401 otherwise. */
    let relogin = false;
    const visibility = createVisibilityReporter(() => document.visibilityState === "visible");
    /** The link is down: the composer stops looking live, whatever the
     * socket still owed an ack for is marked not delivered, and dictation —
     * which types into this link — ends. Shared by a close, a closing frame
     * that ends the session, and a link this code judged dead itself. */
    const dropLink = () => {
      connectedRef.current = false;
      voiceRequest.current += 1;
      // Whatever this socket still owed an ack for is gone with it.
      failUnacked(Number.POSITIVE_INFINITY, true);
      setConnected(false);
      setPreparingVoice(false);
      const activeRecognition = recognition.current;
      if (activeRecognition) {
        recognition.current = undefined;
        activeRecognition.abort();
        paintMicLevel(dictateButton.current, null);
        setListening(false);
        setVoiceStatus(null);
        setVoiceFailure({ key: "mobile.voice.disconnected" });
      }
    };
    /** The next attempt, on the backoff. The server attaches to the persisted
     * tmux session again on reconnect, so its screen/history is replayed. Do
     * not clear the local screen: it keeps the last rendered state useful
     * while a phone wakes or switches between Wi-Fi and cellular. */
    const reconnectLater = () => {
      // Once per outage: a long one used to print this on every attempt,
      // which walked the screen away from what the reader was reading.
      if (!interrupted) {
        interrupted = true;
        term.write(`\r\n\x1b[33m[${translate(useI18nStore.getState().lang, "mobile.terminal.interrupted")}]\x1b[0m\r\n`);
      }
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
      reconnectAttempt += 1;
      // A session that ended on the desktop refuses the upgrade at the HTTP
      // layer, so no `closing` frame can ever say why — the phone would show
      // "reconnecting…" forever. After two straight failures, ask the tab
      // endpoint; a transient network failure keeps the reconnect loop.
      if (reconnectAttempt >= 2) {
        void api<{ tab: TabRow }>(`/api/v1/tabs/${tab.id}`)
          .then((body) => { if (!body.tab.available) throw new ApiError(410, "session_gone"); })
          .catch((reason) => {
            if (stopped || !(reason instanceof ApiError)) return;
            if (reason.status !== 404 && reason.status !== 410) return;
            stopped = true;
            clearTimeout(reconnectTimer);
            setStoppedReason(describeFailure("session_gone"));
          });
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, delay);
    };
    /** A link this code judged dead — no pong, a send buffer not draining —
     * is let go of at once. `close()` alone left it to `onclose`, which on a
     * silent link the browser fires only once the closing handshake times
     * out; until then `readyState` read CLOSING, the screen still said
     * connected, and neither the ping tick nor `resume` would act on it.
     * Detached here, its late `onclose` and anything it still delivers are
     * ignored (`ws !== next`); the desktop evicts the old viewer when the new
     * socket attaches. */
    const abandon = (socket: WebSocket) => {
      if (stopped || ws !== socket) return;
      ws = null;
      socket.close();
      dropLink();
      reconnectLater();
    };
    const connect = () => {
      if (stopped) return;
      if (relogin) {
        relogin = false;
        void recoverSession().finally(() => { if (!stopped) connect(); });
        return;
      }
      const next = new WebSocket(`${scheme}://${location.host}/api/v1/tabs/${tab.id}/terminal`, TERMINAL_PROTOCOL);
      ws = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        if (stopped || ws !== next) return;
        reconnectAttempt = 0;
        connectedRef.current = true;
        lastPong = Date.now();
        pongs = 0;
        inputFrames = 0;
        pingMarks.length = 0;
        interrupted = false;
        setConnected(true);
        setSendFailed(false);
        // A retryable close (`idle_timeout`) explained itself and then
        // reconnected; the explanation must not outlive the outage, or it sat
        // over the composer for the rest of the session.
        setStoppedReason("");
        next.send(JSON.stringify({ type: "ready" }));
        applySize();
      };
      // An error is always followed by `close`, which does the reconnecting;
      // this exists so the failure is not an unhandled event.
      next.onerror = () => {
        if (ws === next) connectedRef.current = false;
      };
      // A closing frame that ends the session tore the link down already
      // (below), and an unmount must not set state: both leave `stopped`.
      next.onclose = () => {
        if (stopped || ws !== next) return;
        dropLink();
        reconnectLater();
      };
      next.onmessage = (event) => {
        if (ws !== next) return;
        if (event.data instanceof ArrayBuffer) {
          lastOutputAt.current = Date.now();
          term.write(new Uint8Array(event.data), updateReadable);
          return;
        }
        if (typeof event.data !== "string") return;
        let control: TerminalEvent;
        try {
          control = JSON.parse(event.data) as TerminalEvent;
        } catch {
          return;
        }
        if (control.type === "pong") {
          lastPong = Date.now();
          pongs += 1;
          const mark = pingMarks.shift();
          if (mark !== undefined) acked(mark);
          return;
        }
        if (control.type === "ack") {
          acked(control.seq);
          return;
        }
        if (control.type === "replay") {
          // The desktop sends this once, before it reads any input: frames the
          // phone sent ahead of it are still to be written and acked, not lost.
          // The server is about to resend the session. Without an explicit
          // boundary the replay was appended to whatever was already on screen,
          // so each reconnect left another copy of the same agent turn — and a
          // reader could not tell one destructive command from three.
          // The history log goes with it: the replay re-delivers the session,
          // so keeping the absorbed copy would double every line.
          term.reset();
          watchTrim();
          resetHistory();
          setLines([]);
          return;
        }
        if (control.type === "features") {
          // This desktop takes visibility reports: say so if the page is
          // already hidden, and from here on at every change.
          if (control.visibility) visibility.supported(next);
          return;
        }
        if (control.type === "window") {
          windowSize = { cols: control.cols, rows: control.rows };
          applySize();
          return;
        }
        if (control.type === "closing") {
          // An end the desktop chose (`replaced`, `access_revoked`, …) is
          // torn down here, on its frame: `stopped` makes the `onclose` that
          // follows a no-op, so leaving it to that left the composer live and
          // the unacked prompts pending under the sentence below. That
          // sentence is the whole explanation; nothing goes on the screen.
          if (!control.retry && !stopped) {
            stopped = true;
            clearTimeout(reconnectTimer);
            dropLink();
          }
          // The session lapsed, not the tab: renew it and come back.
          if (control.reason === "session_expired") relogin = true;
          setStoppedReason(describeFailure(control.reason));
        }
      };
    };
    connect();
    // xterm retains an internal textarea for accessibility even with stdin
    // disabled. Explicitly disable and remove it from tab order so a tap can
    // neither summon a second keyboard nor become a second input route.
    if (term.textarea) {
      term.textarea.disabled = true;
      term.textarea.tabIndex = -1;
      term.textarea.setAttribute("aria-hidden", "true");
    }
    const terminalHost = host.current;
    const removeTouchScroll = installTerminalTouchScroll(terminalHost, term);
    // Both the drag handler and `anchorNewest` scroll the box, and both arrive
    // here. `NEWEST_SLACK` absorbs the sub-pixel cell height that leaves a
    // fitted screen a fraction short of its own scroll extent.
    const followNewest = () => {
      atNewest.current =
        terminalHost.scrollHeight - terminalHost.scrollTop - terminalHost.clientHeight <= NEWEST_SLACK;
    };
    terminalHost.addEventListener("scroll", followNewest, { passive: true });
    // A fresh session starts at column one, whatever the previous tab was
    // panned to.
    terminalHost.scrollLeft = 0;
    if (wideHint.current) wide = installWideOutputHint(terminalHost, wideHint.current);
    anchorNewest();
    let resizeTimer = 0;
    let resizeFrame = 0;
    // A pending reading-view frame is left alone: the keyboard opening fires a
    // burst of viewport resizes, and cancelling the frame here dropped the
    // rebuild of whatever output had just arrived — the next byte, if any,
    // was the only thing that brought it back.
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(applySize, 100);
      });
    };
    // A backgrounded PWA can be frozen before React unmounts, so the release
    // has to go out on `pagehide` too — otherwise the server holds the tab.
    const release = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" }));
    };
    window.addEventListener("pagehide", release);
    // Hidden is not gone: the socket stays (no replay on the way back), and
    // the desktop is told nobody is looking, so an agent's notice is not held
    // back for a phone in a pocket (`terminal/visibility.ts`).
    document.addEventListener("visibilitychange", visibility.changed);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    // A phone can change the terminal's usable width without firing a window
    // resize (for example when browser chrome or a split-screen divider moves).
    // Keep xterm and the PTY in lockstep so long output is reflowed at the
    // visible right edge instead of leaving a stale, wider canvas behind.
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(resize);
    resizeObserver?.observe(terminalHost);
    const ping = window.setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      // The server answers every ping. Silence past the grace window means the
      // link is gone even though the browser still reports OPEN, so let go of
      // it and reconnect. So does a send buffer the socket is not draining —
      // the earlier tell of the same dead link.
      if ((lastPong && Date.now() - lastPong > PONG_GRACE) || ws.bufferedAmount > STALLED_BYTES) {
        abandon(ws);
        return;
      }
      sendPing(ws);
    }, PING_INTERVAL);
    // The page came back into view — a phone unlocked, the app switched back
    // to. A socket that closed while it was away has its reconnect waiting on
    // a backoff timer that was frozen with the page: run it now. One the
    // browser still reports OPEN is asked for a pong within RESUME_GRACE and
    // abandoned otherwise, which starts the ordinary reconnect without waiting
    // for the browser's close; before this the composer stayed enabled on a
    // dead link until PONG_GRACE ran out, and typing went nowhere.
    let resumeTimer = 0;
    const resume = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = ws;
      if (!current || current.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        connect();
        return;
      }
      if (current.readyState !== WebSocket.OPEN) return;
      const seen = pongs;
      sendPing(current);
      clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        if (stopped || ws !== current || current.readyState !== WebSocket.OPEN) return;
        if (pongs === seen) {
          reconnectAttempt = 0;
          abandon(current);
        }
      }, RESUME_GRACE);
      updateReadable();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      stopped = true;
      connectedRef.current = false;
      voiceRequest.current += 1;
      refreshReadable.current = () => {};
      write.current = () => false;
      bracketedPaste.current = () => false;
      screenRows.current = () => [];
      clearTimeout(reconnectTimer);
      clearTimeout(ackTimer);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" }));
      ws?.close();
      trimWatch?.dispose();
      themeWatch.disconnect();
      term.dispose();
      window.clearTimeout(linkTimer.current);
      clearInterval(ping);
      clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      clearTimeout(resizeTimer);
      clearTimeout(readableTimer);
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(readableFrame);
      cancelAnimationFrame(readableScrollFrame);
      cancelAnimationFrame(anchorFrame);
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", visibility.changed);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      terminalHost.removeEventListener("scroll", followNewest);
      removeTouchScroll();
      wide?.dispose();
    };
  }, [tab.id]);
  useEffect(() => { if (view === "focus") refreshReadable.current(); }, [view]);
  // The reading view has the problem Terminal view's box has: the keyboard
  // opening, or the composer growing under a long draft, shrinks it without
  // moving its scroll offset, so the newest turn slides under the composer.
  // There it also stops following output, because the follow test is the
  // distance to the bottom the shrink just opened up — nothing came back until
  // the reader found "Jump to latest". Put it back on the newest whenever it
  // was there before the resize.
  useEffect(() => {
    const stream = readableHost.current;
    if (!stream || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => stream.scrollTo({ top: stream.scrollHeight }));
    });
    observer.observe(stream);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // The stored session mounts the reading view over a full-screen program
    // too, so its availability re-runs this as well.
  }, [view, altScreen, focusSource, transcript?.available]);
  // A default Focus on an agent whose transcript is never read (`unsupported`)
  // would only re-read the screen: open Terminal instead, without writing
  // that as the reader's choice. Every other reason is a session on its way —
  // a tab the phone just created has no session id until its hook records
  // one, a read can fail once, Codex binds its rollout late — so Focus stays,
  // reading the screen meanwhile, and paints the stored session the moment it
  // reads. It used to leave for Terminal on any of these, and since that was
  // not the reader's choice either, nothing ever brought it back.
  /** Whether the composer has the keyboard. While it does, nothing swaps the
   * view under the reader's thumbs: not the hand-over to Terminal below, and
   * not a read that answers a shown chat `available: false` — on a desktop
   * under full load the window misses the call's deadline, the host answers
   * from the tab record instead, and the chat used to drop to the screen and
   * come back with the next read, mid-sentence. Such an answer is only noted
   * (`transcriptHeld`); letting go of the composer reads the session afresh. */
  const [composerTyping, setComposerTyping] = useState(false);
  const transcriptHeld = useRef(false);
  const typingStopped = () => {
    setComposerTyping(false);
    if (!transcriptHeld.current) return;
    transcriptHeld.current = false;
    setTranscriptReload((count) => count + 1);
  };
  // Asks the page rather than `composerTyping`: a composer disabled while it
  // had focus (the link dropped) loses it without a blur event.
  const showTranscript = (next: SessionTranscript) => setTranscript((current) => {
    const typing = !!composerInput.current && document.activeElement === composerInput.current;
    if (typing && current?.available && !next.available) {
      transcriptHeld.current = true;
      return current;
    }
    transcriptHeld.current = false;
    return current && sameTranscript(current, next) ? current : next;
  });
  useEffect(() => {
    // A just-sent prompt is still a useful Reader conversation when Codex has
    // not produced a readable rollout yet. Keep its local bubble on screen
    // instead of swapping to the terminal and making it vanish mid-turn.
    if (!viewChosen.current && !composerTyping && view === "focus" && transcript?.available === false && transcript.reason === "unsupported"
      && (!CODEX_AGENT.test(tab.agent_label ?? tab.label) || pending.length === 0)) setView("terminal");
  }, [view, transcript, pending, tab.agent_label, tab.label, composerTyping]);
  /** Whether Focus is reading the stored session rather than the screen. */
  const sessionFocus = tab.kind === "agent" && view === "focus" && focusSource === "session";
  const transcriptVersion = useRef<string | undefined>();
  const transcriptRequest = useRef<AbortController>();
  useEffect(() => { transcriptVersion.current = transcript?.version; }, [transcript]);
  /** Reads the stored session: on open, every TRANSCRIPT_POLL while the page
   * is visible, and TRANSCRIPT_SETTLE after the screen last changed. A read
   * that answers `unchanged` keeps what is shown; one that fails keeps it too
   * and the next read retries. An unavailable session (a shell, an agent
   * whose transcript is not read, no desktop) hands Focus to the screen. */
  useEffect(() => {
    if (tab.kind !== "agent" || view !== "focus") return;
    let stopped = false;
    const read = () => {
      if (stopped || document.visibilityState === "hidden") return;
      transcriptRequest.current?.abort();
      const controller = new AbortController();
      transcriptRequest.current = controller;
      void getTranscript(tab.id, transcriptVersion.current, transcriptLimit, controller.signal).then(
        (next) => {
          if (stopped || controller.signal.aborted) return;
          // A malformed answer is a failed read: keep what is shown.
          if (!next || typeof next !== "object" || next.unchanged) return;
          // A forced full read (after an Undo) answers the same session: keep
          // what is shown, but ask by its version again from here on.
          transcriptVersion.current = next.version;
          showTranscript(next);
        },
        () => {},
      );
    };
    read();
    const timer = window.setInterval(read, TRANSCRIPT_POLL);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      transcriptRequest.current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [tab.id, tab.kind, view, transcriptLimit, transcriptReload]);
  useEffect(() => {
    if (!sessionFocus || screenTick === 0) return;
    const timer = window.setTimeout(() => {
      transcriptRequest.current?.abort();
      const controller = new AbortController();
      transcriptRequest.current = controller;
      void getTranscript(tab.id, transcriptVersion.current, transcriptLimit, controller.signal).then(
        (next) => {
          if (controller.signal.aborted || !next || typeof next !== "object" || next.unchanged) return;
          showTranscript(next);
        },
        () => {},
      );
    }, TRANSCRIPT_SETTLE);
    return () => window.clearTimeout(timer);
  }, [screenTick, sessionFocus, tab.id, transcriptLimit]);
  /** Where the live screen's input box begins — `liveScreen.length` while the
   * CLI has not drawn one yet (still starting, or a dialog in its place). */
  const liveFrameStart = useMemo(
    () => (tab.kind === "agent" ? inputFrameStart(liveScreen, tab.agent_label ?? tab.label) : liveScreen.length),
    [tab.kind, tab.agent_label, tab.label, liveScreen],
  );
  const cliReady = liveFrameStart < liveScreen.length;
  /** Whether the screen already holds a conversation: a prompt echo above
   * the input box, or more history than a CLI's banner fills. */
  const promptOnScreen = useMemo(() => {
    const label = tab.agent_label ?? tab.label;
    const echo = (line: ReadableLine) => isLiveEcho(line, label);
    return earlier.chunks.length > 0 || earlier.open.some(echo) || (altScreen && lines.some(echo))
      || liveScreen.slice(0, liveFrameStart).some(echo);
  }, [tab.agent_label, tab.label, earlier, altScreen, lines, liveScreen, liveFrameStart]);
  const [startGaveUp, setStartGaveUp] = useState(false);
  useEffect(() => setStartGaveUp(false), [tab.id]);
  /** Nothing drawn yet: no history, and every live row blank. */
  const screenBlank = earlier.chunks.length === 0 && earlier.open.length === 0 && liveScreen.every((line) => !line.text.trim());
  /** A fresh tab whose session has nothing to read yet: the CLI is starting
   * and has recorded no session (or, before the first read answers, has drawn
   * nothing at all). Its screen is only the CLI's banner, so Focus shows the
   * session chat — a loading row while the CLI starts, then the empty chat —
   * rather than painting that banner as a conversation. A screen that already
   * holds a conversation (the session read lost) keeps the screen, and so
   * does one that waited past `STARTING_GRACE` (`startGaveUp`). */
  const preSessionWait = sessionFocus && !startGaveUp
    && (transcript === null ? screenBlank : !transcript.available && (transcript.reason === "no_session" || transcript.reason === "no_transcript"))
    && (!promptOnScreen || pending.length > 0);
  /** The stored session is what Focus paints: available, and not switched
   * away from — or a fresh tab's, before it holds anything (`preSessionWait`).
   * Until the first read answers on a tab with a conversation on screen, the
   * screen is shown, so the view never opens blank. */
  // Codex can report a fresh session before it has a rollout to read, then
  // temporarily report `no_transcript` while it binds that rollout. A prompt
  // sent from this phone remains part of the Reader during that hand-off.
  const sessionShown = sessionFocus && (transcript?.available === true || preSessionWait
    || (pending.length > 0 && CODEX_AGENT.test(tab.agent_label ?? tab.label)));
  /** The session chat's entries: the stored ones, with each prompt sent
   * from here held in its place (`withPending`). */
  /** The new chat's records while the one cleared from here is still what the
   * desktop answers with; `null` once another session is read. */
  const sinceClear = useMemo(() => afterClear(transcript?.entries ?? [], clearedAt), [transcript, clearedAt]);
  // The Undo is done once the session read holds the cleared conversation's
  // last record again (at once, when that conversation was empty).
  useEffect(() => {
    if (typeof undoing !== "object") return;
    if (undoing.mark && afterClear(transcript?.entries ?? [], undoing.mark) === null) return;
    setUndoing(false);
  }, [undoing, transcript]);
  const storedEntries = useMemo(() => sinceClear ?? transcript?.entries ?? [], [sinceClear, transcript]);
  const sessionEntries = useMemo(() => withPending(storedEntries, pending), [storedEntries, pending]);
  const sessionAgents = useMemo(() => sessionEntries.filter((entry) => entry.kind === "agent"), [sessionEntries]);
  /** Earlier turns not read in hold a subagent — the index's "+". A long
   * session that never spawned one would otherwise read "Subagents (0+)". */
  const agentsEarlier = !!transcript?.truncated && !!transcript.agentsEarlier && !sinceClear;
  /** A prompt the desktop still holds sits below the agent at work. */
  const queuedShown = sessionEntries.some((entry) => entry.queued);
  /** The files the agent sent while this conversation ran, as its messages. */
  // The gallery holds every file of the project; the chat only what this tab sent.
  const chatPosts = useMemo(() => outboxPosts(sessionEntries, outbox.filter((file) => file.from_tab)), [sessionEntries, outbox]);
  /** What the phone sent into the inbox, as the chat's prompts and the
   * composer name it — described once by the desktop for their previews. */
  const promptLeaves = useMemo(() => [...new Set(sessionEntries.flatMap((entry) => entry.kind === "prompt" ? inboxLeaves(entry.text) : []))], [sessionEntries]);
  const inboxNamed = useMemo(() => [...new Set([
    ...promptLeaves,
    ...uploads.flatMap((upload) => upload.reference === undefined || upload.failure ? [] : [leafOfReference(upload.reference)]),
  ])], [promptLeaves, uploads]);
  const inboxFiles = useInboxFiles(tab.id, inboxNamed);
  /** Both directions' files, for the list beside the subagent index. */
  const chatFiles = useMemo(() => sentFiles(outbox, promptLeaves, inboxFiles), [outbox, promptLeaves, inboxFiles]);
  /** The open subagent's conversation, once read. */
  const subToken = openStep?.token;
  const subTranscript = subRead && subRead.token === subToken ? subRead.transcript : null;
  // Another tab is another session, with subagents of its own. Not on the
  // first run: a subagent picked off the card is open from the start.
  const pathTab = useRef(tab.id);
  useEffect(() => {
    if (pathTab.current === tab.id) return;
    pathTab.current = tab.id;
    setSubagentPath([]);
  }, [tab.id]);
  useEffect(() => { setSubagentListOpen(false); setSentListOpen(false); }, [tab.id]);
  useEffect(() => { setSubagentNote(""); }, [tab.id, subToken]);
  useEffect(() => { setSubLimit(TRANSCRIPT_STEP); }, [subToken]);
  /** Reads the open subagent's conversation as the session itself is read: at
   * once, then every TRANSCRIPT_POLL while the page is visible — a subagent
   * still at work keeps writing. */
  useEffect(() => {
    if (!subToken || tab.kind !== "agent" || view !== "focus") return;
    let stopped = false;
    let version: string | undefined;
    let inflight: AbortController | undefined;
    const read = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void getTranscript(tab.id, version, subLimit, controller.signal, subToken).then(
        (next) => {
          if (stopped || controller.signal.aborted || !next || typeof next !== "object" || next.unchanged) return;
          version = next.version;
          setSubRead((current) => current && current.token === subToken && sameTranscript(current.transcript, next)
            ? current
            : { token: subToken, transcript: next });
        },
        () => {},
      );
    };
    read();
    const timer = window.setInterval(read, TRANSCRIPT_POLL);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [subToken, subLimit, tab.id, tab.kind, view]);
  /** The conversation on screen — the session's, or the open subagent's —
   * which is where a card tapped in it was opened from. */
  const levelEntries = openStep ? (subTranscript?.entries ?? []) : sessionEntries;
  const levelEntriesRef = useRef(levelEntries);
  levelEntriesRef.current = levelEntries;
  const openSubagentTurn = useCallback((turn: Pick<TranscriptTurn, "subagent" | "text" | "role">, fromList = false) => {
    const token = turn.subagent;
    if (!token) return;
    const top = readableHost.current?.scrollTop ?? 0;
    setSubagentPath((path) => openSubagent(path, { token, task: turn.text, role: turn.role }, levelEntriesRef.current, top));
    if (!fromList) setSubagentListOpen(false);
    // A conversation opens on its newest turn, as the session does.
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);
  const openListedSubagent = (entry: TranscriptEntry) => {
    if (!entry.subagent) return;
    openSubagentTurn(entry, true);
  };
  /** Back up one level, to where that conversation was scrolled. */
  const subagentUp = () => {
    if (!openStep) return;
    // Opened from outside the chat (the card's list): up lands on its newest turn.
    const fromOutside = openStep.scrollTop < 0;
    restoreScroll.current = fromOutside ? null : openStep.scrollTop;
    atBottomRef.current = fromOutside;
    setAtBottom(fromOutside);
    setSubagentPath((path) => path.slice(0, -1));
  };
  const subagentSibling = (delta: number) => {
    atBottomRef.current = true;
    setAtBottom(true);
    setSubagentPath((path) => stepSibling(path, delta));
  };
  // A prompt that went to the session (a Claude subagent's own words never
  // join `pending`): the Reader goes back to the chat it lands in.
  const pendingCount = useRef(pending.length);
  useEffect(() => {
    if (pending.length > pendingCount.current) {
      atBottomRef.current = true;
      setAtBottom(true);
      setSubagentPath([]);
    }
    pendingCount.current = pending.length;
  }, [pending.length]);
  useLayoutEffect(() => {
    const top = restoreScroll.current;
    const stream = readableHost.current;
    // Wait until the conversation gone back to is drawn.
    if (top === null || !stream || (openStep && !subTranscript)) return;
    restoreScroll.current = null;
    stream.scrollTop = top;
  }, [openStep, subTranscript]);
  /** Read-aloud: each answer that arrives at the end of the stored session is
   * spoken once. What the first read brought is history, as is anything
   * "earlier" reveals above it or a whole other session swapped in — only a
   * short new tail is news. Nothing is said over dictation: the microphone
   * would hear it. */
  const spokenKeys = useRef<Set<string> | null>(null);
  useEffect(() => {
    spokenKeys.current = null;
    return stopSpeaking;
  }, [tab.id]);
  useEffect(() => {
    if (!sessionShown || !transcript) return;
    const turns = transcriptTurns(transcript.entries);
    const seen = spokenKeys.current;
    spokenKeys.current = new Set(turns.map((turn) => turn.key));
    if (!seen || !readAloud || listening) return;
    let known = -1;
    turns.forEach((turn, index) => { if (seen.has(turn.key)) known = index; });
    const fresh = turns.slice(known + 1).filter((turn) => turn.kind === "answer");
    if (fresh.length === 0 || fresh.length > MAX_SPOKEN_AT_ONCE) return;
    const code = t("mobile.speech.code");
    for (const turn of fresh) speak(turn.key, spokenText(turn.text, code), speechTag());
  }, [sessionShown, transcript, readAloud, listening, t]);
  useEffect(() => {
    if (listening || !sessionShown) stopSpeaking();
  }, [listening, sessionShown]);
  // A new turn in the stored session, or a file the agent sent into the
  // Focus chat, scrolls the view to it, as new screen output does, unless
  // the reader has scrolled up to read.
  useLayoutEffect(() => {
    if (!sessionShown || !atBottom) return;
    const stream = readableHost.current;
    if (stream && typeof stream.scrollTo === "function") stream.scrollTo({ top: stream.scrollHeight });
  }, [sessionShown, transcript, pending, chatPosts, atBottom, subToken, subTranscript]);
  /** Reads the outbox now and every `OUTBOX_POLL` while the page is visible;
   * coming back to the page reads it at once. A listing that could not be
   * fetched keeps what was shown — the next poll retries. */
  useEffect(() => {
    setOutbox([]);
    setGallery(false);
    setOutboxOpen(null);
    setInboxOpen(null);
    let stopped = false;
    let inflight: AbortController | undefined;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      void listOutbox({ tab: tab.id }, controller.signal).then(
        (images) => {
          if (stopped || controller.signal.aborted || !Array.isArray(images)) return;
          setOutbox((current) => sameOutbox(current, images) ? current : images);
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, OUTBOX_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      inflight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tab.id]);
  /** Reads the usage panel now and every `LIMITS_POLL` while the page is
   * visible. A CLI with no usage readout stops the polling; a failed read keeps
   * what was shown — the next poll retries. */
  useEffect(() => {
    if (tab.kind !== "agent") return;
    let stopped = false;
    let last = 0;
    const poll = () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (Date.now() - last < LIMITS_POLL / 2) return;
      last = Date.now();
      void getAgentStatus(tab.id).then(
        (report) => {
          // A malformed answer is a failed read: keep what is shown.
          if (stopped || !report?.usage) return;
          if (report.usage.supported === false) {
            stopped = true;
            return;
          }
          if (report.usage.raw) rememberLimits(limitMeters(parseUsageReport(report.usage.raw)));
        },
        () => {},
      );
    };
    poll();
    const timer = window.setInterval(poll, LIMITS_POLL);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tab.id, tab.kind, rememberLimits]);
  useEffect(() => {
    if (tab.kind !== "agent") return;
    const timer = window.setInterval(() => setLimitsNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [tab.kind]);
  useEffect(() => {
    if (!outboxOpen && !gallery && !inboxOpen) return;
    // The viewer opens from the gallery, so Escape closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (outboxOpen) setOutboxOpen(null);
      else if (inboxOpen) setInboxOpen(null);
      else setGallery(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [outboxOpen, gallery, inboxOpen]);
  /** A picture, a text or a PDF opens full-screen here; in an agent tab the
   * viewer also carries **Mark up**. */
  const openOutbox = useCallback((file: OutboxFile) => setOutboxOpen(file), []);
  /** A lone picture takes its own shape once loaded; a chat following its
   * bottom follows the taller bubble (the resize observer watches the view's
   * box, not what grows inside it). */
  const settlePost = useCallback(() => {
    const stream = readableHost.current;
    if (atBottomRef.current && stream && typeof stream.scrollTo === "function") stream.scrollTo({ top: stream.scrollHeight });
  }, []);
  const renderPost = useCallback((post: ChatPost) => <OutboxPost scope={outboxScope} post={post} onOpen={openOutbox} onSettle={settlePost} />, [outboxScope, openOutbox, settlePost]);
  const chatInbox = useMemo<ChatInbox>(() => ({ tabId: tab.id, files: inboxFiles, onOpen: setInboxOpen, onSettle: settlePost }), [tab.id, inboxFiles, settlePost]);
  const inboxScope = useMemo(() => ({ inbox: tab.id }), [tab.id]);
  /** A row of the chat's file list, opened in the viewer of its side. */
  const openSentFile = useCallback(({ file, from }: SentFile) => (from === "agent" ? setOutboxOpen : setInboxOpen)(file), []);
  /** Removes one of the files the agent sent, from the tile's own confirm — the
   * same removal the project screen's shelf does, through this tab's scope. The
   * row goes now rather than at the next poll, and the sheet closes with the
   * last file rather than standing empty over the session. */
  const removeOutbox = useCallback(async (file: OutboxFile) => {
    await deleteOutboxFile({ tab: tab.id }, file.name);
    setOutbox((current) => {
      const left = current.filter((row) => row.name !== file.name);
      if (left.length === 0) setGallery(false);
      return left;
    });
    setOutboxOpen((open) => open?.name === file.name ? null : open);
  }, [tab.id]);
  /** Chunks above the revealed window stay in memory but out of the DOM — the
   * lazy half of the earlier-output log. */
  const hiddenChunks = Math.max(0, earlier.chunks.length - revealed);
  const visibleChunks = useMemo(
    () => earlier.chunks.slice(hiddenChunks),
    [earlier.chunks, hiddenChunks],
  );
  const hiddenLines = useMemo(
    () => earlier.chunks.slice(0, hiddenChunks).reduce((sum, chunk) => sum + chunk.lines.length, 0),
    [earlier.chunks, hiddenChunks],
  );
  const showEarlier = () => {
    const stream = readableHost.current;
    if (stream) revealAnchor.current = { height: stream.scrollHeight, top: stream.scrollTop };
    setRevealed((count) => count + REVEAL_CHUNKS);
  };
  // Revealing prepends content, which would shove the line the reader tapped
  // beside out of view; restore the reading position by the height delta.
  useLayoutEffect(() => {
    const anchor = revealAnchor.current;
    const stream = readableHost.current;
    if (!anchor || !stream) return;
    revealAnchor.current = undefined;
    stream.scrollTop = anchor.top + (stream.scrollHeight - anchor.height);
  }, [revealed]);
  const type = (value: string, prompt?: number) => {
    const delivered = write.current(value, prompt);
    // A prompt's frames report through their bubble; the composer's notice
    // is for keystrokes with no bubble to carry it.
    if (prompt === undefined) setSendFailed(!delivered);
    return delivered;
  };
  /** A single keypress, unmodified — what an agent's select prompts, `less` and
   * `vim` actually read. The composer's line-editor prefix would be meaningless
   * or destructive there. */
  const press = (value: string) => {
    const payload = ctrl && value.length === 1
      ? String.fromCharCode(value.toUpperCase().charCodeAt(0) & 0x1f)
      : value;
    const delivered = type(payload);
    if (ctrl) setCtrl(false);
    return delivered;
  };
  /** Run `send` after `delay`, cancelled when the screen switches tabs. */
  const later = (delay: number, send: () => void) => {
    sendTimers.current.push(window.setTimeout(send, delay));
  };
  /** Drops writes still queued behind their gaps. */
  const clearPending = () => {
    sendTimers.current.forEach(window.clearTimeout);
    sendTimers.current = [];
  };
  /** Delivers a run of writes one at a time, never as one chunk (see
   * AGENT_KEY_GAP). Only the first can be confirmed synchronously; a later one
   * that fails raises the dropped-connection notice through `type`. Shared by
   * the composer's Send and by the sheet that answers a TUI dialog with the
   * same arrow/Enter keys the on-screen key row sends. */
  const deliver = (writes: string[], prompt?: number) => {
    if (writes.length === 0) return true;
    if (!type(writes[0], prompt)) return false;
    const step = (index: number) => {
      if (index >= writes.length) return;
      // The submit gets the longer pause: it is the one write whose arrival in
      // the same read as the text would be swallowed as part of a paste.
      const gap = index === writes.length - 1 ? AGENT_SUBMIT_GAP : AGENT_KEY_GAP;
      later(gap, () => {
        if (type(writes[index], prompt)) step(index + 1);
        // A later piece refused by a socket that has since closed: the bubble
        // says so, since its first piece went and left it looking sent.
        else if (prompt !== undefined) setPending((current) => current.map((entry) => entry.id === prompt ? { ...entry, failed: true, retrying: false } : entry));
      });
    };
    step(1);
    return true;
  };
  /** One message into the agent's line editor: reset its line, deliver the
   * text, submit — inside bracketed paste markers where the pane has the mode
   * on and the family wants them (`bracketsAgentMessage`). Shared by the
   * composer's Send and the composer chips' slash commands. */
  const sendAgentText = (text: string, prompt?: number) => {
    const bracketed = bracketsAgentMessage(tab.agent_label ?? tab.label, bracketedPaste.current());
    const message = { writes: agentInputWrites(text, bracketed), prompt, settles: SLASH_COMMAND.test(text) };
    // Behind a command still settling, and behind anything already waiting on
    // one, a message queues; the writes it reports as sent go once it drains.
    if (message.writes.length > 0 && (settleQueue.current.length > 0 || !commandSettled())) {
      if (!connectedRef.current) return false;
      settleQueue.current.push(message);
      if (settleQueue.current.length === 1) later(COMMAND_SETTLE_POLL, drainSettled);
      return true;
    }
    clearPending();
    return deliverMessage(message);
  };
  /** How long `deliver` takes to put `writes` out, CR included. */
  const writesSpan = (writes: string[]) => writes.length < 2 ? 0 : (writes.length - 2) * AGENT_KEY_GAP + AGENT_SUBMIT_GAP;
  const commandSettled = () => {
    const now = Date.now();
    const since = now - commandSentAt.current;
    if (since >= COMMAND_SETTLE_MAX) return true;
    return since >= COMMAND_SETTLE_MIN && now - Math.max(lastOutputAt.current, commandSentAt.current) >= COMMAND_SETTLE_QUIET;
  };
  const deliverMessage = (message: { writes: string[]; prompt?: number; settles?: boolean }) => {
    const delivered = deliver(message.writes, message.prompt);
    // Timed from its CR, the write the agent acts on.
    if (delivered && message.settles) commandSentAt.current = Date.now() + writesSpan(message.writes);
    return delivered;
  };
  /** Types the queued messages once the command before them has settled, one
   * at a time, each after the last one's writes are out — a queued command
   * holds the ones behind it in turn. */
  const drainSettled = () => {
    if (!commandSettled()) {
      later(COMMAND_SETTLE_POLL, drainSettled);
      return;
    }
    const next = settleQueue.current.shift();
    if (!next) return;
    if (!deliverMessage(next) && next.prompt !== undefined) {
      setPending((current) => current.map((entry) => entry.id === next.prompt ? { ...entry, failed: true, retrying: false } : entry));
    }
    if (settleQueue.current.length > 0) later(writesSpan(next.writes) + AGENT_SUBMIT_GAP, drainSettled);
  };
  /** Once dictated words have left the composer by its ✕, "Heard:" stops
   * quoting them. They stay counted as inserted: the recognizer, still
   * listening, reads them back, and they must not return to the draft. */
  const forgetDictation = () => {
    voiceProgress.current = settleDictation(voiceProgress.current);
    setVoicePreview("");
  };
  /** Send ends the dictation, and a start still being prepared with it. It is
   * aborted, not stopped: a stop lets the recognizer finalize what it still
   * holds, and those words would land in the draft just emptied. */
  const endDictation = () => {
    voiceRequest.current += 1;
    setPreparingVoice(false);
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.abort();
      paintMicLevel(dictateButton.current, null);
    }
    voiceProgress.current = DICTATION_START;
    setListening(false);
    setVoicePreview("");
    setVoiceStatus(null);
  };
  /** The open subagent the composer writes to: Claude's only, the one CLI
   * whose own TUI takes words for a subagent. */
  const subagentTarget = openStep && agentFamily(tab.agent_label ?? tab.label) === "claude" ? openStep : undefined;
  /** Words for the open subagent, delivered through Claude's agent list
   * (`subagentInput`); the Reader stays on the subagent, whose conversation
   * shows them once it has taken them. Words that did not get there go back
   * into an empty composer, with the reason under it. */
  /** Types `words` as the composer would, once its last write is out. */
  const typeOut = async (words: string) => {
    const writes = agentInputWrites(words, bracketsAgentMessage(tab.agent_label ?? tab.label, bracketedPaste.current()));
    if (!deliver(writes)) return false;
    await new Promise((resolve) => window.setTimeout(resolve, writesSpan(writes) + AGENT_SUBMIT_GAP));
    return true;
  };
  const sendToOpenSubagent = (text: string, target: SubagentStep, fromComposer: boolean) => {
    setSubagentNote("");
    setSubagentSending(true);
    if (fromComposer) {
      setDraft("");
      endDictation();
    }
    void sendToSubagent({
      rows: () => screenRows.current(),
      key: async (key) => type(key),
      command: (command) => typeOut(command),
      type: () => typeOut(text),
    }, target, SUBAGENT_WALK).then((result) => {
      if (result.ok) {
        setLastSent(text);
        return;
      }
      setSubagentNote(SUBAGENT_SEND_FAILED[result.reason]);
      if (fromComposer) setDraft((current) => current || text);
    }).finally(() => setSubagentSending(false));
  };
  /** `fromComposer` false: words that are not the draft (the Commit chip's
   * prompts) — sent as a prompt like any other, the draft and an edit left
   * alone. */
  /** Whether the words left the phone, or are held for the agent's next idle
   * point — the markup view's Submit keeps its layer otherwise. */
  /** `interrupt`: the Send button's hold — a working agent is stopped and the
   * words go in at once instead of waiting for its next idle point. */
  const submitText = (text: string, fromComposer: boolean, interrupt: boolean): boolean => {
    if (editing && fromComposer) {
      submitEdit(editing, text);
      return true;
    }
    if (!connected || !text.trim()) return false;
    // Only confirm what actually left the device. `readyState === OPEN` on a
    // half-open cellular link silently buffers, and "Sent" was shown regardless.
    if (tab.kind !== "agent") {
      // A shell has no soft newline: each line is its own command line.
      if (!type(`${text.replace(/\r?\n/g, "\r")}\r`)) return false;
      setLastSent(text);
      setDraft("");
      return true;
    }
    // A slash command is the CLI's, not a turn: the session never records it,
    // so a bubble for it would wait forever. `/clear` also ends the chat the
    // earlier bubbles were waiting in.
    const slash = /^\s*\//u.test(text);
    // Words go to the open subagent; a command stays the session's.
    if (subagentTarget && !slash) {
      if (subagentSending) return false;
      sendToOpenSubagent(text, subagentTarget, fromComposer);
      return true;
    }
    const id = slash ? undefined : ++pendingId.current;
    if (id !== undefined && agentAtWork && !interrupt) {
      holdDraft(id, text, fromComposer);
      return true;
    }
    if (!(interrupt && agentAtWork ? interruptWith(text, id) : sendAgentText(text, id))) return false;
    setLastSent(text);
    setEditNote("");
    if (id === undefined) {
      if (CLEAR_COMMAND.test(text)) startedOver();
      rememberSlashCommand(slashCliKey, text);
      setUsedSlash(readSlashCommands(slashCliKey));
    } else {
      // The new chat has a prompt now: resuming the old one would leave it.
      setUndoable(false);
      setClearQueued(false);
      setUndoNote("");
      const sent = pendingPrompt(id, text, storedEntries);
      setPending((current) => [...current, sent].slice(-MAX_PENDING));
      // The phone knows the words before they leave; the desktop records them
      // as this tab's prompt — the only record of it for an agent whose
      // transcript is not read (OpenCode's cards list these).
      void reportSentPrompt(tab.id, text).catch(() => {});
    }
    if (!fromComposer) return true;
    setDraft("");
    endDictation();
    return true;
  };
  /** The composer's words go with the files that landed for them; while one
   * is still on its way nothing goes, so no reference is left behind. */
  const submitDraft = (text = draft, fromComposer = true, interrupt = false): boolean => {
    if (!fromComposer) return submitText(text, false, interrupt);
    if (uploadsRef.current.some(uploadInFlight)) return false;
    if (!submitText(withAttachments(text, uploadsRef.current), true, interrupt)) return false;
    setUploads((current) => current.filter((upload) => upload.reference === undefined));
    return true;
  };
  /** For dictation's spoken send: the session's handlers outlive the render
   * that started them. */
  const submitDraftRef = useRef(submitDraft);
  submitDraftRef.current = submitDraft;
  /** Esc stops the agent's turn; once the CLI has wound down the message is
   * typed like any other — not held for an idle point the interrupt has just
   * made. A failure after the gap marks the bubble, as a dropped piece does. */
  const interruptWith = (text: string, id?: number) => {
    clearPending();
    if (!type(AGENT_INTERRUPT)) return false;
    later(AGENT_INTERRUPT_GAP, () => {
      if (sendAgentText(text, id) || id === undefined) return;
      setPending((current) => current.map((entry) => entry.id === id ? { ...entry, failed: true, retrying: false } : entry));
    });
    return true;
  };
  /** Send held down: interrupt and send. `fired` swallows the click the
   * release still delivers, so the words do not go out twice. */
  const sendHold = useRef({ timer: 0, fired: false });
  const fireSendHold = () => {
    window.clearTimeout(sendHold.current.timer);
    if (sendHold.current.fired) return;
    sendHold.current.fired = true;
    submitDraftRef.current(undefined, true, true);
  };
  const sendHoldHandlers = {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      sendHold.current.fired = false;
      window.clearTimeout(sendHold.current.timer);
      sendHold.current.timer = window.setTimeout(fireSendHold, SEND_HOLD_MS);
    },
    onPointerUp: () => window.clearTimeout(sendHold.current.timer),
    onPointerLeave: () => window.clearTimeout(sendHold.current.timer),
    onPointerCancel: () => window.clearTimeout(sendHold.current.timer),
    // The browser's own long press (a tooltip, a callout) is this hold.
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      if (tab.kind === "agent" && !editing) fireSendHold();
    },
  };
  /** Whether a prompt sent now is held — what `submitDraft` decides on, read
   * by the markup view's Submit, which outlives the render it began in. */
  const agentAtWorkRef = useRef(agentAtWork);
  agentAtWorkRef.current = agentAtWork;
  /** The markup view's Submit: the desktop's prompt goes out like a typed
   * one — into the agent's queue while it works (a markup prompt is never a
   * slash command, so `submitDraft` holds it exactly then). The viewer stays
   * open for the next round (`docs/pdf_markup_rounds_plan.md` §2.5). */
  const sendMarkup = useCallback((text: string): MarkupSend => {
    const queued = agentAtWorkRef.current;
    if (!submitDraftRef.current(text, false)) return false;
    return queued ? "queued" : "sent";
  }, []);
  /** Mark up's Reload on a file the agent sent: the newest copy this tab
   * sent under the same name — at least as new as the one shown, by the
   * desktop's clock — else the shown one's fresh row. */
  const refreshOutboxFile = useCallback(async (file: OutboxFile): Promise<OutboxFile | null> => {
    const files = await listOutbox({ tab: tab.id });
    if (!Array.isArray(files)) return null;
    const name = sentName(file);
    const newer = files
      .filter((candidate) => candidate.from_tab && sentName(candidate) === name && candidate.modified >= file.modified)
      .sort((a, b) => b.modified - a.modified)[0];
    return newer ?? files.find((candidate) => candidate.name === file.name) ?? null;
  }, [tab.id]);
  /** Send while the agent works: the desktop holds the prompt for the tab's
   * next idle point (`holdPrompt`) instead of it going into the CLI's own
   * queue, where nothing can reach it again — so until the agent takes it in,
   * its bubble's hold menu offers Edit. The bubble shows at once, as any
   * prompt's does. With no window the Mobile host holds it itself. A host
   * that cannot hold it (an older build, a tab with no binding) costs nothing: the words are typed as they always were. The delivery
   * records the prompt in the desktop's history, so it is not reported here. */
  const holdDraft = (id: number, text: string, fromComposer = true) => {
    setLastSent(text);
    setUndoable(false);
    setUndoNote("");
    setEditNote("mobile.composer.heldNote");
    // `held: ""` — asked for, id not known yet: waiting, not yet editable.
    setPending((current) => [...current, { ...pendingPrompt(id, text, storedEntries), held: "" }].slice(-MAX_PENDING));
    if (fromComposer) {
      setDraft("");
      endDictation();
    }
    // The answer may come after the reader left the tab, or came back to it:
    // `patchHeld` hands it to the chat showing the tab then (`onHeldPatched`).
    holdPrompt(tab.id, text).then(
      (held) => patchHeld(tab.id, id, { held }),
      () => {
        setEditNote("");
        if (!sendAgentText(text, id)) {
          patchHeld(tab.id, id, { held: undefined, failed: true, retrying: false });
          return;
        }
        patchHeld(tab.id, id, { held: undefined });
        void reportSentPrompt(tab.id, text).catch(() => {});
      },
    );
  };
  /** The bubble's Edit: its words go into the composer, the draft steps
   * aside until the edit is sent or cancelled. */
  const startEdit = (id: number) => {
    const prompt = pending.find((entry) => entry.id === id);
    if (!prompt?.held || arrivedPending(storedEntries, pending).has(id)) {
      setEditNote("mobile.composer.heldGone");
      return;
    }
    setEditNote("");
    setEditing({ id, before: editing?.before ?? draft });
    setDraft(prompt.text);
    composerInput.current?.focus();
  };
  const cancelEdit = () => {
    if (!editing) return;
    setDraft(editing.before);
    setEditing(null);
    setEditNote("");
  };
  /** Send in edit mode: the desktop rewrites the held prompt, and only once
   * it says so does the bubble take the new words — it keeps its place. An
   * agent that took the prompt first keeps the old words: the new ones stay
   * in the composer, now an ordinary draft, to be sent or dropped. */
  const submitEdit = (target: { id: number; before: string }, words = draft) => {
    const prompt = pending.find((entry) => entry.id === target.id);
    const text = words.trim();
    if (!connected || !text || editSending || !prompt?.held) return;
    if (text === prompt.text) {
      cancelEdit();
      return;
    }
    setEditSending(true);
    editHeldPrompt(tab.id, prompt.held, text)
      .then(() => {
        setPending((current) => current.map((entry) => entry.id === target.id ? reworded(entry, text, storedEntries) : entry));
        if (editingRef.current?.id === target.id) {
          setDraft(target.before);
          setEditing(null);
        }
        setEditNote("mobile.composer.heldEdited");
      })
      .catch((error) => {
        const code = error instanceof ApiError ? error.code : "";
        if (code === "held_gone" || code === "held_busy") {
          setEditing(null);
          setEditNote("mobile.composer.heldGone");
        } else setEditNote("mobile.composer.heldEditFailed");
      })
      .finally(() => setEditSending(false));
  };
  useEffect(() => onHeldPatched((tabId, id, patch) => {
    if (tabId === tab.id) setPending((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }), [tab.id]);
  // What the desktop holds outlives this view; what the session recorded is
  // the record's.
  useEffect(() => {
    const arrived = arrivedPending(storedEntries, pending);
    writeHeld(tab.id, pending.filter((entry) => !arrived.has(entry.id)));
  }, [tab.id, storedEntries, pending]);
  // Back on the tab: a prompt held when the reader left may have been
  // delivered, or dropped on the desktop, meanwhile.
  useEffect(() => {
    // Only what was held before this view: a prompt held since may be newer
    // than the list read.
    const restored = new Set(readHeld(tab.id).map((entry) => entry.id));
    if (!restored.size) return;
    let live = true;
    getSchedules(tab.id).then(({ schedules }) => {
      if (!live || !Array.isArray(schedules)) return;
      setPending((current) => {
        const kept = stillHeld(current.filter((entry) => restored.has(entry.id) && entry.held !== undefined), schedules);
        return current.flatMap((entry) => {
          if (!restored.has(entry.id) || entry.held === undefined) return [entry];
          const now = kept.find((prompt) => prompt.id === entry.id);
          return now ? [now] : [];
        });
      });
    }, () => {});
    return () => { live = false; };
  }, [tab.id]);
  /** Some prompt sent from here still waits on the desktop. */
  const heldWaiting = useMemo(() => {
    const arrived = arrivedPending(storedEntries, pending);
    return pending.some((entry) => entry.held !== undefined && !arrived.has(entry.id));
  }, [storedEntries, pending]);
  // What the notes about waiting prompts say is over once none waits.
  useEffect(() => {
    if (!heldWaiting && (editNote === "mobile.composer.heldNote" || editNote === "mobile.composer.heldEdited")) setEditNote("");
  }, [heldWaiting, editNote]);
  // The agent took the prompt being edited: its words are final. What the
  // reader typed stays in the composer as an ordinary draft.
  useEffect(() => {
    if (editing && !editSending && arrivedPending(storedEntries, pending).has(editing.id)) {
      setEditing(null);
      setEditNote("mobile.composer.heldGone");
    }
  }, [editing, editSending, storedEntries, pending]);
  /** A prompt the link lost goes again, as the same bubble: the same words
   * into the agent's line editor (which is reset first, so a half-delivered
   * first try is not doubled), tagged with the same id so the ack clears
   * the marker. The desktop hears the words again too; it folds a repeat of
   * the same prompt close in time into one history row. */
  const resendPrompt = (id: number) => {
    const prompt = pending.find((entry) => entry.id === id);
    if (!prompt || !connected) return;
    setPending((current) => current.map((entry) => entry.id === id ? { ...entry, failed: false, retrying: true } : entry));
    if (!sendAgentText(prompt.text, id)) {
      setPending((current) => current.map((entry) => entry.id === id ? { ...entry, failed: true, retrying: false } : entry));
      return;
    }
    void reportSentPrompt(tab.id, prompt.text).catch(() => {});
  };
  /** Codex at work: it answers `/clear` with "disabled while a task is in
   * progress" and keeps the conversation. */
  const codexBusy = () => CODEX_AGENT.test(tab.agent_label ?? tab.label) && liveBusy;
  /** A `/clear` just left for the agent: the chat shown starts over. What the
   * session held stays hidden until the new one is read, unless Codex was busy
   * and refused it — then the conversation goes on, and so does the chat. */
  const startedOver = () => {
    setUndoNote("");
    if (codexBusy()) return;
    if (agentAtWork) {
      setClearQueued(true);
      return;
    }
    setPending([]);
    clearShown();
  };
  /** The chat shown starts over, the Clear chip reading Undo. */
  const clearShown = () => {
    setClearedAt(clearMark(transcript?.entries ?? []));
    // Every agent Tabtivity resumes can take the clear back — the desktop decides
    // how, and says so when a tab is not one of them. Aider resumes nothing.
    setUndoable(slashCliKey !== "aider");
  };
  // The turn is over: the queued `/clear` runs now. Bubbles held meanwhile
  // stay — they went in ahead of it.
  useEffect(() => {
    if (!clearQueued || agentAtWork) return;
    setClearQueued(false);
    clearShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the turn's end, with the transcript as it stands then
  }, [clearQueued, agentAtWork]);
  /** The Undo chip: the desktop brings back the conversation just cleared —
   * in-session for Claude, by relaunching the tab onto it for the others, as a
   * restart of Tabtivity would. Claude's hook records the clear a moment after the
   * command lands, so a tap that beats it is tried once more. */
  const undoClearConversation = () => {
    const mark = clearedAt;
    const run = ++undoRun.current;
    setUndoable(false);
    setUndoNote("");
    setUndoing("asking");
    const attempt = (retry: boolean): void => {
      undoClear(tab.id)
        .then(() => {
          setUndoing({ mark });
          window.setTimeout(() => {
            if (undoRun.current === run) setUndoing(false);
          }, UNDO_SETTLE_MAX);
          // The cleared conversation is the session read again, all of it:
          // read it afresh now, and again while a relaunched agent comes up.
          setClearedAt(null);
          // The desktop just typed the resume, or relaunched the agent.
          commandSentAt.current = Date.now();
          transcriptVersion.current = undefined;
          setTranscriptReload((count) => count + 1);
          for (const delay of UNDO_RELOADS) {
            window.setTimeout(() => {
              transcriptVersion.current = undefined;
              setTranscriptReload((count) => count + 1);
            }, delay);
          }
        })
        .catch((error) => {
          const code = error instanceof ApiError ? error.code : "";
          if (code === "nothing_to_undo" && retry) {
            window.setTimeout(() => attempt(false), UNDO_CLEAR_RETRY);
            return;
          }
          setUndoing(false);
          setUndoNote(code === "nothing_to_undo" ? "mobile.composer.undoGone"
            : code === "remote_tab" ? "mobile.composer.undoRemote"
            : "mobile.composer.undoFailed");
        });
    };
    attempt(true);
  };
  /** The bar's Clear chip sends the selected CLI's new-conversation command at
   * once — no confirm dialog. The draft is left alone. A Codex that is working
   * would refuse it, so the button says so here instead. */
  const clearConversation = () => {
    if (codexBusy()) {
      setClearRefused(true);
      return;
    }
    setClearRefused(false);
    if (sendAgentText(NEW_CONVERSATION_COMMAND)) startedOver();
  };
  /** The Commit chip's pick: its prompt goes as the reader's own would —
   * a bubble at once, held while the agent works — and the draft stays. */
  const commitOptions: SheetOption[] = COMMIT_CHOICES.map((choice) => ({
    key: choice,
    label: t(COMMIT_LABELS[choice]),
    description: t(COMMIT_HINTS[choice]),
    current: false,
  }));
  const pickCommit = (key: string) => {
    setCommitSheet(false);
    submitDraft(COMMIT_PROMPTS[key as CommitChoice], false);
  };
  /** The composer's `/` menu: the commands that continue the draft, the
   * reader's own first. Picking one only fills the field — the reader still
   * sends it, so a stray tap never runs `/clear` on a session. Its rows,
   * like the mode sheet's, are worded in the language live when read. */
  const lang = useI18nStore((state) => state.lang);
  const slashMenu = useMemo(
    () => (tab.kind === "agent" && connected ? slashSuggestions(draft, slashCliKey, usedSlash) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lang` re-words the rows
    [tab.kind, connected, draft, slashCliKey, usedSlash, lang],
  );
  const pickSlash = (suggestion: SlashSuggestion) => {
    setDraft(suggestion.args ? `${suggestion.line} ` : suggestion.line);
    composerInput.current?.focus();
  };
  /** The bar's Plan / Goal chips: tapping one leads the draft with its
   * command (or takes it off again). Like the `/` menu it only fills the
   * field — the reader still writes the words and sends. */
  const prefixCommands = draftPrefixes(slashCliKey);
  const activePrefix = draftPrefix(draft, prefixCommands);
  const togglePrefix = (command: string) => {
    setDraft((current) => toggleDraftPrefix(current, command, prefixCommands));
    composerInput.current?.focus();
  };
  const forgetSlash = (line: string) => {
    forgetSlashCommand(slashCliKey, line);
    setUsedSlash(readSlashCommands(slashCliKey));
    composerInput.current?.focus();
  };
  /** The composer's ✕: an empty draft, and the dictation transcript with it. */
  const clearDraft = () => {
    setDraft("");
    forgetDictation();
    composerInput.current?.focus();
  };
  /** Keep the draft a moment after the typing stops. Per keystroke would put a
   * synchronous store write between the reader and their next letter, and the
   * only thing the delay can cost is text that is still on the screen. */
  useEffect(() => {
    const timer = window.setTimeout(() => writeDraft(tab.id, savedDraft()), DRAFT_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [tab.id, draft, uploads]);
  /** …and once more when this screen goes away, which the delay above would
   * otherwise eat: leaving for the tab list unmounts it, and a phone putting the
   * PWA away kills it without unmounting anything (`pagehide` is the last word
   * either way — `beforeunload` never fires on iOS). */
  useEffect(() => {
    const flush = () => writeDraft(tab.id, savedDraft());
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [tab.id]);
  /** The tab's own name for its agent, which is what every family rule is
   * scoped by: the mode tables, the prompt echo Kimi Code draws, and the whole
   * of OpenCode's mini interface, whose frame has no marker to be found by. */
  const agentLabel = tab.agent_label ?? tab.label;
  const openCode = tab.kind === "agent" && isOpenCodeTab(agentLabel);
  const antigravity = tab.kind === "agent" && isAntigravityTab(agentLabel);
  const cursorAgent = tab.kind === "agent" && isCursorTab(agentLabel);
  /** A choice a sign-in tab's CLI asks before it prints its link —
   * Antigravity opens on "Select login method" — which the sign-in sheet,
   * drawn over the session, answers while it waits. */
  const signInChoice = useMemo(
    () => (signInTab && signInSheet && !signIn && tab.kind === "agent" ? readSelectPrompt(liveScreen, agentLabel) : null),
    [signInTab, signInSheet, signIn, tab.kind, liveScreen, agentLabel],
  );
  /** The facts the session prints below its own input box — the facts row's
   * labels. Absent fields leave a button on its generic label. */
  const status = useMemo(
    () => (tab.kind === "agent" ? sessionStatus(liveScreen, agentLabel) : null),
    [tab.kind, liveScreen, agentLabel],
  );
  // The mode walk reads the status between two presses, outside React's render.
  useEffect(() => { statusRef.current = status; }, [status]);
  /** Codex draws neither its context nor its limits on screen and has no
   * usage panel the desktop can run, but writes both into its rollout: the
   * stored session's figures fill in what the screen and the panel leave out,
   * so its facts row reads like Claude's. */
  // The cleared conversation's figures are not the new chat's.
  const storedUsage = sinceClear ? undefined : transcript?.usage;
  const contextLeft = status?.context ?? (storedUsage?.contextLeft != null ? `${storedUsage.contextLeft}%` : undefined);
  const limitTime = new Date(limitsNow);
  const shownLimits = limits.session || limits.week ? limits : sessionLimits(storedUsage, limitTime);
  const readTime = limits.session || limits.week ? new Date(limitsReadAt) : limitTime;
  const sessionReset = shownLimits.session?.resets ? resetCountdown(shownLimits.session.resets, limitTime, readTime) : "";
  const weekReset = shownLimits.week?.resets ? resetCountdown(shownLimits.week.resets, limitTime, readTime) : "";
  /** The picker the model chip opened, read off the screen while the sheet is
   * up — a list of the session's own rows, not a list of models Tabtivity
   * believes in. None of OpenCode's, Antigravity's or Cursor's is the numbered
   * dialog the others draw, so each is read by its own shape (`openCodeMini`,
   * `antigravity`, `cursorAgent`). */
  const picker = useMemo(
    () => {
      if (!modelSheet) return null;
      if (openCode) return readOpenCodePicker(liveScreen);
      if (antigravity) return readAntigravityPicker(liveScreen);
      if (cursorAgent) return readCursorPicker(liveScreen);
      return readSelectPrompt(liveScreen, agentLabel);
    },
    [modelSheet, openCode, antigravity, cursorAgent, liveScreen, agentLabel],
  );
  /** The step the sheet is showing: the picker on screen, unless it is the one
   * a tap just answered and the session has not redrawn yet. */
  const pickerStep = picker && answered && sameSelectStep(answered, picker) ? null : picker;
  /** The step as far as it is known: the rows on screen plus those an earlier
   * slice of the same picker drew. OpenCode's list is never windowed, and a
   * tapped group heading narrows it into a list of its own. */
  const listedStep = useMemo<SelectStep | null>(
    () => (!pickerStep ? null : openCode ? pickerStep : mergeSelectRows(knownStep, pickerStep)),
    [pickerStep, openCode, knownStep],
  );
  useEffect(() => { if (listedStep && !openCode) setKnownStep(listedStep); }, [listedStep, openCode]);
  /** The printed number of the row the dialog highlights right now. */
  const pickerAt = pickerStep?.options[pickerStep.current]?.number;
  /** The effort stops Antigravity's dialog is offering right now — the ones
   * belonging to the model its highlight is on, which is why they are read
   * again after every walk rather than kept with the row. */
  const effortSlider = useMemo<AntigravityEffort | null>(
    () => (modelSheet && antigravity ? readAntigravityEffort(liveScreen) : null),
    [modelSheet, antigravity, liveScreen],
  );
  useEffect(() => {
    if (!modelSheet) return;
    if (pickerStep) {
      sawPicker.current = true;
      // A step is up, so nothing is left to hold for: a dialog that comes back
      // to a list already answered (Codex's "More reasoning…" has an esc back)
      // is a step again, not the stale paint of the answer.
      if (answered) setAnswered(null);
      return;
    }
    // The answered list, still on screen: the session has not read the Enter
    // yet. Hold — the next step, if there is one, replaces it in place. If the
    // session never moves off it, the answer did not land: give the list back
    // rather than hold a sheet the tap can no longer leave.
    if (answered && picker) {
      const stuck = window.setTimeout(() => setAnswered(null), MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    if (sawPicker.current) {
      // Gone after it was listed: answered here, on the desktop, or dismissed.
      // After a tap the gap is given to the step that may still follow.
      if (!answered) {
        setModelSheet(false);
        return;
      }
      const next = window.setTimeout(() => {
        setModelSheet(false);
        setAnswered(null);
      }, SELECT_NEXT_WAIT);
      return () => window.clearTimeout(next);
    }
    // Never drawn: the session may have no `/model` picker at all. Step out of
    // the way rather than hold an empty sheet over its output.
    const timer = window.setTimeout(() => setModelSheet(false), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(timer);
  }, [modelSheet, picker, pickerStep, answered]);
  /** A windowed picker says how many rows it is not drawing: the highlight is
   * walked to each one it hides, which scrolls it into view, and back. Only
   * arrow keys — nothing is accepted — and only while nothing was tapped. */
  useEffect(() => {
    if (!modelSheet || openCode || answered || !pickerStep || !listedStep || pickerAt === undefined || revealStuck.current) return;
    if (reveal && pickerAt !== reveal.target) {
      // The keys have not landed yet. If they never do, stop walking.
      const stuck = window.setTimeout(() => {
        revealStuck.current = true;
        setReveal(null);
      }, MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    const target = revealSelectRow(listedStep, pickerStep) ?? reveal?.origin;
    if (target === undefined || target === pickerAt) {
      if (reveal) setReveal(null);
      return;
    }
    if (!deliver(selectMoveKeys(pickerAt, target))) {
      setReveal(null);
      return;
    }
    setReveal({ origin: reveal?.origin ?? pickerAt, target });
    // `deliver` is a fresh closure every render; the walk runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSheet, openCode, answered, pickerStep, listedStep, pickerAt, reveal]);
  /** The highlight has reached the model an Antigravity tap chose, so the
   * dialog has redrawn its slider for *that* model: a model with stops asks
   * for one here, and a model with none — every Claude model it offers — is
   * accepted now, because there is nothing left to ask. Until the walk lands
   * the screen still shows the row it left, so nothing is pressed on a frame
   * that has not caught up; a walk whose keys never show gives the list back. */
  useEffect(() => {
    if (!effortFor) return;
    if (!pickerStep || pickerAt !== effortFor.number) {
      const stuck = window.setTimeout(() => setEffortFor(null), MODEL_PICKER_WAIT);
      return () => window.clearTimeout(stuck);
    }
    if (effortSlider && effortSlider.stops.length > 1) {
      setEffortStep(effortFor.label);
      setEffortFor(null);
      return;
    }
    if (deliver(["\r"]) && listedStep) setAnswered(listedStep);
    setEffortFor(null);
    // `deliver` is a fresh closure every render; the step runs on the frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effortFor, pickerStep, pickerAt, effortSlider, listedStep]);
  /** `/model` opens the agent's own picker in the session; the sheet lists the
   * rows it drew, and a tap answers it with the same keys the arrow row sends —
   * so nothing here decides what the models are.
   *
   * Neither OpenCode interface has a `/model`. In mini the words would be
   * submitted to the model as a prompt, a turn the reader never asked for; in
   * the full TUI the command is `/models`, so `/model` only opened the slash
   * completion and left it sitting in the composer. Both open the same picker
   * from the command palette, so the chip presses the keys that get there
   * (`OPENCODE_MODEL_KEYS`) instead of typing a command. */
  const selectModel = () => {
    if (modelSheet) return;
    sawPicker.current = false;
    revealStuck.current = false;
    setAnswered(null);
    setKnownStep(null);
    setReveal(null);
    setEffortFor(null);
    setEffortStep(null);
    if (openCode) {
      clearPending();
      if (!deliver(OPENCODE_MODEL_KEYS)) return;
    } else if (!sendAgentText("/model")) return;
    setModelSheet(true);
  };
  /** The card's model tap, answered once the socket is up and the session has
   * drawn its first frame: sent any earlier, `/model` lands before the agent's
   * prompt exists, and the sheet's own wait for the picker would run out on
   * the attach rather than on the agent. */
  const pickModelPending = useRef(pickModel && tab.kind === "agent");
  useEffect(() => {
    if (!pickModelPending.current || !connected || liveScreen.length === 0) return;
    pickModelPending.current = false;
    selectModel();
  });
  /** Answers the step on screen. The sheet does not close on the tap: `/model`
   * is one step in Claude Code and two in Codex, which asks for a reasoning
   * level next, and which it is, is the session's answer to give — the sheet
   * lists whatever it draws next, and closes when it draws nothing.
   *
   * OpenCode's picker is answered by typing into its search field rather than
   * by walking a highlight this cannot see (`openCodePickKeys`); tapping one of
   * its group headings narrows the list, which the sheet reads as the next
   * step. */
  const chooseModel = (key: string) => {
    // Mid-walk the highlight is not where the frame says; the sheet is busy.
    if (!pickerStep || !listedStep || reveal || effortFor) return;
    clearPending();
    const picked = listedStep.options.find((option) => option.number === Number(key));
    if (!picked) return;
    // Antigravity's dialog applies the model and its effort together, on one
    // Enter: the tap only walks the highlight there, and what happens next is
    // the effort the dialog then draws for it.
    if (antigravity) {
      if (pickerAt === undefined || !deliver(selectMoveKeys(pickerAt, picked.number))) return;
      setEffortFor({ number: picked.number, label: picked.label });
      return;
    }
    // Walked by printed number: a windowed picker's rows on screen are a slice.
    const writes = openCode
      ? openCodePickKeys(picked.label)
      : pickerAt === undefined ? [] : selectKeys(pickerAt, picked.number);
    if (writes.length === 0 || !deliver(writes)) return;
    setAnswered(listedStep);
  };
  /** Answers Antigravity's effort step: the slider is moved with the same
   * ←/→ its own keyboard row names, and the Enter that follows is the one
   * that applies the model and the effort at once. */
  const chooseEffort = (key: string) => {
    if (!effortSlider || !listedStep) return;
    clearPending();
    const target = Number(key);
    if (!effortSlider.stops[target]) return;
    if (!deliver([...antigravityEffortKeys(effortSlider.current, target), "\r"])) return;
    setAnswered(listedStep);
    setEffortStep(null);
  };
  /** The hidden-link notice's button: the key the CLI hands its link over
   * on, answered by a clipboard copy the terminal above catches. */
  const askForLink = () => {
    if (!hiddenLink) return;
    clearPending();
    if (!type(hiddenLink.key)) return;
    linkAsked.current = Date.now();
    setLinkAsking(true);
    setLinkMissing(false);
    window.clearTimeout(linkTimer.current);
    linkTimer.current = window.setTimeout(() => {
      if (linkAsked.current === 0) return;
      linkAsked.current = 0;
      setLinkAsking(false);
      setLinkMissing(true);
    }, LINK_WAIT_MS);
  };
  /** The CLI's own sign-in command, typed into the session like any slash
   * command, for a CLI the desktop has no sign-in tab for. What it prints
   * next — a method list the reading view answers, then the link — reaches
   * the notice above the composer; nothing here waits on it. */
  const startSignIn = (command: string) => {
    if (!sendAgentText(command)) return;
    setStatusSheet(false);
    setHiddenSignIn("");
  };
  /** A sign-in tab for this tab's CLI, beside it (`openSignInTab`), shown in
   * place of this one. From a sign-in tab it is a retry, and replaces it. */
  const openSignIn = async (alternate: boolean) => {
    if (openingSignIn || !openTab) return;
    const way = alternate ? "alternate" : "default";
    const key = signInKeys.current[way] ?? crypto.randomUUID();
    signInKeys.current[way] = key;
    setOpeningSignIn(true);
    setSignInError("");
    try {
      const body = await openSignInTab(tab.id, alternate, key);
      delete signInKeys.current[way];
      setStatusSheet(false);
      if (signInTab) void closeTab(tab.id).catch(() => undefined);
      openTab(body.tab, { signIn: true });
    } catch (cause) {
      setSignInError(describeFailure(cause));
    } finally {
      setOpeningSignIn(false);
    }
  };
  /** How this CLI signs in from here: a sign-in tab where the desktop has a
   * login command for it, else its slash command in this session. */
  const typedSignIn = signInCommand(slashCliKey);
  const signInWay = !connected || tab.kind !== "agent" ? null
    : hasSignInTab(slashCliKey) && openTab
      ? { hint: t("mobile.signIn.tabHint", { agent: agentLabel }), start: () => void openSignIn(false) }
      : typedSignIn
        ? { hint: t("mobile.signIn.startHint", { command: typedSignIn }), start: () => startSignIn(typedSignIn) }
        : null;
  /** Done in a sign-in tab: a login command's tab has served its purpose and
   * closes; a CLI that signed in as it started stays, as the session it is. */
  const finishSignIn = () => {
    setSignInSheet(false);
    if (!hasSignInTab(slashCliKey)) return;
    void closeTab(tab.id).catch(() => undefined);
    back();
  };
  const closeModelSheet = () => {
    // The dialog is the session's own and still open: close it there too,
    // rather than leaving a modal behind that the reader can no longer see.
    if (picker) type("\u001b");
    setModelSheet(false);
    setAnswered(null);
    setReveal(null);
    setEffortFor(null);
    setEffortStep(null);
  };
  /** Shift+Tab — the mode cycle Claude Code, Codex and Qwen Code all bind,
   * encoded the way this family's TUI reads it (`shiftTabKey`). The chip label
   * follows the status line the TUI redraws, so the feedback is real. */
  /** The chip's lamp comes from the row this screen was opened with, and that
   * row is frozen for the whole session (it even survives a restart, via
   * `lastPlace`). A `done` on it is by definition already read — the tab is on
   * screen — so it is not shown here, the same way the desktop's tab bar hides
   * the viewed tab's own glow. An `interrupted` is left off too, as the desktop
   * strip leaves it off the viewed tab. The desktop retires the flag for real when the
   * attach reports the tab seen. */
  const lamp = tab.agent_status === "done" || tab.agent_status === "interrupted" ? "idle" : tab.agent_status ?? "idle";
  const shiftTab = shiftTabKey(agentLabel);
  const cycleMode = () => press(shiftTab);
  /** The modes this session has, decided by the mode it is showing with the
   * tab's agent label as the tie-break (and, for a family whose default mode
   * draws no text at all, as the way in). Empty for a session no family
   * claims — the chip then keeps cycling, as before. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `lang` re-words the rows
  const modes = useMemo(() => modeChoices(status?.mode, agentLabel), [status?.mode, agentLabel, lang]);
  const activeMode = currentMode(modes, status?.mode, status != null);
  /** A family whose mode no key here can change (OpenCode's mini interface).
   * The sheet lists its modes as a readout: nothing is pressed, and the chip
   * never cycles into a session that ignores the key. */
  const fixedMode = modeFixed(agentLabel);
  const openModeSheet = () => {
    if (modes.length === 0 && !fixedMode) {
      cycleMode();
      return;
    }
    setSwitchFailed("");
    setModeSheet(true);
  };
  /** Walks the Shift+Tab cycle to the tapped mode, reading the redrawn status
   * line after every press. No cycle order is assumed: the walk stops when the
   * session reports the mode that was asked for, or when a full lap has brought
   * it back to where it started — which is also what leaves a mode the session
   * does not offer with nothing changed. */
  const applyMode = async (value: string) => {
    if (switching || !connected || fixedMode) return;
    const start = statusRef.current?.mode;
    if (currentMode(modes, start, statusRef.current != null) === value) {
      setModeSheet(false);
      return;
    }
    const walk = modeWalk.current + 1;
    modeWalk.current = walk;
    setSwitchFailed("");
    setSwitching(value);
    for (let step = 0; step < MODE_CYCLE_LIMIT; step += 1) {
      if (!type(shiftTab)) break;
      await new Promise((resolve) => { window.setTimeout(resolve, MODE_SETTLE); });
      if (modeWalk.current !== walk) return;
      const now = statusRef.current?.mode;
      if (currentMode(modes, now, statusRef.current != null) === value) {
        setSwitching("");
        setModeSheet(false);
        return;
      }
      // Back where it started ends the walk — but only on a positively read
      // mode: with a silent-mode family, `undefined` is also what a mid-redraw
      // frame reports, and breaking on it would end a legitimate walk early.
      if (step > 0 && now !== undefined && now === start) break;
    }
    if (modeWalk.current !== walk) return;
    setSwitching("");
    setSwitchFailed(value);
  };
  const sheetUp = modelSheet || modeSheet || statusSheet || desktopSheet || gallery || outboxOpen !== null || inboxOpen !== null;
  useLayoutEffect(() => {
    setFrozenLines(sheetUp ? linesRef.current : null);
  }, [sheetUp]);
  /** Adds an `@` for the agent's file mentions to the draft — context is
   * resolved by the agent from the submitted message, not by the phone. */
  const addContext = () => {
    setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@`);
    composerInput.current?.focus();
  };
  /** Marks one file as landed: its row now holds the reference that Send
   * puts after the message (`withAttachments`). */
  const uploadLanded = (id: number, reference: string) => {
    setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, reference } : upload));
  };
  /** Sends the picked files into the project inbox one by one; each one's
   * `@` reference goes with the next message once it lands. The reference is
   * the desktop's — the phone never composes a path. */
  const attachFromPhone = (files: ArrayLike<File> | null) => {
    if (!files || files.length === 0) return;
    const run = uploadRun.current;
    for (const file of Array.from(files)) {
      const id = ++uploadSeq.current;
      const name = file.name || "attachment";
      if (file.size > MAX_INBOX_FILE) {
        setUploads((current) => [...current, { id, name, source: "phone", failure: UPLOAD_FAILURES.file_too_large }]);
        continue;
      }
      // Only the formats an `<img>` shows everywhere — the inbox serves the same.
      const preview = /^image\/(png|jpeg|gif|webp)$/u.test(file.type) && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
      setUploads((current) => [...current, { id, name, source: "phone", preview }]);
      void uploadToInbox(tab.id, file, name).then(
        (attachment) => {
          if (uploadRun.current !== run) return;
          uploadLanded(id, attachment.reference);
        },
        (error: unknown) => {
          if (uploadRun.current !== run) return;
          const code = error instanceof ApiError ? error.code : "";
          const failure = UPLOAD_FAILURES[code] ?? "mobile.sendToDesktop.failed";
          setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, failure } : upload));
        },
      );
    }
    composerInput.current?.focus();
  };
  const dismissUpload = (id: number) => setUploads((current) => current.filter((upload) => upload.id !== id));
  /** Opens the desktop's list and asks for it. The list is read once per
   * opening — the sheet shows what the desktop had when it was asked, and a
   * screenshot taken meanwhile is one close-and-reopen away. */
  const openDesktopSheet = () => {
    const run = uploadRun.current;
    setDesktopImages(null);
    setDesktopFailure("");
    setDesktopSheet(true);
    void listDesktopImages(tab.id).then(
      (images) => { if (uploadRun.current === run) setDesktopImages(images); },
      (error: unknown) => {
        if (uploadRun.current !== run) return;
        const code = error instanceof ApiError ? error.code : "";
        setDesktopFailure(DESKTOP_LIST_FAILURES[code] ?? "mobile.desktopImages.failed.other");
        setDesktopImages([]);
      },
    );
  };
  /** Asks the desktop to copy one listed image into the project inbox — the
   * same row and the same `@` a file sent from the phone gets. */
  const attachFromDesktop = (imageId: string) => {
    const image = desktopImages?.find((entry) => entry.id === imageId);
    setDesktopSheet(false);
    if (!image) return;
    const run = uploadRun.current;
    const id = ++uploadSeq.current;
    setUploads((current) => [...current, { id, name: image.name, source: "desktop" }]);
    void attachDesktopImage(tab.id, image.id).then(
      (attachment) => {
        if (uploadRun.current !== run) return;
        uploadLanded(id, attachment.reference);
      },
      (error: unknown) => {
        if (uploadRun.current !== run) return;
        const code = error instanceof ApiError ? error.code : "";
        const failure = UPLOAD_FAILURES[code] ?? "mobile.inbox.failed.copy";
        setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, failure } : upload));
      },
    );
    composerInput.current?.focus();
  };
  const pickAdd = (key: string) => {
    setAddSheet(false);
    if (key === "phone") {
      pickPhoneFiles(fileInput.current, attachFromPhone);
    } else if (key === "gallery") {
      galleryInput.current?.click();
    } else if (key === "desktop") {
      openDesktopSheet();
    } else {
      addContext();
    }
  };
  /** What the reading view paints: the live screen, or the frame it held when
   * a composer sheet opened — minus the session's own input frame, which the
   * composer and its chips already are. */
  const shown = frozenLines ?? lines;
  const painted = useMemo(
    () => (tab.kind === "agent" ? shown.slice(0, inputFrameStart(shown, agentLabel)) : shown),
    [tab.kind, shown, agentLabel],
  );
  /** The rows the session draws under its input box — the frame `painted`
   * cuts away — for the swipe-in status strip. From the same `shown`, so a
   * frame frozen behind a sheet stays consistent; always the xterm screen,
   * even while Focus reads the stored session. */
  const frameStatus = useMemo(
    // A fullscreen agent's rows are on its frame instead, where nothing is
    // frozen behind a sheet: the frame is what the session is drawing now.
    // Dedented, because a fullscreen TUI centres its box — OpenCode's sits 70
    // columns in on a wide pane — and the strip is a phone-width readout of
    // those rows, not a scale model of the desktop window. On the scrollback,
    // where the rows start at the margin, this takes nothing away.
    () => (tab.kind === "agent" ? dedentRows(statusFrameLines(altScreen ? liveScreen : shown, agentLabel)) : []),
    [tab.kind, altScreen, liveScreen, shown, agentLabel],
  );
  const statusSwipe = tab.kind === "agent" && view === "focus" && (!altScreen || liveScreen.length > 0);
  useEffect(() => {
    if (!project) return;
    // Read on opening and on coming back to the page, not polled: the drawer
    // itself says so when the switch went off in between.
    const controller = new AbortController();
    const read = () => {
      if (document.visibilityState !== "visible") return;
      api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(project)}`, { signal: controller.signal })
        .then((detail) => setFilesLabel(detail.files ? detail.project.label : null))
        .catch(() => {});
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", read);
    };
  }, [project]);
  const filesSwipe = filesLabel !== null && view === "focus";
  /** Where the output is up for a swipe to read; `readableHost` is mounted
   * with it. */
  const readableShown = view === "focus" && (!altScreen || sessionShown);
  useEffect(() => {
    const stream = readableHost.current;
    if ((!statusSwipe && !filesSwipe) || filesOpen || !stream) return;
    return installFocusSwipe(stream, {
      onSwipeRight: (start) => {
        if (filesSwipe && (!statusSwipe || start.x < window.innerWidth * FILES_SWIPE_ZONE)) setFilesOpen(true);
        else setStatusStrip(true);
      },
      onSwipeLeft: () => setStatusStrip(false),
    }, { leftEdge: filesSwipe });
  }, [statusSwipe, filesSwipe, filesOpen, readableShown]);
  /** Agent tabs read as a chat (`ReadableTurns`); a shell's output has no
   * turns to lay out. */
  const chat = tab.kind === "agent";
  /** The live screen after the last prompt echo — what the session is
   * drawing right now. Shown under the stored session while it holds a
   * choice the session is waiting on, which the transcript cannot carry. */
  const liveTail = useMemo(() => {
    if (!sessionShown) return [];
    // On the alternate screen that tail is the frame itself, cut at its input
    // box the way `painted` cuts the scrollback's: a fullscreen agent draws its
    // session there, so a question of its own reaches the phone in no other
    // way. A frame that holds no dialog reaches the reader in no other way
    // either — only `liveQuestion` reads this, never the view.
    const screen = altScreen ? liveScreen.slice(0, inputFrameStart(liveScreen, agentLabel)) : painted;
    let start = 0;
    screen.forEach((line, index) => { if (isLiveEcho(line, agentLabel)) start = index + 1; });
    return screen.slice(start);
  }, [sessionShown, altScreen, liveScreen, painted, agentLabel]);
  /** The choice the session is waiting on, read off the live screen. On the
   * phone it is answered by tapping a row, so what is kept is the dialog
   * itself — its rows, and where on the tail they start — not just that there
   * is one. */
  const liveQuestion = useMemo(
    () => (liveTail.length > 0 ? readSelectPrompt(liveTail, agentLabel, paneColumns.current) ?? readReviewStep(liveTail, agentLabel) : null),
    [liveTail, agentLabel],
  );
  /** A fresh tab's chat waits on the CLI — still starting, or answered from
   * here with no session recorded yet. A question on screen waits on the
   * reader instead, so it never runs the clock. Past `STARTING_GRACE` the
   * screen is shown: an error the CLI printed reaches the reader. */
  const startWaiting = preSessionWait && !liveQuestion && (!cliReady || promptOnScreen);
  useEffect(() => {
    if (!startWaiting) return;
    const timer = window.setTimeout(() => setStartGaveUp(true), STARTING_GRACE);
    return () => window.clearTimeout(timer);
  }, [startWaiting]);
  /** The agent as the markup view's round pill reads it: the live screen
   * only — `tab.agent_status` is the snapshot taken when this tab was
   * opened, and would read "working" forever for a tab opened mid-turn. */
  const markupAgent: AgentSignal = liveQuestion !== null ? "question" : liveBusy ? "working" : "idle";
  /** An agent tab's viewers offer **Mark up**; a shell has no chat to send to.
   * The agent's state is in the deps, so the viewers re-render on its edges. */
  const markupTarget = useMemo<MarkupTarget | undefined>(
    () => (tab.kind === "agent"
      ? { tabId: tab.id, projectId: project ?? `tab:${tab.id}`, onSend: sendMarkup, agent: markupAgent, refresh: refreshOutboxFile }
      : undefined),
    [tab.kind, tab.id, project, sendMarkup, markupAgent, refreshOutboxFile],
  );
  /** The agent's open markup question (`markup_ask`), for the banner over the
   * composer: read on the markup views' own poll, only while the Focus chat
   * is on screen (no viewer over it) and on each agent edge. */
  const { asks: markupAsks } = useMarkupAsks(tab.kind === "agent" ? tab.id : undefined, undefined,
    view === "focus" && !outboxOpen && !inboxOpen && !filesOpen && !gallery && !askedFile, markupAgent);
  const markupAsk = markupAsks.find((ask) => ask.questions.length > 0);
  /** The file it is about, if this tab's outbox has it — the newest copy. */
  const markupAskFile = markupAsk?.file_name ? outbox.find((file) => sentName(file) === markupAsk.file_name) : undefined;
  /** Else the project file it is about, as the files drawer rows it (the
   * sidecar seals it; only while the drawer is switched on). */
  const markupAskRow = !markupAskFile && project ? markupAsk?.file_row : undefined;
  const askedScope = useMemo<ViewerScope | undefined>(() => (project ? { files: project } : undefined), [project]);
  /** Mark up's Reload for that file: its folder listed again, for a fresh row. */
  const askedFolder = askedFile?.folder;
  const refreshAskedFile = useMemo(
    () => (project ? refreshProjectFile(project, askedFolder) : async () => null),
    [project, askedFolder],
  );
  const openAskedRow = (row: PhoneMarkupFile) => setAskedFile({
    file: { name: row.name, kind: row.kind, size: row.size, modified: row.modified, ref: row.token },
    place: row.place,
    folder: row.folder,
  });
  /** A shell tab has no chat to send marks to: Mark up's Submit opens a new
   * tab of the desktop's default agent; its Open tab shows that tab in place
   * of this one. */
  const markupNewTab = useMemo<MarkupNewTab | undefined>(
    () => (tab.kind !== "agent" && project && openTab ? { projectId: project, show: (row: TabRow) => openTab(row) } : undefined),
    [tab.kind, project, openTab],
  );
  /** The dialog's own question — the block right above its rows, which the
   * list below shows as its heading — and the screen it was drawn onto, which
   * stays as the session drew it. Blank rows at either seam are the dialog's
   * own gutter, not a paragraph of anybody's.
   *
   * Between the two Claude Code draws a tab row over a question an agent asks
   * (`readQuestionTabs`); it is the question's label, so it is lifted off and
   * the list shows it as chips. Such a question and the agent's prose above it
   * are rejoined into paragraphs (`joinProseWraps`) — any other dialog's
   * screen, a diff or a command, stays as drawn. */
  const { ask: questionAsk, context: questionContext, tabs: questionTabs, tabFocus: questionTabFocus, tabSubmit: questionTabSubmit, tabKeys: questionStepKeys } = useMemo(
    (): QuestionParts => (liveQuestion ? questionParts(liveTail, liveQuestion) : NO_QUESTION_PARTS),
    [liveQuestion, liveTail],
  );
  /** What the list on screen *is*, as a string: a stable dep for the effects
   * below, which must not restart on every repaint of the same question. Two
   * questions of one dialog can offer the same rows (two yes/no questions):
   * the step they are on tells them apart. */
  const questionSignature = !liveQuestion ? ""
    : questionTabs.length === 0 ? selectSignature(liveQuestion)
    : [selectSignature(liveQuestion), ...questionTabs.map((tab) => `${tab.answered ? "✓" : "☐"}${tab.label}`), `@${questionTabFocus ?? ""}`, ...questionAsk.map((line) => line.text)].join("\n");
  /** The question a tap just answered, while the session has not redrawn yet:
   * its rows stay listed, but nothing can be tapped twice. */
  const [questionSent, setQuestionSent] = useState<{ signature: string; number: number } | null>(null);
  const sentSignature = questionSent?.signature ?? "";
  useEffect(() => {
    if (!sentSignature) return;
    // Redrawn as something else — answered, or moved on: the list is live again.
    if (questionSignature !== sentSignature) {
      setQuestionSent(null);
      return;
    }
    // Still the same question after the keys had time to land: the answer did
    // not arrive. Give the list back rather than leave a dead block on screen.
    const stuck = window.setTimeout(() => setQuestionSent(null), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(stuck);
  }, [sentSignature, questionSignature]);
  /** Answers the question on screen with the row tapped — the same arrow keys
   * and Enter the on-screen key row sends, so a tapped row lands exactly as a
   * walked one. Nothing here decides what the options are. */
  const answerQuestion = (option: SelectOption) => {
    if (!liveQuestion || questionSent) return;
    clearPending();
    if (!deliver(selectKeys(liveQuestion.current, option.index))) return;
    setQuestionSent({ signature: questionSignature, number: option.number });
  };
  /** Walks a several-question dialog — Claude Code's ←/→, Codex's
   * PageUp/PageDown — so an answer already given can be changed before it is
   * sent. No row is pending, but none can be tapped until the session redraws. */
  const stepQuestion = (from: number, to: number) => {
    const keys = questionTabKeys(from, to, questionStepKeys);
    if (!liveQuestion || questionSent || keys.length === 0) return;
    clearPending();
    if (!deliver(keys)) return;
    setQuestionSent({ signature: questionSignature, number: -1 });
  };
  /** Answers the question's free-text row (`freeTextRow`) with what was typed
   * under it: the highlight walked there, the words, and Enter where Enter
   * sends them (`freeTextWrites`). */
  const answerQuestionText = (option: SelectOption, text: string) => {
    if (!liveQuestion || questionSent) return;
    const writes = freeTextWrites(liveQuestion.current, option, text);
    if (writes.length === 0) return;
    clearPending();
    if (!deliver(writes)) return;
    setQuestionSent({ signature: questionSignature, number: option.number });
  };
  /** The stored session only grows at message boundaries, so a turn busy in
   * tool calls looked finished. The live screen's interrupt hint says it is
   * not; a choice on screen is waiting on the reader instead. */
  const sessionWork = useMemo(
    () => (sessionShown && !liveQuestion ? agentWork(liveScreen) : null),
    [sessionShown, liveQuestion, liveScreen],
  );
  const sessionBusy = sessionWork !== null;
  /** What the working row says beside the dots: the elapsed time and the
   * tokens the agent's own spinner prints, in its words. A family that prints
   * neither leaves the line as it was. */
  const workFacts = [
    sessionWork?.elapsed,
    sessionWork?.tokens ? t("mobile.focus.workingTokens", { count: sessionWork.tokens }) : undefined,
  ].filter((fact): fact is string => !!fact);
  /** The model the stored session last answered with, by its family word
   * (`claude-opus-4-5-…` → `Opus`). Read on every transcript poll, so it
   * follows the session — unlike `tab.agent_model`, which is the row as it
   * was when this screen opened (a tab the phone just created has none yet). */
  const transcriptModel = sinceClear ? undefined : workingModelName(transcript?.model);
  /** Who the working row names: the model's family word as the session prints
   * it (`Opus 4.5` → `Opus`), else the stored session's, else the tab's
   * published model; a tab with none keeps the generic "Agent". */
  const workingModel = (status?.model ?? transcriptModel ?? tab.agent_model)?.trim().split(/\s+/)[0];
  /** The screen's lines as the reading view shows them: the revealed history,
   * the open chunk, then the live tail. */
  const screenStream = useMemo(
    () => [...visibleChunks.flatMap((chunk) => chunk.lines), ...earlier.open, ...painted],
    [visibleChunks, earlier.open, painted],
  );
  /** A shell's Focus has no messages to hold for a menu (`useMessageMenu`), so
   * it copies what the reading view shows: the revealed history, the open
   * chunk, then the live tail. */
  const copyReadable = async () => {
    try {
      await navigator.clipboard.writeText(readableText(screenStream));
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  // New turns push the prompt up as surely as a scroll does.
  useLayoutEffect(checkPinnedPrompt, [checkPinnedPrompt, view, sessionShown, sessionEntries, screenStream, openStep, subagentListOpen, sentListOpen]);
  const jumpToLatest = () => {
    const stream = readableHost.current;
    if (!stream) return;
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    followReadable(true);
  };
  const stopVoice = () => recognition.current?.stop();
  /** A tap while the on-device check runs takes the check back, so a browser
   * whose check hangs (or a long language download) never locks the button. */
  const cancelVoicePrep = () => {
    voiceRequest.current += 1;
    setPreparingVoice(false);
    setVoiceStatus(null);
  };
  const startVoice = async () => {
    if (!connectedRef.current || recognition.current || preparingVoice) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceFailure({ key: "mobile.voice.unavailable" });
      return;
    }
    const request = voiceRequest.current + 1;
    voiceRequest.current = request;
    const language = speechTag();
    setPreparingVoice(true);
    setVoiceStatus({ key: "mobile.voice.checking" });
    setVoiceFailure(null);
    // Read at the tap, like the language: the menu's choice applies to the
    // next dictation without this closure having to follow it.
    const mode = readFlag("voiceRemote") ? "remote" : await prepareOnDeviceSpeech(Recognition, language);
    if (voiceRequest.current !== request) return;
    setPreparingVoice(false);
    if (!connectedRef.current) {
      setVoiceStatus(null);
      setVoiceFailure({ key: "mobile.voice.disconnected" });
      return;
    }
    if (mode === "installed") {
      setVoiceStatus({ key: "mobile.voice.installed", language });
      return;
    }
    voiceProgress.current = DICTATION_START;
    setVoicePreview("");
    setVoiceFailure(null);
    // The session restarts the browser's recognizer through pauses, so
    // "listening" holds from the tap until the stop (`voiceSession.ts`).
    const session: DictationSession = startDictation(Recognition, { lang: language, local: mode === "local" }, {
      onStart: () => {
        setListening(true);
        setVoiceStatus({ key: mode === "local" ? "mobile.voice.listeningLocal" : "mobile.voice.listeningRemote" });
      },
      onResult: (event) => {
        const reading = readDictation(event);
        const step = advanceDictation(voiceProgress.current, reading.heard);
        voiceProgress.current = step.progress;
        // Speech is inserted into the current prompt, not submitted: the user
        // reviews it and presses Send — or says "go on" / "los" last, which
        // leaves the draft and sends the rest (`spokenSend`). The ref, not
        // the state, is read and moved: two results can land in one render.
        if (step.insert) {
          const current = draftRef.current;
          const next = `${current}${current && !current.endsWith(" ") ? " " : ""}${step.insert}`;
          const spoken = spokenSend(next);
          draftRef.current = spoken ?? next;
          setDraft(spoken ?? next);
          if (spoken !== null) {
            forgetDictation();
            submitDraftRef.current(spoken);
            return;
          }
        }
        setVoicePreview(dictationPreview(step.progress, reading.interim));
      },
      // A new recognizer's result list starts empty: everything the last one
      // heard is in the draft already, and none of it is read back.
      onRestart: () => { voiceProgress.current = DICTATION_START; },
      onError: (message) => setVoiceFailure({ key: message }),
      onLevel: (level) => paintMicLevel(dictateButton.current, level),
      onEnd: () => {
        if (recognition.current === session) recognition.current = undefined;
        setListening(false);
        setVoiceStatus(null);
      },
    });
    recognition.current = session;
  };
  useEffect(() => () => {
    voiceRequest.current += 1;
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.abort();
      paintMicLevel(dictateButton.current, null);
    }
  }, [tab.id]);
  const dictateLabel = t(listening ? "mobile.voice.stop" : preparingVoice ? "mobile.voice.preparing" : "mobile.voice.dictate");
  const sayVoice = (note: VoiceNote) => t(note.key, note.language ? { language: note.language } : undefined);
  /** A browser without Web Speech says so from the start: no action clears
   * that, so it is derived rather than stored beside the failures that do. */
  const voiceProblem: VoiceNote | null = voiceFailure ?? (voiceAvailable ? null : { key: "mobile.voice.unavailable" });
  const voiceLine = voiceProblem ? sayVoice(voiceProblem)
    : voicePreview ? t("mobile.voice.heard", { text: voicePreview })
    : voiceStatus ? sayVoice(voiceStatus) : "";
  /** What the sheet paints: the live step, or — between the tap and the
   * session's redraw — the answered one, listed but not tappable, so the sheet
   * does not blink empty on the way to the next step. */
  /** The model chip's label: the model the session prints, with the reasoning
   * effort beside it where the session prints one too (Antigravity). Without a
   * readable status it falls back to the stored session's model, then the
   * tab's published one — the desktop's reading of this same line, composed
   * the same way, or the transcript's id behind it. */
  const modelChip = status?.model
    ? (status.effort ? `${status.model} · ${status.effort}` : status.model)
    : transcriptModel ?? tab.agent_model ?? t("terminal.reader.model");
  const shownStep = listedStep ?? (answered && picker ? answered : null);
  /** The highlighted row — where it was before a reveal walk moved it. */
  const shownAt = reveal?.origin ?? picker?.options[picker.current]?.number;
  const pickerOptions: SheetOption[] = (shownStep?.options ?? []).map((option) => ({
    key: String(option.number),
    label: option.label,
    description: option.description,
    current: option.number === shownAt,
  }));
  /** Antigravity's effort step: the stops its slider is drawing for the model
   * the sheet just walked to, in its own words. */
  const effortOptions: SheetOption[] = (effortStep && effortSlider ? effortSlider.stops : []).map((stop, index) => ({
    key: String(index),
    label: stop.label,
    description: stop.description,
    current: index === effortSlider?.current,
  }));
  const modeOptions: SheetOption[] = modes.map((choice) => ({
    key: choice.value,
    label: choice.label,
    description: choice.description,
    current: choice.value === activeMode,
    pending: choice.value === switching,
  }));
  const failedMode = modes.find((choice) => choice.value === switchFailed);
  const addOptions: SheetOption[] = [
    { key: "phone", label: t("mobile.add.phone"), description: t("mobile.add.phoneHint"), current: false },
    { key: "gallery", label: t("mobile.add.gallery"), description: t("mobile.add.galleryHint"), current: false },
    { key: "desktop", label: t("mobile.add.desktop"), description: t("mobile.add.desktopHint"), current: false },
    { key: "project", label: t("mobile.add.project"), description: t("mobile.add.projectHint"), current: false },
  ];
  const desktopOptions: SheetOption[] = (desktopImages ?? []).map((image) => ({
    key: image.id,
    label: image.name,
    description: desktopImageDescription(image),
    current: false,
  }));
  const subagentUntested = isUntested("mobile.focus.subagents") ? t("mobile.focus.untested") : "";
  const planUntested = isUntested("mobile.focus.planBubble") ? t("mobile.focus.untested") : "";
  /** Where the open subagent stands among its siblings, and the conversation
   * the bar goes back up to. */
  const subagentPosition = openStep ? siblingPosition(openStep) : { index: -1, count: 0 };
  /** The open subagent at work: it has not reported back, and the session is
   * at work or it runs in the background. Its row names the subagent's own
   * model, not the session's. */
  const subagentWorking = openSubagentRunning(subagentPath, sessionEntries, sessionBusy);
  const subagentModel = workingModelName(subTranscript?.model);
  /** What the subagent's working row says beside the dots, as the session's
   * does: how long since it was spawned (its entry's stamp, else its own
   * first record's) and the tokens its newest request carried. */
  const subagentStart = openStep?.at ?? (subTranscript && !subTranscript.truncated ? subTranscript.entries[0]?.at : undefined);
  const subagentTimed = subagentWorking && !!subagentStart;
  const [subagentNow, setSubagentNow] = useState(() => Date.now());
  // The elapsed time counts on by the second while the row is up.
  useEffect(() => {
    if (!subagentTimed) return;
    setSubagentNow(Date.now());
    const timer = window.setInterval(() => setSubagentNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subagentTimed]);
  const subagentTokens = compactTokens(subTranscript?.tokens);
  const subagentFacts = [
    workingElapsed(subagentStart, subagentNow),
    subagentTokens ? t("mobile.focus.workingTokens", { count: subagentTokens }) : undefined,
  ].filter((fact): fact is string => !!fact);
  const subagentRowUntested = isUntested("mobile.subagent.working") || isUntested("mobile.subagent.workingFacts");
  const subagentParent = subagentPath.length > 1 ? subagentPath[subagentPath.length - 2].task : t("mobile.subagent.main");
  /** A subagent's conversation in the Reader: under a bar that goes back up
   * to the conversation it was opened from and steps through the subagents
   * beside it, laid out as the session is. Its first prompt is the task it
   * was given; the cards in it open its own subagents. */
  const subagentView = openStep && <>
    <nav className="subagent-bar" aria-label={t("mobile.subagent.region")}>
      <button className="subagent-up" onClick={subagentUp} aria-label={t("mobile.subagent.back", { name: subagentParent })}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
      </button>
      <div className="subagent-title">
        <small>{openStep.role ?? t("mobile.subagent.region")}{subagentUntested && <em> · {subagentUntested}</em>}</small>
        <strong>{openStep.task || openStep.role}</strong>
      </div>
      {subagentPosition.count > 1 && <div className="subagent-steps">
        <button disabled={subagentPosition.index <= 0} onClick={() => subagentSibling(-1)} aria-label={t("mobile.subagent.previous")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <span>{t("mobile.subagent.position", { index: subagentPosition.index + 1, count: subagentPosition.count })}</span>
        <button disabled={subagentPosition.index >= subagentPosition.count - 1} onClick={() => subagentSibling(1)} aria-label={t("mobile.subagent.next")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>}
    </nav>
    {!subTranscript
      ? <div className="readable-empty"><strong>{t("mobile.subagent.loading")}</strong></div>
      : !subTranscript.available
      ? <div className="readable-empty"><strong>{t("mobile.subagent.missing")}</strong><span>{t("mobile.subagent.missingHint")}</span><button onClick={subagentUp}>{t("mobile.subagent.back", { name: subagentParent })}</button></div>
      : subTranscript.entries.length === 0
      ? <div className="readable-empty"><strong>{t("mobile.subagent.empty")}</strong></div>
      : <div className="readable-lines chat transcript" data-testid="subagent-transcript">
          {subTranscript.truncated && <button className="readable-earlier" onClick={() => setSubLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.transcript.earlier")}</button>}
          <TranscriptTurns entries={subTranscript.entries} cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.subagent.task")} planLabel={t("mobile.transcript.plan")} planUntested={planUntested} agentLabel={t("mobile.subagent.region")} agentUntested={subagentUntested} onOpenAgent={openSubagentTurn} />
          {subagentWorking && <div className="transcript-working" role="status" data-testid="subagent-working">
            <span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span>
            {subagentModel ? t("mobile.focus.workingModel", { model: subagentModel }) : t("mobile.focus.working")}
            {(subagentFacts.length > 0 || subagentRowUntested) && <small className="transcript-working-facts">
              {subagentFacts.join(" · ")}
              {subagentRowUntested && <em>{subagentFacts.length > 0 && " · "}{t("mobile.focus.untested")}</em>}
            </small>}
          </div>}
        </div>}
  </>;
  return <main className={`terminal-screen ${tab.kind}-tab`} style={viewportHeight ? { height: viewportHeight } : undefined}><header><button className="back" onClick={back}>‹</button><div className="terminal-title"><h1>{tab.label}</h1><small>{t(tab.kind === "agent" ? "mobile.focus.agentSession" : "mobile.focus.shellSession")}</small></div>{outbox.length > 0 && <button className="terminal-gallery" onClick={() => setGallery(true)} aria-label={t("mobile.outbox.galleryOpen", { count: outbox.length })} title={t("mobile.outbox.region")}><span aria-hidden="true">🖼</span><small>{outbox.length}</small></button>}<div className="terminal-view-switch" aria-label={t("mobile.focus.outputView")}><button className={view === "focus" ? "selected" : ""} aria-pressed={view === "focus"} aria-haspopup={chat ? "menu" : undefined} aria-expanded={chat ? focusMenu : undefined} onClick={() => {
      // An agent tab's Reader is a list once it is up: where it reads from.
      if (chat && view === "focus") setFocusMenu((open) => !open);
      else chooseView("focus");
    }}>{t(chat ? "mobile.focus.chat" : "mobile.focus.reader")}{chat && <span className="view-caret" aria-hidden="true" />}</button><button className={view === "terminal" ? "selected" : ""} aria-pressed={view === "terminal"} onClick={() => { setFocusMenu(false); chooseView("terminal"); }}>{t("mobile.focus.terminal")}</button></div><span className={connected ? "lamp" : "lamp off"} /></header>
    {focusMenu && chat && view === "focus" && <div className="focus-menu-backdrop" role="presentation" onClick={() => setFocusMenu(false)}>
      <div className="focus-menu" role="menu" aria-label={t("mobile.focus.source")} onClick={(event) => event.stopPropagation()}>
        {/* Dimmed when the stored session cannot be read (an agent whose
            transcript Tabtivity does not read, no session id yet); the row then
            says which, rather than doing nothing. */}
        <button role="menuitemradio" aria-checked={sessionShown} aria-disabled={transcript?.available ? undefined : "true"} className={transcript?.available ? undefined : "unavailable"} onClick={() => {
          if (!transcript?.available) return;
          setFocusSource("session");
          setFocusMenu(false);
        }}>
          <span><strong>{t("mobile.focus.session")} {isUntested("mobile.focus.session") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{transcript?.available ? t("mobile.focus.sessionHint") : t(noSessionReason(transcript))}{!transcript?.available && transcript?.reason === "no_session" && isUntested("mobile.focus.noSessionYet") && <em> · {t("mobile.focus.untested")}</em>}</small></span>
          {sessionShown && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        <button role="menuitemradio" aria-checked={!sessionShown} onClick={() => {
          setFocusSource("screen");
          setFocusMenu(false);
        }}>
          <span><strong>{t("mobile.focus.screen")}</strong><small>{t("mobile.focus.screenHint")}</small></span>
          {!sessionShown && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        {/* Spoken from the stored session only: its answers arrive whole, where
            the screen's are still being drawn. */}
        <button role="menuitemcheckbox" aria-checked={readAloud && speechAvailable} aria-disabled={speechAvailable ? undefined : "true"} className={speechAvailable ? undefined : "unavailable"} onClick={() => {
          if (!speechAvailable) return;
          // The tap is the gesture a browser wants before a page may speak.
          if (readAloud) stopSpeaking();
          else unlockSpeech();
          writeFlag("focusReadAloud", !readAloud);
          setReadAloud(!readAloud);
          setFocusMenu(false);
        }}>
          <span><strong>{t("mobile.speech.auto")} {isUntested("mobile.focus.readAloud") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{t(speechAvailable ? "mobile.speech.autoHint" : "mobile.speech.unavailable")}</small></span>
          {readAloud && speechAvailable && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        <button role="menuitemcheckbox" aria-checked={voiceRemote && voiceLocalOffered} aria-disabled={voiceLocalOffered ? undefined : "true"} className={voiceLocalOffered ? undefined : "unavailable"} onClick={() => {
          if (!voiceLocalOffered) return;
          writeFlag("voiceRemote", !voiceRemote);
          setVoiceRemote(!voiceRemote);
        }}>
          <span><strong>{t("mobile.voice.remote")} {isUntested("mobile.voice.remote") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{t(voiceLocalOffered ? "mobile.voice.remoteHint" : "mobile.voice.remoteOnly")}</small></span>
          {voiceRemote && voiceLocalOffered && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
        </button>
        {/* The one language for both directions — what an answer is read in
            and what dictation is listened for. The phone's own is the default,
            and the row says which language that turned out to be. */}
        <button role="menuitem" aria-haspopup="dialog" aria-expanded={speechLangSheet} onClick={() => {
          setFocusMenu(false);
          setSpeechLangSheet(true);
        }}>
          <span><strong>{t("mobile.speech.language")} {isUntested("mobile.speech.language") && <em>{t("mobile.focus.untested")}</em>}</strong><small>{speechLangSummary(speechLang, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </div>}
    <div className="terminal-body">
      <div ref={host} className={`terminal${view === "focus" ? " focus-source" : ""}`} />
      <div ref={wideHint} className="terminal-wide-hint" aria-hidden="true" />
      {/* The stored session does not depend on the screen, so a full-screen
          agent (OpenCode's TUI) still reads as a chat in Focus. */}
      {view === "focus" && altScreen && !sessionShown && <div className="alt-screen-notice"><strong>{t("mobile.focus.altScreen")}</strong><span>{t("mobile.focus.altScreenHint")}</span>{openCode && !transcript?.available && <span>{t("mobile.focus.openCodeMini")}</span>}{tab.kind === "agent" && transcript?.available && <button onClick={() => setFocusSource("session")}>{t("mobile.focus.sessionHint")}</button>}<button className="primary" onClick={() => chooseView("terminal")}>{t("mobile.focus.altScreenOpen")}</button></div>}
      {view === "focus" && (!altScreen || sessionShown) && <>
        <section ref={readableHost} className="readable-output" aria-label={t("mobile.focus.output")} aria-live="polite"
          onScroll={(event) => {
            const stream = event.currentTarget;
            followReadable(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120);
            checkPinnedPrompt();
          }}>
          {/* The sticky strip over the chat: the session's subagents and the
              files it carried, each a chip that opens its list. */}
          {sessionShown && !openStep && (sessionAgents.length > 0 || agentsEarlier || chatFiles.length > 0) && <div className="chat-index">
            {(sessionAgents.length > 0 || agentsEarlier) &&
            <nav className={`subagent-index${subagentListOpen ? " open" : ""}`} aria-label={t("mobile.subagent.indexRegion")}>
              <button type="button" className="subagent-index-toggle" aria-expanded={subagentListOpen} aria-controls="mobile-subagent-list" onClick={() => { setSentListOpen(false); setSubagentListOpen((open) => !open); }}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v7a4 4 0 0 0 4 4h7m-3-3 3 3-3 3" /></svg>
                <span>{t("mobile.subagent.index", { count: `${sessionAgents.length}${agentsEarlier ? "+" : ""}` })}{subagentUntested && <em> · {subagentUntested}</em>}</span>
                <svg className={subagentListOpen ? "expanded" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {subagentListOpen && <div id="mobile-subagent-list" className="subagent-index-list">
                {sessionAgents.map((entry, index) => <button type="button" key={`${entry.at ?? index}:${index}`} disabled={!entry.subagent} aria-label={`${entry.role ?? t("mobile.subagent.region")} · ${entry.text}`} onClick={() => openListedSubagent(entry)}>
                  <small>{entry.role ?? t("mobile.subagent.region")}</small>
                  <span>{entry.text}{entry.cut && "…"}</span>
                </button>)}
                {agentsEarlier && <button type="button" className="subagent-index-earlier" onClick={() => setTranscriptLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.subagent.earlier")}</button>}
              </div>}
            </nav>}
            {chatFiles.length > 0 && <SentFilesIndex tabId={tab.id} files={chatFiles} open={sentListOpen} onToggle={() => { setSubagentListOpen(false); setSentListOpen((open) => !open); }} onOpen={openSentFile} />}
          </div>}
          {sessionShown && openStep
            ? subagentView
            : sessionShown
            ? ((transcript || preSessionWait) && sessionEntries.length === 0 && !liveQuestion && !sessionBusy
              ? (undoing
                ? <div className="readable-empty" role="status" aria-busy="true"><span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span><strong>{t("mobile.transcript.undoing")}</strong></div>
                // A fresh tab while its CLI starts: the banner it draws is not
                // a conversation. The screen stays one tap away.
                : preSessionWait && (!cliReady || !transcript)
                ? <div className="readable-empty" role="status" aria-busy="true" data-testid="session-starting">
                    <span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span>
                    <strong>{cliReady ? t("mobile.focus.sessionLoading") : t("mobile.focus.starting", { agent: agentLabel })}{isUntested("mobile.focus.starting") && <em> · {t("mobile.focus.untested")}</em>}</strong>
                    <button onClick={() => setStartGaveUp(true)}>{t("mobile.focus.startingScreen")}</button>
                  </div>
                : <div className="readable-empty"><strong>{t("mobile.transcript.empty")}</strong><span>{t("mobile.transcript.emptyHint")}</span></div>)
              : <div className="readable-lines chat transcript" data-testid="session-transcript">
                  {transcript?.truncated && !sinceClear && <button className="readable-earlier" onClick={() => setTranscriptLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.transcript.earlier")}</button>}
                  <TranscriptTurns entries={sessionEntries} part="settled" cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.transcript.prompt")} planLabel={t("mobile.transcript.plan")} planUntested={planUntested} agentLabel={t("mobile.subagent.region")} agentUntested={subagentUntested} onOpenAgent={openSubagentTurn} onResend={resendPrompt} onEdit={startEdit} posts={chatPosts} renderPost={renderPost} inbox={chatInbox} />
                  {liveQuestion && <div className="transcript-screen" role="group" aria-label={t("mobile.transcript.question")}>
                    <small>{t("mobile.transcript.question")}{isUntested("mobile.focus.onScreen") && <> · {t("mobile.focus.untested")}</>}</small>
                    {/* The screen the dialog was drawn onto, as the screen drew
                        it — in Claude Code's permission dialog the file and the
                        diff it is asking about. Bounded by `readSelectPrompt`
                        to what the rows answer: the turn above it is already in
                        the conversation, and an unprompted session's banner is
                        not a question. The rows themselves are replaced by the
                        list below — a highlight walked with arrow keys is not
                        something a phone can do — and the question above them
                        is that list's heading. */}
                    {questionContext.length > 0 && <ReadableTurns lines={questionContext} chat={chat} agent={agentLabel} promptLabel={t("mobile.transcript.prompt")} columns={paneColumns.current} />}
                    <QuestionList prompt={liveQuestion} tabs={questionTabs} tabFocus={questionTabFocus} tabSubmit={questionTabSubmit} question={questionAsk} sent={sentSignature === questionSignature ? questionSent?.number : undefined} sendingLabel={t("mobile.transcript.answering")} onPick={answerQuestion} onType={answerQuestionText} onStep={stepQuestion} />
                  </div>}
                  {sessionBusy && <div className="transcript-working" role="status">
                    <span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span>
                    {workingModel ? t("mobile.focus.workingModel", { model: workingModel }) : t("mobile.focus.working")}
                    {workFacts.length > 0 && <small className="transcript-working-facts">
                      {workFacts.join(" · ")}
                      {isUntested("mobile.focus.workingFacts") && <em> · {t("mobile.focus.untested")}</em>}
                    </small>}
                  </div>}
                  {/* A prompt sent while the agent worked waits below its work
                      until the desktop types it in: not taken yet. */}
                  {queuedShown && <TranscriptTurns entries={sessionEntries} part="queued" cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.transcript.prompt")} onResend={resendPrompt} onEdit={startEdit} inbox={chatInbox} />}
                </div>)
            : painted.length === 0 && visibleChunks.length === 0 && earlier.open.length === 0
            ? <div className="readable-empty"><strong>{t("mobile.focus.waitingOutput")}</strong><span>{t("mobile.focus.waitingOutputHint")}</span></div>
            : <div className={chat ? "readable-lines chat" : "readable-lines"}>
                {clipped && <div className="readable-notice">{t("mobile.focus.truncated")}</div>}
                {hiddenLines > 0 && <button className="readable-earlier" onClick={showEarlier}>{t("mobile.focus.earlierOutput", { count: hiddenLines.toLocaleString() })}</button>}
                {hiddenLines === 0 && earlier.dropped && <div className="readable-notice">{t("mobile.focus.truncated")}</div>}
                {/* An agent's output is laid out as ONE stream: grouped piece by
                    piece, a turn that ran from the history into the live
                    screen was cut in two where they met — and that seam moved
                    every time rows scrolled into the history. A shell has no
                    turns, so it keeps the memoized chunks. */}
                {chat
                  ? <ReadableTurns lines={screenStream} chat agent={agentLabel} promptLabel={t("mobile.transcript.prompt")} columns={paneColumns.current} />
                  : <>
                    {visibleChunks.map((chunk) => <ReadableTurns key={chunk.id} lines={chunk.lines} chat={false} promptLabel={t("mobile.transcript.prompt")} />)}
                    <ReadableTurns lines={earlier.open} chat={false} promptLabel={t("mobile.transcript.prompt")} />
                    <ReadableTurns lines={painted} chat={false} promptLabel={t("mobile.transcript.prompt")} />
                  </>}
              </div>}
        </section>
        {!openStep && pinnedPrompt && <button className="readable-pinned-prompt" style={pinnedTop ? { top: pinnedTop + 6 } : undefined} aria-label={t("mobile.focus.lastPrompt")}
          onClick={() => pinnedPromptEl.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
          <span className="readable-pinned-prompt-text">{pinnedPrompt}</span>
          {isUntested("mobile.focus.pinnedPrompt") && <em>{t("mobile.focus.untested")}</em>}
        </button>}
        {statusStrip && statusSwipe && <div className="focus-statusline" role="status" aria-label={t("mobile.focus.statusLine")}>
          <div className="focus-statusline-head"><strong>{t("mobile.focus.statusLine")} {isUntested("mobile.focus.statusLine") && <small>{t("mobile.focus.untested")}</small>}</strong><button onClick={() => setStatusStrip(false)} aria-label={t("mobile.focus.statusLineHide")}>✕</button></div>
          {frameStatus.length
            ? frameStatus.map((row, i) => <div key={i} className="focus-statusline-row">{row}</div>)
            : <div className="focus-statusline-empty">{t("mobile.focus.statusLineEmpty")}</div>}
        </div>}
        {/* A chat copies message by message and picks its source under the
            Focus button, so nothing floats over its newest lines. */}
        {!chat && lines.length > 0 && <div className="readable-tools">
          <button onClick={() => void copyReadable()} aria-label={t("mobile.focus.copySession")}>{t(copied ? "mobile.focus.copied" : "mobile.focus.copy")}</button>
        </div>}
        {!atBottom && <button className="readable-jump" onClick={jumpToLatest}>{t("mobile.focus.jumpLatest")}</button>}
      </>}
    </div>
    <div className="terminal-controls">
      {tab.kind === "agent" && voiceLine && <div className={voiceProblem ? "voice-feedback error" : "voice-feedback"} role={voiceProblem ? "alert" : "status"} aria-live="polite">{voiceLine}{listening && !voiceProblem && !voicePreview && (isUntested("mobile.voice.keepListening") || isUntested("mobile.voice.spokenSend")) && <em>{t("mobile.focus.untested")}</em>}</div>}
      {stoppedReason && <div className="voice-feedback error" role="alert">{stoppedReason}{isUntested("mobile.link.failureText") && <em> · {t("mobile.focus.untested")}</em>}</div>}
      {sendFailed && !stoppedReason && <div className="voice-feedback error" role="alert">{t("mobile.composer.notDelivered")}</div>}
      {undoNote && <div className="voice-feedback" role="status">{t(undoNote)}</div>}
      {subagentTarget && (subagentSending || subagentNote) && <div className={subagentNote ? "voice-feedback error" : "voice-feedback"} role={subagentNote ? "alert" : "status"}>{t(subagentNote || "mobile.subagent.sending")}{isUntested("mobile.subagent.input") && <em> · {t("mobile.focus.untested")}</em>}</div>}
      {editNote && !editing && <div className={editNote === "mobile.composer.heldEditFailed" ? "voice-feedback error" : "voice-feedback"} role="status">{t(editNote)}{editNote === "mobile.composer.heldNote" && <> {t("mobile.composer.holdToInterrupt")}{isUntested("mobile.composer.sendHold") && <> · <em>{t("mobile.focus.untested")}</em></>}</>}{isUntested("mobile.chat.editHeld") && <> · <em>{t("mobile.focus.untested")}</em></>}</div>}
      {editing && <div className="sign-in-notice" role="status">
        <span>{t(editNote === "mobile.composer.heldEditFailed" ? "mobile.composer.heldEditFailed" : "mobile.composer.editingHeld")}{isUntested("mobile.chat.editHeld") && <> · <em>{t("mobile.focus.untested")}</em></>}</span>
        <button onPointerDown={(event) => event.preventDefault()} onClick={cancelEdit}>{t("mobile.composer.editCancel")}</button>
      </div>}
      {clearRefused && liveBusy && <div className="voice-feedback" role="status">{t("mobile.composer.clearBusy")}{isUntested("mobile.composer.clearBusy") && <> · <em>{t("mobile.focus.untested")}</em></>}</div>}
      {lastSent && !sessionShown && <div className="last-sent"><span>{t("mobile.composer.lastSent")}</span><p>{lastSent}</p></div>}
      {uploads.map((upload) => upload.failure && <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{t(upload.failure)}</span><button onClick={() => dismissUpload(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.name })}>✕</button></div>)}
      {/* What goes with the next message, as pictures beside the draft —
          never as `@` text in it (`withAttachments` adds the references on
          Send). */}
      {uploads.some((upload) => !upload.failure) && <div className="composer-attachments" role="group" aria-label={t("mobile.inbox.attached")}>
        {uploads.map((upload) => {
          if (upload.failure) return null;
          const leaf = upload.reference === undefined ? undefined : leafOfReference(upload.reference);
          const known = leaf === undefined ? undefined : inboxFiles.get(leaf);
          const picture = upload.preview ?? (known && known.kind.startsWith("image/") ? inboxFileUrl(tab.id, known.name) : undefined);
          return <ComposerThumb key={upload.id} name={upload.name} picture={picture} kind={known?.kind} sending={leaf === undefined}
            onRemove={leaf === undefined ? undefined : () => dismissUpload(upload.id)} removeLabel={t("mobile.inbox.detach", { name: upload.name })} />;
        })}
        <small className="composer-attachments-note" role="status">
          {t(!uploading ? "mobile.inbox.attached" : uploads.some((upload) => uploadInFlight(upload) && upload.source === "desktop") ? "mobile.inbox.copyingNote" : "mobile.inbox.sendingNote")}
          {(isUntested("mobile.composer.attachHeld") || isUntested("mobile.composer.thumbnails")) && <> · <em>{t("mobile.focus.untested")}</em></>}
        </small>
      </div>}
      {signIn && !signInSheet && signIn.url !== hiddenSignIn && <div className="sign-in-notice" role="status">
        <span>{t("mobile.signIn.banner", { agent: agentLabel })}</span>
        <button className="primary" onClick={() => setSignInSheet(true)} aria-haspopup="dialog">{t("mobile.signIn.open")}</button>
        <button className="sign-in-hide" onClick={() => setHiddenSignIn(signIn.url)} aria-label={t("mobile.signIn.hide")} title={t("mobile.signIn.hide")}>✕</button>
      </div>}
      {hiddenLink && !signIn && !signInSheet && hiddenSignIn !== HIDDEN_LINK && <div className="sign-in-notice" role="status">
        <span>
          {linkMissing ? t("mobile.signIn.noLink", { agent: agentLabel }) : t("mobile.signIn.onDesktop", { agent: agentLabel })}
          {isUntested("mobile.signIn.hiddenLink") && <> · <em>{t("mobile.focus.untested")}</em></>}
        </span>
        <button className="primary" onClick={askForLink} disabled={!connected || linkAsking}>{linkAsking ? t("mobile.signIn.gettingLink") : t("mobile.signIn.getLink")}</button>
        <button className="sign-in-hide" onClick={() => setHiddenSignIn(HIDDEN_LINK)} aria-label={t("mobile.signIn.hide")} title={t("mobile.signIn.hide")}>✕</button>
      </div>}
      {signedOut && signInWay && !signInSheet && !signedOutHidden && <div className="sign-in-notice" role="status">
        <span>
          {t("mobile.signIn.signedOutBanner", { agent: agentLabel })}
          {isUntested("mobile.signIn.tab") && <> · <em>{t("mobile.focus.untested")}</em></>}
        </span>
        <button className="primary" onClick={signInWay.start} disabled={openingSignIn}>{openingSignIn ? t("mobile.signIn.opening") : t("mobile.signIn.open")}</button>
        <button className="sign-in-hide" onClick={() => setSignedOutHidden(true)} aria-label={t("mobile.signIn.hide")} title={t("mobile.signIn.hide")}>✕</button>
      </div>}
      {view === "focus" && markupAsk && <div className="sign-in-notice markup-ask-notice" role="status">
        <span>
          {!markupAsk.file_name ? t("mobile.markup.questions.bannerAny")
            : markupAskFile || markupAskRow ? t("mobile.markup.questions.banner", { file: markupAsk.file_name })
              : t("mobile.markup.questions.bannerElsewhere", { file: markupAsk.file_name })}
          {isUntested("mobile.markup.questions") && <> · <em>{t("mobile.focus.untested")}</em></>}
        </span>
        {markupAskFile && <button className="primary" onClick={() => setOutboxOpen(markupAskFile)}>{t("mobile.markup.questions.bannerOpen")}</button>}
        {markupAskRow && <button className="primary" onClick={() => openAskedRow(markupAskRow)}>{t("mobile.markup.questions.bannerOpen")}</button>}
      </div>}
      {signInError && !signInSheet && <div className="inbox-upload error" role="alert"><strong>{t("mobile.signIn.open")}</strong><span>{signInError}</span><button onClick={() => setSignInError("")} aria-label={t("mobile.signIn.hide")}>✕</button></div>}
      {(tab.kind === "agent" || status?.branch || contextLeft || shownLimits.session || shownLimits.week) && <div className="session-facts">
        {/* An agent tab's model, mode and status lead the row as tappable facts:
            the composer keeps the whole bar for the draft and its buttons. */}
        {tab.kind === "agent" && <>
          <button className="fact-action" onClick={() => setStatusSheet(true)} aria-haspopup="dialog" aria-expanded={statusSheet} title={t("mobile.facts.statusHint")}><span className={`fact-lamp ${lamp}`} aria-hidden="true" /><span className="fact-action-label">{t("terminal.reader.status.button")}</span></button>
          <button className="fact-action" disabled={!connected} onClick={selectModel} aria-haspopup="dialog" aria-expanded={modelSheet} title={t("mobile.facts.modelHint")}><span className="fact-action-label">{modelChip}</span></button>
          <button className={`fact-action${status?.mode === "plan" ? " fact-action-plan" : ""}`} disabled={!connected} onClick={openModeSheet} aria-haspopup={modes.length > 0 ? "dialog" : undefined} aria-expanded={modes.length > 0 ? modeSheet : undefined} title={t(modes.length > 0 ? "mobile.facts.modeHint" : "mobile.facts.modeCycle")}><span className="fact-action-label">{status?.mode ?? activeMode ?? t("terminal.reader.mode")}</span></button>
          {status?.mode === "plan" && isUntested("mobile.focus.planModeMark") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
          {openCode && altScreen && status && isUntested("mobile.focus.openCodeComposer") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
        </>}
        {status?.branch && <span className="fact-branch">⎇ {status.branch}</span>}
        {contextLeft && <span className="fact-context">{t("terminal.reader.contextLeft", { percent: contextLeft })}</span>}
        {shownLimits.session && <span className={`fact-limit${shownLimits.session.percent >= 90 ? " high" : ""}`} title={shownLimits.session.resets ? resetText(shownLimits.session.resets, limitTime, readTime) : undefined}>{t("mobile.facts.session", { percent: Math.round(100 - shownLimits.session.percent) })}{sessionReset && <> · {t("mobile.facts.resetIn", { time: sessionReset })}</>}</span>}
        {shownLimits.week && <span className={`fact-limit${shownLimits.week.percent >= 90 ? " high" : ""}`} title={shownLimits.week.resets ? resetText(shownLimits.week.resets, limitTime, readTime) : undefined}>{t("mobile.facts.week", { percent: Math.round(100 - shownLimits.week.percent) })}{weekReset && <> · {t("mobile.facts.resetIn", { time: weekReset })}</>}</span>}
        {(sessionReset || weekReset) && isUntested("mobile.facts.limitResets") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
      </div>}
      <div className="prompt-composer">
        {slashMenu.length > 0 && <div className="slash-menu" role="group" aria-label={t("mobile.slash.title")}>
          <div className="slash-menu-head">{t("mobile.slash.title")} {isUntested("mobile.composer.slash") && <em>{t("mobile.focus.untested")}</em>}</div>
          {/* Pointer-down is held back so a tap does not take the focus off
              the field: the keyboard stays up for the argument. */}
          {slashMenu.map((suggestion) => <div key={suggestion.line} className={`slash-row${suggestion.used ? " used" : ""}`}>
            <button className="slash-pick" onPointerDown={(event) => event.preventDefault()} onClick={() => pickSlash(suggestion)}>
              <strong>{suggestion.line}</strong>
              {suggestion.used ? <small>{t("mobile.slash.recent")}{suggestion.description ? ` · ${suggestion.description}` : ""}</small> : suggestion.description && <small>{suggestion.description}</small>}
            </button>
            {suggestion.used && <button className="slash-forget" onPointerDown={(event) => event.preventDefault()} onClick={() => forgetSlash(suggestion.line)} aria-label={t("mobile.slash.forget", { command: suggestion.line })} title={t("mobile.slash.forget", { command: suggestion.line })}>✕</button>}
          </div>)}
        </div>}
        <div className="composer-field">
          <textarea ref={composerInput} value={draft} disabled={!connected} rows={1} aria-label={t(tab.kind === "agent" ? "mobile.composer.messageAgent" : "mobile.composer.shellCommand")} placeholder={connected ? (tab.kind === "agent" ? (subagentTarget ? t("mobile.subagent.placeholder") : t("mobile.composer.placeholderAgent")) : t("mobile.composer.placeholderShell")) : t("mobile.indReconnecting")} onChange={(event) => setDraft(event.target.value)} onFocus={() => setComposerTyping(true)} onBlur={typingStopped} onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // Enter confirms a candidate inside an IME composition (CJK keyboards,
            // and 229 is what Android keyboards report mid-composition); that
            // one belongs to the keyboard, not to the send.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            submitDraft();
          }} />
          {(draft.includes("\n") || draft.length > 60) && isUntested("mobile.composer.autoGrow") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
          {draft && <button className="composer-clear" onClick={clearDraft} aria-label={t("mobile.composer.clear")} title={t("mobile.composer.clear")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
          {tab.kind === "agent" && <button className={`composer-dictate${listening ? " listening" : ""}`} disabled={!connected || !voiceAvailable} title={t(voiceAvailable ? "mobile.voice.hint" : "mobile.voice.hintUnavailable")} aria-label={dictateLabel} aria-pressed={listening} ref={dictateButton} onClick={listening ? stopVoice : preparingVoice ? cancelVoicePrep : () => void startVoice()}>{listening ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}</button>}
        </div>
        <div className="composer-bar">
          {tab.kind === "agent" && <>
            <input ref={fileInput} type="file" accept={ANY_FILE_ACCEPT} multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-file-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <input ref={galleryInput} type="file" accept="image/*,video/*" multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-gallery-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <button className="composer-add" disabled={!connected} onClick={() => setAddSheet(true)} aria-label={t("mobile.add.title")} aria-haspopup="dialog" aria-expanded={addSheet} title={t("mobile.add.hint")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
            {/* Folds the key row below in and out; it starts folded. */}
            <button className={`composer-keys${keysShown ? " open" : ""}`} onPointerDown={(event) => event.preventDefault()} onClick={toggleKeys} aria-label={t(keysShown ? "mobile.composer.keysHide" : "mobile.composer.keysShow")} aria-expanded={keysShown} aria-controls="terminal-keys" title={t(keysShown ? "mobile.composer.keysHide" : "mobile.composer.keysShow")}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" /></svg></button>
            {/* Plan / Goal / Clear sit centred between the keys button and Send, evenly spaced. */}
            <div className="composer-chips">
            {prefixCommands.map((command) => {
              const plan = command === "/plan";
              return <button key={command} className={`composer-prefix${activePrefix === command ? " active" : ""}`} disabled={!connected} aria-pressed={activePrefix === command} onPointerDown={(event) => event.preventDefault()} onClick={() => togglePrefix(command)} title={t(plan ? "mobile.composer.planHint" : "mobile.composer.goalHint")}>{t(plan ? "mobile.composer.plan" : "mobile.composer.goal")}</button>;
            })}
            {/* Clear sends /clear at once, draft or not; the draft stays. Right
                after one it reads Undo, until the new chat gets a prompt. */}
            {undoing
              ? <button className="composer-prefix composer-undoing" disabled aria-busy="true" onPointerDown={(event) => event.preventDefault()} aria-label={t("mobile.composer.undoing")} title={t("mobile.composer.undoing")}><span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span>{t("mobile.composer.undoing")}</button>
              : undoable
              ? <button className="composer-prefix" disabled={!connected} onPointerDown={(event) => event.preventDefault()} onClick={undoClearConversation} aria-label={t("mobile.composer.undoClearHint")} title={t("mobile.composer.undoClearHint")}>{t("mobile.composer.undoClear")}</button>
              : <button className="composer-prefix" disabled={!connected} onPointerDown={(event) => event.preventDefault()} onClick={clearConversation} aria-label={t("mobile.composer.clearChat")} title={t("mobile.composer.clearChat")}>{t("mobile.composer.clearChip")}</button>}
            {((undoable && isUntested("mobile.composer.undoClear")) || (undoing && isUntested("mobile.composer.undoing"))) && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
            {/* Commit opens its sheet: one commit, or split into several. */}
            <button className="composer-prefix composer-commit" disabled={!connected} onPointerDown={(event) => event.preventDefault()} onClick={() => setCommitSheet(true)} aria-label={t("mobile.commit.open")} aria-haspopup="dialog" aria-expanded={commitSheet} title={t("mobile.commit.open")}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M2 12h6.5M15.5 12H22" /></svg></button>
            </div>
          </>}
          {tab.kind !== "agent" && <>
            <button className={`composer-keys${keysShown ? " open" : ""}`} onPointerDown={(event) => event.preventDefault()} onClick={toggleKeys} aria-label={t(keysShown ? "mobile.composer.keysHide" : "mobile.composer.keysShow")} aria-expanded={keysShown} aria-controls="terminal-keys" title={t(keysShown ? "mobile.composer.keysHide" : "mobile.composer.keysShow")}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" /></svg></button>
            <span className="composer-spacer" />
          </>}
          <button className="send-icon" disabled={!connected || (!draft.trim() && !attached) || uploading || editSending} {...(tab.kind === "agent" && !editing ? sendHoldHandlers : {})} onClick={() => {
            if (sendHold.current.fired) {
              sendHold.current.fired = false;
              return;
            }
            submitDraft();
          }} aria-label={t(editing ? "mobile.composer.editSave" : "mobile.question.typeSend")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z" /><path d="M7 12h13" /></svg></button>
        </div>
      </div>
      {keysShown && <div className="keys" id="terminal-keys">
      {isUntested("mobile.composer.keysToggle") && <em className="composer-untested keys-untested">{t("mobile.focus.untested")}</em>}
      <button className={ctrl ? "selected" : ""} aria-pressed={ctrl} disabled={!connected} onClick={() => setCtrl((on) => !on)}>Ctrl</button><button disabled={!connected} onClick={() => press("\u001b")}>Esc</button><button disabled={!connected} onClick={() => press("\t")}>Tab</button><button disabled={!connected} onClick={() => press("\u001b[D")}>←</button><button disabled={!connected} onClick={() => press("\u001b[A")}>↑</button><button disabled={!connected} onClick={() => press("\u001b[B")}>↓</button><button disabled={!connected} onClick={() => press("\u001b[C")}>→</button><button disabled={!connected} onClick={() => press("\r")}>Enter</button><button disabled={!connected} onClick={() => press("\u007f")}>⌫</button><button className="danger" disabled={!connected} onClick={() => window.confirm(t("mobile.keys.interruptConfirm")) && type("\u0003")}>{t("mobile.keys.interrupt")}</button>
      </div>}
    </div>
    {modelSheet && (effortStep
      ? <OptionSheet
        title={t("mobile.model.effortTitle", { model: effortStep })}
        note={{ text: isUntested("mobile.model.effort")
          ? `${t("mobile.model.effortHint")} · ${t("mobile.focus.untested")}`
          : t("mobile.model.effortHint") }}
        options={effortOptions}
        waiting={t(connected ? "mobile.model.waitingSession" : "mobile.model.waitingConnection")}
        busy={effortOptions.length === 0}
        onPick={chooseEffort}
        onClose={closeModelSheet}
      />
      : <OptionSheet
        title={shownStep?.title ?? t("terminal.reader.modelTitle")}
        note={cursorAgent && isUntested("mobile.model.cursor") ? { text: t("mobile.focus.untested") } : undefined}
        options={pickerOptions}
        waiting={t(!connected
          ? "mobile.model.waitingConnection"
          : answered ? "mobile.model.waitingSession" : "terminal.reader.modelWaiting")}
        busy={shownStep != null && (pickerStep == null || reveal != null || effortFor != null)}
        onPick={chooseModel}
        onClose={closeModelSheet}
      />)}
    {speechLangSheet && <SpeechLangSheet chosen={speechLang} onChoose={setSpeechLang} onClose={() => setSpeechLangSheet(false)} />}
    {addSheet && <OptionSheet
      title={t("mobile.add.title")}
      options={addOptions}
      waiting=""
      busy={false}
      onPick={pickAdd}
      onClose={() => setAddSheet(false)}
    />}
    {commitSheet && <OptionSheet
      title={t("mobile.commit.title")}
      note={isUntested("mobile.composer.commit") ? { text: t("mobile.focus.untested") } : undefined}
      options={commitOptions}
      waiting=""
      busy={!connected}
      onPick={pickCommit}
      onClose={() => setCommitSheet(false)}
    />}
    {desktopSheet && <OptionSheet
      title={t("mobile.add.desktop")}
      note={desktopFailure
        ? { text: t(desktopFailure), error: true }
        : desktopImages?.length ? { text: t("mobile.desktopImages.pick") } : undefined}
      options={desktopOptions}
      waiting={desktopImages === null
        ? t("mobile.desktopImages.looking")
        : t(desktopFailure ? "mobile.desktopImages.retry" : "mobile.desktopImages.none")}
      busy={false}
      onPick={attachFromDesktop}
      onClose={() => setDesktopSheet(false)}
    />}
    {modeSheet && <OptionSheet
      title={t("terminal.reader.modeTitle")}
      note={failedMode
        ? { text: t("mobile.mode.failed", { mode: failedMode.label }), error: true }
        : fixedMode ? { text: t("mobile.focus.modeFixed") } : undefined}
      options={modeOptions}
      waiting={t(fixedMode ? "mobile.focus.modeFixed" : "mobile.mode.none")}
      busy={switching !== "" || fixedMode}
      onPick={(key) => void applyMode(key)}
      onClose={() => { if (!switching) setModeSheet(false); }}
    />}
    {statusSheet && <StatusSheet tab={tab} live={status} onLimits={rememberLimits} onClose={() => setStatusSheet(false)} signIn={signInWay} />}
    {signInSheet && <SignInSheet
      tabId={tab.id}
      agent={agentLabel}
      signIn={signIn}
      done={signedIn && (signInTab || !signIn)}
      ended={stoppedReason !== ""}
      signInTab={signInTab}
      alternate={signInTab ? signInAlternate(slashCliKey) : undefined}
      error={signInError}
      choice={signInChoice}
      onChoose={(option) => {
        if (!signInChoice) return false;
        clearPending();
        return deliver(selectKeys(signInChoice.current, option.index));
      }}
      onRetry={signInTab && openTab ? (alternate) => void openSignIn(alternate) : undefined}
      onFinish={finishSignIn}
      connected={connected}
      onType={(text) => {
        clearPending();
        return deliver([text, "\r"]);
      }}
      onClose={() => setSignInSheet(false)}
    />}
    {/* The viewer covers the phone; the gallery stays chosen behind it, so
        closing the file lands back on the grid. */}
    {gallery && !outboxOpen && <OutboxGallery scope={outboxScope} files={outbox} onOpen={openOutbox} onDetails={setOutboxOpen} onDelete={removeOutbox} onClose={() => setGallery(false)} />}
    {outboxOpen && <OutboxViewer key={`${tab.id}/${outboxOpen.name}`} scope={outboxScope} file={outboxOpen} pictures={outboxPictures} onStep={setOutboxOpen} onClose={() => setOutboxOpen(null)} markup={markupTarget}
      newTab={markupNewTab} />}
    {/* What the reader sent is only looked at: no Mark up, no stepping. */}
    {inboxOpen && !outboxOpen && <OutboxViewer key={`${tab.id}/inbox/${inboxOpen.name}`} scope={inboxScope} file={inboxOpen} onClose={() => setInboxOpen(null)} />}
    {askedFile && askedScope && <OutboxViewer key={`asked/${askedFile.file.ref}`} scope={askedScope} file={askedFile.file} onClose={() => setAskedFile(null)}
      markup={markupTarget && { ...markupTarget, place: askedFile.place, refresh: refreshAskedFile }} />}
    {filesOpen && project && filesLabel !== null && <ProjectFiles key={project} projectId={project} label={filesLabel} onClose={closeFiles}
      markup={markupTarget && { tabId: markupTarget.tabId, onSend: markupTarget.onSend, agent: markupTarget.agent }} showTab={markupNewTab?.show} />}

  </main>;
}
