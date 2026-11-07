import { invoke } from "@tauri-apps/api/core";

import { isLinkable, openPathLink } from "../terminal/pathLinks";
import { jumpToTab } from "../shortcuts/tabJump";
import { isDetachedWindow } from "../../stores/detachedContext";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import type { FileEntry, InternalViewer } from "../viewers/fileUtils";
import type { TranslationKey } from "../i18n";

/** The host's answer to a click on a listed result (`cockpit_result_target`). */
export type ResultTarget =
  | { status: "open"; entry: FileEntry; projectDir: string }
  | { status: "unavailable" | "refused" | "stale" };

/** What a click came to: opened, or why nothing was. */
export type ResultOutcome = "opened" | "unavailable" | "refused" | "stale" | "noViewer";

/**
 * Open result `index` of an agent tab's listed results — only ever from a click.
 * The host judges the *saved* reference again against the project folder
 * (a file replaced by a link out of it since the agent listed it is refused):
 * the window sends the scope, the saved tab id, the index and the revision it
 * drew, never a path. The file then opens through the ordinary path-link
 * route, an in-app viewer tab in the tab's own scope with a Back button to the
 * agent tab, and the window shows it.
 */
export async function openCockpitResult(
  row: { scope: { id: string }; tab: Pick<TabEntry, "id" | "key" | "cwd" | "cockpitMeta"> },
  index: number,
  ctx: { t: (key: TranslationKey) => string; disabled?: ReadonlySet<InternalViewer> },
): Promise<ResultOutcome> {
  const { id: tabId, cockpitMeta } = row.tab;
  if (!tabId || !cockpitMeta) return "unavailable";
  let target: ResultTarget;
  try {
    target = await invoke<ResultTarget>("cockpit_result_target", { scope: row.scope.id, tabId, index, revision: cockpitMeta.revision });
  } catch {
    return "unavailable";
  }
  if (target.status !== "open") return target.status;
  const { entry, projectDir } = target;
  if (!isLinkable(entry, projectDir, ctx.disabled)) return "noViewer";
  const scope = row.scope.id;
  openPathLink(entry, {}, { scope, projectId: scope, projectDir, cwd: row.tab.cwd, disabled: ctx.disabled, t: ctx.t, fromTab: row.tab.key });
  // Show what opened: its viewer tab if it can be found, else the agent's own.
  const state = useTabsStore.getState();
  const tabs = scope === state.scope ? state.tabs : (state.tabsByScope[scope] ?? []);
  const opened = tabs.find((tab) => tab.kind === "embed" && tab.embedPath === entry.path);
  jumpToTab(scope, opened?.key ?? row.tab.key);
  if (scope !== ROOT_SCOPE || isDetachedWindow()) useRootOverlayStore.getState().close();
  return "opened";
}
