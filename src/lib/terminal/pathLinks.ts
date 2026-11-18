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
import { openFileEntry } from "../files/openFileEntry";
import { openProjectFilesTab } from "../tabs/openProjectFilesTab";
import { useTabsStore } from "../../stores/tabs";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { linkBackKey, useLinkBackStore } from "../../stores/linkBack";
import { relativePathWithin } from "../paths";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../viewers/fileUtils";
import type { TranslationKey } from "../i18n";

export { PATH_LINK_ATTR, findPathCandidates, linkPathsInHtml, unknownPaths, type PathCandidate } from "./pathCandidates";

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
 *  links — a remote-run tab prints the remote host's paths. The exception is
 *  a remote project's tab that runs here (`runsLocal`, an agent's default):
 *  it works in the project's local mirror, its `cwd`, and links what is there
 *  (files only — a folder link opens the project's Files tab). */
export function pathLinkContext(
  projectId: string | null | undefined,
  projectDir: string | null,
  cwd: string | undefined,
  disabled?: ReadonlySet<InternalViewer>,
  runsLocal = false,
): PathLinkContext {
  if (projectId && projectDir === "" && runsLocal && cwd) return { bases: [cwd], projectDir: "", disabled };
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
 *  already open), scrolled to the line it named; a folder in a Files tab.
 *  `newSubwindow` (Ctrl+click) puts the file's tab in a new subwindow.
 *  `fromTab`, the agent tab the link was in, gives the file tab a Back button
 *  to it (`stores/linkBack`) — one that closes the file tab when the link
 *  opened it. */
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
    newSubwindow?: boolean;
    fromTab?: string;
  },
): void {
  if (!isLinkable(entry, ctx.projectDir, ctx.disabled)) return;
  if (entry.is_dir) {
    openProjectFilesTab(ctx.t, ctx.projectDir, relativePathWithin(ctx.projectDir, entry.path) ?? "", ctx.scope);
    return;
  }
  const tabsOf = () => {
    const s = useTabsStore.getState();
    return ctx.scope === s.scope ? s.tabs : (s.tabsByScope[ctx.scope] ?? []);
  };
  const viewer = internalViewerFor(entry, ctx.disabled);
  const fileTab = () =>
    tabsOf().find((t) => t.kind === "embed" && t.viewer === viewer && t.embedPath === entry.path);
  const prior = fileTab();
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
    newSubwindow: ctx.newSubwindow,
  });
  const opened = ctx.fromTab ? fileTab() : undefined;
  if (opened && ctx.fromTab && opened.key !== ctx.fromTab) {
    const links = useLinkBackStore.getState();
    // A tab an earlier link opened stays one Back closes.
    const earlier = links.byTab[linkBackKey(ctx.scope, opened.key)];
    links.set(ctx.scope, opened.key, { from: ctx.fromTab, close: earlier?.close ?? !prior });
  }
  if (at.line) useEditorJumpStore.getState().requestJump(entry.path, at.line, at.column ?? 0);
}
