import { invoke } from "@tauri-apps/api/core";
import { isDetachedWindow } from "./detachedContext";
import { hydrateScopeFromDisk, refreshWorkspaceScope, useTabsStore, type TabEntry } from "./tabs";
import { ASSISTANT_DEFAULT_MODEL, ASSISTANT_SCOPE, assistantCurrentModel, assistantNewChat, type AssistantLaunch } from "../lib/assistant";
import { useAssistantViewStore } from "./assistantView";
import { useOverlayAgentStore } from "./overlayAgent";
import { onTerminalExit, onTerminalReady } from "../lib/terminal/terminalBus";
import { IS_HOST_WINDOWS } from "../lib/platform";

/**
 * The **Tabby scope** in the tabs store: the chats of the assistant
 * (`docs/assistant_plan.md`), one agent tab each, in `tabsByScope.assistant`.
 *
 * Like the root console's scope (`stores/rootOverlay`) it is reached as an
 * overlay and never switched to: opening it must not change `activeId` or the
 * store's `scope`. Its tabs persist under `sessions/assistant/` (the backend
 * keeps only agent tabs whose `assistant` launch validates), their PTYs are
 * owned by `CenterPanel`'s keep-alive pane layer, and the overlay draws
 * attach-only views of them (`AttachedAgentPane`) — closing it ends nothing.
 *
 * This module is the scope's door for everything that is not a pane: restore,
 * mounting a chat the backend just made, the persist host's helper.
 */

/**
 * Restore the scope's saved chats on its first use this session. The overlay
 * never switches scope, so it asks for itself (the root console's pattern).
 * `createEmptyScope` marks a scope with nothing saved as hydrated, so the
 * persist host may write it — an absent key reads as "never hydrated" and
 * every save is skipped. Resolves true when the scope is hydrated.
 *
 * In a popout the store owns no tabs: nothing is hydrated there.
 */
export async function ensureAssistantScopeHydrated(): Promise<boolean> {
  const hydrated = () =>
    Object.prototype.hasOwnProperty.call(useTabsStore.getState().tabsByScope, ASSISTANT_SCOPE);
  if (isDetachedWindow()) return false;
  if (hydrated()) return true;
  // The cwd is the chat's own folder, kept from the saved tab and rewritten by
  // the backend at the spawn; there is no scope-wide default. (Its boolean
  // answer is "had chats"; with `createEmptyScope` the key exists either way.)
  await hydrateScopeFromDisk(ASSISTANT_SCOPE, "", { createEmptyScope: true }).catch(() => false);
  return hydrated();
}

// A chat's process ends with its CLI: the pane runs the pinned line and nothing
// after it (no login shell, which would be outside the fence), and the tmux
// session goes with it. Every started chat watches its PTY so a chat that
// quit can be started again (`startAssistantChat`), here or from the phone.
const endWatches = new Map<string, () => void>();

function watchChatEnd(key: string): void {
  if (endWatches.has(key)) return;
  const ptyId = `${ASSISTANT_SCOPE}:${key}`;
  const { markAssistantEnded } = useOverlayAgentStore.getState();
  const offExit = onTerminalExit(ptyId, () => markAssistantEnded(key, true));
  const offReady = onTerminalReady(ptyId, () => markAssistantEnded(key, false));
  endWatches.set(key, () => {
    offExit();
    offReady();
  });
}

/** Stop watching a chat that was deleted (its pane is gone with it). */
export function forgetAssistantChat(key: string): void {
  endWatches.get(key)?.();
  endWatches.delete(key);
  useOverlayAgentStore.getState().markAssistantEnded(key, false);
}

/**
 * Let the chat's CLI run. Hydrating the scope restores chats as records only
 * (`CenterPanel` mounts the pane that owns a PTY just for started chats), so
 * the CLI of a restored chat starts when this is called: the overlay calls it
 * for the chat it shows, and `mountAssistantChat` / `addTabToAssistant` call it
 * for a chat that was just made. A chat started earlier whose CLI has since
 * quit is started again (the same pane respawns its PTY; the backend resumes
 * the conversation), so the phone opening such a chat, or the overlay's Restart,
 * brings it back. Otherwise idempotent; never ends a running chat.
 */
export function startAssistantChat(key: string): void {
  const store = useOverlayAgentStore.getState();
  if (store.assistantStartedKeys.has(key) && store.assistantEndedKeys.has(key)) {
    store.markAssistantEnded(key, false);
    useTabsStore.getState().relaunchTabInScope(ASSISTANT_SCOPE, key, []);
    return;
  }
  watchChatEnd(key);
  store.markAssistantStarted(key);
}

/** How long a model switch waits for the old CLI to exit once its tmux session
 *  is ended. */
const SWITCH_EXIT_WAIT_MS = 3_000;

/**
 * Switch a running chat to `model` in place: the same tab, conversation and
 * folder, its CLI restarted on the new model. A chat's slash commands are off,
 * so the CLI's own `/model` cannot do it. The tab's launch (and, for a local
 * model, its label) is rewritten, its tmux session ended (a session left
 * running would only be reattached), and the pane respawns: the backend builds
 * the line from the launch and resumes the conversation (Claude `--resume`,
 * Codex `resume`, OpenCode and local Claude `--continue`). `ASSISTANT_DEFAULT_MODEL`
 * launches it with no model. Resolves false when nothing was switched (no such
 * chat, the same model, the session would not end).
 */
export async function switchAssistantModel(key: string, model: string): Promise<boolean> {
  const tab = assistantTabs().find((c) => c.key === key);
  const launch = tab?.assistant;
  if (!tab || !launch || !model || assistantCurrentModel(launch) === model) return false;
  if (tab.tmuxSession && !IS_HOST_WINDOWS) {
    // The old CLI's exit is waited for, so it lands before the respawn and not
    // on the new one (the chat would read as ended while it runs).
    let off = () => {};
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SWITCH_EXIT_WAIT_MS);
      off = onTerminalExit(`${ASSISTANT_SCOPE}:${key}`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      await invoke("local_tmux_kill", { session: tab.tmuxSession });
      await exited;
    } catch {
      return false;
    } finally {
      off();
    }
  }
  // A local chat's label names its model (`assistant::new_chat_record`: "<CLI> · <model>").
  const named = launch.model ? ` · ${launch.model}` : "";
  const label = named && tab.label.endsWith(named) ? `${tab.label.slice(0, -named.length)} · ${model}` : tab.label;
  const next = model === ASSISTANT_DEFAULT_MODEL && launch.cli === "claude" ? { cli: launch.cli } : { ...launch, model };
  useTabsStore.getState().relaunchTabInScope(ASSISTANT_SCOPE, key, [], { label, assistant: next });
  useOverlayAgentStore.getState().markAssistantEnded(key, false);
  return true;
}

/** The scope's chat tabs, in the order the scope holds them (oldest first). */
export function assistantTabs(): readonly TabEntry[] {
  return useTabsStore.getState().tabsByScope[ASSISTANT_SCOPE] ?? [];
}

/** The chat whose shared id is `tabId` (`assistant_new_chat`'s `tabId`). */
export function assistantTabById(tabId: string): TabEntry | undefined {
  return assistantTabs().find((tab) => tab.id === tabId);
}

/**
 * The chat tab for `tabId`, mounted in the store: the one door for a chat the
 * backend made (`assistant_new_chat`). The scope is hydrated first when this
 * is its first use (a created tab arriving at an unhydrated scope is only
 * picked up by the hydrate), then the `workspace:patch` the command emitted is
 * waited for by re-reading the stored set when the tab is not there yet
 * (`refreshWorkspaceScope`; whichever of the two lands first mounts the tab,
 * the other finds it held). Resolves null when the tab is not in the stored
 * set (closed meanwhile) or in a popout.
 *
 * Does NOT activate the chat anywhere: showing it is `revealAssistantChat`.
 * It does let the chat's CLI start (`startAssistantChat`).
 */
export async function mountAssistantChat(tabId: string): Promise<TabEntry | null> {
  if (!(await ensureAssistantScopeHydrated())) return null;
  await refreshIfMissing(tabId);
  const tab = assistantTabById(tabId) ?? null;
  // Mounting is asking for the chat to run (a new chat, the phone opening one).
  if (tab) startAssistantChat(tab.key);
  return tab;
}

/**
 * A fresh chat on `launch`, selected in the Tabby view, and every other chat
 * of the scope removed, so the scope holds the one chat both surfaces show:
 * the view's Relaunch and CLI pick, and the Reader's Clear in a chat (its
 * slash commands are off, so `/clear` never reaches the CLI). Resolves null
 * when the new chat was gone before it mounted; a refused
 * `assistant_new_chat` rejects.
 */
export async function replaceAssistantChat(launch: AssistantLaunch): Promise<TabEntry | null> {
  // The scope first: a created tab arriving at an unhydrated scope is only
  // picked up by the hydrate (the restored chats would then be missed).
  await ensureAssistantScopeHydrated();
  const made = await assistantNewChat(launch.cli, launch.model);
  const tab = await mountAssistantChat(made.tabId);
  if (!tab) return null;
  useAssistantViewStore.getState().select(tab.key);
  for (const old of assistantTabs().filter((c) => c.key !== tab.key)) deleteAssistantChat(old);
  return tab;
}

/** Like closing any tab: the pane unmounts and its PTY is reaped. The persist
 *  host saves the shorter list. */
function deleteAssistantChat(chat: TabEntry): void {
  useAssistantViewStore.getState().forget(chat.key);
  forgetAssistantChat(chat.key);
  useTabsStore.getState().removeTabInScope(ASSISTANT_SCOPE, chat.key);
}

async function refreshIfMissing(tabId: string): Promise<void> {
  if (assistantTabById(tabId)) return;
  await refreshWorkspaceScope(ASSISTANT_SCOPE).catch(() => {});
}

/** Make `key` the active tab of its group in the scope (a no-op for a key the
 *  scope does not hold). Never touches `activeId` or the store's `scope`. */
export function revealAssistantChat(key: string): boolean {
  return useTabsStore.getState().revealTabInScope(ASSISTANT_SCOPE, key);
}

/**
 * Open `spec` as a chat tab in the scope — the frontend add path, for a chat
 * the backend did not make (the backend's own `assistant_new_chat` is the
 * normal door: it builds the record, and `mountAssistantChat` mounts it). The
 * spec must carry the `assistant` launch and the chat's `sessionId`; the
 * scope is restored first on its first use (an add to an unhydrated scope
 * would create the key and the first persist would write the lone new tab
 * over the saved chats). `onOpened` runs synchronously when the scope is
 * already hydrated, after the restore otherwise. In a popout the add is
 * forwarded to the main window.
 */
export function addTabToAssistant(
  spec: Omit<TabEntry, "key">,
  onOpened?: (tab: TabEntry) => void,
): void {
  const add = () => {
    const tab = useTabsStore.getState().addTabToScope(ASSISTANT_SCOPE, spec);
    startAssistantChat(tab.key);
    onOpened?.(tab);
  };
  if (isDetachedWindow() || ASSISTANT_SCOPE in useTabsStore.getState().tabsByScope) {
    add();
    return;
  }
  void ensureAssistantScopeHydrated().then(add);
}
