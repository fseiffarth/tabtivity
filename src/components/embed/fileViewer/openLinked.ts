import { findGroupOfTab, findTabByKey, useTabsStore, type TabEntry } from "../../../stores/tabs";
import { openTabInScope } from "../../../lib/tabs/tabScopeContext";
import { useLinkRoutingStore } from "../../../stores/linkRouting";
import { useEditorJumpStore } from "../../../stores/viewers/editorJump";
import { splitLineHint } from "../../../lib/viewers/markdown";
import { useMdAnchorStore } from "../../../stores/viewers/mdAnchor";
import { internalViewerFor, type InternalViewer, type FileEntry } from "../../../lib/viewers/fileUtils";
import { basename, dirname } from "../../../lib/paths";

/**
 * Open `resolved` (a linked file) following the #50 routing rules: prefer a
 * session-only drag-set override group, else the SAME subwindow/group as the
 * linking tab, else the focused group (addTab default). Re-activates an existing
 * viewer tab for the same file instead of opening a duplicate.
 */
export function openLinkedFile(
  linkingTabKey: string | undefined,
  linkingFileDir: string,
  resolved: { path: string; viewer: InternalViewer; label: string; mdGraphOriginKey?: string },
) {
  const store = useTabsStore.getState();
  // A `.tex` editor tab that healed into a workspace (`FileViewerPane`) is
  // still this file's tab: matching only `viewer: "tex"` answered every later
  // open of that document with one more copy.
  const sameFile = (t: TabEntry) =>
    t.kind === "embed" &&
    t.embedPath === resolved.path &&
    (t.viewer === resolved.viewer || (resolved.viewer === "tex" && t.viewer === "texworkspace"));
  const tab = {
    label: resolved.label,
    cmd: "",
    cwd: linkingFileDir,
    kind: "embed" as const,
    embedPath: resolved.path,
    viewer: resolved.viewer,
    ...(resolved.mdGraphOriginKey ? { mdGraphOriginKey: resolved.mdGraphOriginKey } : {}),
  };
  // A linking tab of ANOTHER scope — a viewer in the root console, floating over
  // a project — opens its link beside itself, in its own scope's focused
  // subwindow (the one it was clicked in), not in the project underneath.
  const owner = linkingTabKey ? findTabByKey(store, linkingTabKey)?.scope : undefined;
  if (owner && owner !== store.scope) {
    openTabInScope(owner, tab, sameFile);
    return;
  }
  const prior = store.tabs.find(sameFile);
  if (prior) {
    store.setActive(prior.key);
    return;
  }

  // 1. A session-only override set by dragging this link to another subwindow.
  const override =
    linkingTabKey != null
      ? useLinkRoutingStore.getState().getRoute(linkingTabKey, resolved.path)
      : null;
  // 2. Otherwise the SAME group the linking tab lives in.
  const sameGroup =
    linkingTabKey != null
      ? findGroupOfTab(store.layout, linkingTabKey)?.group.id ?? null
      : null;
  const targetGroup = override ?? sameGroup;

  if (targetGroup) {
    // splitWithNewTab with "center" adds into the target group without splitting,
    // and returns null if the group no longer exists (then we fall back).
    const created = store.splitWithNewTab(tab, targetGroup, "center");
    if (created) {
      store.setActive(created.key);
      return;
    }
  }
  // Fallback: focused group (addTab default).
  const entry = store.addTab(tab);
  store.setActive(entry.key);
}

/** What a click on a local file link in rendered Markdown does
 *  (`onMarkdownLinkClick`'s `open`): open `target` in a tab beside the linking
 *  one (`openLinkedFile`), jump to a `:line` hint, and hand a cross-file
 *  `#fragment` to the target markdown view. `mdPath` is the markdown file the
 *  link sits in. */
export function openMarkdownTarget(
  tabKey: string | undefined,
  mdPath: string,
): (target: string, href: string) => void {
  return (target, href) => {
    const hinted = splitLineHint(href);
    openLinkedFile(tabKey, dirname(mdPath), {
      path: target,
      viewer: viewerForPath(target),
      label: basename(target),
    });
    if (hinted.line != null) {
      useEditorJumpStore.getState().requestJump(target, hinted.line);
    }
    // A fragment on a cross-file markdown link (`docs/guide.md#setup`) rides
    // the anchor channel: the target view — freshly mounted or re-activated —
    // consumes it once its preview is rendered.
    const fragment = href.split("#").slice(1).join("#");
    if (fragment && viewerForPath(target) === "markdown") {
      useMdAnchorStore.getState().requestAnchor(target, fragment);
    }
  };
}

/** The built-in viewer for a bare path (no FileEntry handy), used to route a
 *  SyncTeX source target. Defaults to the plain text editor (e.g. `.sty`). */
export function viewerForPath(path: string): InternalViewer {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : null;
  const entry: FileEntry = {
    name,
    path,
    is_dir: false,
    size: 0,
    extension: ext,
    mime: null,
  };
  return internalViewerFor(entry) ?? "text";
}
