import { emit, listen } from "@tauri-apps/api/event";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../../stores/tabs";
import { rootViewShown, useRootOverlayStore } from "../../../stores/rootOverlay";
import { useEditorJumpStore, hasMountedEditor } from "../../../stores/viewers/editorJump";
import { parseDetachedParam } from "../../../stores/detached";
import { basename, dirname } from "../../../lib/paths";
import { focusTexWorkspaceForSource } from "../../../lib/viewers/tex/openTexWorkspace";
import { openLinkedFile, viewerForPath } from "./openLinked";
import { useProjectsStore } from "../../../stores/projects";
import { useFileSourcesStore } from "../../../stores/viewers/fileSources";
import { otherSidePath } from "../../../lib/remote/fileSide";

/** Tauri event carrying a reverse-search jump across the main/detached window
 *  boundary (#42). Only the main window listens; see {@link jumpToSource}. */
const SOURCE_JUMP_EVENT = "editor-source-jump";
interface SourceJumpEnvelope {
  input: string;
  line: number;
  column: number;
  /** The main `.tex` that produces the PDF (the clicked source's root). Used to
   *  route the opened source into the subwindow that already holds that main
   *  `.tex`. Absent, or unmatched in the receiving window (its tab isn't open
   *  there), falls back to the focused group — see {@link applySourceJump}. */
  anchorPath?: string;
}

/** The key of an open editor tab for `path` (any viewer), or undefined. Lets a
 *  reverse-search source route into the subwindow that already holds the
 *  producing main `.tex`, via {@link openLinkedFile}'s same-group rule. */
function tabKeyForPath(path: string): string | undefined {
  const store = useTabsStore.getState();
  const holds = (t: TabEntry) => t.kind === "embed" && t.embedPath === path;
  // The root console's tabs are on screen too while its Root view is up; a PDF there
  // anchors its source into the console, not into the project underneath.
  return (
    store.tabs.find(holds)?.key ??
    (rootViewShown(useRootOverlayStore.getState())
      ? store.tabsByScope[ROOT_SCOPE]?.find(holds)?.key
      : undefined)
  );
}

/** The embed tabs a jump in this window can land on: the active scope's, plus
 *  the root console's while its Root view is up (the `tabKeyForPath` rule). */
function jumpableTabs(): TabEntry[] {
  const store = useTabsStore.getState();
  if (!rootViewShown(useRootOverlayStore.getState())) return store.tabs;
  return [...store.tabs, ...(store.tabsByScope[ROOT_SCOPE] ?? [])];
}

/**
 * Show a remote project's file on the side the jump names, in the tab that is
 * already open for it, instead of a second tab.
 *
 * A PDF read from the host names its `.tex` by the HOST path; the `.tex` tab the
 * user has open usually holds the local MIRROR path (or holds the host path but
 * is switched to Local). Matching on the exact path missed it, and the jump
 * opened a duplicate tab on the remote copy. Here, for `input` and the document
 * root `anchorPath` (the workspace tab's key), the open tab of that file is put
 * on the jump's side first:
 *  - a tab on the exact path whose Local/Remote switch points the other way is
 *    switched back to the path's own side;
 *  - else a tab on the OTHER side's path is pointed at this one
 *    (`setTabEmbedPath`), which makes it read that side — what flipping its
 *    switch shows, kept across a restart like any path a tab was opened on.
 * The routing that follows then finds it by path as usual. Local projects, and
 * paths under neither root of a remote one, are left alone.
 */
function alignSourceTabSide(input: string, anchorPath?: string) {
  const store = useTabsStore.getState();
  const projects = useProjectsStore.getState().projects;
  const tabs = jumpableTabs().filter(
    (t): t is TabEntry & { embedPath: string } => t.kind === "embed" && !!t.embedPath,
  );
  const targets = anchorPath && anchorPath !== input ? [input, anchorPath] : [input];
  for (const target of targets) {
    for (const tab of tabs) {
      const project = projects.find((p) => p.id === (tab.scope ?? store.scope));
      const other = otherSidePath(project, target);
      if (!other) continue;
      if (tab.embedPath === target) {
        const controls = useFileSourcesStore.getState().controlsByTab[tab.key];
        if (controls) {
          if (controls.current !== other.side) controls.set(other.side);
        } else if (tab.viewerState?.fileSide && tab.viewerState.fileSide !== other.side) {
          // Not mounted (a hidden group): its flip is only the persisted one,
          // which it would come back on.
          store.setViewerState(tab.key, { fileSide: other.side });
        }
      } else if (tab.embedPath === other.twin && !tabs.some((t) => t.embedPath === target)) {
        store.setTabEmbedPath(tab.key, target);
      }
    }
  }
}

/** True when this webview is the MAIN window (no `?detached=` param) — the one
 *  that owns the full tab layout and is the canonical place to open source files
 *  for reverse search. */
function isMainWindow(): boolean {
  try {
    return parseDetachedParam(window.location.search) === null;
  } catch {
    return true;
  }
}

/** A `.tex` source may be owned by an open TeX workspace tab (which hosts its
 *  editor in-tab, the PDF being a separate tab). */
function isTexSource(path: string): boolean {
  return /\.tex$/i.test(path);
}

/**
 * Route a reverse-search jump into an already-open TeX workspace when one owns
 * the source, and report whether it did. On a hit it focuses the workspace and
 * switches its center to `input` ({@link focusTexWorkspaceForSource}) and posts
 * the scroll to the editor-jump store; `fallback` runs only when no workspace
 * owns the file. Non-`.tex` sources skip straight to the fallback.
 *
 * This has to run BEFORE the standalone `hasMountedEditor`/tab probes: a
 * workspace child sits mounted-but-hidden in the LRU, so it already satisfies
 * `hasMountedEditor` and a bare `requestJump` would scroll an invisible pane
 * instead of switching the center to it.
 */
function routeSourceJump(
  input: string,
  line: number,
  column: number,
  fallback: () => void,
) {
  if (!isTexSource(input)) {
    fallback();
    return;
  }
  focusTexWorkspaceForSource(input)
    .then((handled) => {
      if (handled) useEditorJumpStore.getState().requestJump(input, line, column);
      else fallback();
    })
    .catch(() => fallback());
}

/** Open/re-activate the source tab in THIS window and post the editor jump to its
 *  local editorJump store. The standalone (non-workspace) half of
 *  {@link jumpToSource}. `anchorPath` is the main `.tex` that produces the PDF:
 *  when the source is not already open, the new editor tab opens in the subwindow
 *  that already holds that main `.tex` (resolved to its tab here, so the group
 *  lookup runs in the window that owns the layout) rather than in whichever group
 *  happens to be focused. */
function openStandaloneSourceTab(input: string, line: number, column: number, anchorPath?: string) {
  const dir = dirname(input) || "/";
  const label = basename(input);
  const linkingTabKey = anchorPath ? tabKeyForPath(anchorPath) : undefined;
  openLinkedFile(linkingTabKey, dir, { path: input, viewer: viewerForPath(input), label });
  useEditorJumpStore.getState().requestJump(input, line, column);
}

/** Handle a reverse-search jump in THIS window: into an open TeX workspace when
 *  one owns the source, else open/focus the standalone source tab. The local half
 *  of {@link jumpToSource}, and what {@link listenSourceJump} runs for a jump
 *  broadcast from a detached PDF window. */
function applySourceJump(input: string, line: number, column: number, anchorPath?: string) {
  alignSourceTabSide(input, anchorPath);
  routeSourceJump(input, line, column, () =>
    openStandaloneSourceTab(input, line, column, anchorPath),
  );
}

/**
 * SyncTeX reverse search lands here: open (or re-activate) the source file's
 * editor tab and ask it to scroll to `line`/`column`. The editor
 * (`TexView`/`TextView`) for that path consumes the request via the editorJump
 * store, since the tab may already be open and won't remount.
 *
 * #42 cross-window: the PDF may be popped out into a detached window, either on
 * its own (source editor docked in the main window) or alongside the source in a
 * split view. Decide where to run the jump:
 *  - The source editor is already mounted in THIS window (e.g. a split PDF|TeX,
 *    possibly popped out) → just scroll it. This is the path a detached window
 *    must take, because its React-rendered tabs never populate `useTabsStore`,
 *    so a tab-store probe alone would wrongly report "not open" and delegate to
 *    the main window, where the editor isn't.
 *  - This window already has the source as a (possibly background) tab, or this
 *    IS the main window → open/focus it here.
 *  - Otherwise (detached window without the source) → broadcast to the main
 *    window, which owns the editor layout (it registers {@link listenSourceJump}).
 * `requestJump` itself broadcasts cross-window, so the scroll reaches the editor
 * wherever it is mounted regardless of which branch opens/focuses the tab.
 *
 * `anchorPath` is the main `.tex` that produces the PDF (the clicked source's
 * root). When the source file has no tab yet, the new editor opens in the
 * subwindow that already holds that main `.tex`, rather than whichever group
 * happens to be focused.
 */
export function jumpToSource(input: string, line: number, column = 0, anchorPath?: string) {
  // An open tab of this file showing the other side of a remote project is
  // switched to this side first, so the routing below lands on it.
  alignSourceTabSide(input, anchorPath);
  // A `.tex` source owned by an open workspace is centered there first (in this
  // window, or wherever the workspace lives — the store write reaches it); only a
  // source no workspace owns falls through to the standalone routing below.
  routeSourceJump(input, line, column, () =>
    jumpToStandaloneSource(input, line, column, anchorPath),
  );
}

/** The standalone (non-workspace) reverse-search routing: scroll an already-open
 *  editor, open/focus the source tab here, or delegate to the main window. */
function jumpToStandaloneSource(input: string, line: number, column: number, anchorPath?: string) {
  if (hasMountedEditor(input)) {
    useEditorJumpStore.getState().requestJump(input, line, column);
    return;
  }
  const viewer = viewerForPath(input);
  const hasTab = useTabsStore
    .getState()
    .tabs.some((t) => t.kind === "embed" && t.viewer === viewer && t.embedPath === input);
  if (hasTab || isMainWindow()) {
    openStandaloneSourceTab(input, line, column, anchorPath);
    return;
  }
  // Detached window without the source tab: ask the main window to handle it.
  try {
    emit(SOURCE_JUMP_EVENT, { input, line, column, anchorPath } satisfies SourceJumpEnvelope)
      .catch(() => {});
  } catch {
    /* no Tauri event bus available */
  }
}

/**
 * MAIN window: listen for reverse-search jumps broadcast from a detached PDF
 * window and run them here (open/focus the source tab + scroll the caret).
 * Register once at startup; returns an unlisten. No-op outside Tauri. Detached
 * windows never register this — they either handle a jump locally (they own the
 * source tab) or delegate to the main window via {@link jumpToSource}.
 */
export async function listenSourceJump(): Promise<() => void> {
  try {
    // Registered once at startup and hands back its unlisten — not a component lifecycle.
    // eslint-disable-next-line no-restricted-syntax
    return await listen<SourceJumpEnvelope>(SOURCE_JUMP_EVENT, (ev) => {
      const { input, line, column, anchorPath } = ev.payload;
      applySourceJump(input, line, column, anchorPath);
    });
  } catch {
    return () => {};
  }
}
