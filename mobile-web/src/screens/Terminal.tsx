import { FileImageIcon } from "../../../src/components/common/icons/Icon";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { AgentStatusMark } from "../components/AgentStatusPill";
import { WorktreeChip, worktreeTitle } from "../components/AgentModeMarks";
import { useMessageMenu, type HoldHandlers } from "../components/MessageMenu";
import { useChatLinks, type LinkHandlers } from "../components/LinkSheet";
import { OptionSheet, type SheetOption } from "../components/OptionSheet";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { AttachSheet, type AttachTile } from "../components/AttachSheet";
import { QuestionRows } from "../components/QuestionRows";
import { SpeechLangSheet, speechLangSummary } from "../components/SpeechLangPicker";
import { OutboxGallery } from "../components/OutboxGallery";
import { OutboxViewer, type MarkupBack, type MarkupNewTab, type MarkupTarget } from "../components/OutboxViewer";
import { dialogLine, type AgentSignal } from "../markup/submitState";
import { useMarkupAsks } from "../markup/questions";
import { SentFilesIndex } from "../components/SentFilesIndex";
import { useScopeKind } from "../scopeKind";
import { TabbyHead } from "../components/TabbyHead";
import { ComposerThumb, InboxAlbum } from "../components/InboxPreview";
import { ProjectFiles } from "../components/ProjectFiles";
import { Fragment, memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  ANY_FILE_ACCEPT,
  ApiError,
  api,
  attachDesktopImage,
  closeTab,
  inboxFileUrl,
  listDesktopImages,
  MAX_INBOX_FILE,
  openSignInTab,
  openTeleportTab,
  pickPhoneFiles,
  refreshProjectFile,
  sentName,
  getTabWorktrees,
  moveTabWorktree,
  getAssistantModels,
  switchAssistantModel,
  uploadToInbox,
  type DesktopImage,
  type OutboxFile,
  type PhoneMarkupFile,
  type ViewerScope,
  type ProjectDetail,
  type SessionTranscript,
  type AskedQuestion,
  type TabRow,
  type TabWorktrees,
  type AssistantModels,
} from "../api";
import { describeFailure } from "../connection";
import { readDraft } from "../drafts";
import { readFlag, readTerminalView, writeFlag, writeTerminalView, type TerminalViewChoice } from "../prefs";
import { readSpeechLang, speechTag, type SpeechLang } from "../speechLang";
import { readableText, type ReadableLine } from "../terminal/readableScreen";
import { type HistoryChunk } from "../terminal/readableHistory";
import { type TerminalControl } from "../terminal/protocol";
import { inputFrameStart, sessionStatus, statusModelTag, type SessionStatus } from "../terminal/statusLine";
import { readPromptSuggestion } from "../terminal/promptSuggestion";
import { transcriptModelTag } from "../../../src/lib/agents/agentModel";
import { worktreeChoiceText, worktreeMoveNote } from "../../../src/lib/agents/agentWorktrees";
import { sessionLimits } from "../terminal/sessionUsage";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { BackNest } from "../backStack";
import {
  freeTextRow,
  readCodexHooksPage,
  readReviewStep,
  readSelectPrompt,
  readStrayDialog,
  pressHintShown,
  dialogFooterShown,
  selectKeys,
  type QuestionTab,
  type SelectOption,
  type SelectPrompt,
  type SelectStep,
} from "../terminal/selectPrompt";
import { isOpenCodeTab, openCodeDialogCloseKeys } from "../terminal/openCodeMini";
import { groupOpenCodeModels, openCodeModelGroupTitle } from "../terminal/openCodeModelGroups";
import { isAntigravityTab } from "../terminal/antigravity";
import { isCursorTab } from "../terminal/cursorAgent";
import { currentMode, modeChoices, modeFixed, shiftTabKey } from "../terminal/agentModes";
import { agentFamily } from "../terminal/composer";
import { CommitFiles } from "./CommitFiles";
import { agentWork } from "../terminal/agentBusy";
import { chatTurns, isLiveEcho } from "../terminal/chatTurns";
import { answerHtml, promptHtml } from "../terminal/answerMarkdown";
import { chatDayLabel, chatMoment, chatTime, dayOpeners } from "../terminal/chatTimes";
import { commandArgsInline, slashCommand, transcriptTurns, type SlashCommand, type TranscriptTurn } from "../terminal/transcriptTurns";
import { compactTokens, openSubagentRunning, siblingPosition, splitByWork, subagentAtWork, workingElapsed, workingModelName, type SubagentStep } from "../terminal/subagents";
import { type PendingPrompt } from "../terminal/pendingPrompts";
import { type OutboxPost as ChatPost } from "../terminal/outboxPosts";
import { inboxInPlace, inboxLeaves, inboxSegments, withoutInboxReferences } from "../terminal/inboxRefs";
import { type ClearMark } from "../terminal/clearedSession";
import { readHeld } from "../terminal/heldPrompts";
import { ageLabel } from "../terminal/fileLabels";
import { formatBytes } from "../../../src/lib/formatBytes";
import { resetCountdown, resetText, StatusSheet } from "./StatusSheet";
import { SignInSheet } from "./SignInSheet";
import { hasSignInTab, readCloudLink, readCloudSession, readHiddenSignIn, readPagedSignIn, readSignedOut, readSignIn, readSignInPage, signInAlternate, signInCommand, signInDone, type SignIn, type SignInPage } from "../terminal/signIn";
import { type LimitMeters } from "../../../shared/usageReport";
import { isUntested } from "../../../src/lib/untested";
import { ChatChanges } from "../components/ChatChanges";
import { readSlashCommands, slashCli } from "../slashCommands";
import {
  onDeviceSpeechAsked,
  speechRecognitionConstructor,
  speechRecognitionSupported,
  DICTATION_START,
  type DictationProgress,
} from "../voiceInput";
import { type DictationSession } from "../voiceSession";
import { usePenWriting } from "../penWriting";
import { speechOutputSupported, stopSpeaking, unlockSpeech } from "../speechOutput";
import { useComposerUploads, useComposerSend, useComposerTools } from "./terminal/useComposer";
import { useTerminalViewport, useTerminalSocket } from "./terminal/useTerminalSocket";
import { useReadableFollow, useEarlierOutput } from "./terminal/useReadableView";
import {
  useSessionTranscript, useSessionEntries, useSubagentReader, useReadAloud, useLimitsPoll,
} from "./terminal/useSessionChat";
import { useOutboxPoll, useOutboxViewers } from "./terminal/useOutbox";
import { useModelPicker, useModelPickerAnswers } from "./terminal/useModelPicker";
import { useSignInPageWalk } from "./terminal/useSignInPageWalk";
import { useLiveQuestion } from "./terminal/useLiveQuestion";
import { useVoiceInput } from "./terminal/useVoiceInput";
import {
  type VoiceNote, TRANSCRIPT_STEP, UNDO_RELOADS, LINK_WAIT_MS, type InboxUpload, leafOfReference,
  liftedDraft, uploadInFlight, withAttachments, type ChatInbox,
} from "./terminal/terminalShared";

/** CLIs whose queue the desktop reads for Send now. Mirrors `queue_hint` in
 * `src-tauri/src/services/mobile_control/pty_bridge.rs`. */
const SEND_NOW_FAMILIES: ReadonlySet<string> = new Set(["claude"]);

/** `hiddenSignIn`'s value once the reader hid the hidden-link notice. */
const HIDDEN_LINK = "\u0000hidden-link";
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

/** "Screenshots · 3 min ago · 1.2 MB", or "Clipboard · 1920×1080". */
function desktopImageDescription(image: DesktopImage) {
  return [
    image.source,
    image.age_secs != null ? ageLabel(image.age_secs) : "",
    image.size != null ? formatBytes(image.size) : "",
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

/** A block of screen lines: a shell's Focus output, or the screen a dialog an
 * agent waits on was drawn onto. On an agent tab they lay out as a chat: the
 * agent's turns on the left as printed, a prompt echo as a bubble on the
 * right, see `chatTurns`. A shell has no turns and paints flat. Memoized on
 * the `lines` reference: a frozen history chunk and the open chunk keep
 * theirs, so the per-frame rebuild of the live tail costs nothing for however
 * much history is on screen. */
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

/** Per tab, the markup view tucked away behind its chat (`markupAway`): the
 * chat's way back to the file outlives the tab being left, and the tab opens
 * again with the view tucked away under the same bar. For as long as the
 * app runs. */
const awayMarkups = new Map<string, MarkupBack>();

/** A prompt's words, with the files it sent from the phone drawn above them
 * as pictures — a messenger's picture with its caption — and their `@`
 * references left out of the words. Pictures the words caption in several
 * places (a markup prompt's marked picture, then its layer) are each drawn
 * where they stand instead (`inboxSegments`). Both follow from the text
 * alone, so a shown bubble keeps its shape. */
function PromptBody({ text, links, inbox }: { text: string; links: LinkHandlers; inbox?: ChatInbox }) {
  const leaves = useMemo(() => inbox ? inboxLeaves(text) : [], [inbox, text]);
  const segments = useMemo(() => leaves.length > 0 ? inboxSegments(text) : [], [leaves, text]);
  if (!inbox || leaves.length === 0) return <PromptText text={text} links={links} />;
  if (inboxInPlace(segments)) {
    // The untested note once, under the first album.
    const first = segments.findIndex((segment) => segment.kind === "files");
    return <>{segments.map((segment, i) => segment.kind === "words"
      ? <PromptText key={i} text={segment.text} links={links} />
      : <InboxAlbum key={i} tabId={inbox.tabId} leaves={segment.leaves} files={inbox.files} onOpen={inbox.onOpen} onSettle={inbox.onSettle} tag={i === first ? undefined : null} />)}</>;
  }
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
function SubagentCard({ turn, label, untested, time, busy = false, onOpen }: {
  turn: TranscriptTurn;
  label: string;
  untested: string;
  time?: ReactNode;
  /** The conversation it was spawned from is at work (`subagentAtWork`). */
  busy?: boolean;
  onOpen?: (turn: TranscriptTurn) => void;
}) {
  const t = useT();
  const openable = !!turn.subagent && !!onOpen;
  return <button type="button" className="transcript-agent" disabled={!openable} aria-label={`${label}: ${turn.role ? `${turn.role} · ` : ""}${turn.text}`} onClick={() => onOpen?.(turn)}>
    <svg className="transcript-agent-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v7a4 4 0 0 0 4 4h7m-3-3 3 3-3 3" /></svg>
    <span className="transcript-agent-body">
      <small>{turn.role ?? label}{untested && <em> · {untested}</em>}</small>
      <span>{turn.text}{turn.cut && "…"}</span>
      {/* Where it works, when that is a worktree and not the project folder. */}
      {turn.worktree && <span className="transcript-agent-worktree">
        <WorktreeChip worktree={turn.worktree} title={worktreeTitle(t, turn.worktree)} />
        {isUntested("mobile.project.subagentWorktree") && <em className="untested">{t("mobile.newTab.untested")}</em>}
      </span>}
      {time}
    </span>
    {turn.finished ? <AgentStatusMark status="done" /> : subagentAtWork(turn, busy) && <AgentStatusMark status="working" />}
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
const TranscriptTurns = memo(function TranscriptTurns({ entries, part, cutLabel, promptLabel, planLabel = "", planUntested = "", agentLabel = "", agentUntested = "", busy = false, onOpenAgent, onResend, onEdit, posts, renderPost, inbox }: {
  entries: SessionTranscript["entries"];
  part?: "settled" | "queued";
  cutLabel: string;
  promptLabel: string;
  /** The heading over a plan's bubble, and its untested mark. */
  planLabel?: string;
  planUntested?: string;
  agentLabel?: string;
  agentUntested?: string;
  /** The conversation is at work: its subagents that have not reported back are too. */
  busy?: boolean;
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
      ? <SubagentCard turn={turn} label={agentLabel} untested={agentUntested} time={time} busy={busy} onOpen={onOpenAgent} />
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
 * whole turns — and Terminal on a shell. Focus hands over to Terminal once the
 * agent turns out to have no stored session to read (`unsupported`). */
function initialView(tab: TabRow): TerminalViewChoice {
  return readTerminalView(viewAgentOf(tab)) ?? (tab.kind === "agent" ? "focus" : "terminal");
}

/** Why an agent tab's stored session is not shown: the chat's own row, and
 * the dimmed Chat entry of an agent with none. */
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
    {prompt.source === "opencode" && isUntested("agents.opencode.questions") && <em>{t("mobile.focus.untested")}</em>}
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
    {prompt.options.some((option) => option.keys) && isUntested("mobile.question.codexHooksPage") && <em>{t("mobile.focus.untested")}</em>}
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
export function Terminal({ tab, project: projectOfTab, back, pickModel = false, subagent, signInTab: openedToSignIn = false, openTab, markupBack }: {
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
  openTab?: (tab: TabRow, opts?: { signIn?: boolean; markupBack?: MarkupBack }) => void;
  /** Opened from a markup view's Open tab: that view, marking, is kept here
   * tucked away under the bar over the composer, which brings it back. */
  markupBack?: MarkupBack;
}) {
  // From the tab list, or after the PWA reloaded on the way back from the
  // sign-in page, only the row knows — and without it the sheet lost its
  // retry, its other way in and the Done that closes the tab.
  const signInTab = openedToSignIn || tab.sign_in === true;
  /** A vendor cloud session (`TabRow.cloud`): its CLI may only print the
   * session's link and exit, so there is no local session to wait for. */
  const cloudTab = tab.cloud === true;
  const t = useT();
  /** A chat of the assistant scope: it has no folder behind it, so the
   * affordances that reach one are gone — the files drawer, the outbox, inbox
   * uploads (the composer's **+**), Commit and Mark up. */
  const bare = useScopeKind(projectOfTab) === "assistant";
  const project = bare ? undefined : projectOfTab;
  const host = useRef<HTMLDivElement>(null);
  const wideHint = useRef<HTMLDivElement>(null);
  const readableHost = useRef<HTMLElement>(null);
  /** The latest `back`, for the swipe listener that outlives a render. */
  const backRef = useRef(back);
  backRef.current = back;
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** A pen writes here: the composer opens a few lines tall, so the system's
   * handwriting-to-text (iPad Scribble) has room to write in. */
  const penWriting = usePenWriting();
  /** Re-reads the emulated screen on demand — used when Focus is opened, so the
   * reading view is current instead of waiting for the next output byte. */
  const refreshReadable = useRef<() => void>(() => {});
  /** Hands bytes to the socket. `prompt` tags the frame with the pending
   * bubble it belongs to, so a lost frame marks that bubble and not the
   * composer's generic notice. */
  const write = useRef<(value: string, prompt?: number) => boolean>(() => false);
  /** Hands a control frame to the socket; false when none is open. */
  const sendControl = useRef<(frame: TerminalControl) => boolean>(() => false);
  /** This socket's bridge takes `send_now` (its `features`). */
  const [sendNowReady, setSendNowReady] = useState(false);
  /** A `send_now` is out and not answered yet. */
  const sendNowAsking = useRef(false);
  /** What a `send_now` answer does, as the latest render has it. */
  const sendNowAnswer = useRef<(sent: boolean) => void>(() => {});
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
  /** The attached screen's rows, the viewport only: whether OpenCode has a
   * dialog up over its composer (`openCodeDialogCloseKeys`). */
  const viewportRows = useRef<() => string[]>(() => []);
  const [viewportHeight, setViewportHeight] = useState<number>();
  const [connected, setConnected] = useState(false);
  const [stoppedReason, setStoppedReason] = useState("");
  // The desktop's AI switch is off: the bridge acked what was typed but
  // dropped it (`ai_off` event). Said for a few seconds after each drop.
  const [aiOffAt, setAiOffAt] = useState(0);
  // The switch as the terminal socket reports it (`ai_switch`, `ai_off`):
  // while off an agent tab's composer keeps its draft instead of sending.
  const [aiOff, setAiOff] = useState(false);
  const aiOffRef = useRef(false);
  aiOffRef.current = aiOff;
  useEffect(() => {
    if (!aiOffAt) return;
    const id = window.setTimeout(() => setAiOffAt(0), 6000);
    return () => window.clearTimeout(id);
  }, [aiOffAt]);
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
  const chooseView = (next: TerminalViewChoice) => {
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
  /** A sign-in page the CLI scrolls in its own window because the pane is too
   * short for its link (`readSignInPage`): every line any frame has shown,
   * which the walk below pages through until the link is whole. */
  const [signInPage, setSignInPage] = useState<SignInPage | null>(null);
  useEffect(() => {
    setSignInPage((known) => (tab.kind === "agent" ? readSignInPage(liveScreen, known) : null));
  }, [tab.kind, liveScreen]);
  const screenSignIn = useMemo(
    () => (tab.kind === "agent" ? readSignIn(liveScreen) ?? (signInPage ? readPagedSignIn(signInPage) : null) : null),
    [tab.kind, liveScreen, signInPage],
  );
  /** The cloud session's page, as the cloud tab's CLI printed it. */
  const cloudLink = useMemo(() => (cloudTab ? readCloudLink(liveScreen) : null), [cloudTab, liveScreen]);
  /** The session id it printed for taking the session over (`--teleport`). */
  const cloudSession = useMemo(() => (cloudTab ? readCloudSession(liveScreen) : null), [cloudTab, liveScreen]);
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
   * reading pin alike, with the bubble's own time (`.transcript-time`). The subagent index sticks over the top of the chat:
   * a bubble behind it is out of sight too, and the pin sits under it
   * (`pinnedTop`, px below the view's top) — drawn over it, it was hidden. */
  const [pinnedPrompt, setPinnedPrompt] = useState("");
  const [pinnedTime, setPinnedTime] = useState("");
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
    setPinnedTime(owner?.querySelector(":scope > .transcript-time")?.textContent ?? "");
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
  /** The tab's CLI (`agentFamily`). */
  const agentKey = agentFamily(tab.agent_label ?? tab.label);
  /** Send now is offered where the desktop can tell the CLI's queue apart —
   * Claude's queue hint (`queue_hint` in `pty_bridge.rs`); Codex and Copilot
   * take a mid-turn prompt in at once, and OpenCode marks its queue nowhere
   * on screen. */
  const sendNowOffered = sendNowReady && SEND_NOW_FAMILIES.has(agentKey);
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
  const [teleporting, setTeleporting] = useState(false);
  const [teleportError, setTeleportError] = useState("");
  /** One key per session, kept until the desktop answers: a retry after a
   * lost answer finds the tab (and worktree) the first try made. */
  const teleportKeys = useRef<Record<string, string>>({});
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
  /** The rows this CLI build's picker drew last time (`getModelRows`), listed
   * until the session draws its own; the one tapped among them, answered in
   * the live picker by its label once it is all there; whether this opening
   * answered its first list yet (Codex's next list is reasoning levels, not
   * models), and the list last kept for the next opening. */
  const [rememberedStep, setRememberedStep] = useState<SelectStep | null>(null);
  const [heldPick, setHeldPick] = useState<string | null>(null);
  const sheetAnswered = useRef(false);
  const keptStep = useRef<SelectStep | null>(null);
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
  /** The ⎇ chip's sheet: where the agent can move (`null` while asked), the
   * id a move is under way to, and what the last ask or move ran into. */
  const [worktreeSheet, setWorktreeSheet] = useState(false);
  const [worktreeChoices, setWorktreeChoices] = useState<TabWorktrees | null>(null);
  const [worktreeMoving, setWorktreeMoving] = useState("");
  const [worktreeNote, setWorktreeNote] = useState<TranslationKey | "">("");
  /** A Tabby chat's model chip: its `/model` is off, so the sheet lists what
   * the desktop's own chip lists and a pick restarts the chat on it. */
  const [assistantSheet, setAssistantSheet] = useState(false);
  const [assistantModels, setAssistantModels] = useState<AssistantModels | null>(null);
  const [assistantSwitching, setAssistantSwitching] = useState("");
  const [assistantNote, setAssistantNote] = useState<TranslationKey | "">("");
  /** The status chip's sheet: the session's state and the CLI's own usage
   * panel. Opening it asks the desktop, which may run the CLI once. */
  const [statusSheet, setStatusSheet] = useState(false);
  /** The account's session (5h) and weekly windows, read off the same usage
   * panel the status sheet shows — the facts row prints them beside the
   * context figure. Empty until a read answers or for a CLI without one. */
  const [limits, setLimits] = useState<LimitMeters>({});
  const [limitBars, setLimitBars] = useState(() => readFlag("limitBars"));
  const toggleLimitBars = () => {
    setLimitBars(!limitBars);
    writeFlag("limitBars", !limitBars);
  };
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
  // The key row's Interrupt asks first, in the phone's own sheet.
  const [interruptSheet, setInterruptSheet] = useState(false);
  /** The "From the desktop" list: `null` while the desktop is being asked. */
  const [desktopSheet, setDesktopSheet] = useState(false);
  const [desktopImages, setDesktopImages] = useState<DesktopImage[] | null>(null);
  const [desktopFailure, setDesktopFailure] = useState<TranslationKey | "">("");
  const { setUploads, uploads, uploading, attached } = useComposerUploads({ tab, uploadsRef });
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
  /** The markup view this tab opens with tucked away: the one whose Open tab
   * showed it, else the one tucked away here when the tab was last left. */
  const [markupReturn] = useState(() => markupBack ?? awayMarkups.get(tab.id));
  const [askedFile, setAskedFile] = useState<{ file: OutboxFile; place?: string; folder?: string; scope?: ViewerScope; marking?: boolean } | null>(
    () => (markupReturn ? { ...markupReturn, marking: true } : null),
  );
  /** The markup view tucked away behind the chat (its **Chat** button, while a
   * round is with this tab): still mounted — layer, round pill, scroll — and
   * brought back by the bar over the composer. Holds the file's name. */
  const [markupAway, setMarkupAway] = useState<string | null>(() => (markupReturn ? sentName(markupReturn.file) : null));
  // Brought back, closed or swapped for another file: the tab no longer
  // reopens with it.
  useEffect(() => {
    if (markupAway === null) awayMarkups.delete(tab.id);
    else if (markupReturn && !awayMarkups.has(tab.id)) awayMarkups.set(tab.id, markupReturn);
  }, [markupAway, markupReturn, tab.id]);
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
  /** Why the queued prompts did not all come back (`pullQueued`), and
   * whether a pull is under way. */
  const [queueNote, setQueueNote] = useState<TranslationKey | "">("");
  const [queuePulling, setQueuePulling] = useState(false);
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
  /** Send now was tapped; its Esc waits for a moment that loses nothing. */
  const [sendNowWaiting, setSendNowWaiting] = useState(false);
  /** The agent is in a turn — by its screen, or by the desktop's word — so a
   * prompt sent now is held for its next idle point (`holdDraft`). */
  const agentAtWork = tab.kind === "agent" && (liveBusy || tab.agent_status === "working");
  // Once the turn is over the button works again; the note goes with it.
  useEffect(() => { if (clearRefused && !liveBusy) setClearRefused(false); }, [clearRefused, liveBusy]);
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
  /** The Diffs view (`ChatChanges`) over the chat or the terminal, picked in
   * the view pill's list like the desktop's Diffs tab; never remembered. */
  const [diffsOpen, setDiffsOpen] = useState(false);
  /** The project's name while the desktop's "Project files on the phone"
   * switch is on for it (`detail.files`) — null while off, or unknown. */
  const [filesLabel, setFilesLabel] = useState<string | null>(null);
  /** Which sides the drawer's library has (`detail.files`, `detail.host_files`). */
  const [filesSides, setFilesSides] = useState({ here: true, host: false });
  /** The files drawer, the project screen's own, opened here by a right→left
   * swipe over the output. */
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
  /** The same drop, straight from the camera: `capture` skips every chooser
   * and opens it on Android and iOS alike. */
  const cameraInput = useRef<HTMLInputElement>(null);
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
    setDiffsOpen(false);
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
    setFocusMenu(false);
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
    setAssistantSheet(false);
    setAssistantModels(null);
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
    setRememberedStep(null);
    setHeldPick(null);
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

  useTerminalViewport({ setViewportHeight });


  useTerminalSocket({
    tab, host, wideHint, readableHost, refreshReadable, write, sendControl, setSendNowReady,
    sendNowAsking, sendNowAnswer, recognition, dictateButton, connectedRef, voiceRequest,
    lastOutputAt, bracketedPaste, screenRows, viewportRows, setConnected, setStoppedReason,
    setAiOffAt, setAiOff, setAltScreen, setAltFrame, setSendFailed, setLines, setClipped,
    setSignInSheet, setCopiedLink, linkAsked, linkTimer, setLinkAsking, setLinkMissing, setEarlier,
    followReadable, atNewest, setListening, setPreparingVoice, setVoiceStatus, setVoiceFailure,
    setPending, setScreenTick, paneColumns,
  });
  useReadableFollow({ readableHost, refreshReadable, altScreen, view, atBottomRef, transcript });
  const {
    setComposerTyping, typingStopped, chatUnavailable, sessionFocus, transcriptCurrent,
    transcriptVersion, setCommitRefresh, uncommitted, uncommittedCount,
  } = useSessionTranscript({
    tab, bare, composerInput, view, setView, setTranscript, transcript, pending,
    setTranscriptReload, transcriptReload, transcriptLimit, screenTick,
  });
  const {
    cliReady, sessionWaiting, sinceClear, storedEntries, sessionEntries, sessionAgents,
    earlierAgents, agentsEarlier, queuedShown, chatPosts, inboxFiles, chatFiles,
  } = useSessionEntries({
    tab, cloudTab, liveScreen, uploads, outbox, transcript, pending, clearedAt, undoing, setUndoing,
    sessionFocus,
  });
  const {
    subToken, subTranscript, openSubagentTurn, openListedSubagent, subagentUp, subagentSibling,
  } = useSubagentReader({
    tab, readableHost, view, setAtBottom, atBottomRef, pending, setSubagentNote, setSubagentPath,
    setSubagentListOpen, setSentListOpen, openStep, subRead, setSubRead, setSubLimit, subLimit,
    restoreScroll, sessionEntries,
  });
  useReadAloud({ tab, t, listening, transcript, readAloud, sessionFocus });
  // A new turn in the stored session, or a file the agent sent into the
  // Focus chat, scrolls the view to it, as new screen output does, unless
  // the reader has scrolled up to read.
  useLayoutEffect(() => {
    if (!sessionFocus || !atBottom) return;
    const stream = readableHost.current;
    if (stream && typeof stream.scrollTo === "function") stream.scrollTo({ top: stream.scrollHeight });
  }, [sessionFocus, transcript, pending, chatPosts, atBottom, subToken, subTranscript]);
  useOutboxPoll({ tab, bare, setOutbox, setGallery, setOutboxOpen, setInboxOpen });
  useLimitsPoll({ tab, setLimitsNow, rememberLimits });
  const {
    openOutbox, renderPost, chatInbox, inboxScope, openSentFile, removeOutbox, removeAllOutbox,
  } = useOutboxViewers({
    tab, readableHost, atBottomRef, setOutbox, outboxScope, gallery, setGallery, outboxOpen,
    setOutboxOpen, inboxOpen, setInboxOpen, askedFile, markupAway, setMarkupAway, filesOpen,
    inboxFiles,
  });
  const { visibleChunks, hiddenLines, showEarlier } = useEarlierOutput({
    readableHost, earlier, revealed, setRevealed, revealAnchor,
  });
  const {
    type, press, clearPending, deliver, sendAgentText, forgetDictation, subagentTarget, submitDraft,
    submitDraftRef, sendHold, sendHoldHandlers, sendMarkup, refreshOutboxFile, sendQueuedNow,
    pullQueued, startEdit, cancelEdit, resendPrompt, undoClearConversation, clearConversation,
  } = useComposerSend({
    tab, bare, composerInput, write, sendControl, sendNowAsking, sendNowAnswer, recognition,
    dictateButton, connectedRef, voiceRequest, voiceProgress, sendTimers, commandSentAt,
    lastOutputAt, settleQueue, bracketedPaste, screenRows, viewportRows, connected, setAiOffAt,
    aiOffRef, ctrl, setCtrl, setSendFailed, setDraft, draft, uploadsRef, editing, setEditing,
    editingRef, editSending, setEditSending, liveScreen, setLastSent, slashCliKey, agentKey,
    usedSlash, setUsedSlash, setListening, setPreparingVoice, setVoicePreview, setVoiceStatus,
    setUploads, transcript, setPending, pending, pendingId, setClearedAt, clearedAt, setUndoable,
    setClearQueued, clearQueued, setEditNote, editNote, setSubagentSending, subagentSending,
    setSubagentNote, setQueueNote, queuePulling, setQueuePulling, setUndoNote, setUndoing, undoRun,
    setTranscriptReload, setClearRefused, liveBusy, setSendNowWaiting, sendNowWaiting, agentAtWork,
    subagentPath, openStep, transcriptCurrent, transcriptVersion, storedEntries, queuedShown,
  });
  const {
    commitOptions, pickCommit, lang, slashMenu, pickSlash, prefixCommands, activePrefix,
    togglePrefix, forgetSlash, clearDraft,
  } = useComposerTools({
    tab, t, composerInput, connected, draft, setDraft, savedDraft, slashCliKey, usedSlash,
    setUsedSlash, setCommitSheet, uploads, forgetDictation, submitDraft,
  });
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
  /** A status line that names no branch (Codex's): the ⎇ chip reads the one
   * the tab's worktree has from the desktop instead of its generic word. */
  const statusBranch = status?.branch;
  const [cwdBranch, setCwdBranch] = useState<string | undefined>();
  const movable = tab.worktree_movable === true;
  const linkedBranch = tab.worktree?.branch;
  const linkedLabel = tab.worktree?.label;
  useEffect(() => {
    setCwdBranch(undefined);
    if (!movable || statusBranch || linkedBranch || !connected) return;
    let live = true;
    getTabWorktrees(tab.id).then((choices) => {
      if (live) setCwdBranch(choices.worktrees.find((row) => row.id === choices.current)?.branch);
    }, () => {});
    return () => { live = false; };
  }, [tab.id, movable, statusBranch, linkedBranch, linkedLabel, connected]);
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
  // A tap on either limit flips both between the percentage and a bar of
  // what is left; the phone keeps the choice.
  const limitFact = (meter: LimitMeters["session"], reset: string, key: "mobile.facts.session" | "mobile.facts.week", label: "mobile.facts.sessionLabel" | "mobile.facts.weekLabel") => {
    if (!meter) return null;
    const remaining = Math.max(0, Math.min(100, 100 - meter.percent));
    const percentText = t(key, { percent: Math.round(remaining) });
    return <button type="button" className={`fact-limit${meter.percent >= 90 ? " high" : ""}`} onClick={toggleLimitBars} aria-pressed={limitBars} aria-label={limitBars ? percentText : undefined} title={meter.resets ? resetText(meter.resets, limitTime, readTime) : undefined}>
      {limitBars ? <>{t(label)}<span className="fact-limit-bar" aria-hidden="true"><span style={{ width: `${remaining}%` }} /></span></> : percentText}
      {reset && <> · {t("mobile.facts.resetIn", { time: reset })}</>}
    </button>;
  };
  const {
    openCodeWalk, picker, pickerStep, listedStep, modelPreview, pickerAt, effortSlider,
  } = useModelPicker({
    write, viewportRows, liveScreen, modelSheet, setModelSheet, answered, setAnswered, knownStep,
    setKnownStep, rememberedStep, setReveal, reveal, revealStuck, effortFor, effortStep, sawPicker,
    clearPending, deliver, agentLabel, openCode, antigravity, cursorAgent,
  });
  useSignInPageWalk({ signInPage, deliver });
  const { selectModel, chooseModel, chooseEffort } = useModelPickerAnswers({
    tab, pickModel, bare, connected, liveScreen, modelSheet, setModelSheet, setAnswered, answered,
    setKnownStep, setRememberedStep, rememberedStep, setHeldPick, heldPick, sheetAnswered, keptStep,
    setReveal, reveal, revealStuck, effortFor, setEffortFor, setEffortStep, effortStep, sawPicker,
    clearPending, deliver, sendAgentText, openCode, antigravity, openCodeWalk, picker, pickerStep,
    listedStep, modelPreview, pickerAt, effortSlider,
  });
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
  /** The cloud session pulled onto the desktop as a new agent tab in a
   * worktree of its own (`openTeleportTab`), shown in place of this one. */
  const teleport = async () => {
    if (teleporting || !openTab || !cloudSession) return;
    const key = teleportKeys.current[cloudSession] ?? crypto.randomUUID();
    teleportKeys.current[cloudSession] = key;
    setTeleporting(true);
    setTeleportError("");
    try {
      const body = await openTeleportTab(tab.id, cloudSession, key);
      delete teleportKeys.current[cloudSession];
      openTab(body.tab);
    } catch (cause) {
      setTeleportError(describeFailure(cause));
    } finally {
      setTeleporting(false);
    }
  };
  /** How this CLI signs in from here: a sign-in tab where the desktop has a
   * login command for it, else its slash command in this session. */
  const typedSignIn = signInCommand(slashCliKey);
  // Not on a tab on the remote host: a sign-in tab would start a local CLI,
  // and its callback would reach a port on this machine, not the host's.
  const signInWay = !connected || tab.kind !== "agent" || tab.on_host ? null
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
    openCodeWalk.current?.hold();
    // Closed mid-walk, the reveal's queued arrow keys would follow the Esc
    // into the composer, where ↑ recalls old prompts from history: dropped.
    clearPending();
    // The dialog is the session's own and still open: close it there too,
    // rather than leaving a modal behind that the reader can no longer see.
    if (picker) type("\u001b");
    else if (openCode) openCodeDialogCloseKeys(viewportRows.current()).forEach((key) => type(key));
    setModelSheet(false);
    setAnswered(null);
    setReveal(null);
    setEffortFor(null);
    setEffortStep(null);
    setHeldPick(null);
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
  /** The ⎇ chip: the desktop Reader's worktree move, as a sheet. The list
   * is the desktop's (`TabWorktrees`); a pick has the desktop stop the CLI,
   * take the conversation along where it can and restart it there. */
  const openWorktreeSheet = () => {
    setWorktreeNote("");
    setWorktreeChoices(null);
    setWorktreeSheet(true);
    getTabWorktrees(tab.id).then(setWorktreeChoices, (error) => {
      const code = error instanceof ApiError ? error.code : "";
      setWorktreeChoices({ worktrees: [], carries: false });
      setWorktreeNote(code === "desktop_unavailable" ? "mobile.worktree.offline" : "mobile.worktree.unreadable");
    });
  };
  const chooseWorktree = (id: string) => {
    if (worktreeMoving) return;
    if (id === worktreeChoices?.current) {
      setWorktreeSheet(false);
      return;
    }
    setWorktreeNote("");
    setWorktreeMoving(id);
    moveTabWorktree(tab.id, id)
      .then(() => {
        setWorktreeMoving("");
        setWorktreeSheet(false);
        // The agent restarted elsewhere: read its conversation afresh while
        // it comes up, as after an Undo of a Clear.
        commandSentAt.current = Date.now();
        for (const delay of [0, ...UNDO_RELOADS]) {
          window.setTimeout(() => {
            transcriptVersion.current = undefined;
            setTranscriptReload((count) => count + 1);
          }, delay);
        }
      })
      .catch((error) => {
        const code = error instanceof ApiError ? error.code : "";
        setWorktreeMoving("");
        setWorktreeNote(code === "move_failed" ? "terminal.reader.worktreeFailed"
          : code === "tab_busy" ? "mobile.worktree.busy"
          : code === "desktop_unavailable" ? "mobile.worktree.offline"
          : "mobile.worktree.unreadable");
      });
  };
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
  const openAssistantSheet = () => {
    setAssistantNote("");
    setAssistantModels(null);
    setAssistantSheet(true);
    getAssistantModels(tab.id).then(setAssistantModels, (error) => {
      const code = error instanceof ApiError ? error.code : "";
      setAssistantModels({ models: [] });
      setAssistantNote(code === "desktop_unavailable" ? "mobile.assistantModel.offline" : "terminal.reader.assistantModelFailed");
    });
  };
  const chooseAssistantModel = (model: string) => {
    if (assistantSwitching) return;
    if (model === assistantModels?.current) {
      setAssistantSheet(false);
      return;
    }
    setAssistantNote("");
    setAssistantSwitching(model);
    switchAssistantModel(tab.id, model)
      .then(() => {
        setAssistantSwitching("");
        setAssistantSheet(false);
        // The chat restarted on the new model: show it on the chip at once and
        // read its conversation afresh while it comes up, as after a move.
        setAssistantModels((now) => (now ? { ...now, current: model } : now));
        commandSentAt.current = Date.now();
        for (const delay of [0, ...UNDO_RELOADS]) {
          window.setTimeout(() => {
            transcriptVersion.current = undefined;
            setTranscriptReload((count) => count + 1);
          }, delay);
        }
      })
      .catch((error) => {
        const code = error instanceof ApiError ? error.code : "";
        setAssistantSwitching("");
        setAssistantNote(code === "tab_busy" ? "mobile.assistantModel.busy"
          : code === "desktop_unavailable" ? "mobile.assistantModel.offline"
          : "terminal.reader.assistantModelFailed");
      });
  };
  const sheetUp = modelSheet || assistantSheet || modeSheet || worktreeSheet || statusSheet || desktopSheet || gallery
    || (outboxOpen !== null && markupAway === null) || inboxOpen !== null;
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
    } else if (key === "camera") {
      cameraInput.current?.click();
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
  useEffect(() => {
    if (!project) return;
    // Read on opening and on coming back to the page, not polled: the drawer
    // itself says so when the switch went off in between.
    const controller = new AbortController();
    const read = () => {
      if (document.visibilityState !== "visible") return;
      api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(project)}`, { signal: controller.signal })
        .then((detail) => {
          setFilesLabel(detail.files || detail.host_files ? detail.project.label : null);
          setFilesSides({ here: !!detail.files, host: !!detail.host_files });
        })
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
  const readableShown = view === "focus" && (!altScreen || sessionFocus);
  useEffect(() => {
    const stream = readableHost.current;
    if (filesOpen || !stream) return;
    // Left→right goes back, as the header's ‹ does, from the left edge too;
    // right→left pulls the files in from the right.
    return installFocusSwipe(stream, {
      onSwipeRight: () => backRef.current(),
      onSwipeLeft: () => { if (filesSwipe) setFilesOpen(true); },
    }, { leftEdge: true, rightEdge: filesSwipe });
  }, [filesSwipe, filesOpen, readableShown]);
  /** Agent tabs read as a chat (`ReadableTurns`); a shell's output has no
   * turns to lay out. */
  const chat = tab.kind === "agent";
  /** What the non-terminal view is called: a chat on an agent tab. */
  const focusLabel = chat ? "mobile.focus.chat" : "mobile.focus.reader";
  /** The Diffs view: an agent tab of a scope with a folder, on this machine
   * (`GET /tabs/{id}/changes` refuses Tabby's chats and host tabs). */
  const diffsOffered = chat && !bare && !tab.on_host;
  const diffsShown = diffsOpen && diffsOffered;
  /** The live screen after the last prompt echo — what the session is
   * drawing right now. Shown under the stored session while it holds a
   * choice the session is waiting on, which the transcript cannot carry. */
  const liveTail = useMemo(() => {
    if (!sessionFocus) return [];
    // Codex's hooks page replaces the input box, whose `›` its highlighted
    // row reads as: it is read off the whole screen.
    if (readCodexHooksPage(liveScreen, agentLabel)) return liveScreen;
    // On the alternate screen that tail is the frame itself, cut at its input
    // box the way `painted` cuts the scrollback's: a fullscreen agent draws its
    // session there, so a question of its own reaches the phone in no other
    // way. A frame that holds no dialog reaches the reader in no other way
    // either — only `liveQuestion` reads this, never the view.
    const screen = altScreen ? liveScreen.slice(0, inputFrameStart(liveScreen, agentLabel)) : painted;
    let start = 0;
    screen.forEach((line, index) => { if (isLiveEcho(line, agentLabel)) start = index + 1; });
    return screen.slice(start);
  }, [sessionFocus, altScreen, liveScreen, painted, agentLabel]);
  /** The choice the session is waiting on, read off the live screen. On the
   * phone it is answered by tapping a row, so what is kept is the dialog
   * itself — its rows, and where on the tail they start — not just that there
   * is one. */
  const liveQuestion = useMemo(
    () => (liveTail.length > 0
      ? readCodexHooksPage(liveTail, agentLabel) ?? readSelectPrompt(liveTail, agentLabel, paneColumns.current) ?? readReviewStep(liveTail, agentLabel)
        // No input box and no busy row: a first run's own screen (Claude
        // Code's theme picker, a `Press Enter to continue`).
        ?? ((pressHintShown(liveScreen) || inputFrameStart(liveScreen, agentLabel) >= liveScreen.length) && !agentWork(liveScreen)
          ? readStrayDialog(liveTail, paneColumns.current)
          : null)
      : null),
    [liveTail, liveScreen, agentLabel],
  );
  /** Claude Code's prompt suggestion, dimmed in its own empty box, which the
   * chat hides (`promptSuggestion.ts`): a row over the composer that a tap
   * puts into the field — never sent. The terminal view shows the CLI's box. */
  const promptSuggestion = useMemo(
    () => (view === "focus" && tab.kind === "agent" && !liveQuestion && !liveBusy ? readPromptSuggestion(liveScreen, agentLabel) : ""),
    [view, tab.kind, liveQuestion, liveBusy, liveScreen, agentLabel],
  );
  /** A dialog the session is waiting on whose rows `readSelectPrompt` could
   * not read: the chat says so and offers the screen, rather than showing
   * nothing while the session waits. */
  const unreadQuestion = useMemo(
    () => sessionFocus && !liveQuestion && dialogFooterShown(liveScreen),
    [sessionFocus, liveQuestion, liveScreen],
  );
  /** The agent as the markup view's round pill reads it: the live screen
   * only — `tab.agent_status` is the snapshot taken when this tab was
   * opened, and would read "working" forever for a tab opened mid-turn. */
  const markupAgent: AgentSignal = liveQuestion !== null ? "question" : liveBusy ? "working" : "idle";
  /** An agent tab's viewers offer **Mark up**; a shell has no chat to send to,
   * and a tab on the remote host cannot read the marked pages Submit puts in
   * the mirror's inbox (`tab_on_host`).
   * The agent's state is in the deps, so the viewers re-render on its edges. */
  const markupTarget = useMemo<MarkupTarget | undefined>(
    () => (tab.kind === "agent" && !bare && !tab.on_host
      ? { tabId: tab.id, projectId: project ?? `tab:${tab.id}`, onSend: sendMarkup, agent: markupAgent, refresh: refreshOutboxFile }
      : undefined),
    [tab.kind, tab.id, tab.on_host, bare, project, sendMarkup, markupAgent, refreshOutboxFile],
  );
  /** The agent's open markup question (`markup_ask`), for the banner over the
   * composer: read on the markup views' own poll, only while the Focus chat
   * is on screen (no viewer over it) and on each agent edge. */
  const { asks: markupAsks } = useMarkupAsks(tab.kind === "agent" && !bare ? tab.id : undefined, undefined,
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
  const askedInFiles = !askedFile?.scope || "files" in askedFile.scope;
  const refreshAskedFile = useMemo(
    () => (project && askedInFiles ? refreshProjectFile(project, askedFolder) : undefined),
    [project, askedFolder, askedInFiles],
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
    () => (tab.kind !== "agent" && project && openTab ? { projectId: project, show: (row: TabRow, back?: MarkupBack) => openTab(row, { markupBack: back }) } : undefined),
    [tab.kind, project, openTab],
  );
  const {
    questionAsk, questionContext, questionTabs, questionTabFocus, questionTabSubmit,
    questionContextShown, questionSignature, questionSent, sentSignature, answerQuestion,
    stepQuestion, answerQuestionText,
  } = useLiveQuestion({
    clearPending, deliver, agentLabel, liveTail, liveQuestion,
  });
  /** The stored session only grows at message boundaries, so a turn busy in
   * tool calls looked finished. The live screen's interrupt hint says it is
   * not; a choice on screen is waiting on the reader instead. */
  const sessionWork = useMemo(
    () => (sessionFocus && !liveQuestion ? agentWork(liveScreen) : null),
    [sessionFocus, liveQuestion, liveScreen],
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
  const storedModelId = sinceClear ? undefined : transcript?.model?.trim() || undefined;
  const transcriptModel = workingModelName(storedModelId);
  /** The model the session's own status line names, kept while the screen
   * shows none — the desktop keeps its reading the same way (`screenByTab`),
   * so a dialog over the footer does not drop the chip to an older answer's
   * model while the tab's card still says the current one. */
  const screenModel = statusModelTag(status);
  const [shownScreenModel, setShownScreenModel] = useState(screenModel);
  if (screenModel && screenModel !== shownScreenModel) setShownScreenModel(screenModel);
  /** Who the working row names: the model's family word as the session prints
   * it (`Opus 4.5` → `Opus`), else the stored session's, else the tab's
   * published model; a tab with none keeps the generic "Agent". */
  const workingModel = (status?.model ?? transcriptModel ?? tab.agent_model)?.trim().split(/\s+/)[0];
  /** The dialog's question line for the markup view's pill, while the CLI
   * waits on one: shown there, answered here. */
  const markupDialog = useMemo(
    () => (liveQuestion ? dialogLine(questionAsk.map((line) => line.text)) ?? liveQuestion.title : undefined),
    [liveQuestion, questionAsk],
  );
  /** Mark up's target with that model, for the round pill's "Opus is
   * working…" — `markupTarget` is built before the model is read. */
  const selectModelNow = useRef(selectModel);
  selectModelNow.current = selectModel;
  /** The markup view's model chip: the chat's own model sheet, over the view.
   * Not on a local-model tab, which keeps the model it was launched on. */
  const markupPickModel = useCallback(() => selectModelNow.current(), []);
  const markupFor = useMemo(
    () => markupTarget && {
      ...markupTarget,
      model: workingModel,
      pickModel: tab.local_model ? undefined : markupPickModel,
      // The gallery the viewer may have opened from would cover the chat.
      toChat: (back: MarkupBack) => {
        setGallery(false);
        setMarkupAway(sentName(back.file));
        awayMarkups.set(tab.id, back);
      },
      dialog: markupDialog,
    },
    [markupTarget, workingModel, markupDialog, tab.local_model, markupPickModel, tab.id],
  );
  /** A shell's Focus has no messages to hold for a menu (`useMessageMenu`), so
   * it copies what the reading view shows: the revealed history, the open
   * chunk, then the live tail. */
  const copyReadable = async () => {
    try {
      await navigator.clipboard.writeText(readableText([...visibleChunks.flatMap((chunk) => chunk.lines), ...earlier.open, ...painted]));
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  /** A cloud tab's page and Teleport, as its CLI printed them: the
   * conversation runs on the vendor's site, and the tab records no session
   * the chat could read. */
  const cloudChat = cloudLink && <>
    <div className="sign-in-open readable-cloud-link">
      <a className="button primary" href={cloudLink.url} target="_blank" rel="noopener noreferrer">
        <strong>{t("mobile.focus.cloudOpen")}{isUntested("mobile.focus.cloudLink") && <em> · {t("mobile.focus.untested")}</em>}</strong>
        <small>{cloudLink.site}</small>
      </a>
      {cloudSession && openTab && <button disabled={teleporting || !connected} onClick={() => void teleport()}>{t("mobile.focus.cloudTeleport")}{isUntested("mobile.focus.cloudTeleport") && <em> · {t("mobile.focus.untested")}</em>}</button>}
    </div>
    {cloudSession && openTab && <div className="readable-notice">{teleportError || t("mobile.focus.cloudTeleportNote")}</div>}
  </>;
  // New turns push the prompt up as surely as a scroll does.
  useLayoutEffect(checkPinnedPrompt, [checkPinnedPrompt, view, sessionFocus, sessionEntries, openStep, subagentListOpen, sentListOpen]);
  const jumpToLatest = () => {
    const stream = readableHost.current;
    if (!stream) return;
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    followReadable(true);
  };
  const { stopVoice, cancelVoicePrep, startVoice } = useVoiceInput({
    tab, recognition, dictateButton, connectedRef, voiceRequest, voiceProgress, setDraft, draftRef,
    setListening, setPreparingVoice, preparingVoice, setVoicePreview, setVoiceStatus,
    setVoiceFailure, forgetDictation, submitDraftRef,
  });
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
  /** The model chip's label, read exactly as the desktop reads the tag its
   * tab cards carry (`agentTabModelTag`): the model the session prints, by
   * the one composition (`statusModelTag`); while the screen shows none (a
   * dialog, output mid-scroll), the last one it did; else the stored
   * session's model by the one fallback (`transcriptModelTag`); else the
   * tab's published tag. */
  const modelChip = shownScreenModel
    ?? (storedModelId ? transcriptModelTag(storedModelId, /^claude$/iu.test(agentLabel)) : undefined)
    ?? tab.agent_model
    ?? t("terminal.reader.model");
  const shownStep = modelPreview ?? listedStep ?? (answered && picker ? answered : null);
  /** The highlighted row — where it was before a reveal walk moved it. */
  const shownAt = modelPreview ? undefined : reveal?.origin ?? picker?.options[picker.current]?.number;
  const pickerOptionsRaw: SheetOption[] = (shownStep?.options ?? []).map((option) => ({
    key: String(option.number),
    label: option.label,
    description: option.description,
    current: option.number === shownAt,
  }));
  const pickerOptions = openCode && shownStep?.title === "Select model"
    ? groupOpenCodeModels(pickerOptionsRaw).flatMap((group) => group.options.map((option) => ({
      ...option, group: openCodeModelGroupTitle(group, t),
    })))
    : pickerOptionsRaw;
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
  const assistantOptionRows: SheetOption[] = (assistantModels?.models ?? []).map((model) => ({
    key: model.id,
    label: model.label,
    description: model.description,
    current: model.id === assistantModels?.current,
    pending: model.id === assistantSwitching,
  }));
  const worktreeOptions: SheetOption[] = (worktreeChoices?.worktrees ?? []).map((row) => ({
    key: row.id,
    ...worktreeChoiceText({ branch: row.branch, name: row.label, main: row.main }, t),
    current: row.id === worktreeChoices?.current,
    pending: row.id === worktreeMoving,
  }));
  /** The composer's ＋ sheet. The camera, gallery, phone and desktop tiles
   * put a file in the mirror's inbox, which a tab on the remote host cannot
   * read (`tab_on_host`): such a tab keeps only the project reference. */
  const allAttachTiles: AttachTile[] = [
    { key: "camera", tone: "camera", label: t("mobile.add.camera"), hint: t("mobile.add.cameraHint"), untested: "mobile.add.camera",
      icon: <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3.5" /></svg> },
    { key: "gallery", tone: "gallery", label: t("mobile.add.gallery"), hint: t("mobile.add.galleryHint"),
      icon: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 15-5-5-10 10" /></svg> },
    { key: "phone", tone: "files", label: t("mobile.add.phone"), hint: t("mobile.add.phoneHint"),
      icon: <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg> },
    { key: "desktop", tone: "desktop", label: t("mobile.add.desktopTile"), hint: t("mobile.add.desktopHint"),
      icon: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg> },
    { key: "project", tone: "project", label: t("mobile.add.project"), hint: t("mobile.add.projectHint"),
      icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" /><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8" /></svg> },
  ];
  const attachTiles = tab.on_host ? allAttachTiles.filter((tile) => tile.key === "project") : allAttachTiles;
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
          <TranscriptTurns entries={subTranscript.entries} cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.subagent.task")} planLabel={t("mobile.transcript.plan")} planUntested={planUntested} agentLabel={t("mobile.subagent.region")} agentUntested={subagentUntested} busy={subagentWorking} onOpenAgent={openSubagentTurn} />
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
  return <main className={`terminal-screen ${tab.kind}-tab`} style={viewportHeight ? { height: viewportHeight } : undefined}><header><button className="back" onClick={back}>‹</button>{bare && projectOfTab
        // Tabby's one chat: its CLI is the title, a dropdown, with Relaunch.
        ? <TabbyHead tab={tab} scope={projectOfTab} openTab={openTab} />
        : <div className="terminal-title"><h1>{tab.label}</h1><small>{t(tab.kind === "agent" ? "mobile.focus.agentSession" : "mobile.focus.shellSession")}</small></div>}
      {/* The project's drawer, the ☰ the project screen carries too: what a
          right→left swipe over the output pulls in, offered while the
          desktop's "Project files on the phone" switch is on. */}
      {project && filesLabel !== null && <button
        className="drawer-open"
        onClick={() => setFilesOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={filesOpen}
        aria-label={t("mobile.project.menu")}
        title={t("mobile.project.menu")}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>}
      {outbox.length > 0 && <button className="terminal-gallery" onClick={() => setGallery(true)} aria-label={t("mobile.outbox.galleryOpen", { count: outbox.length })} title={t("mobile.outbox.region")}><span aria-hidden="true"><FileImageIcon /></span><small>{outbox.length}</small></button>}
      {/* One pill named after the view on screen; its list switches views and,
          on an agent tab's Chat, says where the chat reads from. */}
      <div className="terminal-view-switch"><button
        className="selected"
        aria-haspopup="menu"
        aria-expanded={focusMenu}
        title={t("mobile.focus.outputView")}
        onClick={() => setFocusMenu((open) => !open)}
      >{t(diffsShown ? "terminal.reader.changes" : view === "terminal" ? "mobile.focus.terminal" : focusLabel)}<span className="view-caret" aria-hidden="true" /></button></div><span className={connected ? "lamp" : "lamp off"} /></header>
    {focusMenu && <div className="focus-menu-backdrop" role="presentation" onClick={() => setFocusMenu(false)}>
      <div className="focus-menu" role="menu" aria-label={t("mobile.focus.outputView")} onClick={(event) => event.stopPropagation()}>
        {/* Chat / Diffs / Terminal, in the desktop's order. Chat is the stored
            session only: dimmed, saying why, for an agent with none. */}
        {([["focus", focusLabel], ...(diffsOffered ? [["diffs", "terminal.reader.changes"] as const] : []), ["terminal", "mobile.focus.terminal"]] as const).map(([choice, label]) => {
          const checked = choice === "diffs" ? diffsShown : view === choice && !diffsShown;
          const off = choice === "focus" && chatUnavailable;
          const googleUntested = choice === "focus" && chat && (antigravity || /gemini/iu.test(agentLabel)) && isUntested("mobile.focus.googleSession");
          return <button key={choice} role="menuitemradio" aria-checked={checked} aria-disabled={off ? "true" : undefined} className={off ? "unavailable" : undefined} onClick={() => {
            if (off) return;
            setFocusMenu(false);
            if (choice === "diffs") {
              setDiffsOpen(true);
              return;
            }
            setDiffsOpen(false);
            if (view !== choice) chooseView(choice);
          }}>
            <span>
              <strong>{t(label)}{((choice === "diffs" && isUntested("mobile.focus.diffs")) || googleUntested) && <em>{t("mobile.focus.untested")}</em>}</strong>
              {choice === "diffs" && <small>{t("mobile.focus.diffsHint")}</small>}
              {off && <small>{t(noSessionReason(transcript))}</small>}
            </span>
            {checked && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" /></svg>}
          </button>;
        })}
        {chat && view === "focus" && !diffsShown && <>
        <hr className="focus-menu-rule" />
        {/* Spoken from the stored session: its answers arrive whole. */}
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
        </>}
      </div>
    </div>}
    <div className="terminal-body">
      <div ref={host} className={`terminal${view === "focus" ? " focus-source" : ""}`} />
      <div ref={wideHint} className="terminal-wide-hint" aria-hidden="true" />
      {diffsShown && <ChatChanges tabId={tab.id} subagent={view === "focus" ? openStep?.token : undefined}
        subagentTitle={openStep?.task || openStep?.role} visible onClose={() => setDiffsOpen(false)} />}
      {/* The stored session does not depend on the screen, so a full-screen
          agent (OpenCode's TUI) still reads as a chat in Focus. */}
      {view === "focus" && altScreen && !sessionFocus && <div className="alt-screen-notice"><strong>{t("mobile.focus.altScreen")}</strong><span>{t("mobile.focus.altScreenHint")}</span><button className="primary" onClick={() => chooseView("terminal")}>{t("mobile.focus.altScreenOpen")}</button></div>}
      {view === "focus" && (!altScreen || sessionFocus) && <>
        <section ref={readableHost} className="readable-output" aria-label={t("mobile.focus.output")} aria-live="polite"
          onScroll={(event) => {
            const stream = event.currentTarget;
            followReadable(stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120);
            checkPinnedPrompt();
          }}>
          {/* The sticky strip over the chat: the session's subagents and the
              files it carried, each a chip that opens its list. */}
          {sessionFocus && !openStep && (sessionAgents.length > 0 || agentsEarlier || chatFiles.length > 0) && <div className="chat-index">
            {(sessionAgents.length > 0 || agentsEarlier) &&
            <nav className={`subagent-index${subagentListOpen ? " open" : ""}`} aria-label={t("mobile.subagent.indexRegion")}>
              <button type="button" className="subagent-index-toggle" aria-expanded={subagentListOpen} aria-controls="mobile-subagent-list" onClick={() => { setSentListOpen(false); setSubagentListOpen((open) => !open); }}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v7a4 4 0 0 0 4 4h7m-3-3 3 3-3 3" /></svg>
                <span>{t("mobile.subagent.index", { count: sessionAgents.length + earlierAgents })}{subagentUntested && <em> · {subagentUntested}</em>}</span>
                <svg className={subagentListOpen ? "expanded" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {subagentListOpen && <div id="mobile-subagent-list" className="subagent-index-list">
                {([["running", "mobile.subagent.running"], ["finished", "mobile.subagent.finished"]] as const).map(([group, heading]) => {
                  const rows = splitByWork(sessionAgents, sessionBusy)[group];
                  if (rows.length === 0) return null;
                  const title = t(heading, { count: rows.length });
                  return <section key={group} className="subagent-index-group" aria-label={title}>
                    <h3 className="subagent-index-head">{title}</h3>
                    {rows.map((entry, index) => {
                      const status = group === "running" ? "working" : entry.finished ? "done" : null;
                      return <button type="button" key={`${entry.at ?? index}:${index}`} className={status ? "has-status" : undefined} disabled={!entry.subagent} aria-label={`${entry.role ?? t("mobile.subagent.region")} · ${entry.text}`} onClick={() => openListedSubagent(entry)}>
                        <small>{entry.role ?? t("mobile.subagent.region")}</small>
                        <span>{entry.text}{entry.cut && "…"}</span>
                        {status && <AgentStatusMark status={status} />}
                      </button>;
                    })}
                  </section>;
                })}
                {agentsEarlier && <button type="button" className="subagent-index-earlier" onClick={() => setTranscriptLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.subagent.earlier")}</button>}
              </div>}
            </nav>}
            {chatFiles.length > 0 && <SentFilesIndex tabId={tab.id} files={chatFiles} open={sentListOpen} onToggle={() => { setSubagentListOpen(false); setSentListOpen((open) => !open); }} onOpen={openSentFile} />}
          </div>}
          {sessionFocus && openStep
            ? subagentView
            : sessionFocus
            ? (sessionEntries.length === 0 && !liveQuestion && !unreadQuestion && !sessionBusy
              ? (undoing
                ? <div className="readable-empty" role="status" aria-busy="true"><span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span><strong>{t("mobile.transcript.undoing")}</strong></div>
                // A fresh tab while its CLI starts: the banner it draws is not
                // a conversation. The screen stays one tap away in Terminal —
                // shown, not remembered as the reader's choice.
                : sessionWaiting && (!cliReady || !transcript)
                ? <div className="readable-empty" role="status" aria-busy="true" data-testid="session-starting">
                    <span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span>
                    <strong>{cliReady ? t("mobile.focus.sessionLoading") : t("mobile.focus.starting", { agent: agentLabel })}{(isUntested("mobile.focus.starting") || (transcript?.reason === "no_session" && isUntested("mobile.focus.noSessionYet"))) && <em> · {t("mobile.focus.untested")}</em>}</strong>
                    <button onClick={() => setView("terminal")}>{t("mobile.transcript.toTerminal")}</button>
                  </div>
                // No session to wait for: a cloud tab (its page is the
                // conversation), or a read the desktop could not answer.
                : transcript && !transcript.available && !sessionWaiting
                ? <div className="readable-empty" data-testid="session-unavailable">
                    {cloudChat || <strong>{t(noSessionReason(transcript))}</strong>}
                    <button onClick={() => setView("terminal")}>{t("mobile.transcript.toTerminal")}</button>
                  </div>
                // Still no session to read once the CLI is up: what it printed
                // stays one tap away, for a session that never records one.
                : <div className="readable-empty"><strong>{t("mobile.transcript.empty")}</strong><span>{t("mobile.transcript.emptyHint")}</span>{transcript?.available === false && <button onClick={() => setView("terminal")}>{t("mobile.transcript.toTerminal")}</button>}</div>)
              : <div className="readable-lines chat transcript" data-testid="session-transcript">
                  {cloudChat}
                  {transcript?.truncated && !sinceClear && <button className="readable-earlier" onClick={() => setTranscriptLimit((limit) => limit + TRANSCRIPT_STEP)}>{t("mobile.transcript.earlier")}</button>}
                  <TranscriptTurns entries={sessionEntries} part="settled" cutLabel={t("mobile.transcript.cut")} promptLabel={t("mobile.transcript.prompt")} planLabel={t("mobile.transcript.plan")} planUntested={planUntested} agentLabel={t("mobile.subagent.region")} agentUntested={subagentUntested} busy={sessionBusy} onOpenAgent={openSubagentTurn} onResend={resendPrompt} onEdit={startEdit} posts={chatPosts} renderPost={renderPost} inbox={chatInbox} />
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
                    {questionContextShown && <ReadableTurns lines={questionContext} chat={chat} agent={agentLabel} promptLabel={t("mobile.transcript.prompt")} columns={paneColumns.current} />}
                    <QuestionList prompt={liveQuestion} tabs={questionTabs} tabFocus={questionTabFocus} tabSubmit={questionTabSubmit} question={questionAsk} sent={sentSignature === questionSignature ? questionSent?.number : undefined} sendingLabel={t("mobile.transcript.answering")} onPick={answerQuestion} onType={answerQuestionText} onStep={stepQuestion} />
                  </div>}
                  {unreadQuestion && <div className="transcript-screen" role="group" aria-label={t("mobile.transcript.question")} data-testid="question-unread">
                    <small>{t("mobile.transcript.question")}{isUntested("mobile.focus.questionUnread") && <> · {t("mobile.focus.untested")}</>}</small>
                    <p className="transcript-screen-note">{t("mobile.transcript.questionUnread")}</p>
                    <button type="button" className="transcript-screen-action" onClick={() => chooseView("terminal")}>{t("mobile.transcript.toTerminal")}</button>
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
                  {/* Both act on Claude's whole queue: once, under its last bubble. */}
                  {queuedShown && agentAtWork && !editing && agentKey === "claude" && <div className="transcript-queued-actions">
                    {sendNowOffered && <button type="button" disabled={!connected || sendNowWaiting} onClick={sendQueuedNow}>{t("terminal.reader.sendNow")}</button>}
                    {sendNowWaiting && <em role="status">{t("mobile.chat.sendNowWaiting")}</em>}
                    <button type="button" disabled={!connected || queuePulling} onClick={pullQueued}>{t("terminal.reader.cancelEdit")}</button>
                    {isUntested("mobile.chat.queuedActions") && <em>{t("mobile.focus.untested")}</em>}
                  </div>}
                </div>)
            : painted.length === 0 && visibleChunks.length === 0 && earlier.open.length === 0
            ? <div className="readable-empty"><strong>{t("mobile.focus.waitingOutput")}</strong><span>{t("mobile.focus.waitingOutputHint")}</span></div>
            // A shell's Focus: its screen, flat, the history in memoized chunks.
            : <div className="readable-lines">
                {clipped && <div className="readable-notice">{t("mobile.focus.truncated")}</div>}
                {hiddenLines > 0 && <button className="readable-earlier" onClick={showEarlier}>{t("mobile.focus.earlierOutput", { count: hiddenLines.toLocaleString() })}</button>}
                {hiddenLines === 0 && earlier.dropped && <div className="readable-notice">{t("mobile.focus.truncated")}</div>}
                {visibleChunks.map((chunk) => <ReadableTurns key={chunk.id} lines={chunk.lines} chat={false} promptLabel={t("mobile.transcript.prompt")} />)}
                <ReadableTurns lines={earlier.open} chat={false} promptLabel={t("mobile.transcript.prompt")} />
                <ReadableTurns lines={painted} chat={false} promptLabel={t("mobile.transcript.prompt")} />
              </div>}
        </section>
        {!openStep && pinnedPrompt && <button className="readable-pinned-prompt" style={pinnedTop ? { top: pinnedTop + 6 } : undefined} aria-label={t("mobile.focus.lastPrompt")}
          onClick={() => pinnedPromptEl.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
          <span className="readable-pinned-prompt-text">{pinnedPrompt}</span>
          {pinnedTime && <small className="transcript-time">{pinnedTime}</small>}
          {isUntested("mobile.focus.pinnedPrompt") && <em>{t("mobile.focus.untested")}</em>}
        </button>}
        {/* A chat copies message by message, so nothing floats over its
            newest lines. */}
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
      {(aiOff || aiOffAt > 0) && <div className="voice-feedback error" role="alert">{t("mobile.aiOff")}{isUntested("mobile.aiOff") && <em> · {t("mobile.focus.untested")}</em>}</div>}
      {undoNote && <div className="voice-feedback" role="status">{t(undoNote)}</div>}
      {subagentTarget && (subagentSending || subagentNote) && <div className={subagentNote ? "voice-feedback error" : "voice-feedback"} role={subagentNote ? "alert" : "status"}>{t(subagentNote || "mobile.subagent.sending")}{isUntested("mobile.subagent.input") && <em> · {t("mobile.focus.untested")}</em>}</div>}
      {queueNote && <div className="voice-feedback error" role="alert">{t(queueNote)}</div>}
      {editNote && !editing && <div className={editNote === "mobile.composer.heldEditFailed" ? "voice-feedback error" : "voice-feedback"} role="status">{t(editNote)}{editNote === "mobile.composer.heldNote" && <> {t("mobile.composer.holdToInterrupt")}{isUntested("mobile.composer.sendHold") && <> · <em>{t("mobile.focus.untested")}</em></>}</>}{isUntested("mobile.chat.editHeld") && <> · <em>{t("mobile.focus.untested")}</em></>}</div>}
      {editing && <div className="sign-in-notice" role="status">
        <span>{t(editNote === "mobile.composer.heldEditFailed" ? "mobile.composer.heldEditFailed" : "mobile.composer.editingHeld")}{isUntested("mobile.chat.editHeld") && <> · <em>{t("mobile.focus.untested")}</em></>}</span>
        <button onPointerDown={(event) => event.preventDefault()} onClick={cancelEdit}>{t("mobile.composer.editCancel")}</button>
      </div>}
      {clearRefused && liveBusy && <div className="voice-feedback" role="status">{t("mobile.composer.clearBusy")}{isUntested("mobile.composer.clearBusy") && <> · <em>{t("mobile.focus.untested")}</em></>}</div>}
      {lastSent && !sessionFocus && <div className="last-sent"><span>{t("mobile.composer.lastSent")}</span><p>{lastSent}</p></div>}
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
      {markupAway !== null && <div className="sign-in-notice markup-away-notice" role="status">
        <span>
          {t("mobile.markup.awayBanner", { file: markupAway })}
          {isUntested("mobile.markup.chatLink") && <> · <em>{t("mobile.focus.untested")}</em></>}
        </span>
        <button className="primary" onClick={() => setMarkupAway(null)}>{t("mobile.markup.awayBack")}</button>
      </div>}
      {signInError && !signInSheet && <div className="inbox-upload error" role="alert"><strong>{t("mobile.signIn.open")}</strong><span>{signInError}</span><button onClick={() => setSignInError("")} aria-label={t("mobile.signIn.hide")}>✕</button></div>}
      {(tab.kind === "agent" || status?.branch || contextLeft || shownLimits.session || shownLimits.week) && <div className="session-facts">
        {/* An agent tab's model, mode and status lead the row as tappable facts:
            the composer keeps the whole bar for the draft and its buttons. */}
        {tab.kind === "agent" && <>
          <button className="fact-action" onClick={() => setStatusSheet(true)} aria-haspopup="dialog" aria-expanded={statusSheet} title={t("mobile.facts.statusHint")}><span className={`fact-lamp ${lamp}`} aria-hidden="true" /><span className="fact-action-label">{t("terminal.reader.status.button")}</span></button>
          {/* A local-model tab keeps the model it was launched on: the
              driver's list would only offer to move it off. A chat of the
              assistant scope runs with its slash commands off, so `/model`
              cannot reach it (the desktop switches its model by restarting it). */}
          {tab.local_model
            ? <span className="fact-model">{modelChip}</span>
            : bare
            ? <button className="fact-action" disabled={!connected || tab.agent_status === "working" || tab.agent_status === "question"} onClick={openAssistantSheet} aria-haspopup="dialog" aria-expanded={assistantSheet} title={t("terminal.reader.assistantModelHint")}><span className="fact-action-label">{assistantModels?.models.find((model) => model.id === assistantModels.current)?.label ?? modelChip}</span></button>
            : <button className="fact-action" disabled={!connected} onClick={selectModel} aria-haspopup="dialog" aria-expanded={modelSheet} title={t("mobile.facts.modelHint")}><span className="fact-action-label">{modelChip}</span></button>}
          <button className={`fact-action${status?.mode === "plan" ? " fact-action-plan" : ""}`} disabled={!connected} onClick={openModeSheet} aria-haspopup={modes.length > 0 ? "dialog" : undefined} aria-expanded={modes.length > 0 ? modeSheet : undefined} title={t(modes.length > 0 ? "mobile.facts.modeHint" : "mobile.facts.modeCycle")}><span className="fact-action-label">{status?.mode ?? activeMode ?? t("terminal.reader.mode")}</span></button>
          {status?.mode === "plan" && isUntested("mobile.focus.planModeMark") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
          {openCode && altScreen && status && isUntested("mobile.focus.openCodeComposer") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
        </>}
        {tab.worktree && <span className="fact-worktree" title={t("terminal.reader.worktreeHint")}>{t("terminal.reader.worktree", { name: tab.worktree.label })}</span>}
        {/* As on the desktop Reader: the branch moves the agent to another
            worktree of the project, where the move applies. */}
        {tab.worktree_movable
          ? <button className="fact-action" disabled={!connected || tab.agent_status === "working" || tab.agent_status === "question"} onClick={openWorktreeSheet} aria-haspopup="dialog" aria-expanded={worktreeSheet} title={t("terminal.reader.worktreeSwitchHint")}><span className="fact-action-label">⎇ {statusBranch ?? linkedBranch ?? cwdBranch ?? t("terminal.reader.worktreeButton")}</span></button>
          : status?.branch && <span className="fact-branch">⎇ {status.branch}</span>}
        {tab.worktree_movable && isUntested("mobile.facts.worktreeSwitch") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
        {contextLeft && <span className="fact-context">{t("terminal.reader.contextLeft", { percent: contextLeft })}</span>}
        {limitFact(shownLimits.session, sessionReset, "mobile.facts.session", "mobile.facts.sessionLabel")}
        {limitFact(shownLimits.week, weekReset, "mobile.facts.week", "mobile.facts.weekLabel")}
        {(shownLimits.session || shownLimits.week) && isUntested("mobile.facts.limitBars") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
        {(sessionReset || weekReset) && isUntested("mobile.facts.limitResets") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
      </div>}
      <div className={`prompt-composer${penWriting ? " pen-writing" : ""}`}>
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
        {promptSuggestion && connected && !draft && !subagentTarget && pending.length === 0 && <div className="slash-menu prompt-suggestion" role="group" aria-label={t("terminal.reader.suggestion")}>
          <div className="slash-menu-head">{t("terminal.reader.suggestion")} {isUntested("mobile.composer.promptSuggestion") && <em>{t("mobile.focus.untested")}</em>}</div>
          {/* As the `/` menu's rows: the tap keeps the keyboard up. */}
          <div className="slash-row">
            <button className="slash-pick" onPointerDown={(event) => event.preventDefault()} onClick={() => { setDraft(promptSuggestion); composerInput.current?.focus(); }} title={t("mobile.composer.suggestionHint")}>
              <strong>{promptSuggestion}</strong>
            </button>
          </div>
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
          {penWriting && isUntested("mobile.composer.penWriting") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
          {(draft.includes("\n") || draft.length > 60) && isUntested("mobile.composer.autoGrow") && <em className="composer-untested">{t("mobile.focus.untested")}</em>}
          {draft && <button className="composer-clear" onClick={clearDraft} aria-label={t("mobile.composer.clear")} title={t("mobile.composer.clear")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
          {tab.kind === "agent" && <button className={`composer-dictate${listening ? " listening" : ""}`} disabled={!connected || !voiceAvailable} title={t(voiceAvailable ? "mobile.voice.hint" : "mobile.voice.hintUnavailable")} aria-label={dictateLabel} aria-pressed={listening} ref={dictateButton} onClick={listening ? stopVoice : preparingVoice ? cancelVoicePrep : () => void startVoice()}>{listening ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}</button>}
        </div>
        <div className="composer-bar">
          {tab.kind === "agent" && <>
            {!bare && <>
            <input ref={fileInput} type="file" accept={ANY_FILE_ACCEPT} multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-file-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <input ref={galleryInput} type="file" accept="image/*,video/*" multiple hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-gallery-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden aria-hidden="true" tabIndex={-1} data-testid="inbox-camera-input" onChange={(event) => { attachFromPhone(event.target.files); event.target.value = ""; }} />
            <button className={`composer-add${addSheet ? " open" : ""}`} disabled={!connected} onClick={() => setAddSheet(true)} aria-label={t("mobile.add.title")} aria-haspopup="dialog" aria-expanded={addSheet} title={t("mobile.add.hint")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
            </>}
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
{!bare &&             <button className="composer-prefix composer-commit" disabled={!connected} onPointerDown={(event) => event.preventDefault()} onClick={() => { setCommitSheet(true); setCommitRefresh((count) => count + 1); }} aria-label={uncommittedCount > 0 ? t("mobile.commit.openCount", { count: uncommittedCount }) : t("mobile.commit.open")} aria-haspopup="dialog" aria-expanded={commitSheet} title={uncommittedCount > 0 ? t("mobile.commit.openCount", { count: uncommittedCount }) : t("mobile.commit.open")}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M2 12h6.5M15.5 12H22" /></svg>{uncommittedCount > 0 && <span className="composer-commit-count" aria-hidden="true">{uncommittedCount > 99 ? "99+" : uncommittedCount}</span>}</button>}
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
      <button className={ctrl ? "selected" : ""} aria-pressed={ctrl} disabled={!connected} onClick={() => setCtrl((on) => !on)}>Ctrl</button><button disabled={!connected} onClick={() => press("\u001b")}>Esc</button><button disabled={!connected} onClick={() => press("\t")}>Tab</button><button disabled={!connected} onClick={() => press("\u001b[D")}>←</button><button disabled={!connected} onClick={() => press("\u001b[A")}>↑</button><button disabled={!connected} onClick={() => press("\u001b[B")}>↓</button><button disabled={!connected} onClick={() => press("\u001b[C")}>→</button><button disabled={!connected} onClick={() => press("\r")}>Enter</button><button disabled={!connected} onClick={() => press("\u007f")}>⌫</button><button className="danger" disabled={!connected} onClick={() => setInterruptSheet(true)}>{t("mobile.keys.interrupt")}</button>
      </div>}
    </div>
    {/* Lifted over a markup view, whose model chip opens it too. */}
    {modelSheet && <div className="sheet-lift">{effortStep
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
        note={modelPreview
          ? { text: isUntested("agents.modelRows.remembered")
            ? `${t("terminal.reader.modelRemembered")} · ${t("mobile.focus.untested")}`
            : t("terminal.reader.modelRemembered") }
          : cursorAgent && isUntested("mobile.model.cursor")
          ? { text: t("mobile.focus.untested") }
          : openCode && (picker?.hidden || isUntested("agents.opencode.modelList"))
            ? { text: [
              ...(picker?.hidden ? [t("terminal.reader.modelListing")] : []),
              ...(isUntested("agents.opencode.modelList") ? [t("mobile.focus.untested")] : []),
            ].join(" · ") }
            : undefined}
        options={pickerOptions}
        waiting={t(!connected
          ? "mobile.model.waitingConnection"
          : answered ? "mobile.model.waitingSession" : "terminal.reader.modelWaiting")}
        busy={modelPreview ? heldPick !== null : shownStep != null && (pickerStep == null || reveal != null || effortFor != null)}
        onPick={chooseModel}
        onClose={closeModelSheet}
      />}</div>}
    {speechLangSheet && <SpeechLangSheet chosen={speechLang} onChoose={setSpeechLang} onClose={() => setSpeechLangSheet(false)} />}
    {addSheet && <AttachSheet
      title={t("mobile.add.title")}
      tiles={attachTiles}
      onPick={pickAdd}
      onClose={() => setAddSheet(false)}
    />}
    {interruptSheet && <ConfirmSheet
      confirm={{ title: t("mobile.keys.interrupt"), note: t("mobile.keys.interruptConfirm"), label: t("mobile.keys.interrupt"), run: () => { type("\u0003"); } }}
      busy={!connected}
      onClose={() => setInterruptSheet(false)}
    />}
    {commitSheet && <OptionSheet
      title={t("mobile.commit.title")}
      note={isUntested("mobile.composer.commit") ? { text: t("mobile.focus.untested") } : undefined}
      options={commitOptions}
      waiting=""
      busy={!connected}
      onPick={pickCommit}
      onClose={() => setCommitSheet(false)}
    ><CommitFiles uncommitted={uncommitted} /></OptionSheet>}
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
    {assistantSheet && <OptionSheet
      title={t("terminal.reader.modelTitle")}
      note={assistantNote
        ? { text: t(assistantNote), error: true }
        : assistantModels && assistantModels.models.length > 0
          ? { text: t("terminal.reader.assistantModelNote") + (isUntested("mobile.facts.assistantModel") ? ` · ${t("mobile.focus.untested")}` : "") }
          : undefined}
      options={assistantOptionRows}
      waiting={t(assistantModels === null ? "terminal.reader.assistantModelLoading" : "terminal.reader.assistantModelNone")}
      busy={assistantSwitching !== ""}
      onPick={chooseAssistantModel}
      onClose={() => { if (!assistantSwitching) setAssistantSheet(false); }}
    />}
    {worktreeSheet && <OptionSheet
      title={t("terminal.reader.worktreeTitle")}
      note={worktreeNote
        ? { text: t(worktreeNote), error: true }
        : worktreeChoices && worktreeChoices.worktrees.length > 0
          ? { text: worktreeMoveNote(worktreeChoices.carries, agentLabel, t) }
          : undefined}
      options={worktreeOptions}
      waiting={t(worktreeChoices === null ? "terminal.reader.worktreeLoading" : worktreeNote ? "mobile.worktree.retry" : "terminal.reader.worktreeNone")}
      busy={worktreeMoving !== ""}
      onPick={chooseWorktree}
      onClose={() => { if (!worktreeMoving) setWorktreeSheet(false); }}
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
    {gallery && (!outboxOpen || markupAway !== null) && <OutboxGallery scope={outboxScope} files={outbox} onOpen={openOutbox} onDetails={setOutboxOpen} onDelete={removeOutbox} onDeleteAll={removeAllOutbox} onClose={() => setGallery(false)} />}
    {/* A markup view's Chat tucks its viewer away (`markupAway`) without
        unmounting it; the host is always there, so the switch never remounts. */}
    {outboxOpen && <div className={markupAway === null ? "markup-host" : "markup-host away"}><BackNest off={markupAway !== null}>
      <OutboxViewer key={`${tab.id}/${outboxOpen.name}`} scope={outboxScope} file={outboxOpen} pictures={outboxPictures} onStep={setOutboxOpen} onClose={() => setOutboxOpen(null)} markup={markupFor}
        newTab={markupNewTab} />
    </BackNest></div>}
    {/* What the reader sent is only looked at: no Mark up, no stepping. */}
    {inboxOpen && (!outboxOpen || markupAway !== null) && <OutboxViewer key={`${tab.id}/inbox/${inboxOpen.name}`} scope={inboxScope} file={inboxOpen} onClose={() => setInboxOpen(null)} />}
    {askedFile && (askedFile.scope ?? askedScope) && <div className={markupAway === null ? "markup-host" : "markup-host away"}><BackNest off={markupAway !== null}>
      <OutboxViewer key={`asked/${askedFile.file.ref ?? askedFile.file.name}`} scope={(askedFile.scope ?? askedScope)!} file={askedFile.file} onClose={() => setAskedFile(null)} startMarking={askedFile.marking}
        markup={markupFor && { ...markupFor, place: askedFile.place, folder: askedFile.folder, refresh: refreshAskedFile }} />
    </BackNest></div>}
    {filesOpen && project && filesLabel !== null && <div className={markupAway === null ? "markup-host" : "markup-host away"}><BackNest off={markupAway !== null}>
      <ProjectFiles key={project} projectId={project} label={filesLabel} onClose={closeFiles} here={filesSides.here} host={filesSides.host}
        markup={markupFor && { tabId: markupFor.tabId, onSend: markupFor.onSend, agent: markupFor.agent, model: markupFor.model, pickModel: markupFor.pickModel, toChat: markupFor.toChat, dialog: markupFor.dialog }} showTab={markupNewTab?.show} />
    </BackNest></div>}

  </main>;
}
