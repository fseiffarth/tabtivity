/**
 * Whether the user just typed an agent CLI's new-conversation command into its
 * pane — how the window learns of a `/clear` at once: Codex fires its hook
 * only with the new chat's first prompt, and every other CLI but Claude says
 * nothing at all (for "Undo clear", and the Reader letting go of the chat).
 *
 * Follows the line as typed: printable text and pastes add to it, Backspace
 * takes from it, and any other key (arrows, Tab completion, a Ctrl chord)
 * makes it unknown until the next Enter. A command finished in the CLI's own
 * slash popup is read off the screen at that Enter instead (`screen`): the
 * composer row as it stands — a completion or a recalled line — or, for a
 * prefix typed out and run as is, the popup's first entry, which is the one
 * Enter picks while no arrow has moved the selection.
 */
const NEW_CONVERSATION = /^\/(clear|new|new-chat|reset)$/u;
/** Longer than any command above; a line past it can match none of them. */
const MAX_LINE = 32;
/** How far below the composer row the popup's first entry is looked for. */
const POPUP_ROWS = 8;

/** Whether `text` is a CLI's new-conversation command (`/clear`, `/new`, …). */
export function isNewConversationCommand(text: string): boolean {
  return NEW_CONVERSATION.test(text.trim());
}

/** The pane's rows around the cursor at the moment of an Enter, before it
 * reaches the CLI. */
export interface TypedScreen {
  /** The row the cursor sits on. */
  input: string;
  /** The rows under it, top down. */
  below: string[];
}

/** What a composer row holds: the text after the prompt glyph, the box frame
 * stripped; null for a row that is no composer. */
function composerText(row: string): string | null {
  const inner = row.replace(/^[\s│┃|]+/u, "").replace(/[\s│┃|]+$/u, "");
  const match = /^[>›❯]\s*(.*)$/u.exec(inner);
  return match ? match[1].trim() : null;
}

/** The command a popup row offers (`/clear  start a new chat`), if it is one. */
function popupCommand(row: string): string | null {
  const inner = row.replace(/^[\s│┃|]+/u, "");
  return /^(?:[>›❯▸]\s*)?(\/[\w-]+)(?:\s|$)/u.exec(inner)?.[1] ?? null;
}

/** Whether the Enter on `screen` runs a new-conversation command; `typed` is
 * the line as followed (null: unknown). */
function screenRunsClear(screen: TypedScreen, typed: string | null): boolean {
  const composer = composerText(screen.input);
  if (composer === null) return false;
  if (NEW_CONVERSATION.test(composer)) return true;
  // A prefix runs the popup's selection, the first entry unless an arrow
  // moved it — and then the line is not known.
  if (typed === null || !/^\/[\w-]+$/u.test(typed) || composer !== typed) return false;
  const first = screen.below.map(popupCommand).find((command) => command !== null);
  return !!first && NEW_CONVERSATION.test(first) && first.startsWith(typed);
}

/** The cursor's row and the ones under it, off an xterm-shaped buffer. */
export function screenAtCursor(buffer: {
  baseY: number;
  cursorY: number;
  length: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}): TypedScreen {
  const y = buffer.baseY + buffer.cursorY;
  const row = (at: number) => buffer.getLine(at)?.translateToString(true) ?? "";
  const below: string[] = [];
  for (let at = y + 1; at < Math.min(buffer.length, y + 1 + POPUP_ROWS); at++) below.push(row(at));
  return { input: row(y), below };
}

const lineByPty: Record<string, string | null> = {};

/** Feed one chunk of the user's input; true when its Enter submitted a
 * new-conversation command. `screen` is read only for a lone Enter the line
 * alone does not answer. */
export function noteTypedLine(ptyId: string, data: string, screen?: () => TypedScreen | null): boolean {
  // Bracketed-paste markers carry no text; a paste is typing done at once.
  const text = data.replace(/\x1b\[20[01]~/gu, "");
  // `null` is a line that is no longer known (see above); absent is empty.
  let line: string | null = ptyId in lineByPty ? lineByPty[ptyId] : "";
  let cleared = false;
  if (text.includes("\x1b")) {
    lineByPty[ptyId] = null;
    return false;
  }
  for (const ch of text) {
    if (ch === "\r" || ch === "\n") {
      if (line !== null && NEW_CONVERSATION.test(line.trim())) cleared = true;
      else if (screen && text.length === 1 && (line === null || line.startsWith("/"))) {
        const shown = screen();
        if (shown && screenRunsClear(shown, line === null ? null : line.trim())) cleared = true;
      }
      line = "";
    } else if (line === null) {
      continue;
    } else if (ch === "\x7f" || ch === "\b") {
      line = line.slice(0, -1);
    } else if (ch < " ") {
      line = null;
    } else if (line.length < MAX_LINE) {
      line += ch;
    } else {
      line = null;
    }
  }
  lineByPty[ptyId] = line;
  return cleared;
}

/** Forget a pane's line (tab closed). */
export function forgetTypedLine(ptyId: string): void {
  delete lineByPty[ptyId];
}
