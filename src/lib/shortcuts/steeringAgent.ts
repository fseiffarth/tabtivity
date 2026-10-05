/**
 * Steering's agent keys on the tab level — the desktop half of the phone
 * composer's Clear / Plan / Goal chips, acting on the focused pane's active
 * agent tab.
 *
 *  - Clear submits `/clear` the way a scheduled prefix command goes in
 *    (`submitScheduledAgentCommand`), and offers "Undo clear" as a typed one
 *    does (`noteTypedClear`). Every agent CLI Tabtivity launches reads `/clear` as
 *    a new conversation (see the phone's `NEW_CONVERSATION_COMMAND`).
 *  - Plan / Goal open steering's prompt box led with the command — the user
 *    writes the rest and sends it themselves, as with the chips, and steering
 *    comes back after. Offered only to the CLIs that document them
 *    (`agentDraftPrefixes`).
 *
 * None of them leaves the mode: the keyboard stays with steering, or comes
 * back to it once the box is done.
 *
 * Tabtivity chooses nothing here: each key types what the user could have typed
 * into the agent's own CLI (AGENTS.md, agent authority).
 */
import { agentDraftPrefixes, agentFamily } from "../../../shared/agentComposer";
import {
  scheduledAgentInput,
  submitScheduledAgentCommand,
  submitScheduledAgentMessage,
} from "../agents/scheduledAgentInput";
import { noteSentPrompt } from "../agents/sentPrompts";
import { useActivityStore } from "../../stores/activity";
import { agentTabLabel } from "../../stores/agents/agentModels";
import { noteTypedClear } from "../../stores/agents/agentClearUndo";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { SteeringBaseLevel } from "../../stores/keyboardSteering";

/** What the Clear key types. */
const NEW_CONVERSATION_COMMAND = "/clear";

export type SteeringAgentCommand = "/plan" | "/goal";

/** Which agent keys the tab takes: none for a tab that is not an agent. */
export interface SteeringAgentOffer {
  clear: boolean;
  plan: boolean;
  goal: boolean;
  prompt: boolean;
}

const NONE: SteeringAgentOffer = { clear: false, plan: false, goal: false, prompt: false };

function isAgentTab(tab: TabEntry | null | undefined): tab is TabEntry {
  return !!tab && (tab.kind === "agent" || tab.kind === "local_agent");
}

export function steeringAgentOffer(tab: TabEntry | null | undefined): SteeringAgentOffer {
  if (!isAgentTab(tab)) return NONE;
  const prefixes = agentDraftPrefixes(agentFamily(agentTabLabel(tab)));
  return { clear: true, plan: prefixes.includes("/plan"), goal: prefixes.includes("/goal"), prompt: true };
}

/** The active tab of the active scope — the one the focused pane shows. */
export function steeringActiveTab(): { scope: string; tab: TabEntry } | null {
  const s = useTabsStore.getState();
  const tab = s.activeKey ? s.tabs.find((t) => t.key === s.activeKey) : undefined;
  return tab ? { scope: s.scope, tab } : null;
}

/**
 * `/clear` into the tab. False when it did not go in: not an agent tab, the
 * pane not ready for input, or Codex at work (it answers "disabled while a task
 * is in progress" and keeps the conversation, so no undo is offered either).
 */
export async function clearAgentTab(scope: string, tab: TabEntry): Promise<boolean> {
  if (!steeringAgentOffer(tab).clear || !tab.scheduleTargetId) return false;
  const ptyId = `${scope}:${tab.key}`;
  const busy = !!useActivityStore.getState().busyByTab[ptyId];
  if (agentFamily(agentTabLabel(tab)) === "codex" && busy) return false;
  try {
    await submitScheduledAgentCommand(tab.scheduleTargetId, NEW_CONVERSATION_COMMAND);
  } catch {
    return false;
  }
  noteTypedClear(ptyId, busy);
  return true;
}

/** Whether the tab's CLI takes `command`. */
export function takesAgentCommand(tab: TabEntry | null | undefined, command: SteeringAgentCommand): boolean {
  const offer = steeringAgentOffer(tab);
  return command === "/plan" ? offer.plan : offer.goal;
}

/** What `requestSteeringPrompt` sends: the tab the text goes to, the steering
 *  level to come back to, the command the text starts with (Plan / Goal), and
 *  whether a prompt box answered. */
export interface SteeringPromptDetail {
  scope: string;
  tab: TabEntry;
  level: SteeringBaseLevel;
  lead?: SteeringAgentCommand;
  handled: boolean;
}

/** The prompt box's opening text: a kept draft led with `lead`, a Plan / Goal
 *  lead it already had swapped for the new one (never `/goal /plan …`). */
export function ledDraft(draft: string, lead: SteeringAgentCommand | undefined): string {
  if (!lead) return draft;
  return `${lead} ${draft.replace(/^\/(?:plan|goal)(?:\s+|$)/u, "")}`;
}

/** Window event the `SteeringPromptOverlay` answers by opening its text box. */
export const STEERING_PROMPT_EVENT = "app:steering-prompt";

/** Ask the prompt box to open for `tab`, its text led with `lead`; false when
 *  the tab is not an agent, its CLI does not take `lead`, or no box is
 *  mounted. */
export function requestSteeringPrompt(
  scope: string,
  tab: TabEntry,
  level: SteeringBaseLevel,
  lead?: SteeringAgentCommand,
): boolean {
  if (!steeringAgentOffer(tab).prompt || (lead && !takesAgentCommand(tab, lead))) return false;
  const detail: SteeringPromptDetail = { scope, tab, level, lead, handled: false };
  window.dispatchEvent(new CustomEvent<SteeringPromptDetail>(STEERING_PROMPT_EVENT, { detail }));
  return detail.handled;
}

/** How long a prompt waits for an agent pane that is still coming up. */
const START_WAIT_MS = 15_000;
const START_POLL_MS = 200;

/**
 * Submit `text` into the agent tab as one prompt — also while the agent works,
 * as a prompt typed into its CLI then would be (the CLI queues it), and once
 * the pane is up when it is still starting. Throws when it did not go in (no
 * schedule binding, no pane in this window, a pane that never came up, nothing
 * left after sanitizing) — the box keeps the text and shows why.
 */
export async function sendSteeringPrompt(tab: TabEntry, text: string): Promise<void> {
  if (!steeringAgentOffer(tab).prompt || !tab.scheduleTargetId) throw new Error("not an agent tab");
  const target = tab.scheduleTargetId;
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    const input = scheduledAgentInput(target);
    if (!input || (input.started ?? input.ready)() || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  await submitScheduledAgentMessage(target, text, { whileBusy: true });
  noteSentPrompt(target, text);
}
