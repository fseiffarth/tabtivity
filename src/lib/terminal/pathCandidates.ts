/**
 * The pure half of the path links (`pathLinks`): finding the path-shaped words
 * of a text and marking up the ones that turned out to be files. No Tauri and
 * no store in here, so the phone's chat shares it with the desktop's.
 */
import { basename } from "../paths";

/** A path-shaped word: where it sits in the text (string indices, `end`
 *  exclusive — the `:line` after it included), the path, and that line. */
export interface PathCandidate {
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
}

// A run of characters free of the ones that delimit a path in prose and
// Markdown (spaces, quotes, brackets, `*`); a path is looked for inside one.
const WORD = /[^\s"'`<>()[\]{}|,;*=]+/gu;
const URL_LIKE = /:\/\/|^(?:https?|mailto|file):/iu;
// Sentence punctuation after a path, not part of it.
const TRAILING = /[.:!?]+$/u;
// `:12`, `:12:5` (line, column), `:12-20` (from line 12), `#L12`, `#L12C5`,
// `#L12-L20`.
const LINE_SUFFIX = /(?::(\d+)(?::(\d+)|-\d+)?|#L(\d+)(?:C(\d+)|-L?\d+)?)$/u;
// Segments joined by either separator (`src/a.ts`, `src\a.ts`), rooted at a
// POSIX `/`, a Windows drive (`C:\…`) or `./`/`../`. A bare leading `\` is no
// root here: `\section` is TeX, not a path.
const PATH_SHAPE = /^(?:\/|[A-Za-z]:[\\/]|(?:\.{1,2}[\\/])+)?[\p{L}\p{N}_@+.~-]+(?:[\\/][\p{L}\p{N}_@+.~-]+)*[\\/]?$/u;
// Two separators in a row (`a//b`, `a\\b`): an escaped string, not a path.
const DOUBLE_SEP = /[\\/]{2}/u;
// The last segment's extension, with a letter in it (`v0.1.111` has none).
const EXTENSION = /[^/\\.]\.[\p{N}_-]*\p{L}[\p{L}\p{N}_-]{0,11}$|^\.[\p{L}][\p{L}\p{N}_.-]*$/u;
const MAX_PATH_CHARS = 400;

/** The path-shaped words of `text`: a word with a `/` between two names, or a
 *  file name with an extension. Most are not paths at all — the backend's
 *  answer is what makes one a link. */
export function findPathCandidates(text: string): PathCandidate[] {
  const found: PathCandidate[] = [];
  for (const m of text.matchAll(WORD)) {
    let word = m[0];
    if (URL_LIKE.test(word) || word.length > MAX_PATH_CHARS + 16) continue;
    word = word.replace(TRAILING, "");
    let line: number | undefined;
    let column: number | undefined;
    let path = word;
    const suffix = LINE_SUFFIX.exec(word);
    if (suffix) {
      path = word.slice(0, suffix.index);
      const l = Number(suffix[1] ?? suffix[3]);
      const c = Number(suffix[2] ?? suffix[4] ?? 0);
      if (l > 0) line = l;
      if (c > 0) column = c;
    }
    path = path.replace(TRAILING, "");
    if (!path || path.length > MAX_PATH_CHARS || !PATH_SHAPE.test(path) || DOUBLE_SEP.test(path)) continue;
    if (!/\p{L}/u.test(path)) continue;
    const trimmed = path.replace(/[\\/]+$/u, "");
    const last = basename(path);
    const slashed = /[^\\/][\\/][^\\/]/u.test(path) || (path.startsWith("/") && trimmed.length > 1);
    if (!slashed && !EXTENSION.test(last)) continue;
    if (last === "." || last === "..") continue;
    const shown = line !== undefined ? word : path;
    found.push({ start: m.index, end: m.index + shown.length, path, line, column });
  }
  return found;
}

/** The attribute a chat path link carries its path in (`linkPathsInHtml`). */
export const PATH_LINK_ATTR = "data-path-link";

/**
 * `html` (an answer `answerHtml` formatted) with every path `links` holds an
 * entry for made a file link — the Markdown viewer's own `a.file-link` (#49),
 * carrying its path and line in data attributes for the chat's one click
 * handler, never an `href`. Text already inside a link is left alone. Pure
 * markup work on a detached template: nothing in it loads or runs.
 */
export function linkPathsInHtml(html: string, links: ReadonlyMap<string, unknown>): string {
  if (!links.size) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  // A Markdown link to a file (`[the report](out/report.pdf)`) keeps its own
  // label and takes the path from its target (`data-path`, `answerHtml`).
  let targeted = false;
  for (const link of template.content.querySelectorAll<HTMLElement>(".md-link[data-path]")) {
    const path = link.getAttribute("data-path") ?? "";
    if (!links.get(path)) continue;
    link.setAttribute(PATH_LINK_ATTR, path);
    link.setAttribute("role", "link");
    link.setAttribute("tabindex", "0");
    targeted = true;
  }
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  let changed = targeted;
  for (const node of texts) {
    if (node.parentElement?.closest("a, .md-link")) continue;
    const text = node.data;
    const found = findPathCandidates(text).filter((c) => links.get(c.path));
    if (!found.length) continue;
    const parts = document.createDocumentFragment();
    let from = 0;
    for (const c of found) {
      if (c.start > from) parts.append(text.slice(from, c.start));
      const a = document.createElement("a");
      a.className = "file-link";
      a.setAttribute(PATH_LINK_ATTR, c.path);
      if (c.line) a.setAttribute("data-line", String(c.line));
      if (c.column) a.setAttribute("data-column", String(c.column));
      a.setAttribute("role", "link");
      a.setAttribute("tabindex", "0");
      a.textContent = text.slice(c.start, c.end);
      parts.append(a);
      from = c.end;
    }
    if (from < text.length) parts.append(text.slice(from));
    node.replaceWith(parts);
    changed = true;
  }
  return changed ? template.innerHTML : html;
}

/** Every path-shaped word of `texts` not yet in `known`, for one lookup. */
export function unknownPaths(texts: readonly string[], known: ReadonlyMap<string, unknown>): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const c of findPathCandidates(text)) if (!known.has(c.path)) out.add(c.path);
  }
  return [...out];
}
