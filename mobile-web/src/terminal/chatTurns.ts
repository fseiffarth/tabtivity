/**
 * Groups the reading view's lines into the turns of a conversation, so an
 * agent tab reads like a chat: the agent's answers on the left, the prompts
 * the user submitted on the right.
 *
 * This is the one place Focus reads a *shape* out of session text, and it is
 * kept to the shapes every agent TUI shares. When a prompt is submitted, the
 * TUI echoes it back into the transcript with its own input marker in
 * front — `> fix the tests` in Claude Code and Gemini CLI / Qwen Code (whose
 * box frame `readableScreen` has already stripped), `› fix the tests` in
 * Codex — at the left edge, with the lines of a multi-line prompt indented
 * under it. Nothing else the TUIs print starts a line that way: answers open
 * with `⏺`, `•` or `✦` and indent their continuation, tool calls with `⎿`,
 * and a quoted `>` inside an answer sits indented under its bullet.
 *
 * A bubble must hold what the user typed and **nothing else**, so each
 * look-alike is excluded, and a doubtful row is dropped from the bubble
 * rather than shown as the reader's own words:
 *   - a select dialog's `❯ 1. Yes` row, by its number — and `❯` is not a
 *     marker here at all, see `PROMPT_ECHO`;
 *   - the box's own placeholder (`> Try "…"`), which is the empty box, not an
 *     echo;
 *   - a box the TUI is still drawing, told by the footer row pinned under it.
 *     Only the live tail is cut by `inputFrameStart`; a frame left behind in
 *     the scrollback reaches a history chunk whole;
 *   - the rows a prompt's indent cannot mean: a tool result's `⎿`/`└` gutter,
 *     a bullet, a frame stroke, an indented footer. `CONTINUATION` used to
 *     swallow every indented row under an echo, so `> /model` took the
 *     `⎿ Set model to …` under it into the bubble.
 *
 * The second shape is an agent's message bullet — Claude Code's here, and the
 * `●`/`✦`/`◆︎` Kimi Code, Gemini CLI and Qwen Code open an answer with, which
 * earn the same answer layout (their tool calls are not dropped: only Claude
 * Code's shapes below are known well enough to leave out). Everything Claude
 * prints between two prompts opens with `⏺`: an answer as `⏺ The tests pass.`, and
 * a tool call as `⏺ Update(src/App.tsx)` — a capitalised tool name and its
 * argument in parentheses — with the call's status rows (`⎿ Updated
 * src/App.tsx with 3 additions`, a read's line count, a command's output)
 * indented under it. On a phone the answer is what is wanted and the
 * edit-by-edit status beside it is noise, so each `⏺` message is one agent
 * turn and a tool call, status rows included, is left out of the layout.
 * Only those exact shapes are dropped — a capitalised name followed directly
 * by `(`, or an MCP tool's `server - tool (MCP)` — and a permission dialog
 * under a tool call sits at the left edge,
 * which ends the call's block, so a question the session is waiting on is
 * still shown.
 *
 * A turn is a grouping for layout only: the lines keep their keys, their
 * text and the styles the program emitted, and Copy still copies the
 * transcript as it was printed, markers and tool rows included.
 */

import type { ReadableLine, ReadableSpan } from "./readableScreen";
import { columnCount, statusColumns } from "./statusLine";
import {
  isOpenCodeBanner,
  isOpenCodeTab,
  isOpenCodeToolRow,
  joinOpenCodeWraps,
  openCodeBlockEnd,
  openCodeTurnFooter,
} from "./openCodeMini";
import { radioMarkerAgent } from "./selectPrompt";

export interface ChatTurn {
  /** The key of the turn's first line — stable across frames the same way. */
  key: string;
  role: "user" | "agent";
  /** The lines as printed. */
  lines: readonly ReadableLine[];
  /** A user turn's lines with the echo marker and its indent removed — what
   * the bubble shows. Absent on an agent turn. */
  prompt?: readonly ReadableLine[];
  /** A Claude answer's lines with the `⏺` marker and its indent removed —
   * what the turn shows. Absent on any other agent turn, which shows `lines`. */
  answer?: readonly ReadableLine[];
}

/** The echoed prompt: the input marker at the left edge (at most one space
 * of frame padding before it), a space, then text. A bare marker is an empty
 * input box, not a prompt.
 *
 * `❯` is deliberately not one of the markers. No CLI in the survey echoes a
 * submitted prompt with it — Claude Code, Gemini CLI, Qwen Code, Aider and
 * Goose echo `>`, Codex `›`, Kimi Code `✨` — while `❯` *is* the highlight
 * cursor a select dialog draws (`selectPrompt`'s `OPTION` lists it first), so
 * reading it as an echo turned every unnumbered picker row — `❯ Opus 4.1`, a
 * `/resume` entry — into the reader's own words. It stays an input-box marker
 * in `statusLine`, which asks a different question: where the live frame
 * begins, not who said something. */
const PROMPT_ECHO = /^ ?[>›] (?=\S)/u;
/** Kimi Code echoes with `✨` and draws no `>` at all (read out of its 0.43
 * bundle). Only for a tab whose label names it: `✨` opens plenty of ordinary
 * output — a custom statusline row, an answer's flourish — and on any other
 * session it is not a prompt. */
const KIMI_ECHO = /^ ?(?:[>›]|✨) (?=\S)/u;
const KIMI_AGENT = /kimi/iu;
/** A numbered dialog row (`❯ 1. Yes`) — a question, never a prompt. */
const OPTION_ROW = /^ ?[>›❯] \d{1,2}[.)] /u;
/** The hint a CLI draws inside its *empty* input box, in the very column a
 * submitted prompt's echo sits in: Claude Code's `Try "…"`, the `Type your
 * message or @path/to/file` of Gemini CLI and Qwen Code. Matched against the
 * text after the marker, and against the **whole** of it — a prompt that
 * merely opens with those words is the user's (`try "npm ci" first`, `type
 * your message into the box`), and eating one costs them their bubble. */
const PLACEHOLDER =
  /^\s*(?:try\s+["'“”‘’][^"'“”‘’]*["'“”‘’][?.!]?|type your message or @path\/to\/file)\s*$/iu;
/** The rows a TUI pins *under* its input box: its mode indicator and its key
 * hints. The row must be *only* that — anchored at both ends and holding no
 * sentence punctuation — so neither a tool result that mentions a key
 * (`… +40 lines (ctrl+o to expand)`) nor an answer *about* one
 * (`Shift+Tab cycles the permission mode.`) is ever taken for the footer.
 * An unbulleted agent's first answer row is the one that was demoted. */
const FOOTER_OPENS =
  /^\s*(?:[⏵⏸⏎⌃⇧]|\?\s*for shortcuts\b|(?:shift\s*\+\s*tab|esc|ctrl\s*\+\s*\S|alt\s*\+\s*\S)\s+to\s+\S)/iu;
/** Whether the row is a footer and not a sentence that opens like one.
 *
 * The row has to *start* with the hint — a tool result naming a key
 * (`… +40 lines (ctrl+o to expand)`) never does — and then be either the bare
 * hint or a columned row. Claude Code prints its hint with the context and
 * cost beside it (`? for shortcuts · 85% context left · $0.42`), so requiring
 * the hint to be the whole row put that footer, and the stale draft above it,
 * in the reader's own bubble; requiring no sentence punctuation dropped it
 * again over the `.` in `$0.42`. An answer *about* a key is one column and
 * ends in prose (`Esc to interrupt is the one you want.`), so it stays the
 * agent's. */
function isFooterRow(text: string): boolean {
  if (!FOOTER_OPENS.test(text)) return false;
  return columnCount(text) >= 2 || !/[.!?]/u.test(text);
}
/** A row opening with a glyph the TUI owns: a tool call's result gutter
 * (Claude Code's `⎿`, Codex's `└ `), a message bullet, a spinner.
 *
 * The frame and tree strokes `├ │ ┌ ╭ ╰ ┃` are deliberately *not* here.
 * Pasting `tree` output into a prompt is routine, and claiming those cut the
 * prompt at its first `├── src` row and handed the rest to the agent. Codex's
 * gutter is kept apart from a tree's elbow by what follows it: `└ ` carries
 * text, `└──` carries more strokes. */
const STRUCTURE_ROW = /^\s*(?:[⎿⏺●✦◆✻✽]|└(?![─━═]))/u;
/** Every TUI indents the further lines of a multi-line prompt under the
 * marker; an unindented line is the agent's again. */
const CONTINUATION = /^\s+\S/u;
/** Columns the marker and its space occupy — what the indent lines up with. */
const MARKER_WIDTH = 2;
/** An agent's message bullet at the left edge, opening a message: Claude
 * Code's `⏺`, or the `●` it draws on Linux (Kimi Code's bullet too), Gemini
 * CLI's `✦`, and Qwen Code's `◆︎` — a `◆` with the text-presentation selector,
 * which replaced its `✦` by 0.23 (each read out of the published bundle).
 * Codex's `•` is deliberately not one: it opens tool calls and progress lines
 * as well as answers, and nothing on the row tells them apart. */
const AGENT_MESSAGE = /^ ?(?:[⏺●✦]|◆︎?) (?=\S)/u;
/** The same, for Gemini CLI and Qwen Code, whose `●` is no message bullet but
 * the radio dot on a dialog's highlighted row (`● 1.  Allow once`). Taken for
 * a bullet, the dot was cut off the question and the highlight went with it. */
const RADIO_AGENT_MESSAGE = /^ ?(?:✦|◆︎?) (?=\S)/u;
/** A Claude Code tool call: the bullet, then either a capitalised built-in
 * tool name (`Bash`, `Update`, `Web Search`) with its argument in parentheses,
 * or an MCP tool, which Claude Code names `server - tool (MCP)` (`mcp__…
 * (MCP)` for one whose server is gone) — lowercase, so the first form never
 * matched it — followed by its argument, or by nothing when it takes none. */
const CLAUDE_TOOL_CALL = /^ ?[⏺●] (?:[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*\(|(?:\S+ - \S+|mcp__\S+) \(MCP\)(?:\(|$))/u;
/** A row that belongs to the tool call above it: its `⎿` status line, an
 * indented output or continuation row, or a blank between them. */
const TOOL_ROW = /^(?:\s*⎿|\s{2,}\S|\s*$)/u;

/** The echo marker this session draws, which is Kimi Code's only for a tab
 * whose label names it. */
function echoPattern(agentLabel?: string): RegExp {
  return agentLabel && KIMI_AGENT.test(agentLabel) ? KIMI_ECHO : PROMPT_ECHO;
}

/** Whether `line` is the start of an echoed prompt — a row on its own, so a
 * caller with no surrounding lines (the live-tail scan in `Terminal.tsx`) can
 * ask too. `chatTurns` adds the guards that need the rows around it. */
export function isPromptEcho(line: { text: string }, agentLabel?: string): boolean {
  const marker = echoPattern(agentLabel).exec(line.text);
  if (!marker || OPTION_ROW.test(line.text)) return false;
  return !PLACEHOLDER.test(line.text.slice(marker[0].length));
}

/** Claude Code's prompt echo in its fullscreen frame: `❯` and the prompt,
 * the whole row painted on its user-message background. */
const PAINTED_ECHO = /^ ?❯ (?=\S)/u;

/** Whether `line` is where the session on a *live* screen moved past a
 * prompt: `isPromptEcho`, or Claude Code's `❯` echo told from a picker's
 * highlight cursor by its painted background — a cursor row carries none.
 * Only for cutting the live tail: missing it handed the startup banner and
 * every earlier prompt to an agent's question as its context. */
export function isLiveEcho(line: { text: string; spans?: readonly ReadableSpan[] }, agentLabel?: string): boolean {
  if (isPromptEcho(line, agentLabel)) return true;
  if (!PAINTED_ECHO.test(line.text) || OPTION_ROW.test(line.text)) return false;
  const painted = line.spans?.filter((span) => span.text.trim()) ?? [];
  return painted.length > 0 && painted.every((span) => !!span.background);
}

/** Whether the echo at `index` is a box the TUI is still drawing rather than a
 * prompt somebody submitted: the first non-blank row under it is one the TUI
 * pins beneath its input box. A real echo is followed by the answer, by the
 * empty box below it, or by nothing. */
function isInputBox(lines: readonly { text: string }[], index: number): boolean {
  for (let row = index + 1; row < lines.length; row += 1) {
    const text = lines[row].text;
    if (!text.trim()) continue;
    // Gemini CLI and Qwen Code pin no key hint under the box — they pin the
    // columned row `statusLine` reads the chips out of (`~/proj  main
    // gemini-2.5-pro  25% used`), and their mode indicator sits *above* the
    // box where this never looks. Two *columns* carrying status means the row
    // is printed in columns, which an answer's sentence is not — counting
    // fields instead scored `~/tabtivity/projects/app (main)` two on its own and
    // handed the prompt above it to the agent.
    return isFooterRow(text) || statusColumns(text) >= 2;
  }
  return false;
}

/** Whether `line` opens a Claude Code tool call, whose block Focus leaves out. */
export function isToolCall(line: { text: string }): boolean {
  return CLAUDE_TOOL_CALL.test(line.text);
}

/** A copy of `spans` with the first `count` characters removed. */
function dropLeading(spans: readonly ReadableSpan[], count: number): ReadableSpan[] {
  const out: ReadableSpan[] = [];
  let remaining = count;
  for (const span of spans) {
    if (remaining >= span.text.length) {
      remaining -= span.text.length;
      continue;
    }
    out.push(remaining > 0 ? { ...span, text: span.text.slice(remaining) } : span);
    remaining = 0;
  }
  return out;
}

/** The message's own words: the marker (and any frame padding before it) off
 * the first line, up to the marker's width of indent off the rest. */
function unmark(lines: readonly ReadableLine[], marker: RegExp): ReadableLine[] {
  return lines.map((line, index) => {
    const lead = index === 0
      ? (marker.exec(line.text)?.[0].length ?? 0)
      : Math.min(MARKER_WIDTH, line.text.length - line.text.trimStart().length);
    if (lead === 0) return line;
    return { key: line.key, text: line.text.slice(lead), spans: dropLeading(line.spans, lead) };
  });
}

function trimBlank(lines: ReadableLine[]): ReadableLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].text === "") start += 1;
  while (end > start && lines[end - 1].text === "") end -= 1;
  return lines.slice(start, end);
}

/**
 * The agent's lines between two prompts as turns: one per `⏺` message, with
 * each tool call and its rows left out. Lines before the first bullet — a
 * spinner, a status line, another TUI's whole output — are one plain turn.
 *
 * A message is a bubble of its own and stays one: the next thing the agent
 * writes is the next bubble, never more text in one already shown. Each turn
 * is keyed by its first row, so a bubble keeps its identity while the agent
 * goes on below it.
 */
function agentTurns(lines: readonly ReadableLine[], bullet: RegExp): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let plain: ReadableLine[] = [];
  const flushPlain = () => {
    const kept = trimBlank(plain);
    if (kept.length > 0) turns.push({ key: kept[0].key, role: "agent", lines: kept });
    plain = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isToolCall(line)) {
      flushPlain();
      index += 1;
      while (index < lines.length && !bullet.test(lines[index].text) && TOOL_ROW.test(lines[index].text)) index += 1;
      continue;
    }
    if (!bullet.test(line.text)) {
      plain.push(line);
      index += 1;
      continue;
    }
    flushPlain();
    const message = [line];
    index += 1;
    // A message's own rows sit indented under its marker. The first row at
    // the left edge — the spinner, a status row, a question the session asks —
    // is the TUI's and not the message's: taken in, a ticking spinner changed
    // a bubble already shown every second.
    while (index < lines.length
      && !bullet.test(lines[index].text)
      && (lines[index].text === "" || CONTINUATION.test(lines[index].text))) {
      message.push(lines[index]);
      index += 1;
    }
    const kept = trimBlank(message);
    turns.push({ key: kept[0].key, role: "agent", lines: kept, answer: unmark(kept, bullet) });
  }
  flushPlain();
  return turns;
}

/**
 * Splits `lines` into agent and user turns, in order. The blank rows a TUI
 * leaves around a prompt echo are the seam between turns, not content, and
 * are dropped there; blanks inside an agent turn stay its paragraph breaks.
 */
export function chatTurns(
  original: readonly ReadableLine[],
  agentLabel?: string,
  columns = 0,
): ChatTurn[] {
  const echo = echoPattern(agentLabel);
  const bullet = radioMarkerAgent(agentLabel) ? RADIO_AGENT_MESSAGE : AGENT_MESSAGE;
  // OpenCode's minimal interface wraps its own rows at the pane width, with no
  // marker and no indent on the continuation, so a block is held together by
  // the blank row that ends it rather than by an indent (`openCodeMini.ts`).
  // With the pane's width in hand its wrapping is undone first, so the phone
  // re-wraps at its own — everything below then sees whole logical lines, the
  // way `readableScreen` hands them over for every other CLI.
  const mini = isOpenCodeTab(agentLabel);
  const lines = mini ? joinOpenCodeWraps(original, columns) : original;
  const turns: ChatTurn[] = [];
  let agent: ReadableLine[] = [];
  const flushAgent = () => {
    turns.push(...agentTurns(agent, bullet));
    agent = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (mini) {
      // A blank left where a dropped block stood is not a paragraph break the
      // session drew; `readableScreen` collapsed the ones it printed, and this
      // collapses the ones the drops below open.
      if (!line.text.trim() && (agent.length === 0 || agent[agent.length - 1].text === "")) {
        index += 1;
        continue;
      }
      // The start-up banner and the `▣ Build · model · 6.2s` a turn ends with
      // are the TUI talking about itself; the model and the agent they name
      // reach the reader as the composer's chips (`statusLine`).
      if (isOpenCodeBanner(line.text) || openCodeTurnFooter(line.text) !== null) {
        index += 1;
        continue;
      }
      // A tool call and its wrapped rows, left out the way Claude Code's are.
      // The bash tool is not one of these: it prints `$ cmd` and the output
      // under it, which is the session's own words and stays.
      if (isOpenCodeToolRow(line.text)) {
        index = openCodeBlockEnd(lines, index);
        continue;
      }
    }
    if (!isPromptEcho(line, agentLabel) || isInputBox(lines, index)) {
      agent.push(line);
      index += 1;
      continue;
    }
    flushAgent();
    const prompt = [line];
    index += 1;
    if (mini) {
      const end = openCodeBlockEnd(lines, index - 1);
      while (index < end) {
        prompt.push(lines[index]);
        index += 1;
      }
    } else {
      while (index < lines.length
        && CONTINUATION.test(lines[index].text)
        && !STRUCTURE_ROW.test(lines[index].text)
        && !isFooterRow(lines[index].text)) {
        prompt.push(lines[index]);
        index += 1;
      }
    }
    turns.push({ key: line.key, role: "user", lines: prompt, prompt: unmark(prompt, echo) });
  }
  flushAgent();
  return turns;
}
