import { isDetachedWindow } from "./detachedContext";
import { hydrateScopeFromDisk, refreshWorkspaceScope, useTabsStore, type TabEntry } from "./tabs";
import { ASSISTANT_SCOPE } from "../lib/assistant";

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
 */
export async function mountAssistantChat(tabId: string): Promise<TabEntry | null> {
  if (!(await ensureAssistantScopeHydrated())) return null;
  const held = assistantTabById(tabId);
  if (held) return held;
  await refreshWorkspaceScope(ASSISTANT_SCOPE).catch(() => {});
  return assistantTabById(tabId) ?? null;
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
    onOpened?.(tab);
  };
  if (isDetachedWindow() || ASSISTANT_SCOPE in useTabsStore.getState().tabsByScope) {
    add();
    return;
  }
  void ensureAssistantScopeHydrated().then(add);
}
