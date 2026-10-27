import { ROOT_SCOPE, orderedTabKeys, useTabsStore, type TabEntry } from "../../../stores/tabs";
import { useRootOverlayStore } from "../../../stores/rootOverlay";
import {
  centerTexWorkspace,
  compileTexWorkspace,
  hasTexCompiler,
  requestTexCenter,
  requestTexCompile,
} from "../../../stores/viewers/texCenter";
import { resolveTexRoot } from "./tex";
import { basename, dirname } from "../../paths";
import { openTabInScope } from "../../tabs/tabScopeContext";

/**
 * The single open-a-LaTeX-file policy: open (or focus) the ONE "TeX workspace"
 * tab for the document `clickedPath` belongs to, and center it on `clickedPath`.
 *
 * The GOAL is "one tab, not a scatter": every place that used to open a `.tex`
 * as its own embed tab (the FileTree double-click, a drag-to-tab, Quick Open)
 * funnels through here instead. It resolves the build root (`resolve_tex_root`,
 * so a child `\input` file redirects to its main document) and dedupes on that
 * root, so there is exactly one workspace tab per main document. Opening a child
 * of an already-open workspace just focuses it and switches the center via
 * `texActivePath` — no second tab.
 *
 * Kept in this tiny module (imports only the tabs store, `resolveTexRoot` and
 * `paths`) rather than in the 7,000-line `FileViewerPane`, mirroring how
 * `openProjectFilesTab` is split out, so every call site can import it without
 * dragging the whole viewer graph (and its import cycles) along.
 *
 * `place` is the detached-popout / drop-target seam (like `openFileEntry`'s
 * `placeTab`): when given AND no existing workspace is found, it is handed the
 * fresh tab payload to place (into a popout, a split, a drop slot) instead of the
 * default `addTab` into the focused subwindow.
 *
 * `drop` marks a DROP rather than a click, for the existing-workspace case. A
 * workspace is a single-tab concept, so an already-open one is never duplicated —
 * but a drop names a destination, and "focus it wherever it already is" is not
 * an answer to "put it here": a `.tex` dragged from the side panel onto a popout
 * while its workspace was open in the main window lit the popout's split preview
 * and then visibly did nothing (the existing tab was focused in the main window,
 * or — when it lived in a popout, where `setActive` cannot see it — nowhere at
 * all). So a drop of the document's ROOT hands the existing tab to
 * `drop.relocate` to be MOVED to the target; a drop of a CHILD (a file the root
 * `\input`s, which the build-root resolver folds into the same document) opens
 * that child as its own editor tab at the target through `place`, leaving the
 * workspace where it is — the user dragged a distinct file to a specific place,
 * and moving the whole document there, or nothing at all, is not what a drop
 * of that file asked for. A plain open (a click, no destination) still focuses
 * the workspace in place and centers it on the clicked file.
 *
 * `scope` names the scope the workspace belongs to when it is not the active one
 * (the root console's, `TabScopeContext`): the dedupe looks there and a fresh
 * tab lands there. Omitted, both use the active scope.
 */
export interface TexWorkspaceDrop {
  relocate: (existingKey: string) => void;
}

export async function openTexWorkspace(
  clickedPath: string,
  place?: (tab: Omit<TabEntry, "key">) => void,
  drop?: TexWorkspaceDrop,
  scope?: string | null,
): Promise<void> {
  const root = await resolveTexRoot(clickedPath);
  const store = useTabsStore.getState();
  const scopeTabs = scope ? store.tabsByScope[scope] ?? [] : store.tabs;

  // Represent "center shows the main document" as texActivePath === root (store
  // the root path), not undefined, so focusing an existing workspace on its own
  // main is an ordinary merge write with nothing to clear.
  const activePath = clickedPath === root ? root : clickedPath;

  // The tab that already holds this document, if any. A bare `tex` tab ON THE
  // ROOT counts as one: `viewer` is persisted, so a `.tex` opened as a plain
  // editor before this one-workspace-per-document policy came back as a plain
  // editor for ever — no structure sidebar, no in-place child navigation — and a
  // dedupe looking only for `texworkspace` answered re-opening the file by
  // adding a SECOND tab beside it instead of fixing the first. Matching it here
  // and promoting it in place is the heal for the tab the user actually has open.
  // A CHILD editor tab (a drop, a followed link) never matches: its `embedPath`
  // is not the root the click resolved to.
  const isLegacyEditor = (t: TabEntry) =>
    t.kind === "embed" && t.viewer === "tex" && t.embedPath === root;
  const existing = scopeTabs.find(
    (t) => (t.kind === "embed" && t.viewer === "texworkspace" && t.embedPath === root) || isLegacyEditor(t),
  );
  if (existing) {
    if (isLegacyEditor(existing)) store.setTabViewer(existing.key, "texworkspace");
    if (drop && clickedPath !== root) {
      // A child dropped somewhere specific while its document is open: a plain
      // editor tab for THAT file, there. The workspace is left untouched.
      const child: Omit<TabEntry, "key"> = {
        label: basename(clickedPath) || clickedPath,
        cmd: "",
        cwd: dirname(clickedPath) || "/",
        kind: "embed",
        embedPath: clickedPath,
        viewer: "tex",
      };
      if (place) place(child);
      else if (scope) openTabInScope(scope, child);
      else store.setActive(store.addTab(child).key);
      return;
    }
    // Center first, then move/focus: the relocation may re-seed a popout, and
    // the seed should already carry the centered path.
    store.setViewerState(existing.key, { texActivePath: activePath });
    if (drop) drop.relocate(existing.key);
    else store.setActive(existing.key);
    return;
  }

  const tab: Omit<TabEntry, "key"> = {
    label: basename(root) || root,
    cmd: "",
    cwd: dirname(root) || "/",
    kind: "embed",
    embedPath: root,
    viewer: "texworkspace",
    // A fresh workspace centers on the main by default (texActivePath absent);
    // only seed it when a child was the file actually opened.
    viewerState: clickedPath === root ? undefined : { texActivePath: clickedPath },
  };

  if (place) {
    place(tab);
    return;
  }
  if (scope) {
    openTabInScope(scope, tab);
    return;
  }
  const entry = store.addTab(tab);
  store.setActive(entry.key);
}

/**
 * Route a SyncTeX reverse-search target (a `.tex` source) into an ALREADY-OPEN
 * workspace, when one owns it. Resolves the build root and looks for an existing
 * workspace tab keyed on it; if found, focuses that tab and switches its center
 * to `sourcePath` (via `texActivePath`), returning `true`. Returns `false` — and
 * touches nothing — when no workspace tab is open for the document, so the caller
 * falls back to the standalone open.
 *
 * The deliberate difference from `openTexWorkspace` is that this NEVER creates a
 * tab: reverse search is a navigation into an existing surface, so a PDF whose
 * workspace the user has closed should reopen the source the ordinary way, not
 * resurrect the whole workspace.
 *
 * #42 cross-window, in escalation order:
 *  1. A workspace MOUNTED IN THIS WINDOW is centered through the `texCenter`
 *     registry — the only probe that works in a popout (whose tabs store holds
 *     no tabs), and in the main window it also routes through the workspace's
 *     own `goTo`, so the back stack records the step.
 *  2. A workspace tab in this window's store that is DETACHED (rendered in a
 *     popout) gets the switch broadcast to the window that renders it: a
 *     `setViewerState` here would write a field the popout's one-time-seeded
 *     local mirror never re-reads — the write that used to make pdf→tex sync
 *     look dead for a popped-out workspace.
 *  3. An in-layout tab keeps the direct store write.
 */
export async function focusTexWorkspaceForSource(sourcePath: string): Promise<boolean> {
  const root = await resolveTexRoot(sourcePath);
  if (centerTexWorkspace(root, sourcePath)) return true;
  const store = useTabsStore.getState();
  const isWorkspace = (t: TabEntry) =>
    t.kind === "embed" && t.viewer === "texworkspace" && t.embedPath === root;
  // The root console's tabs are on screen too while it floats over a project
  // (the same rule as `tabKeyForPath`): missing its workspace here sent every
  // reverse click from a console PDF to the standalone open, one more tab each.
  const existing =
    store.tabs.find(isWorkspace) ??
    (useRootOverlayStore.getState().open
      ? store.tabsByScope[ROOT_SCOPE]?.find(isWorkspace)
      : undefined);
  if (!existing) return false;
  const detachedGroups = store.detachedGroupsByScope[existing.scope ?? store.scope] ?? [];
  if (detachedGroups.some((g) => orderedTabKeys(g.subtree).includes(existing.key))) {
    requestTexCenter(root, sourcePath);
    return true;
  }
  store.setActive(existing.key);
  // "center on the main" is represented as texActivePath === root, matching
  // `openTexWorkspace`, so nothing has to special-case the main document.
  store.setViewerState(existing.key, { texActivePath: sourcePath === root ? root : sourcePath });
  return true;
}

/**
 * Whether a recompile of the document `sourcePath` belongs to can be triggered
 * from here: an editor for it (or for its main document) is mounted in this
 * window, or a workspace tab for the main document exists in this window's
 * store (possibly rendered in a popout). The PDF viewer's recompile notice
 * offers its button only when this is true — a button that does nothing is
 * worse than a sentence.
 */
export async function canRecompileTexSource(sourcePath: string): Promise<boolean> {
  const root = await resolveTexRoot(sourcePath).catch(() => sourcePath);
  if (hasTexCompiler(sourcePath) || hasTexCompiler(root)) return true;
  return useTabsStore
    .getState()
    .tabs.some((t) => t.kind === "embed" && t.viewer === "texworkspace" && t.embedPath === root);
}

/**
 * Recompile the document `sourcePath` belongs to, through the editor that owns
 * the build (`registerTexCompile`): the mounted editor for the source or its
 * main document in this window, else a broadcast to the window rendering the
 * (detached) workspace. The workspace is focused first so the build's errors
 * and the resulting PDF reload land somewhere visible. Returns false when no
 * workspace for the document is known to this window at all.
 */
export async function recompileTexSource(sourcePath: string): Promise<boolean> {
  const root = await resolveTexRoot(sourcePath).catch(() => sourcePath);
  if (compileTexWorkspace(sourcePath) || compileTexWorkspace(root)) return true;
  if (!(await focusTexWorkspaceForSource(sourcePath))) return false;
  // Focusing mounted the editor in this window (a keep-mounted center switch),
  // or the workspace lives in a popout — either way, one more local try before
  // the broadcast.
  if (compileTexWorkspace(sourcePath) || compileTexWorkspace(root)) return true;
  requestTexCompile(root, sourcePath);
  return true;
}
