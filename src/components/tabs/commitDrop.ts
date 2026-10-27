import { type TabDrag } from "../../stores/drag/drag";
import { findGroupOfTab, useTabsStore } from "../../stores/tabs";
import { useLinkRoutingStore } from "../../stores/linkRouting";
import { useTabLandStore } from "../../stores/drag/tabLand";
import { openLinkedFile } from "../embed/fileViewer/openLinked";
import { basename, dirname } from "../../lib/paths";

/**
 * Commit a finished tab drag. Reads store actions from getState() so it can live
 * outside any component. A reorder target adjusts the slot for the source's
 * removal; an edge target splits (or moves into, for center).
 *
 * This lives in its own module (not in CenterPanel) because it is the SINGLE
 * drop authority and must be callable from TabBar's pointerup handler too: on
 * WebKitGTK the terminal `pointerup` is only delivered to window listeners bound
 * before the gesture's implicit pointer capture (i.e. TabBar's, bound at
 * pointerdown). CenterPanel's listeners are added mid-gesture and never see the
 * release, so they cannot be the sole committer.
 */
export function commitDrop(d: TabDrag | null) {
  if (!d) return;
  // #42: a detached-window drag is committed by CenterPanel's cross-window END
  // handler (via attachGroup), not here — guard so a stray pointerup on the main
  // window can never mis-commit it as a tab move.
  if (d.kind === "detached") return;
  // #50: a link dragged out of a viewer onto a subwindow records a session-only
  // route (linkingTab, targetPath) → that group, then opens the file there. The
  // pure routing/open is reused so a click later honours the same target.
  if (d.kind === "link") {
    commitLinkDrop(d);
    return;
  }
  const store = useTabsStore.getState();
  // A whole subwindow dragged by its grip: a bar slot or a body's center
  // merges its tabs in, an edge moves the subwindow there. Dropped on itself
  // (or nowhere) it stays put — this drag never pops out.
  if (d.kind === "group") {
    if (d.reorderGroup && d.reorderIndex != null) {
      store.moveGroup(d.fromGroup, d.reorderGroup, "center", d.reorderIndex);
    } else if (d.overGroup && d.edge) {
      store.moveGroup(d.fromGroup, d.overGroup, d.edge);
    }
    return;
  }
  if (d.reorderGroup && d.reorderIndex != null) {
    if (d.reorderGroup === d.fromGroup) {
      const found = findGroupOfTab(store.layout, d.key);
      if (!found) return;
      const from = found.index;
      // The slot indexes the array *before* the source is spliced out, so a
      // target to its right shifts left by one once it's removed.
      const to = from < d.reorderIndex ? d.reorderIndex - 1 : d.reorderIndex;
      if (to !== from && to >= 0) store.reorderInGroup(d.reorderGroup, from, to);
    } else {
      // Dropped into ANOTHER bar's slot: play the destination drop-in landing.
      store.moveTab(d.key, d.reorderGroup, d.reorderIndex);
      useTabLandStore.getState().markLanded(d.key);
    }
    return;
  }
  if (d.overGroup && d.edge) {
    if (d.edge === "center") {
      // Dropping onto the body of the SAME subwindow it came from is a no-op:
      // keep the tab where it is rather than moving it to the end of its own
      // group. (A non-center edge is a real split-off intent, so it's allowed.)
      if (d.overGroup === d.fromGroup) return;
      // Merged into another subwindow's tab bar → land in its new group.
      store.moveTab(d.key, d.overGroup);
      useTabLandStore.getState().markLanded(d.key);
    } else {
      // Split off into a brand-new subwindow → land in the new group's bar.
      store.splitWithTab(d.key, d.overGroup, d.edge);
      useTabLandStore.getState().markLanded(d.key);
    }
  }
}

/**
 * Commit a "link" drag (#50): the user dragged a file link onto a subwindow to
 * make it the session-only target for that link. Record the override route and
 * open the linked file there. Exported for the unit test.
 */
export function commitLinkDrop(d: TabDrag) {
  if (!d.overGroup || !d.linkTargetPath || !d.linkingTabKey || !d.viewer) return;
  useLinkRoutingStore
    .getState()
    .setRoute(d.linkingTabKey, d.linkTargetPath, d.overGroup);
  const dir = dirname(d.linkTargetPath) || "/";
  openLinkedFile(d.linkingTabKey, dir, {
    path: d.linkTargetPath,
    viewer: d.viewer,
    label: basename(d.linkTargetPath),
  });
}
