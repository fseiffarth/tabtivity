import { type Lang } from "../../../lib/viewers/highlight";
import { escapeHtml } from "../../../lib/textSafety";
import { pythonStringEnd } from "../../../lib/viewers/python";
import { hasMatchingTexEnd } from "../../../lib/viewers/tex/tex";
import { BRACKET_CLOSE_FOR } from "./decorations";

const INDENT = "    "; // 4 spaces — what Tab inserts and Shift+Tab strips.

/** Apply Tab / Shift+Tab indentation to a code textarea, preserving selection.
 *  Returns the next value + selection, or null to let the key fall through. */
export function applyIndent(
  el: HTMLTextAreaElement,
  outdent: boolean,
): { value: string; selStart: number; selEnd: number } | null {
  const { value, selectionStart: start, selectionEnd: end } = el;
  const multiLine = value.slice(start, end).includes("\n");

  // Plain Tab with no multi-line selection → insert one indent at the caret.
  if (!outdent && !multiLine) {
    const value2 = value.slice(0, start) + INDENT + value.slice(end);
    const caret = start + INDENT.length;
    return { value: value2, selStart: caret, selEnd: caret };
  }

  // Otherwise operate on every line the selection touches.
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines
    .map((line, i) => {
      if (outdent) {
        // Strip up to one indent's worth of leading whitespace (a full INDENT,
        // else whatever leading spaces/tabs exist, capped at INDENT width).
        const lead = line.match(/^[ \t]+/)?.[0].length ?? 0;
        const strip = line.startsWith(INDENT)
          ? INDENT.length
          : Math.min(lead, INDENT.length);
        if (strip > 0) {
          if (i === 0) firstDelta = -strip;
          totalDelta -= strip;
          return line.slice(strip);
        }
        return line;
      }
      if (i === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    })
    .join("\n");

  const value2 = value.slice(0, lineStart) + next + value.slice(end);
  return {
    value: value2,
    selStart: Math.max(lineStart, start + firstDelta),
    selEnd: end + totalDelta,
  };
}

/** Advance across the closing brace of a TeX argument. This is deliberately a
 * narrow Tab-stop: it applies only to a collapsed caret immediately before `}`;
 * selections and ordinary source indentation retain their usual Tab behaviour.
 */
export function advanceTexBraceTabStop(el: HTMLTextAreaElement): number | null {
  const { value, selectionStart: start, selectionEnd: end } = el;
  return start === end && value[start] === "}" ? start + 1 : null;
}

/**
 * Toggle line comments over every line the selection touches (Ctrl+Shift+C),
 * using `marker` — `%` in a `.tex` file, `//`, `#`, … elsewhere. Returns the next
 * value + selection, or null when there is nothing to toggle.
 *
 * Comment or uncomment is decided by what is already there: the block
 * UNcomments only when every non-blank line it covers is already commented, so a
 * partially-commented block commutes to fully commented first (the same rule the
 * common editors use — pressing twice always round-trips). Commenting inserts at
 * the block's shallowest indent so relative indentation survives, and skips
 * blank lines rather than leaving stranded markers; uncommenting drops the
 * marker plus at most one following space, so `% x` → `x` while `%% x` keeps the
 * second percent — a deliberate double-comment is not this gesture's to undo.
 */
export function applyLineComment(
  el: HTMLTextAreaElement,
  marker: string,
): { value: string; selStart: number; selEnd: number } | null {
  if (!marker) return null;
  const { value, selectionStart: start, selectionEnd: end } = el;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection ending exactly at a line start stops at the newline before it —
  // it does not reach into the line it merely touches with its tail.
  const probe = end > start ? end - 1 : end;
  const nl = value.indexOf("\n", probe);
  const to = nl === -1 ? value.length : nl;

  const lines = value.slice(from, to).split("\n");
  const blank = (line: string) => line.trim() === "";
  // A selection of nothing but blank lines still comments them — there is no
  // "meaningful" line to skip in favour of.
  const skipBlanks = lines.some((line) => !blank(line));
  const body = skipBlanks ? lines.filter((line) => !blank(line)) : lines;
  const uncomment = body.every((line) => line.trimStart().startsWith(marker));
  const col = uncomment
    ? 0
    : Math.min(...body.map((line) => line.length - line.trimStart().length));

  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines
    .map((line, i) => {
      if (skipBlanks && blank(line)) return line;
      if (uncomment) {
        const at = line.indexOf(marker);
        const after = at + marker.length;
        const drop = marker.length + (line[after] === " " ? 1 : 0);
        if (i === 0) firstDelta = -drop;
        totalDelta -= drop;
        return line.slice(0, at) + line.slice(at + drop);
      }
      const add = marker.length + 1;
      if (i === 0) firstDelta = add;
      totalDelta += add;
      return line.slice(0, col) + marker + " " + line.slice(col);
    })
    .join("\n");

  if (totalDelta === 0) return null;
  return {
    value: value.slice(0, from) + next + value.slice(to),
    selStart: Math.max(from, start + firstDelta),
    selEnd: Math.max(from, end + totalDelta),
  };
}

/** How wide a tab renders in the editor and every overlay layer — `tab-size: 4`
 *  in `viewers.css`. Column arithmetic here has to agree with what the reader
 *  sees, so the two are one number and this comment is the link between them. */
const TAB_WIDTH = 4;

/** One indentation level, as the file itself writes it. */
export interface IndentUnit {
  /** The characters one level is made of — `"  "`, `"    "`, `"\t"`. */
  text: string;
  /** How many columns that is, once tabs are expanded. */
  width: number;
}

/** What a file with nothing to learn from indents by, and what the Tab key
 *  writes (see {@link INDENT}). */
const DEFAULT_INDENT_UNIT: IndentUnit = { text: INDENT, width: INDENT.length };

/** How far into a file the unit is sampled from. A file indents the same way
 *  throughout or it has no unit worth finding, so reading all of a 40k-line
 *  generated JSON on every keystroke buys nothing. */
const INDENT_SAMPLE_LINES = 2000;

/**
 * How much one indentation level is worth **in this file** — read out of the
 * text rather than assumed, because the editor's own 4 spaces are a house style
 * and the file being edited is somebody else's.
 *
 * Measured as the step between successive lines' indentation (the way an editor
 * infers it): a run of `0, 4, 8` says four, `0, 2, 4` says two. Only 2/3/4/8 are
 * admitted — every other step is a continuation line or a wrapped argument list,
 * not a level — and a file whose lines lead with tabs is a tab file whatever
 * those steps say, since one tab is one level by definition. Falls back to the
 * editor's own {@link INDENT} when the text says nothing.
 */
export function detectIndentUnit(source: string): IndentUnit {
  let tabbed = 0;
  let spaced = 0;
  const steps = new Map<number, number>();
  let prev = -1;
  let seen = 0;
  let i = 0;
  for (;;) {
    if (seen >= INDENT_SAMPLE_LINES) break;
    const nl = source.indexOf("\n", i);
    const to = nl < 0 ? source.length : nl;
    let width = 0;
    let sawTab = false;
    let j = i;
    for (; j < to; j++) {
      const ch = source[j];
      if (ch === "\t") {
        sawTab = true;
        width += TAB_WIDTH - (width % TAB_WIDTH);
      } else if (ch === " ") {
        width += 1;
      } else break;
    }
    // A blank line has no indentation to speak of and must not break the run:
    // it neither votes nor resets `prev`.
    if (j < to) {
      if (width > 0) {
        if (sawTab) tabbed++;
        else spaced++;
      }
      if (prev >= 0 && width > prev) {
        const step = width - prev;
        if (step === 2 || step === 3 || step === 4 || step === 8) {
          steps.set(step, (steps.get(step) ?? 0) + 1);
        }
      }
      prev = width;
    }
    seen++;
    if (nl < 0) break;
    i = nl + 1;
  }
  if (tabbed > spaced) return { text: "\t", width: TAB_WIDTH };
  let best = 0;
  let bestCount = 0;
  for (const [step, count] of steps) {
    // Ties go to the narrower step: `0, 4, 8` is also two steps of two, and the
    // finer reading is the one that draws a guide at every level that exists.
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  return best > 0 ? { text: " ".repeat(best), width: best } : DEFAULT_INDENT_UNIT;
}

/** The column `pos` sits at on its own line, tabs expanded to the next
 *  {@link TAB_WIDTH} stop — the advance the monospace layers actually paint. */
function columnAt(source: string, pos: number): number {
  const from = source.lastIndexOf("\n", pos - 1) + 1;
  let col = 0;
  for (let i = from; i < pos; i++) {
    col += source[i] === "\t" ? TAB_WIDTH - (col % TAB_WIDTH) : 1;
  }
  return col;
}

/** The leading whitespace of the line `pos` sits on. */
function lineIndentAt(source: string, pos: number): string {
  const from = source.lastIndexOf("\n", pos - 1) + 1;
  let i = from;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(from, i);
}

/** One indentation level off the end of `lead`, never past column 0. */
function dedentOnce(lead: string, unit: IndentUnit): string {
  if (unit.text === "\t") return lead.endsWith("\t") ? lead.slice(0, -1) : lead;
  return lead.length >= unit.width ? lead.slice(0, lead.length - unit.width) : "";
}

/** The rest of `from`'s line, minus a trailing `#` comment — what decides
 *  whether an open bracket has arguments on its own line to align under. */
function pyCodeAfter(source: string, from: number): string {
  const nl = source.indexOf("\n", from);
  const line = source.slice(from, nl < 0 ? source.length : nl);
  const hash = line.indexOf("#");
  return hash < 0 ? line : line.slice(0, hash);
}

/** `line` up to the `%` that starts its comment (a `\%` is a percent sign, not
 *  a comment) — TeX's equivalent of {@link pyCodeAfter}. */
function texCodePrefix(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return line.slice(0, i);
  }
  return line;
}

/**
 * What Python's Enter needs to know at `caret`: whether it lands inside a string
 * literal (where the text is data and nothing should be inferred from it), which
 * brackets are still open in front of it (implicit line continuation — the
 * openers can be lines above, which is why this scans from the top rather than
 * from the caret's own line), and the caret's own line with strings and comments
 * blanked out, so a trailing `:` is only read when it really is one.
 *
 * A lexer, not a parser — the buffer under an editing caret is regularly not
 * valid Python, and an unterminated literal is its normal state.
 */
function pythonIndentState(
  source: string,
  caret: number,
): { inString: boolean; openers: number[]; lineCode: string } {
  const openers: number[] = [];
  let lineCode = "";
  let i = 0;
  while (i < caret) {
    const c = source[i];
    if (c === "\n") {
      lineCode = "";
      i++;
      continue;
    }
    if (c === "#") {
      while (i < caret && source[i] !== "\n") {
        lineCode += " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const to = pythonStringEnd(source, i);
      if (to > caret) return { inString: true, openers, lineCode };
      for (let j = i; j < to; j++) {
        // A triple-quoted literal spans lines, and the line the caret is on is
        // still the one after the last newline inside it.
        lineCode = source[j] === "\n" ? "" : lineCode + " ";
      }
      i = to;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") openers.push(i);
    else if (c === ")" || c === "]" || c === "}") openers.pop();
    lineCode += c;
    i++;
  }
  return { inString: false, openers, lineCode };
}

/** The languages whose Enter is aligned rather than dropped to column 0. Both
 *  put their structure in the indentation, and both have a block opener the next
 *  line is expected to sit inside; every other language keeps the plain
 *  newline the engine writes. */
const AUTO_INDENT_LANGS: ReadonlySet<Lang> = new Set<Lang>(["python", "tex"]);

/** Python statements that end a block: the line after one starts a level out. */
const PY_BLOCK_EXIT = /^(?:return|raise|pass|break|continue)\b/;

/**
 * Enter, aligned with the code it continues (Python and TeX). Returns the next
 * value + caret, or **null** to let the engine insert the newline itself — which
 * is deliberate rather than lazy: a plain newline through the browser keeps the
 * textarea's own undo entry, so the only keystrokes this intercepts are the ones
 * that genuinely add something.
 *
 * What it adds, in the order the rules are tried:
 *
 *  - the current line's indentation, always, so a block does not fall out from
 *    under the caret;
 *  - **inside brackets** (Python's implicit continuation) the new line aligns
 *    under the first argument, or one level in when the opener ends its line —
 *    and when the caret sits directly between a pair, the closer is pushed onto
 *    its own line so `foo(|)` opens into a block;
 *  - **after a `:`** one level in, and after `return`/`raise`/`pass`/`break`/
 *    `continue` one level out, since that statement ended the block;
 *  - **after `\begin{env}`** one level in, plus the matching `\end{env}` below
 *    when the document does not already have one waiting (`hasMatchingTexEnd` —
 *    the same test the environment completion makes, so typing a `\begin` out by
 *    hand and completing it cannot disagree).
 *
 * A caret inside a string literal gets the plain carry and nothing else: the
 * text there is data, and a `:` at the end of a sentence is not a block.
 */
export function applyAutoIndent(
  el: HTMLTextAreaElement,
  lang: Lang,
  unit: IndentUnit = DEFAULT_INDENT_UNIT,
): { value: string; selStart: number; selEnd: number } | null {
  if (!AUTO_INDENT_LANGS.has(lang)) return null;
  const { value, selectionStart: start, selectionEnd: end } = el;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  // Only the part of the line being LEFT BEHIND decides the new line: a caret
  // parked inside the indentation splits it rather than copying it whole.
  const head = value.slice(lineStart, start);
  const lead = /^[ \t]*/.exec(head)?.[0] ?? "";

  let indent = lead;
  let tail = ""; // a further line written BELOW the new one (a closer)

  if (lang === "python") {
    const st = pythonIndentState(value, start);
    const open = st.openers.length > 0 ? st.openers[st.openers.length - 1] : -1;
    if (st.inString) {
      // Carry the indentation and infer nothing from the prose.
    } else if (open >= 0) {
      const openIndent = lineIndentAt(value, open);
      if (value[end] === BRACKET_CLOSE_FOR[value[open]]) {
        indent = openIndent + unit.text;
        tail = "\n" + openIndent;
      } else if (/\S/.test(pyCodeAfter(value, open + 1))) {
        indent = " ".repeat(columnAt(value, open) + 1);
      } else {
        indent = openIndent + unit.text;
      }
    } else {
      const code = st.lineCode.trim();
      if (code.endsWith(":")) indent = lead + unit.text;
      else if (PY_BLOCK_EXIT.test(code)) indent = dedentOnce(lead, unit);
    }
  } else {
    const begun = /\\begin\s*\{([^{}]+)\}\s*$/.exec(texCodePrefix(head));
    if (begun) {
      indent = lead + unit.text;
      if (!hasMatchingTexEnd(value.slice(end), begun[1])) {
        tail = `\n${lead}\\end{${begun[1]}}`;
      }
    }
  }

  const insert = "\n" + indent + tail;
  if (insert === "\n") return null; // nothing to add — leave it to the engine
  const caret = start + 1 + indent.length;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    selStart: caret,
    selEnd: caret,
  };
}

/**
 * Build the indent-guide overlay: each line's leading whitespace is cut into
 * whole indentation levels and every level's first column wears a hairline, so
 * the nesting a file expresses through blank space becomes something to read
 * rather than something to count.
 *
 * Two rules keep it honest. The **file's own characters** are what the spans
 * wrap — never a tab rewritten as four spaces — because this layer sits on top
 * of the textarea's glyphs and one substituted character puts every guide after
 * it on the wrong column. And a **partial** level (an indentation of six with a
 * unit of four) still gets its guide at column four, where the level genuinely
 * starts, and nothing at all for the two spaces that follow.
 *
 * Returns null when no line in the file is indented — there is nothing to draw,
 * and the layer is then not rendered at all. SECURITY: every run of source text
 * is HTML-escaped before output, exactly as {@link decorateSearchRanges} does.
 */
export function decorateIndentGuides(source: string, unit: IndentUnit): string | null {
  if (unit.width <= 0) return null;
  let any = false;
  const out = source.split("\n").map((line) => {
    let w = 0;
    while (w < line.length && (line[w] === " " || line[w] === "\t")) w++;
    if (w === 0) return escapeHtml(line);
    any = true;
    let html = "";
    let col = 0;
    let chunk = "";
    let chunkCol = 0;
    const flush = () => {
      if (chunk === "") return;
      html +=
        chunkCol % unit.width === 0
          ? `<span class="file-viewer-indent-guide">${escapeHtml(chunk)}</span>`
          : escapeHtml(chunk);
      chunk = "";
    };
    for (let i = 0; i < w; i++) {
      const ch = line[i];
      if (chunk !== "" && col % unit.width === 0) {
        flush();
        chunkCol = col;
      }
      chunk += ch;
      col += ch === "\t" ? TAB_WIDTH - (col % TAB_WIDTH) : 1;
    }
    flush();
    return html + escapeHtml(line.slice(w));
  });
  return any ? out.join("\n") : null;
}

/** Where the indent guides are drawn: the languages that put meaning in leading
 *  whitespace, which is every one the editor highlights except the two that are
 *  prose — a stray indent in a paragraph is not a level of anything. */
export const INDENT_GUIDE_LANGS = (lang: Lang) => lang !== "plain" && lang !== "markdown";
