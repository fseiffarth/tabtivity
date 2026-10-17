import { agentWork, type WorkFacts } from "../../../mobile-web/src/terminal/agentBusy";
import { isLiveEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { questionParts } from "../../../mobile-web/src/terminal/questionParts";
import {
  answerRowKeys,
  freeTextRow,
  freeTextWrites,
  questionTabKeys,
  readCodexHooksPage,
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
  /** The screen shows something none of the above reads: no dialog, no busy
   * row and no input box at its bottom, yet it is not blank — a picker, an
   * error or a screen of the CLI's own the chat cannot draw. The Reader
   * points at the terminal once this lasts (`STRAY_MS`). */
  stray: boolean;
}

export const NO_LIVE: ReaderLive = {
  question: null, ask: [], context: [], tabs: [], tabFocus: null, tabSubmit: false, tabKeys: "arrows", signature: "", working: null, status: null, stray: false,
};

/** Rows read off the end of the buffer for the live reading. What it looks
 * for — a dialog, the busy row, the status line — sits at the bottom of the
 * screen, below the last echoed prompt; the whole `MAX_ROWS` (1200) was read
 * cell by cell on every settled write for a tail a few dozen rows long.
 * Deliberately not the viewport: a dialog drawn under a long answer is still
 * found, and the phone reads the same tail. */
export const READER_ROWS = 300;

/** Reads `buffer` (the pane's active xterm buffer, `columns` wide) for
 * `agentLabel`'s TUI. */
export function readReaderLive(buffer: ReadableBufferLike, agentLabel: string, columns?: number): ReaderLive {
  const { lines } = readableScreen(buffer, READER_ROWS);
  const status = sessionStatus(lines, agentLabel);
  // The input box and the rows under it are the TUI's frame, not output; the
  // tail after the last echoed prompt is what the session draws now.
  const frameStart = inputFrameStart(lines, agentLabel);
  const screen = lines.slice(0, frameStart);
  let start = 0;
  screen.forEach((line, index) => { if (isLiveEcho(line, agentLabel)) start = index + 1; });
  // Codex's hooks page replaces the input box, whose `›` its highlighted row
  // reads as: it is read off the whole screen.
  const hooksPage = readCodexHooksPage(lines, agentLabel);
  const tail = hooksPage ? lines : screen.slice(start);
  const question = hooksPage ?? (tail.length > 0 ? readSelectPrompt(tail, agentLabel, columns) ?? readReviewStep(tail, agentLabel) : null);
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
      stray: false,
    };
  }
  const working = agentWork(lines);
  // `inputFrameStart` answers the screen's length when it finds no input box
  // (or the box-like row is a dialog's highlighted option).
  const stray = !working && frameStart >= lines.length && lines.some((line) => line.text.trim() !== "");
  return { ...NO_LIVE, working, status, stray };
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
    && a.stray === b.stray
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
  const { lines } = readableScreen(buffer, READER_ROWS);
  return isOpenCodeTab(agentLabel) ? readOpenCodePicker(lines) : readSelectPrompt(lines, agentLabel);
}

/** The keys that answer the picker with `option`: OpenCode's is answered by
 * typing into its search field, every other one by walking its highlight. */
export function modelPickKeys(picker: SelectPrompt, option: SelectOption, agentLabel: string): string[] {
  return isOpenCodeTab(agentLabel) ? openCodePickKeys(option.label) : selectKeys(picker.current, option.index);
}

/** The keystrokes that answer `question` with `option`: arrows from the
 * highlighted row, then Enter — or the row's own keys (`answerRowKeys`) —
 * what the phone sends for a tapped row.
 *
 * None for Claude Code's free-text row (`freeTextRow`): Enter on its empty
 * field does not pick it, it turns the whole question down ("User declined to
 * answer questions", 2.1.288). That row is answered with words
 * (`answerTextKeys`). */
export function answerKeys(question: SelectPrompt, option: SelectOption): string[] {
  if (freeTextRow(option)) return [];
  return answerRowKeys(question, option);
}

/** The keystrokes that answer `question`'s free-text row with `text` — the
 * phone's (`freeTextWrites`). None for blank words. */
export function answerTextKeys(question: SelectPrompt, option: SelectOption, text: string): string[] {
  return freeTextRow(option) ? freeTextWrites(question.current, option, text) : [];
}

export { freeTextRow };

/** The keys that move `live`'s several-question dialog from step `from` to
 * step `to` — Claude Code's ←/→, Codex's PageUp/PageDown; the answers given
 * so far stay, so one can be changed before it is sent. */
export function tabStepKeys(live: Pick<ReaderLive, "tabKeys">, from: number, to: number): string[] {
  return questionTabKeys(from, to, live.tabKeys);
}

/** Esc: the key Claude Code, Codex and OpenCode stop a running turn with. */
export const STOP_KEY = "\u001b";
