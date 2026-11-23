import { samePath } from "../paths";
import type { TabEntry } from "../../stores/tabs";
import type { InternalViewer } from "../viewers/fileUtils";

/**
 * The one "is this file already open?" test every open-a-file path shares, so a
 * second open focuses (or moves) the tab already showing it instead of adding a
 * copy. A viewer tab matches on its viewer and its path, compared with
 * `samePath`: the openers spell one file differently (a search result joined
 * onto the project folder, a link resolved against a tab's folder, a path
 * restored from an older session), and an exact string test let each spelling
 * open its own tab.
 *
 * A `.tex` editor tab that healed into a workspace (`FileViewerPane`) is still
 * that file's tab. Without `viewer` any embed tab of the path matches.
 */
export function isFileTab(t: TabEntry, path: string, viewer?: InternalViewer): boolean {
  if (t.kind !== "embed" || !t.embedPath) return false;
  if (viewer !== undefined && t.viewer !== viewer && !(viewer === "tex" && t.viewer === "texworkspace")) {
    return false;
  }
  return samePath(t.embedPath, path);
}

/** `isFileTab` as a predicate, for `tabs.find` and the `matches` argument of
 *  `openTabInScope` / `openTabInNewSubwindow`. */
export function fileTabMatcher(path: string, viewer?: InternalViewer): (t: TabEntry) => boolean {
  return (t) => isFileTab(t, path, viewer);
}
