/**
 * Pure unified-diff parser for the in-app diff viewer (Dev 3 / TODO Group K).
 *
 * Turns a unified diff string (the output of `git diff`, a `.diff`/`.patch`
 * file, etc.) into structured files → hunks → lines, tracking running old/new
 * line numbers so the viewer can render a two-column line-number gutter. The
 * parser is deliberately tolerant: a bare diff with no `diff --git` header (just
 * `---`/`+++`/`@@`) still parses into a single file, and multiple files /
 * multiple hunks per file are handled.
 *
 * No DOM, no React — this is the unit-tested logic half of the viewer. All line
 * text is preserved verbatim (the viewer is responsible for HTML-escaping it).
 */

export type DiffLineType = "context" | "add" | "del" | "hunk" | "meta" | "nonewline";

export interface DiffLine {
  type: DiffLineType;
  /** The line's text, with any leading diff marker (`+`/`-`/space) stripped for
   *  body lines, or the full text for meta/hunk/nonewline markers. */
  text: string;
  /** 1-based line number in the OLD file, or null (added / marker lines). */
  oldNo: number | null;
  /** 1-based line number in the NEW file, or null (deleted / marker lines). */
  newNo: number | null;
}

export interface DiffHunk {
  /** The raw `@@ -l,s +l,s @@` header (with any trailing section context). */
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffFile {
  /** Old path with any `a/` prefix stripped; `/dev/null` for an added file. */
  oldPath: string;
  /** New path with any `b/` prefix stripped; `/dev/null` for a deleted file. */
  newPath: string;
  hunks: DiffHunk[];
  /** What happened to the file; `modified` when the diff doesn't say more. */
  status: DiffFileStatus;
  /** `Binary files … differ` / `GIT binary patch`: no text hunks to show. */
  binary: boolean;
  /** A merge's combined diff (`diff --cc`, `@@@`): lines carry one marker
   *  column per parent, `oldNo` follows the first parent only. */
  combined: boolean;
  /** Some line ended in `\r\n` (the `\r` is stripped from every line's text). */
  crlf: boolean;
  /** File mode before / after (`100644`), when git printed one. */
  oldMode?: string;
  newMode?: string;
  /** `similarity index N%` of a rename or copy. */
  similarity?: number;
}

/** The path a file is shown under: its new one, or the old one if deleted. */
export function diffFilePath(file: DiffFile): string {
  return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
}

/** Strip a leading `a/` or `b/` git prefix from a diff path. Leaves `/dev/null`
 *  and bare paths untouched. */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '"': '"', "\\": "\\",
};

/** Undo git's C-style quoting of a path (`"a/caf\303\251 x"`): `\"`, `\\`,
 *  `\t`, … and octal byte escapes, which decode as UTF-8. A string that isn't
 *  quoted comes back as it is. */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\" || i === body.length - 1) {
      const cp = body.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(cp);
      bytes.push(...encoder.encode(ch));
      i += ch.length;
      continue;
    }
    const next = body[i + 1];
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
    if (oct) {
      bytes.push(parseInt(oct, 8) & 0xff);
      i += 1 + oct.length;
    } else {
      bytes.push(...encoder.encode(SIMPLE_ESCAPES[next] ?? next));
      i += 2;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The end index (exclusive) of the quoted token starting at `from`, or -1. */
function quotedEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** Parse the path off a `--- ` / `+++ ` line: drop the marker, take up to the
 *  first tab (git appends a timestamp after a tab), trim, unquote, strip the
 *  prefix. */
function parsePathLine(line: string): string {
  // line starts with "--- " or "+++ "
  let rest = line.slice(4);
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest, 0);
    if (end > 0) return stripPrefix(unquotePath(rest.slice(0, end)));
  }
  const tab = rest.indexOf("\t");
  if (tab >= 0) rest = rest.slice(0, tab);
  return stripPrefix(rest.trim());
}

/** The two paths of a `diff --git <old> <new>` line (the text after `diff --git `).
 *  Quoted paths, and unquoted ones with spaces when both sides name the same
 *  file, are told apart; for a rename the `rename from/to` lines say it better. */
function parseGitHeader(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest, 0);
    if (end > 0 && rest[end] === " ") {
      return [stripPrefix(unquotePath(rest.slice(0, end))), stripPrefix(unquotePath(rest.slice(end + 1)))];
    }
  }
  const quoted = rest.indexOf(' "');
  if (quoted > 0 && rest.endsWith('"')) {
    return [stripPrefix(rest.slice(0, quoted)), stripPrefix(unquotePath(rest.slice(quoted + 1)))];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const first = rest.slice(0, half);
    const second = rest.slice(half + 1);
    if (first === second || first.slice(2) === second.slice(2)) return [stripPrefix(first), stripPrefix(second)];
  }
  const split = rest.indexOf(" b/");
  if (split > 0) return [stripPrefix(rest.slice(0, split)), stripPrefix(rest.slice(split + 1))];
  const space = rest.indexOf(" ");
  return space > 0 ? [stripPrefix(rest.slice(0, space)), stripPrefix(rest.slice(space + 1))] : [rest, rest];
}

interface HunkStarts {
  oldNo: number;
  newNo: number;
  oldCount: number;
  newCount: number;
  /** Marker columns per body line: 1 for a plain hunk, one per parent in a combined one. */
  columns: number;
}

/** Parse the starting line numbers and counts out of a `@@ -oldStart,oldCount +newStart,newCount @@`
 *  header (a combined `@@@ -a,b -c,d +e,f @@@` reads the first parent's old range
 *  and the result's range). The counts are optional (`,n` may be omitted,
 *  meaning 1). Unparseable starts default to 1. */
function parseHunkStarts(header: string): HunkStarts {
  const ats = /^@+/.exec(header)?.[0].length ?? 2;
  const columns = Math.max(1, ats - 1);
  const ranges = [...header.matchAll(/([-+])(\d+)(?:,(\d+))?/g)];
  const first = ranges.find((m) => m[1] === "-");
  const last = [...ranges].reverse().find((m) => m[1] === "+");
  const num = (v: string | undefined, dflt: number): number => (v === undefined ? dflt : parseInt(v, 10));
  return {
    oldNo: num(first?.[2], 1),
    newNo: num(last?.[2], 1),
    oldCount: first ? num(first[3], 1) : 0,
    newCount: last ? num(last[3], 1) : 0,
    columns,
  };
}

/**
 * Parse a unified-diff string into a list of {@link DiffFile}. Robust to:
 *  - `diff --git a/x b/x` headers starting a new file (quoted paths, spaces),
 *  - git's extended headers: `new file mode`, `deleted file mode`, `old/new mode`,
 *    `similarity index`, `rename|copy from/to`, `Binary files … differ`,
 *    `GIT binary patch` (a file flagged `binary`, no hunks),
 *  - `---`/`+++` path lines (sets old/new path, strips `a/`,`b/`, handles `/dev/null`),
 *  - `@@ … @@` hunk headers (seeds running old/new line counters; the counts keep
 *    a deleted `-- x` line from reading as a `--- ` file header),
 *  - body lines: `+` add (newNo advances), `-` del (oldNo advances),
 *    ` ` context (both advance), `\ No newline at end of file` → a `nonewline` marker,
 *  - combined diffs (`diff --cc`, `@@@`): one marker column per parent,
 *  - CRLF input (the `\r` is stripped, `crlf` set on the file),
 *  - a headerless diff (no `diff --git`) → a single file.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let columns = 1;

  const fresh = (): DiffFile => {
    const created: DiffFile = {
      oldPath: "", newPath: "", hunks: [], status: "modified", binary: false, combined: false, crlf: false,
    };
    files.push(created);
    return created;
  };

  // Split on \n; tolerate \r\n by trimming a trailing \r from each line.
  const lines = text.split("\n");
  const stripped = (i: number): string => {
    const raw = lines[i] ?? "";
    return raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  };
  for (let at = 0; at < lines.length; at++) {
    const line = stripped(at);
    const hadCr = line.length !== lines[at].length;

    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      // Start a brand-new file; subsequent ---/+++ fill in the paths.
      const started = (file = fresh());
      hunk = null;
      if (line.startsWith("diff --git ")) {
        [started.oldPath, started.newPath] = parseGitHeader(line.slice("diff --git ".length));
      } else {
        started.combined = true;
        const path = stripPrefix(unquotePath(line.slice(line.indexOf(" ", 7) + 1)));
        started.oldPath = path;
        started.newPath = path;
      }
      continue;
    }

    // A `--- ` line inside a hunk is a deleted line starting `-- ` while the
    // header's counts still expect lines; otherwise it opens a file's paths. A
    // wrong count is forgiven when `--- `, `+++ ` and `@@` really follow.
    const expecting = hunk !== null && (file?.combined === true || oldLeft > 0 || newLeft > 0);
    const headerAhead = line.startsWith("--- ") && stripped(at + 1).startsWith("+++ ") && stripped(at + 2).startsWith("@@");
    const inBody = expecting && !headerAhead;

    if (!inBody && line.startsWith("--- ")) {
      // A `---` after a file's hunks belongs to a headerless next file.
      if (!file || file.hunks.length > 0) file = fresh();
      file.oldPath = parsePathLine(line);
      hunk = null;
      continue;
    }
    if (!inBody && line.startsWith("+++ ")) {
      (file ??= fresh()).newPath = parsePathLine(line);
      hunk = null;
      continue;
    }

    if (line.startsWith("@@")) {
      const current = (file ??= fresh());
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
      const starts = parseHunkStarts(line);
      oldNo = starts.oldNo;
      newNo = starts.newNo;
      oldLeft = starts.oldCount;
      newLeft = starts.newCount;
      columns = starts.columns;
      if (columns > 1) current.combined = true;
      hunk.lines.push({ type: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }

    // Extended headers. They describe the current file, so one that arrives
    // with no `diff --git` before it (plain `diff -u`) opens its own. No body
    // line starts like one (those begin with `+`, `-`, a space or `\`).
    const meta = hunk && /^[-+ \\]/.test(line) ? null : parseMeta(line);
    if (meta) {
      if (!file || (meta.opensFile && (file.binary || file.hunks.length > 0))) file = fresh();
      meta.apply(file);
      hunk = null;
      continue;
    }
    if (!hunk) continue;

    if (hadCr && file) file.crlf = true;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" marker — belongs to the preceding line.
      hunk.lines.push({ type: "nonewline", text: line, oldNo: null, newNo: null });
      continue;
    }
    // Past the header's counts, the blank line a trailing newline leaves is no line.
    if (line === "" && (!expecting || columns > 1)) continue;

    if (columns > 1) {
      const marks = line.slice(0, columns);
      const body = line.slice(columns);
      if (marks.includes("-")) {
        hunk.lines.push({ type: "del", text: body, oldNo: marks[0] === "-" ? oldNo : null, newNo: null });
        if (marks[0] === "-") oldNo++;
      } else {
        hunk.lines.push({
          type: marks.includes("+") ? "add" : "context",
          text: body,
          oldNo: marks[0] === "+" ? null : oldNo,
          newNo,
        });
        if (marks[0] !== "+") oldNo++;
        newNo++;
      }
      continue;
    }

    const marker = line[0];
    const body = line.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", text: body, oldNo: null, newNo });
      newNo++;
      newLeft--;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", text: body, oldNo, newNo: null });
      oldNo++;
      oldLeft--;
    } else {
      // A space-prefixed context line, or a bare empty line (some tools emit a
      // truly empty context line rather than a single space).
      hunk.lines.push({ type: "context", text: body, oldNo, newNo });
      oldNo++;
      newNo++;
      oldLeft--;
      newLeft--;
    }
  }

  for (const f of files) {
    if (f.status !== "modified") continue;
    // A file whose headers didn't say added/deleted still is, by its `/dev/null`.
    if (f.oldPath === "/dev/null") f.status = "added";
    else if (f.newPath === "/dev/null") f.status = "deleted";
  }
  return files;
}

/** One extended-header line: what it sets on the file, and whether it can only
 *  start a file of its own (a bare `Binary files` line with no `diff --git`). */
function parseMeta(line: string): { apply: (f: DiffFile) => void; opensFile: boolean } | null {
  const hit = (re: RegExp): RegExpExecArray | null => re.exec(line);
  let m: RegExpExecArray | null;
  if ((m = hit(/^new file mode (\d+)/))) {
    const [, mode] = m;
    return { opensFile: false, apply: (f) => { f.status = "added"; f.newMode = mode; f.oldPath = "/dev/null"; } };
  }
  if ((m = hit(/^deleted file mode (\d+)/))) {
    const [, mode] = m;
    return { opensFile: false, apply: (f) => { f.status = "deleted"; f.oldMode = mode; f.newPath = "/dev/null"; } };
  }
  if ((m = hit(/^old mode (\d+)/))) {
    const [, mode] = m;
    return { opensFile: false, apply: (f) => { f.oldMode = mode; } };
  }
  if ((m = hit(/^new mode (\d+)/))) {
    const [, mode] = m;
    return { opensFile: false, apply: (f) => { f.newMode = mode; } };
  }
  if ((m = hit(/^similarity index (\d+)%/))) {
    const pct = parseInt(m[1], 10);
    return { opensFile: false, apply: (f) => { f.similarity = pct; } };
  }
  if ((m = hit(/^(rename|copy) (from|to) (.*)$/))) {
    const [, verb, side, raw] = m;
    return {
      opensFile: false,
      apply: (f) => {
        f.status = verb === "rename" ? "renamed" : "copied";
        if (side === "from") f.oldPath = unquotePath(raw);
        else f.newPath = unquotePath(raw);
      },
    };
  }
  if (line === "GIT binary patch") return { opensFile: false, apply: (f) => { f.binary = true; } };
  if ((m = hit(/^Binary files (.+) and (.+) differ$/))) {
    const [, from, to] = m;
    return {
      opensFile: true,
      apply: (f) => {
        f.binary = true;
        f.oldPath = stripPrefix(unquotePath(from));
        f.newPath = stripPrefix(unquotePath(to));
        if (f.oldPath === "/dev/null") f.status = "added";
        else if (f.newPath === "/dev/null") f.status = "deleted";
      },
    };
  }
  return null;
}

/** `text` as lines: `\r\n` tolerated, a final newline ends the last line
 *  rather than starting an empty one. */
function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * `file`'s diff spread over the whole of `text` — the new side as it is on
 * disk now: every line between and around the hunks joins as context, so the
 * changes read in place inside the full file. No `file` (an empty diff) is the
 * whole file unchanged. Null when the hunks don't fit `text` (the file moved on
 * since the diff was taken, or this is a deletion): the caller shows the bare
 * hunks instead of a misaligned file.
 */
export function wholeFileHunk(file: DiffFile | undefined, text: string): DiffHunk | null {
  if (file?.newPath === "/dev/null" || file?.binary) return null;
  const source = textLines(text);
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const fill = (count: number): boolean => {
    if (count < 0 || newNo - 1 + count > source.length) return false;
    for (let i = 0; i < count; i++) {
      lines.push({ type: "context", text: source[newNo - 1], oldNo, newNo });
      oldNo++;
      newNo++;
    }
    return true;
  };
  for (const hunk of file?.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.type === "hunk" || line.type === "meta") continue;
      if (line.type === "nonewline") {
        lines.push(line);
        continue;
      }
      const gap = line.oldNo != null ? line.oldNo - oldNo : (line.newNo ?? newNo) - newNo;
      if (!fill(gap)) return null;
      if (line.newNo != null && source[line.newNo - 1] !== line.text) return null;
      lines.push(line);
      if (line.oldNo != null) oldNo = line.oldNo + 1;
      if (line.newNo != null) newNo = line.newNo + 1;
    }
  }
  if (!fill(source.length - (newNo - 1))) return null;
  return { header: "", lines };
}
