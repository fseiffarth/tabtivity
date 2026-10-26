import { PROJECT_FILES_TAB_CMD, useTabsStore } from "../../stores/tabs";
import type { TranslationKey } from "../i18n";
import { openTabInScope } from "./tabScopeContext";

/**
 * Open a Files (Project) tab on a folder — what the file tree's "Open in a new
 * tab" does, from the side panel and from another Files (Project) tab alike.
 * The tab lands in `scope` when given — the tree's own, which the root console's
 * file column needs (root is not the active scope while it floats) — else in the
 * store's current scope, i.e. the project the tree belongs to. Always labelled "Files (Project)" so it reads as this tab kind (not the
 * plain "Files" explorer) at a glance; the browsed folder shows in the tab's
 * own header instead (see `ProjectFilesView`'s header).
 */
export function openProjectFilesTab(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  cwd: string,
  folder: string,
  scope?: string,
) {
  const tab = {
    label: t("tabKind.projectfiles"),
    cmd: PROJECT_FILES_TAB_CMD,
    args: [],
    env: {},
    cwd,
    kind: "projectfiles" as const,
    folder,
  };
  if (scope) openTabInScope(scope, tab);
  else useTabsStore.getState().addTab(tab);
}
