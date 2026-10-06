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

export interface DiffFile {
  /** Old path with any `a/` prefix stripped; `/dev/null` for an added file. */
  oldPath: string;
  /** New path with any `b/` prefix stripped; `/dev/null` for a deleted file. */
  newPath: string;
  hunks: DiffHunk[];
}

/** Strip a leading `a/` or `b/` git prefix from a diff path. Leaves `/dev/null`
 *  and bare paths untouched. */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/** Parse the path off a `--- ` / `+++ ` line: drop the marker, take up to the
 *  first tab (git appends a timestamp after a tab), trim, strip the prefix. */
function parsePathLine(line: string): string {
  // line starts with "--- " or "+++ "
  let rest = line.slice(4);
  const tab = rest.indexOf("\t");
  if (tab >= 0) rest = rest.slice(0, tab);
  return stripPrefix(rest.trim());
}

/** Parse the starting line numbers out of a `@@ -oldStart,oldCount +newStart,newCount @@`
 *  header. The counts are optional (`,n` may be omitted, meaning 1). Returns the
 *  1-based old/new start lines, defaulting to 1 when unparseable. */
function parseHunkStarts(header: string): { oldNo: number; newNo: number } {
  const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!m) return { oldNo: 1, newNo: 1 };
  return { oldNo: parseInt(m[1], 10), newNo: parseInt(m[2], 10) };
}

/**
 * Parse a unified-diff string into a list of {@link DiffFile}. Robust to:
 *  - `diff --git a/x b/x` headers starting a new file,
 *  - `---`/`+++` path lines (sets old/new path, strips `a/`,`b/`, handles `/dev/null`),
 *  - `@@ … @@` hunk headers (seeds running old/new line counters),
 *  - body lines: `+` add (newNo advances), `-` del (oldNo advances),
 *    ` ` context (both advance), `\ No newline at end of file` → a `nonewline` marker,
 *  - a headerless diff (no `diff --git`) → a single file.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const ensureFile = (): DiffFile => {
    if (!file) {
      file = { oldPath: "", newPath: "", hunks: [] };
      files.push(file);
    }
    return file;
  };

  // Split on \n; tolerate \r\n by trimming a trailing \r from each line.
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("diff --git ")) {
      // Start a brand-new file; subsequent ---/+++ fill in the paths.
      file = { oldPath: "", newPath: "", hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }

    if (line.startsWith("--- ")) {
      ensureFile().oldPath = parsePathLine(line);
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      ensureFile().newPath = parsePathLine(line);
      hunk = null;
      continue;
    }

    if (line.startsWith("@@")) {
      const f = ensureFile();
      hunk = { header: line, lines: [] };
      f.hunks.push(hunk);
      const starts = parseHunkStarts(line);
      oldNo = starts.oldNo;
      newNo = starts.newNo;
      hunk.lines.push({ type: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }

    // Body lines only count once we're inside a hunk; anything else (extended
    // git headers like `index …`, `new file mode …`, etc.) is metadata.
    if (!hunk) {
      // Pre-hunk metadata. Attach to the current file as a meta line only when a
      // file exists; otherwise ignore stray leading noise.
      if (file) {
        // Keep extended headers out of the rendered hunks (the viewer shows the
        // file path itself); we simply skip them.
      }
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" marker — belongs to the preceding line.
      hunk.lines.push({ type: "nonewline", text: line, oldNo: null, newNo: null });
      continue;
    }

    const marker = line[0];
    const body = line.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", text: body, oldNo: null, newNo });
      newNo++;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", text: body, oldNo, newNo: null });
      oldNo++;
    } else {
      // A space-prefixed context line, or a bare empty line (some tools emit a
      // truly empty context line rather than a single space).
      hunk.lines.push({ type: "context", text: body, oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }

  return files;
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
  if (file?.newPath === "/dev/null") return null;
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
