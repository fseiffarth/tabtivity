/**
 * What the user typed into an agent's input box, followed from the keystrokes
 * alone — the prompt strip's CLI-independent source (`stores/agents/promptTrail`).
 *
 * Same stance as `promptCount` and `typedClear`: Tabtivity sees only the bytes
 * going into the PTY, never the TUI's input box, and reads no CLI's private
 * files for this. So the line is edited here as a plain line editor would:
 * printable text and pastes insert at a cursor, Backspace/Delete remove,
 * ←/→ (and Home/End on a one-line buffer) move it, Ctrl+U/K/W cut, Ctrl+C
 * empties, Alt+Enter inserts a newline, and Enter submits.
 *
 * Anything whose effect depends on the CLI — ↑/↓ (history recall, or a line
 * change in a multi-line box), Tab (completion), a bare Esc over typed text,
 * an unknown chord — makes the line *unknown* until the next Enter, which then
 * submits nothing. A prompt finished that way is missed rather than guessed at.
 */

/** A line being typed: its text and the cursor within it (UTF-16 index).
 *  `null` is a line no longer known (see above). */
export type TypedLine = { text: string; cursor: number } | null;

/** Longest line followed; typing past it keeps the head. */
export const TYPED_LINE_MAX = 32_000;

const EMPTY: TypedLine = { text: "", cursor: 0 };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A CSI (`ESC [ … final`) or SS3 (`ESC O x`) sequence at the head of `s`. */
const SEQUENCE = /^\x1b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|O[ -~])/u;

function insert(line: NonNullable<TypedLine>, text: string): NonNullable<TypedLine> {
  const room = TYPED_LINE_MAX - line.text.length;
  if (room <= 0) return line;
  const add = text.slice(0, room);
  return {
    text: line.text.slice(0, line.cursor) + add + line.text.slice(line.cursor),
    cursor: line.cursor + add.length,
  };
}

/** Home/End and the line cuts are the same thing in every editor only while
 *  the buffer is one line; across lines each CLI does its own thing. */
function oneLine(line: NonNullable<TypedLine>): boolean {
  return !line.text.includes("\n");
}

/** What an escape sequence does to the line. */
function applySequence(line: NonNullable<TypedLine>, seq: string): TypedLine {
  switch (seq) {
    case "\x1b[D":
    case "\x1bOD":
      return { ...line, cursor: Math.max(0, line.cursor - 1) };
    case "\x1b[C":
    case "\x1bOC":
      return { ...line, cursor: Math.min(line.text.length, line.cursor + 1) };
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
    case "\x1b[7~":
      return oneLine(line) ? { ...line, cursor: 0 } : null;
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
    case "\x1b[8~":
      return oneLine(line) ? { ...line, cursor: line.text.length } : null;
    case "\x1b[3~":
      return { ...line, text: line.text.slice(0, line.cursor) + line.text.slice(line.cursor + 1) };
    // Shift+Enter in the CSI-u (kitty) encoding: a newline in the box.
    case "\x1b[13;2u":
      return insert(line, "\n");
    // Focus reports and bracketed-paste markers out of place carry no edit.
    case "\x1b[I":
    case "\x1b[O":
      return line;
  }
  // Mouse reports (SGR `ESC [ < … M/m`) do not edit what a keyboard typed.
  if (seq.startsWith("\x1b[<")) return line;
  // ↑/↓ recall history (or move between the box's lines); any other chord
  // edits typed text in a way only the CLI knows.
  if (/^\x1b[[O][AB]$/u.test(seq)) return null;
  return line.text ? null : line;
}

/** What a C0 control (or DEL) does to the line. */
function applyControl(line: NonNullable<TypedLine>, ch: string): TypedLine {
  switch (ch) {
    case "\x7f":
    case "\b":
      if (line.cursor === 0) return line;
      return { text: line.text.slice(0, line.cursor - 1) + line.text.slice(line.cursor), cursor: line.cursor - 1 };
    case "\x01": // Ctrl+A
      return oneLine(line) ? { ...line, cursor: 0 } : null;
    case "\x05": // Ctrl+E
      return oneLine(line) ? { ...line, cursor: line.text.length } : null;
    case "\x15": // Ctrl+U
      return oneLine(line) ? { text: line.text.slice(line.cursor), cursor: 0 } : null;
    case "\x0b": // Ctrl+K
      return oneLine(line) ? { ...line, text: line.text.slice(0, line.cursor) } : null;
    case "\x17": { // Ctrl+W: the word before the cursor, and the spaces after it
      const head = line.text.slice(0, line.cursor).replace(/\S*\s*$/u, "");
      return { text: head + line.text.slice(line.cursor), cursor: head.length };
    }
    case "\x0c": // Ctrl+L redraws
      return line;
  }
  return line.text ? null : line;
}

/**
 * Feed one chunk of the user's input into `line`. Returns the line after it
 * and every prompt an Enter in it submitted (text as typed, untrimmed), in
 * order. `pasting` carries a bracketed paste split across chunks.
 */
export function feedTypedLine(
  line: TypedLine,
  data: string,
  pasting = false,
): { line: TypedLine; submitted: string[]; pasting: boolean } {
  const submitted: string[] = [];
  let rest = data;
  while (rest) {
    if (pasting) {
      const end = rest.indexOf(PASTE_END);
      const body = end < 0 ? rest : rest.slice(0, end);
      if (line) line = insert(line, body.replace(/\r\n?/gu, "\n"));
      rest = end < 0 ? "" : rest.slice(end + PASTE_END.length);
      pasting = end < 0;
      continue;
    }
    if (rest.startsWith(PASTE_START)) {
      pasting = true;
      rest = rest.slice(PASTE_START.length);
      continue;
    }
    const ch = rest[0];
    if (ch === "\r" || ch === "\n") {
      if (line && line.text.trim()) submitted.push(line.text);
      line = EMPTY;
      rest = rest.slice(1);
      continue;
    }
    if (ch === "\x1b") {
      // Alt+Enter: a newline in the box, in every CLI that has one.
      if (rest[1] === "\r" || rest[1] === "\n") {
        if (line) line = insert(line, "\n");
        rest = rest.slice(2);
        continue;
      }
      const seq = SEQUENCE.exec(rest)?.[0];
      if (seq) {
        if (line) line = applySequence(line, seq);
        rest = rest.slice(seq.length);
        continue;
      }
      // A bare Esc (or Alt+key): over typed text, each CLI decides.
      if (line?.text) line = null;
      rest = rest.slice(rest[1] ? 2 : 1);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      // Ctrl+C empties the box even when what was in it was not known.
      if (ch === "\x03") line = EMPTY;
      else if (line) line = ch === "\t" ? null : applyControl(line, ch);
      rest = rest.slice(1);
      continue;
    }
    // A run of printable text at once (a fast typist, an unbracketed paste).
    let end = 1;
    while (end < rest.length) {
      const c = rest.charCodeAt(end);
      if (c < 0x20 || c === 0x7f) break;
      end++;
    }
    if (line) line = insert(line, rest.slice(0, end));
    rest = rest.slice(end);
  }
  return { line, submitted, pasting };
}
