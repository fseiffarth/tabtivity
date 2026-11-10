/**
 * Steering's digits on a tab whose agent waits on a question: 1–9 answer the
 * dialog on its screen directly — the permission prompt, an agent's own
 * question, a picker the session opened — instead of opening agent N beside
 * it. The screen is read as the Reader reads it (`readReaderLive`), and the
 * answer goes in as the Reader's tapped row does (`answerKeys`, typed paced by
 * `typePaneKeys`), so no box opens in between.
 *
 * Claude Code's free-text row ("Type something") takes words, not a pick: its
 * digit walks the highlight onto it and gives the keyboard to the terminal.
 *
 * Once answered, `settleAfterAnswer` watches the screen: the dialog gone means
 * the tab stopped asking (steering may go back where it came from); another
 * dialog — the next question of the same ask, a new permission — means it
 * still asks.
 */
import { terminalFor } from "../terminal/terminalRegistry";
import { answerKeys, freeTextRow, readReaderLive, UNNUMBERED } from "../agents/readerLive";
import { typePaneKeys } from "../agents/paneKeys";
import { selectMoveKeys, type SelectOption, type SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import { agentTabLabel } from "../../stores/agents/agentModels";
import { useActivityStore } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";

/** What a digit did on the active tab. */
export type SteeringAnswer =
  /** The row was picked; `signature` names the dialog it answered. */
  | { kind: "answered"; ptyId: string; agentLabel: string; signature: string; typed: Promise<void> }
  /** The free-text row: the highlight is on it, the terminal should type. */
  | { kind: "freeText"; ptyId: string; typed: Promise<void> }
  /** A dialog is up but has no row by that number (or an answer to it is on
   *  its way): the key is spent, nothing else happens. */
  | { kind: "ignored" }
  /** No dialog: the digit keeps its other meaning (agent N). */
  | { kind: "none" };

function isAgentTab(tab: TabEntry): boolean {
  return tab.kind === "agent" || tab.kind === "local_agent";
}

interface LiveQuestion {
  ptyId: string;
  agentLabel: string;
  question: SelectPrompt;
  signature: string;
}

/** An answer typed but not yet taken by the session, per pane: the same dialog
 *  is not answered twice by a quick second press. */
const inFlight = new Map<string, { signature: string; until: number }>();
const IN_FLIGHT_MS = 1500;

function liveQuestion(scope: string, tab: TabEntry): LiveQuestion | null {
  if (!isAgentTab(tab)) return null;
  const ptyId = `${scope}:${tab.key}`;
  const term = terminalFor(ptyId);
  if (!term) return null;
  const agentLabel = agentTabLabel(tab);
  const live = readReaderLive(term.buffer.active, agentLabel, term.cols);
  return live.question ? { ptyId, agentLabel, question: live.question, signature: live.signature } : null;
}

/** Whether the active tab is asking: a dialog on its screen, or its agent's
 *  turn waiting on a decision (the state Q jumps to). What the legend lists
 *  "Answer" by. */
export function steeringTabAsks(scope: string, tab: TabEntry | null | undefined): boolean {
  if (!tab || !isAgentTab(tab)) return false;
  if (useActivityStore.getState().attentionByTab[`${scope}:${tab.key}`] === "decision") return true;
  return liveQuestion(scope, tab) !== null;
}

/** The row digit `n` picks: the one printed with that number; on a dialog
 *  that prints none, the nth row. */
export function optionForDigit(question: SelectPrompt, n: number): SelectOption | null {
  const numbered = question.options.find((option) => option.number === n);
  if (numbered) return numbered;
  if (question.options.every((option) => option.number === UNNUMBERED)) return question.options[n - 1] ?? null;
  return null;
}

/** Answer the active tab's dialog with row `n` (1–9). */
export function answerSteeringQuestion(scope: string, tab: TabEntry, n: number): SteeringAnswer {
  const live = liveQuestion(scope, tab);
  if (!live) return rawDigit(scope, tab, n);
  const { ptyId, question, signature } = live;
  const held = inFlight.get(ptyId);
  if (held && held.signature === signature && held.until > Date.now()) return { kind: "ignored" };
  const option = optionForDigit(question, n);
  if (!option) return { kind: "ignored" };
  if (freeTextRow(option) && !option.keys) {
    const typed = typePaneKeys(ptyId, selectMoveKeys(question.current, option.index));
    return { kind: "freeText", ptyId, typed };
  }
  const keys = answerKeys(question, option);
  if (keys.length === 0) return { kind: "ignored" };
  inFlight.set(ptyId, { signature, until: Date.now() + IN_FLIGHT_MS });
  const typed = typePaneKeys(ptyId, keys);
  return { kind: "answered", ptyId, agentLabel: live.agentLabel, signature, typed };
}

/** A tab whose turn waits on a decision while its screen reads as no dialog
 *  (a shape the reader does not know, a pane not redrawn yet): the digit goes
 *  in as typed — the CLIs' own dialogs take a row's number as its pick. */
function rawDigit(scope: string, tab: TabEntry, n: number): SteeringAnswer {
  const ptyId = `${scope}:${tab.key}`;
  if (!isAgentTab(tab) || !terminalFor(ptyId)) return { kind: "none" };
  if (useActivityStore.getState().attentionByTab[ptyId] !== "decision") return { kind: "none" };
  const held = inFlight.get(ptyId);
  if (held && held.until > Date.now()) return { kind: "ignored" };
  inFlight.set(ptyId, { signature: "", until: Date.now() + IN_FLIGHT_MS });
  return { kind: "answered", ptyId, agentLabel: agentTabLabel(tab), signature: "", typed: typePaneKeys(ptyId, [String(n)]) };
}

/** Polls of the screen after an answer, and how far apart. */
const SETTLE_POLLS = 10;
const SETTLE_GAP_MS = 300;

/**
 * Whether the pane stopped asking once `answered` (the dialog `signature`) was
 * typed: "cleared" when no dialog is on its screen two polls running, "asking"
 * when another one is (or the same one never went away within ~3 s).
 */
export async function settleAfterAnswer(ptyId: string, agentLabel: string, signature: string): Promise<"cleared" | "asking"> {
  let empty = 0;
  for (let i = 0; i < SETTLE_POLLS; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_GAP_MS));
    const term = terminalFor(ptyId);
    if (!term) return "asking";
    const live = readReaderLive(term.buffer.active, agentLabel, term.cols);
    // A digit typed blind (`rawDigit`, no signature) never saw the dialog, so
    // its going is told by the turn no longer waiting on a decision.
    const waits = !signature && useActivityStore.getState().attentionByTab[ptyId] === "decision";
    if (!live.question && !waits) {
      empty += 1;
      if (empty >= 2) {
        inFlight.delete(ptyId);
        return "cleared";
      }
      continue;
    }
    empty = 0;
    if (live.question && live.signature !== signature) {
      inFlight.delete(ptyId);
      return "asking";
    }
  }
  inFlight.delete(ptyId);
  return "asking";
}
