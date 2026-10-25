/**
 * Beamer overlays in the TeX editor (#tex-beamer), the pure half. Everything
 * here is a function of a string and two offsets, so the bar in
 * `FileViewerPane`'s `TexView` is chrome over these and the tests need no DOM.
 *
 * The problem this solves: writing a beamer deck means wrapping the same
 * fragments over and over in `\only<2->{…}`, `\uncover<3>{…}`, `\alert<2>{…}` —
 * seven characters of ceremony around every phrase that is to appear later, and
 * a slide number the author has to keep in their head per frame. The editor
 * already knows the selection and the frame, so it can write the ceremony and
 * suggest the number.
 *
 * Three rules worth stating:
 * - **Re-target, don't nest.** Applying `\uncover<3>` to a selection that is
 *   already the body of `\only<2>{…}` (or that IS the whole `\only<2>{…}`)
 *   rewrites the command and spec in place. Wrapping is idempotent-ish: the
 *   author changes their mind about *which* slide far more often than they mean
 *   a doubly wrapped fragment. Only same-arity commands re-target — `\alt` has a
 *   second argument `\only` has no place for, so those still wrap.
 * - **A trailing newline stays outside.** A line-wise selection (triple click,
 *   Shift+Down) ends in `\n`; `\only<2>{…}\n` is what was meant, not a brace on
 *   the next line.
 * - **The spec is validated, never interpreted.** `<+->`, `<.->`, `<1-| alert@2>`,
 *   `<handout:0>` are all beamer; the editor only refuses what cannot be a spec
 *   (braces, backslashes, a second `<`), because a wrong guess at the grammar
 *   would refuse a valid deck.
 */
import type { EditResult } from "../markdownEdit";

/** The overlay-aware commands the bar offers, in menu order. `alt` and
 *  `temporal` take more than one brace argument (see {@link BEAMER_ARITY}). */
export const BEAMER_OVERLAY_COMMANDS = [
  "only",
  "uncover",
  "visible",
  "invisible",
  "alert",
  "onslide",
  "alt",
  "temporal",
] as const;
export type BeamerOverlayCommand = (typeof BEAMER_OVERLAY_COMMANDS)[number];

/** Brace arguments each command takes; the selection lands in `BEAMER_SELECTION_ARG`. */
export const BEAMER_ARITY: Record<BeamerOverlayCommand, number> = {
  only: 1,
  uncover: 1,
  visible: 1,
  invisible: 1,
  alert: 1,
  onslide: 1,
  alt: 2,
  temporal: 3,
};

/** Which brace argument the selection is written into (0-based). `\alt<s>{on}{off}`
 *  shows its FIRST argument on the spec's slides — the selected text is what is
 *  to appear, so it goes first. `\temporal<s>{before}{during}{after}` shows the
 *  MIDDLE one on the spec's slides. */
export const BEAMER_SELECTION_ARG: Record<BeamerOverlayCommand, number> = {
  only: 0,
  uncover: 0,
  visible: 0,
  invisible: 0,
  alert: 0,
  onslide: 0,
  alt: 0,
  temporal: 1,
};

/** Longest spec body the editor recognises; anything longer is prose with a `<`. */
export const OVERLAY_SPEC_MAX = 60;

/**
 * Is `body` (the text between `<` and `>`) an overlay specification? Accepts
 * the beamer grammar generously — numbers, ranges, lists, the relative forms
 * `+`/`.` with offsets `(1)`, the mode prefixes `beamer:`/`handout:`/`all:`,
 * and action specs `1-| alert@2` — and refuses only what cannot be one: empty,
 * over-long, or carrying braces, backslashes, math or a nested angle bracket.
 * At least one digit, `+` or `.` is required so `\vec<a>` in prose (rare, but
 * `a<b` after a command is not) stays plain text.
 */
export function isOverlaySpecBody(body: string): boolean {
  if (body.length === 0 || body.length > OVERLAY_SPEC_MAX) return false;
  if (!/^[0-9A-Za-z+.,\-|@:() ]*$/.test(body)) return false;
  return /[0-9+.]/.test(body);
}

/** `<…>` immediately at `pos` in `text`, if its body {@link isOverlaySpecBody}.
 *  Returns the whole `<…>` span's end, or `null`. */
export function overlaySpecAt(text: string, pos: number): { body: string; end: number } | null {
  if (text[pos] !== "<") return null;
  const close = text.indexOf(">", pos + 1);
  if (close === -1 || close - pos - 1 > OVERLAY_SPEC_MAX) return null;
  const body = text.slice(pos + 1, close);
  if (body.includes("\n") || !isOverlaySpecBody(body)) return null;
  return { body, end: close + 1 };
}

/** Does `text` load the beamer class? `%` comments are dropped first so a
 *  commented-out `\documentclass{beamer}` under an `article` line does not count. */
export function isBeamerDocument(text: string): boolean {
  const code = text.replace(/(^|[^\\])%[^\n]*/g, "$1");
  return /\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*beamer\s*\}/.test(code);
}

/**
 * The spec body for the bar's three fields. `from` alone → `n`; with `onward` →
 * `n-`; with `to` → `n-m` (collapsed to `n` when equal, swapped when reversed);
 * `to` alone → `-m`. Nothing → `""`, which {@link isOverlaySpecBody} refuses.
 */
export function buildOverlaySpec(from: number | null, to: number | null, onward: boolean): string {
  const a = from != null && Number.isFinite(from) && from > 0 ? Math.floor(from) : null;
  const b = to != null && Number.isFinite(to) && to > 0 ? Math.floor(to) : null;
  if (a == null && b == null) return "";
  if (a == null) return `-${b}`;
  if (b != null && !onward) {
    if (b === a) return `${a}`;
    return b < a ? `${b}-${a}` : `${a}-${b}`;
  }
  return onward ? `${a}-` : `${a}`;
}

/** Where a `\begin{frame}` … `\end{frame}` around `caret` starts and ends in
 *  `text` — the whole text when the caret is outside any frame. */
export function frameBoundsAt(text: string, caret: number): { start: number; end: number } {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("\\begin{frame}");
  const closeBefore = before.lastIndexOf("\\end{frame}");
  const start = open !== -1 && open > closeBefore ? open : 0;
  const close = text.indexOf("\\end{frame}", caret);
  return { start, end: close === -1 ? text.length : close };
}

/** Every overlay spec in `text`: the `<…>` right after a control word (`\only<2>`,
 *  `\item<3->`), after a `\begin{env}`'s brace, or inside an environment's
 *  optional argument (`\begin{itemize}[<+->]`). Comments are skipped. */
export function overlaySpecsIn(text: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  const re = /\\[A-Za-z]+(?:\{[^{}\n]*\})?(?:\[)?(<)|(^|[^\\])%[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === undefined) continue; // a comment: consumed, not scanned
    const at = m.index + m[0].length - 1;
    const spec = overlaySpecAt(text, at);
    if (!spec) continue;
    out.push({ start: at, end: spec.end, body: spec.body });
    re.lastIndex = spec.end;
  }
  return out;
}

/**
 * The next unused slide number in the frame around `caret`: one past the
 * largest explicit number in any overlay spec there, or 2 when the frame has
 * none yet (slide 1 is what everything without a spec is already on).
 */
export function nextOverlayNumber(text: string, caret: number): number {
  const { start, end } = frameBoundsAt(text, caret);
  let max = 1;
  for (const s of overlaySpecsIn(text.slice(start, end))) {
    for (const n of s.body.match(/\d+/g) ?? []) {
      const v = parseInt(n, 10);
      if (v > max && v < 1000) max = v;
    }
  }
  return max + 1;
}

/** The index just past the `}` matching the `{` at `open`, honouring `\{`/`\}`
 *  escapes; `null` when unbalanced. */
function braceGroupEnd(text: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

export interface OverlayCommandAt {
  cmd: BeamerOverlayCommand;
  spec: string;
  /** Content ranges of each brace argument, in order. */
  args: Array<{ start: number; end: number }>;
  /** Just past the last argument's `}`. */
  end: number;
}

/** Parse `\cmd<spec>{…}…` starting exactly at `at` — the command must be one of
 *  {@link BEAMER_OVERLAY_COMMANDS} and carry every brace argument its arity says. */
export function parseOverlayCommandAt(text: string, at: number): OverlayCommandAt | null {
  const m = /^\\([A-Za-z]+)</.exec(text.slice(at, at + 24));
  if (!m) return null;
  const cmd = m[1] as BeamerOverlayCommand;
  if (!Object.prototype.hasOwnProperty.call(BEAMER_ARITY, cmd)) return null;
  const spec = overlaySpecAt(text, at + m[0].length - 1);
  if (!spec) return null;
  const args: Array<{ start: number; end: number }> = [];
  let pos = spec.end;
  for (let k = 0; k < BEAMER_ARITY[cmd]; k += 1) {
    if (text[pos] !== "{") return null;
    const close = braceGroupEnd(text, pos);
    if (close == null) return null;
    args.push({ start: pos + 1, end: close - 1 });
    pos = close;
  }
  return { cmd, spec: spec.body, args, end: pos };
}

/** The overlay command the selection `[start, end)` already names — either the
 *  whole `\cmd<s>{…}` or exactly one of its argument bodies (`argIndex`). */
export function overlayCommandAround(
  text: string,
  start: number,
  end: number,
): { at: number; parsed: OverlayCommandAt; argIndex: number | null } | null {
  // The whole command selected.
  if (text[start] === "\\") {
    const parsed = parseOverlayCommandAt(text, start);
    if (parsed && parsed.end === end) return { at: start, parsed, argIndex: null };
  }
  // An argument body selected: walk back over `{`, then over any earlier
  // argument groups, to the `\cmd<spec>` head.
  if (text[start - 1] !== "{") return null;
  let head = start - 1;
  for (let hops = 0; hops < 3; hops += 1) {
    const m = /\\([A-Za-z]+)<([^<>\n]{1,60})>$/.exec(text.slice(Math.max(0, head - 90), head));
    if (m) {
      const at = head - m[0].length;
      const parsed = parseOverlayCommandAt(text, at);
      if (!parsed) return null;
      const argIndex = parsed.args.findIndex((a) => a.start === start && a.end === end);
      return argIndex === -1 ? null : { at, parsed, argIndex };
    }
    // Not directly after the head: maybe after a previous argument's `}`.
    if (text[head - 1] !== "}") return null;
    let depth = 0;
    let i = head - 1;
    for (; i >= 0; i -= 1) {
      const c = text[i];
      if (i > 0 && text[i - 1] === "\\") continue;
      if (c === "}") depth += 1;
      else if (c === "{") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (i < 0) return null;
    head = i;
  }
  return null;
}

/**
 * Wrap the selection in `\cmd<spec>{…}` — or re-target the overlay command it
 * already sits in (same arity only, see the module note). Returns the new text
 * with the wrapped body selected, so applying again with another spec
 * re-targets; an empty selection leaves the caret inside the empty braces. For
 * `\alt` the caret goes into the empty second argument, for `\temporal` into the
 * empty first — the argument the author has to fill next.
 */
export function wrapBeamerOverlay(
  value: string,
  start: number,
  end: number,
  cmd: BeamerOverlayCommand,
  spec: string,
): EditResult {
  if (start > end) [start, end] = [end, start];
  const around = overlayCommandAround(value, start, end);
  if (around && BEAMER_ARITY[around.parsed.cmd] === BEAMER_ARITY[cmd]) {
    const { at, parsed, argIndex } = around;
    const oldHeadLen = `\\${parsed.cmd}<${parsed.spec}>`.length;
    const head = `\\${cmd}<${spec}>`;
    const next = value.slice(0, at) + head + value.slice(at + oldHeadLen);
    const shift = head.length - oldHeadLen;
    if (argIndex == null) {
      return { value: next, selStart: at, selEnd: parsed.end + shift };
    }
    const arg = parsed.args[argIndex];
    return { value: next, selStart: arg.start + shift, selEnd: arg.end + shift };
  }

  // A line-wise selection's trailing newline stays outside the braces.
  let body = value.slice(start, end);
  let tail = "";
  if (body.endsWith("\n")) {
    body = body.slice(0, -1);
    tail = "\n";
  }
  const arity = BEAMER_ARITY[cmd];
  const selArg = BEAMER_SELECTION_ARG[cmd];
  // Where the caret lands: the body itself for a one-argument command; for
  // `\alt` the empty second argument, for `\temporal` the empty first — the
  // branch the author has to fill next.
  const caretArg = arity > 1 ? (cmd === "alt" ? 1 : 0) : selArg;
  let text = `\\${cmd}<${spec}>`;
  let selStart = start;
  let selEnd = start;
  for (let k = 0; k < arity; k += 1) {
    text += "{";
    const at = start + text.length;
    if (k === selArg) text += body;
    if (k === caretArg) {
      selStart = at;
      selEnd = k === selArg ? at + body.length : at;
    }
    text += "}";
  }
  return {
    value: value.slice(0, start) + text + tail + value.slice(end),
    selStart,
    selEnd,
  };
}

/**
 * Stamp `<spec>` onto every `\item` in the lines the selection touches (the
 * caret's line when nothing is selected), replacing a spec already there. When
 * the spec starts with a number, each further item counts one up — `2-` gives
 * `<2->`, `<3->`, `<4->` …, the reveal-one-per-slide list that is the whole point
 * of overlays on items. A relative or other spec (`+-`) is stamped as is. `null`
 * when the lines hold no `\item`, so the caller can say so instead of silently
 * doing nothing.
 */
export function overlayItems(
  value: string,
  start: number,
  end: number,
  spec: string,
): EditResult | null {
  if (start > end) [start, end] = [end, start];
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const numbered = /^(\d+)(.*)$/.exec(spec);
  let count = 0;
  const stamped = block.replace(/\\item(?![A-Za-z])(<[^<>\n]{0,60}>)?/g, () => {
    let s = spec;
    if (numbered) {
      const base = parseInt(numbered[1], 10) + count;
      // A range `n-m` steps both ends so the window slides with the item.
      const rest = numbered[2].replace(/^-(\d+)/, (_all, m: string) => `-${parseInt(m, 10) + count}`);
      s = `${base}${rest}`;
    }
    count += 1;
    return `\\item<${s}>`;
  });
  if (count === 0) return null;
  return {
    value: value.slice(0, lineStart) + stamped + value.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + stamped.length,
  };
}

/**
 * Insert `\pause` at the caret (the selection's start), on a line of its own:
 * a newline is prepended when the caret is not at a line start and appended
 * when text follows on the line. The caret lands after `\pause`.
 */
export function insertPause(value: string, start: number, end: number): EditResult {
  if (start > end) [start, end] = [end, start];
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const atLineStart = value.slice(lineStart, start).trim() === "";
  const lineEnd = value.indexOf("\n", start);
  const restOfLine = value.slice(start, lineEnd === -1 ? value.length : lineEnd);
  const ins = `${atLineStart ? "" : "\n"}\\pause${restOfLine.trim() === "" ? "" : "\n"}`;
  const caret = start + (atLineStart ? 0 : 1) + "\\pause".length;
  return { value: value.slice(0, start) + ins + value.slice(start), selStart: caret, selEnd: caret };
}

/** The selection the beamer bar acts on, remembered from the editor's own
 *  reports (see `CodeEditor`'s `onSelectionChange` in `FileViewerPane`). `text` is what was selected,
 *  so a stale memory is recognised and ignored after the draft moved under it. */
export interface RememberedSelection {
  start: number;
  end: number;
  text: string;
}

/**
 * Which range a beamer edit applies to: the live selection when there is one,
 * else the remembered one if the draft still holds exactly that text there,
 * else the live caret. Pure so the rule is testable.
 */
export function beamerEditRange(
  value: string,
  liveStart: number,
  liveEnd: number,
  remembered: RememberedSelection | null,
): { start: number; end: number } {
  if (liveStart !== liveEnd) return { start: liveStart, end: liveEnd };
  if (
    remembered &&
    remembered.start !== remembered.end &&
    remembered.end <= value.length &&
    value.slice(remembered.start, remembered.end) === remembered.text
  ) {
    return { start: remembered.start, end: remembered.end };
  }
  return { start: liveStart, end: liveEnd };
}
