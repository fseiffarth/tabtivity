// The phone terminal's composer: its uploads, everything it sends (keys,
// messages, held prompts, Clear and Undo), and its chips and menus.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useI18nStore, useT, type TranslationKey } from "../../../../src/lib/i18n";
import { type SheetOption } from "../../components/OptionSheet";
import { type MarkupSend } from "../../components/OutboxViewer";
import {
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback,
  useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject,
  type RefObject,
} from "react";
import {
  ApiError, getSchedules, listOutbox, editHeldPrompt, holdPrompt, reportSentPrompt, sentName,
  undoClear, type OutboxFile, type SessionTranscript, type TabRow, type TranscriptEntry,
} from "../../api";
import { DRAFT_SAVE_DELAY, readDraft, writeDraft } from "../../drafts";
import { type ReadableLine } from "../../terminal/readableScreen";
import { type TerminalControl } from "../../terminal/protocol";
import { isOpenCodeTab, openCodeDialogCloseKeys } from "../../terminal/openCodeMini";
import { agentFamily, agentInputWrites, bracketsAgentMessage } from "../../terminal/composer";
import { COMMIT_CHOICES, COMMIT_PROMPTS, type CommitChoice } from "../../terminal/commitPrompts";
import { sendToSubagent, type SubagentSendFailure } from "../../terminal/subagentInput";
import { pullQueuedPrompts, queuedHintShown } from "../../terminal/queuePull";
import { inWorkflow, type SubagentStep } from "../../terminal/subagents";
import {
  MAX_PENDING, arrivedPending, pendingPrompt, reworded, type PendingPrompt,
} from "../../terminal/pendingPrompts";
import { clearMark, type ClearMark } from "../../terminal/clearedSession";
import { onHeldPatched, patchHeld, readHeld, stillHeld, writeHeld } from "../../terminal/heldPrompts";
import {
  completedSlashCommand, draftPrefix, draftPrefixes, forgetSlashCommand, readSlashCommands,
  rememberSlashCommand, slashSuggestions, toggleDraftPrefix, type SlashSuggestion,
} from "../../slashCommands";
import { DICTATION_START, settleDictation, type DictationProgress } from "../../voiceInput";
import { type DictationSession } from "../../voiceSession";
import { paintMicLevel } from "../../../../shared/voice";
import { type SendGuard } from "../../../../shared/handsFree";
import {
  type VoiceNote, UNDO_RELOADS, CODEX_AGENT, type InboxUpload, liftedDraft, uploadInFlight,
  withAttachments,
} from "./terminalShared";

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

/** The longest the Undo chip shows its progress after the desktop took it. */
const UNDO_SETTLE_MAX = 12_000;

/** The files beside the composer, and the picture copies let go once their file leaves it. */
export function useComposerUploads({
  tab, uploadsRef,
}: {
  tab: TabRow;
  uploadsRef: MutableRefObject<InboxUpload[]>;
}) {
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
  return { setUploads, uploads, uploading, attached };
}

/** Everything the composer sends: keys, messages behind a settling command, a
 * subagent's words, held prompts and their edits, and the conversation's Clear
 * and Undo. */
export function useComposerSend({
  tab, bare, composerInput, write, sendControl, sendNowAsking, sendNowAnswer, recognition,
  dictateButton, connectedRef, voiceRequest, voiceProgress, sendGuard, voiceOpen, sendTimers, commandSentAt, lastOutputAt,
  settleQueue, bracketedPaste, screenRows, viewportRows, connected, setAiOffAt, aiOffRef, ctrl,
  setCtrl, setSendFailed, setDraft, draft, uploadsRef, editing, setEditing, editingRef, editSending,
  setEditSending, liveScreen, setLastSent, slashCliKey, agentKey, usedSlash, setUsedSlash,
  setListening, setPreparingVoice, setVoicePreview, setVoiceStatus, setUploads, transcript,
  setPending, pending, pendingId, setClearedAt, clearedAt, setUndoable, setClearQueued, clearQueued,
  setEditNote, editNote, setSubagentSending, subagentSending, setSubagentNote, setQueueNote,
  queuePulling, setQueuePulling, setUndoNote, setUndoing, undoRun, setTranscriptReload,
  setClearRefused, liveBusy, setSendNowWaiting, sendNowWaiting, agentAtWork, subagentPath, openStep,
  transcriptCurrent, transcriptVersion, storedEntries, queuedShown,
}: {
  tab: TabRow;
  bare: boolean;
  composerInput: RefObject<HTMLTextAreaElement>;
  write: MutableRefObject<(value: string, prompt?: number) => boolean>;
  sendControl: MutableRefObject<(frame: TerminalControl) => boolean>;
  sendNowAsking: MutableRefObject<boolean>;
  sendNowAnswer: MutableRefObject<(sent: boolean) => void>;
  recognition: MutableRefObject<DictationSession | undefined>;
  dictateButton: RefObject<HTMLButtonElement>;
  connectedRef: MutableRefObject<boolean>;
  voiceRequest: MutableRefObject<number>;
  voiceProgress: MutableRefObject<DictationProgress>;
  /** Hands-free's send guard and whether the recognizer holds unsettled words
   * (`useHandsFree`): a send ends both. */
  sendGuard: MutableRefObject<SendGuard | undefined>;
  voiceOpen: MutableRefObject<boolean>;
  sendTimers: MutableRefObject<number[]>;
  commandSentAt: MutableRefObject<number>;
  lastOutputAt: MutableRefObject<number>;
  settleQueue: MutableRefObject<{ writes: string[]; prompt?: number; settles: boolean; }[]>;
  bracketedPaste: MutableRefObject<() => boolean>;
  screenRows: MutableRefObject<() => string[]>;
  viewportRows: MutableRefObject<() => string[]>;
  connected: boolean;
  setAiOffAt: Dispatch<SetStateAction<number>>;
  aiOffRef: MutableRefObject<boolean>;
  ctrl: boolean;
  setCtrl: Dispatch<SetStateAction<boolean>>;
  setSendFailed: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  draft: string;
  uploadsRef: MutableRefObject<InboxUpload[]>;
  editing: { id: number; before: string; } | null;
  setEditing: Dispatch<SetStateAction<{ id: number; before: string; } | null>>;
  editingRef: MutableRefObject<{ id: number; before: string; } | null>;
  editSending: boolean;
  setEditSending: Dispatch<SetStateAction<boolean>>;
  liveScreen: ReadableLine[];
  setLastSent: Dispatch<SetStateAction<string>>;
  slashCliKey: string;
  agentKey: string;
  usedSlash: string[];
  setUsedSlash: Dispatch<SetStateAction<string[]>>;
  setListening: Dispatch<SetStateAction<boolean>>;
  setPreparingVoice: Dispatch<SetStateAction<boolean>>;
  setVoicePreview: Dispatch<SetStateAction<string>>;
  setVoiceStatus: Dispatch<SetStateAction<VoiceNote | null>>;
  setUploads: Dispatch<SetStateAction<InboxUpload[]>>;
  transcript: SessionTranscript | null;
  setPending: Dispatch<SetStateAction<PendingPrompt[]>>;
  pending: PendingPrompt[];
  pendingId: MutableRefObject<number>;
  setClearedAt: Dispatch<SetStateAction<ClearMark | null>>;
  clearedAt: ClearMark | null;
  setUndoable: Dispatch<SetStateAction<boolean>>;
  setClearQueued: Dispatch<SetStateAction<boolean>>;
  clearQueued: boolean;
  setEditNote: Dispatch<SetStateAction<"" | TranslationKey>>;
  editNote: "" | TranslationKey;
  setSubagentSending: Dispatch<SetStateAction<boolean>>;
  subagentSending: boolean;
  setSubagentNote: Dispatch<SetStateAction<"" | TranslationKey>>;
  setQueueNote: Dispatch<SetStateAction<"" | TranslationKey>>;
  queuePulling: boolean;
  setQueuePulling: Dispatch<SetStateAction<boolean>>;
  setUndoNote: Dispatch<SetStateAction<"" | TranslationKey>>;
  setUndoing: Dispatch<SetStateAction<false | "asking" | { mark: ClearMark | null; }>>;
  undoRun: MutableRefObject<number>;
  setTranscriptReload: Dispatch<SetStateAction<number>>;
  setClearRefused: Dispatch<SetStateAction<boolean>>;
  liveBusy: boolean;
  setSendNowWaiting: Dispatch<SetStateAction<boolean>>;
  sendNowWaiting: boolean;
  agentAtWork: boolean;
  subagentPath: readonly SubagentStep[];
  openStep: SubagentStep;
  transcriptCurrent: boolean;
  transcriptVersion: MutableRefObject<string | undefined>;
  storedEntries: TranscriptEntry[];
  queuedShown: boolean;
}) {
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
    const typed = agentInputWrites(text, bracketed);
    // A dialog OpenCode has up over its composer would take the message
    // instead of the agent: closed first (`openCodeDialogCloseKeys`).
    const writes = typed.length > 0 && isOpenCodeTab(tab.agent_label ?? tab.label)
      ? [...openCodeDialogCloseKeys(viewportRows.current()), ...typed]
      : typed;
    const message = { writes, prompt, settles: SLASH_COMMAND.test(text) };
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
    sendGuard.current?.reset();
    voiceOpen.current = false;
    setListening(false);
    setVoicePreview("");
    setVoiceStatus(null);
  };
  /** The open subagent the composer writes to: Claude's only, the one CLI
   * whose own TUI takes words for a subagent. */
  const subagentTarget = openStep && agentFamily(tab.agent_label ?? tab.label) === "claude" && !inWorkflow(subagentPath) ? openStep : undefined;
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
    // The desktop's AI switch is off: the draft stays, nothing is sent.
    if (tab.kind === "agent" && aiOffRef.current) {
      setAiOffAt(Date.now());
      return false;
    }
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
    // A chat of the assistant scope has no held-prompt binding: its words go straight to the CLI.
    if (id !== undefined && agentAtWork && !interrupt && !bare) {
      holdDraft(id, text, fromComposer);
      return true;
    }
    if (!(interrupt && agentAtWork ? interruptWith(text, id) : sendAgentText(text, id))) return false;
    setLastSent(text);
    setEditNote("");
    if (id === undefined) {
      // A prefix the CLI's popup completes (`/clea`) runs that command.
      const command = completedSlashCommand(text, slashCliKey, usedSlash) ?? text;
      if (CLEAR_COMMAND.test(command)) startedOver();
      rememberSlashCommand(slashCliKey, command);
      setUsedSlash(readSlashCommands(slashCliKey));
    } else {
      // The new chat has a prompt now: resuming the old one would leave it.
      setUndoable(false);
      setClearQueued(false);
      setUndoNote("");
      // A bubble takes its place from the session the phone holds. Sent from
      // Terminal view that one is stale or empty, and the bubble stood above
      // turns that came before it — at the top of the chat for a session never
      // read here — while its record, where it belongs, was hidden for it. The
      // record alone shows it once Focus reads the session.
      if (transcriptCurrent) {
        const sent = pendingPrompt(id, text, storedEntries);
        setPending((current) => [...current, sent].slice(-MAX_PENDING));
      }
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
   * open for the next round (`docs/done/pdf_markup_rounds_plan.md` §2.5). */
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
  /** The queued bubbles' Send now: Esc stops the agent's turn, and the CLI
   * then sends what waits in its queue at once (the desktop chat's Send now).
   * But Claude takes a queued message into the running turn at its next tool
   * call, and an Esc after that stops the turn that was to answer it. The
   * phone's copy of the screen is too late to judge that by, so the desktop
   * does, beside the pane (`send_now`): it presses only while the queue hint
   * shows. Until then — the desktop has not typed the prompt in yet, or the
   * hint the phone saw was gone by the time it asked — Send now waits, and it
   * gives up once the turn ends or takes the prompt up. */
  const sendQueuedNow = () => {
    setQueueNote("");
    setSendNowWaiting(true);
  };
  useEffect(() => {
    if (!sendNowWaiting) return;
    // The turn ended, or took the prompts up: they go without an Esc.
    if (!liveBusy || !queuedShown) {
      setSendNowWaiting(false);
      return;
    }
    // The phone's own read only says when to ask; the desktop reads again.
    if (sendNowAsking.current || !queuedHintShown(screenRows.current())) return;
    sendNowAsking.current = sendControl.current({ type: "send_now", family: agentKey });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendNowWaiting, liveBusy, queuedShown, liveScreen, agentKey]);
  sendNowAnswer.current = (sent) => {
    sendNowAsking.current = false;
    if (sent) setSendNowWaiting(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setSendNowWaiting(false), [tab.id]);
  /** The queued bubbles' Cancel and edit — the desktop chat's ↑ in its empty
   * box: every prompt in Claude's queue comes back out of it into the
   * composer, after the draft, read off the phone's copy of the screen
   * (`queuePull`); the bubbles of those it held go. */
  const pullQueued = () => {
    if (queuePulling) return;
    const arrived = arrivedPending(storedEntries, pending);
    const queued = pending.filter((entry) => entry.held !== undefined && !arrived.has(entry.id));
    if (queued.length === 0) return;
    setQueueNote("");
    setQueuePulling(true);
    void pullQueuedPrompts({ rows: () => screenRows.current(), key: async (key) => type(key) }, queued.map((entry) => entry.text), SUBAGENT_WALK).then((result) => {
      if (!result.ok) {
        setQueueNote("terminal.reader.pullFailed");
        return;
      }
      const taken = new Set(queued.slice(queued.length - result.pulled).map((entry) => entry.id));
      if (taken.size > 0) setPending((current) => current.filter((entry) => !taken.has(entry.id)));
      setDraft((current) => (current ? `${current}\n${result.text}` : result.text));
      if (!result.cleared) setQueueNote("terminal.reader.pullLeftover");
      composerInput.current?.focus();
    }).finally(() => setQueuePulling(false));
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  /** Some prompt sent from here still waits on the desktop. */
  const heldWaiting = useMemo(() => {
    const arrived = arrivedPending(storedEntries, pending);
    return pending.some((entry) => entry.held !== undefined && !arrived.has(entry.id));
  }, [storedEntries, pending]);
  // What the notes about waiting prompts say is over once none waits.
  useEffect(() => {
    if (!heldWaiting && (editNote === "mobile.composer.heldNote" || editNote === "mobile.composer.heldEdited")) setEditNote("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldWaiting, editNote]);
  // The agent took the prompt being edited: its words are final. What the
  // reader typed stays in the composer as an ordinary draft.
  useEffect(() => {
    if (editing && !editSending && arrivedPending(storedEntries, pending).has(editing.id)) {
      setEditing(null);
      setEditNote("mobile.composer.heldGone");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  return { type, press, clearPending, deliver, sendAgentText, forgetDictation, endDictation, subagentTarget, submitDraft, submitDraftRef, sendHold, sendHoldHandlers, sendMarkup, refreshOutboxFile, sendQueuedNow, pullQueued, startEdit, cancelEdit, resendPrompt, undoClearConversation, clearConversation };
}

/** The composer's chips and menus (Commit, the `/` menu, the Plan/Goal
 * prefixes, the ✕) and the draft kept on the phone. */
export function useComposerTools({
  tab, t, composerInput, connected, draft, setDraft, savedDraft, slashCliKey, usedSlash,
  setUsedSlash, setCommitSheet, uploads, forgetDictation, submitDraft,
}: {
  tab: TabRow;
  t: ReturnType<typeof useT>;
  composerInput: RefObject<HTMLTextAreaElement>;
  connected: boolean;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  savedDraft: () => string;
  slashCliKey: string;
  usedSlash: string[];
  setUsedSlash: Dispatch<SetStateAction<string[]>>;
  setCommitSheet: Dispatch<SetStateAction<boolean>>;
  uploads: InboxUpload[];
  forgetDictation: () => void;
  submitDraft: (text?: string, fromComposer?: boolean, interrupt?: boolean) => boolean;
}) {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  return { commitOptions, pickCommit, lang, slashMenu, pickSlash, prefixCommands, activePrefix, togglePrefix, forgetSlash, clearDraft };
}
