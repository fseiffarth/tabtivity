/**
 * The YAML/JSON tree model and its edit operations (#yaml).
 *
 * The tree is a VIEW ON THE TEXT, never a replacement for it: every edit is a
 * surgical splice back into the source. Re-serializing the parsed model — the
 * obvious shortcut — would rewrite the whole file and drop every comment in it,
 * which for a config file is the one thing you must not do. Splicing instead
 * keeps comments, blank lines, quoting style, anchors and key order exactly as
 * the author left them, and it is what lets Tree and Source be two views on ONE
 * draft: switching modes converts nothing, and Ctrl+S / undo / redo / format /
 * validation keep working on the text underneath.
 *
 * BOTH of YAML's syntaxes are first-class here, because real files mix them:
 *  - **block** style (`key:` / `- item`), structured by indentation, and
 *  - **flow** style (`{a: 1, b: [2, 3]}`) — which is also, exactly, JSON. A flow
 *    collection parses into real map/seq nodes with real children whether it sits
 *    on one line or spreads over twenty, so a JSON-formatted `.yml` — and a
 *    `.json` file, which is the same thing — opens as a tree rather than as one
 *    opaque blob.
 * Which syntax a node is written in decides how it is edited, and the tree keeps
 * the author's choice: a block node is spliced by LINES, a flow node by its SPAN,
 * so adding to `[a, b]` yields `[a, b, c]` and never a silent rewrite into block.
 * Every node therefore carries absolute text offsets (key, value, whole span);
 * block nodes additionally carry the lines they own.
 *
 * `strict` (set for `.json`) is the one thing the writer needs to know about the
 * dialect: JSON has no plain scalars, so a key or value written there is quoted
 * unless it is a number/bool/null.
 *
 * COMMENTS are a node's own, not scenery. A `#` is the only place a YAML file can
 * say what a key means, so each node reads the one written behind its value and the
 * run written directly above it at its own indent, the tree shows that on the key,
 * and it is editable. The consequence is in the edits: a comment TRAVELS with the
 * node it belongs to — deleting or reordering a key takes its description along,
 * because a description left behind would silently come to sit above whichever key
 * slid into that place, and describe the wrong thing.
 *
 * What it will not do: a construct it can render but could not rewrite without
 * botching it — an anchor, an alias, a merge key, a plain scalar continued across
 * lines — parses to an `editable: false` node, so the tree never offers an edit it
 * cannot make. A line it cannot classify at all fails the parse (`YamlDoc.error`)
 * and the tree defers to Source rather than showing a structure that isn't the
 * file's.
 *
 * Pure: no React, no Tauri, no fs. Unit-tested in `src/__tests__/viewers/Yaml*.test.ts`.
 */

import type { TranslationKey } from "../i18n";

export type YamlKind = "map" | "seq" | "scalar";

/** How a scalar is written, so an edit round-trips in the author's own style.
 *  "empty" is a key with no value at all (`key:`) — YAML null, and the one place
 *  a scalar can still grow children. */
export type ScalarStyle = "plain" | "single" | "double" | "block" | "empty";

export interface YamlNode {
  /** Stable across re-parses (it is the node's path), so the tree's collapse
   *  state and the row being edited survive the re-parse an edit triggers. */
  id: string;
  /** Keys and sequence indices from the document root down to this node. */
  path: (string | number)[];
  kind: YamlKind;
  /** Decoded mapping key; null for sequence items and document roots. */
  key: string | null;
  /** The key exactly as written (quotes included), or null. */
  keyRaw: string | null;
  /** Absolute offsets of the key token, for an in-place rename. */
  keyStart: number;
  keyEnd: number;
  /** Scalars: the decoded value (a block scalar's body, dedented). "" otherwise. */
  value: string;
  /** Scalars: the value exactly as written. */
  raw: string;
  style: ScalarStyle;
  /** Absolute offsets of the value token. For "empty" both sit at the insertion
   *  point right after the `:` / `-`, so writing a first value splices there. */
  valueStart: number;
  valueEnd: number;
  /** The node's whole span (key through value/children) — what a flow edit moves. */
  start: number;
  end: number;
  /** Block scalars only: the column their body lines are indented to. */
  blockIndent: number;
  /** A container written in FLOW style: its children are spliced into its own
   *  span rather than added as lines. -1 when not flow; else the `[`/`{` offset. */
  flowOpen: number;
  /** This node lives INSIDE a flow collection, so it owns a span, not lines. */
  inFlow: boolean;
  /** 0-based first line of the node. */
  line: number;
  /** 0-based last line of the node's block, children included (inclusive). */
  endLine: number;
  /** Column of the key / of the `-` (block nodes). */
  indent: number;
  /** The `#` comment written BEHIND this node, on its own line ("" when none). */
  comment: string;
  /** The `#` comment written ABOVE it: the contiguous run of comment lines directly
   *  over it at its own indent, `#` markers stripped ("" when none). A blank line
   *  or a differently-indented comment ends the run, so a node only claims prose
   *  that is unambiguously about it. */
  lead: string;
  /** Offset of the `#` that starts the trailing comment, or -1 when there is none. */
  commentStart: number;
  /** Where a trailing comment goes: the end of the node's own content on its line.
   *  -1 when the node cannot carry one at all — it lives inside a flow collection,
   *  where a `#` would swallow the closing bracket and everything up to it. */
  commentAnchor: number;
  /** Whether the tree may rewrite this node's value in place. */
  editable: boolean;
  /** Whether this node can be removed on its own. */
  deletable: boolean;
  /** This entry STARTS ON ITS LIST ITEM'S DASH LINE (`- name: a` → the `name`
   *  key, `- - x` → the first nested item): its first line is shared with the
   *  dash, so every whole-line edit must splice around the dash — take the line's
   *  content but leave (or hand over) the `- ` prefix — rather than take the
   *  line. Its `lead` is also NOT its own to move: a comment run above the dash
   *  line reads as the item's prose and stays put. */
  onDash?: boolean;
  /** Whether this node's comment lives ABOVE its line (a lead comment) rather than
   *  behind it. Set for a mapping/sequence written on a `-` dash line: a comment
   *  behind that line would belong to the item's first child (which owns the line),
   *  so the whole entry is documented on the line above it instead. */
  leadComment?: boolean;
  children: YamlNode[];
}

/** True when the container is written in flow (`{…}` / `[…]`, i.e. JSON) style. */
export function isFlow(node: YamlNode): boolean {
  return node.flowOpen >= 0;
}

export interface YamlDoc {
  /** One synthetic root per YAML document (`---`-separated); usually just one. */
  docs: YamlNode[];
  /** First construct the tree could not classify — the tree defers to Source.
   *  The reason is an i18n key (plus its vars), resolved by whoever renders it. */
  error: { line: number; messageKey: TranslationKey; messageVars?: Record<string, string> } | null;
  /** The document's own indent step, so inserted lines match the file's style. */
  indentStep: number;
  /** JSON dialect: no plain scalars, so what is written is quoted or numeric. */
  strict: boolean;
}

/** The value a new entry is created with. Mirrors the type picker in the UI. */
export type YamlValueType = "text" | "number" | "boolean" | "null" | "map" | "seq";

function extOf(path: string): string {
  const name = (path.split(/[/\\]/).filter(Boolean).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function isYamlPath(path: string): boolean {
  const ext = extOf(path);
  return ext === ".yaml" || ext === ".yml";
}

/** JSON is YAML's flow syntax, so it gets the same tree — written back in the
 *  stricter dialect (see {@link YamlDoc.strict}). */
export function isJsonPath(path: string): boolean {
  return extOf(path) === ".json";
}

/** Every path the structure tree can edit. */
export function isTreePath(path: string): boolean {
  return isYamlPath(path) || isJsonPath(path);
}

// ── Text plumbing ───────────────────────────────────────────────────────────
// Block edits address whole lines, flow edits address spans; both splice into the
// original string by offset, so nothing outside the edited region — including a
// mixed or missing trailing newline — is rewritten.

interface LineIndex {
  lines: string[];
  /** Offset of each line's first character. */
  starts: number[];
  eol: string;
}

function indexLines(text: string): LineIndex {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (;;) {
    const nl = text.indexOf("\n", at);
    starts.push(at);
    if (nl === -1) {
      lines.push(text.slice(at));
      break;
    }
    const end = nl > at && text[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push(text.slice(at, end));
    at = nl + 1;
  }
  return { lines, starts, eol };
}

function lineOfOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The plain splice every edit ultimately reduces to. */
function splice(text: string, from: number, to: number, next: string): string {
  return text.slice(0, from) + next + text.slice(to);
}

/** Replace lines [from..to] (inclusive) with `next`; `next` empty deletes them. */
function replaceLines(text: string, from: number, to: number, next: string[]): string {
  const idx = indexLines(text);
  if (from < 0 || to >= idx.lines.length || from > to) return text;
  const start = idx.starts[from];
  const end = to + 1 < idx.starts.length ? idx.starts[to + 1] : text.length;
  // Only re-terminate the replacement when the region we cut was terminated —
  // otherwise a file with no trailing newline would grow one.
  const cutEndedWithEol = end > start && text[end - 1] === "\n";
  let body = next.map((l) => l + idx.eol).join("");
  if (body && !cutEndedWithEol) body = body.slice(0, -idx.eol.length);
  return splice(text, start, end, body);
}

/** Insert `next` before line `at` (== line count appends at EOF). */
function insertLines(text: string, at: number, next: string[]): string {
  if (!next.length) return text;
  const idx = indexLines(text);
  if (at >= idx.lines.length) {
    const needsEol = text.length > 0 && !text.endsWith("\n");
    return text + (needsEol ? idx.eol : "") + next.map((l) => l + idx.eol).join("");
  }
  const start = idx.starts[Math.max(0, at)];
  return splice(text, start, start, next.map((l) => l + idx.eol).join(""));
}

// ── Encoding ────────────────────────────────────────────────────────────────

const SPECIAL_FIRST = new Set([
  "-", "?", ":", ",", "[", "]", "{", "}", "#", "&", "*", "!", "|", ">", "'", '"',
  "%", "@", "`",
]);

/** True when the value must be quoted to survive a round-trip as written.
 *
 *  `flow` is the context the value is being written INTO, and it is not
 *  cosmetic: inside a flow collection (`[a, b]`, `{k: v}` — i.e. every JSON-
 *  shaped region) the structural characters end the scalar wherever they appear,
 *  so an unquoted `a, b` written into `[x]` becomes TWO items and an unquoted
 *  `a]b` closes the collection early and tears the rest of the file. In block
 *  context those same characters are ordinary text and quoting them would
 *  rewrite perfectly good plain scalars, which is why this is a parameter and
 *  not a blanket rule — the same bargain `bib.ts`'s `bibLiteral(value, delim)`
 *  and `table.ts`'s `encodeCell(v, delimiter)` already strike. */
export function needsQuoting(value: string, flow = false): boolean {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  if (SPECIAL_FIRST.has(value[0])) return true;
  if (value.includes(": ") || value.endsWith(":")) return true;
  if (value.includes(" #")) return true;
  if (/[\n\r\t]/.test(value)) return true;
  if (flow && /[,[\]{}]/.test(value)) return true;
  return false;
}

/** True when a plain (unquoted) `value` would be read back as a non-string —
 *  a number, a bool, a null. Quoting is what makes "no" the string "no". */
export function parsesAsNonString(value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  if (/^-?(\d+|\d*\.\d+)([eE][+-]?\d+)?$/.test(v)) return true;
  if (/^0[xob][0-9a-fA-F_]+$/.test(v)) return true;
  return /^(true|false|yes|no|on|off|null|~)$/i.test(v);
}

/** True when `v` is a bare JSON literal — the only things JSON leaves unquoted. */
function isJsonLiteral(v: string): boolean {
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v) || v === "true" || v === "false" || v === "null";
}

function encodeDouble(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function encodeSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Write `value` back in `style`, falling back to a quoted form when the style
 * cannot carry it. In `strict` (JSON) there are no plain scalars at all, so
 * anything that is not a bare literal comes back quoted.
 */
export function encodeScalar(
  value: string,
  style: ScalarStyle,
  strict = false,
  flow = false,
): string {
  if (style === "double") return encodeDouble(value);
  if (style === "single") return value.includes("\n") ? encodeDouble(value) : encodeSingle(value);
  if (strict) return isJsonLiteral(value.trim()) ? value.trim() : encodeDouble(value);
  return needsQuoting(value, flow) ? encodeDouble(value) : value;
}

/** A mapping key, quoted only when it must be — which in JSON is always. */
export function encodeKey(key: string, strict = false, flow = false): string {
  if (
    strict ||
    key === "" ||
    /^\s|\s$/.test(key) ||
    SPECIAL_FIRST.has(key[0]) ||
    key.includes(":") ||
    key.includes("#") ||
    // A key is a scalar too, and inside `{…}` it ends at the first `,` or brace
    // exactly as a value does — `{a: 1, x,y: 2}` is not a two-key mapping.
    (flow && /[,[\]{}]/.test(key))
  ) {
    return encodeDouble(key);
  }
  return key;
}

/**
 * The literal a newly added entry is written with. In YAML, `text` quotes whenever
 * a plain token would read back as a number/bool/null, so the type the user picked
 * is the type the file gets; in JSON every string is quoted anyway. A container is
 * created as an EMPTY FLOW collection (`{}` / `[]`) — a real, empty collection in
 * either dialect, which the tree then adds children to in flow style.
 */
export function literalFor(
  type: YamlValueType,
  value: string,
  strict = false,
  flow = false,
): string {
  switch (type) {
    case "number":
      return value.trim() === "" ? "0" : value.trim();
    case "boolean":
      return value.trim().toLowerCase() === "true" ? "true" : "false";
    case "null":
      return "null";
    case "map":
      return "{}";
    case "seq":
      return "[]";
    default:
      if (strict) return encodeDouble(value);
      return needsQuoting(value, flow) || parsesAsNonString(value) ? encodeDouble(value) : value;
  }
}

function decodeDouble(raw: string): string {
  const body = raw.slice(1, -1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, esc: string) => {
    if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      default: return esc;
    }
  });
}

function decodeSingle(raw: string): string {
  return raw.slice(1, -1).replace(/''/g, "'");
}

function decodeQuoted(raw: string): string {
  return raw[0] === '"' ? decodeDouble(raw) : decodeSingle(raw);
}

// ── Scanning ────────────────────────────────────────────────────────────────

/** End index (exclusive) of the quoted token starting at `start`, or -1 when it is
 *  not terminated in `s`. Used on a single line (block) and on the whole text
 *  (flow), which is why it takes the string rather than a line. */
function scanQuoted(s: string, start: number): number {
  const q = s[start];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (q === '"' && c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

const BLOCK_HEADER = /^[|>][+-]?\d*\s*(#.*)?$/;

interface ScannedValue {
  raw: string;
  value: string;
  style: ScalarStyle;
  valueCol: number;
  valueEnd: number;
  /** An unterminated quote — the scalar continues on the next line. */
  open: boolean;
  /** An anchor/alias/tag prefix — we render it, we never rewrite it. */
  opaque: boolean;
  /** A block scalar header (`|`, `>-`, …) — its body is on the lines below. */
  block: boolean;
  /** A flow collection starts here — the flow parser takes over at `valueCol`. */
  flow: boolean;
}

const NO_FLAGS = { open: false, opaque: false, block: false, flow: false };

/** Read the value token that starts at/after `from` on `line`. `from` is the
 *  insertion point (just past the `:` or `-`), so an empty value reports itself
 *  there and a first value splices in exactly the right place. */
function readValue(line: string, from: number): ScannedValue {
  let i = from;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (i >= line.length || line[i] === "#") {
    return { raw: "", value: "", style: "empty", valueCol: from, valueEnd: from, ...NO_FLAGS };
  }

  const c = line[i];
  if (c === '"' || c === "'") {
    const end = scanQuoted(line, i);
    if (end < 0) {
      return {
        raw: line.slice(i), value: line.slice(i), style: "plain",
        valueCol: i, valueEnd: line.length, ...NO_FLAGS, open: true,
      };
    }
    const raw = line.slice(i, end);
    return {
      raw, value: decodeQuoted(raw), style: c === '"' ? "double" : "single",
      valueCol: i, valueEnd: end, ...NO_FLAGS,
    };
  }

  if (c === "[" || c === "{") {
    // The flow parser owns this — it may well run past the end of the line.
    return { raw: "", value: "", style: "plain", valueCol: i, valueEnd: i, ...NO_FLAGS, flow: true };
  }

  const rest = line.slice(i);
  if (BLOCK_HEADER.test(rest)) {
    const header = rest.replace(/\s*#.*$/, "");
    return {
      raw: header, value: "", style: "block",
      valueCol: i, valueEnd: i + header.length, ...NO_FLAGS, block: true,
    };
  }

  // Plain scalar: runs to a ` #` comment or the end of the line.
  let end = line.length;
  for (let j = i; j < line.length; j++) {
    if (line[j] === "#" && j > i && (line[j - 1] === " " || line[j - 1] === "\t")) {
      end = j;
      break;
    }
  }
  while (end > i && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  const raw = line.slice(i, end);
  return {
    raw, value: raw, style: "plain", valueCol: i, valueEnd: end,
    ...NO_FLAGS, opaque: c === "&" || c === "*" || c === "!",
  };
}

interface ScannedKey {
  keyRaw: string;
  key: string;
  keyCol: number;
  keyEnd: number;
  /** Column just past the `:`, where the value begins. */
  afterColon: number;
}

/** Read a block mapping key starting at `from`, or null when this line does not
 *  open a mapping entry (no `:` terminator before a comment/EOL). */
function readKey(line: string, from: number): ScannedKey | null {
  const c = line[from];
  if (c === undefined || c === "#") return null;

  let keyEnd: number;
  if (c === '"' || c === "'") {
    const end = scanQuoted(line, from);
    if (end < 0) return null;
    keyEnd = end;
  } else {
    let j = from;
    let found = -1;
    while (j < line.length) {
      const ch = line[j];
      if (ch === "#" && j > from && line[j - 1] === " ") return null;
      if (ch === ":" && (j + 1 === line.length || line[j + 1] === " " || line[j + 1] === "\t")) {
        found = j;
        break;
      }
      j++;
    }
    if (found < 0) return null;
    keyEnd = found;
    while (keyEnd > from && (line[keyEnd - 1] === " " || line[keyEnd - 1] === "\t")) keyEnd--;
  }

  let colon = keyEnd;
  while (colon < line.length && (line[colon] === " " || line[colon] === "\t")) colon++;
  if (line[colon] !== ":") return null;

  const keyRaw = line.slice(from, keyEnd);
  const key = keyRaw[0] === '"' || keyRaw[0] === "'" ? decodeQuoted(keyRaw) : keyRaw;
  return { keyRaw, key, keyCol: from, keyEnd, afterColon: colon + 1 };
}

/** A flow mapping key, addressed by absolute offsets (it can sit anywhere). */
interface FlowKey {
  keyRaw: string;
  key: string;
  start: number;
  end: number;
  /** Offset just past the `:`. */
  colonEnd: number;
}

interface FlowScalar {
  raw: string;
  value: string;
  style: ScalarStyle;
  start: number;
  end: number;
}

// ── Parser ──────────────────────────────────────────────────────────────────

class Bail extends Error {
  constructor(
    readonly line: number,
    readonly reasonKey: TranslationKey,
    readonly reasonVars?: Record<string, string>,
  ) {
    super(reasonKey);
  }
}

/** The deepest nesting the tree reads, counted across block AND flow levels
 *  (a node's `path` length). Every recursion in the parser adds one path segment
 *  per level, so this bounds the parser's stack, the O(depth²) `path` copies and
 *  every recursive walk of the tree after it. Past it the file bails like any
 *  other construct the tree can't model, instead of a `RangeError` escaping the
 *  render: `[[[[…` or `- - - - …` costs two bytes a level. */
export const MAX_YAML_DEPTH = 512;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === "";
const isComment = (line: string): boolean => line.trimStart().startsWith("#");
const isDirective = (line: string): boolean => line.startsWith("%");
const isDocStart = (line: string): boolean => line === "---" || line.startsWith("--- ");
const isDocEnd = (line: string): boolean => line === "..." || line.startsWith("... ");

/** Parse `text` into one tree per YAML document. Never throws: a construct the
 *  tree cannot model comes back as `error` with the offending 1-based line. */
export function parseYaml(text: string, opts: { strict?: boolean } = {}): YamlDoc {
  const strict = !!opts.strict;
  const { lines, starts } = indexLines(text);
  const parser = new Parser(lines, starts, text);
  try {
    const docs = parser.parseDocuments();
    return { docs, error: null, indentStep: parser.indentStep(docs), strict };
  } catch (e) {
    if (e instanceof Bail) {
      return {
        docs: [],
        error: {
          line: e.line + 1,
          messageKey: e.reasonKey,
          ...(e.reasonVars ? { messageVars: e.reasonVars } : {}),
        },
        indentStep: 2,
        strict,
      };
    }
    throw e;
  }
}

class Parser {
  private i = 0;
  /** A copy of the source lines in which a sequence dash is blanked to a space, so
   *  a mapping written inline after it (`- name: a`) is read at its true column.
   *  Same length as the original line, so every column we record is a valid offset
   *  into the real text. */
  private view: string[];

  constructor(
    private readonly lines: string[],
    private readonly starts: number[],
    private readonly text: string,
  ) {
    this.view = lines.slice();
  }

  private off(line: number, col: number): number {
    return this.starts[line] + col;
  }

  private lineOf(offset: number): number {
    return lineOfOffset(this.starts, offset);
  }

  /** Refuse a collection nested past {@link MAX_YAML_DEPTH}; `line` is 0-based. */
  private checkDepth(path: (string | number)[], line: number): void {
    if (path.length > MAX_YAML_DEPTH) {
      throw new Bail(line, "yamlParse.tooDeep", { max: String(MAX_YAML_DEPTH) });
    }
  }

  private lineEnd(line: number): number {
    return this.off(line, this.lines[line]?.length ?? 0);
  }

  /** The comment run written directly ABOVE line `at` at column `indent`. A blank
   *  line, a differently-indented comment, or any real content ends it — so a node
   *  claims only the prose that is unambiguously about it, and never the section
   *  header two keys up. */
  private leadAt(at: number, indent: number): string {
    const out: string[] = [];
    for (let j = at - 1; j >= 0; j--) {
      const l = this.lines[j];
      if (!isComment(l) || indentOf(l) !== indent) break;
      out.unshift(l.trimStart().replace(/^#[ \t]?/, ""));
    }
    return out.join("\n");
  }

  /** Attach a block node's `#` comments. `col` is where its own content ends on
   *  `line` — always past its key and value tokens, so a `#` inside a quoted string
   *  can never be mistaken for the start of a comment. */
  private annotate(node: YamlNode, line: number, col: number): YamlNode {
    const l = this.lines[line] ?? "";
    const hash = l.indexOf("#", col);
    node.comment = hash < 0 ? "" : l.slice(hash + 1).trim();
    node.commentStart = hash < 0 ? -1 : this.off(line, hash);
    node.commentAnchor = this.off(line, col);
    node.lead = this.leadAt(node.line, node.indent);
    return node;
  }

  parseDocuments(): YamlNode[] {
    const docs: YamlNode[] = [];
    let docIndex = 0;
    this.skipIgnorable();
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (isDocStart(l) || isDocEnd(l)) {
        this.i++;
        this.skipIgnorable();
        continue;
      }
      const root = this.parseCollection(indentOf(this.view[this.i]), [], docIndex);
      if (root) docs.push(root);
      docIndex++;
      this.skipIgnorable();
    }
    return docs;
  }

  /** The document's own indent step, read off its first block nesting; 2 default. */
  indentStep(docs: YamlNode[]): number {
    const walk = (n: YamlNode): number | null => {
      if (!isFlow(n) && n.key !== null) {
        for (const c of n.children) {
          if (!c.inFlow && c.indent > n.indent) return c.indent - n.indent;
        }
      }
      for (const c of n.children) {
        const deeper = walk(c);
        if (deeper) return deeper;
      }
      return null;
    };
    for (const d of docs) {
      const step = walk(d);
      if (step && step > 0) return step;
    }
    return 2;
  }

  private skipIgnorable(): void {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (isBlank(l) || isComment(l) || isDirective(l)) this.i++;
      else break;
    }
  }

  /** True when the cursor sits on a line that ends the current block. */
  private atBoundary(): boolean {
    if (this.i >= this.lines.length) return true;
    const l = this.lines[this.i];
    return isDocStart(l) || isDocEnd(l);
  }

  /** Parse whatever block starts at the cursor at column `indent`. */
  private parseCollection(
    indent: number,
    path: (string | number)[],
    docIndex: number,
  ): YamlNode | null {
    this.skipIgnorable();
    if (this.atBoundary()) return null;
    if (/^\t/.test(this.lines[this.i])) {
      throw new Bail(this.i, "yamlParse.tabs");
    }
    const line = this.view[this.i];
    // A document written in flow/JSON syntax, however many lines it spans. This is
    // what makes a JSON file — and a JSON-formatted .yml — a tree.
    if (line[indent] === "{" || line[indent] === "[") {
      return this.takeFlow(this.off(this.i, indent), path, docIndex, null, indent);
    }
    if (this.isSeqDash(line, indent)) return this.parseSeq(indent, path, docIndex);
    return this.parseMap(indent, path, docIndex);
  }

  /** Parse a flow collection, then resume block parsing on the line after it. */
  private takeFlow(
    at: number,
    path: (string | number)[],
    docIndex: number,
    k: ScannedKey | null,
    indent: number,
  ): YamlNode {
    const keyLine = this.lineOf(at);
    const fk: FlowKey | null = k
      ? {
          keyRaw: k.keyRaw,
          key: k.key,
          start: this.off(keyLine, k.keyCol),
          end: this.off(keyLine, k.keyEnd),
          colonEnd: this.off(keyLine, k.afterColon),
        }
      : null;
    const node = this.parseFlowCollection(at, path, docIndex, fk, false);
    node.line = keyLine;
    node.endLine = this.lineOf(node.end);
    node.indent = indent;
    // Its key sits on a block line, so it can carry a comment after all — behind the
    // closing bracket, wherever the author put that.
    this.annotate(node, node.endLine, node.end - this.starts[node.endLine]);
    // A flow value can run past its own line; block parsing resumes after it.
    this.i = node.endLine + 1;
    return node;
  }

  private isSeqDash(line: string, indent: number): boolean {
    return line[indent] === "-" && (line.length === indent + 1 || line[indent + 1] === " ");
  }

  private parseMap(indent: number, path: (string | number)[], docIndex: number): YamlNode {
    this.checkDepth(path, this.i);
    const start = this.i;
    const children: YamlNode[] = [];
    let endLine = start;

    for (;;) {
      this.skipIgnorable();
      if (this.atBoundary()) break;
      const line = this.view[this.i];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Bail(this.i, "yamlParse.indent");
      if (this.isSeqDash(line, ind)) break;
      if (line.slice(ind).startsWith("? ")) {
        throw new Bail(this.i, "yamlParse.explicitKey");
      }

      const child = this.parseMapEntry(indent, path, docIndex);
      children.push(child);
      endLine = child.endLine;
    }

    return this.container("map", null, path, docIndex, start, endLine, indent, children);
  }

  /** One `key: …` entry, including whatever block hangs below it. */
  private parseMapEntry(indent: number, path: (string | number)[], docIndex: number): YamlNode {
    const at = this.i;
    const line = this.view[at];
    const k = readKey(line, indent);
    if (!k) throw new Bail(at, "yamlParse.notAPairLine");
    const childPath = [...path, k.key];
    const v = readValue(line, k.afterColon);
    this.i++;
    if (v.flow) return this.takeFlow(this.off(at, v.valueCol), childPath, docIndex, k, indent);
    return this.finishValue(at, indent, k, v, childPath, docIndex);
  }

  private parseSeq(indent: number, path: (string | number)[], docIndex: number): YamlNode {
    this.checkDepth(path, this.i);
    const start = this.i;
    const items: YamlNode[] = [];
    let endLine = start;

    for (;;) {
      this.skipIgnorable();
      if (this.atBoundary()) break;
      const line = this.view[this.i];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent || !this.isSeqDash(line, ind)) break;

      const item = this.parseSeqItem(indent, [...path, items.length], docIndex);
      items.push(item);
      endLine = item.endLine;
    }

    return this.container("seq", null, path, docIndex, start, endLine, indent, items);
  }

  private parseSeqItem(indent: number, path: (string | number)[], docIndex: number): YamlNode {
    const at = this.i;
    const line = this.view[at];
    // The content column: the first non-space after the dash.
    let content = indent + 1;
    while (content < line.length && line[content] === " ") content++;
    const rest = line.slice(content);

    if (rest === "" || rest.startsWith("#")) {
      // A bare `-`: whatever hangs below it (indented past the dash) is the item.
      this.i++;
      const child = this.childBlock(indent, path, docIndex);
      if (child) {
        const node = this.container(
          child.kind, null, path, docIndex, at, child.endLine, indent, child.children,
        );
        node.flowOpen = child.flowOpen;
        node.end = child.end;
        return node;
      }
      return this.scalar(null, path, docIndex, at, indent, {
        raw: "", value: "", style: "empty",
        valueCol: indent + 1, valueEnd: indent + 1, ...NO_FLAGS,
      }, true, true);
    }

    if (this.isSeqDash(line, content)) {
      // `- - x` — the item is a nested SEQUENCE that starts on the dash's own line.
      // Same trick as `- key: value` below: blank the outer dash in the parse view
      // so the nested list reads at column `content`, where the items it continues
      // with on the lines below also sit. It nests to any depth (`- - - x`), because
      // each level blanks its own dash before handing on.
      this.view[at] = line.slice(0, indent) + " " + line.slice(indent + 1);
      const seq = this.parseSeq(content, path, docIndex);
      // The nested list's first entry shares the outer item's dash line, so its
      // whole-line edits must splice around the dash (see YamlNode.onDash).
      if (seq.children.length) seq.children[0].onDash = true;
      return {
        ...seq,
        line: at,
        indent,
        path,
        id: idFor(docIndex, path),
        start: this.off(at, indent),
        // The item is written at the dash's column, so that is where the prose about
        // it sits — not at the nested list's.
        lead: this.leadAt(at, indent),
        // A comment on this item is written above its dash line (a comment behind
        // it would belong to the nested list's first entry, which owns the line).
        leadComment: true,
      };
    }

    // `- {a: 1}` / `- [1, 2]`: the item is a flow collection.
    if (line[content] === "{" || line[content] === "[") {
      const node = this.takeFlow(this.off(at, content), path, docIndex, null, indent);
      node.start = this.off(at, indent);
      return node;
    }

    const k = readKey(line, content);
    if (k) {
      // `- key: value` — the item is a mapping that starts on the dash's own line.
      // Blank the dash in the parse view so the mapping reads at column `content`,
      // where its siblings on the lines below also sit.
      this.view[at] = line.slice(0, indent) + " " + line.slice(indent + 1);
      const map = this.parseMap(content, path, docIndex);
      // The first key shares the item's dash line, so its whole-line edits must
      // splice around the dash (see YamlNode.onDash).
      if (map.children.length) map.children[0].onDash = true;
      return {
        ...map,
        line: at,
        indent,
        path,
        id: idFor(docIndex, path),
        start: this.off(at, indent),
        lead: this.leadAt(at, indent),
        // A comment on this item is written above its dash line — behind it would
        // belong to the first key, which owns the line (`- name: a  # …`).
        leadComment: true,
      };
    }

    const v = readValue(line, content);
    this.i++;
    return this.finishValue(at, indent, null, v, path, docIndex);
  }

  /**
   * Turn a scanned (non-flow) value into a node, consuming whatever it drags
   * along: a block scalar's body, an unterminated quote's continuation lines, a
   * nested block hanging under an empty value, or a plain scalar continued across
   * lines.
   */
  private finishValue(
    at: number,
    indent: number,
    k: ScannedKey | null,
    v: ScannedValue,
    path: (string | number)[],
    docIndex: number,
  ): YamlNode {
    if (v.block) {
      const { endLine, blockIndent, body } = this.readBlockBody(at, indent);
      const node = this.scalar(k, path, docIndex, at, indent, { ...v, value: body }, true, true);
      node.endLine = endLine;
      node.blockIndent = blockIndent;
      node.end = this.lineEnd(endLine);
      return node;
    }

    if (v.open) {
      // An unterminated quote: swallow lines until it closes. We can render it, we
      // will never rewrite it.
      const endLine = this.consumeOpenQuote(at, v);
      const node = this.scalar(k, path, docIndex, at, indent, v, false, true);
      node.endLine = endLine;
      node.end = this.lineEnd(endLine);
      return node;
    }

    if (v.style === "empty" || (v.opaque && v.raw !== "" && this.hasChildBlock(indent))) {
      // A block sequence may sit at the SAME column as its key — `key:` on one
      // line, `- item` at the key's own indent below — which is valid YAML (a
      // sequence needn't indent past its key). `childBlock` only sees a deeper
      // block, so try the same-indent sequence when it finds nothing.
      const child = this.childBlock(indent, path, docIndex)
        ?? this.sameIndentSeq(indent, path, docIndex);
      if (child) {
        const node = this.container(
          child.kind, k, path, docIndex, at, child.endLine, indent, child.children,
        );
        node.flowOpen = child.flowOpen;
        node.valueStart = this.off(at, v.valueCol);
        node.valueEnd = this.off(at, v.valueEnd);
        node.raw = v.raw;
        node.editable = !v.opaque;
        node.end = child.end;
        // The key's own line ends here, so a comment behind it is this node's.
        return this.annotate(node, at, v.valueEnd);
      }
      return this.scalar(k, path, docIndex, at, indent, v, !v.opaque, true);
    }

    // A scalar with a value. If more-indented lines follow, it is a plain scalar
    // continued across lines — legal YAML we render but do not rewrite.
    if (this.hasChildBlock(indent)) {
      const endLine = this.consumeIndentedBlock(indent);
      const joined = [v.raw, ...this.lines.slice(at + 1, endLine + 1).map((l) => l.trim())].join(" ");
      const node = this.scalar(k, path, docIndex, at, indent, { ...v, value: joined }, false, true);
      node.endLine = endLine;
      node.end = this.lineEnd(endLine);
      return node;
    }

    return this.scalar(k, path, docIndex, at, indent, v, !v.opaque, true);
  }

  /** True when the line at the cursor belongs to a block nested under `indent`. */
  private hasChildBlock(indent: number): boolean {
    const save = this.i;
    this.skipIgnorable();
    const ok = !this.atBoundary() && indentOf(this.view[this.i]) > indent;
    this.i = save;
    return ok;
  }

  /** Parse the block nested under a key at `indent`, or null when there is none. */
  private childBlock(indent: number, path: (string | number)[], docIndex: number): YamlNode | null {
    if (!this.hasChildBlock(indent)) return null;
    this.skipIgnorable();
    return this.parseCollection(indentOf(this.view[this.i]), path, docIndex);
  }

  /**
   * A key's value written as a block SEQUENCE at the key's OWN column — valid
   * YAML (a sequence needn't indent past its key), e.g.
   *     values:
   *     - 1
   *     - 2
   * Unambiguous in a mapping: a bare `- item` at the key's indent can only be
   * that key's value, since a map holds `key:` entries, never a lone seq item.
   * (This is why it's resolved here, not in `childBlock`, which is also called for
   * a bare `-` seq item, where a same-indent dash is a SIBLING, not a child.)
   * Returns null — cursor untouched — when the next line isn't such a sequence.
   */
  private sameIndentSeq(
    indent: number,
    path: (string | number)[],
    docIndex: number,
  ): YamlNode | null {
    const save = this.i;
    this.skipIgnorable();
    if (
      this.atBoundary() ||
      indentOf(this.view[this.i]) !== indent ||
      !this.isSeqDash(this.view[this.i], indent)
    ) {
      this.i = save;
      return null;
    }
    return this.parseSeq(indent, path, docIndex);
  }

  /** Consume the lines indented past `indent` (a plain scalar's continuation). */
  private consumeIndentedBlock(indent: number): number {
    let end = this.i - 1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (isBlank(l) || isDocStart(l) || isDocEnd(l) || indentOf(l) <= indent) break;
      end = this.i;
      this.i++;
    }
    return end;
  }

  /** Consume a block scalar's body: every line indented past the header's key. */
  private readBlockBody(
    at: number,
    indent: number,
  ): { endLine: number; blockIndent: number; body: string } {
    const bodyLines: string[] = [];
    let endLine = at;
    let blockIndent = -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (isBlank(l)) {
        bodyLines.push("");
        this.i++;
        continue;
      }
      if (isDocStart(l) || isDocEnd(l) || indentOf(l) <= indent) break;
      if (blockIndent < 0) blockIndent = indentOf(l);
      bodyLines.push(l.slice(Math.min(blockIndent, indentOf(l))));
      endLine = this.i;
      this.i++;
    }
    // Trailing blank lines are not part of the node's block: an insertion after it
    // should land on them, not past them.
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
    if (blockIndent < 0) blockIndent = indent + 2;
    return { endLine, blockIndent, body: bodyLines.join("\n") };
  }

  /** Swallow the continuation lines of an unterminated quoted scalar. */
  private consumeOpenQuote(at: number, v: ScannedValue): number {
    const quote = this.lines[at][v.valueCol];
    let end = at;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      end = this.i;
      this.i++;
      if (l.includes(quote)) break;
    }
    return end;
  }

  // ── Flow (JSON) syntax ────────────────────────────────────────────────────
  // Offset-driven, because a flow collection is a span, not a set of lines: it may
  // sit inline (`[a, b]`) or spread over twenty, and its children are edited by
  // splicing that span rather than by rewriting whole lines.

  /** Skip whitespace, newlines and comments from `o`. */
  private ws(o: number): number {
    const t = this.text;
    while (o < t.length) {
      const c = t[o];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        o++;
        continue;
      }
      if (c === "#") {
        while (o < t.length && t[o] !== "\n") o++;
        continue;
      }
      break;
    }
    return o;
  }

  /**
   * Parse the flow collection whose `[`/`{` is at `at`. `k` is the mapping key it
   * is the value of, when it is one — the node then spans from that key, so
   * deleting it takes the key with it.
   */
  private parseFlowCollection(
    at: number,
    path: (string | number)[],
    docIndex: number,
    k: FlowKey | null,
    inFlow: boolean,
  ): YamlNode {
    this.checkDepth(path, this.lineOf(at));
    const t = this.text;
    const isSeq = t[at] === "[";
    const close = isSeq ? "]" : "}";
    const children: YamlNode[] = [];

    let p = this.ws(at + 1);
    while (p < t.length && t[p] !== close) {
      if (t[p] === ",") {
        p = this.ws(p + 1);
        continue;
      }
      const child = isSeq
        ? this.parseFlowValue(p, [...path, children.length], docIndex, null)
        : this.parseFlowEntry(p, path, docIndex);
      children.push(child);
      const next = this.ws(child.end);
      if (next <= p) break; // no progress: refuse to spin
      p = next;
    }
    if (p >= t.length || t[p] !== close) {
      throw new Bail(this.lineOf(at), "yamlParse.neverClosed", { open: t[at] });
    }
    const end = p + 1;
    const line = this.lineOf(at);

    return {
      id: idFor(docIndex, path),
      path,
      kind: isSeq ? "seq" : "map",
      key: k?.key ?? null,
      keyRaw: k?.keyRaw ?? null,
      keyStart: k?.start ?? -1,
      keyEnd: k?.end ?? -1,
      value: "",
      raw: "",
      style: "empty",
      valueStart: at,
      valueEnd: end,
      start: k ? k.start : at,
      end,
      blockIndent: -1,
      flowOpen: at,
      inFlow,
      line,
      endLine: this.lineOf(end),
      indent: -1,
      // Inside a flow collection a `#` would swallow the closing bracket, so there
      // is nowhere to put one. `takeFlow` annotates the outermost node — the one
      // whose key sits on a block line, where a comment is safe.
      comment: "",
      lead: "",
      commentStart: -1,
      commentAnchor: -1,
      editable: true,
      deletable: true,
      children,
    };
  }

  /** One `key: value` entry inside a flow mapping. */
  private parseFlowEntry(at: number, path: (string | number)[], docIndex: number): YamlNode {
    const t = this.text;
    const k = this.readFlowKey(at);
    if (!k) {
      throw new Bail(this.lineOf(at), "yamlParse.notAPair");
    }
    const childPath = [...path, k.key];
    const p = this.ws(k.colonEnd);
    // `{a: , b: 1}` — an empty value; the insertion point is right after the colon.
    if (p >= t.length || t[p] === "," || t[p] === "}" || t[p] === "]") {
      return this.flowScalar(childPath, docIndex, k, {
        raw: "", value: "", style: "empty", start: k.colonEnd, end: k.colonEnd,
      });
    }
    return this.parseFlowValue(p, childPath, docIndex, k);
  }

  /** A value inside a flow collection: a nested collection, or a scalar. */
  private parseFlowValue(
    at: number,
    path: (string | number)[],
    docIndex: number,
    k: FlowKey | null,
  ): YamlNode {
    const c = this.text[at];
    if (c === "[" || c === "{") return this.parseFlowCollection(at, path, docIndex, k, true);
    return this.flowScalar(path, docIndex, k, this.readFlowScalar(at));
  }

  private flowScalar(
    path: (string | number)[],
    docIndex: number,
    k: FlowKey | null,
    s: FlowScalar,
  ): YamlNode {
    const opaque = s.raw[0] === "&" || s.raw[0] === "*" || s.raw[0] === "!";
    return {
      id: idFor(docIndex, path),
      path,
      kind: "scalar",
      key: k?.key ?? null,
      keyRaw: k?.keyRaw ?? null,
      keyStart: k?.start ?? -1,
      keyEnd: k?.end ?? -1,
      value: s.value,
      raw: s.raw,
      style: s.style,
      valueStart: s.start,
      valueEnd: s.end,
      start: k ? k.start : s.start,
      end: s.end,
      blockIndent: -1,
      flowOpen: -1,
      inFlow: true,
      line: this.lineOf(k ? k.start : s.start),
      endLine: this.lineOf(s.end),
      indent: -1,
      comment: "",
      lead: "",
      commentStart: -1,
      commentAnchor: -1,
      editable: !opaque,
      deletable: true,
      children: [],
    };
  }

  /** A flow mapping key: quoted or plain, terminated by `:`. */
  private readFlowKey(at: number): FlowKey | null {
    const t = this.text;
    const c = t[at];
    let end: number;
    if (c === '"' || c === "'") {
      end = scanQuoted(t, at);
      if (end < 0) return null;
    } else {
      let j = at;
      while (
        j < t.length &&
        t[j] !== ":" && t[j] !== "," && t[j] !== "}" && t[j] !== "]" && t[j] !== "\n"
      ) {
        j++;
      }
      if (t[j] !== ":") return null;
      end = j;
      while (end > at && (t[end - 1] === " " || t[end - 1] === "\t")) end--;
    }
    const colon = this.ws(end);
    if (t[colon] !== ":") return null;
    const keyRaw = t.slice(at, end);
    return {
      keyRaw,
      key: c === '"' || c === "'" ? decodeQuoted(keyRaw) : keyRaw,
      start: at,
      end,
      colonEnd: colon + 1,
    };
  }

  /** A scalar inside a flow collection: quoted, or plain up to `,` / `]` / `}`. */
  private readFlowScalar(at: number): FlowScalar {
    const t = this.text;
    const c = t[at];
    if (c === '"' || c === "'") {
      const end = scanQuoted(t, at);
      if (end < 0) throw new Bail(this.lineOf(at), "yamlParse.quoteNeverClosed");
      const raw = t.slice(at, end);
      return {
        raw, value: decodeQuoted(raw),
        style: c === '"' ? "double" : "single",
        start: at, end,
      };
    }
    let j = at;
    while (j < t.length && t[j] !== "," && t[j] !== "]" && t[j] !== "}" && t[j] !== "\n") {
      if (t[j] === "#" && j > at && t[j - 1] === " ") break;
      j++;
    }
    let end = j;
    while (end > at && (t[end - 1] === " " || t[end - 1] === "\t")) end--;
    const raw = t.slice(at, end);
    return { raw, value: raw, style: "plain", start: at, end };
  }

  // ── Node builders ─────────────────────────────────────────────────────────

  private container(
    kind: YamlKind,
    k: ScannedKey | null,
    path: (string | number)[],
    docIndex: number,
    line: number,
    endLine: number,
    indent: number,
    children: YamlNode[],
  ): YamlNode {
    return {
      id: idFor(docIndex, path),
      path,
      kind,
      key: k?.key ?? null,
      keyRaw: k?.keyRaw ?? null,
      keyStart: k ? this.off(line, k.keyCol) : -1,
      keyEnd: k ? this.off(line, k.keyEnd) : -1,
      value: "",
      raw: "",
      style: "empty",
      valueStart: -1,
      valueEnd: -1,
      start: this.off(line, indent),
      end: this.lineEnd(endLine),
      blockIndent: -1,
      flowOpen: -1,
      inFlow: false,
      line,
      endLine,
      indent,
      // A synthetic container (a document root, or the mapping/list a `-` opens on
      // its own line) has no value column of its own, so nothing behind it is its
      // comment — the entry written on that line owns it. The prose above it is
      // still its own.
      comment: "",
      lead: this.leadAt(line, indent),
      commentStart: -1,
      commentAnchor: -1,
      editable: true,
      deletable: true,
      children,
    };
  }

  private scalar(
    k: ScannedKey | null,
    path: (string | number)[],
    docIndex: number,
    line: number,
    indent: number,
    v: ScannedValue,
    editable: boolean,
    deletable: boolean,
  ): YamlNode {
    return this.annotate({
      id: idFor(docIndex, path),
      path,
      kind: "scalar",
      key: k?.key ?? null,
      keyRaw: k?.keyRaw ?? null,
      keyStart: k ? this.off(line, k.keyCol) : -1,
      keyEnd: k ? this.off(line, k.keyEnd) : -1,
      value: v.value,
      raw: v.raw,
      style: v.style,
      valueStart: this.off(line, v.valueCol),
      valueEnd: this.off(line, v.valueEnd),
      start: this.off(line, k ? k.keyCol : indent),
      end: this.off(line, v.valueEnd),
      blockIndent: -1,
      flowOpen: -1,
      inFlow: false,
      line,
      endLine: line,
      indent,
      comment: "",
      lead: "",
      commentStart: -1,
      commentAnchor: -1,
      editable,
      deletable,
      children: [],
    }, line, v.valueEnd);
  }
}

/** A node's identity: its document plus its path, JSON-encoded so that a key
 *  holding the separator character cannot collide with a deeper path. Stable
 *  across re-parses, which is what lets the tree keep its collapse state and its
 *  open editor across the re-parse every edit triggers. */
function idFor(docIndex: number, path: (string | number)[]): string {
  return `${docIndex}:${JSON.stringify(path)}`;
}

// ── Edits ───────────────────────────────────────────────────────────────────
// Each takes the current text and returns the next text. They are total: an edit
// the node does not support returns the text unchanged, so a stale node from a
// previous parse can never corrupt the file.

/** Rewrite a scalar's value in place, keeping its key, its style and its trailing
 *  comment. Block scalars rewrite their body lines. */
export function setValue(text: string, doc: YamlDoc, node: YamlNode, next: string): string {
  if (!node.editable || node.kind !== "scalar") return text;

  if (node.style === "block") {
    const body = next === ""
      ? []
      : next.split("\n").map((l) => (l === "" ? "" : " ".repeat(node.blockIndent) + l));
    if (node.endLine > node.line) return replaceLines(text, node.line + 1, node.endLine, body);
    return insertLines(text, node.line + 1, body);
  }

  const literal = encodeScalar(next, node.style, doc.strict, node.inFlow);
  // An empty value has no token to replace: the splice point sits right after the
  // `:`/`-`, so the leading space has to come with the literal.
  const lead = node.style === "empty" ? " " : "";
  return splice(text, node.valueStart, node.valueEnd, lead + literal);
}

/**
 * The values of a list the tree can show — and edit — as ONE comma-separated
 * line, or null when it must stay rows. Every item has to be a single-line
 * scalar the tree could rewrite, carrying nothing a `a, b, c` reading would
 * drop: no comment (the line has nowhere to keep it), no nested collection, no
 * anchor, no shared dash line, no comma or newline inside a value (the display
 * could not round-trip), no empty value (an invisible token between commas).
 * A flow list spread over lines also stays rows — collapsing it onto one line
 * would rewrite the author's layout, which the tree never does.
 */
export function inlineListValues(node: YamlNode): string[] | null {
  if (node.kind !== "seq" || !node.editable || !node.children.length) return null;
  if (isFlow(node) && node.endLine !== node.line) return null;
  const out: string[] = [];
  for (const c of node.children) {
    // The shared-dash check is what keeps a nested `- - x` list in rows: its
    // first item's line is the outer item's dash line, which the comma line's
    // rewrite (setListItems replaces whole item lines) would overwrite.
    if (c.kind !== "scalar" || !c.editable || !c.deletable || c.onDash) return null;
    if (c.style === "block" || c.style === "empty") return null;
    if (c.comment || c.lead) return null;
    if (c.value === "" || /[\n,]/.test(c.value)) return null;
    out.push(c.value);
  }
  return out;
}

/**
 * Rewrite an inline-edited list ({@link inlineListValues}) to exactly `values`,
 * in the list's own style: a flow list inside its brackets, a block list as
 * `- item` lines at the items' own indent. A value an existing item already
 * holds keeps that item's written form (its quotes), so reordering or appending
 * never restyles a neighbour; a new value is written as typed — plain unless it
 * NEEDS quoting (typing `8080` into a list of ports means the number), quoted
 * in the strict (JSON) dialect. An empty `values` empties the list: a flow list
 * to `[]`, a block list down to its bare key.
 */
export function setListItems(
  text: string,
  doc: YamlDoc,
  node: YamlNode,
  values: string[],
): string {
  if (inlineListValues(node) === null) return text;
  const rawFor = new Map<string, string>();
  for (const c of node.children) if (!rawFor.has(c.value)) rawFor.set(c.value, c.raw);
  const enc = (v: string) => rawFor.get(v) ?? encodeScalar(v, "plain", doc.strict, isFlow(node));

  if (isFlow(node)) {
    return splice(text, node.flowOpen, node.end, `[${values.map(enc).join(", ")}]`);
  }
  const first = node.children[0];
  const pad = " ".repeat(first.indent);
  return replaceLines(
    text,
    first.line,
    node.endLine,
    values.map((v) => `${pad}- ${enc(v)}`),
  );
}

/** Rename a mapping key in place, in the dialect it is written in. */
export function renameKey(text: string, doc: YamlDoc, node: YamlNode, nextKey: string): string {
  if (node.keyRaw === null || node.keyStart < 0 || nextKey === "") return text;
  // A key already written quoted stays quoted, whatever the dialect.
  const quoted = node.keyRaw[0] === '"' || node.keyRaw[0] === "'";
  return splice(
    text,
    node.keyStart,
    node.keyEnd,
    encodeKey(nextKey, doc.strict || quoted, node.inFlow),
  );
}

/** The lines a BLOCK node owns: its own, plus the comment run written above it.
 *  Both edits that move lines around use it, because a node's comment is part of
 *  the node — left behind, it would silently re-attach itself to whichever entry
 *  slid into its place, and describe the wrong thing. */
function blockSpan(node: YamlNode): [number, number] {
  const lead = node.lead === "" ? 0 : node.lead.split("\n").length;
  return [node.line - lead, node.endLine];
}

/**
 * Remove a node, and the comments that are its own: the one behind it and the run
 * written above it (see {@link blockSpan}). A node inside a FLOW collection gives
 * up its span plus the one comma that separated it, so `[a, b, c]` minus `b` is
 * `[a, c]` and not `[a, , c]`.
 */
export function deleteNode(text: string, node: YamlNode): string {
  if (!node.deletable) return text;
  if (node.onDash && !node.inFlow) {
    // The entry shares its item's dash line, so the dash is not its to take:
    // pull the next sibling up onto it when one follows on its own line
    // (`- name: a\n  port: 1` minus `name` → `- port: 1`), otherwise leave a
    // bare `-` — a comment-led sibling keeps its lead run where it is, above
    // its own line, rather than have the pull-up drag a comment onto the dash.
    const { lines, starts } = indexLines(text);
    const next = lines[node.endLine + 1];
    if (next !== undefined && next.trim() !== "" && !isComment(next) && indentOf(next) === node.indent) {
      return splice(text, node.start, starts[node.endLine + 1] + node.indent, "");
    }
    return replaceLines(text, node.line, node.endLine, [
      lines[node.line].slice(0, node.indent).trimEnd(),
    ]);
  }
  if (!node.inFlow) {
    const [from, to] = blockSpan(node);
    return replaceLines(text, from, to, []);
  }

  let from = node.start;
  let to = node.end;
  // Prefer eating the comma BEFORE us (it keeps the opening bracket clean);
  // failing that, the one after — we are the collection's first entry.
  let back = from - 1;
  while (back >= 0 && /\s/.test(text[back])) back--;
  if (back >= 0 && text[back] === ",") {
    from = back;
  } else {
    let fwd = to;
    while (fwd < text.length && /\s/.test(text[fwd])) fwd++;
    if (text[fwd] === ",") {
      fwd++;
      while (fwd < text.length && (text[fwd] === " " || text[fwd] === "\t")) fwd++;
      to = fwd;
    }
  }
  return splice(text, from, to, "");
}

/**
 * Insert a copy of `node` right after it, as a new sibling — what "copy last
 * item" does when growing a list. A BLOCK node's own lines (its nested block and
 * the comment behind it, but NOT the prose above it — a copy is not the original)
 * are duplicated verbatim, so the new entry keeps the source's exact shape and
 * indentation. A FLOW node's span is duplicated after it with a separating comma.
 */
export function duplicateNode(text: string, node: YamlNode): string {
  if (!node.deletable) return text;
  if (!node.inFlow) {
    const { lines } = indexLines(text);
    const copy = lines.slice(node.line, node.endLine + 1);
    // A dash-line entry's first line carries the item's `- `; the copy gets
    // spaces there instead — the dash is the item's, not the entry's.
    if (node.onDash) copy[0] = " ".repeat(node.indent) + copy[0].slice(node.indent);
    return insertLines(text, node.endLine + 1, copy);
  }
  const body = text.slice(node.start, node.end);
  return splice(text, node.end, node.end, `, ${body}`);
}

// ── Copy & paste ────────────────────────────────────────────────────────────

/** An entry captured by the tree's copy button: the node's own source, ready to
 *  be put back down after another node ({@link pasteAfter}) or handed to the
 *  system clipboard. A BLOCK entry carries its lines dedented to column 0, so
 *  `text` reads as a clean fragment and a paste only has to indent it to its new
 *  siblings' column; a FLOW entry is its span, pasted back between commas. */
export interface YamlClip {
  /** The entry as YAML text — what goes on the system clipboard. */
  text: string;
  /** Block form: the node's own lines (its trailing comment included, the lead
   *  run above it not — a copy is not the original; same rule as
   *  {@link duplicateNode}), dedented to column 0. Empty for a flow entry. */
  lines: string[];
  /** Captured from inside a flow collection — pastes back into one. */
  inFlow: boolean;
  /** `key: …` (a mapping entry) vs a bare item — decides which containers can
   *  take it (see {@link canPasteAfter}). */
  isMapEntry: boolean;
  kind: YamlKind;
  /** What the copy is called in the banner and the paste button. */
  label: string;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** Capture a node for copy/paste, or null when it cannot be removed on its own
 *  (a copy exists to be pasted, and a paste of it must be deletable again). */
export function copyNode(text: string, node: YamlNode, label?: string): YamlClip | null {
  if (!node.deletable) return null;
  const isMapEntry = node.key !== null;
  const name = label ?? node.key ?? "item";
  if (node.inFlow) {
    const body = text.slice(node.start, node.end);
    return { text: body, lines: [], inFlow: true, isMapEntry, kind: node.kind, label: name };
  }
  const { lines } = indexLines(text);
  // Dedent by the node's own column — but never past a line's actual indent, so
  // an oddly out-dented line loses only what it has (a blank line stays blank).
  const own = lines
    .slice(node.line, node.endLine + 1)
    .map((l) => l.slice(Math.min(node.indent, leadingSpaces(l))));
  // A dash-line entry's first line: the min-guard above would keep the item's
  // `- ` (the dash sits before the entry's column), so it dedents past it here —
  // the copy is the entry, not the item.
  if (node.onDash) own[0] = lines[node.line].slice(node.indent);
  return { text: own.join("\n"), lines: own, inFlow: false, isMapEntry, kind: node.kind, label: name };
}

/**
 * Whether {@link pasteAfter} can put `clip` down as `anchor`'s next sibling. The
 * entry must FIT the container it would land in — a `key: …` belongs in a
 * mapping, a bare item in a list, and a block entry has no place inside a flow
 * collection (nor a flow span on a block line of its own) — so the paste cursor
 * simply never lands where the splice would tear the file.
 */
export function canPasteAfter(clip: YamlClip, anchor: YamlNode, parentKind: string): boolean {
  if (anchor.inFlow !== clip.inFlow) return false;
  if (parentKind === "map") return clip.isMapEntry;
  if (parentKind === "seq") return !clip.isMapEntry;
  return false;
}

/**
 * Insert a copied entry as `anchor`'s next sibling — the spot the paste cursor
 * marks. A BLOCK clip's lines land right after the anchor's block, re-indented
 * to the anchor's own column ({@link duplicateNode}'s insertion point, with the
 * re-indent a copy from another depth needs). A FLOW clip splices in after the
 * anchor's span — on its own line at the anchor's column when the collection is
 * spread over lines, inline with a `, ` when it isn't (mirroring how
 * {@link addChild} grows a flow collection).
 */
export function pasteAfter(text: string, anchor: YamlNode, clip: YamlClip): string {
  if (clip.inFlow) {
    if (!anchor.inFlow) return text;
    const { starts, eol } = indexLines(text);
    const line = lineOfOffset(starts, anchor.start);
    const ownLine = /^[ \t]*$/.test(text.slice(starts[line], anchor.start));
    const col = anchor.start - starts[line];
    return ownLine
      ? splice(text, anchor.end, anchor.end, `,${eol}${" ".repeat(col)}${clip.text}`)
      : splice(text, anchor.end, anchor.end, `, ${clip.text}`);
  }
  if (anchor.inFlow) return text;
  const pad = " ".repeat(anchor.indent);
  return insertLines(
    text,
    anchor.endLine + 1,
    clip.lines.map((l) => (l === "" ? "" : pad + l)),
  );
}

/** True when the node holds nothing yet, so its first child can replace the
 *  placeholder: `key:` or `key: null`. (An empty `[]`/`{}` is NOT a placeholder —
 *  it is a real, empty flow collection, and it grows children in flow style.) */
export function isEmptyPlaceholder(node: YamlNode): boolean {
  if (node.kind !== "scalar" || !node.editable) return false;
  if (node.style === "empty") return true;
  const raw = node.raw.trim();
  return raw === "null" || raw === "~";
}

/** Whether the tree can add a `kind` child to this node. A map takes keys; a list
 *  takes items and — as "+ key" — an item that IS a mapping (`- name: api`), which
 *  is the shape a list of mappings actually grows by; an empty placeholder takes
 *  either, and becomes that kind. */
export function canAddChild(node: YamlNode, kind: "key" | "item"): boolean {
  if (node.kind === "map") return kind === "key";
  if (node.kind === "seq") return true;
  return isEmptyPlaceholder(node);
}

/**
 * Append a child to `parent`, in the parent's OWN style:
 *  - a BLOCK collection gains a line (`  key: value` / `  - item`) at its
 *    children's indent, matching the file's indent step;
 *  - a FLOW collection gains an entry inside its brackets — inline when it is
 *    written inline (`[a, b]` → `[a, b, c]`), on its own line at its siblings'
 *    column when it is spread over lines. It is never rewritten into block style
 *    behind the author's back.
 * On a LIST, `kind: "key"` means an item that IS a mapping (`- name: api`) — a list
 * of mappings is grown by adding keys to it, not by adding a container and then
 * filling it.
 * Adding the first child to an empty placeholder (`key:` / `key: null`) clears the
 * placeholder, so the key holds the new block rather than a scalar AND a block.
 */
export function addChild(
  text: string,
  doc: YamlDoc,
  parent: YamlNode,
  kind: "key" | "item",
  key: string,
  literal: string,
): string {
  if (!canAddChild(parent, kind)) return text;

  // "+ key" on a list writes an item, not a key: `- name: api`.
  const asItem = parent.kind === "seq" && kind === "key";
  const pair = `${encodeKey(key, doc.strict)}:${literal ? ` ${literal}` : ""}`;
  const flowPair = `${encodeKey(key, doc.strict, true)}: ${literal || "null"}`;

  // A placeholder INSIDE a flow collection — `{a: null}`, `[a, null]`, and so every
  // null in a JSON file — has no lines to grow into: it holds a span, and a flow
  // node has no column at all (`indent` is -1). Growing it as a block would splice a
  // line at column -1 into the middle of the brackets and tear the collection open.
  // It becomes a collection in place instead, in the only style available to it.
  if (parent.inFlow && isEmptyPlaceholder(parent)) {
    const coll = kind === "item" ? `[${literal}]` : `{${flowPair}}`;
    // An empty value (`{a: , …}`) has no token to replace: the splice point sits
    // right after the `:`, so the space comes with the collection — and the spaces
    // already sitting there go with the splice, or they would be left stranded
    // between the value and the comma.
    if (parent.style !== "empty") {
      return splice(text, parent.valueStart, parent.valueEnd, coll);
    }
    let to = parent.valueEnd;
    while (to < text.length && (text[to] === " " || text[to] === "\t")) to++;
    return splice(text, parent.valueStart, to, ` ${coll}`);
  }

  if (isFlow(parent)) {
    const body = kind === "item" ? literal : asItem ? `{${flowPair}}` : flowPair;
    return addFlowChild(text, parent, body);
  }

  const body = kind === "item"
    ? `- ${literal}`.trimEnd()
    : asItem
      ? `- ${pair}`
      : pair;

  if (parent.children.length) {
    const childIndent = parent.children[0].indent;
    const last = parent.children[parent.children.length - 1];
    return insertLines(text, last.endLine + 1, [" ".repeat(childIndent) + body]);
  }

  // First child. A placeholder value on the parent's line has to go first, or the
  // key would hold both a scalar and a block.
  let out = text;
  if (parent.kind === "scalar" && parent.style !== "empty") {
    out = splice(out, parent.valueStart, parent.valueEnd, "");
    out = trimLineEnd(out, parent.line);
  }
  const childIndent = parent.indent + (doc.indentStep || 2);
  return insertLines(out, parent.line + 1, [" ".repeat(childIndent) + body]);
}

/** Splice a new entry into a flow collection, matching how it is laid out. */
function addFlowChild(text: string, parent: YamlNode, body: string): string {
  if (!parent.children.length) {
    // An empty `{}` / `[]`: the entry goes straight after the bracket.
    return splice(text, parent.flowOpen + 1, parent.flowOpen + 1, body);
  }

  const last = parent.children[parent.children.length - 1];
  const spread = text.slice(parent.flowOpen, parent.end).includes("\n");
  if (!spread) return splice(text, last.end, last.end, `, ${body}`);

  // Written over several lines: put the entry on its own line, at the column its
  // siblings are written at, and leave the closing bracket where the author put it.
  const { starts, eol } = indexLines(text);
  const lastLine = lineOfOffset(starts, last.start);
  const col = last.start - starts[lastLine];
  return splice(text, last.end, last.end, `,${eol}${" ".repeat(col)}${body}`);
}

/**
 * Append a top-level entry. This is the one add with no parent node to hang off —
 * an empty (or comment-only) file, where the tree has nothing to show yet but must
 * still be able to seed the document. A JSON file is seeded with the collection
 * itself, since JSON has no block form to grow into.
 */
export function addRootEntry(
  text: string,
  kind: "key" | "item",
  key: string,
  literal: string,
  strict = false,
): string {
  const body = strict
    ? kind === "item"
      ? `[${literal}]`
      : `{${encodeKey(key, true, true)}: ${literal || "null"}}`
    : kind === "item"
      ? `- ${literal}`.trimEnd()
      : `${encodeKey(key)}:${literal ? ` ${literal}` : ""}`;
  const { lines } = indexLines(text);
  return insertLines(text, lines.length, [body]);
}

/** Drop trailing whitespace from one line (used after clearing a placeholder). */
function trimLineEnd(text: string, line: number): string {
  const idx = indexLines(text);
  if (line < 0 || line >= idx.lines.length) return text;
  const l = idx.lines[line];
  const trimmed = l.replace(/[ \t]+$/, "");
  if (trimmed === l) return text;
  return splice(text, idx.starts[line], idx.starts[line] + l.length, trimmed);
}

/**
 * Move a node to the position its sibling at `to` holds — what a drag onto that row
 * means, and what the ↑/↓ buttons ask for one step at a time. A BLOCK node moves
 * whole lines: its nested block, its trailing comment and the prose above it all
 * travel with it ({@link blockSpan}), and the siblings it passes keep theirs. A FLOW
 * node moves its span, taking its separating comma along, so `[a, b, c]` stays a
 * well-formed flow list however its entries are shuffled.
 *
 * It is a MOVE, not a chain of swaps: a swap-per-step would have to re-parse the
 * text between steps (every splice invalidates every offset after it), and a drag
 * across five rows is one edit, not five.
 */
export function moveNodeTo(
  text: string,
  siblings: YamlNode[],
  node: YamlNode,
  to: number,
): string {
  const from = siblings.findIndex((s) => s.id === node.id);
  if (from < 0 || to < 0 || to >= siblings.length || to === from) return text;
  const target = siblings[to];
  if (!node.deletable || !target.deletable) return text;

  if (node.inFlow && target.inFlow) {
    const body = text.slice(node.start, node.end);
    const cut = deleteNode(text, node); // takes the one comma that separated it
    // Everything after the removed region shifted left by exactly what was removed;
    // everything before it (which is where a target above us sits) did not move.
    const shift = text.length - cut.length;
    const anchor = to < from ? target.start : target.end;
    const at = anchor > node.start ? anchor - shift : anchor;
    return splice(cut, at, at, to < from ? `${body}, ` : `, ${body}`);
  }

  const { lines } = indexLines(text);
  // A dash-line entry's span is its own lines only — never blockSpan's, whose
  // lead is the prose above the item's dash line and not the entry's to move.
  const spanOf = (n: YamlNode): [number, number] =>
    n.onDash ? [n.line, n.endLine] : blockSpan(n);
  const [nodeFrom, nodeTo] = spanOf(node);
  const [targetFrom, targetTo] = spanOf(target);
  // Rewrite only the run of lines the two of them span, so nothing outside it —
  // another sibling's comment, a blank line, the trailing newline — is touched.
  const lo = Math.min(nodeFrom, targetFrom);
  const hi = Math.max(nodeTo, targetTo);
  const span = lines.slice(lo, hi + 1);
  // When first place changes hands, so does the item's dash: the current first
  // entry gives its `- ` prefix up (its line is dedashed inside the span)…
  const dash = siblings[0].onDash && (from === 0 || to === 0) ? siblings[0] : null;
  const prefix = dash ? lines[dash.line].slice(0, dash.indent) : "";
  if (dash) {
    span[dash.line - lo] = " ".repeat(dash.indent) + span[dash.line - lo].slice(dash.indent);
  }
  const block = span.splice(nodeFrom - lo, nodeTo - nodeFrom + 1);
  const at = to < from ? targetFrom - lo : targetTo + 1 - lo - block.length;
  span.splice(at, 0, ...block);
  // …and the new first entry takes it, on its ENTRY line — its lead comments
  // stay above the dash line, which is exactly where an item's prose lives
  // (`leadComment`). The entry line is the span's first line of real content.
  if (dash) {
    const entry = span.findIndex((l) => l.trim() !== "" && !isComment(l));
    if (entry >= 0) span[entry] = prefix + span[entry].slice(prefix.length);
  }
  return replaceLines(text, lo, hi, span);
}

/** Move a node one place up (-1) or down (+1). */
export function moveNode(
  text: string,
  siblings: YamlNode[],
  node: YamlNode,
  delta: -1 | 1,
): string {
  const at = siblings.findIndex((s) => s.id === node.id);
  if (at < 0) return text;
  return moveNodeTo(text, siblings, node, at + delta);
}

// ── Comments ────────────────────────────────────────────────────────────────
// A `#` comment is the only place a YAML file documents a key, so the tree treats
// it as the key's description rather than as scenery: it is read on both of the
// two places it can be written (above the key, or behind the value), shown on the
// key, and it travels with the key when the key moves or goes.

/** The node's comment, whichever way round the author wrote it. */
export function commentOf(node: YamlNode): string {
  return node.comment || node.lead;
}

/** Whether the tree may write a comment here. JSON has none to write (it is not a
 *  YAML dialect thing — the format simply has no comments), and inside a flow
 *  collection a `#` would swallow the closing bracket and everything up to it. */
export function canComment(doc: YamlDoc, node: YamlNode): boolean {
  // A dash-line item carries its comment above (`leadComment`), so it needs no
  // trailing anchor of its own; every other node needs a place to put one.
  return !doc.strict && (node.commentAnchor >= 0 || !!node.leadComment);
}

/**
 * Write (or, with an empty `next`, clear) a node's comment, KEEPING THE AUTHOR'S
 * PLACEMENT: one written above the key is rewritten above it, one written behind
 * the value stays behind it. A node with no comment yet gets one behind — the
 * placement that adds no line and so cannot disturb anything around it.
 */
export function setComment(text: string, doc: YamlDoc, node: YamlNode, next: string): string {
  if (!canComment(doc, node)) return text;
  const body = next.trim();
  const leadLines = node.lead === "" ? 0 : node.lead.split("\n").length;

  // A comment written ABOVE the node's line: when it already has a lead run (any
  // node), or when it's a dash-line item whose comment lives above by rule. An
  // existing run is replaced (empty body clears it); a brand-new one is inserted.
  if ((leadLines > 0 && node.commentStart < 0) || (node.leadComment && node.commentStart < 0)) {
    const pad = " ".repeat(Math.max(0, node.indent));
    const written = body === "" ? [] : body.split("\n").map((l) => `${pad}# ${l}`.trimEnd());
    if (leadLines > 0) {
      return replaceLines(text, node.line - leadLines, node.line - 1, written);
    }
    return insertLines(text, node.line, written);
  }

  const idx = indexLines(text);
  const line = lineOfOffset(idx.starts, node.commentAnchor);
  const eol = idx.starts[line] + idx.lines[line].length;
  const had = node.commentStart >= 0;

  if (body === "") {
    // Take the run of spaces before the `#` with it, or clearing the comment would
    // leave the line with trailing whitespace no one asked for.
    let from = had ? node.commentStart : node.commentAnchor;
    while (from > node.commentAnchor && /[ \t]/.test(text[from - 1])) from--;
    return splice(text, from, eol, "");
  }

  // Rewriting an existing comment starts at its own `#`, so the gap the author left
  // in front of it — which may be aligning it with the comments above and below —
  // survives. Only a brand-new one has to choose a gap.
  const from = had ? node.commentStart : node.commentAnchor;
  // A comment behind the value is one line by definition.
  return splice(text, from, eol, `${had ? "" : "  "}# ${body.replace(/\s*\n+\s*/g, " ")}`);
}

/** A scalar's type, for the tree's value styling. Display only. */
export function scalarType(node: YamlNode): "string" | "number" | "boolean" | "null" {
  if (node.style === "double" || node.style === "single" || node.style === "block") return "string";
  const v = node.raw.trim();
  if (node.style === "empty" || v === "null" || v === "~") return "null";
  if (/^-?(\d+|\d*\.\d+)([eE][+-]?\d+)?$/.test(v) || /^0[xob][0-9a-fA-F_]+$/.test(v)) return "number";
  if (/^(true|false|yes|no|on|off)$/i.test(v)) return "boolean";
  return "string";
}

/** Flatten a document's nodes, parents before children (used by tests). */
export function walkYaml(node: YamlNode, visit: (n: YamlNode) => void): void {
  visit(node);
  for (const c of node.children) walkYaml(c, visit);
}
