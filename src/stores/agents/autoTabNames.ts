import { firstPromptTabName, holdsAutoLabel } from "../../lib/agents/autoTabName";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { useSettingsStore } from "../settings";
import { useTabsStore } from "../tabs";
import { useAgentModelsStore } from "./agentModels";

/**
 * The naming half of "agent tabs named by their task"
 * (`lib/agents/autoTabName`). It reads no transcript of its own: it follows
 * the prompts `agentModels` already reads at every turn's start and end —
 * whatever route a prompt took (typed, the Reader's composer, the phone, a
 * schedule) — and gives a tab that still holds the label Tabtivity gave it
 * the name of its first prompt, once.
 *
 * A `/clear` starts a new conversation in the same tab (`noteAutoNameRoll`):
 * a tab still carrying its automatic name is named again by the first prompt
 * of the new one — a resumed or restored tab too, which opened unarmed, while
 * its label is its CLI's own. The prompts read before the clear are its baseline — a read
 * still pointed at the cleared conversation brings nothing new. In memory
 * only: a relaunch before the next prompt simply keeps the old name.
 *
 * Main window only (`AppShell`): the one heap that owns every tab, popouts'
 * included, so a name is written once.
 */

/** Prompts of the conversation a `/clear` ended, per composed PTY id. */
const clearedPrompts = new Map<string, Set<string>>();

const promptKey = (text: string, at = "") => `${at}\u0000${text}`;

/** The prompts this store knows for `ptyId`, as baseline keys. */
function knownPromptKeys(ptyId: string): Set<string> {
  const state = useAgentModelsStore.getState();
  const keys = new Set<string>();
  for (const prompt of state.recentByTab[ptyId] ?? []) keys.add(promptKey(prompt.text, prompt.at));
  const last = state.promptByTab[ptyId];
  if (last) keys.add(promptKey(last));
  return keys;
}

/** Whether the user left task names on (Settings → Agents; on by default). */
function autoNamesOn(): boolean {
  return useSettingsStore.getState().settings?.agent_tab_auto_name !== false;
}

/** The prompts that may name `ptyId`, oldest first: the timed tail where the
 *  transcript has one, else the one line the screen echo found. */
function namingPrompts(ptyId: string, baseline: Set<string> | undefined): string[] {
  const state = useAgentModelsStore.getState();
  const recent = state.recentByTab[ptyId];
  if (recent?.length) {
    return recent.filter((prompt) => !baseline?.has(promptKey(prompt.text, prompt.at))).map((prompt) => prompt.text);
  }
  const last = state.promptByTab[ptyId];
  return last && !baseline?.has(promptKey(last)) ? [last] : [];
}

/** Name `ptyId`'s tab from its prompts, when it is waiting for a name. */
export function autoNameTab(ptyId: string): void {
  if (!autoNamesOn()) return;
  const parts = splitPtyId(ptyId);
  if (!parts) return;
  const tab = useTabsStore.getState().tabsByScope[parts.scope]?.find((entry) => entry.key === parts.key);
  if (!tab || !holdsAutoLabel(tab)) {
    clearedPrompts.delete(ptyId);
    return;
  }
  const baseline = clearedPrompts.get(ptyId);
  if (tab.autoNamed && !baseline) return;
  const name = firstPromptTabName(namingPrompts(ptyId, baseline));
  if (!name) return;
  clearedPrompts.delete(ptyId);
  useTabsStore.getState().autoNameTabInScope(parts.scope, parts.key, name);
}

/** A tab's session (re)started (`agent-session-roll`): after a `/clear`, a
 *  tab still carrying its automatic name — or its CLI's own, when it opened
 *  unarmed — waits for the new conversation's first prompt. */
export function noteAutoNameRoll(ptyId: string, source: string): void {
  if (source !== "clear" || !autoNamesOn()) return;
  const parts = splitPtyId(ptyId);
  // A tab that opened unarmed (resumed, restored) is armed by the clear while
  // its label is still its CLI's name (`autoLabelOnClear`).
  if (!parts || !useTabsStore.getState().armAutoLabelInScope(parts.scope, parts.key)) return;
  clearedPrompts.set(ptyId, knownPromptKeys(ptyId));
}

/** Follow the prompt reads; returns the unsubscribe. */
export function startAutoTabNames(): () => void {
  return useAgentModelsStore.subscribe((state, prev) => {
    if (state.recentByTab === prev.recentByTab && state.promptByTab === prev.promptByTab) return;
    const changed = new Set<string>();
    for (const ptyId of Object.keys(state.recentByTab)) {
      if (state.recentByTab[ptyId] !== prev.recentByTab[ptyId]) changed.add(ptyId);
    }
    for (const ptyId of Object.keys(state.promptByTab)) {
      if (state.promptByTab[ptyId] !== prev.promptByTab[ptyId]) changed.add(ptyId);
    }
    for (const ptyId of changed) autoNameTab(ptyId);
  });
}

/** Test seam. */
export function _resetAutoTabNamesForTest(): void {
  clearedPrompts.clear();
}
