import { invoke } from "@tauri-apps/api/core";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../fileUtils";
import { bibPlainValue, parseBib } from "./bib";
import { isBeamerDocument } from "./beamer";
import { basename, dirname, isAbsolute, normalizePath, resolvePath } from "../../paths";
import { fileMtime, writeFileBytes, writeFileText } from "../../../components/embed/fileAccess";

/** Which TeX tools are on PATH; mirrors the backend `TexCapability`. */
export type TexCapability = {
  available: boolean;
  engines: string[];
  bibtex: boolean;
  latexmk: boolean;
};

/** Result of `compile_tex`; mirrors the backend `TexCompileResult`. */
export type TexCompileResult = {
  success: boolean;
  pdf_path: string | null;
  engine: string;
  log: string;
  /** True when the build ran with shell-escape (`\write18`) active behind our
   *  back (system texmf.cnf / latexmkrc). Surfaced as a warning in the viewer. */
  shell_escape: boolean;
  /** Why `latexmk` exited non-zero, in its own words, when it did — the
   *  `Collected error summary` block minus the "use -f" advisory. Set even when
   *  `success` is true: latexmk fails a build over configuration (warnings as
   *  errors, a bibliography rule, an unresolved reference) while the engine
   *  still writes the PDF, and that is a note, not a compilation error. */
  driver_note: string | null;
};

// TeX tooling is PATH-global, so probe the backend once per app run and share
// the result across every consumer (the FileTree context menu and the in-tab
// LaTeX viewer).
let texCapPromise: Promise<TexCapability> | null = null;

export function getTexCapability(): Promise<TexCapability> {
  if (!texCapPromise) {
    texCapPromise = invoke<TexCapability>("tex_capability").catch(
      () => ({ available: false, engines: [], bibtex: false, latexmk: false }),
    );
  }
  return texCapPromise;
}

/** Drop the cached probe and re-query the backend. The one-shot cache above is
 *  right for a probe that never changes mid-session, but it goes stale the
 *  moment the user installs a TeX distribution from the "no engine found"
 *  banner — call this after that install (or from a manual "Recheck") so the
 *  viewer picks up the newly-detected engine without an app restart. */
export function refreshTexCapability(): Promise<TexCapability> {
  texCapPromise = null;
  return getTexCapability();
}

/** Last meaningful line of a build log, for a terse error message. */
export function lastLogLine(log: string): string {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** A parsed compile error with its source location, for jump-to-error. */
export type TexError = {
  /** File the error is in, exactly as the log named it (may be relative to the
   *  compile dir, or absolute). Resolve with {@link resolveTexErrorPath}. */
  file: string;
  /** 1-based source line. */
  line: number;
  /** The error message (without the `file:line:` prefix). */
  message: string;
};

// `file:line: message`, the form TeX uses under `-file-line-error` (which Tabtivity
// always passes). The file part is non-greedy so the FIRST `:<digits>:` wins,
// and the line must be followed by `:` then a space to avoid matching e.g.
// Windows drive letters or `l.12` context dumps.
const FILE_LINE_ERROR = /^(.+?):(\d+): (.*)$/;

/** Parse `compile_tex`'s log into the list of errors TeX reported, in order.
 *  Relies on the `-file-line-error` format Tabtivity compiles with. Duplicate
 *  file+line+message lines (TeX can repeat them) are collapsed. */
/** True when the build log says latexmk ran NO engine because every tracked
 *  source still matched its recorded checksum — "Nothing to do for 'main.tex'" /
 *  "All targets (main.pdf) are up-to-date". The exit status is 0 and the PDF
 *  exists, so the backend reports success; but the bytes on disk are the previous
 *  build's, and a reader expecting new content needs to hear that — the usual
 *  cause is an edit that never reached disk (an unsaved pane, an editor draft),
 *  which no amount of recompiling will pick up. */
export function compileWasNoop(log: string): boolean {
  // Only this line is exclusive to the no-op: "All targets (…) are up-to-date"
  // closes a real build too.
  return /^Latexmk: Nothing to do for '/m.test(log);
}

export function parseTexErrors(log: string): TexError[] {
  const out: TexError[] = [];
  const seen = new Set<string>();
  for (const raw of log.split("\n")) {
    const m = FILE_LINE_ERROR.exec(raw.trimEnd());
    if (!m) continue;
    const file = m[1].trim();
    const line = Number(m[2]);
    const message = m[3].trim();
    // Skip degenerate matches: empty file token, or a path with no extension
    // and a space (those are usually prose lines that happen to contain ": N:").
    if (!file || !Number.isFinite(line) || line < 1) continue;
    const key = `${file}:${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line, message });
  }
  return out;
}

/** Resolve a {@link TexError}'s `file` against the directory the build ran in
 *  (the TeX root's folder) into an absolute path the editor can open. Absolute
 *  paths and `./`-relative paths are both handled. */
export function resolveTexErrorPath(rootDir: string, file: string): string {
  // Absolute (POSIX `/x`, Windows `C:\x` / UNC) passes through unchanged.
  if (isAbsolute(file)) return file;
  const rel = file.replace(/^\.[/\\]+/, "");
  return rootDir ? resolvePath(rootDir, rel) : rel;
}

// --- Compile WARNINGS (#245) -------------------------------------------------
//
// A LaTeX build that *succeeds* is the normal case and is also where nearly
// everything worth fixing is reported: an undefined `\ref` prints as a bold `??`
// in the PDF, a missing citation as `[?]`, an overfull `\hbox` as a line running
// into the margin. The viewer parsed errors and nothing else, so a document that
// compiled showed no notice at all and the reader found the `??` by reading the
// output — which is exactly the trip to the PDF the SyncTeX work exists to save.
//
// Warnings are harder to place than errors, because `-file-line-error` only
// applies to errors: a warning carries `on input line N` and no file at all. The
// file therefore comes from TRACKING the `(path … )` nesting TeX prints as it
// opens and closes each source, which is what every LaTeX IDE does and is only
// as reliable as the log's line breaking — hence `max_print_line` in the
// backend's compile environment. When the stack is empty the warning is
// attributed to nothing and the caller resolves it against the build root.

/** What kind of thing a warning is about — the dropdown's grouping and the only
 *  thing the viewer tones on. */
export type TexWarningKind = "reference" | "citation" | "box" | "font" | "other";

/** One warning TeX or a package reported, with wherever it can be placed. */
export interface TexWarning {
  kind: TexWarningKind;
  /** The message, without the `LaTeX Warning:` lead-in. */
  message: string;
  /** The source file the log was reading at the time, when the `(…)` nesting
   *  gave one. Relative to the build directory, like {@link TexError.file}. */
  file?: string;
  /** 1-based source line, from `on input line N` or `at lines N--M`. */
  line?: number;
}

/** `LaTeX Warning: …`, `Package xcolor Warning: …`, `LaTeX Font Warning: …` — the
 *  one shape every warning-emitting macro in the ecosystem prints. */
const WARNING_HEAD = /^(?:(LaTeX|pdfTeX|LuaTeX|XeTeX|Package|Class|Module)\s+)?(?:(\S+)\s+)?Warning:\s*(.*)$/;
/** The gutter marker a package prints on its warning's continuation lines
 *  (`(hyperref)                removing …`). A bare `(word)` only — anything
 *  holding a `/`, a `.` or a space is a file being opened, not a marker. */
const WARN_CONT_MARKER = /^\([A-Za-z][\w-]*\)\s+/;
/** `Overfull \hbox (12.3pt too wide) in paragraph at lines 12--14`. */
const BOX_WARNING = /^(Over|Under)full \\[hv]box \(([^)]*)\)(.*?)(?:at lines (\d+)--(\d+)|at line (\d+))?\.?$/;
/** A file being opened in the log, matched right after its `(`. Only paths
 *  carrying a recognised source extension count — TeX prints `(` for a great many
 *  things that are not files, and a bogus entry would misattribute every warning
 *  after it. */
const LOG_FILE_OPEN = /^[^()\s]*\.(?:tex|ltx|sty|cls|def|clo|fd)\b/i;

/** The `(file … )` nesting a log line advances. Parens are counted for DEPTH
 *  regardless of what they hold — TeX prints `(12.3pt too wide)` and a hundred
 *  other bracketed asides — and only the ones that open a source file are
 *  remembered, at the depth they opened at. Closing a depth forgets every file at
 *  or below it, so an unbalanced aside cannot silently pop a real file off. */
interface TexLogFiles {
  depth: number;
  open: Array<{ depth: number; file: string }>;
}

/** The file the log is currently inside, if the nesting named one. */
function currentLogFile(state: TexLogFiles): string | undefined {
  return state.open[state.open.length - 1]?.file;
}

/** Advance the nesting over one log line. */
function advanceLogFiles(state: TexLogFiles, line: string): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") {
      state.depth++;
      const m = LOG_FILE_OPEN.exec(line.slice(i + 1));
      if (m) {
        state.open.push({ depth: state.depth, file: m[0] });
        i += m[0].length;
      }
    } else if (ch === ")") {
      while (state.open.length && state.open[state.open.length - 1].depth >= state.depth) {
        state.open.pop();
      }
      state.depth = Math.max(0, state.depth - 1);
    }
  }
}

/** Classify a warning by its text. The families are the ones a reader acts on
 *  differently: a missing reference is fixed in the source, an overfull box is a
 *  typesetting decision, a font substitution is usually accepted. */
function classifyTexWarning(message: string): TexWarningKind {
  const m = message.toLowerCase();
  if (m.startsWith("reference ") || m.includes("undefined references")) return "reference";
  if (m.startsWith("citation ") || m.includes("undefined citations")) return "citation";
  if (m.includes("font")) return "font";
  return "other";
}

/**
 * Parse the warnings out of a compile log, in order and de-duplicated. Handles
 * the `… Warning: …` family (whose message may continue on the following
 * indented lines, which is where `on input line N` usually ends up) and the
 * bare `Overfull/Underfull \hbox` lines, which follow no such shape.
 *
 * The `(file … )` nesting is tracked while scanning so each warning can name the
 * source TeX was reading. That tracking is best-effort by construction — a log
 * line wrapped mid-path breaks it — so a warning it cannot place carries no
 * `file` rather than a guessed one: the caller falls back to the build root,
 * which is right for a single-file document and honestly unknown for the rest.
 * Pure.
 */
export function parseTexWarnings(log: string): TexWarning[] {
  const out: TexWarning[] = [];
  const seen = new Set<string>();
  const files: TexLogFiles = { depth: 0, open: [] };

  const push = (w: TexWarning) => {
    const key = `${w.kind}:${w.file ?? ""}:${w.line ?? ""}:${w.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };

  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trimEnd();
    // The file a warning on THIS line belongs to is the one open before the line
    // is scanned: a warning printed on the same line as a `(file` opening came
    // from the file that was already open, not the one being entered.
    const fileHere = currentLogFile(files);
    advanceLogFiles(files, raw);

    const box = BOX_WARNING.exec(raw.trim());
    if (box) {
      const line = Number(box[4] ?? box[6]);
      push({
        kind: "box",
        message: `${box[1]}full box (${box[2]})${box[3].trimEnd()}`.trim(),
        file: fileHere,
        line: Number.isFinite(line) && line > 0 ? line : undefined,
      });
      continue;
    }

    const head = WARNING_HEAD.exec(raw.trim());
    if (!head) continue;
    // TeX wraps a warning over the following indented/continuation lines, and
    // `on input line N` is regularly on one of them — so the message is the head
    // plus the run of non-blank lines under it that start no new report. Each
    // consumed line still advances the nesting; only this loop reads it.
    let message = head[3].trim();
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j].trim();
      if (!cont || WARNING_HEAD.test(cont) || BOX_WARNING.test(cont)) break;
      // A package continues its own warning behind a `(name)` gutter marker,
      // which is a continuation to keep (with the marker stripped) — while a
      // line that OPENS a file, or a `!` error, ends the warning. Telling them
      // apart is what `WARN_CONT_MARKER` is for: only a bare `(word)` counts.
      const marker = WARN_CONT_MARKER.exec(cont);
      if (!marker && /^[(!)]/.test(cont)) break;
      message = `${message} ${marker ? cont.slice(marker[0].length) : cont}`.trim();
      advanceLogFiles(files, lines[j].trimEnd());
      i = j;
    }
    const at = /on input line (\d+)/.exec(message);
    const source = head[1] === "Package" || head[1] === "Class" ? `${head[2]}: ` : "";
    push({
      kind: classifyTexWarning(message),
      message: (source + message).replace(/\s+/g, " ").trim(),
      file: fileHere,
      line: at ? Number(at[1]) : undefined,
    });
  }
  return out;
}

// --- Per-file build diagnostics (the structure sidebar's badges) -------------
//
// The Errors and Warnings cards answer "what is wrong" for the build as a
// whole, and are read from the file the reader happens to be editing. In a
// document split across a dozen `\input`s that leaves the other question
// unanswered: WHICH file is broken. The structure sidebar already draws the
// document as its files, so it is the one surface where an answer costs a
// glance — hence the counts below, bucketed to the same absolute paths the
// structure tree is keyed by.

/** One file's share of the last build's log. */
export interface TexFileDiagnostics {
  errors: number;
  warnings: number;
  /** 1-based line of the file's FIRST error, for the badge's jump. */
  errorLine?: number;
  /** …and of its first *locatable* warning (many carry no line at all). */
  warningLine?: number;
}

/**
 * Bucket a build's errors and warnings by the absolute path of the file each is
 * in, ready for the structure sidebar to look up per row. `rootDir` and
 * `rootPath` are the built document's directory and path: log locations are
 * relative to the former, and a warning TeX's `(…)` nesting could not place
 * falls back to the latter — the same rule the Warnings card renders under, so
 * a warning cannot be attributed to one file in the list and another in the
 * badge. Pure / unit-tested.
 */
export function texDiagnosticsByFile(
  rootDir: string,
  rootPath: string,
  errors: TexError[],
  warnings: TexWarning[],
): Map<string, TexFileDiagnostics> {
  const out = new Map<string, TexFileDiagnostics>();
  const bucket = (path: string): TexFileDiagnostics => {
    let d = out.get(path);
    if (!d) {
      d = { errors: 0, warnings: 0 };
      out.set(path, d);
    }
    return d;
  };
  for (const e of errors) {
    const d = bucket(resolveTexErrorPath(rootDir, e.file));
    d.errors += 1;
    // First in log order wins: that is the one worth jumping to, since a LaTeX
    // build's later errors are usually the first one's wreckage.
    if (d.errorLine === undefined) d.errorLine = e.line;
  }
  for (const w of warnings) {
    const d = bucket(resolveTexErrorPath(rootDir, w.file ?? rootPath));
    d.warnings += 1;
    if (d.warningLine === undefined && w.line !== undefined) d.warningLine = w.line;
  }
  return out;
}

// --- SyncTeX forward/reverse search -----------------------------------------

/** A source location from SyncTeX reverse search; mirrors backend `SyncSource`. */
export type SyncSource = {
  /** Absolute path to the source `.tex`. */
  input: string;
  /** 1-based source line. */
  line: number;
  /** 1-based source column (0 when SyncTeX did not report one). */
  column: number;
};

/** A PDF box from SyncTeX forward search; mirrors backend `SyncRect`. Units are
 *  big points (72 dpi) measured from the page's top-left corner. */
export type SyncRect = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Reverse search: which source line produced `(x, y)` (big points from the
 *  page top-left) on `page` of `pdf`. Resolves to null on any error / no hit. */
export function synctexEdit(
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<SyncSource | null> {
  return invoke<SyncSource | null>("synctex_edit", { pdf, page, x, y }).catch(() => null);
}

/** What reverse search can promise for a PDF right now; mirrors the backend
 *  `MapStatus`. Every true/non-empty field is a reason to recompile. */
export type SyncTexStatus = {
  /** A `.synctex(.gz)` sits beside the PDF at all. */
  has_map: boolean;
  /** The PDF was rebuilt after the map (without SyncTeX, or by another tool). */
  pdf_newer_than_map: boolean;
  /** Local sources saved after the map was written, absolute paths. */
  newer_sources: string[];
};

/** Probe the SyncTeX map beside `pdf`. Resolves to null when the backend cannot
 *  answer (a backend not yet rebuilt for it), which the caller reads as "unknown"
 *  and words nothing from. */
export function synctexStatus(pdf: string): Promise<SyncTexStatus | null> {
  return invoke<SyncTexStatus>("synctex_status", { pdf }).catch(() => null);
}

/** The notice a reverse-search click deserves, from the map's status and whether
 *  the click resolved. Pure, so the wording decision is unit-tested:
 *   - `noMap`     nothing to resolve against — compile with SyncTeX first;
 *   - `pdfNewer`  the PDF outgrew its map — the positions are a previous build's;
 *   - `stale`     a source was saved after the build — the line is the old one;
 *   - `miss`      the map is current but nothing was set at that spot;
 *   - `null`      a clean hit, or a status the backend could not report.
 *  A stale/pdf-newer notice is shown even on a hit: the jump still happens (a
 *  nearby line beats nothing), but the reader is told why it may be off. */
export type SyncNoticeKind = "noMap" | "pdfNewer" | "stale" | "miss";
export function syncNoticeKind(
  status: SyncTexStatus | null,
  hit: boolean,
): SyncNoticeKind | null {
  if (!status) return hit ? null : "miss";
  if (!status.has_map) return "noMap";
  if (status.pdf_newer_than_map) return "pdfNewer";
  if (status.newer_sources.length > 0) return "stale";
  return hit ? null : "miss";
}

/** Forward search: every SyncTeX record (`input:line:column` → the line's
 *  constituent boxes / wrapped rows). Resolves to `[]` when the query *ran* but
 *  matched nothing, and to `null` when the backend command itself errored — i.e.
 *  SyncTeX could not run at all (the `synctex` tool absent, or a backend not yet
 *  rebuilt for it). Keeping the two apart is what lets the caller tell an honest
 *  "no match on that line" from "jump-to-cursor is unavailable" (they used to
 *  read identically as a miss). */
export function synctexView(
  pdf: string,
  input: string,
  line: number,
  column: number,
): Promise<SyncRect[] | null> {
  return invoke<SyncRect[]>("synctex_view", { pdf, input, line, column }).catch(() => null);
}

/**
 * SyncTeX forward search is sensitive to how the source path is spelled — it
 * matches the `-i` input against the path string recorded at compile time, which
 * may be the absolute path, the name relative to the compile dir, or a bare
 * basename depending on the engine/version and how the file was passed in. Tabtivity
 * compiles with the bare filename, so an absolute `-i` often fails to match. This
 * tries the absolute path, the path relative to the build dir, and the basename
 * (deduped, in that order) and returns the first spelling that yields records —
 * so forward search works regardless of which spelling SyncTeX stored.
 *
 * Propagates {@link synctexView}'s two failure modes so the caller can tell them
 * apart: `[]` when SyncTeX ran but no spelling matched (a genuine miss), `null`
 * when *every* attempt errored — i.e. SyncTeX could not run at all (unavailable).
 * A single spelling that runs (even to an empty result) counts as "ran", so a
 * mismatched spelling never masquerades as unavailable.
 */
export async function synctexViewBest(
  pdf: string,
  input: string,
  rootDir: string,
  line: number,
  column: number,
): Promise<SyncRect[] | null> {
  let ran = false;
  for (const cand of forwardInputCandidates(input, rootDir)) {
    const recs = await synctexView(pdf, cand, line, column);
    if (recs === null) continue; // this attempt errored — the next spelling may run
    ran = true;
    if (recs.length) return recs; // first spelling that matched wins
  }
  return ran ? [] : null;
}

/**
 * The clicked column's position along its source line, as a fraction in `[0, 1]`.
 * `column` is 1-based. Used to pick which SyncTeX record (the line's boxes /
 * wrapped rows, left-to-right then top-to-bottom) the caret lands in — so a click
 * late on a line that wrapped maps to the lower row, not the first box SyncTeX
 * happened to list. A blank/one-char line maps to 0. Pure / unit-tested.
 */
export function sourceColumnFraction(text: string, line: number, column: number): number {
  const start = lineStartOffset(text, line);
  const nl = text.indexOf("\n", start);
  const len = (nl === -1 ? text.length : nl) - start;
  if (len <= 1) return 0;
  // column is 1-based; clamp into [0, len] then normalise by the line length.
  const c = Math.max(0, Math.min(column - 1, len));
  return c / len;
}

/**
 * Pick the SyncTeX forward-search record the clicked column lands in. The records
 * are the line's constituent boxes (and, when the source line wrapped, one row
 * per visual line); read in order (top-to-bottom, then left-to-right) their
 * widths tile the line, so the box covering `frac` of the cumulative horizontal
 * advance is the one under the caret. This resolves the ROW under wrapping (which
 * pure text matching could not), leaving the exact word to {@link refineToWord}.
 * Returns null only for an empty list. Pure / unit-tested.
 */
export function pickSyncRect(records: SyncRect[], frac: number): SyncRect | null {
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];
  const sorted = [...records].sort((a, b) => a.y - b.y || a.x - b.x);
  // Zero-width boxes (SyncTeX occasionally omits W) count as one unit so the
  // walk still advances and never divides by zero.
  const widths = sorted.map((r) => (r.w > 0 ? r.w : 1));
  const total = widths.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    const mid = acc + widths[i] / 2;
    if (mid / total >= frac) return sorted[i];
    acc += widths[i];
  }
  return sorted[sorted.length - 1];
}

/** The source-path spellings to try for SyncTeX forward search, in order: the
 *  absolute path, the path relative to the build dir, and the bare basename
 *  (deduped). Pure / unit-tested — {@link synctexViewBest} feeds each to
 *  `synctex view -i` until one matches. */
export function forwardInputCandidates(input: string, rootDir: string): string[] {
  const rel = forwardRelative(rootDir, input);
  const base = basename(input);
  // SyncTeX may have stored the path with a `./` prefix (a common engine
  // spelling); try those forms too.
  const out: string[] = [input];
  for (const r of [rel, base]) {
    if (!r) continue;
    out.push(r, `./${r}`);
  }
  return Array.from(new Set(out));
}

/** `file` expressed relative to directory `dir`, using forward slashes (the
 *  spelling SyncTeX records on every platform), or null when `file` is not under
 *  `dir`. Accepts either separator on either argument so it is correct for native
 *  Windows paths (`C:\proj` + `C:\proj\ch\x.tex` → `ch/x.tex`) as well as POSIX. */
function forwardRelative(dir: string, file: string): string | null {
  const trimmed = dir.replace(/[/\\]+$/, "");
  if (!trimmed) return null;
  const nDir = trimmed.replace(/\\/g, "/");
  const nFile = file.replace(/\\/g, "/");
  return nFile.startsWith(nDir + "/") ? nFile.slice(nDir.length + 1) : null;
}

/** Resolve the file that should actually be compiled for `path` (a child file
 *  redirects to its main document). Falls back to `path` on any error. */
export function resolveTexRoot(path: string): Promise<string> {
  return invoke<string>("resolve_tex_root", { path })
    .then((r) => (typeof r === "string" && r ? r : path))
    .catch(() => path);
}

/**
 * Does `text` read as a document of its own — i.e. does it carry a
 * `\documentclass`? The complement of a fragment: a chapter reached by
 * `\input` never declares one, so this separates "a main document that happens
 * not to be recorded as anybody's child yet" from "a piece of one, opened on its
 * own". Comments are blanked first, so a commented-out `\documentclass` in a
 * fragment's header does not promote it. Pure — the caller supplies the text.
 *
 * Used by the workspace self-heal (`FileViewerPane`): a `.tex` tab's `viewer` is
 * PERSISTED, so a file opened as a bare editor before the one-workspace-per-
 * document policy came back as a bare editor for ever. `resolveTexRoot` alone
 * cannot tell that shape from a deliberate child-editor tab (a drop, a followed
 * link) whose parent has never been compiled and so is in no root map — this
 * does.
 */
export function isTexDocumentRoot(text: string): boolean {
  return /\\documentclass\s*(?:\[[^\]]*\])?\s*\{/.test(blankTexComments(text));
}

/**
 * Map a click on a pdf.js page canvas to SyncTeX big points (72 dpi from the
 * page's top-left). At pdf.js `scale = 1` the viewport unit already equals one
 * big point, so dividing the CSS-pixel offset within the page rect by `scale`
 * recovers big points. `rect` is the page canvas's bounding rect.
 */
export function pdfPointToBigPoints(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
  scale: number,
): { x: number; y: number } {
  return {
    x: (clientX - rect.left) / scale,
    y: (clientY - rect.top) / scale,
  };
}

/** Inverse of {@link pdfPointToBigPoints}: a SyncTeX box in big points → CSS
 *  pixels for positioning a highlight overlay over a page at `scale`. */
export function bigPointsToCssRect(
  rect: SyncRect,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.w * scale,
    height: rect.h * scale,
  };
}

/**
 * The characters a word is broken with at the end of a line. A hyphen-minus, the
 * typographic hyphen, and the soft hyphen — deliberately **not** an en or em dash,
 * which at a line end is ordinary punctuation ("pages 3–\n4") rather than a word cut
 * in half, and dropping one would join two words that are not one.
 */
const LINE_BREAK_HYPHENS = new Set(["-", "‐", "­"]);

/**
 * Do these two runs sit on different lines?
 *
 * pdf.js's own `hasEOL` is asked first, because it is the producer's answer rather
 * than a guess. Where it is missing the geometry stands in: the next run sits clearly
 * below this one, or starts back to the left of where it began (a wrapped line, or
 * the next column).
 */
function breaksLine(a: TextItemBox, b: TextItemBox): boolean {
  if (a.eol) return true;
  return Math.abs(b.y - a.y) > Math.max(a.h, b.h) * 0.5 || b.x + 1 < a.x;
}

/** The text a page is searched over, plus, per character, which run it came from and
 *  where in that run — so a match can be sliced back into boxes exactly. */
interface PageHaystack {
  text: string;
  /** Run index per character of `text`; -1 for a character this module inserted. */
  item: number[];
  /** Index within that run; -1 for an inserted character. */
  char: number[];
  /** Runs whose trailing hyphen was dropped as a line break. */
  dehyphenated: Set<number>;
}

/**
 * A page's runs joined into one searchable string, **with the line breaks read**.
 *
 * This is the whole of "find a word that is split across two lines". A PDF has no
 * words and no lines — it has positioned runs of glyphs — so a paragraph that wraps
 * arrives as `…"hyphen-"` then `"ation"…`, and joining the runs end to end (which is
 * what this did before) produces `hyphen-ation`: a reader searching for *hyphenation*
 * finds nothing, on a page where the word is plainly printed. Worse, two whole words
 * either side of a line break joined into `theend`, so a phrase that happened to wrap
 * could not be searched for at all.
 *
 * So a break is not nothing. Where a run ends a line:
 *
 * - a trailing hyphen is **dropped**, joining the two halves into the word the
 *   typesetter split (`hyphen-` + `ation` → `hyphenation`);
 * - otherwise a **space** is inserted, because that is what the break means to a
 *   reader — unless one of the two sides already carries whitespace, or the query
 *   would need two spaces where the page shows one break.
 *
 * The per-character map is what keeps the highlight honest through all of that: the
 * boxes are still sliced out of the runs' own geometry, so a match across a break is
 * drawn as one box per line, and the dropped hyphen is included in the box (a
 * highlight stopping just short of the hyphen it matched *through* reads as a bug).
 *
 * Case folding happens **here**, character by character, rather than by lowercasing
 * the joined string: a few characters (`İ`, `ẞ` in some locales) fold to two, which
 * would shift every index after them and slide the highlights off the words. A
 * character that does not fold to exactly one is kept as it is — it will only ever
 * fail to match case-insensitively, which is a smaller wrong than a misplaced box.
 */
function pageHaystack(items: readonly TextItemBox[], caseSensitive: boolean): PageHaystack {
  let text = "";
  const item: number[] = [];
  const char: number[] = [];
  const dehyphenated = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const next = items[i + 1];
    const broken = next != null && breaksLine(it, next);
    const cut =
      broken && it.str.length > 0 && LINE_BREAK_HYPHENS.has(it.str[it.str.length - 1]) ? 1 : 0;
    if (cut) dehyphenated.add(i);
    for (let c = 0; c < it.str.length - cut; c++) {
      const ch = it.str[c];
      if (caseSensitive) {
        text += ch;
      } else {
        const low = ch.toLowerCase();
        text += low.length === 1 ? low : ch;
      }
      item.push(i);
      char.push(c);
    }
    if (broken && !cut && text.length > 0) {
      const hasSpace = /\s$/.test(it.str) || /^\s/.test(next.str);
      if (!hasSpace) {
        text += " ";
        item.push(-1);
        char.push(-1);
      }
    }
  }
  return { text, item, char, dehyphenated };
}

/**
 * Find every occurrence of `query` in a PDF page's extracted text runs, returning one
 * entry per match — each a list of big-point boxes ({@link SyncRect}) covering it.
 * Most matches yield a single box; a match that straddles text-run boundaries — or a
 * line break — yields one box per run it touches. Case-insensitive unless
 * `caseSensitive`.
 *
 * The runs are joined by {@link pageHaystack}, which reads the line breaks rather than
 * ignoring them, so a word the typesetter split across two lines is found under the
 * word a reader would type. Each run's box is sliced by the matched character span
 * using its uniform per-character width. An empty query (or no items) yields no
 * matches. Pure — unit-tested; the caller derives `items` via `getTextContent()` at
 * scale 1, the same boxes SyncTeX word-refinement uses, so highlights sit on the
 * glyphs.
 */
export function pdfPageMatches(
  items: TextItemBox[],
  page: number,
  query: string,
  caseSensitive: boolean,
): SyncRect[][] {
  if (!query) return [];
  const { text, item, char, dehyphenated } = pageHaystack(items, caseSensitive);
  // The query is folded the same way the page was, and for the same reason.
  const needle = caseSensitive
    ? query
    : [...query].map((c) => (c.toLowerCase().length === 1 ? c.toLowerCase() : c)).join("");
  const out: SyncRect[][] = [];
  for (let from = 0; ; ) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) break;
    const end = idx + needle.length;
    // Which characters of which runs the match covers. Insertion order is run order,
    // so the boxes come out in reading order without a second sort.
    const spans = new Map<number, { a: number; b: number }>();
    for (let k = idx; k < end; k++) {
      const i = item[k];
      if (i < 0) continue; // an inserted space stands for a break, not for a glyph
      const span = spans.get(i);
      if (!span) spans.set(i, { a: char[k], b: char[k] + 1 });
      else {
        span.a = Math.min(span.a, char[k]);
        span.b = Math.max(span.b, char[k] + 1);
      }
    }
    const rects: SyncRect[] = [];
    const runs = [...spans.keys()];
    for (const i of runs) {
      const it = items[i];
      const span = spans.get(i)!;
      if (it.w <= 0 || it.str.length === 0) continue;
      // A match that runs THROUGH a dropped hyphen covers it: the glyph is on the
      // page, inside the word that was matched, and a highlight stopping one
      // character short of it looks like the search missed the end of the word.
      const b =
        dehyphenated.has(i) && i !== runs[runs.length - 1] && span.b === it.str.length - 1
          ? it.str.length
          : span.b;
      const charW = it.w / it.str.length;
      rects.push({ page, x: it.x + span.a * charW, y: it.y, w: (b - span.a) * charW, h: it.h });
    }
    if (rects.length) out.push(rects);
    from = end; // non-overlapping, mirroring findMatches
  }
  return out;
}

/** Character offset of the start of (1-based) `line` in `text`. Clamped to the
 *  valid range; a line past the end maps to the text length. */
export function lineStartOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  let seen = 1;
  while (seen < line) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    seen += 1;
  }
  return offset;
}

/** 1-based {line, column} of character `offset` in `text` (column counts from
 *  the start of the line). Used to feed SyncTeX forward search from the caret. */
export function offsetToLineCol(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

// --- Word-precise forward search (Ctrl+Click → exact word in the PDF) ---------
//
// SyncTeX forward search resolves a caret to a line-ish *box* in the PDF, which
// is often a whole line. We narrow that box to the exact clicked word. A single
// word is ambiguous (a common word like "the" appears all over), so the matcher
// also takes the NEIGHBOURING words around the caret and prefers the occurrence
// where that surrounding phrase agrees — disambiguating which "the" to box.
// `phraseAt` pulls the word + its neighbours out of the source; `refineToWord`
// locates the clicked word in the PDF text using that context.
//
// When the surrounding phrase ITSELF repeats on the line (boilerplate, list
// items, "the … the …"), neighbour matching ties and the old tiebreak — nearest
// the line box's horizontal centre — picked an occurrence essentially at random.
// The fix is a signal duplicates can't share: the clicked word's ORDINAL
// POSITION in its line. `phraseAt` records the caret's word index on the source
// line (`lineIndex`) and `refineToWord` compares it to each PDF occurrence's
// index within its visual row, so the occurrence at the matching position wins.

/** A run of letters/digits (with internal hyphens/apostrophes), so a click in
 *  the middle of "framework" still selects the whole word. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lowercase + strip leading/trailing non-alphanumerics, so a source word and a
 *  PDF token with attached punctuation/quotes compare equal ("(word)" → "word"). */
function normWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/** Natural-language words in `s` after stripping TeX control sequences / markup,
 *  so only text that actually appears in the PDF survives (`\emph{x}` → `x`). */
function texWords(s: string): string[] {
  const stripped = s
    .replace(/\\[a-zA-Z]+\*?/g, " ") // control words: \emph, \textbf, …
    .replace(/\\[^a-zA-Z]/g, " ") // control symbols: \&, \%, …
    .replace(/[{}$&%#~^_\\]/g, " "); // braces, math, other specials
  const out: string[] = [];
  const re = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) out.push(m[0].toLowerCase());
  return out;
}

/**
 * The natural-language word under `caret` in `source` — a maximal run of
 * letter/digit characters around the caret (internal hyphens/apostrophes kept) —
 * or null when the caret isn't on a word (whitespace, punctuation, a backslash).
 * Pure / unit-tested.
 */
export function wordAt(source: string, caret: number): string | null {
  if (caret < 0 || caret > source.length) return null;
  const isWord = (ch: string) => WORD_CHAR.test(ch) || ch === "-" || ch === "'" || ch === "’";
  let start = caret;
  let end = caret;
  while (start > 0 && isWord(source[start - 1])) start--;
  while (end < source.length && isWord(source[end])) end++;
  // Trim any leading/trailing connector chars so "word-" → "word".
  let s = source.slice(start, end);
  s = s.replace(/^[-'’]+/, "").replace(/[-'’]+$/, "");
  // Require at least one real word character (not a lone connector run).
  return WORD_CHAR.test(s) ? s : null;
}

/** The clicked word plus its same-line neighbours, for disambiguating which
 *  occurrence to highlight. `words` is the phrase in reading order (lowercased,
 *  markup stripped); `index` is the position of the clicked word within it.
 *  `lineIndex` is the clicked word's UNCAPPED ordinal among the natural-language
 *  words on its source line (0-based), used to break ties between repeated
 *  phrases by position rather than by proximity to the line centre. Optional so
 *  callers/tests can build a bare `{words, index}`; when absent `refineToWord`
 *  falls back to `index`. */
export interface CaretPhrase {
  words: string[];
  index: number;
  lineIndex?: number;
}

/**
 * Build a {@link CaretPhrase} for the caret: the clicked word plus up to `radius`
 * natural-language words on each side, staying on the same source line and
 * skipping TeX markup. Returns null when the caret isn't on a word. Pure /
 * unit-tested. Words are lowercased so matching is case-insensitive.
 */
export function phraseAt(source: string, caret: number, radius = 3): CaretPhrase | null {
  const clicked = wordAt(source, caret);
  if (!clicked) return null;
  const isWord = (ch: string) =>
    !!ch && (WORD_CHAR.test(ch) || ch === "-" || ch === "'" || ch === "’");
  let ws = caret;
  let we = caret;
  while (ws > 0 && isWord(source[ws - 1])) ws--;
  while (we < source.length && isWord(source[we])) we++;
  const lineStart = source.lastIndexOf("\n", ws - 1) + 1;
  const nl = source.indexOf("\n", we);
  const lineEnd = nl < 0 ? source.length : nl;
  const beforeAll = texWords(source.slice(lineStart, ws));
  const before = beforeAll.slice(-radius);
  const after = texWords(source.slice(we, lineEnd)).slice(0, radius);
  return {
    words: [...before, clicked.toLowerCase(), ...after],
    index: before.length,
    // Uncapped count of words ahead of the clicked one on its source line.
    lineIndex: beforeAll.length,
  };
}

/** A PDF page's extracted text run, positioned in big points (72 dpi) from the
 *  page's top-left — the same coordinate space as {@link SyncRect}. The caller
 *  derives these from pdf.js `getTextContent()` items at viewport scale 1. */
export interface TextItemBox {
  /** The run's text. */
  str: string;
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Run width. */
  w: number;
  /** Run height (≈ font size). */
  h: number;
  /** This run ends a line (pdf.js's own `hasEOL`). Optional because the geometry
   *  answers the same question well enough when it is missing — see
   *  {@link breaksLine} — but the flag is the producer's word and is trusted first. */
  eol?: boolean;
}

/** A single positioned PDF word (normalised text + its box in big points). */
interface WordBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Split each text run into positioned word boxes (whitespace-delimited tokens),
 *  estimating each token's box from its character span within the run. The box
 *  hugs the word's alphanumeric core: a token's attached punctuation/quotes
 *  ("(word)," → "word") is matched out by {@link normWord} for comparison, and
 *  trimmed off the box too so the highlight sits on the word, not the surround. */
function wordBoxes(items: TextItemBox[]): WordBox[] {
  const out: WordBox[] = [];
  for (const it of items) {
    if (!it.str || it.w <= 0) continue;
    const charW = it.w / it.str.length;
    const re = /\S+/g;
    for (let m = re.exec(it.str); m; m = re.exec(it.str)) {
      const raw = m[0];
      const text = normWord(raw);
      if (!text) continue;
      // Characters of leading/trailing punctuation to shave off the token's box,
      // matching what normWord dropped from `text`, so x/w span only the core.
      const lead = raw.length - raw.replace(/^[^\p{L}\p{N}]+/u, "").length;
      const trail = raw.length - raw.replace(/[^\p{L}\p{N}]+$/u, "").length;
      const coreLen = raw.length - lead - trail;
      out.push({
        text,
        x: it.x + (m.index + lead) * charW,
        y: it.y,
        w: coreLen * charW,
        h: it.h,
      });
    }
  }
  return out;
}

/**
 * Each word's ordinal position within its visual PDF row (0-based, left-to-right),
 * parallel to `words` (so `out[p]` is the column index of `words[p]`). Rows are
 * formed by clustering on the vertical centre with a tolerance of ~0.6 of the
 * word height, so a single line of output groups together regardless of minor
 * baseline jitter. Used to disambiguate a repeated word by matching the clicked
 * word's source-line position against the PDF position.
 */
function rowIndices(words: WordBox[]): number[] {
  const col = new Array<number>(words.length).fill(0);
  // Visit words top-to-bottom (then left-to-right) so consecutive entries with a
  // close `y` form one row; flush a row when the next word drops far enough below.
  const order = words.map((_, i) => i).sort((a, b) => words[a].y - words[b].y || words[a].x - words[b].x);
  let members: number[] = [];
  let rowTop = -Infinity;
  const flush = () => {
    members.sort((a, b) => words[a].x - words[b].x);
    members.forEach((p, k) => (col[p] = k));
    members = [];
  };
  for (const p of order) {
    const tol = (words[p].h || 12) * 0.6;
    if (members.length && words[p].y - rowTop > tol) flush();
    if (!members.length) rowTop = words[p].y;
    members.push(p);
  }
  flush();
  return col;
}

/** Fallback when phrase matching finds nothing: locate `needle` as a substring of
 *  any run, nearest the target line. Handles words a token split would miss. */
function refineSingle(target: SyncRect, needle: string, items: TextItemBox[]): SyncRect | null {
  if (!needle) return null;
  const tcx = target.x + target.w / 2;
  const tcy = target.y + target.h / 2;
  let best: { rect: SyncRect; score: number } | null = null;
  for (const it of items) {
    if (!it.str || it.w <= 0) continue;
    const hay = it.str.toLowerCase();
    for (let idx = hay.indexOf(needle); idx >= 0; idx = hay.indexOf(needle, idx + needle.length)) {
      const charW = it.w / it.str.length;
      const x = it.x + idx * charW;
      const w = needle.length * charW;
      const cy = it.y + it.h / 2;
      const dy = Math.max(0, Math.abs(cy - tcy) - (target.h + it.h) / 2);
      const before = idx > 0 ? hay[idx - 1] : " ";
      const after = idx + needle.length < hay.length ? hay[idx + needle.length] : " ";
      const whole = !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
      const score = dy * 1e6 + Math.abs(x + w / 2 - tcx) + (whole ? 0 : 500);
      if (!best || score < best.score) best = { rect: { page: target.page, x, y: it.y, w, h: it.h }, score };
    }
  }
  return best ? best.rect : null;
}

/**
 * Narrow a SyncTeX forward-search box (`target`, typically a whole source line's
 * output) down to the exact word the caret sat on, using the surrounding
 * `phrase` for disambiguation. Tokenises the PDF page's `items` into positioned
 * words and, for each occurrence of the clicked word, counts how many of the
 * neighbouring phrase words also line up around it. Occurrences are ranked
 * lexicographically:
 *   1. the most matching phrase context (the strongest signal for WHICH
 *      occurrence the caret meant — and one a repeated word can't fake);
 *   2. then nearest the target row (`target` is the box {@link pickSyncRect}
 *      chose for the clicked column — only a tiebreak, because for a word that
 *      repeats on a source line that WRAPPED, that pick can land on the wrong
 *      visual row, so it must not override clear phrase context);
 *   3. then — when the phrase itself repeats — the occurrence whose position
 *      within its PDF row matches the clicked word's ordinal on the source line
 *      (`phrase.lineIndex`);
 *   4. and finally nearest the line centre horizontally.
 * Returns a tight box around the clicked word, or null (→ caller keeps the line
 * box). Pure / tested.
 */
export function refineToWord(
  target: SyncRect,
  phrase: CaretPhrase,
  items: TextItemBox[],
): SyncRect | null {
  const pw = phrase.words.map((w) => normWord(w));
  const ci = phrase.index;
  if (!pw.length || ci < 0 || ci >= pw.length || !pw[ci]) {
    return null;
  }
  const words = wordBoxes(items);
  const col = rowIndices(words);
  // The clicked word's ordinal on its source line; fall back to its index within
  // the (capped) phrase when a bare phrase carries no line position.
  const srcIndex = phrase.lineIndex ?? ci;
  const tcx = target.x + target.w / 2;
  const tcy = target.y + target.h / 2;
  // A candidate's ranking key, compared lexicographically (see the doc comment):
  // more matches wins; then the smaller row distance; then the smaller source-
  // line-position penalty; then the smaller horizontal distance. Sub-pixel `dy`
  // differences count as a tie so two words on the same visual row fall through
  // to the position/horizontal tiebreaks rather than splitting on jitter.
  interface Cand { rect: SyncRect; matches: number; dy: number; pos: number; xd: number; }
  const better = (a: Cand, b: Cand): boolean => {
    if (a.matches !== b.matches) return a.matches > b.matches;
    if (Math.abs(a.dy - b.dy) > 0.5) return a.dy < b.dy;
    if (a.pos !== b.pos) return a.pos < b.pos;
    return a.xd < b.xd;
  };
  let best: Cand | null = null;
  for (let p = 0; p < words.length; p++) {
    if (words[p].text !== pw[ci]) continue;
    // Count contiguous phrase words matching on each side of the clicked word.
    let matches = 1;
    for (let d = 1; ci - d >= 0 && p - d >= 0 && words[p - d].text === pw[ci - d]; d++) matches++;
    for (let d = 1; ci + d < pw.length && p + d < words.length && words[p + d].text === pw[ci + d]; d++) {
      matches++;
    }
    const wb = words[p];
    const cy = wb.y + wb.h / 2;
    const dy = Math.max(0, Math.abs(cy - tcy) - (target.h + wb.h) / 2);
    const pos = Math.min(Math.abs(col[p] - srcIndex), 900);
    const xd = Math.abs(wb.x + wb.w / 2 - tcx);
    const cand: Cand = {
      rect: { page: target.page, x: wb.x, y: wb.y, w: wb.w, h: wb.h },
      matches, dy, pos, xd,
    };
    if (!best || better(cand, best)) best = cand;
  }
  return best ? best.rect : refineSingle(target, pw[ci], items);
}

// --- Math/environment delimiter matching (bracket-match, LaTeX extras) ------
//
// The editor's plain ()[]{} matcher (`FileViewerPane.findMatchingBracket`)
// covers group braces and optional-arg brackets, but LaTeX has three more
// delimiter families worth the same "highlight the matching one" affordance:
// math-mode toggles (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and `\begin{env}…
// \end{env}` structure blocks. Kept here rather than in FileViewerPane
// because they're LaTeX syntax, not generic code-editor behaviour — the
// caller only tries these when the open file's language is "tex".
//
// `TexDelimiterMatch` is structurally identical to FileViewerPane's
// `BracketMatch` ({open,close} ranges) on purpose, so `decorateBracketMatch`
// can render either without either module importing the other's type
// (importing FileViewerPane's type back into this module, which
// FileViewerPane already imports from, would be a cycle).

/** One side of a matched delimiter: a `[start, end)` source range — mirrors
 *  FileViewerPane's `BracketSide`. */
export interface TexDelimiterSide {
  start: number;
  end: number;
}

/** A matched math/environment delimiter pair — mirrors FileViewerPane's
 *  `BracketMatch` (see the section comment above for why it's a separate,
 *  structurally-identical type rather than an import). */
export interface TexDelimiterMatch {
  open: TexDelimiterSide;
  close: TexDelimiterSide;
}

/** Builds a clean `{start,end}`-only pair from whatever token objects the two
 *  scanners pass in (both carry an extra `kind` field the caller has no use
 *  for once matched) — stripped explicitly rather than relying on TS's
 *  structural typing to hide it, since excess properties on a plain object
 *  survive at runtime regardless of what the parameter type says. */
function texDelimiterPair(open: TexDelimiterSide, close: TexDelimiterSide): TexDelimiterMatch {
  return {
    open: { start: open.start, end: open.end },
    close: { start: close.start, end: close.end },
  };
}

/**
 * How closely `caret` "touches" `side` — the same test the plain bracket
 * matcher applies to a single character, generalised to a multi-character
 * token (`\[`, `$$`, a whole `\begin{itemize}`): anywhere in the token counts,
 * not just its two ends. Returns a rank rather than a boolean so a caller
 * choosing among several candidate tokens can prefer the closer touch —
 * `0` (caret sits right before the token, at its `start`) beats `1` (right
 * after, at its `end`) beats `2` (strictly inside it); `null` when caret
 * doesn't touch it at all. The rank matters when two tokens are directly
 * adjacent with nothing between them (`\end{a}\begin{b}`): the boundary caret
 * sits at BOTH `\end{a}`'s `end` and `\begin{b}`'s `start`, and rank prefers
 * `\begin{b}` — the same "check the token starting right at the caret before
 * the one ending there" priority `FileViewerPane.findMatchingBracket` uses
 * for `()[]{}`. */
function touchRank(side: TexDelimiterSide, caret: number): number | null {
  if (side.start === caret) return 0;
  if (side.end === caret) return 1;
  if (caret > side.start && caret < side.end) return 2;
  return null;
}

/** One recognised math-delimiter token in source order. `$$` is matched
 *  before a lone `$` (checked first in the scanner below) so display math
 *  isn't split into two bogus inline-math tokens. */
interface MathToken {
  kind: "dollar" | "ddollar" | "pOpen" | "pClose" | "bOpen" | "bClose";
  start: number;
  end: number;
}

/** True when the run of backslashes immediately before `pos` has odd length —
 *  i.e. the character AT `pos` is itself escaped (`\$` is a literal dollar
 *  sign, not a math toggle; `\\$` is a literal backslash followed by a real
 *  toggle, so it is NOT escaped). The standard TeX parity rule. */
function isBackslashEscaped(text: string, pos: number): boolean {
  let n = 0;
  for (let i = pos - 1; i >= 0 && text[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/**
 * Blank every TeX line comment — an unescaped `%` to the end of its line — with
 * spaces, leaving the string the SAME length (offsets, and every `\n`, are
 * preserved) so a caller can keep scanning it with the module's offset-based
 * regexes and still map a match back onto the real source. This is what makes the
 * structure sidebar and the editor's link layer ignore a commented-out
 * `\input{…}`/`\includegraphics{…}` rather than list it, underline it or follow it
 * on Ctrl+click. `\%` (an escaped literal percent) is not a comment. Deliberately
 * shallow like the rest of this module — it does not skip `verbatim`/`\verb` bodies
 * (a `%` there is treated as a comment), which at worst hides a reference nested
 * inside verbatim, never a real one. Pure.
 */
export function blankTexComments(source: string): string {
  // Hops from `%` to `%` with `indexOf` and copies the stretches between them
  // whole. The character-at-a-time version this replaced was called four times
  // per keystroke from the TeX editor (link layer, key layer, and the live
  // completion merge) and was the single largest share of a keystroke on a
  // long document.
  let out = "";
  let last = 0;
  let i = source.indexOf("%");
  while (i !== -1) {
    if (isBackslashEscaped(source, i)) {
      i = source.indexOf("%", i + 1);
      continue;
    }
    // Blank from here to (not including) the next newline.
    const nl = source.indexOf("\n", i);
    const end = nl === -1 ? source.length : nl;
    out += source.slice(last, i) + " ".repeat(end - i);
    last = end;
    i = source.indexOf("%", end);
  }
  if (last === 0) return source; // no comments: the source is already the answer
  return out + source.slice(last);
}

/**
 * Every math-delimiter token in `text`, in source order: `$`/`$$` (skipping an
 * escaped `\$`) and the literal 2-character sequences `\(`/`\)`/`\[`/`\]`. Not
 * TeX-verbatim/comment-aware (a `%` comment or a verbatim block can contain a
 * bare `$` that isn't really math) — the same "plain scan, no deep parsing"
 * level the rest of this module's regex-based helpers work at.
 *
 * A backslash ALWAYS consumes the character after it, and that single step is
 * what keeps the line break out of the scan: `\\[2mm]` is `\\` followed by an
 * ordinary optional argument, not a `\[` opening display math — which is how a
 * table row spacing its lines used to be diagnosed as an unclosed delimiter
 * (every `\\[…]` in the document painted red, for the whole rest of the file).
 * The same step covers `\$`, `\\)` and every other escaped delimiter, so the
 * parity rule {@link isBackslashEscaped} states is enforced by the walk itself
 * rather than re-tested per token. Pure.
 */
function texMathTokens(text: string): MathToken[] {
  const out: MathToken[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      const two = text.slice(i, i + 2);
      if (two === "\\(") out.push({ kind: "pOpen", start: i, end: i + 2 });
      else if (two === "\\)") out.push({ kind: "pClose", start: i, end: i + 2 });
      else if (two === "\\[") out.push({ kind: "bOpen", start: i, end: i + 2 });
      else if (two === "\\]") out.push({ kind: "bClose", start: i, end: i + 2 });
      i++;
      continue;
    }
    if (text[i] === "$") {
      if (text[i + 1] === "$") { out.push({ kind: "ddollar", start: i, end: i + 2 }); i++; continue; }
      out.push({ kind: "dollar", start: i, end: i + 1 });
    }
  }
  return out;
}

/**
 * Pair up a token stream from {@link texMathTokens}: `\(`/`\)` and `\[`/`\]`
 * nest like ordinary brackets (a stack per kind), while `$` and `$$` are the
 * SAME token on both sides, so they pair by toggling (first one open, next one
 * of the same kind closes it) rather than by a stack. An unmatched opener
 * (odd count, or a `\)`/`\]` with nothing open) is simply dropped, matching
 * this codebase's other bracket matchers' "unbalanced source → no match"
 * behaviour. Pure.
 */
function pairTexMathTokens(tokens: MathToken[]): TexDelimiterMatch[] {
  const pairs: TexDelimiterMatch[] = [];
  const parenStack: MathToken[] = [];
  const bracketStack: MathToken[] = [];
  let openDollar: MathToken | null = null;
  let openDDollar: MathToken | null = null;
  for (const tok of tokens) {
    switch (tok.kind) {
      case "pOpen":
        parenStack.push(tok);
        break;
      case "pClose": {
        const open = parenStack.pop();
        if (open) pairs.push(texDelimiterPair(open, tok));
        break;
      }
      case "bOpen":
        bracketStack.push(tok);
        break;
      case "bClose": {
        const open = bracketStack.pop();
        if (open) pairs.push(texDelimiterPair(open, tok));
        break;
      }
      case "ddollar":
        if (openDDollar) {
          pairs.push(texDelimiterPair(openDDollar, tok));
          openDDollar = null;
        } else {
          openDDollar = tok;
        }
        break;
      case "dollar":
        if (openDollar) {
          pairs.push(texDelimiterPair(openDollar, tok));
          openDollar = null;
        } else {
          openDollar = tok;
        }
        break;
    }
  }
  return pairs;
}

/** What a flagged delimiter's problem is, so the editor can say which mistake
 *  it found rather than one generic "missing partner" for all of them. */
export type TexDelimiterProblem =
  /** An opening delimiter that never receives its closing partner. */
  | "unclosed"
  /** An `\end{…}` with no open `\begin{…}` of that environment name. */
  | "unmatchedEnd";

/** One delimiter the document-wide diagnostic flags: the range to paint, what
 *  is wrong with it, and — for `\begin`/`\end` tokens — the environment name
 *  involved, which the hover hint names. */
export interface TexUnclosedDelimiter extends TexDelimiterSide {
  problem: TexDelimiterProblem;
  env?: string;
}

/**
 * TeX delimiters left without a partner. This is the document-wide diagnostic
 * counterpart of the caret-local match helpers below: ordinary
 * parentheses/brackets/braces, math delimiters, and `\begin{…}`/`\end{…}`
 * blocks all use the same ranges the editor can paint. Comments are blanked
 * first and escaped ordinary brackets are left to TeX's math-token scan or
 * treated as literals, so commented examples and printed braces do not turn a
 * source line red.
 *
 * Environments are paired BY NAME here, unlike the caret-local matcher, which
 * counts depth alone. Depth counting is right for a well-formed document and
 * exactly wrong for a broken one: `\begin{itemize}…\end{enumerate}` cancels
 * out under a depth count, so the one document shape this diagnostic most needs
 * to catch reported nothing at all. Name pairing also lets an `\end` be flagged
 * on its own — the one closing delimiter that is. A stray `}` stays ignored
 * because it says nothing about which group it was meant to close and turns red
 * constantly mid-edit, while `\end{itemize}` names the environment it claims to
 * close and is simply wrong when no `itemize` is open.
 */
export function findUnclosedTexBrackets(source: string): TexUnclosedDelimiter[] {
  const text = blankTexComments(source);
  const unclosed: TexUnclosedDelimiter[] = [];

  // Ordinary groups pair independently by kind, matching the existing plain
  // bracket matcher. LIFO leaves the outer opener behind in a nested group.
  const ordinary = new Map<string, number[]>([
    ["(", []],
    ["[", []],
    ["{", []],
  ]);
  const openFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ordinary.has(ch) || openFor[ch]) && isBackslashEscaped(text, i)) continue;
    const stack = ordinary.get(ch);
    if (stack) {
      stack.push(i);
      continue;
    }
    const open = openFor[ch];
    if (open) ordinary.get(open)?.pop();
  }
  for (const stack of ordinary.values()) {
    for (const start of stack) unclosed.push({ start, end: start + 1, problem: "unclosed" });
  }

  // TeX math pairs: \(...\) and \[...\] are stacks; $ and $$ toggle.
  const parenMath: MathToken[] = [];
  const bracketMath: MathToken[] = [];
  let dollar: MathToken | null = null;
  let doubleDollar: MathToken | null = null;
  for (const tok of texMathTokens(text)) {
    switch (tok.kind) {
      case "pOpen":
        parenMath.push(tok);
        break;
      case "pClose":
        parenMath.pop();
        break;
      case "bOpen":
        bracketMath.push(tok);
        break;
      case "bClose":
        bracketMath.pop();
        break;
      case "dollar":
        dollar = dollar ? null : tok;
        break;
      case "ddollar":
        doubleDollar = doubleDollar ? null : tok;
        break;
    }
  }
  for (const tok of [...parenMath, ...bracketMath]) {
    unclosed.push({ start: tok.start, end: tok.end, problem: "unclosed" });
  }
  if (dollar) unclosed.push({ start: dollar.start, end: dollar.end, problem: "unclosed" });
  if (doubleDollar) {
    unclosed.push({ start: doubleDollar.start, end: doubleDollar.end, problem: "unclosed" });
  }

  // Environment blocks, paired by name. The whole `\begin`/`\end` token is
  // painted so it reads as the structural diagnostic, rather than making the
  // token's own (already closed) braces look like the problem.
  //
  // An `\end` closes the INNERMOST open environment of its name, and every
  // environment opened inside that one is then unclosed — the recovery that
  // reports `\begin{itemize}` in `\begin{itemize}\begin{center}\end{itemize}`
  // instead of blaming the wrong token and losing the rest of the file's
  // structure to a skewed stack. An `\end` naming nothing that is open is
  // flagged where it stands.
  const openEnvs: EnvToken[] = [];
  for (const tok of texEnvTokens(text)) {
    if (tok.kind === "begin") {
      openEnvs.push(tok);
      continue;
    }
    let match = -1;
    for (let i = openEnvs.length - 1; i >= 0; i--) {
      if (openEnvs[i].name === tok.name) {
        match = i;
        break;
      }
    }
    if (match < 0) {
      unclosed.push({ start: tok.start, end: tok.end, problem: "unmatchedEnd", env: tok.name });
      continue;
    }
    for (const inner of openEnvs.splice(match + 1)) {
      unclosed.push({ start: inner.start, end: inner.end, problem: "unclosed", env: inner.name });
    }
    openEnvs.pop();
  }
  for (const tok of openEnvs) {
    unclosed.push({ start: tok.start, end: tok.end, problem: "unclosed", env: tok.name });
  }

  return unclosed.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The math-delimiter pair (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) the caret is
 * touching, if any — for the bracket-match overlay's LaTeX extras. `null` when
 * the caret touches none, or touches an unmatched one. Pure / unit-tested.
 */
export function findTexMathDelimiterMatch(text: string, caret: number): TexDelimiterMatch | null {
  const pairs = pairTexMathTokens(texMathTokens(text));
  let best: TexDelimiterMatch | null = null;
  let bestRank = Infinity;
  for (const p of pairs) {
    for (const side of [p.open, p.close]) {
      const rank = touchRank(side, caret);
      if (rank != null && rank < bestRank) {
        bestRank = rank;
        best = p;
      }
    }
  }
  return best;
}

/** Every `\begin{name}`/`\end{name}` occurrence, whole-token ranges. The name
 *  is carried along for the document-wide diagnostic
 *  ({@link findUnclosedTexBrackets}), which pairs BY NAME; the caret-local
 *  matcher ({@link findTexEnvDelimiterMatch}) ignores it on purpose. */
const TEX_ENV_TOKEN_RE = /\\(begin|end)\s*\{([^{}]*)\}/g;

interface EnvToken {
  kind: "begin" | "end";
  /** The environment name, trimmed — `""` for a half-typed `\begin{}`. */
  name: string;
  start: number;
  end: number;
}

function texEnvTokens(text: string): EnvToken[] {
  const out: EnvToken[] = [];
  TEX_ENV_TOKEN_RE.lastIndex = 0;
  for (let m = TEX_ENV_TOKEN_RE.exec(text); m; m = TEX_ENV_TOKEN_RE.exec(text)) {
    out.push({
      kind: m[1] === "begin" ? "begin" : "end",
      name: m[2].trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * The `\begin{…}`/`\end{…}` pair straddling `caret`, if any — the "begin/end
 * structure" counterpart of bracket-match, for `\begin{itemize}…\end{itemize}`
 * blocks. Matching is by NESTING DEPTH ONLY, deliberately ignoring the
 * environment name: a well-formed LaTeX document's environments always nest
 * properly regardless of name (you cannot legally open `itemize` inside
 * `enumerate` and close them out of order), so a name-agnostic depth count
 * finds the right partner for any well-formed document — the same "plain
 * nesting count" `FileViewerPane`'s ()[]{} matcher uses, just applied to a
 * multi-character token instead of a single character. Returns `null` when
 * the caret touches neither a `\begin`/`\end`, or the one it touches has no
 * partner (unbalanced source). Pure / unit-tested.
 */
export function findTexEnvDelimiterMatch(text: string, caret: number): TexDelimiterMatch | null {
  const tokens = texEnvTokens(text);
  let idx = -1;
  let bestRank = Infinity;
  for (let i = 0; i < tokens.length; i++) {
    const rank = touchRank(tokens[i], caret);
    if (rank != null && rank < bestRank) {
      bestRank = rank;
      idx = i;
    }
  }
  if (idx < 0) return null;
  const tok = tokens[idx];
  if (tok.kind === "begin") {
    let depth = 1;
    for (let i = idx + 1; i < tokens.length; i++) {
      if (tokens[i].kind === "begin") depth++;
      else {
        depth--;
        if (depth === 0) return texDelimiterPair(tok, tokens[i]);
      }
    }
  } else {
    let depth = 1;
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i].kind === "end") depth++;
      else {
        depth--;
        if (depth === 0) return texDelimiterPair(tokens[i], tok);
      }
    }
  }
  return null;
}

/**
 * The bracket-match overlay's full LaTeX extras: math delimiters first (the
 * more common case), falling back to `\begin`/`\end`. The caller
 * (`FileViewerPane`'s `CodeEditor`) tries this only after its own plain
 * ()[]{} matcher comes up empty, and only for a `.tex` file. Pure.
 */
export function findTexDelimiterMatch(text: string, caret: number): TexDelimiterMatch | null {
  return findTexMathDelimiterMatch(text, caret) ?? findTexEnvDelimiterMatch(text, caret);
}

/** A whole `\begin{…}`/`\end{…}` token with its environment name located inside
 *  it — `{start,end}` is the token, `[nameStart,nameEnd)` the name between the
 *  braces (empty for `\begin{}`, which is what a half-typed one looks like). */
interface EnvNameToken {
  kind: "begin" | "end";
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
}

/** `\begin{env}`/`\end{env}` with the name captured — the same token shape
 *  {@link TEX_ENV_TOKEN_RE} matches, split so the name can be addressed. */
const TEX_ENV_NAME_RE = /\\(begin|end)(\s*)\{([^{}]*)\}/g;

function texEnvNameTokens(text: string): EnvNameToken[] {
  const out: EnvNameToken[] = [];
  TEX_ENV_NAME_RE.lastIndex = 0;
  for (let m = TEX_ENV_NAME_RE.exec(text); m; m = TEX_ENV_NAME_RE.exec(text)) {
    const nameStart = m.index + 1 + m[1].length + m[2].length + 1; // `\` + kw + ws + `{`
    out.push({
      kind: m[1] === "begin" ? "begin" : "end",
      start: m.index,
      end: m.index + m[0].length,
      nameStart,
      nameEnd: nameStart + m[3].length,
    });
  }
  return out;
}

// ── Hover-preview snippets (#tex-hover-preview) ──────────────────────────────
//
// What the editor's hover preview may typeset. Deliberately a *narrow* set: a
// snippet qualifies only when compiling it on its own means the same thing it
// means in the document — a formula, a matrix, a picture, a table. A `figure`
// float or a `\section` does not (its meaning is where it lands, and its body is
// usually a `\includegraphics` this preview would have to resolve), and prose is
// not a snippet at all.

/** What kind of fragment a previewable range is, for the hover card's label. */
export type TexSnippetKind = "inline" | "display" | "env";

/** A previewable fragment of the source: `[start,end)` covering the WHOLE thing
 *  including its delimiters, since that is what has to be handed to the engine —
 *  `x^2` alone is not a document, `$x^2$` is. */
export interface TexSnippetRange {
  start: number;
  end: number;
  kind: TexSnippetKind;
  /** The environment name for `kind: "env"`, else the delimiter (`$`, `\[`). */
  label: string;
}

/**
 * Environments the hover preview will typeset. Each one is self-contained: it
 * renders to the same thing beside the paper as it does inside it.
 *
 * **`figure` and `table` are here**, and the four names are exactly the ones
 * `preview.sty`'s `floats` option fixes up (`figure`, `table` and their starred
 * twins) — the backend wraps a float differently for that reason, see
 * `commands/tex.rs`'s `body_is_float`. A float's *placement* is the one thing a
 * preview genuinely cannot show, which is not much of a loss: what is worth
 * seeing before a build is whether the graphic is the right size and where the
 * caption wraps, and both are exactly what comes out.
 *
 * The floats that are NOT here were each tried against a real engine and each
 * failed: a `wrapfigure` is not a `\@float` and previews to no pages at all, and
 * a `float`-package custom float — `algorithm`, `listing`, anything from
 * `\newfloat` — redefines `\end@float` past what the option patches and dies. So
 * is anything that only means something inside the document around it (`frame`,
 * `abstract`, `thebibliography`). The starred forms are matched by stripping the
 * `*`, so `align*` and `align` are one entry.
 */
const PREVIEWABLE_TEX_ENVS = new Set([
  "align",
  "alignat",
  "array",
  "bmatrix",
  "cases",
  "displaymath",
  "eqnarray",
  "equation",
  "figure",
  "flalign",
  "gather",
  "math",
  "matrix",
  "multline",
  "pmatrix",
  "smallmatrix",
  "split",
  "table",
  "tabular",
  "tabularx",
  "tikzcd",
  "tikzpicture",
  "vmatrix",
  "Vmatrix",
  "Bmatrix",
]);

/** Is `name` (with any trailing `*`) an environment worth previewing? */
export function isPreviewableTexEnv(name: string): boolean {
  return PREVIEWABLE_TEX_ENVS.has(name.trim().replace(/\*$/, ""));
}

/**
 * Every previewable fragment in `source`, in document order, non-overlapping and
 * outermost-first.
 *
 * Two rules earn their keep. **Comments are blanked before the scan** (the same
 * `blankTexComments` the link layer uses), so a commented-out `$…$` is not a
 * hover target and a stray `%` full of dollars cannot pair with real math half a
 * page away. And **a nested fragment is dropped**: the `\begin{align}` around a
 * `$…$` is the thing to typeset, and two overlapping hit boxes would make which
 * one you get depend on which span the browser laid out last. Pure / unit-tested.
 */
export function texSnippetRanges(source: string): TexSnippetRange[] {
  const text = blankTexComments(source);
  const out: TexSnippetRange[] = [];

  for (const p of pairTexMathTokens(texMathTokens(text))) {
    const open = text.slice(p.open.start, p.open.end);
    out.push({
      start: p.open.start,
      end: p.close.end,
      kind: open === "$" ? "inline" : "display",
      label: open,
    });
  }

  const envs = texEnvNameTokens(text);
  for (let i = 0; i < envs.length; i++) {
    const tok = envs[i];
    if (tok.kind !== "begin") continue;
    const name = text.slice(tok.nameStart, tok.nameEnd);
    if (!isPreviewableTexEnv(name)) continue;
    // The partner is found by nesting depth, exactly as findTexEnvDelimiterMatch
    // does — a well-formed document nests its environments regardless of name.
    let depth = 1;
    for (let j = i + 1; j < envs.length; j++) {
      if (envs[j].kind === "begin") depth++;
      else if (--depth === 0) {
        out.push({ start: tok.start, end: envs[j].end, kind: "env", label: name });
        break;
      }
    }
  }

  // Outermost-first: sort by start, then by the LONGER range, and keep only what
  // does not sit inside something already kept.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: TexSnippetRange[] = [];
  let covered = -1;
  for (const r of out) {
    if (r.start < covered) continue;
    kept.push(r);
    covered = r.end;
  }
  return kept;
}

/** The previewable fragment containing `offset`, or null. Pure. */
export function texSnippetAt(source: string, offset: number): TexSnippetRange | null {
  for (const r of texSnippetRanges(source)) {
    if (offset >= r.start && offset < r.end) return r;
  }
  return null;
}

/**
 * The preamble of `source` — everything before `\begin{document}` — or null when
 * this file has none.
 *
 * Null is the answer that matters: a `\input`ed chapter is a real `.tex` with no
 * preamble of its own, and the preview has to go and read the build root's
 * instead (which is where the `\newcommand` the chapter's formula uses lives).
 * Returning `""` for that case would silently preview every macro-using formula
 * in a multi-file paper as an "Undefined control sequence". Pure.
 */
export function texPreamble(source: string): string | null {
  const i = source.indexOf("\\begin{document}");
  return i < 0 ? null : source.slice(0, i);
}

/**
 * The environment name's range when `caret` sits between the braces of a
 * `\begin{…}`/`\end{…}` — for the editor's "click into the braces, get the name
 * selected" gesture, so retyping an environment is one gesture rather than a
 * drag across a word the double-click rules split at `:` and `*` anyway.
 * Inclusive at both ends (clicking just after `{` or just before `}` counts);
 * `null` anywhere else, and a zero-length range for an empty `\begin{}`, which a
 * caller may treat as nothing to select. Pure / unit-tested.
 */
export function texEnvNameRangeAt(text: string, caret: number): TexDelimiterSide | null {
  for (const t of texEnvNameTokens(text)) {
    if (caret >= t.nameStart && caret <= t.nameEnd) return { start: t.nameStart, end: t.nameEnd };
  }
  return null;
}

/** A control sequence found at a position: its `[start, end)` range — the
 *  backslash included — and the token itself (`\emph`), which is the key the
 *  occurrence scan below matches on. */
export interface TexCommandToken extends TexDelimiterSide {
  name: string;
}

/** The letters a control sequence's name is made of. `@` rides along because a
 *  package/class file's internal macros (`\my@thing`) are written with it, and
 *  a name that stopped at the `@` would call `\my` an occurrence of a macro that
 *  is nowhere in the file. */
const TEX_CMD_CHAR = /[a-zA-Z@]/;

/**
 * The whole control sequence covering `pos` (`\emph` for a `pos` anywhere in
 * `\e|mph`, on the backslash, or just past the last letter) — what a
 * double-click in the editor lands on, since the word rules split `\emph` at the
 * backslash and hand back only the letters.
 *
 * `null` for anything that is not a *named* command: prose, a bare `\`, and the
 * one-character sequences (`\\`, `\%`, `\{`) whose "other occurrences" would be
 * every line break in the document. An escaped backslash never starts one, so
 * the `emph` in `\\emph` is text, not a macro. Pure / unit-tested.
 */
export function texCommandAt(text: string, pos: number): TexCommandToken | null {
  if (pos < 0 || pos > text.length) return null;
  let slash = -1;
  if (text[pos] === "\\" && !isBackslashEscaped(text, pos)) {
    slash = pos;
  } else {
    let i = pos;
    while (i > 0 && TEX_CMD_CHAR.test(text[i - 1])) i--;
    if (i > 0 && text[i - 1] === "\\" && !isBackslashEscaped(text, i - 1)) slash = i - 1;
  }
  if (slash < 0) return null;
  let end = slash + 1;
  while (end < text.length && TEX_CMD_CHAR.test(text[end])) end++;
  if (end === slash + 1) return null; // `\` alone, or `\%`/`\{`/`\\`
  if (pos > end) return null; // the caret sits past the token, not in it
  return { start: slash, end, name: text.slice(slash, end) };
}

/**
 * Every occurrence of the control sequence `name` (backslash included) in
 * `text`, in source order — the "mark the other uses of this macro" overlay
 * behind a double-click in the LaTeX editor.
 *
 * Whole-token only: `\ref` does not match inside `\reflectbox`, and an escaped
 * backslash (`\\ref` — a line break followed by the word) is not a use. A
 * trailing `*` is left out of the range, so `\section` marks the `\section` of a
 * `\section*` too — the same command, and the reader is looking for both.
 * Comments are NOT skipped: a commented-out call is exactly what someone
 * hunting a macro's uses wants to see. Pure / unit-tested.
 */
export function texCommandOccurrences(text: string, name: string): TexDelimiterSide[] {
  const out: TexDelimiterSide[] = [];
  if (!name.startsWith("\\") || name.length < 2) return out;
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + name.length)) {
    const end = i + name.length;
    if (isBackslashEscaped(text, i)) continue;
    if (end < text.length && TEX_CMD_CHAR.test(text[end])) continue;
    out.push({ start: i, end });
  }
  return out;
}

/**
 * The two environment NAMES of a `\begin{…}…\end{…}` pair, as a delimiter match,
 * when `caret` sits inside either of them — so the bracket-match overlay marks
 * the partner's name while you are in one, which is what says *which* `\end` a
 * rename is about to carry with it. The whole-token match
 * ({@link findTexEnvDelimiterMatch}) still answers a caret on the `\begin`
 * keyword itself; this is the finer reading inside the braces.
 *
 * Deliberately does NOT require the two names to agree: mid-rename they don't,
 * and that is exactly when the marker earns its place. Pairing is the same
 * name-agnostic depth count everything else here uses. A name that is currently
 * empty (`\begin{}`) yields a zero-length side — nothing to paint on that end,
 * while the partner is still marked. Pure / unit-tested.
 */
export function findTexEnvNameMatch(text: string, caret: number): TexDelimiterMatch | null {
  const tokens = texEnvNameTokens(text);
  const here = tokens.find((t) => caret >= t.nameStart && caret <= t.nameEnd);
  if (!here) return null;
  const pair = findTexEnvDelimiterMatch(text, here.start);
  if (!pair) return null;
  const partnerSide = here.kind === "begin" ? pair.close : pair.open;
  const partner = tokens.find((t) => t.start === partnerSide.start);
  if (!partner || partner.start === here.start) return null;
  const name = (t: EnvNameToken) => ({ start: t.nameStart, end: t.nameEnd });
  return here.kind === "begin"
    ? { open: name(here), close: name(partner) }
    : { open: name(partner), close: name(here) };
}

/** The single changed run between two versions of a document — the common
 *  prefix/suffix pared off, so `[start, prevEnd)` in `prev` was replaced by
 *  `[start, nextEnd)` in `next`. `null` when nothing changed. A multi-caret or
 *  find-and-replace edit collapses to one wide run here, which is exactly what
 *  the caller wants: a run wider than the environment name is not a rename. */
function texEditSpan(
  prev: string,
  next: string,
): { start: number; prevEnd: number; nextEnd: number } | null {
  if (prev === next) return null;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start += 1;
  let tail = 0;
  while (
    tail < prev.length - start &&
    tail < next.length - start &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { start, prevEnd: prev.length - tail, nextEnd: next.length - tail };
}

/** The result of mirroring an environment rename: the document with BOTH names
 *  changed, and where the caret belongs in it (mirroring into a `\begin` that
 *  sits before the caret shifts everything after it). */
export interface TexEnvRename {
  text: string;
  caret: number;
}

/**
 * Keep `\begin{env}` and `\end{env}` spelled the same while one of them is being
 * edited: given the draft before (`prev`) and after (`next`) a keystroke, plus
 * the caret in `next`, return `next` with the PARTNER's name changed the same
 * way. `null` — the ordinary case — means the edit was not an environment
 * rename and the caller should take `next` as it stands.
 *
 * Three conditions, each of which exists to stop this from rewriting text the
 * user did not aim at:
 *
 *  - the whole changed run lies inside one environment name's braces, and the
 *    caret is in there too (a paste spanning the braces, or a find-and-replace
 *    across the file, widens the run past the name and is left alone);
 *  - the token has a partner at all, by the same name-agnostic depth count
 *    {@link findTexEnvDelimiterMatch} uses — a `\begin` still waiting for its
 *    `\end` has nothing to keep in step;
 *  - the partner still spells the name the edited token spelled BEFORE the
 *    keystroke. A pair that already disagreed is not a pair somebody is
 *    renaming, and depth-matching an unbalanced document can pick the wrong
 *    partner — this is what keeps such a mistake from being written into it.
 *
 * Pure / unit-tested.
 */
export function syncTexEnvRename(prev: string, next: string, caret: number): TexEnvRename | null {
  const span = texEditSpan(prev, next);
  if (!span) return null;
  const delta = next.length - prev.length;

  const tokens = texEnvNameTokens(next);
  const edited = tokens.find(
    (t) =>
      span.start >= t.nameStart &&
      span.nextEnd <= t.nameEnd &&
      caret >= t.nameStart &&
      caret <= t.nameEnd,
  );
  if (!edited) return null;

  // The token's own text before the edit: its start is inside the untouched
  // prefix, so only its end moved — by exactly the length the document did.
  const oldName = prev.slice(edited.nameStart, edited.nameEnd - delta);
  const newName = next.slice(edited.nameStart, edited.nameEnd);
  if (oldName === newName) return null;

  const pair = findTexEnvDelimiterMatch(next, edited.start);
  if (!pair) return null;
  const partnerSide = edited.kind === "begin" ? pair.close : pair.open;
  if (partnerSide.start === edited.start) return null;
  const partner = tokens.find((t) => t.start === partnerSide.start);
  if (!partner) return null;
  if (next.slice(partner.nameStart, partner.nameEnd) !== oldName) return null;

  const text =
    next.slice(0, partner.nameStart) + newName + next.slice(partner.nameEnd);
  const shift = partner.nameStart < caret ? newName.length - oldName.length : 0;
  return { text, caret: caret + shift };
}

// --- Cross-file references (Ctrl/Cmd+Click to open) -------------------------
//
// LaTeX commands whose brace argument names another file the viewer can open in
// its own tab. The value is the extension assumed when the argument is written
// without one (LaTeX's own default for that command). `\includegraphics` has no
// default because graphics extensions are resolved against a search list we
// don't replicate, so a bare graphics argument is left unresolved.
const TEX_REF_COMMANDS: Record<string, string | null> = {
  input: ".tex",
  include: ".tex",
  subfile: ".tex",
  subfileinclude: ".tex",
  bibliography: ".bib",
  addbibresource: ".bib",
  includegraphics: null,
};

// `\cmd[opts]{arg}` for any of the file-referencing commands above. The optional
// bracket group (e.g. `\includegraphics[width=…]`) is skipped; the brace body is
// captured whole and split on commas later (e.g. `\bibliography{a,b}`).
const TEX_REF_RE = new RegExp(
  `\\\\(${Object.keys(TEX_REF_COMMANDS).join("|")})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
  "g",
);

/** A file reference recognised under the caret: the command (no backslash) and
 *  the single comma-separated path token the caret falls on. */
export interface TexRefTarget {
  command: string;
  token: string;
}

/**
 * Find the `\input`/`\include`/… reference the caret sits on, if any. A click
 * anywhere on the command (`\input{foo}`) counts as on the reference; when the
 * argument lists several comma-separated files the token under the caret wins,
 * falling back to the first.
 */
export function findTexRefAt(source: string, caret: number): TexRefTarget | null {
  // Scan with comments blanked (same length, so `caret` and every offset still
  // line up) — a commented-out `\input{…}` is not a link to follow.
  source = blankTexComments(source);
  TEX_REF_RE.lastIndex = 0;
  for (let m = TEX_REF_RE.exec(source); m; m = TEX_REF_RE.exec(source)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (caret < start || caret > end) continue;
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    const token = pickToken(m[2], caret - braceStart);
    if (!token) return null;
    return { command: m[1], token };
  }
  return null;
}

/** From a comma-separated brace body, return the trimmed token covering `offset`
 *  (relative to the body start), else the first non-empty token. */
function pickToken(body: string, offset: number): string {
  let pos = 0;
  let first = "";
  for (const part of body.split(",")) {
    const next = pos + part.length;
    const trimmed = part.trim();
    if (trimmed && !first) first = trimmed;
    if (offset >= pos && offset <= next && trimmed) return trimmed;
    pos = next + 1; // account for the comma
  }
  return first;
}

/** A character range `[start, end)` in the source covering a reference token's
 *  brace argument, used to decorate it as a clickable file link (#49). */
export interface TexRefRange {
  start: number;
  end: number;
  /** A hit-only range (see `texRefHitRanges`): clickable, never underlined. */
  hit?: boolean;
}

/**
 * Every recognised `\input{…}`/`\includegraphics{…}`/… argument range in the
 * source, so the editor can underline them as clickable links (#49). Each
 * comma-separated token inside a brace body gets its own range. Pure (no FS
 * access) — it only finds the syntactic ranges; resolution still happens on
 * click via `resolveTexRefAsync`.
 */
export function texRefRanges(source: string): TexRefRange[] {
  const ranges: TexRefRange[] = [];
  forEachTexRef(source, (_start, _end, tokens) => ranges.push(...tokens));
  return ranges;
}

/**
 * The rest of every reference `texRefRanges` underlines — the `\input` word, an
 * option bracket, the braces, the commas — as hit-only ranges, so a Ctrl/⌘+click
 * anywhere on the command follows it, not only a click on the path itself. They
 * paint nothing; every offset in them lies inside the match `findTexRefAt` reads.
 */
export function texRefHitRanges(source: string): TexRefRange[] {
  const ranges: TexRefRange[] = [];
  forEachTexRef(source, (start, end, tokens) => {
    let pos = start;
    for (const t of tokens) {
      if (t.start > pos) ranges.push({ start: pos, end: t.start, hit: true });
      pos = t.end;
    }
    if (end > pos) ranges.push({ start: pos, end, hit: true });
  });
  return ranges;
}

/** Each live reference's match span and its trimmed token ranges, in order. */
function forEachTexRef(
  source: string,
  visit: (start: number, end: number, tokens: TexRefRange[]) => void,
): void {
  // Blanking comments keeps every offset stable (so the emitted ranges still
  // index the real source) while dropping a commented-out `\input{…}` from the
  // underlined-link set.
  source = blankTexComments(source);
  TEX_REF_RE.lastIndex = 0;
  for (let m = TEX_REF_RE.exec(source); m; m = TEX_REF_RE.exec(source)) {
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    const body = m[2];
    // One range per non-empty comma-separated token (trimmed to the token).
    const tokens: TexRefRange[] = [];
    let pos = 0;
    for (const part of body.split(",")) {
      const trimmedStart = part.length - part.trimStart().length;
      const trimmed = part.trim();
      if (trimmed) {
        const start = braceStart + pos + trimmedStart;
        tokens.push({ start, end: start + trimmed.length });
      }
      pos += part.length + 1; // account for the comma
    }
    visit(m.index, m.index + m[0].length, tokens);
  }
}

/** A resolved reference: the absolute path to open and the viewer to render it
 *  with, plus a tab label. */
export interface ResolvedTexRef {
  path: string;
  viewer: InternalViewer;
  label: string;
}

/**
 * Resolve a reference token against the referencing .tex file's path: apply the
 * command's default extension when the token has none, resolve it relative to
 * that file's directory, and pick the built-in viewer for the result. Returns
 * null when no extension can be assumed (a bare `\includegraphics`) or no viewer
 * handles the file type.
 */
export function resolveTexRef(
  currentPath: string,
  target: TexRefTarget,
  disabled?: ReadonlySet<InternalViewer>,
): ResolvedTexRef | null {
  const def = TEX_REF_COMMANDS[target.command] ?? null;
  const token = target.token.trim();
  if (!token) return null;

  const base = basename(token);
  const dot = base.lastIndexOf(".");
  const hasExt = dot > 0 && dot < base.length - 1;
  const rel = hasExt ? token : def == null ? null : token + def;
  if (rel == null) return null;

  const dir = dirname(currentPath);
  return viewerRefFor(resolvePath(dir, rel), disabled);
}

/** An absolute path as something openable: the viewer that renders it plus the
 *  tab label. Null when no built-in viewer handles the type. Shared by the file
 *  references above and the `\ref`/`\cite` jump below, so a target opens the
 *  same way however it was named. */
function viewerRefFor(
  path: string,
  disabled?: ReadonlySet<InternalViewer>,
): ResolvedTexRef | null {
  const name = basename(path);
  const lastDot = name.lastIndexOf(".");
  const extension = lastDot > 0 ? name.slice(lastDot).toLowerCase() : null;
  const entry: FileEntry = {
    name,
    path,
    is_dir: false,
    size: 0,
    extension,
    mime: null,
  };
  const viewer = internalViewerFor(entry, disabled);
  if (!viewer) return null;
  return { path, viewer, label: name };
}

// Graphics extensions `\includegraphics` resolves a bare argument against, in
// the order it prefers them (PDF/vector first for engines that take them, then
// the common rasters). Used to pick a file when the argument omits the
// extension (the usual style) by listing the target directory.
const GRAPHICS_EXTS = [
  ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps",
  ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg",
];

/**
 * Resolve a reference, probing the filesystem when needed. Falls back to the
 * pure `resolveTexRef` for tokens whose path is fully determined; for a bare
 * `\includegraphics{…}` (no extension — the common case) it lists the target
 * directory and matches the stem against the graphics extensions in preference
 * order. Returns null when nothing matches or the directory can't be listed.
 */
export async function resolveTexRefAsync(
  currentPath: string,
  target: TexRefTarget,
  disabled?: ReadonlySet<InternalViewer>,
): Promise<ResolvedTexRef | null> {
  const direct = resolveTexRef(currentPath, target, disabled);
  if (direct) return direct;
  if (target.command !== "includegraphics") return null;

  const token = target.token.trim();
  if (!token) return null;
  // TeX reference tokens are written with forward slashes regardless of OS.
  const slash = token.lastIndexOf("/");
  const sub = slash >= 0 ? token.slice(0, slash) : "";
  const stem = (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
  if (!stem) return null;

  const dir = dirname(currentPath);
  const absDir = isAbsolute(token)
    ? normalizePath(sub || "/")
    : resolvePath(dir, sub);

  let entries: FileEntry[];
  try {
    entries = await invoke<FileEntry[]>("list_dir", { projectDir: absDir, relPath: "" });
  } catch {
    return null;
  }

  // Among files sharing the stem, take the one whose extension ranks earliest in
  // the graphics preference order; ignore non-graphics matches.
  let best: { entry: FileEntry; rank: number } | null = null;
  for (const e of entries) {
    if (e.is_dir) continue;
    const dot = e.name.lastIndexOf(".");
    if (dot <= 0 || e.name.slice(0, dot).toLowerCase() !== stem) continue;
    const rank = GRAPHICS_EXTS.indexOf(e.name.slice(dot).toLowerCase());
    if (rank < 0) continue;
    if (!best || rank < best.rank) best = { entry: e, rank };
  }
  if (!best) return null;
  const viewer = internalViewerFor(best.entry, disabled);
  if (!viewer) return null;
  return { path: best.entry.path, viewer, label: best.entry.name };
}

// --- Creating a reference's file when it isn't there yet (#tex-create-ref) ---
//
// `\input{chapters/intro}` written before `chapters/intro.tex` exists is the
// ordinary state of a document being written, not a mistake — so Ctrl/⌘+click on
// one offers to create the file instead of opening a tab that can only report a
// read error. The offer is deliberately narrow: only a command whose default
// extension we already assume (`\input`/`\include`/`\subfile` → `.tex`,
// `\bibliography`/`\addbibresource` → `.bib`), i.e. exactly the references whose
// file an EMPTY file is a valid first version of. A `\includegraphics` is never
// offered — there is no format to invent, and an empty file there would be a
// figure that breaks the build rather than one waiting to be written.

/** A missing reference target, as something a click can offer to create. */
export interface TexRefCreation {
  /** Absolute path of the file the reference names. */
  path: string;
  /** Its basename — the tab label once it opens. */
  label: string;
  /** Viewer the created file opens in. */
  viewer: InternalViewer;
  /** The reference as it will read on disk, relative to the referencing file's
   *  own folder (`chapters/intro.tex`) — what the prompt shows, since that is
   *  how the user wrote it. */
  rel: string;
  /** The subfolder the file needs, when the reference names one *inside* the
   *  referencing file's folder — `create_dir`'s `(projectDir, relPath)` pair.
   *  Null when the file lands beside the referencing one, or above it: a `../`
   *  token points outside the document's own folder, which is not a tree this
   *  offer may build. */
  folder: { dir: string; rel: string } | null;
}

/**
 * The file a reference names, as something creatable — or null when this is not
 * a reference whose file we can honestly make (see the note above).
 *
 * Pure: it decides *what* would be created, never whether it is missing.
 */
export function texRefCreation(
  currentPath: string,
  target: TexRefTarget,
  disabled?: ReadonlySet<InternalViewer>,
): TexRefCreation | null {
  const def = TEX_REF_COMMANDS[target.command] ?? null;
  if (def == null) return null;
  const token = target.token.trim();
  // An absolute token names a file outside the document's folder entirely; it
  // resolves and opens fine, but creating one is not this offer's business.
  if (!token || isAbsolute(token)) return null;

  const base = basename(token);
  const dot = base.lastIndexOf(".");
  const hasExt = dot > 0 && dot < base.length - 1;
  // An explicit extension has to be the one the command assumes: `\input{fig.png}`
  // is somebody's mistake, not a file to create.
  if (hasExt && base.slice(dot).toLowerCase() !== def) return null;

  const rel = hasExt ? token : token + def;
  const home = dirname(currentPath);
  const path = resolvePath(home, rel);
  const ref = viewerRefFor(path, disabled);
  if (!ref) return null;

  const slash = rel.lastIndexOf("/");
  const sub = slash > 0 ? rel.slice(0, slash) : "";
  const climbs = rel.split("/").includes("..");
  return {
    path,
    label: ref.label,
    viewer: ref.viewer,
    rel,
    folder: sub && !climbs ? { dir: home, rel: sub } : null,
  };
}

/**
 * Is this path — a file or a folder — there?
 *
 * Stat'd through `file_mtime`, the scope-confined absolute-path read the editor's
 * own reload poll already uses, which is what makes the answer true for a remote
 * (SFTP) project as well as a local one. The two obvious alternatives are not:
 * `project_path_exists` canonicalizes a *local* path and cannot see a host tree,
 * and a `list_dir` of the parent only routes over SFTP for a project's own
 * registered directory — so both would report every existing `\input` of a remote
 * document as missing.
 *
 * `false` therefore means "this stat did not answer", which is *usually* absence
 * but also covers a path outside the viewer's scope or a folder it may not read.
 * The one place that distinction could cost something is the create — see
 * {@link createTexRefFile}.
 */
export async function texPathExists(path: string, projectId: string | null): Promise<boolean> {
  try {
    await fileMtime(path, projectId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the file a reference names, empty, and say whether it made one.
 *
 * The existence check is re-taken here rather than trusted from the prompt, and
 * that is the load-bearing part: the write below **overwrites**, so the one
 * reading that could empty somebody's chapter is taken at the moment it is acted
 * on. `false` (it was there after all) sends the caller on to simply open it.
 *
 * The write goes through the absolute-path `write_file_bytes` because that is the
 * one create that routes a remote project's path over SFTP. It does not make
 * parent directories, so a reference naming a folder that isn't there yet gets
 * the folder first — that one is addressed project-style (`create_dir`) and so is
 * the single step here a remote project cannot take; it fails with the host's own
 * message rather than silently, and the folder can be made in the file tree.
 */
export async function createTexRefFile(
  creation: TexRefCreation,
  projectId: string | null,
): Promise<boolean> {
  if (await texPathExists(creation.path, projectId)) return false;
  if (creation.folder && !(await texPathExists(dirname(creation.path), projectId))) {
    await invoke("create_dir", {
      projectDir: creation.folder.dir,
      relPath: creation.folder.rel,
    });
  }
  await writeFileBytes(creation.path, new Uint8Array(), projectId);
  return true;
}

// --- Adding a child file from the structure sidebar (#tex-structure-newfile) --
//
// The sidebar's ＋ is #tex-create-ref run in the other direction: there the
// reference existed and the file was missing; here the user names the file first
// and the reference is written for them. Both halves ride the same machinery —
// `texRefCreation` decides what an `\input` token would create (and refuses the
// same absolute/wrong-extension tokens), `createTexRefFile` makes the file with
// the re-checked, never-overwriting write — so the two gestures cannot disagree
// about what a name means. What is new is only the splice: without an `\input`
// naming it, the created file would never appear in the structure the button
// lives in, which would make "new file" a button that visibly does nothing.

/**
 * Splice an `\input{token}` line into `source`: directly above `\end{document}`
 * when the document has one (new material belongs inside the document body, and
 * the end of it is the one position that is correct for any document), else
 * appended at the end (a child fragment has no `\end{document}` and reads top to
 * bottom). Pure; returns the new text and the 1-based line the reference landed
 * on. The `\end{document}` is looked up on a comment-blanked scan, so a
 * commented-out one does not attract the insert.
 */
export function insertTexInputLine(
  source: string,
  token: string,
): { text: string; line: number } {
  const ref = `\\input{${token}}`;
  const scan = blankTexComments(source);
  const m = /\\end\s*\{document\}/.exec(scan);
  if (m) {
    let at = source.lastIndexOf("\n", m.index);
    at = at < 0 ? 0 : at + 1;
    const line = source.slice(0, at).split("\n").length;
    return { text: source.slice(0, at) + ref + "\n" + source.slice(at), line };
  }
  const base = source.length === 0 || source.endsWith("\n") ? source : source + "\n";
  return { text: base + ref + "\n", line: base.split("\n").length };
}

/** What {@link addTexChildFile} did, so the caller can center the file. */
export interface TexChildAdd {
  /** Absolute path of the child file (created, or already there). */
  path: string;
  /** Viewer it opens in. */
  viewer: InternalViewer;
  /** True when the file was written (false: it already existed — adopting an
   *  existing file into the document is a valid use of the same gesture). */
  created: boolean;
  /** True when an `\input` line was spliced into the parent (false: the parent
   *  already referenced the file, however the token was spelled). */
  inserted: boolean;
}

/**
 * Create `token`'s `.tex` file under `parentPath`'s folder (when missing) and
 * add an `\input{token}` to `parentPath` (when it does not already reference the
 * file). Null when the token is not one an `\input` could honestly create — the
 * caller's validate should have said so already.
 *
 * The file is made first: it is the thing the user asked for, and a parent
 * splice that then fails leaves a created file with no reference (harmless, and
 * the retry adopts it) rather than a reference to nothing — though even that is
 * exactly what the #tex-create-ref banner exists to answer. The parent is
 * written through the same scope-aware `write_file_text` the editor saves with,
 * so a remote document routes over SFTP like everything else here. The caller
 * owns the one precondition this cannot see: a parent with unsaved edits in an
 * open editor must not be spliced on disk (the next save would write the older
 * draft over the reference).
 */
export async function addTexChildFile(
  parentPath: string,
  token: string,
  projectId: string | null = null,
  disabled?: ReadonlySet<InternalViewer>,
): Promise<TexChildAdd | null> {
  const trimmed = token.trim();
  const creation = texRefCreation(parentPath, { command: "input", token: trimmed }, disabled);
  if (!creation) return null;
  const created = await createTexRefFile(creation, projectId);
  const text = await invoke<string>("read_file_text", { path: parentPath, projectId });
  const already = texCommandTokens(blankTexComments(text), TEX_INPUT_CMDS).some(
    (tk) => resolveSibling(parentPath, tk, ".tex") === creation.path,
  );
  if (!already) {
    const { text: next } = insertTexInputLine(text, trimmed);
    await writeFileText(parentPath, next, projectId);
  }
  return { path: creation.path, viewer: creation.viewer, created, inserted: !already };
}

// --- \ref / \cite key autocomplete (#cite-ref-complete) ---------------------
//
// As the user types inside a reference-family command (`\ref{`, `\cref{`,
// `\autoref{`, `\eqref{`, …) or a cite-family command (`\cite{`, `\citep{`,
// `\parencite{`, …) the viewer offers a dropdown of candidate keys: `\label{…}`
// keys gathered from the document for refs, and entry keys from the connected
// `.bib` file(s) for cites. These helpers are pure (or invoke-only) so they can
// be unit-tested independently of the React editor.

/** Which kind of *key* a reference command takes. These two families are the
 *  ones that resolve to a definition somewhere in the document, which is why the
 *  jump (`findTexKeyRefAt`/`resolveTexKeyRef`) is typed on this narrower union
 *  rather than on {@link TexComplKind}: a `\begin{figure}` is not a key that
 *  anything defines, and Ctrl+clicking it must not start a search for one. */
export type TexKeyKind = "ref" | "cite";

/** What a completion dropdown is offering. The two key families above, plus the
 *  two structural ones (#245): an environment name inside `\begin{…}`/`\end{…}`,
 *  and a control sequence being typed after a bare `\`. */
export type TexComplKind = TexKeyKind | "env" | "cmd";

/** A reference/cite command's open brace under the caret, plus the partial key
 *  token being typed (`query`) and the `[start, end)` source range to replace on
 *  accept. */
export interface TexComplContext {
  kind: TexComplKind;
  start: number;
  end: number;
  query: string;
}

/** Reference-family commands (cleveref/varioref/hyperref/base) that take a
 *  `\label` key as their brace argument. Matched case-insensitively, so `\Cref`
 *  and `\cref` both land here. */
const REF_COMPL_CMDS = new Set([
  "ref", "cref", "autoref", "eqref", "pageref", "vref", "vpageref", "nameref",
  "labelcref", "crefrange", "cpageref", "cpagerefrange", "fref", "fullref",
  "thref", "namecref", "nameCref",
]);

/** Classify the command preceding a brace: any command containing "cite" is a
 *  citation (covers natbib/biblatex variants — citep/citet/parencite/…), the
 *  fixed `REF_COMPL_CMDS` set is a reference. Returns null otherwise. */
function classifyComplCmd(cmd: string): TexKeyKind | null {
  const lower = cmd.toLowerCase();
  if (lower.includes("cite")) return "cite";
  if (REF_COMPL_CMDS.has(lower)) return "ref";
  return null;
}

/** Commands whose brace argument is an ENVIRONMENT name rather than a key.
 *  `\newenvironment`/`\renewenvironment` are deliberately absent: their first
 *  argument is the name being *defined*, and offering the existing names there
 *  would suggest redefining `itemize` rather than naming something new. */
const ENV_COMPL_CMDS = new Set(["begin", "end"]);

/** Classify a brace argument's command for completion: the key families, or an
 *  environment name. Kept separate from {@link classifyComplCmd} so widening it
 *  never widens what Ctrl+click treats as a resolvable key. */
function classifyComplBrace(cmd: string): TexComplKind | null {
  const key = classifyComplCmd(cmd);
  if (key) return key;
  return ENV_COMPL_CMDS.has(cmd.toLowerCase()) ? "env" : null;
}

/** True when `caret` sits after an unescaped `%` on its own line — inside a TeX
 *  comment. Completion stays shut there: a `\se` written in a note about the
 *  document is prose, not a control sequence being typed. Scans only the current
 *  line, so this is O(line) rather than O(document). */
function caretInTexComment(source: string, caret: number): boolean {
  let lineStart = source.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  if (lineStart < 0) lineStart = 0;
  for (let i = lineStart; i < caret; i++) {
    if (source[i] === "%" && !isBackslashEscaped(source, i)) return true;
  }
  return false;
}

/** A control sequence being typed at the caret (`\se|`), as a completion
 *  context. `start` is the backslash, `query` the letters after it, so accepting
 *  replaces the whole `\name`. Requires at least one letter — a bare `\` is the
 *  first keystroke of `\\`, `\[`, `\%` and everything else that is not a word,
 *  and popping a list of every command over it would fight the typist. Returns
 *  null when the run is not a command (no backslash, an escaped one, a digit
 *  in the middle). Pure. */
function findTexCommandAt(source: string, caret: number): TexComplContext | null {
  let i = caret;
  while (i > 0 && /[a-zA-Z]/.test(source[i - 1])) i--;
  if (i === caret) return null; // no letters typed yet
  const slash = i - 1;
  if (slash < 0 || source[slash] !== "\\") return null;
  if (isBackslashEscaped(source, slash)) return null; // `\\se` — the `\\` is a break
  return { kind: "cmd", start: slash, end: caret, query: source.slice(i, caret) };
}

/**
 * Detect whether `caret` sits inside the (possibly still-unclosed) brace
 * argument of a reference- or cite-family command, for live autocomplete. Scans
 * a short window back from the caret for the enclosing `{` — bailing on a `}` or
 * a blank line first — then checks the text just before it for `\cmd` (allowing
 * a `*` and any number of `[optional]` groups, e.g. `\citep[see][p.5]{`). The
 * `query` is the comma-separated token under the caret, trimmed; `start`/`end`
 * cover that token so accepting replaces just it (keeping earlier keys in a
 * multi-key `\cite{a,b}`). Returns null when not in such a context.
 */
export function findTexComplAt(source: string, caret: number): TexComplContext | null {
  if (caret < 0 || caret > source.length) return null;
  // A comment is prose: neither a command nor a key is being typed in one.
  if (caretInTexComment(source, caret)) return null;
  // A control sequence being typed (#245) is checked FIRST: it is the only
  // context whose caret sits outside any brace, so it can never be confused with
  // the argument scan below, and checking it first keeps that scan's 600-char
  // look-back off the common keystroke.
  const cmd = findTexCommandAt(source, caret);
  if (cmd) return cmd;
  let braceStart = -1;
  const limit = Math.max(0, caret - 600);
  for (let i = caret - 1; i >= limit; i--) {
    const c = source[i];
    if (c === "}") return null;
    if (c === "{") { braceStart = i; break; }
    if (c === "\n" && source[i - 1] === "\n") return null;
  }
  if (braceStart < 0) return null;
  const tail = source.slice(Math.max(0, braceStart - 80), braceStart);
  const m = /\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]\s*)*$/.exec(tail);
  if (!m) return null;
  const kind = classifyComplBrace(m[1]);
  if (!kind) return null;
  const bodyStart = braceStart + 1;
  const segment = source.slice(bodyStart, caret);
  if (/[{}]/.test(segment)) return null; // brace appeared since the open → not in the arg
  const comma = segment.lastIndexOf(",");
  const rawStart = comma >= 0 ? comma + 1 : 0;
  const raw = segment.slice(rawStart);
  const lead = raw.length - raw.trimStart().length;
  return {
    kind,
    start: bodyStart + rawStart + lead,
    end: caret,
    query: raw.trim(),
  };
}

/** A `\label{…}` key plus the title of the sectioning command it falls under,
 *  when one precedes it in the same file — the `\ref`/`\cref` dropdown's "which
 *  section is this in" detail. */
export interface TexLabelEntry {
  key: string;
  section?: string;
}

/** Sectioning commands (article/report/book classes) whose title is read for
 *  a label's `section`. Matched with an optional trailing `*` (unnumbered
 *  variants) and an optional `[short title]`, which is skipped in favour of
 *  the full `{…}` title. */
const SECTIONING_CMDS = ["part", "chapter", "section", "subsection", "subsubsection"];

/**
 * Index of the brace matching the one at `open` (a backslash-escaped `{`/`}`
 * does not count), or `text.length` when unterminated.
 */
function matchTexBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Compact, human-readable form of a section title: inline-formatting
 *  commands (`\textbf{…}`, `\emph{…}`, accents, …) and braces dropped,
 *  whitespace collapsed. Best-effort, like {@link bibPlainValue} — a display
 *  string, never round-tripped. */
function texPlainTitle(value: string): string {
  return value
    .replace(/\\[a-zA-Z]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every sectioning command's position and title, in document order —
 *  `parseTexLabelEntries`'s lookup table for "which section is this label
 *  in". A title is brace-matched, so `\section{Results for \texttt{foo}}`
 *  reads its whole title rather than stopping at the nested brace. */
export function parseTexSections(source: string): Array<{ pos: number; title: string }> {
  const out: Array<{ pos: number; title: string }> = [];
  const re = new RegExp(`\\\\(?:${SECTIONING_CMDS.join("|")})\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const open = m.index + m[0].length - 1;
    const close = matchTexBrace(source, open);
    const title = texPlainTitle(source.slice(open + 1, close));
    if (title) out.push({ pos: m.index, title });
  }
  return out;
}

/** Every `\label{…}` key in a TeX source, each with the title of the nearest
 *  preceding sectioning command (if any), in document order (duplicates
 *  kept; the caller dedupes when merging across files). */
export function parseTexLabels(source: string): TexLabelEntry[] {
  const sections = parseTexSections(source);
  let secIdx = 0;
  const out: TexLabelEntry[] = [];
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const k = m[1].trim();
    if (!k) continue;
    while (secIdx + 1 < sections.length && sections[secIdx + 1].pos < m.index) secIdx++;
    const section =
      sections.length && sections[secIdx].pos < m.index ? sections[secIdx].title : undefined;
    out.push({ key: k, section });
  }
  return out;
}

/** A parsed `.bib` entry: the citation key plus a few display fields. */
export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
}

/**
 * The `.bib` entries of a bibliography, for the `\cite` dropdown: the citation
 * key plus the three fields it displays.
 *
 * A thin adapter over `lib/viewers/tex/bib`'s parser rather than a second reading of
 * the format — the bibliography card view and this dropdown must not be able to
 * disagree about what is in a `.bib` (which entries exist, what a field's value
 * is), and the parser that has to survive being *edited* through is the stricter
 * of the two. `@string`/`@preamble`/`@comment` carry no citation key, so they
 * drop out here.
 */
export function parseBibEntries(bib: string): BibEntry[] {
  return parseBib(bib)
    .records.filter((r) => r.kind === "entry" && r.key)
    .map((r) => {
      const field = (name: string): string | undefined => {
        const hit = r.fields.find((f) => f.key === name);
        const value = hit ? bibPlainValue(hit.value) : "";
        return value || undefined;
      };
      return {
        key: r.key,
        type: r.type,
        title: field("title"),
        author: field("author"),
        year: field("year"),
      };
    });
}

/** Brace tokens (comma-split, trimmed) of the given commands in `source`. Used
 *  to follow `\input`/`\include` and locate `\bibliography`/`\addbibresource`. */
function texCommandTokens(source: string, commands: string[]): string[] {
  const re = new RegExp(
    `\\\\(?:${commands.join("|")})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
    "g",
  );
  const out: string[] = [];
  for (let m = re.exec(source); m; m = re.exec(source)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Resolve a `\input`/`\bibliography` token to an absolute path against the
 *  referencing file's dir, appending `defExt` when it has none. */
function resolveSibling(fromFile: string, token: string, defExt: string): string {
  const base = basename(token);
  const hasExt = base.includes(".");
  const rel = hasExt ? token : token + defExt;
  const dir = dirname(fromFile) || "/";
  return resolvePath(dir, rel);
}

const TEX_INPUT_CMDS = ["input", "include", "subfile", "subfileinclude"];
const TEX_BIB_CMDS = ["bibliography", "addbibresource"];

// --- Command and environment completion (#245) -------------------------------
//
// The dropdown answered two of the four questions a LaTeX editor is asked while
// typing — which label, which citation key — and neither of the two asked far
// more often: what is this command called, and what is this environment called.
// Those are the ones every other LaTeX editor answers, and their absence is felt
// hardest by the people the rest of this viewer is for: `\includegraphics` has
// eight more letters than anyone types correctly first time, and an
// `\begin{align}` written without its `\end{align}` is a compile error whose log
// line names the end of the file.
//
// The tables below are deliberately a CURATED standard set rather than a parse of
// the installed distribution: reading `texmf` would offer thousands of commands
// from packages the document never loads, and the value of a completion list is
// entirely in what it leaves out. What the document itself defines is added on
// top, from its own text, so a `\newcommand{\R}` is offered beside `\ref`.

/** One command the dropdown can offer. `args` is how many mandatory `{}`
 *  arguments to seed on accept — 0 leaves the caret after the name. */
export interface TexCommandEntry {
  /** The name WITHOUT its backslash (`section`, not `\section`). */
  name: string;
  /** Mandatory brace arguments seeded on accept. */
  args: number;
  /** True when it came from the document's own definitions rather than the
   *  standard table — the dropdown says so, since a local macro is the one
   *  candidate whose meaning is not general knowledge. */
  local?: boolean;
}

/** One environment the dropdown can offer. */
export interface TexEnvEntry {
  name: string;
  /** Extra argument text seeded after `\begin{name}` — `tabular` and friends do
   *  not compile without one, so the caret lands inside it. */
  seed?: string;
  /** First body line, for an environment whose body is a list of items. */
  item?: string;
  /** Defined by, or already used in, this document rather than standard. */
  local?: boolean;
}

/** Build a plain `{name, args}` table from a compact `name:args` spelling, so the
 *  list below reads as a list of commands rather than of object literals. */
function texCmdTable(spec: string): TexCommandEntry[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const [name, args] = tok.split(":");
      return { name, args: args ? Number(args) : 0 };
    });
}

/**
 * The standard LaTeX commands offered when a `\` is being typed. Chosen for what
 * a document actually contains — structure, text, references, floats, math and
 * the definition forms — not for coverage: a list nobody can scan is a list
 * nobody reads. The `:n` suffix is the number of mandatory brace arguments.
 */
export const TEX_STANDARD_COMMANDS: TexCommandEntry[] = texCmdTable(`
  documentclass:1 usepackage:1 begin:1 end:1 title:1 author:1 date:1 maketitle
  tableofcontents listoffigures listoftables appendix newpage clearpage
  part:1 chapter:1 section:1 subsection:1 subsubsection:1 paragraph:1 subparagraph:1
  textbf:1 textit:1 texttt:1 textsc:1 textsf:1 textrm:1 textnormal:1 emph:1
  underline:1 textsuperscript:1 textsubscript:1 footnote:1 marginpar:1
  url:1 href:2 texorpdfstring:2 verb
  label:1 ref:1 cref:1 Cref:1 autoref:1 eqref:1 pageref:1 nameref:1
  cite:1 citep:1 citet:1 citeauthor:1 citeyear:1 parencite:1 textcite:1
  bibliography:1 bibliographystyle:1 addbibresource:1 printbibliography
  input:1 include:1 includeonly:1 subfile:1 includegraphics:1 graphicspath:1
  caption:1 captionof:2 item subitem centering raggedright raggedleft
  hline cline:1 toprule midrule bottomrule multicolumn:3 multirow:3
  newcommand:2 renewcommand:2 providecommand:2 newenvironment:3 renewenvironment:3
  DeclareMathOperator:2 newtheorem:2 setlength:2 addtolength:2 newcounter:1
  setcounter:2 definecolor:3 textcolor:2 colorbox:2
  noindent indent linebreak newline pagebreak smallskip medskip bigskip
  hspace:1 vspace:1 hfill vfill rule:2
  tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge
  frac:2 dfrac:2 tfrac:2 binom:2 sqrt:1 sum prod int iint oint lim
  log ln exp sin cos tan arcsin arccos arctan sinh cosh tanh
  min max inf sup det dim ker deg gcd arg bmod pmod:1
  mathbb:1 mathcal:1 mathbf:1 mathrm:1 mathit:1 mathsf:1 mathtt:1 mathfrak:1
  boldsymbol:1 operatorname:1 text:1 overline:1 hat:1 bar:1 tilde:1 vec:1
  dot:1 ddot:1 widehat:1 widetilde:1 substack:1 left right
  quad qquad cdot cdots ldots dots vdots ddots
  times div pm mp leq geq neq approx equiv sim simeq cong propto
  in notin subset subseteq supset supseteq cup cap setminus emptyset
  forall exists nexists neg land lor implies iff to mapsto
  rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow
  infty partial nabla ell aleph Re Im
  alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa
  lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega
  Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
`);

/**
 * The beamer commands, offered ONLY in a document that is a deck. They are a
 * table of their own rather than lines in the standard one for the reason that
 * table is curated at all: `\frametitle` and `\setbeamercolor` are noise in an
 * article, and a list nobody can scan is a list nobody reads. What makes a file
 * a deck is `isBeamerDocument` over the whole document — a `\input`-ed fragment
 * of a deck is a deck too, which is why the flag rides the source walk rather
 * than the file on screen.
 */
export const TEX_BEAMER_COMMANDS: TexCommandEntry[] = texCmdTable(`
  frametitle:1 framesubtitle:1 titlepage subtitle:1 institute:1 titlegraphic:1 logo:1
  usetheme:1 usecolortheme:1 usefonttheme:1 useinnertheme:1 useoutertheme:1
  setbeamertemplate:2 setbeamercolor:2 setbeamerfont:2 setbeamersize:1 setbeamercovered:1
  pause onslide only:1 uncover:1 visible:1 invisible:1 alt:2 temporal:3
  alert:1 structure:1 note:1 againframe:1 hyperlink:2 hypertarget:2
  AtBeginSection:1 AtBeginSubsection:1 AtBeginPart:1
  insertframenumber inserttotalframenumber insertsection insertsubsection
  inserttitle insertauthor insertdate insertshorttitle
`);

/** The standard environments offered inside `\begin{…}`/`\end{…}`. `seed` is the
 *  argument an environment cannot compile without; `item` the first body line for
 *  a list. */
export const TEX_STANDARD_ENVIRONMENTS: TexEnvEntry[] = [
  { name: "document" },
  { name: "abstract" },
  { name: "itemize", item: "\\item " },
  { name: "enumerate", item: "\\item " },
  { name: "description", item: "\\item[] " },
  { name: "figure", seed: "[htbp]" },
  { name: "figure*", seed: "[htbp]" },
  { name: "table", seed: "[htbp]" },
  { name: "table*", seed: "[htbp]" },
  { name: "tabular", seed: "{}" },
  { name: "tabularx", seed: "{\\textwidth}{}" },
  { name: "array", seed: "{}" },
  { name: "center" },
  { name: "flushleft" },
  { name: "flushright" },
  { name: "quote" },
  { name: "quotation" },
  { name: "verbatim" },
  { name: "lstlisting" },
  { name: "minipage", seed: "{0.5\\textwidth}" },
  { name: "equation" },
  { name: "equation*" },
  { name: "align" },
  { name: "align*" },
  { name: "gather" },
  { name: "gather*" },
  { name: "multline" },
  { name: "split" },
  { name: "cases" },
  { name: "matrix" },
  { name: "pmatrix" },
  { name: "bmatrix" },
  { name: "vmatrix" },
  { name: "theorem" },
  { name: "lemma" },
  { name: "proposition" },
  { name: "corollary" },
  { name: "definition" },
  { name: "remark" },
  { name: "example" },
  { name: "proof" },
  { name: "thebibliography", seed: "{9}" },
  { name: "frame" },
  { name: "columns" },
  { name: "column", seed: "{0.5\\textwidth}" },
  { name: "block", seed: "{}" },
  { name: "alertblock", seed: "{}" },
  { name: "exampleblock", seed: "{}" },
  { name: "tikzpicture" },
  { name: "algorithm" },
  { name: "algorithmic" },
];

/** The definition forms whose first argument names a new command. `\def` is
 *  included even though its syntax is plain TeX's — a document that uses it uses
 *  it a lot, and the name is what the dropdown needs, not the parameter text. */
const TEX_NEWCMD_RE =
  /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\s*\\([a-zA-Z@]+)\s*\}?(?:\s*\[(\d+)\])?|\\DeclareMathOperator\*?\s*\{?\s*\\([a-zA-Z@]+)|\\def\s*\\([a-zA-Z@]+)/g;

/**
 * Every command `source` defines: `\newcommand`/`\renewcommand`/
 * `\providecommand` (whose `[n]` says how many arguments it takes),
 * `\DeclareMathOperator` and plain `\def`. Comments are blanked first, so a
 * commented-out definition is not offered — the same rule every other reader in
 * this module follows. Pure.
 */
export function parseTexDefinedCommands(source: string): TexCommandEntry[] {
  const out: TexCommandEntry[] = [];
  const seen = new Set<string>();
  const scan = blankTexComments(source);
  TEX_NEWCMD_RE.lastIndex = 0;
  for (let m = TEX_NEWCMD_RE.exec(scan); m; m = TEX_NEWCMD_RE.exec(scan)) {
    const name = m[1] ?? m[3] ?? m[4];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, args: m[2] ? Number(m[2]) : 0, local: true });
  }
  return out;
}

/** `\newenvironment{name}` / `\newtheorem{name}` — the two ways a document adds
 *  an environment of its own. */
const TEX_NEWENV_RE = /\\(?:re)?newenvironment\*?\s*\{([^{}]+)\}|\\newtheorem\*?\s*\{([^{}]+)\}/g;
/** Every `\begin{name}` in a file, for the "already used here" candidates. */
const TEX_BEGIN_RE = /\\begin\s*\{([^{}]+)\}/g;

/**
 * Every environment `source` defines (`\newenvironment`, `\newtheorem`) or
 * already uses (`\begin{…}`). Using one is evidence enough to offer it: a
 * document that opens a `wrapfigure` once will open a second, and the standard
 * table cannot know which packages it loaded. Comments blanked. Pure.
 */
export function parseTexDocumentEnvironments(source: string): TexEnvEntry[] {
  const out: TexEnvEntry[] = [];
  const seen = new Set<string>();
  const scan = blankTexComments(source);
  const add = (raw: string | undefined) => {
    const name = raw?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, local: true });
  };
  TEX_NEWENV_RE.lastIndex = 0;
  for (let m = TEX_NEWENV_RE.exec(scan); m; m = TEX_NEWENV_RE.exec(scan)) add(m[1] ?? m[2]);
  TEX_BEGIN_RE.lastIndex = 0;
  for (let m = TEX_BEGIN_RE.exec(scan); m; m = TEX_BEGIN_RE.exec(scan)) add(m[1]);
  return out;
}

/** The document with a completion applied, and where the caret goes afterwards.
 *  Returned rather than applied so the whole decision stays pure and testable —
 *  the editor only splices the text in and moves the cursor. */
export interface TexComplEdit {
  text: string;
  caret: number;
}

/** Which of `\begin`/`\end` an environment-completion context belongs to. Read
 *  back off the source rather than carried on the context, so it cannot disagree
 *  with the text the insert is about to splice. */
export function texEnvComplCommand(source: string, ctx: TexComplContext): "begin" | "end" | null {
  const open = source.lastIndexOf("{", Math.max(0, ctx.start - 1));
  if (open < 0) return null;
  const m = /\\(begin|end)\*?\s*$/.exec(source.slice(Math.max(0, open - 40), open));
  return m ? (m[1] as "begin" | "end") : null;
}

/** The leading whitespace of the line containing `pos`. */
function lineIndentAt(source: string, pos: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const m = /^[ \t]*/.exec(source.slice(start, pos));
  return m ? m[0] : "";
}

/** Does an unmatched `\end{name}` already follow `after`? Nested `\begin{name}`s
 *  are counted, so completing the outer `\begin{align}` of a nested pair still
 *  sees the outer `\end`. This is what stops an accept from inserting a second
 *  `\end` into a block the user is merely re-typing the name of — and, exported,
 *  what stops the editor's Enter from doing the same when the `\begin` was typed
 *  out by hand rather than completed. */
export function hasMatchingTexEnd(after: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, "g");
  let depth = 0;
  for (let m = re.exec(after); m; m = re.exec(after)) {
    if (m[1] === "begin") depth++;
    else if (depth === 0) return true;
    else depth--;
  }
  return false;
}

/**
 * Accept a command completion: replace the `\query` under the caret with
 * `\name`, and seed its mandatory `{}` arguments with the caret inside the first
 * one. Braces are NOT added when the text already continues with one — the user
 * is correcting the name of a command they have already written out. Pure.
 */
export function insertTexCommand(
  source: string,
  ctx: TexComplContext,
  entry: TexCommandEntry,
): TexComplEdit {
  const head = `${source.slice(0, ctx.start)}\\${entry.name}`;
  const rest = source.slice(ctx.end);
  if (entry.args < 1 || /^\s*[{[]/.test(rest)) {
    return { text: head + rest, caret: head.length };
  }
  const braces = "{}".repeat(entry.args);
  return { text: head + braces + rest, caret: head.length + 1 };
}

/**
 * Accept an environment completion. In an `\end{…}` it just writes the name and
 * steps past the brace — writing that brace itself when the name was still
 * being typed and it is not there yet. In a `\begin{…}` on a line with nothing
 * after it, and with no unmatched `\end{name}` already ahead, it also opens the
 * block — `\end{name}` on its own line at the `\begin`'s indent, a body line
 * between them (carrying `\item ` for a list), and the caret waiting in the body
 * or, where the environment takes one, inside its seeded argument.
 *
 * Anything less certain than that degrades to writing the name alone: leftover
 * text inside the braces (which, with no `}` on the line, is anything at all
 * still following the caret), or a line that continues after them. Restructuring
 * a line the user is in the middle of is the one thing an autocomplete must not
 * do. Pure.
 */
export function insertTexEnvironment(
  source: string,
  ctx: TexComplContext,
  entry: TexEnvEntry,
): TexComplEdit {
  const name = entry.name;
  const head = source.slice(0, ctx.start) + name;
  const rest = source.slice(ctx.end);
  const nl = rest.indexOf("\n");
  const lineRest = nl < 0 ? rest : rest.slice(0, nl);
  const afterLine = nl < 0 ? "" : rest.slice(nl);
  const closeRel = lineRest.indexOf("}");
  // With no `}` on the line the whole line-rest counts as being inside the
  // braces — an unclosed `{` at the end of a line is simply a name being typed
  // left to right, and the accept writes the missing `}` itself. Leaving
  // `\begin{align` behind is the one outcome that cannot compile.
  const inner = closeRel < 0 ? lineRest : lineRest.slice(0, closeRel);
  // Something else still inside the braces → name only.
  if (/\S/.test(inner)) return { text: head + rest, caret: head.length };

  const tail = closeRel < 0 ? "" : lineRest.slice(closeRel + 1);
  const closed = `${head}}`;
  const which = texEnvComplCommand(source, ctx);
  if (which !== "begin" || /\S/.test(tail) || hasMatchingTexEnd(rest, name)) {
    return { text: closed + tail + afterLine, caret: closed.length };
  }

  const indent = lineIndentAt(source, ctx.start);
  const seed = entry.seed ?? "";
  const body = `${indent}  ${entry.item ?? ""}`;
  const text = `${closed}${seed}\n${body}\n${indent}\\end{${name}}${afterLine}`;
  // A seeded argument is the one thing that must be filled in before the block
  // compiles, so the caret goes inside it rather than into the body.
  const braceInSeed = seed.lastIndexOf("{");
  const caret =
    braceInSeed >= 0
      ? closed.length + braceInSeed + 1
      : closed.length + seed.length + 1 + body.length;
  return { text, caret };
}

/** Candidate keys for the ref/cite dropdown: `\label` keys across the document
 *  and bib entries from the connected `.bib` file(s) — plus (#245) the commands
 *  and environments offered while one is being typed. */
export interface TexCompletions {
  labels: TexLabelEntry[];
  cites: BibEntry[];
  /** The standard command table plus the document's own `\newcommand` family. */
  commands: TexCommandEntry[];
  /** The standard environment table plus the ones this document defines or uses. */
  envs: TexEnvEntry[];
  /** Does any file of the document load `\documentclass{beamer}`? Rides the same
   *  walk because the class line is regularly in a file the editor is not in —
   *  a child fragment of a deck is still a deck. Absent means unknown/not. */
  beamer?: boolean;
}

/**
 * **The** walk of a document's `.tex` files, and the one place that walk is
 * defined: resolve the build root, follow `\input`/`\include`/`\subfile` from
 * there, hand each file's text to `visit`, and collect every `.bib` the document
 * names on the way. Bounded at 60 files and best-effort throughout — a missing or
 * unreadable file is skipped rather than thrown over, because this runs behind a
 * click that has to answer either way.
 *
 * Two callers share it and must not drift apart: the ref/cite **completion** list
 * (what keys exist) and the ref/cite **jump** (where one is defined). A dropdown
 * offering a key the click cannot then reach is the failure a second copy of this
 * walk would eventually produce.
 *
 * `visit` returning true ends the walk — a definition search is done the moment it
 * has found the definition, whereas gathering candidates reads everything.
 */
async function walkTexSources(
  currentPath: string,
  projectId: string | null,
  visit: (file: string, text: string) => boolean | void,
  options: { currentFirst?: boolean; currentText?: string } = {},
): Promise<Set<string>> {
  const root = await resolveTexRoot(currentPath);
  const seenTex = new Set<string>();
  const queue = options.currentFirst ? [currentPath, root] : [root, currentPath];
  const bibPaths = new Set<string>();

  while (queue.length && seenTex.size < 60) {
    const file = queue.shift()!;
    if (seenTex.has(file)) continue;
    seenTex.add(file);
    let text: string;
    // The file being edited is read from the caller's DRAFT when it offers one:
    // a `\label` typed a minute ago is not on disk yet, and a jump that cannot
    // find the label you are looking at reads as a broken feature.
    if (options.currentText != null && file === currentPath) {
      text = options.currentText;
    } else {
      try {
        text = await invoke<string>("read_file_text", { path: file, projectId });
      } catch {
        continue;
      }
    }
    for (const t of texCommandTokens(text, TEX_INPUT_CMDS)) {
      queue.push(resolveSibling(file, t, ".tex"));
    }
    for (const t of texCommandTokens(text, TEX_BIB_CMDS)) {
      bibPaths.add(resolveSibling(file, t, ".bib"));
    }
    if (visit(file, text) === true) break;
  }
  return bibPaths;
}

/**
 * Gather completion candidates for `currentPath`'s document: every reachable
 * `.tex` file's `\label` keys, plus the entry keys of every `.bib` the document
 * references. The walk and its bounds are {@link walkTexSources}'; pure parsing is
 * the tested helpers'.
 */
export async function gatherTexCompletions(
  currentPath: string,
  projectId: string | null = null,
  options: { currentText?: string } = {},
): Promise<TexCompletions> {
  const labels: TexLabelEntry[] = [];
  const seenLabel = new Set<string>();
  // #245: the document's own macros and environments ride the SAME walk as its
  // labels — a second walk would be a second answer to "what is this document",
  // and the preamble that defines the macros is regularly a file the editor is
  // not currently in.
  const commands: TexCommandEntry[] = [];
  const seenCmd = new Set(TEX_STANDARD_COMMANDS.map((c) => c.name));
  const envs: TexEnvEntry[] = [];
  const seenEnv = new Set(TEX_STANDARD_ENVIRONMENTS.map((e) => e.name));
  let beamer = false;
  const bibPaths = await walkTexSources(
    currentPath,
    projectId,
    (_file, text) => {
      if (!beamer && isBeamerDocument(text)) beamer = true;
      for (const l of parseTexLabels(text)) {
        if (seenLabel.has(l.key)) continue;
        seenLabel.add(l.key);
        labels.push(l);
      }
      for (const c of parseTexDefinedCommands(text)) {
        if (seenCmd.has(c.name)) continue;
        seenCmd.add(c.name);
        commands.push(c);
      }
      for (const e of parseTexDocumentEnvironments(text)) {
        if (seenEnv.has(e.name)) continue;
        seenEnv.add(e.name);
        envs.push(e);
      }
    },
    { currentText: options.currentText },
  );

  const cites: BibEntry[] = [];
  const seenKey = new Set<string>();
  for (const bib of bibPaths) {
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: bib, projectId });
    } catch {
      continue;
    }
    for (const e of parseBibEntries(text)) {
      if (seenKey.has(e.key)) continue;
      seenKey.add(e.key);
      cites.push(e);
    }
  }

  // The document's own definitions come FIRST in each list: a `\newcommand` is
  // the one candidate a reader cannot look up, and it is the one they meant.
  return {
    labels,
    cites,
    commands: [...commands, ...TEX_STANDARD_COMMANDS],
    envs: [...envs, ...TEX_STANDARD_ENVIRONMENTS],
    beamer,
  };
}

/** `gathered`'s entries, with what `key` names deduplicated and `first` put in
 *  front of them. */
function mergeFirst<T>(first: T[], rest: T[], key: (t: T) => string): T[] {
  if (first.length === 0) return rest;
  const seen = new Set<string>();
  return [...first, ...rest].filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The candidates of ONE completion family for the document as it is in the
 * editor: the file's current `draft` is parsed for what it defines and that is
 * merged in front of the `gathered` (on-disk) set — a `\label`, `\newcommand` or
 * `\begin{wrapfigure}` typed a minute ago is offered without waiting for a
 * re-gather, and the document's own definition outranks a standard one.
 *
 * One family at a time, on purpose: this is called from the editor only once a
 * dropdown context exists, for the family that context needs, and cached by the
 * caller for as long as the same token is being typed. The three whole-document
 * parses it replaced ran on every keystroke of every TeX file, dropdown or not.
 * Pure.
 */
export function texCompletionsFor(gathered: TexCompletions, draft: string, kind: "ref"): TexLabelEntry[];
export function texCompletionsFor(gathered: TexCompletions, draft: string, kind: "cite"): BibEntry[];
export function texCompletionsFor(gathered: TexCompletions, draft: string, kind: "cmd"): TexCommandEntry[];
export function texCompletionsFor(gathered: TexCompletions, draft: string, kind: "env"): TexEnvEntry[];
export function texCompletionsFor(
  gathered: TexCompletions,
  draft: string,
  kind: TexComplKind,
): TexLabelEntry[] | BibEntry[] | TexCommandEntry[] | TexEnvEntry[];
export function texCompletionsFor(
  gathered: TexCompletions,
  draft: string,
  kind: TexComplKind,
): TexLabelEntry[] | BibEntry[] | TexCommandEntry[] | TexEnvEntry[] {
  switch (kind) {
    case "ref":
      return mergeFirst(parseTexLabels(draft), gathered.labels, (l) => l.key);
    case "cite":
      // A `.bib` is never the file being edited here, so there is nothing live.
      return gathered.cites;
    case "cmd": {
      // The beamer table joins the standard one only for a deck (#245): the
      // gathered flag knows the whole document, and `draft` catches the
      // `\documentclass{beamer}` typed a minute ago in the file on screen.
      const base =
        gathered.beamer === true || isBeamerDocument(draft)
          ? mergeFirst(gathered.commands, TEX_BEAMER_COMMANDS, (c) => c.name)
          : gathered.commands;
      return mergeFirst(parseTexDefinedCommands(draft), base, (c) => c.name);
    }
    case "env":
      return mergeFirst(parseTexDocumentEnvironments(draft), gathered.envs, (e) => e.name);
  }
}

// --- \ref / \cite jump-to-definition (#tex-ref-jump) ------------------------
//
// The other half of the cross-reference. `\input{…}` has been Ctrl-clickable
// since #49 and `\ref{`/`\cite{` have offered a key dropdown since
// #cite-ref-complete, which between them left the one question a reader actually
// asks — "what IS equation (3), what IS [12]?" — as the only one the editor could
// not answer: the key was typed here and defined somewhere in a 40-file document.
//
// A key reference is not a file reference and resolves nothing like one: the
// target is a POSITION, found by searching the document's own sources for the
// `\label{…}` (or the `.bib` record) that defines the key, and reached through the
// existing editor-jump channel rather than by opening anything new when the
// definition is in the file already on screen.

/** A `\ref`/`\cite`-family key under the caret: which family, and the single
 *  comma-separated key the caret falls on (`\cite{a,b}` picks one). */
export interface TexKeyRef {
  kind: TexKeyKind;
  key: string;
}

/** Any `\command[opt]{body}` whose body holds no braces — the shape every
 *  reference and citation command takes. The command is classified afterwards
 *  (`classifyComplCmd`), so this stays one regex rather than one per family, and
 *  `\textbf{\ref{x}}` matches the inner command because the outer body has
 *  braces in it. */
const TEX_KEYREF_RE = new RegExp(
  // The command name is narrowed IN the pattern to the two families
  // `classifyComplCmd` accepts — anything containing `cite`, or the fixed
  // reference set — so the scan rejects `\textbf{…}` at its first letter instead
  // of capturing every braced argument in the document and classifying it
  // afterwards. `classifyComplCmd` is still applied to each match, so the two
  // cannot disagree about what a key command is; the lookahead keeps `\refx{…}`
  // from matching as `\ref`. Case-insensitive like the classifier (`\Cref`).
  `\\\\([a-zA-Z]*cite[a-zA-Z]*|(?:${[...REF_COMPL_CMDS].join("|")})(?![a-zA-Z]))\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{([^{}]*)\\}`,
  "gi",
);

/**
 * The `\ref`/`\cite` key the caret sits on, if any. A click anywhere on the
 * command counts as on the reference, exactly as it does for `\input` — the
 * command word is part of the link, not a lead-in to it. Comments are blanked
 * first (same length, so offsets still line up): a commented-out `\ref` is not
 * something to follow. Pure.
 */
export function findTexKeyRefAt(source: string, caret: number): TexKeyRef | null {
  source = blankTexComments(source);
  TEX_KEYREF_RE.lastIndex = 0;
  for (let m = TEX_KEYREF_RE.exec(source); m; m = TEX_KEYREF_RE.exec(source)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (caret < start || caret > end) continue;
    const kind = classifyComplCmd(m[1]);
    if (!kind) return null;
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    const key = pickToken(m[2], caret - braceStart);
    return key ? { kind, key } : null;
  }
  return null;
}

/**
 * Every `\ref{…}`/`\cite{…}` key range in the source, so the editor underlines a
 * cross-reference as the link it now is — the same decoration `texRefRanges`
 * gives a `\input`, and for the same reason: an affordance that only appears
 * under the pointer is one nobody knows to look for. One range per key, so
 * `\cite{a,b}` underlines two. Pure.
 */
export function texKeyRefRanges(source: string): TexRefRange[] {
  const ranges: TexRefRange[] = [];
  source = blankTexComments(source);
  TEX_KEYREF_RE.lastIndex = 0;
  for (let m = TEX_KEYREF_RE.exec(source); m; m = TEX_KEYREF_RE.exec(source)) {
    if (!classifyComplCmd(m[1])) continue;
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    let pos = 0;
    for (const part of m[2].split(",")) {
      const lead = part.length - part.trimStart().length;
      const trimmed = part.trim();
      if (trimmed) {
        const start = braceStart + pos + lead;
        ranges.push({ start, end: start + trimmed.length });
      }
      pos += part.length + 1; // account for the comma
    }
  }
  return ranges;
}

/** Where a key is defined: the file to open (as something openable, so the
 *  caller reuses one open path) plus the 1-based line/column of the definition. */
export interface TexKeyLocation extends ResolvedTexRef {
  kind: TexKeyKind;
  key: string;
  line: number;
  column: number;
}

/** The offset of the `\label{key}` defining `key`, or null. Comments blanked, so
 *  a commented-out label is not a definition; the key is compared trimmed, since
 *  `\label{ eq:1 }` and `\ref{eq:1}` are the same label to TeX. */
function findTexLabelOffset(text: string, key: string): number | null {
  const scan = blankTexComments(text);
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (let m = re.exec(scan); m; m = re.exec(scan)) {
    if (m[1].trim() === key) return m.index;
  }
  return null;
}

/**
 * Find where a `\ref`/`\cite` key is defined, across the whole document.
 *
 * A **ref** is looked for in the document's `.tex` sources ({@link
 * walkTexSources}), starting with the file the click came from — both because
 * that is where a label usually is and because it is the one file whose *draft*
 * can be handed in, so a label typed a minute ago and not yet saved is still
 * found. A **cite** is looked for in the `.bib` files the document names, at the
 * record's own first line.
 *
 * Null when nothing defines the key — a `\ref` to a label that does not exist is
 * an ordinary state of a document being written, so the caller must leave the
 * click alone rather than report an error over it.
 */
export async function resolveTexKeyRef(
  currentPath: string,
  ref: TexKeyRef,
  options: {
    projectId?: string | null;
    /** The unsaved buffer for `currentPath`, when the caller has one. */
    currentText?: string;
    disabled?: ReadonlySet<InternalViewer>;
  } = {},
): Promise<TexKeyLocation | null> {
  const { projectId = null, currentText, disabled } = options;
  const key = ref.key.trim();
  if (!key) return null;

  let hit: TexKeyLocation | null = null;
  const bibPaths = await walkTexSources(
    currentPath,
    projectId,
    (file, text) => {
      if (ref.kind !== "ref") return;
      const at = findTexLabelOffset(text, key);
      if (at == null) return;
      const open = viewerRefFor(file, disabled);
      if (!open) return;
      const { line, column } = offsetToLineCol(text, at);
      hit = { ...open, kind: ref.kind, key, line, column };
      return true;
    },
    { currentFirst: true, currentText },
  );
  if (hit || ref.kind === "ref") return hit;

  for (const bib of bibPaths) {
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: bib, projectId });
    } catch {
      continue;
    }
    const record = parseBib(text).records.find((r) => r.kind === "entry" && r.key === key);
    if (!record) continue;
    const open = viewerRefFor(bib, disabled);
    if (!open) continue;
    return { ...open, kind: ref.kind, key, line: record.line, column: 1 };
  }
  return null;
}

// --- Document structure (the TeX workspace's left sidebar) ------------------
//
// The single main `.tex` a workspace tab is opened on, enumerated as a tree of
// its inputted children (`\input`/`\include`/`\subfile`) and its graphics
// (`\includegraphics`), so the sidebar can list what makes up the document and
// let a click switch the center view to any of it. Built entirely on the tested
// helpers above (`texCommandTokens`/`resolveSibling` for children,
// `resolveTexRefAsync` for graphics, `parseTexSections` for the heading a node
// sits under) — this is only the bounded, best-effort walk that stitches them
// into a tree, matching `gatherTexCompletions`' conventions (≤60-file cap,
// missing/unreadable files skipped, no throw).

/** A `\includegraphics` target of one file: the resolved absolute path, its
 *  basename label, the viewer that renders it (image/pdf/…), and the nearest
 *  preceding section heading in the referencing file (if any). */
export interface TexGraphicNode {
  path: string;
  label: string;
  viewer: InternalViewer;
  section?: string;
  /** 1-based line/column of the `\includegraphics` in the referencing file —
   *  where "go up" from the graphic lands (#tex-structure-up). */
  line?: number;
  column?: number;
}

/** One `.tex` file in the document tree: its inputted children in document
 *  order, its graphics, and the heading it sits under in its parent. */
export interface TexFileNode {
  path: string;
  label: string;
  /** The nearest preceding sectioning heading in the PARENT file, when this node
   *  was reached via an `\input`/`\include` under one. Absent for the root. */
  section?: string;
  /** 1-based line/column of the `\input`/`\include`/`\subfile` in the PARENT
   *  file that reached this node — the place the workspace's "go up" step
   *  (#tex-structure-up) puts the caret on. Absent for the root. */
  line?: number;
  column?: number;
  graphics: TexGraphicNode[];
  children: TexFileNode[];
}

/** The parsed structure of a main document, rooted at the build root. */
export interface TexStructure {
  root: TexFileNode;
}

// `\cmd[opts]{arg}` for the child-file commands AND `\includegraphics`, captured
// WITH position so each referenced node can be attributed to the section it sits
// under (document order preserved by the global scan). Kept local to the walk
// below rather than folded into TEX_REF_RE, which also matches bibliography
// commands the sidebar does not list.
const TEX_STRUCT_RE = new RegExp(
  `\\\\(${[...TEX_INPUT_CMDS, "includegraphics"].join("|")})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
  "g",
);

/** The title of the last sectioning heading at or before `pos`, or undefined. */
function sectionAt(sections: Array<{ pos: number; title: string }>, pos: number): string | undefined {
  let title: string | undefined;
  for (const s of sections) {
    if (s.pos > pos) break;
    title = s.title;
  }
  return title;
}

/**
 * Enumerate `rootPath`'s document structure for the workspace sidebar: the tree
 * of inputted `.tex` children and the `\includegraphics` graphics of each, each
 * attributed to the sectioning heading it sits under. Bounded (≤60 files) and
 * best-effort — an unreadable or missing file becomes a leaf node rather than an
 * error, and a bare `\includegraphics{fig}` is resolved by probing its directory
 * (via `resolveTexRefAsync`) exactly as Ctrl+click does. `projectId` scopes the
 * file reads like `gatherTexCompletions`.
 */
export async function gatherTexStructure(
  rootPath: string,
  projectId: string | null = null,
  disabled?: ReadonlySet<InternalViewer>,
): Promise<TexStructure> {
  const seen = new Set<string>();

  const build = async (filePath: string, section: string | undefined): Promise<TexFileNode> => {
    seen.add(filePath);
    const node: TexFileNode = {
      path: filePath,
      label: basename(filePath),
      section,
      graphics: [],
      children: [],
    };
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: filePath, projectId });
    } catch {
      return node; // missing/unreadable → a leaf, still shown
    }
    // Scan a comment-blanked copy (same length, so section offsets still line
    // up): a commented-out `\input{…}`/`\includegraphics{…}` — or a commented
    // `\section` — must not plant a phantom entry in the sidebar.
    const scan = blankTexComments(text);
    const sections = parseTexSections(scan);
    // One document-order pass over both kinds, so children and graphics are
    // gathered in the order they appear and can be attributed to their heading.
    type Job = { token: string; section?: string; line: number; column: number };
    const childJobs: Job[] = [];
    const graphicJobs: Job[] = [];
    TEX_STRUCT_RE.lastIndex = 0;
    // Line/column of each reference, so "go up" from a child can land on the
    // `\input` that reached it rather than at the parent's top. The scan is the
    // same length as the text, so offsets in it are offsets in the file; the
    // line count is kept incrementally since matches arrive in document order.
    let line = 1;
    let lineFrom = 0;
    for (let m = TEX_STRUCT_RE.exec(scan); m; m = TEX_STRUCT_RE.exec(scan)) {
      const cmd = m[1];
      const sec = sectionAt(sections, m.index);
      for (let i = scan.indexOf("\n", lineFrom); i !== -1 && i < m.index; i = scan.indexOf("\n", lineFrom)) {
        line += 1;
        lineFrom = i + 1;
      }
      const column = m.index - lineFrom + 1;
      for (const part of m[2].split(",")) {
        const token = part.trim();
        if (!token) continue;
        if (cmd === "includegraphics") graphicJobs.push({ token, section: sec, line, column });
        else childJobs.push({ token, section: sec, line, column });
      }
    }
    // Resolve graphics (async — a bare stem lists its directory). Skipped when
    // nothing resolves, so a stale/removed figure never plants a dead entry.
    for (const g of graphicJobs) {
      const resolved = await resolveTexRefAsync(
        filePath,
        { command: "includegraphics", token: g.token },
        disabled,
      );
      if (resolved) {
        node.graphics.push({
          path: resolved.path,
          label: resolved.label,
          viewer: resolved.viewer,
          section: g.section,
          line: g.line,
          column: g.column,
        });
      }
    }
    // Recurse into inputted children in document order, honouring the cap and
    // skipping anything already visited (a cycle, or a file inputted twice).
    for (const c of childJobs) {
      if (seen.size >= 60) break;
      const childPath = resolveSibling(filePath, c.token, ".tex");
      if (seen.has(childPath)) continue;
      const child = await build(childPath, c.section);
      child.line = c.line;
      child.column = c.column;
      node.children.push(child);
    }
    return node;
  };

  const root = await build(rootPath, undefined);
  return { root };
}

/** Where "go up" from `path` lands (#tex-structure-up): the file that inputs
 *  it (or, for a graphic, that `\includegraphics` it) and the 1-based
 *  line/column of that reference. Null for the root — and for a path the
 *  structure does not list, which the workspace centers on the main document
 *  anyway. The first occurrence wins: a file inputted twice is listed once
 *  (see `gatherTexStructure`), under the parent that reached it first. */
export function texStructureParent(
  structure: TexStructure,
  path: string,
): { path: string; line?: number; column?: number } | null {
  const walk = (n: TexFileNode): { path: string; line?: number; column?: number } | null => {
    for (const c of n.children) {
      if (c.path === path) return { path: n.path, line: c.line, column: c.column };
    }
    for (const g of n.graphics) {
      if (g.path === path) return { path: n.path, line: g.line, column: g.column };
    }
    for (const c of n.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(structure.root);
}

// --- Word count (#245) -------------------------------------------------------
//
// "How long is it?" is a question every piece of academic writing is asked by
// something with a limit attached — a page budget, an abstract cap, a reviewer's
// word count — and it is the one question a `.tex` file answers worst. `wc -w`
// counts `\includegraphics[width=0.8\textwidth]{figures/plot.pdf}` as four
// words, and opening the PDF to count from there is not counting at all.
//
// So the scanner below reads the source the way `texcount` does: the preamble is
// not text, a control sequence is not a word, a formula is one object rather than
// a handful of them, a verbatim block is not prose, and a heading and a caption
// are counted apart from the body because that is how a limit is usually
// written. It is deliberately shallow, like the rest of this module — it does not
// expand macros, so a `\newcommand` that produces three words counts as none —
// and that is the right side to be wrong on: a count that silently inflates is
// worse than one a writer knows is a floor.

/** A TeX-aware count of one document. Body, headings and captions are separate
 *  totals because that is how a length limit is normally stated. */
export interface TexWordCount {
  /** Words in the body text — headings and captions excluded. */
  words: number;
  /** Words in sectioning titles (`\section{…}` and friends) and `\title`. */
  headerWords: number;
  /** Words inside `\caption{…}`/`\captionof{…}{…}`. */
  captionWords: number;
  /** Characters in the counted words, spaces and markup excluded. */
  characters: number;
  /** Sectioning commands encountered. */
  headers: number;
  /** `figure`/`table` environments (starred variants included). */
  floats: number;
  /** `$…$` and `\(…\)` groups — one each, not their contents. */
  inlineMath: number;
  /** Display-math groups: `\[…\]`, `$$…$$` and the amsmath environments. */
  displayMath: number;
}

/** An empty count, so a caller can fold several files together from a base. */
const ZERO_COUNT: TexWordCount = {
  words: 0, headerWords: 0, captionWords: 0, characters: 0,
  headers: 0, floats: 0, inlineMath: 0, displayMath: 0,
};

/** Environments whose body is display math: counted as one display each, their
 *  contents never counted as words. */
const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*", "gather",
  "gather*", "multline", "multline*", "flalign", "flalign*", "displaymath",
  "eqnarray", "eqnarray*", "split", "cases", "IEEEeqnarray", "IEEEeqnarray*",
]);

/** Environments whose body is not prose at all — skipped whole, counted as
 *  nothing. A `tikzpicture` is a drawing and `lstlisting` is code. */
const SKIP_ENVS = new Set([
  "verbatim", "verbatim*", "lstlisting", "minted", "Verbatim", "alltt",
  "tikzpicture", "pgfpicture", "filecontents", "filecontents*", "comment",
]);

/** Environments that are floats — counted, and still read inside for the
 *  caption they exist to carry. */
const FLOAT_ENVS = new Set(["figure", "figure*", "table", "table*", "wrapfigure", "algorithm"]);

/** Commands whose arguments are machinery rather than prose: their brace and
 *  bracket groups are skipped whole. Sectioning, `\caption` and the text-styling
 *  commands are deliberately absent — their arguments ARE the text. */
const COUNT_SKIP_CMDS = new Set([
  "label", "ref", "cref", "Cref", "autoref", "eqref", "pageref", "nameref",
  "input", "include", "subfile", "includegraphics", "usepackage", "documentclass",
  "bibliography", "bibliographystyle", "addbibresource", "printbibliography",
  "graphicspath", "newcommand", "renewcommand", "providecommand", "newenvironment",
  "renewenvironment", "DeclareMathOperator", "newtheorem", "setlength",
  "addtolength", "definecolor", "setcounter", "newcounter", "hspace", "vspace",
  "url", "bibitem", "cite", "citep", "citet", "parencite", "textcite", "footcite",
]);

/** Sectioning commands whose title is counted as a heading. */
const COUNT_HEADER_CMDS = new Set([
  "part", "chapter", "section", "subsection", "subsubsection", "paragraph",
  "subparagraph", "title", "frametitle", "subtitle",
]);

/** A word: a run of letters/digits with internal apostrophes or hyphens. Counted
 *  only when it holds a letter or a digit, so a stray `--` is not a word. */
const COUNT_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Count the words (and their characters) in a fragment of already-extracted
 *  prose. Shared by the body, heading and caption tallies. */
function countWordsIn(text: string): { words: number; characters: number } {
  let words = 0;
  let characters = 0;
  COUNT_WORD_RE.lastIndex = 0;
  for (let m = COUNT_WORD_RE.exec(text); m; m = COUNT_WORD_RE.exec(text)) {
    words++;
    characters += m[0].length;
  }
  return { words, characters };
}

/** The `[start, end)` of the balanced `{…}` group beginning at `open` (which must
 *  be the `{`), or null when it never closes. Escaped braces do not nest. */
function braceGroupEnd(text: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return null;
}

/** Skip the optional `[…]` and mandatory `{…}` groups following `pos`, returning
 *  the offset after them. Whitespace between groups is stepped over. */
function skipArgGroups(text: string, pos: number, mandatory: number): number {
  let i = pos;
  let taken = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === "[") {
      const close = text.indexOf("]", i);
      if (close < 0) return text.length;
      i = close + 1;
      continue;
    }
    if (text[i] === "{" && taken < mandatory) {
      const close = braceGroupEnd(text, i);
      if (close == null) return text.length;
      i = close + 1;
      taken++;
      continue;
    }
    return i;
  }
}

/**
 * Count one `.tex` source, TeX-aware. Comments are blanked first; when the file
 * carries a `\begin{document}` only the body between it and `\end{document}` is
 * read, so a preamble's package options are never prose (a child file has no
 * `\begin{document}` and is read whole, which is exactly right — it *is* body).
 * Pure, and the single definition of what counts — {@link gatherTexWordCount}
 * only adds the walk over a multi-file document.
 */
export function texWordCount(source: string): TexWordCount {
  const out: TexWordCount = { ...ZERO_COUNT };
  let text = blankTexComments(source);
  const begin = text.indexOf("\\begin{document}");
  if (begin >= 0) {
    const end = text.indexOf("\\end{document}", begin);
    text = text.slice(begin + "\\begin{document}".length, end < 0 ? text.length : end);
  }

  // Prose is accumulated rather than counted per character, so a word split by a
  // `\emph{…}` in its middle is not counted as two.
  let body = "";
  const addProse = (into: "words" | "headerWords" | "captionWords", s: string) => {
    const { words, characters } = countWordsIn(s);
    out[into] += words;
    out.characters += characters;
  };
  const flushBody = () => {
    if (!body) return;
    addProse("words", body);
    body = "";
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    // Display math: `$$…$$` and `\[…\]`. Checked before inline `$`.
    if (c === "$" && text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      out.displayMath++;
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "$" && !isBackslashEscaped(text, j))) j++;
      out.inlineMath++;
      i = j + 1;
      continue;
    }
    if (c === "\\" && (text[i + 1] === "[" || text[i + 1] === "(")) {
      const closer = text[i + 1] === "[" ? "\\]" : "\\)";
      const close = text.indexOf(closer, i + 2);
      if (text[i + 1] === "[") out.displayMath++;
      else out.inlineMath++;
      i = close < 0 ? text.length : close + 2;
      continue;
    }

    if (c !== "\\") {
      // A group delimiter is markup, not a space: `super\emph{script}` is one
      // word to a reader (and to `wc -w`), so the braces are dropped rather than
      // kept as separators that would split it into two.
      if (c !== "{" && c !== "}") body += c;
      i++;
      continue;
    }

    const m = /^\\([a-zA-Z]+)\*?/.exec(text.slice(i));
    if (!m) { i += 2; continue; } // `\%`, `\&`, `\\` — punctuation, not a word
    const cmd = m[1];
    let after = i + m[0].length;

    if (cmd === "begin" || cmd === "end") {
      const open = text.indexOf("{", after);
      const close = open >= 0 ? text.indexOf("}", open) : -1;
      const env = close >= 0 ? text.slice(open + 1, close) : "";
      if (cmd === "end") { i = close < 0 ? text.length : close + 1; continue; }
      flushBody();
      const endToken = `\\end{${env}}`;
      if (MATH_ENVS.has(env) || SKIP_ENVS.has(env)) {
        if (MATH_ENVS.has(env)) out.displayMath++;
        const stop = text.indexOf(endToken, close);
        i = stop < 0 ? text.length : stop + endToken.length;
        continue;
      }
      if (FLOAT_ENVS.has(env)) out.floats++;
      i = close < 0 ? text.length : close + 1;
      continue;
    }

    if (COUNT_HEADER_CMDS.has(cmd)) {
      flushBody();
      out.headers++;
      after = skipArgGroups(text, after, 0); // step over `[short title]`
      if (text[after] === "{") {
        const close = braceGroupEnd(text, after);
        if (close != null) {
          addProse("headerWords", text.slice(after + 1, close));
          i = close + 1;
          continue;
        }
      }
      i = after;
      continue;
    }

    if (cmd === "caption" || cmd === "captionof") {
      flushBody();
      // `\captionof{figure}{…}` — the first group names the float type.
      after = skipArgGroups(text, after, cmd === "captionof" ? 1 : 0);
      if (text[after] === "{") {
        const close = braceGroupEnd(text, after);
        if (close != null) {
          addProse("captionWords", text.slice(after + 1, close));
          i = close + 1;
          continue;
        }
      }
      i = after;
      continue;
    }

    if (COUNT_SKIP_CMDS.has(cmd)) {
      // Skip its groups whole. Two mandatory ones covers `\newcommand{\x}{…}`
      // and `\href{url}{text}`-shaped machinery; the extra group a command does
      // not have is simply not there to take.
      i = skipArgGroups(text, after, 2);
      continue;
    }

    // Any other command: the NAME is markup, whatever it wraps is text. A word
    // interrupted by `\emph{…}` therefore stays one word, since `body` is only
    // flushed at a real boundary.
    i = after;
  }
  flushBody();
  return out;
}

/**
 * Count a whole document: {@link texWordCount} over every `.tex`
 * {@link walkTexSources} reaches from the build root, summed. The file being
 * edited is read from the caller's draft when one is given, so the number
 * answers for what is on screen rather than what was last saved.
 */
export async function gatherTexWordCount(
  currentPath: string,
  projectId: string | null = null,
  options: { currentText?: string } = {},
): Promise<TexWordCount & { files: number }> {
  const total: TexWordCount & { files: number } = { ...ZERO_COUNT, files: 0 };
  await walkTexSources(
    currentPath,
    projectId,
    (_file, text) => {
      const one = texWordCount(text);
      total.files++;
      for (const k of Object.keys(ZERO_COUNT) as Array<keyof TexWordCount>) total[k] += one[k];
    },
    { currentText: options.currentText },
  );
  return total;
}
