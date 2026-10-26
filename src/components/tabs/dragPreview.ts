import { allGroups, findGroup, type LayoutNode } from "../../stores/tabs";
import { removeNodeById } from "../../stores/tabs/layoutTree";

/**
 * The layout that should be RENDERED while a tab drag is in flight.
 *
 * When a subwindow's ONLY tab is being dragged, its (about-to-empty) subwindow is
 * pruned so the remaining subwindows reflow to fill — the source closes "on
 * dragging", not just on the drop. This is a render-only preview: the store
 * layout is NOT mutated, so an aborted/Escaped drag restores instantly and the
 * dragged tab's pane stays mounted in CenterPanel's flat pane layer (its PTY
 * survives; the floating ghost previews its content). The real source-group
 * collapse still happens in the store on commit (writeScope → pruneCollapse).
 *
 * Returns `layout` unchanged when there's nothing to collapse: no tab drag, the
 * dragged tab isn't the lone tab of its source group, it's the only subwindow
 * (nothing to expand into), or a group is fullscreen (its pane owns the panel).
 */
export function dragPreviewLayout(
  layout: LayoutNode | null,
  dragKind: string | null,
  dragKey: string | null,
  dragFromGroup: string | null,
  fullscreen: boolean,
): LayoutNode | null {
  if (!layout || fullscreen) return layout;
  if (dragKind !== "tab" || !dragKey || !dragFromGroup) return layout;
  const src = findGroup(layout, dragFromGroup);
  if (!src || src.tabKeys.length !== 1 || src.tabKeys[0] !== dragKey) return layout;
  // Don't collapse the only subwindow — there's no sibling to expand into, and
  // the placeholder/empty-state would flicker for the duration of the drag.
  if (allGroups(layout).length <= 1) return layout;
  return removeNodeById(layout, dragFromGroup) ?? layout;
}
