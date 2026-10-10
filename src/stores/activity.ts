import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { looksLikeDecisionPromptStripped, stripAnsi } from "../lib/agents/prompt/prompt";
import { METRIC, agentPromptLeaf } from "../lib/usageMetrics";
import { splitPtyId } from "../lib/terminal/ptyId";
import { allGroups, isPtyTabKind, useTabsStore } from "./tabs";
import type { TabEntry } from "./tabs";
import { bumpUsage } from "./usage";
import { isDetachedWindow } from "./detachedContext";

/** Mirrors `DETACHED_ACTIVITY` in stores/detached (spelled here so this module
 *  stays free of that import: detached.ts imports this one). */
const DETACHED_ACTIVITY_EVENT = "detached-activity";

// ── The two readings of an agent tab ────────────────────────────────────────
//
// The tab's OWN HOOKS are the authority where they fire (`turnByPty`, fed by
// the backend's `agent-turn` event off the record `services::agent_turn`
// watches): Claude Code and a trusted Codex tell Tabtivity when a prompt was
// submitted, when a tool finished, when they stopped, and (Claude) when they
// wait on a permission. That is exact, and it is what the bytes could never be:
// every agent TUI paints something while idle (Codex a braille field and its
// title, on a timer), paints almost nothing while it thinks (Codex changes one
// digit a second), and paints a lot while it waits (a menu redraw). Two rounds
// of byte filtering each fixed one agent's habit and broke another's reading.
//
// The BYTE HEURISTIC below stays for the tabs with no hook — Gemini, Qwen, a
// custom command, a Codex whose hooks are not yet trusted — and as the net
// under a verdict that can go stale (an interrupted turn fires no Stop). It
// reads two things off each frame: whether the program is PAINTING (any output,
// spinner and title included) and whether it is SAYING anything (visible text
// past the decoration). Working is both at once, sustained; idle is painting
// without saying; blocked is saying nothing while a menu sits in the tail.

/// A tab is painting right now when any output — a spinner cell, a title
/// frame, real text — arrived within this window. Short enough to clear
/// quickly when a turn ends, long enough to bridge a TUI's own repaint timer.
const BUSY_WINDOW_MS = 800;

/// A tab is still SAYING something when a text-bearing frame arrived within
/// this window. Wider than the paint window on purpose: a working Codex writes
/// one digit of its timer a second and paints its spinner in between, so a
/// 800 ms text window read every second of its work as a fresh burst and
/// "working" never came on. A gap past this ends the burst and its tail.
const TEXT_GAP_MS = 1500;

/// But it only BECOMES "working" once text has been sustained for this long —
/// an onset debounce so a brief blip (a quick command, a single redraw) doesn't
/// flash the working indicator. A burst must last past this before it counts.
const WORK_ONSET_MS = 1500;

/// A text frame landing this soon after the user's own keystroke is its echo —
/// the composer repainting the character just typed — and says nothing about
/// the agent. Not counted as text (it never starts or sustains a burst), so
/// typing a long prompt never lights "working"; still counted as paint.
const ECHO_MS = 150;

/// A hook verdict of "working" is trusted only while the tab is painting at
/// all. An agent whose turn was interrupted fires no Stop, and a Claude that
/// idles goes fully silent, so this much total silence under a "working"
/// verdict means the verdict outlived the turn: drop it and read the bytes.
const HOOK_WORK_SILENCE_MS = 20_000;

/// How long an unwatched agent tab must have been quiet before we call what it's
/// doing. The two are deliberately asymmetric: a decision prompt in its output is
/// POSITIVE evidence that the agent is blocked, so it may glow almost at once;
/// "done" is inferred from the ABSENCE of output, so it waits out a longer
/// silence rather than calling every pause between writes a finished turn.
const DECISION_QUIET_MS = 600;
const DONE_QUIET_MS = 2500;

/// How much of an agent's output tail is kept to classify it by — enough to hold
/// the last screenful of a TUI redraw, small enough to be free.
const TAIL_CAP = 8000;

// Per-PTY activity, all keyed by the composed PTY id (`<scope>:<tabKey>`, the id
// the backend emits under): when output last arrived; when the current burst of
// output began (reset whenever output resumes after a quiet gap); the ANSI-
// stripped tail of that burst; when the user last had eyes on the tab; when the
// agent in it last rang the terminal bell; and when the user last sent input to
// it. Kept outside the store: they churn on every output batch (~60/s) and
// nothing renders off them directly — only the derived maps, recomputed on an
// interval, drive the UI.
/// When `recompute` last ran, so the usage recap can bill agent working time by
/// the real gap between ticks rather than by an assumed interval.
let lastTickAt: number | null = null;

/// The largest gap between two `recompute` ticks that may be billed as agent
/// working time. A longer gap means the interval was not running — the laptop
/// slept, the tab was throttled — and whatever the agents were doing across it is
/// not something we observed. Billing it would silently invent hours.
const MAX_WORK_TICK_MS = 5_000;

/// When a text-bearing frame (not an echo) last arrived — "saying".
const lastOutputByPty: Record<string, number> = {};
/// When ANY frame last arrived, decoration included — "painting".
const lastRawByPty: Record<string, number> = {};
/// When the current text burst began (a gap past `TEXT_GAP_MS` starts a new one).
const onsetByPty: Record<string, number> = {};
const tailByPty: Record<string, string> = {};
/// The tab's own hook verdict (see the header comment), stamped at receipt.
/// Absent for a tab whose agent fires no hooks, or once a verdict was retired.
const turnByPty: Record<string, { state: AgentTurnState; at: number; job: boolean }> = {};
// Automation must not inherit the UI's silence fallback or unread state.
const deliveryTurns: Record<string, { state: AgentTurnState; at: number; startedAt?: number; stoppedAt?: number; job: boolean }> = {};
const seenAtByPty: Record<string, number> = {};
const bellByPty: Record<string, number> = {};
const proposalByPty: Record<string, number> = {};

/** A schedule proposal lights the existing unread affordance until the next look. */
export function noteScheduleProposal(ptyId: string): void {
  proposalByPty[ptyId] = Date.now();
  useActivityStore.getState().recompute();
}
const inputByPty: Record<string, number> = {};
/// When the user cut the agent's turn off (an interrupt key while it was
/// working, or on a pending prompt — see `noteUserInput`). An interrupted turn
/// fires no Stop, so without this the tab went back to looking idle, exactly as
/// a turn that finished would once it had been read. Held until the agent's
/// next turn begins; `attentionFor` turns it into the `interrupted` mark.
const interruptedByPty: Record<string, number> = {};
/// When the tab was last DELIBERATELY opened — switched to in a tab bar, or put
/// on a phone's screen (`clearAttention`). Deliberately not the same as
/// `seenAtByPty`, which `attentionFor` re-stamps on every tick for as long as a
/// tab is the visible one: an agent tab left on screen on an unattended desktop
/// is "being looked at" forever, and that is what kept a finished turn from ever
/// being reported to the phone. This one only moves when somebody arrives.
const readAtByPty: Record<string, number> = {};
/// Whether the tab has been busy since its last turn-end mark (see
/// `lastDoneByTab`): a turn "finishes" only after it was seen working, so a
/// stray blip followed by silence never books a finished turn.
const busySinceMarkByPty: Record<string, boolean> = {};
/// When the tab last produced output inside a burst that counted as WORK —
/// sustained past `WORK_ONSET_MS`, the bar "working" has to clear. This, not
/// `lastOutputByPty`, is what a `done` flag is raised from: an idle agent TUI
/// still paints now and then (a repaint when its pane is resized on a show or
/// hide, a focus report, a status-line refresh), and each of those is output
/// "after the user looked". Counting them brought a turn the user had already
/// read back as unread a few seconds after every look away.
const workAtByPty: Record<string, number> = {};
/// When the tab's current — or, once it is over, its last — turn began (ms
/// epoch): a hooked agent's prompt (`noteAgentTurn`), or for one with no hooks
/// the onset of the burst that first read as work after its last finished turn.
/// A tool call inside a turn, or an approval it waited on, does not restart it.
/// Read by the phone bridge (`agentTurnStartedAt`), which shows how long a tab
/// has been — or was — at work on it.
const turnStartByPty: Record<string, number> = {};
/// When work the agent left running past its Stop — a background shell (the
/// hook's `job`) or a subagent (`noteBackgroundWork`) — was last seen alive.
/// Claude wakes itself when that work finishes; a `working` with this stamp
/// after the Stop and no input since carries on the turn instead of opening one
/// from zero (`wokenByBackground`).
const backgroundAtByPty: Record<string, number> = {};
/// When the tab's agent was last known to be waiting on nothing but its own
/// next hook — so nothing on its screen is a question, and the screen is not
/// read for one (`attentionFor`) until a hook speaks again. Raised by:
///  - the session starting (`noteAgentSessionStart`: a launch, a resume, a
///    `/clear`): the CLI is at its composer;
///  - a spawn whose previous run left its turn finished (`noteAgentResting`,
///    `pty_spawn`'s `resting`): a resumed or reattached agent at its composer;
///  - the user's input retiring a verdict (`noteUserInput`): an answered
///    approval runs its tool and reports it, an interrupted turn is back at
///    its composer.
/// Each of these is followed by a screen the screen check misreads: a resume
/// or a tmux reattach repaints the whole conversation, and Claude's own
/// prompt echo (`❯ continue`, `❯ yes`, `❯ 1. fix …`) and a reply's numbered
/// list ("1. Run the gates / 2. Skip …") both read as a menu. Nothing retires
/// that guess on an idle tab — it paints nothing more, and looking does not
/// answer a question — so it stood until the user typed. Agents with no hooks
/// never raise this, and keep the screen check.
const awaitingHookByPty: Record<string, number> = {};

/** When the tab's current or last turn began, if this session saw one begin. */
export function agentTurnStartedAt(ptyId: string): number | undefined {
  return turnStartByPty[ptyId];
}

/** Record that the tab's session had work of its own at `at` — a subagent still
 *  running, as the phone bridge counts them (`mobileSubagentCount`). */
export function noteBackgroundWork(ptyId: string, at = Date.now()): void {
  if ((backgroundAtByPty[ptyId] ?? 0) < at) backgroundAtByPty[ptyId] = at;
}

/** Whether a `working` after a Stop is the agent woken by the work it left
 *  running (a subagent or background shell finished) rather than a new prompt:
 *  that work was seen alive after the Stop, and nobody typed since. */
function wokenByBackground(ptyId: string, prev: (typeof deliveryTurns)[string] | undefined): boolean {
  if (prev?.state !== "done" || interruptedByPty[ptyId] !== undefined) return false;
  const stoppedAt = prev.stoppedAt ?? prev.at;
  return (backgroundAtByPty[ptyId] ?? 0) >= stoppedAt && (inputByPty[ptyId] ?? 0) <= stoppedAt;
}

/// Memo for the decision-prompt test, keyed by PTY id and validated against the
/// tail it was computed from. `attentionFor` asks the question of every agent tab
/// on every 300ms tick, but the answer can only change when the tail does — and a
/// tab quiet enough to hold a decision prompt is precisely one whose tail is NOT
/// changing. Without this, a settled prompt re-ran four regexes over 8 KB, three
/// of them case-insensitive, ~3.3 times a second forever. The guard is a string
/// compare that hits JS's reference-equality fast path, since `tailByPty` holds
/// the same string instance while the tab is quiet.
const decisionMemo = new Map<string, { tail: string; hit: boolean }>();

function tailLooksLikeDecision(ptyId: string): boolean {
  // Already ANSI-stripped on the way in (see `notePtyOutput`), so this must NOT
  // be routed through `stripAnsi` again.
  const tail = tailByPty[ptyId] ?? "";
  const memo = decisionMemo.get(ptyId);
  if (memo !== undefined && memo.tail === tail) return memo.hit;
  const hit = looksLikeDecisionPromptStripped(tail);
  decisionMemo.set(ptyId, { tail, hit });
  return hit;
}

const PTY_MAPS: Record<string, unknown>[] = [
  lastOutputByPty,
  lastRawByPty,
  onsetByPty,
  tailByPty,
  turnByPty,
  deliveryTurns,
  seenAtByPty,
  bellByPty,
  proposalByPty,
  inputByPty,
  interruptedByPty,
  readAtByPty,
  busySinceMarkByPty,
  workAtByPty,
  turnStartByPty,
  backgroundAtByPty,
  awaitingHookByPty,
];

/// Braille pattern cells (U+2800–U+28FF), which an agent TUI paints as
/// decoration, never as content. Codex 0.154 fills the empty rows around its
/// composer with a drifting field of them — ~1.2 KB of visible cells every
/// 150ms, for as long as it sits idle, once the terminal answers its
/// background-colour query (xterm.js does). Counted as text, that animation
/// kept a commanded Codex tab "working" forever after its turn ended, and
/// pushed the prompt it was waiting on out of the tail. The cost is a TUI whose
/// ONLY sign of life is a lone braille spinner cell; every agent Tabtivity knows
/// repaints a status word or a timer beside its spinner.
const BRAILLE_CELLS = /[\u2800-\u28ff]/g;

/** Record that a PTY produced output just now, keeping the tail of the current
 *  burst so `recompute` can tell a finished turn from a decision prompt. Cheap;
 *  safe to call often. */
export function notePtyOutput(ptyId: string, data = "") {
  const now = Date.now();
  // Every frame is paint, whatever it says.
  lastRawByPty[ptyId] = now;
  const text = data ? stripAnsi(data).replace(BRAILLE_CELLS, "") : "";
  // A frame that paints no text — a terminal-title update, a cursor move, a
  // blanked cell — says nothing about what the agent is doing, and a BLOCKED
  // Codex tab emits nothing else: its title alternates between
  // "[ ! ] Action Required" and "[ . ] Action Required" on a ~100ms timer for as
  // long as an approval sits unanswered (the same timer spins a braille frame
  // into the title while it works). Counting those as text is what kept such
  // a tab stuck on "working": the quiet never reached DECISION_QUIET_MS, so its
  // tail was never classified and the decision lamp never lit. Its idle dot
  // animation is dropped the same way (see `BRAILLE_CELLS`).
  // `/\S/` rather than `!text.trim()`: same whitespace set, but it asks the
  // question without copying the chunk (this runs on every PTY batch).
  if (data && !/\S/.test(text)) return;
  const appendTail = () => {
    if (!text) return;
    const tail = (tailByPty[ptyId] ?? "") + text;
    tailByPty[ptyId] = tail.length > TAIL_CAP ? tail.slice(-TAIL_CAP) : tail;
  };
  // The echo of the user's own keystroke: on the screen (so in the tail, where
  // an answered menu will be dropped by `noteUserInput` anyway) but not a word
  // from the agent. See `ECHO_MS`. A call with no data is the test hook and
  // always counts.
  const input = inputByPty[ptyId];
  if (data && input !== undefined && now - input < ECHO_MS) {
    appendTail();
    return;
  }
  const prev = lastOutputByPty[ptyId];
  // Start of a fresh burst after quiet (or the very first text): reset the
  // onset. Text within the gap keeps the existing onset, so a continuous
  // stream ages past WORK_ONSET_MS and flips to "working".
  if (prev === undefined || now - prev >= TEXT_GAP_MS) {
    onsetByPty[ptyId] = now;
    // A new burst redraws the screen, so the last one's tail is stale. Dropping
    // it is what stops an ALREADY-ANSWERED prompt from being matched again as a
    // live one: an agent sits quiet while a prompt awaits the human, so whatever
    // it does once answered necessarily arrives as a new burst.
    tailByPty[ptyId] = "";
  }
  lastOutputByPty[ptyId] = now;
  if (now - onsetByPty[ptyId] >= WORK_ONSET_MS) workAtByPty[ptyId] = now;
  appendTail();
}

/** What an agent's own hooks last said about its turn: `working` (a prompt
 *  was submitted, or a tool finished — which is also how an approval wait
 *  ends), `decision` (a permission or elicitation notice), `done` (Stop, or
 *  the idle notice) — or `idle`, the session's end, which retires the verdict
 *  and hands the tab back to its bytes. */
export type AgentTurnState = "working" | "decision" | "done" | "idle";

/** Record a hook verdict for a PTY (the backend's `agent-turn` event, keyed by
 *  the composed PTY id). Stamped at receipt so it compares with the store's
 *  own clock (`seenAtByPty`, `inputByPty`). Recomputes at once: a verdict is
 *  the one input here that is exact, and the 300 ms tick would only delay it.
 *
 *  `job` is the second half of the event (`services::agent_turn`): whether a
 *  shell the agent put in the BACKGROUND — Claude's `run_in_background`, or
 *  anything of its own still running after its turn ended — was alive at the
 *  backend's last scan. The tool call an agent is sitting and waiting on is not
 *  one; that is what "working" already says. It is independent of the turn, and
 *  both halves are read here: a `done` with a job still running is not a
 *  finished tab (the turn ended, the work did not), and a `working` with one is
 *  an agent and a command of its own going at once. */
export function noteAgentTurn(ptyId: string, state: AgentTurnState, job = false, replay = false) {
  if (isDetachedWindow()) return;
  if (!splitPtyId(ptyId)) return;
  const at = Date.now();
  // A job flip re-reports the record's last state (`replay`), which still
  // says what the user's input already retired — an approval answered, a turn
  // cut off — since no hook has written over it. It carries the job flag on;
  // it does not bring the verdict back, nor end the interrupted mark.
  if (replay && turnByPty[ptyId] === undefined && awaitingHookByPty[ptyId] !== undefined) {
    const prev = deliveryTurns[ptyId];
    if (prev) deliveryTurns[ptyId] = { ...prev, job };
    useActivityStore.getState().recompute();
    return;
  }
  if (!replay) delete awaitingHookByPty[ptyId];
  // `working` also comes after every tool call and ends an approval wait; only
  // one that follows a finished, interrupted or never-started turn opens a new
  // one. The previous verdict is the raw hook history (`deliveryTurns`, which
  // answering a prompt does not retire), read before it is overwritten and
  // before the interrupted mark is cleared below.
  // So does one that wakes the agent on the work it left running past its Stop:
  // the turn was waiting on that work, not over (`wokenByBackground`).
  const prevTurn = deliveryTurns[ptyId];
  if (state === "working") {
    const prev = prevTurn?.state;
    const resumes =
      ((prev === "working" || prev === "decision") && interruptedByPty[ptyId] === undefined) ||
      wokenByBackground(ptyId, prevTurn);
    if (!resumes || turnStartByPty[ptyId] === undefined) turnStartByPty[ptyId] = at;
  }
  if (state === "done" && job) noteBackgroundWork(ptyId, at);
  // A job's end re-reports `done`; the Stop is the first of the run.
  const stoppedAt = state === "done" ? (prevTurn?.state === "done" ? prevTurn.stoppedAt ?? prevTurn.at : at) : undefined;
  deliveryTurns[ptyId] = { state, at, job, stoppedAt, startedAt: state === "working" ? at : prevTurn?.startedAt };
  // A new turn (or prompt) ends the interrupted mark, and so does the session
  // ending. A `done` does not: after an interrupt Claude's only hook is the
  // idle notice a minute later, which says nothing about the turn that was cut.
  if (state !== "done") delete interruptedByPty[ptyId];
  if (state === "idle") delete turnByPty[ptyId];
  else turnByPty[ptyId] = { state, at, job };
  useActivityStore.getState().recompute();
}

/// How long a keystroke after the agent's Stop is read as "a prompt is going
/// in" before the hooks have their say. A submission is reported by
/// `UserPromptSubmit` within a second or two (hook script, file watcher, one
/// event); a keystroke still unanswered after this long was not one — a draft
/// typed and left in the composer, an arrow key, an Escape that cleared the
/// line — and holding scheduled delivery on it any longer held it forever: the
/// Stop that would release it only follows a turn, and no turn was started.
const INPUT_SUBMIT_GRACE_MS = 20_000;

/** True while a keystroke newer than `after` is still inside the window in
 *  which its submission, if it was one, would have been reported. */
function inputPendingVerdict(ptyId: string, after: number): boolean {
  const input = inputByPty[ptyId];
  return input !== undefined && input > after && Date.now() - input < INPUT_SUBMIT_GRACE_MS;
}

/** The last explicit hook event, even when the display falls back to silence.
 * A stopped session and an interrupted turn are never proof of completion.
 * Fresh input after a Stop reads as the next turn in flight for as long as
 * the hooks would need to confirm it ({@link INPUT_SUBMIT_GRACE_MS}). */
export function agentDeliveryTurn(ptyId: string) {
  const turn = deliveryTurns[ptyId];
  if (turn?.state === "done" && inputPendingVerdict(ptyId, turn.at)) return { ...turn, state: "working" as const };
  return turn;
}

/** Whether automation may type a prompt into the tab. With a hook verdict on
 * record, only the agent's own stable completion opens the gate. Without one —
 * an agent that fires no hooks, or a tab nothing has been asked of yet — the
 * gate waits out the grace after a keystroke and then leaves the call to the
 * bytes (the caller's busy / decision / settle checks), since no Stop is ever
 * going to arrive for such a tab to wait on. */
export function agentDeliveryReady(ptyId: string, stableMs: number): boolean {
  const turn = agentDeliveryTurn(ptyId);
  // A shell the agent left running keeps the gate shut for as long as it runs:
  // the turn is over, but whatever it started is not, and a prompt typed into
  // that tab would land mid-job.
  return turn
    ? turn.state === "done" && !turn.job && Date.now() - turn.at >= stableMs
    : !inputPendingVerdict(ptyId, 0);
}

/** The hook verdict for a PTY, if one stands: absent for a tab with no hooks,
 *  and dropped here once a "working" has outlived all paint (see
 *  `HOOK_WORK_SILENCE_MS`). Test-visible through the store's derived maps. */
function turnVerdict(ptyId: string, now: number): { state: AgentTurnState; at: number; job: boolean } | undefined {
  const turn = turnByPty[ptyId];
  if (!turn) return undefined;
  // A verdict standing over a running job is not one that outlived its turn:
  // the backend polls that shell and says when it exits, so silence under it is
  // expected (a background job paints nothing in the agent's own TUI).
  if (turn.state === "working" && !turn.job) {
    const paintedAt = Math.max(lastRawByPty[ptyId] ?? 0, turn.at);
    if (now - paintedAt >= HOOK_WORK_SILENCE_MS) {
      delete turnByPty[ptyId];
      return undefined;
    }
  }
  return turn;
}

/** True when the bytes alone say the tab is working right now: commanded this
 *  session, painting within the paint window, saying something within the
 *  text window, and that burst of text sustained past the onset debounce. */
function bytesSayWorking(ptyId: string, now: number): boolean {
  const raw = lastRawByPty[ptyId];
  const ts = lastOutputByPty[ptyId];
  const onset = onsetByPty[ptyId];
  return (
    inputByPty[ptyId] !== undefined &&
    raw !== undefined &&
    now - raw < BUSY_WINDOW_MS &&
    ts !== undefined &&
    now - ts < TEXT_GAP_MS &&
    onset !== undefined &&
    now - onset >= WORK_ONSET_MS
  );
}

/** When a PTY last produced output (ms epoch), or undefined if none was seen
 *  this session. Read-only view for the tab hover card's "quiet for…" line —
 *  the raw map stays module-private because it churns per output batch. */
export function lastPtyOutputAt(ptyId: string): number | undefined {
  return lastOutputByPty[ptyId];
}

/** When the tab was last deliberately opened by a person (ms epoch), on either
 *  surface, or undefined if nobody has this session. Read-only view of
 *  `readAtByPty` for the surfaces that must decide "has anyone seen this turn?"
 *  for themselves — the phone's, which cannot infer it from the desktop's
 *  `done` flag (that one is suppressed while the tab is the visible one here). */
export function lastTabReadAt(ptyId: string): number | undefined {
  return readAtByPty[ptyId];
}

/** Record that input was sent to a PTY on the user's behalf — a keystroke, a
 *  paste, a user-triggered flow typing its command (`initialInput`), or a
 *  keystroke a phone sent over the Mobile bridge (`MobileBridgeHost`, which is
 *  told about it because the phone types into a tmux client of its own that this
 *  window never sees). This is
 *  what makes output COUNT: "working" and "done" only ever arise from output
 *  produced after input this session, so a restored tab bursting its resume
 *  banner or replaying a prior transcript — real bytes, but nothing anybody
 *  asked for — never lights up a tab or its project pill. `decision` is exempt:
 *  a resumed agent genuinely sitting at an unanswered prompt is real signal
 *  worth surfacing immediately, commanded or not.
 *
 *  Sending input also drops the tail: answering a prompt is input, and a menu
 *  that has been answered must not be matched again as a live one. This is the
 *  ONLY thing that retires a decision prompt the user is looking at (looking is
 *  no longer enough — see `attentionFor`), and it covers the case the per-burst
 *  reset in `notePtyOutput` misses: an answer so fast that the agent's next
 *  output lands inside the same burst, leaving the answered menu in the tail.
 *
 *  Input also retires a hook verdict it contradicts. Any input answers a
 *  `decision` (the agent's next hook — a finished tool, or Stop — says what
 *  came of it; until then the bytes do). An `interrupt` (a bare Escape,
 *  Ctrl+C) ends a `working` turn that will fire no Stop. Ordinary typing under
 *  a `working` verdict is the next prompt being queued and changes nothing.
 *
 *  An interrupt that lands on a turn in flight — a `working` or `decision`
 *  verdict, or for a tab with no hooks, bytes that read as working — marks the
 *  tab interrupted (see `interruptedByPty`). One on an idle composer (clearing
 *  the line) does not. */
export function noteUserInput(ptyId: string, interrupt = false) {
  // Group B #234: a popout's terminal reports to the classifier that lives in
  // the main window — the popout's own maps are never read by anything.
  if (isDetachedWindow()) {
    void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: interrupt ? "interrupt" : "input" });
    return;
  }
  const now = Date.now();
  const turn = turnVerdict(ptyId, now);
  if (interrupt) {
    const inFlight = turn
      ? turn.state === "working" || turn.state === "decision"
      : bytesSayWorking(ptyId, now);
    if (inFlight) interruptedByPty[ptyId] = now;
  }
  inputByPty[ptyId] = now;
  tailByPty[ptyId] = "";
  if (turn && (turn.state === "decision" || (interrupt && turn.state === "working"))) {
    delete turnByPty[ptyId];
    // The agent's next hook says what came of it (see `awaitingHookByPty`).
    awaitingHookByPty[ptyId] = now;
  }
}

/** Record that a tab's agent session (re)started — its `SessionStart` hook
 *  (`agent-session-roll`): a launch, a resume or a `/clear` puts the CLI at
 *  its composer, so its screen holds no question until a hook says otherwise
 *  (`awaitingHookByPty`). A `compact` can land mid-turn and says nothing. */
export function noteAgentSessionStart(ptyId: string, source: string) {
  if (isDetachedWindow()) return;
  if (!splitPtyId(ptyId)) return;
  if (source !== "startup" && source !== "resume" && source !== "clear") return;
  awaitingHookByPty[ptyId] = Date.now();
  useActivityStore.getState().recompute();
}

/** Record that the tab's previous process left its turn finished (`pty_spawn`'s
 *  `resting`): the resumed — or, under tmux, reattached — agent sits at its
 *  composer, whatever the repaint of its conversation looks like. */
export function noteAgentResting(ptyId: string) {
  if (isDetachedWindow()) {
    void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "resting" });
    return;
  }
  if (!splitPtyId(ptyId)) return;
  awaitingHookByPty[ptyId] = Date.now();
  useActivityStore.getState().recompute();
}

/** Record that the tab's previous process died mid-turn — Tabtivity quit, crashed
 *  or respawned it while its hooks last said `working` or `decision` (the
 *  backend reads the leftover record at spawn: `pty_spawn`'s `interrupted`).
 *  The resumed agent starts out marked interrupted, the same as a turn cut off
 *  by an interrupt key, until its next turn begins. */
export function noteTurnCutOff(ptyId: string) {
  if (isDetachedWindow()) {
    void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "cutoff" });
    return;
  }
  if (!splitPtyId(ptyId)) return;
  interruptedByPty[ptyId] = Date.now();
  useActivityStore.getState().recompute();
}

/** True when a keystroke is the user cutting the agent off: a bare Escape (the
 *  key every agent TUI interrupts on) or Ctrl+C. Arrow keys and other
 *  ESC-prefixed sequences are not bare, and are not. */
export function isInterruptInput(data: string): boolean {
  return data === "\x1b" || data === "\x03";
}

/**
 * Group B #234, the popout side: adopt the statuses the main window mirrored
 * over (`detachedStatusEvent`) into THIS window's activity store, keyed the way
 * `TabBar` reads them, so the popout's strip paints the same lamps. Replaces the
 * whole verdict for `scope`'s keys in `status`; keys of other scopes are kept.
 */
export function applyDetachedStatus(
  scope: string,
  status: Record<
    string,
    "working" | "working-shell" | "working-both" | "needs-decision" | "finished" | "interrupted"
  >,
): void {
  const prefix = `${scope}:`;
  const busyByTab: Record<string, boolean> = {};
  const busyKindByTab: Record<string, BusyKind> = {};
  const attentionByTab: Record<string, AttentionKind> = {};
  const cur = useActivityStore.getState();
  for (const [id, v] of Object.entries(cur.busyByTab)) if (!id.startsWith(prefix)) busyByTab[id] = v;
  for (const [id, v] of Object.entries(cur.busyKindByTab)) {
    if (!id.startsWith(prefix)) busyKindByTab[id] = v;
  }
  for (const [id, v] of Object.entries(cur.attentionByTab)) {
    if (!id.startsWith(prefix)) attentionByTab[id] = v;
  }
  for (const [key, state] of Object.entries(status)) {
    const ptyId = `${prefix}${key}`;
    // The three busy words carry the main window's `BusyKind` across, so a
    // popped-out tab's ring and marks say what the docked one's would.
    if (state.startsWith("working")) {
      busyByTab[ptyId] = true;
      busyKindByTab[ptyId] =
        state === "working-shell" ? "shell" : state === "working-both" ? "both" : "agent";
    } else if (state === "needs-decision") attentionByTab[ptyId] = "decision";
    else if (state === "finished") attentionByTab[ptyId] = "done";
    else if (state === "interrupted") attentionByTab[ptyId] = "interrupted";
  }
  useActivityStore.setState({
    busyByTab,
    busyKindByTab,
    attentionByTab,
    attentionByScope: rollupAttentionScopes(attentionByTab),
  });
}

/** Forget everything recorded about a PTY, called when it is (re)spawned. A
 *  respawn — app launch, a project closed and reopened, a pane remounting — is
 *  a new program: input sent to its predecessor mustn't license the successor's
 *  restore/resume replay as a finished turn. */
export function notePtySpawn(ptyId: string) {
  for (const map of PTY_MAPS) delete map[ptyId];
  decisionMemo.delete(ptyId);
}

// The parser lives in `lib/terminal/ptyId` — one cut for every consumer, and one that
// knows a box scope carries a colon of its own. Re-exported so the call sites
// that have always imported it from here keep working.
export { splitPtyId };

/** True when the tab is the one the user is currently looking at: it's the
 *  active (visible) tab of its group in the CURRENT scope. Background tabs and
 *  background projects are never "looked at". */
function isTabLookedAt(scope: string, key: string): boolean {
  const st = useTabsStore.getState();
  // A tab in a popout is looked at when it is the active tab of its pane there
  // (#234): the popout is its own window, on screen whichever scope the main
  // window shows. Its window focus is not visible from here; the active tab of
  // an unfocused popout is still the one on its screen, which is what "looked
  // at" means for retiring a `done` flag.
  for (const d of st.detachedGroupsByScope[scope] ?? []) {
    for (const g of allGroups(d.subtree)) {
      if (g.tabKeys.includes(key)) return g.activeKey === key;
    }
  }
  if (st.scope !== scope) return false;
  for (const g of allGroups(st.layoutByScope[scope] ?? null)) {
    if (g.tabKeys.includes(key)) return g.activeKey === key;
  }
  return false;
}

// (A `isTabDetached` suppression used to sit here: a popped-out agent raised no
// attention at all, because this window could not tell whether anyone was
// looking at it and a flag it raised would have been unclearable. Group B #234
// answers both — `isTabLookedAt` reads the popout's own active tab, and the
// popout's strip clears the flag over DETACHED_ACTIVITY — so the suppression is
// gone and a popped-out agent lights the project pill like a docked one.)

/** Test-only: forget all recorded PTY activity so cases start isolated. */
export function _clearPtyActivityForTest() {
  for (const map of PTY_MAPS) {
    for (const k of Object.keys(map)) delete map[k];
  }
  decisionMemo.clear();
  useActivityStore.setState({
    busyByScope: {},
    busyByTab: {},
    busyKindByTab: {},
    attentionByTab: {},
    attentionByScope: {},
    statusCountsByScope: {},
    statusTabsByScope: {},
    lastWorkingByTab: {},
    lastDoneByTab: {},
  });
}

/** The kind of attention a tab/scope is raising: an agent waiting on a user
 *  decision (a prompt is on screen), one that simply finished its turn, or one
 *  whose turn the user cut off (`interrupted` — a state, not unread output, so
 *  it is never rolled up into `attentionByScope`). */
export type AttentionKind = "decision" | "done" | "interrupted";

/** What an agent tab is asking for, or null if it isn't asking for anything.
 *  Derived on each `recompute` tick from the tab's own output rather than pushed
 *  in by the terminal: the bell we used to rely on is optional in every agent we
 *  support (and never even reaches xterm for a tab whose pane has not been opened
 *  yet), which left a finished agent showing no state at all.
 *
 *  The two kinds treat "the user is looking at this tab" differently, because
 *  they mean different things:
 *  - `done` is about UNREAD output, so looking at the tab IS the thing that
 *    retires it. A looked-at tab also stamps `seenAtByPty`, so only WORK the
 *    agent does after the user looks away can raise the flag again — a repaint
 *    of a finished screen is not a new turn (see `workAtByPty`).
 *  - `decision` is about a BLOCKED agent, and looking at a prompt does not answer
 *    it. It therefore holds while watched (nothing else in the UI says "this one
 *    is stuck on you" once the tab is on screen but the eyes are elsewhere), and
 *    is retired only by input — `noteUserInput` drops the tail the match is made
 *    against. */
function attentionFor(
  scope: string,
  tab: TabEntry,
  ptyId: string,
  now: number,
  turn: { state: AgentTurnState; at: number; job: boolean } | undefined,
): AttentionKind | null {
  // Only AI agent tabs raise attention; a shell finishing a build doesn't.
  if (tab.kind !== "agent" && tab.kind !== "local_agent") return null;
  // A popped-out agent is classified like any other (#234): its input reaches
  // this window over DETACHED_ACTIVITY, `isTabLookedAt` reads its popout's
  // active tab, and the verdict is mirrored back so the popout's strip shows it.
  const lookedAt = isTabLookedAt(scope, tab.key);
  // What's on screen has been read, so it can't be what raises a "done" later.
  if (lookedAt) seenAtByPty[ptyId] = now;
  const seen = seenAtByPty[ptyId] ?? 0;
  const out = lastOutputByPty[ptyId] ?? 0;
  const bell = bellByPty[ptyId] ?? 0;
  const quiet = now - Math.max(out, bell);
  // A decision is read from the hook where the agent has one for it (Claude's
  // permission notice) AND from the screen regardless: Codex has no such hook,
  // so its approval menu sitting in a quiet tail is still the only sign — even
  // under a "working" verdict, which its tool-use hook left standing while
  // the tool waits on the user. Not after a Stop, though: a finished turn is
  // back at its input box, so nothing on screen can be a pending approval —
  // and what IS on screen is the agent's own reply, which quotes menus (a
  // diff of this very classifier, a report on a prompt) often enough to light
  // a finished tab as a question.
  // Nor while the agent's hooks have the floor (`awaitingHookByPty`): it is at
  // its composer or running what the user just approved, and the screen then
  // holds its conversation, which reads as a menu far too easily.
  if (turn?.state === "decision") return "decision";
  if (
    turn?.state !== "done" &&
    awaitingHookByPty[ptyId] === undefined &&
    quiet >= DECISION_QUIET_MS &&
    tailLooksLikeDecision(ptyId)
  ) {
    return "decision";
  }
  // A cut-off turn is a state of the tab, not output waiting to be read: it
  // holds while watched (the strips leave it off the viewed tab themselves, as
  // they do `done`) and until the agent's next turn begins. It outranks the
  // idle notice's `done`, which is all Claude reports after an interrupt.
  if (interruptedByPty[ptyId] !== undefined) return "interrupted";
  // Past here everything is inferred from silence, which a watched tab's own
  // screen already tells the user better than a lamp could.
  if (lookedAt) return null;
  if ((proposalByPty[ptyId] ?? 0) > seen) return "done";
  // With a hook verdict the question is only whether the finish is unread:
  // Stop fired after the user last had eyes on the tab. A verdict needs no
  // commanded-this-session gate — a restored session's replay fires no Stop.
  // A shell the agent left running is the exception: the turn ended, but the
  // tab is still doing something, and "finished" would be the wrong word for it
  // until that shell exits (it then says so without the agent saying anything).
  if (turn) return turn.state === "done" && !turn.job && turn.at > seen ? "done" : null;
  // The agent has done no work since the user last had eyes on the tab. A
  // repaint, or a bell replayed with one, is not a turn: without a sustained
  // burst after the look there is nothing unread to report.
  if ((workAtByPty[ptyId] ?? 0) <= seen) return null;
  // "Done" means the agent finished work somebody asked for, so it requires
  // input to have been sent this session (see `noteUserInput`): without it, the
  // quiet that follows a restore banner or a resumed session's replayed
  // transcript — and any stray bell replayed with it — would read as a finished
  // turn on every launch. A bell after real input is the agent explicitly
  // asking to be looked at, so it doesn't have to wait out the full silence.
  if (!inputByPty[ptyId]) return null;
  if (bell > seen || quiet >= DONE_QUIET_MS) return "done";
  // Still streaming: the "working" glow already speaks for it.
  return null;
}

/** Roll the per-tab attention flags up to a per-scope kind (decision outranks
 *  done), so the project pill can reflect a backgrounded project's state. */
function rollupAttentionScopes(
  attentionByTab: Record<string, AttentionKind>,
): Record<string, AttentionKind> {
  const byScope: Record<string, AttentionKind> = {};
  for (const [ptyId, kind] of Object.entries(attentionByTab)) {
    if (kind === "interrupted") continue;
    const parts = splitPtyId(ptyId);
    if (!parts) continue;
    if (kind === "decision" || byScope[parts.scope] === undefined) {
      byScope[parts.scope] = kind;
    }
  }
  return byScope;
}

/** True when two attention maps hold the same flags. */
function sameAttention(
  a: Record<string, AttentionKind>,
  b: Record<string, AttentionKind>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** A project's tally of tab statuses — one entry per tab, drawn as one little
 *  bar each along the bottom of the project pill. */
export interface TabStatusCounts {
  working: number;
  decision: number;
  done: number;
  interrupted: number;
}

function sameCounts(a: TabStatusCounts, b: TabStatusCounts): boolean {
  return (
    a.working === b.working &&
    a.decision === b.decision &&
    a.done === b.done &&
    a.interrupted === b.interrupted
  );
}

/** What a busy tab is busy WITH, for the surfaces that paint an agent's own
 *  turn and a running command in different colours:
 *  - `agent`: an agent tab working a turn.
 *  - `shell`: a command and nothing else — a shell tab producing output, or an
 *    agent tab whose turn is over while a shell it started keeps running.
 *  - `both`: an agent working a turn WITH a backgrounded command of its own
 *    running alongside. Two things at once, and the only state drawn with two
 *    marks. (The tool call an agent is waiting on is not one of them: that is
 *    the turn itself, and it is already green.) */
export type BusyKind = "agent" | "shell" | "both";

/** The state class a tab strip puts on a busy tab — the ring's word plus what
 *  the busy is made of: `working` (green, the agent's own turn), `working shell`
 *  (the shell colour: a command and nothing else) or `working job` (green ring,
 *  and a second mark for the command running beside the turn). One helper for
 *  the three strips that draw it (docked, root overlay, popout), so a tab reads
 *  the same wherever it is. A popout mirrored from an older main window, or a
 *  tick that has not classified yet, falls back to the tab's own kind. */
export function busyStateClass(kind: BusyKind | undefined, tabKind: TabEntry["kind"]): string {
  const busy = kind ?? (tabKind === "shell" ? "shell" : "agent");
  return busy === "shell" ? " working shell" : busy === "both" ? " working job" : " working";
}

/** The state class a tab strip puts on an agent tab that is not busy, from its
 *  attention flag (already filtered for the viewed tab by the strip). Shared
 *  by the three strips, like {@link busyStateClass}. */
export function attentionStateClass(attn: AttentionKind | null): string {
  return attn === "decision"
    ? " needs-decision"
    : attn === "done"
      ? " finished"
      : attn === "interrupted"
        ? " interrupted"
        : "";
}

/** One non-idle tab of a scope: WHICH tab a status bar stands for, so the bar
 *  can be clicked to jump to it. The `state` is the bar's own CSS class, i.e.
 *  the same three words the tab glow uses. */
export interface StatusTab {
  /** The tab's key within its scope (not the composed PTY id). */
  key: string;
  state: "working" | "needs-decision" | "finished" | "interrupted";
  /** A tab busy with a COMMAND rather than an agent turn (`BusyKind` "shell").
   *  The bar paints it in its own colour (`--status-shell-working`). A tab doing
   *  both is drawn as the agent it is: one bar cannot say two things, and the
   *  tab's own mark carries the second. */
  shell?: boolean;
}

function sameTabs(a: StatusTab[], b: StatusTab[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.key === b[i].key && t.state === b[i].state && t.shell === b[i].shell);
}

/** True when two per-tab status maps hold the same tabs in the same states.
 *  Relies on `computeStatusScopes` preserving object identity for unchanged
 *  scopes, exactly as `sameCountMaps` does. */
function sameTabMaps(
  a: Record<string, StatusTab[]>,
  b: Record<string, StatusTab[]>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** True when two count maps are equivalent. Relies on `countStatusScopes`
 *  preserving object identity for unchanged scopes, so a per-scope `===` is a
 *  full comparison. */
function sameCountMaps(
  a: Record<string, TabStatusCounts>,
  b: Record<string, TabStatusCounts>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** Tally each scope's tabs by status. A tab counts exactly once: working wins
 *  over a pending attention flag, mirroring how the tab bar resolves its own
 *  glow, so the pill's bars can never disagree with the tabs they stand for.
 *  Every tab counts, including the one under the user's eyes: the pill's strip is
 *  a tally of what the PROJECT is doing, not of what still needs a glance, and a
 *  project whose bars emptied out the moment it was selected could not answer the
 *  one question the strip exists for — "is anything still running in there?" —
 *  for the project you are actually in. (The tab bar shows the viewed tab's
 *  working ring too, but not its `done`.) A looked-at tab that
 *  went quiet can still hold no `done` flag, so what a selected project shows is
 *  its working tabs and its unanswered prompts — see `attentionFor`.
 *  Scopes whose counts are unchanged keep their previous object identity, so a
 *  tab going busy in one project doesn't re-render every other project's pill. */
function computeStatusScopes(
  busyByTab: Record<string, boolean>,
  busyKindByTab: Record<string, BusyKind>,
  attentionByTab: Record<string, AttentionKind>,
  prevCounts: Record<string, TabStatusCounts>,
  prevTabs: Record<string, StatusTab[]>,
): { counts: Record<string, TabStatusCounts>; tabs: Record<string, StatusTab[]> } {
  const { tabsByScope } = useTabsStore.getState();
  const counts: Record<string, TabStatusCounts> = {};
  const byScope: Record<string, StatusTab[]> = {};
  for (const [scope, tabs] of Object.entries(tabsByScope)) {
    const tally: TabStatusCounts = { working: 0, decision: 0, done: 0, interrupted: 0 };
    // Most urgent state first, so the strip's bars and this list are one order —
    // a bar's position IS its tab, which is what makes a click on it addressable.
    const working: StatusTab[] = [];
    const decision: StatusTab[] = [];
    const done: StatusTab[] = [];
    const interrupted: StatusTab[] = [];
    for (const t of tabs) {
      const ptyId = `${scope}:${t.key}`;
      if (isPtyTabKind(t.kind) && busyByTab[ptyId]) {
        tally.working++;
        working.push(
          busyKindByTab[ptyId] === "shell"
            ? { key: t.key, state: "working", shell: true }
            : { key: t.key, state: "working" },
        );
      } else if (attentionByTab[ptyId] === "decision") {
        tally.decision++;
        decision.push({ key: t.key, state: "needs-decision" });
      } else if (attentionByTab[ptyId] === "done") {
        tally.done++;
        done.push({ key: t.key, state: "finished" });
      } else if (attentionByTab[ptyId] === "interrupted") {
        tally.interrupted++;
        interrupted.push({ key: t.key, state: "interrupted" });
      }
    }
    if (!tally.working && !tally.decision && !tally.done && !tally.interrupted) continue;
    const beforeCounts = prevCounts[scope];
    counts[scope] = beforeCounts && sameCounts(beforeCounts, tally) ? beforeCounts : tally;
    const list = [...working, ...decision, ...done, ...interrupted];
    const beforeTabs = prevTabs[scope];
    byScope[scope] = beforeTabs && sameTabs(beforeTabs, list) ? beforeTabs : list;
  }
  return { counts, tabs: byScope };
}

/** True when two string sets hold exactly the same members. */
function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function withoutScript(set: Set<string>, scriptPath: string): Set<string> {
  if (!set.has(scriptPath)) return set;
  const next = new Set(set);
  next.delete(scriptPath);
  return next;
}

interface ActivityStore {
  /** project scope ("root" or project id) → has a running task right now. */
  busyByScope: Record<string, boolean>;
  /** Composed PTY id (`<scope>:<tabKey>`) → that individual tab is actively
   *  producing output right now. Drives the per-tab "working" animation in the
   *  tab bar. */
  busyByTab: Record<string, boolean>;
  /** Composed PTY id → WHAT that tab is busy with ({@link BusyKind}), so the
   *  tab ring, its status mark and the pill's bars can tell an agent's own turn
   *  from a command running in the same tab. Absent wherever `busyByTab` is. */
  busyKindByTab: Record<string, BusyKind>;
  /** Composed PTY id → an agent tab nobody is looking at wants something:
   *  `decision` (a prompt is on its screen) or `done` (it finished its turn).
   *  Derived from the tab's own output by `recompute`; drives the per-tab "needs
   *  attention" glow and clears once the tab is viewed. */
  attentionByTab: Record<string, AttentionKind>;
  /** Per-scope rollup of `attentionByTab` (decision outranks done) so the project
   *  pill can glow for a backgrounded project. */
  attentionByScope: Record<string, AttentionKind>;
  /** Scope → how many of its tabs are working / awaiting a decision / finished.
   *  Drives the per-tab status bars along the bottom of the project pill. Scopes
   *  with nothing to report are absent. */
  statusCountsByScope: Record<string, TabStatusCounts>;
  /** Scope → the same tabs the counts tally, named and in the strip's own order,
   *  so each bar knows which tab it stands for and a click can jump there.
   *  Kept beside the counts rather than derived from them at render: the strip is
   *  drawn from one walk of the tabs, and a second walk in the component could
   *  order the bars differently from the tally they came from. */
  statusTabsByScope: Record<string, StatusTab[]>;
  /** Composed PTY id → when (ms epoch) the tab last produced output while
   *  counted as working. Published on the busy→idle edge only — while a tab IS
   *  busy, `busyByTab` already says "now" — so the Agents views can sort by
   *  "last working" without re-rendering on every output batch. Session-only. */
  lastWorkingByTab: Record<string, number>;
  /** Composed PTY id → when (ms epoch) an agent tab last finished a turn: the
   *  time of its last output before it went quiet for `DONE_QUIET_MS`, marked
   *  whether or not anybody was looking (unlike the `done` attention flag, which
   *  is about UNREAD output and never rises on a watched tab). A decision prompt
   *  counts too — the agent stopped. Session-only. */
  lastDoneByTab: Record<string, number>;
  /** Record a terminal bell from a PTY (`ptyId` is the composed `<scope>:<key>`).
   *  Only a hint that the agent wants attention now — WHAT it wants is worked out
   *  from its output on the next `recompute`, which doesn't race the paint the way
   *  reading the screen inside the bell handler did. */
  noteBell: (ptyId: string) => void;
  /** Clear a tab's attention flag and mark its output read (called the moment the
   *  tab becomes the visible one, ahead of the next `recompute`). */
  clearAttention: (ptyId: string) => void;
  /** Recompute `busyByScope`/`busyByTab`/`attentionByTab` from recent PTY output.
   *  Call on an interval. */
  recompute: () => void;
  /** Absolute paths of `.sh` scripts currently running detached. The run_id
   *  used with the backend is the script's absolute path (see runScript). */
  runningScripts: Set<string>;
  /** Absolute paths of files whose run-launched terminal tab (Python Run/Debug
   *  or a foreground shell run, tagged via `TabEntry.runFile`) is producing
   *  sustained output right now. Derived by `recompute` from `busyByTab`, so it
   *  drops out the moment the tab closes or goes quiet. Drives the green pulse on
   *  the file tree's ▶ run button for the tab-backed run paths (the detached `.sh`
   *  path uses `runningScripts` instead). */
  runningRunFiles: Set<string>;
  /** Spawn a `.sh` script detached and track it so the run button can show a
   *  spinner until the backend emits `script-finished`. `args` is the per-file
   *  argument string from the ▶ popover, parsed by the backend's shell. */
  runScript: (scriptPath: string, cwd: string, projectId?: string | null, args?: string) => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  busyByScope: {},
  busyByTab: {},
  busyKindByTab: {},
  attentionByTab: {},
  attentionByScope: {},
  statusCountsByScope: {},
  statusTabsByScope: {},
  lastWorkingByTab: {},
  lastDoneByTab: {},
  runningScripts: new Set(),
  runningRunFiles: new Set(),

  noteBell: (ptyId) => {
    if (!splitPtyId(ptyId)) return;
    if (isDetachedWindow()) {
      void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "bell" });
      return;
    }
    bellByPty[ptyId] = Date.now();
    get().recompute();
  },

  clearAttention: (ptyId) => {
    // A popout's strip clears a lamp the same way: by telling the main window
    // the tab was looked at. Its own mirrored copy is refreshed by the next
    // status broadcast, which follows the main store's update.
    if (isDetachedWindow()) {
      void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "seen" });
      return;
    }
    seenAtByPty[ptyId] = Date.now();
    readAtByPty[ptyId] = seenAtByPty[ptyId];
    const kind = get().attentionByTab[ptyId];
    if (!kind) return;
    // Looking at a tab marks its output read — but it does not ANSWER a prompt,
    // and the next `recompute` would only raise the flag straight back (see
    // `attentionFor`). Keep it, so the lamp holds steady instead of blinking off
    // and on at the switch. Input is what retires it.
    if (kind === "decision" && tailLooksLikeDecision(ptyId)) return;
    // Nor does it undo an interruption, which is a state rather than unread
    // output (the strips already leave it off the viewed tab).
    if (kind === "interrupted") return;
    const attentionByTab = { ...get().attentionByTab };
    delete attentionByTab[ptyId];
    const status = computeStatusScopes(
      get().busyByTab,
      get().busyKindByTab,
      attentionByTab,
      get().statusCountsByScope,
      get().statusTabsByScope,
    );
    set({
      attentionByTab,
      attentionByScope: rollupAttentionScopes(attentionByTab),
      statusCountsByScope: status.counts,
      statusTabsByScope: status.tabs,
    });
  },

  runScript: (scriptPath, cwd, projectId, args) => {
    set((s) => ({ runningScripts: new Set(s.runningScripts).add(scriptPath) }));
    // `projectId` scopes the backend's path confinement (`run_script_detached`) to
    // the owning project rather than whichever one happens to be current — a file
    // tree in a detached popout is not necessarily showing the active project.
    void invoke("run_script_detached", {
      scriptPath,
      cwd,
      runId: scriptPath,
      projectId: projectId ?? null,
      args: args?.trim() || null,
    })
      .catch(() => {
        set((s) => ({ runningScripts: withoutScript(s.runningScripts, scriptPath) }));
      });
  },

  recompute: () => {
    // A popout classifies nothing (its tabs store is empty — a recompute here
    // would only wipe the statuses the main window mirrored over).
    if (isDetachedWindow()) return;
    const now = Date.now();
    // Seconds of agent work this tick is worth, for the usage recap. Derived from
    // the gap since the last tick rather than assuming the interval, and clamped:
    // a suspended laptop or a stalled interval must not book hours of "agent
    // working time" that never happened.
    const sinceLastTick = lastTickAt === null ? 0 : now - lastTickAt;
    const workedDeltaS =
      sinceLastTick > 0 && sinceLastTick <= MAX_WORK_TICK_MS ? sinceLastTick / 1000 : 0;
    lastTickAt = now;

    const { tabsByScope } = useTabsStore.getState();
    const prevScope = get().busyByScope;
    const prevTab = get().busyByTab;
    const prevKind = get().busyKindByTab;
    const prevAttn = get().attentionByTab;
    const nextScope: Record<string, boolean> = {};
    const nextTab: Record<string, boolean> = {};
    const nextKind: Record<string, BusyKind> = {};
    const nextAttn: Record<string, AttentionKind> = {};
    // Files whose run-launched tab is busy this tick (see `runningRunFiles`).
    // Collected from live tabs only, so a closed/replaced run tab drops out.
    const nextRunFiles = new Set<string>();
    const live = new Set<string>();
    let changed = false;
    // Copied lazily: both maps move rarely (an edge per turn), and an untouched
    // tick must hand the same object back so subscribers do not re-render.
    let nextWorking = get().lastWorkingByTab;
    let nextDone = get().lastDoneByTab;

    for (const [scope, tabs] of Object.entries(tabsByScope)) {
      let scopeBusy = false;
      for (const t of tabs) {
        // PTY output is recorded under the composed id (`<scope>:<tabKey>`, what
        // the backend emits and AppShell feeds in), and tab keys can collide
        // across projects, so every derived map is keyed the same way — a bare
        // key would let one project's agent light another project's pill.
        const ptyId = `${scope}:${t.key}`;
        live.add(ptyId);
        const ts = lastOutputByPty[ptyId];
        const onset = onsetByPty[ptyId];
        const turn = turnVerdict(ptyId, now);
        // A tab with no hooks working again is past its interruption (a hooked
        // one says so itself: `noteAgentTurn`). Before `attentionFor`, so the
        // mark does not outlive the tick that saw the work.
        if (!turn && bytesSayWorking(ptyId, now)) delete interruptedByPty[ptyId];
        // Attention before busy: a menu read off a quiet screen outranks a
        // "working" verdict a tool-use hook left standing (see `attentionFor`),
        // and `computeStatusScopes` lets working win otherwise.
        const attn = attentionFor(scope, t, ptyId, now, turn);
        // Busy = what the tab's own hooks say where they speak; otherwise the
        // bytes — commanded at some point this session (see `noteUserInput`,
        // so restored tabs bursting resume banners on launch never read as
        // "working"), painting and saying something right now, and the text
        // sustained past the onset debounce (so a lone blip never registers).
        const agentBusy = turn
          ? turn.state === "working" && attn !== "decision"
          : bytesSayWorking(ptyId, now);
        // A command the agent backgrounded keeps the tab busy on its own: the
        // turn may be over, but the tab is still running something (this is
        // what used to reach the window as a held "working" verdict, before the
        // two facts were reported apart).
        const jobBusy = !!turn?.job;
        const tabBusy = agentBusy || jobBusy;
        if (tabBusy) {
          nextTab[ptyId] = true;
          // A shell tab is a command by definition; an agent tab is one when a
          // shell of its own is running, and BOTH when it is also working.
          nextKind[ptyId] =
            t.kind === "shell" ? "shell" : jobBusy ? (agentBusy ? "both" : "shell") : "agent";
          scopeBusy = true;
          // A run-launched tab (Python Run/Debug, foreground shell run) pulses
          // its source file's ▶ run button while it produces output. Busy-gated,
          // so a restored-but-quiet run tab never lights up.
          if (t.runFile) nextRunFiles.add(t.runFile);
        }
        if ((prevTab[ptyId] ?? false) !== tabBusy) changed = true;
        // The kind can move while "busy" stands still — a turn ending over a
        // job that keeps running is the case this whole flag exists for.
        if (prevKind[ptyId] !== nextKind[ptyId]) changed = true;
        if (turn) {
          // A turn's end is the hook's Stop (or the decision it paused on),
          // exact to the moment it was received: that is when the tab was last
          // working and when it last finished. Marked once per verdict.
          if (
            (turn.state === "done" || turn.state === "decision") &&
            agentPromptLeaf(t) &&
            nextDone[ptyId] !== turn.at
          ) {
            if ((nextWorking[ptyId] ?? 0) < turn.at) {
              if (nextWorking === get().lastWorkingByTab) nextWorking = { ...nextWorking };
              nextWorking[ptyId] = turn.at;
            }
            if (nextDone === get().lastDoneByTab) nextDone = { ...nextDone };
            nextDone[ptyId] = turn.at;
          }
        } else if (tabBusy) {
          // The first busy tick since the last finished turn starts a new one,
          // dated from the burst that made it read as work.
          if (!busySinceMarkByPty[ptyId]) turnStartByPty[ptyId] = onset ?? now;
          busySinceMarkByPty[ptyId] = true;
        } else if (ts !== undefined && inputByPty[ptyId] !== undefined) {
          // Was the burst that just ended work? Either a tick saw it busy, or
          // — a tick can miss a burst that ended between two of them — the
          // burst itself lasted past the onset debounce. A lone blip is neither.
          const worked =
            busySinceMarkByPty[ptyId] || (onset !== undefined && ts - onset >= WORK_ONSET_MS);
          if (worked && nextWorking[ptyId] !== ts) {
            // The last output of the burst is when this tab was last seen working.
            if (nextWorking === get().lastWorkingByTab) nextWorking = { ...nextWorking };
            nextWorking[ptyId] = ts;
          }
          if (worked && now - ts >= DONE_QUIET_MS && agentPromptLeaf(t) && nextDone[ptyId] !== ts) {
            // Quiet long enough after work to call the turn finished — the same
            // silence `attentionFor` waits out, but marked for every tab, watched
            // or not.
            busySinceMarkByPty[ptyId] = false;
            if (nextDone === get().lastDoneByTab) nextDone = { ...nextDone };
            nextDone[ptyId] = ts;
          }
        }

        if (attn) nextAttn[ptyId] = attn;

        // ── Usage recap ────────────────────────────────────────────────────
        // The busy/attention state this tick is already the truth about what the
        // agents are doing; the recap just needs it accumulated rather than only
        // rendered. Only agent tabs count — a busy shell is the user working, not
        // an agent.
        if (agentPromptLeaf(t)) {
          if (tabBusy && workedDeltaS > 0) {
            // Agent-seconds: two agents working in parallel for a minute is two
            // agent-minutes. That is the quantity worth reporting.
            bumpUsage(scope, METRIC.AGENT_WORKED_S, workedDeltaS);
          }
          // Count the EDGE, not the state: an agent sitting on a decision prompt
          // for ten ticks stopped to ask once, not ten times.
          if (attn && attn !== "interrupted" && prevAttn[ptyId] !== attn) {
            bumpUsage(
              scope,
              attn === "decision" ? METRIC.AGENT_DECISION : METRIC.AGENT_DONE,
            );
          }
        }
      }
      if (scopeBusy) nextScope[scope] = true;
      if ((prevScope[scope] ?? false) !== scopeBusy) changed = true;
    }
    // A scope/tab that was busy and is now gone or idle also counts as a change.
    for (const scope of Object.keys(prevScope)) {
      if (!(scope in nextScope) && prevScope[scope]) changed = true;
    }
    for (const tab of Object.keys(prevTab)) {
      if (!(tab in nextTab) && prevTab[tab]) changed = true;
    }
    // Closed tabs would otherwise keep their output history (and their tail)
    // forever, and hand it back to whatever tab next reuses the key.
    for (const map of PTY_MAPS) {
      for (const ptyId of Object.keys(map)) {
        if (!live.has(ptyId)) delete map[ptyId];
      }
    }
    for (const ptyId of decisionMemo.keys()) {
      if (!live.has(ptyId)) decisionMemo.delete(ptyId);
    }
    for (const ptyId of Object.keys(nextWorking)) {
      if (live.has(ptyId)) continue;
      if (nextWorking === get().lastWorkingByTab) nextWorking = { ...nextWorking };
      delete nextWorking[ptyId];
    }
    for (const ptyId of Object.keys(nextDone)) {
      if (live.has(ptyId)) continue;
      if (nextDone === get().lastDoneByTab) nextDone = { ...nextDone };
      delete nextDone[ptyId];
    }
    const workingChanged = nextWorking !== get().lastWorkingByTab;
    const doneChanged = nextDone !== get().lastDoneByTab;

    const attnChanged = !sameAttention(prevAttn, nextAttn);
    const prevCounts = get().statusCountsByScope;
    const prevStatusTabs = get().statusTabsByScope;
    const status = computeStatusScopes(nextTab, nextKind, nextAttn, prevCounts, prevStatusTabs);
    const nextCounts = status.counts;
    // The tally can move even when no tab flipped busy — a tab carrying an
    // attention flag was closed, say — so it gates the publish independently.
    const countsChanged = !sameCountMaps(prevCounts, nextCounts);
    // The per-tab list can move while the tally stands still: one tab going quiet
    // as another goes busy keeps "1 working" true but changes WHICH tab the bar
    // aims at, so it gates its own publish.
    const statusTabsChanged = !sameTabMaps(prevStatusTabs, status.tabs);
    // The run-file set can move independently of `busyByTab` — a run tab going
    // busy flips both, but a run tab closing while still "busy" drops out here
    // via `live` even if some other tab keeps the same busy tally — so gate it
    // on its own comparison, same as the other maps.
    const runFilesChanged = !sameStringSet(get().runningRunFiles, nextRunFiles);
    if (
      !changed &&
      !attnChanged &&
      !countsChanged &&
      !statusTabsChanged &&
      !runFilesChanged &&
      !workingChanged &&
      !doneChanged
    )
      return;
    // Only re-publish the maps that actually moved: every tab bar subscribes to
    // the whole `busyByTab` object, so handing it a fresh-but-equal one on each
    // interval tick would re-render them all for nothing.
    set({
      ...(changed ? { busyByScope: nextScope, busyByTab: nextTab, busyKindByTab: nextKind } : {}),
      ...(attnChanged
        ? { attentionByTab: nextAttn, attentionByScope: rollupAttentionScopes(nextAttn) }
        : {}),
      ...(countsChanged ? { statusCountsByScope: nextCounts } : {}),
      ...(statusTabsChanged ? { statusTabsByScope: status.tabs } : {}),
      ...(runFilesChanged ? { runningRunFiles: nextRunFiles } : {}),
      ...(workingChanged ? { lastWorkingByTab: nextWorking } : {}),
      ...(doneChanged ? { lastDoneByTab: nextDone } : {}),
    });
  },
}));

// App-lifetime listener: clears the run animation when a detached script
// finishes (run_id is the script's absolute path). Lives in the store rather
// than in FileTree so the run state survives side-panel hide/show, which
// unmounts the tree — see TODO group R #34. Guarded so non-Tauri contexts
// (e.g. unit tests, where the IPC bridge is absent) don't throw on import.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  try {
    // `Promise.resolve` rather than a bare `.catch`: this module is imported
    // (transitively) by suites that stub the event module with a plain `vi.fn()`,
    // whose `undefined` return would throw HERE, at import time, and take the
    // whole suite down before a single test ran. A store's module scope must not
    // be able to fail on the shape of somebody else's mock.
    void Promise.resolve(
      listen<{ runId: string; success: boolean }>("script-finished", (e) => {
        useActivityStore.setState((s) => ({
          runningScripts: withoutScript(s.runningScripts, e.payload.runId),
        }));
      }),
    ).catch(() => {});
  } catch {
    /* no IPC bridge (tests) */
  }
}

/** What an agent tab is doing right now, in the three words a markup pill
 *  needs (`mobile-web/src/markup/submitState.ts`'s `AgentSignal`). */
export type AgentTabState = "working" | "question" | "idle";

/** An agent tab's live state off this store's lamps: its busy flag, then a
 *  decision prompt waiting on it. Pure over the two maps, so a component can
 *  select it (`useActivityStore((s) => agentTabStateOf(s, ptyId))`). */
export function agentTabStateOf(
  state: { busyByTab: Record<string, boolean>; attentionByTab: Record<string, AttentionKind> },
  ptyId: string,
): AgentTabState {
  if (state.busyByTab[ptyId]) return "working";
  if (state.attentionByTab[ptyId] === "decision") return "question";
  return "idle";
}

/** {@link agentTabStateOf} on the store as it is now — for the phone's agent
 *  status (`MobileBridgeHost`) and the desktop markup mode's Submit. */
export function agentTabState(ptyId: string): AgentTabState {
  return agentTabStateOf(useActivityStore.getState(), ptyId);
}
