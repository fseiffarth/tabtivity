/**
 * File paths an agent wrote — in its terminal or in the Reader's chat — as
 * links that open the file's tab (`docs/plan.md`, `src/a.ts:120`).
 *
 * `findPathCandidates` picks the path-shaped words out of a line of text; the
 * backend (`resolve_text_paths`) says which of them exist inside the tab's
 * folder or its project, and only those become links. The text is the agent's,
 * so whatever a project fed it: a link only ever opens an in-app viewer tab
 * (`isLinkable`) — never the OS default app, which could run the file — and
 * never anything outside those folders. Local tabs only: a tab that runs on a
 * remote host names paths on that host (`pathLinkContext` gives it no folders).
 */
import { invoke } from "@tauri-apps/api/core";
import { openFileEntry } from "../../components/files/openFileEntry";
import { openProjectFilesTab } from "../../components/files/ProjectFilesTab";
import { useTabsStore } from "../../stores/tabs";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { basename, relativePathWithin } from "../paths";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../viewers/fileUtils";
import type { TranslationKey } from "../i18n";

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

/** Where a tab's path links are looked up and how they open. */
export interface PathLinkContext {
  /** Folders paths are looked up under, in order; empty = no path links. */
  bases: readonly string[];
  /** The project's folder ("" in the root scope): folder links and the
   *  viewer tab's cwd. */
  projectDir: string;
  disabled?: ReadonlySet<InternalViewer>;
}

/** The tab's own folder, then its project's. `projectDir` is the project's
 *  folder, "" for a remote project and null when the project is not known (a
 *  popout holds no projects): a project tab without a local folder gets no
 *  links — a remote-run tab prints the remote host's paths. */
export function pathLinkContext(
  projectId: string | null | undefined,
  projectDir: string | null,
  cwd: string | undefined,
  disabled?: ReadonlySet<InternalViewer>,
): PathLinkContext {
  if (projectId && !projectDir) return { bases: [], projectDir: "", disabled };
  const bases = [cwd, projectDir].filter((b, i, all): b is string => !!b && all.indexOf(b) === i);
  return { bases, projectDir: projectDir ?? "", disabled };
}

/** How long one lookup is trusted: the agent creates and removes files. */
const CACHE_MS = 10_000;
const CACHE_MAX = 4000;
const cache = new Map<string, { at: number; entry: FileEntry | null }>();
const keyOf = (bases: readonly string[], path: string) => `${bases.join("\0")}\u0001${path}`;

/** The existing files and folders among `paths`, by path — one backend call
 *  for whatever the last few seconds did not already answer. */
export async function resolvePathCandidates(
  bases: readonly string[],
  paths: readonly string[],
): Promise<Map<string, FileEntry>> {
  const out = new Map<string, FileEntry>();
  if (!bases.length || !paths.length) return out;
  const now = Date.now();
  const ask: string[] = [];
  for (const path of new Set(paths)) {
    const hit = cache.get(keyOf(bases, path));
    if (hit && now - hit.at < CACHE_MS) {
      if (hit.entry) out.set(path, hit.entry);
    } else {
      ask.push(path);
    }
  }
  if (!ask.length) return out;
  const answers = await invoke<(FileEntry | null)[]>("resolve_text_paths", { bases, candidates: ask }).catch(() => null);
  if (!answers) return out;
  if (cache.size > CACHE_MAX) cache.clear();
  ask.forEach((path, i) => {
    const entry = answers[i] ?? null;
    cache.set(keyOf(bases, path), { at: now, entry });
    if (entry) out.set(path, entry);
  });
  return out;
}

/** Drop every remembered lookup (tests). */
export function clearPathLinkCache(): void {
  cache.clear();
}

/** A found path is a link only when it opens in the app: a file one of the
 *  enabled viewers shows, or a folder of the project (its Files tab). */
export function isLinkable(entry: FileEntry, projectDir: string, disabled?: ReadonlySet<InternalViewer>): boolean {
  if (entry.is_dir) return !!projectDir && relativePathWithin(projectDir, entry.path) !== null;
  return internalViewerFor(entry, disabled) !== null;
}

/** Open a path link: the file's viewer tab in the tab's own scope (reusing one
 *  already open), scrolled to the line it named; a folder in a Files tab. */
export function openPathLink(
  entry: FileEntry,
  at: { line?: number; column?: number },
  ctx: {
    scope: string;
    projectId: string | null;
    projectDir: string;
    cwd: string;
    disabled?: ReadonlySet<InternalViewer>;
    t: (key: TranslationKey) => string;
  },
): void {
  if (!isLinkable(entry, ctx.projectDir, ctx.disabled)) return;
  if (entry.is_dir) {
    openProjectFilesTab(ctx.t, ctx.projectDir, relativePathWithin(ctx.projectDir, entry.path) ?? "", ctx.scope);
    return;
  }
  openFileEntry({
    entry,
    projectDir: ctx.projectDir || ctx.cwd,
    projectId: ctx.projectId,
    origin: "agent_path_link",
    external: false,
    disabled: ctx.disabled,
    // The active scope opens like a file tree's double-click (the focused
    // subwindow); a root-console tab floating over a project, in its own.
    scope: ctx.scope === useTabsStore.getState().scope ? undefined : ctx.scope,
  });
  if (at.line) useEditorJumpStore.getState().requestJump(entry.path, at.line, at.column ?? 0);
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
export function linkPathsInHtml(html: string, links: ReadonlyMap<string, FileEntry | null>): string {
  if (!links.size) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  let changed = false;
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
