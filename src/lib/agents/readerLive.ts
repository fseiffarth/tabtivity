import { agentWork, type WorkFacts } from "../../../mobile-web/src/terminal/agentBusy";
import { isLiveEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { questionParts } from "../../../mobile-web/src/terminal/questionParts";
import {
  questionTabKeys,
  readReviewStep,
  readSelectPrompt,
  selectKeys,
  selectSignature,
  type QuestionStepKeys,
  type QuestionTab,
  type SelectOption,
  type SelectPrompt,
} from "../../../mobile-web/src/terminal/selectPrompt";
import { isOpenCodeTab, openCodePickKeys, readOpenCodePicker } from "../../../mobile-web/src/terminal/openCodeMini";
import { inputFrameStart, sessionStatus, type SessionStatus } from "../../../mobile-web/src/terminal/statusLine";

/**
 * What the desktop Reader (`TerminalReaderView`) reads off the pane's live
 * screen, which the stored transcript cannot carry: a choice the session is
 * waiting on (a permission prompt, a question, a picker) and whether the agent
 * is working right now. The phone's Focus reads the same two things the same
 * way (`mobile-web/src/screens/Terminal.tsx`: `liveTail`, `liveQuestion`,
 * `sessionWork`) — this is that reading over the xterm buffer, so a beginner
 * can answer and stop the agent without leaving the chat.
 */
export interface ReaderLive {
  /** The dialog on screen, when one is recognized (`readSelectPrompt`). */
  question: SelectPrompt | null;
  /** Its own question — the text right above its rows, with the TUI's word
   * wrap undone (`questionParts`): one entry per paragraph or kept break. */
  ask: string[];
  /** What it was drawn onto: a permission dialog's file or diff, as drawn.
   * Empty for an agent's own question — its message above is already the
   * conversation's last turn. */
  context: string[];
  /** An agent's own question's headers (Claude Code's tab row), as chips. */
  tabs: QuestionTab[];
  /** The step of `tabs` on screen: an index into it, `tabs.length` for the
   * Submit step, null when the row does not say (`questionTabFocus`). */
  tabFocus: number | null;
  /** Whether the tab row ends in a Submit step. */
  tabSubmit: boolean;
  /** Which keys walk the steps: Claude Code's ←/→, Codex's PageUp/PageDown. */
  tabKeys: QuestionStepKeys;
  /** Identifies the dialog step, so one answer is not sent twice. */
  signature: string;
  /** The busy row's facts while the agent works; null when idle or asking. */
  working: WorkFacts | null;
  /** The facts the session prints under its input box (model, branch,
   * context, mode) — the phone's facts row reads the same `sessionStatus`.
   * Null while the bottom of the screen is not the input frame. */
  status: SessionStatus | null;
}

export const NO_LIVE: ReaderLive = {
  question: null, ask: [], context: [], tabs: [], tabFocus: null, tabSubmit: false, tabKeys: "arrows", signature: "", working: null, status: null,
};

/** Reads `buffer` (the pane's active xterm buffer, `columns` wide) for
 * `agentLabel`'s TUI. */
export function readReaderLive(buffer: ReadableBufferLike, agentLabel: string, columns?: number): ReaderLive {
  const { lines } = readableScreen(buffer);
  const status = sessionStatus(lines, agentLabel);
  // The input box and the rows under it are the TUI's frame, not output; the
  // tail after the last echoed prompt is what the session draws now.
  const screen = lines.slice(0, inputFrameStart(lines, agentLabel));
  let start = 0;
  screen.forEach((line, index) => { if (isLiveEcho(line, agentLabel)) start = index + 1; });
  const tail = screen.slice(start);
  const question = tail.length > 0 ? readSelectPrompt(tail, agentLabel, columns) ?? readReviewStep(tail, agentLabel) : null;
  if (question) {
    const parts = questionParts(tail, question);
    const ask = parts.ask.map((line) => line.text.trimEnd());
    return {
      question,
      ask,
      // Under a tab row the context is the agent's message, the
      // conversation's last turn already; Codex's (no row) says why it asks.
      context: parts.tabs.length > 0 && parts.tabKeys !== "pages" ? [] : parts.context.map((line) => line.text.trimEnd()),
      tabs: parts.tabs,
      tabFocus: parts.tabFocus,
      tabSubmit: parts.tabSubmit,
      tabKeys: parts.tabKeys,
      // Two questions of one dialog can offer the same rows (two yes/no
      // questions): the step they are on tells them apart.
      signature: parts.tabs.length > 0
        ? [selectSignature(question), tabsKey(parts.tabs), `@${parts.tabFocus ?? ""}`, ...ask].join("\n")
        : selectSignature(question),
      working: null,
      status,
    };
  }
  return { ...NO_LIVE, working: agentWork(lines), status };
}

function tabsKey(tabs: readonly QuestionTab[]): string {
  return tabs.map((tab) => `${tab.answered ? "✓" : "☐"}${tab.label}`).join("\n");
}

/** Whether two readings would draw the same: the Reader re-renders only then. */
export function sameReaderLive(a: ReaderLive, b: ReaderLive): boolean {
  return a.signature === b.signature
    && a.ask.join("\n") === b.ask.join("\n")
    && a.context.join("\n") === b.context.join("\n")
    && tabsKey(a.tabs) === tabsKey(b.tabs)
    && a.tabFocus === b.tabFocus
    && a.tabSubmit === b.tabSubmit
    && a.tabKeys === b.tabKeys
    && (a.working === null) === (b.working === null)
    && a.working?.elapsed === b.working?.elapsed
    && a.working?.tokens === b.working?.tokens
    && a.working?.effort === b.working?.effort
    && sameStatus(a.status, b.status);
}

function sameStatus(a: SessionStatus | null, b: SessionStatus | null): boolean {
  if (!a || !b) return a === b;
  return a.model === b.model && a.effort === b.effort && a.branch === b.branch
    && a.context === b.context && a.mode === b.mode;
}

/**
 * The model picker the Reader's model chip opened (`/model`, or OpenCode's
 * palette), read off the whole screen: the picker replaces the input box, so
 * it is not in the part `readReaderLive` reads. The phone's model sheet reads
 * it the same way — the session's own rows, not a list Tabtivity believes in.
 */
export function readModelPicker(buffer: ReadableBufferLike, agentLabel: string): SelectPrompt | null {
  const { lines } = readableScreen(buffer);
  return isOpenCodeTab(agentLabel) ? readOpenCodePicker(lines) : readSelectPrompt(lines, agentLabel);
}

/** The keys that answer the picker with `option`: OpenCode's is answered by
 * typing into its search field, every other one by walking its highlight. */
export function modelPickKeys(picker: SelectPrompt, option: SelectOption, agentLabel: string): string[] {
  return isOpenCodeTab(agentLabel) ? openCodePickKeys(option.label) : selectKeys(picker.current, option.index);
}

/** The keystrokes that answer `question` with `option`: arrows from the
 * highlighted row, then Enter — what the phone sends for a tapped row. */
export function answerKeys(question: SelectPrompt, option: SelectOption): string[] {
  return selectKeys(question.current, option.index);
}

/** The keys that move `live`'s several-question dialog from step `from` to
 * step `to` — Claude Code's ←/→, Codex's PageUp/PageDown; the answers given
 * so far stay, so one can be changed before it is sent. */
export function tabStepKeys(live: Pick<ReaderLive, "tabKeys">, from: number, to: number): string[] {
  return questionTabKeys(from, to, live.tabKeys);
}

/** Esc: the key Claude Code, Codex and OpenCode stop a running turn with. */
export const STOP_KEY = "\u001b";
