// The phone terminal's session chat: the stored session it reads, its
// entries, the subagent conversations, read-aloud, and the usage limits poll.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { useT, type TranslationKey } from "../../../../src/lib/i18n";
import { sentFiles } from "../../components/SentFilesIndex";
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch,
  type SetStateAction, type MutableRefObject, type RefObject,
} from "react";
import {
  getAgentStatus, getTranscript, type OutboxFile, type SessionTranscript, type TabRow,
  type TranscriptEntry,
} from "../../api";
import { type TerminalViewChoice } from "../../prefs";
import { speechTag } from "../../speechLang";
import { type ReadableLine } from "../../terminal/readableScreen";
import { inputFrameStart } from "../../terminal/statusLine";
import { useChatUncommitted } from "../../terminal/chatUncommitted";
import { transcriptTurns, type TranscriptTurn } from "../../terminal/transcriptTurns";
import { openSubagent, stepSibling, type SubagentStep } from "../../terminal/subagents";
import { withPending, type PendingPrompt } from "../../terminal/pendingPrompts";
import { outboxPosts } from "../../terminal/outboxPosts";
import { inboxLeaves, useInboxFiles } from "../../terminal/inboxRefs";
import { afterClear, type ClearMark } from "../../terminal/clearedSession";
import { startVisiblePoll, type VisiblePoll } from "../../visiblePoll";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../../shared/usageReport";
import { feedReading, leaveReading, MAX_SPOKEN_AT_ONCE, readAnswers, readingHeld, stopSpeaking } from "../../speechOutput";
import { TRANSCRIPT_STEP, CODEX_AGENT, type InboxUpload, leafOfReference } from "./terminalShared";

/** How often Focus re-reads the stored session while it is in view. The read
 * carries the last fingerprint, so an unchanged transcript costs one small
 * request and no turns cross the link. */
const TRANSCRIPT_POLL = 5_000;

/** How long after the screen last changed the stored session is re-read: the
 * agent writes an answer to its transcript as it prints it, so a change on
 * screen is the earliest sign that the file has moved. */
const TRANSCRIPT_SETTLE = 1_200;

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

/** Reads the agent's stored session for Focus, and what its chat has left uncommitted. */
export function useSessionTranscript({
  tab, bare, composerInput, view, setView, setTranscript, transcript, pending, setTranscriptReload,
  transcriptReload, transcriptLimit, screenTick,
}: {
  tab: TabRow;
  bare: boolean;
  composerInput: RefObject<HTMLTextAreaElement>;
  view: TerminalViewChoice;
  setView: Dispatch<SetStateAction<TerminalViewChoice>>;
  setTranscript: Dispatch<SetStateAction<SessionTranscript | null>>;
  transcript: SessionTranscript | null;
  pending: PendingPrompt[];
  setTranscriptReload: Dispatch<SetStateAction<number>>;
  transcriptReload: number;
  transcriptLimit: number;
  screenTick: number;
}) {
  // Focus on an agent tab is its stored session and nothing else, so an agent
  // whose transcript is never read (`unsupported`) opens Terminal instead,
  // without writing that as the reader's choice. Every other reason is a
  // session on its way — a tab the phone just created has no session id until
  // its hook records one, a read can fail once, Codex binds its rollout late —
  // so Focus stays on a loading row and paints the session the moment it
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
  /** An agent with no stored session to read: its Chat entry is dimmed and
   * its Focus hands over to Terminal. A just-sent prompt is still a useful
   * Reader conversation when Codex has not produced a readable rollout yet —
   * its local bubble stays on screen rather than vanishing mid-turn. */
  const chatUnavailable = tab.kind === "agent" && transcript?.available === false && transcript.reason === "unsupported"
    && (!CODEX_AGENT.test(tab.agent_label ?? tab.label) || pending.length === 0);
  useEffect(() => {
    if (!composerTyping && view === "focus" && chatUnavailable) setView("terminal");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, chatUnavailable, composerTyping]);
  /** Whether Focus is reading an agent's stored session: every agent tab's
   * Focus — a shell's reads its screen. */
  const sessionFocus = tab.kind === "agent" && view === "focus";
  /** Whether `transcript` is the session as it stands: a read answered since
   * Focus last opened. Terminal view reads none, so what it holds is the
   * session of when the reader left Focus — or nothing at all. */
  const [transcriptCurrent, setTranscriptCurrent] = useState(false);
  useEffect(() => { if (view !== "focus") setTranscriptCurrent(false); }, [view]);
  const transcriptVersion = useRef<string | undefined>();
  /** The session poll below, so the settle read can ask it to read now. */
  const transcriptPoll = useRef<VisiblePoll>();
  useEffect(() => { transcriptVersion.current = transcript?.version; }, [transcript]);
  /** What this chat changed and has not committed: the Commit chip's count
   * and its sheet's list, read again each time the sheet opens. */
  const [commitRefresh, setCommitRefresh] = useState(0);
  const uncommitted = useChatUncommitted(tab.id, tab.kind === "agent" && !bare, transcript?.version, commitRefresh);
  const uncommittedCount = uncommitted?.available ? uncommitted.total : 0;
  /** Reads the stored session: on open, every TRANSCRIPT_POLL while the page
   * is visible, and TRANSCRIPT_SETTLE after the screen last changed. A read
   * that answers `unchanged` keeps what is shown; one that fails keeps it too
   * and the next read retries. An unavailable session (a shell, an agent
   * whose transcript is not read, no desktop) hands Focus to the screen. */
  useEffect(() => {
    if (tab.kind !== "agent" || view !== "focus") return;
    const poll = startVisiblePoll((signal) => getTranscript(tab.id, transcriptVersion.current, transcriptLimit, signal).then(
      (next) => {
        if (signal.aborted) return;
        // A malformed answer is a failed read: keep what is shown.
        if (!next || typeof next !== "object") return;
        setTranscriptCurrent(true);
        if (next.unchanged) return;
        // A forced full read (after an Undo) answers the same session: keep
        // what is shown, but ask by its version again from here on.
        transcriptVersion.current = next.version;
        showTranscript(next);
      },
      () => {},
    ), TRANSCRIPT_POLL);
    transcriptPoll.current = poll;
    return () => {
      poll.stop();
      if (transcriptPoll.current === poll) transcriptPoll.current = undefined;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.kind, view, transcriptLimit, transcriptReload]);
  useEffect(() => {
    if (!sessionFocus || screenTick === 0) return;
    const timer = window.setTimeout(() => transcriptPoll.current?.now(), TRANSCRIPT_SETTLE);
    return () => window.clearTimeout(timer);
  }, [screenTick, sessionFocus, tab.id, transcriptLimit]);
  return { setComposerTyping, typingStopped, chatUnavailable, sessionFocus, transcriptCurrent, transcriptVersion, setCommitRefresh, uncommitted, uncommittedCount };
}

/** The session chat's entries, with the prompts sent from here held in place,
 * and the files sent either way. */
export function useSessionEntries({
  tab, cloudTab, liveScreen, uploads, outbox, transcript, pending, clearedAt, undoing, setUndoing,
  sessionFocus,
}: {
  tab: TabRow;
  cloudTab: boolean;
  liveScreen: ReadableLine[];
  uploads: InboxUpload[];
  outbox: OutboxFile[];
  transcript: SessionTranscript | null;
  pending: PendingPrompt[];
  clearedAt: ClearMark | null;
  undoing: false | "asking" | { mark: ClearMark | null; };
  setUndoing: Dispatch<SetStateAction<false | "asking" | { mark: ClearMark | null; }>>;
  sessionFocus: boolean;
}) {
  /** Where the live screen's input box begins — `liveScreen.length` while the
   * CLI has not drawn one yet (still starting, or a dialog in its place). */
  const liveFrameStart = useMemo(
    () => (tab.kind === "agent" ? inputFrameStart(liveScreen, tab.agent_label ?? tab.label) : liveScreen.length),
    [tab.kind, tab.agent_label, tab.label, liveScreen],
  );
  const cliReady = liveFrameStart < liveScreen.length;
  /** A session with nothing to read yet: the first read has not answered, or
   * the CLI has recorded no session (or no transcript) so far — a fresh tab
   * starting, Codex binding its rollout late, a prompt from here not yet
   * recorded. The chat shows a loading row while the CLI starts, then the
   * empty chat; the screen is one tap away in Terminal. A cloud tab never
   * records one (`cloudTab`). */
  const sessionWaiting = sessionFocus && !cloudTab
    && (transcript === null || (!transcript.available && (transcript.reason === "no_session" || transcript.reason === "no_transcript")));
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoing, transcript]);
  const storedEntries = useMemo(() => sinceClear ?? transcript?.entries ?? [], [sinceClear, transcript]);
  const sessionEntries = useMemo(() => withPending(storedEntries, pending), [storedEntries, pending]);
  const sessionAgents = useMemo(() => sessionEntries.filter((entry) => entry.kind === "agent"), [sessionEntries]);
  /** The session's subagents only earlier turns not read in hold, counted
   * with the listed ones; none for a long session that never spawned one. */
  const earlierAgents = transcript?.truncated && !sinceClear ? transcript.agentsEarlier ?? 0 : 0;
  const agentsEarlier = earlierAgents > 0;
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
  return { cliReady, sessionWaiting, sinceClear, storedEntries, sessionEntries, sessionAgents, earlierAgents, agentsEarlier, queuedShown, chatPosts, inboxFiles, chatFiles };
}

/** The subagent conversation open in the Reader: its read, and the walk into,
 * up and across subagents. */
export function useSubagentReader({
  tab, readableHost, view, setAtBottom, atBottomRef, pending, setSubagentNote, setSubagentPath,
  setSubagentListOpen, setSentListOpen, openStep, subRead, setSubRead, setSubLimit, subLimit,
  restoreScroll, sessionEntries,
}: {
  tab: TabRow;
  readableHost: RefObject<HTMLElement>;
  view: TerminalViewChoice;
  setAtBottom: Dispatch<SetStateAction<boolean>>;
  atBottomRef: MutableRefObject<boolean>;
  pending: PendingPrompt[];
  setSubagentNote: Dispatch<SetStateAction<"" | TranslationKey>>;
  setSubagentPath: Dispatch<SetStateAction<readonly SubagentStep[]>>;
  setSubagentListOpen: Dispatch<SetStateAction<boolean>>;
  setSentListOpen: Dispatch<SetStateAction<boolean>>;
  openStep: SubagentStep;
  subRead: { token: string; transcript: SessionTranscript; } | null;
  setSubRead: Dispatch<SetStateAction<{ token: string; transcript: SessionTranscript; } | null>>;
  setSubLimit: Dispatch<SetStateAction<number>>;
  subLimit: number;
  restoreScroll: MutableRefObject<number | null>;
  sessionEntries: TranscriptEntry[];
}) {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSubagentListOpen(false); setSentListOpen(false); }, [tab.id]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSubagentNote(""); }, [tab.id, subToken]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSubLimit(TRANSCRIPT_STEP); }, [subToken]);
  /** Reads the open subagent's conversation as the session itself is read: at
   * once, then every TRANSCRIPT_POLL while the page is visible — a subagent
   * still at work keeps writing. */
  useEffect(() => {
    if (!subToken || tab.kind !== "agent" || view !== "focus") return;
    let version: string | undefined;
    return startVisiblePoll((signal) => getTranscript(tab.id, version, subLimit, signal, subToken).then(
      (next) => {
        if (signal.aborted || !next || typeof next !== "object" || next.unchanged) return;
        version = next.version;
        setSubRead((current) => current && current.token === subToken && sameTranscript(current.transcript, next)
          ? current
          : { token: subToken, transcript: next });
      },
      () => {},
    ), TRANSCRIPT_POLL).stop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subToken, subLimit, tab.id, tab.kind, view]);
  /** The conversation on screen — the session's, or the open subagent's —
   * which is where a card tapped in it was opened from. */
  const levelEntries = openStep ? (subTranscript?.entries ?? []) : sessionEntries;
  const levelEntriesRef = useRef(levelEntries);
  levelEntriesRef.current = levelEntries;
  const openSubagentTurn = useCallback((turn: Pick<TranscriptTurn, "subagent" | "text" | "role" | "workflow">, fromList = false) => {
    const token = turn.subagent;
    if (!token) return;
    const top = readableHost.current?.scrollTop ?? 0;
    setSubagentPath((path) => openSubagent(path, { token, task: turn.text, role: turn.role, ...(turn.workflow ? { workflow: true } : {}) }, levelEntriesRef.current, top));
    if (!fromList) setSubagentListOpen(false);
    // A conversation opens on its newest turn, as the session does.
    atBottomRef.current = true;
    setAtBottom(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);
  useLayoutEffect(() => {
    const top = restoreScroll.current;
    const stream = readableHost.current;
    // Wait until the conversation gone back to is drawn.
    if (top === null || !stream || (openStep && !subTranscript)) return;
    restoreScroll.current = null;
    stream.scrollTop = top;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openStep, subTranscript]);
  return { subToken, subTranscript, openSubagentTurn, openListedSubagent, subagentUp, subagentSibling };
}

/** Speaks each new answer of the stored session once, while read-aloud is on
 * and nothing is dictated — through the tab's reading cursor
 * (`speechOutput.ts`), so the spoken moves and the read position work on it.
 * While a hands-free turn holds it (`holdReadingForTurn`), nothing is read
 * entry by entry: the turn's answers are read once it is over (`readTurn`). */
export function useReadAloud({
  tab, listening, transcript, readAloud, sessionFocus,
}: {
  tab: TabRow;
  /** Kept for the call site: the reading labels are said in the speech
   * language, not the screen's (`speechOutput.ts`). */
  t?: ReturnType<typeof useT>;
  listening: boolean;
  transcript: SessionTranscript | null;
  readAloud: boolean;
  sessionFocus: boolean;
}) {
  /** Read-aloud: each answer that arrives at the end of the stored session is
   * spoken once. What the tab's first read brought is history, as is anything
   * "earlier" reveals above it or a whole other session swapped in — only a
   * short new tail is news. What was heard is kept per tab in memory with
   * the read position, so a reconnect or a trip to another tab neither reads
   * an answer twice nor skips one. Nothing is said over dictation: the
   * microphone would hear it. */
  useEffect(() => () => {
    stopSpeaking();
    leaveReading(tab.id);
  }, [tab.id]);
  useEffect(() => {
    if (!sessionFocus || !transcript) return;
    const turns = transcriptTurns(transcript.entries);
    const agent = tab.agent_label ?? tab.label;
    const answers = turns.filter((turn) => turn.kind === "answer").map((turn) => ({ id: turn.key, text: turn.text, agent }));
    const fresh = feedReading(tab.id, turns.map((turn) => turn.key), answers, speechTag());
    if (!fresh || !readAloud || listening || readingHeld(tab.id)) return;
    if (fresh.length === 0 || fresh.length > MAX_SPOKEN_AT_ONCE) return;
    readAnswers(tab.id, fresh[0]);
  }, [sessionFocus, transcript, readAloud, listening, tab.id, tab.agent_label, tab.label]);
  useEffect(() => {
    if (listening || !sessionFocus) stopSpeaking();
  }, [listening, sessionFocus]);
}

/** Reads the account's usage limits on a slow poll, and ticks the clock their countdowns read. */
export function useLimitsPoll({
  tab, setLimitsNow, rememberLimits,
}: {
  tab: TabRow;
  setLimitsNow: Dispatch<SetStateAction<number>>;
  rememberLimits: (next: LimitMeters) => void;
}) {
  /** Reads the usage panel now and every `LIMITS_POLL` while the page is
   * visible. A CLI with no usage readout stops the polling; a failed read keeps
   * what was shown — the next poll retries. */
  useEffect(() => {
    if (tab.kind !== "agent") return;
    let last = 0;
    let unsupported = false;
    let disposed = false;
    const poll = startVisiblePoll(() => {
      if (unsupported || Date.now() - last < LIMITS_POLL / 2) return undefined;
      last = Date.now();
      return getAgentStatus(tab.id).then(
        (report) => {
          // A malformed answer is a failed read: keep what is shown.
          if (disposed || !report?.usage) return;
          if (report.usage.supported === false) {
            unsupported = true;
            return;
          }
          if (report.usage.raw) rememberLimits(limitMeters(parseUsageReport(report.usage.raw)));
        },
        () => {},
      );
    }, LIMITS_POLL);
    return () => {
      disposed = true;
      poll.stop();
    };
  }, [tab.id, tab.kind, rememberLimits]);
  useEffect(() => {
    if (tab.kind !== "agent") return;
    const timer = window.setInterval(() => setLimitsNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.kind]);
}
