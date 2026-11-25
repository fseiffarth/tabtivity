/**
 * Steering's agent keys on the tab level — the desktop half of the phone
 * composer's Clear / Plan / Goal chips, acting on the focused pane's active
 * agent tab.
 *
 *  - Clear submits `/clear` the way a scheduled prefix command goes in
 *    (`submitScheduledAgentCommand`), and offers "Undo clear" as a typed one
 *    does (`noteTypedClear`). Every agent CLI Tabtivity launches reads `/clear` as
 *    a new conversation (see the phone's `NEW_CONVERSATION_COMMAND`).
 *  - Plan / Goal open steering's prompt (the Chat composer, else the box) led with the command — the user
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
import { AGENT_LINE_RESET, agentDraftPrefixes, agentFamily } from "../../../shared/agentComposer";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { codexComposerFrame } from "../../../mobile-web/src/terminal/statusLine";
import {
  SessionPickerOpenError,
  pressScheduledAgentSubmit,
  scheduledAgentInput,
  sessionPickerOpen,
  submitScheduledAgentCommand,
  submitScheduledAgentMessage,
} from "../agents/scheduledAgentInput";
import { confirmFreshSubmit, freshClaude } from "../agents/freshSubmit";
import { noteSentPrompt } from "../agents/sentPrompts";
import { noteInputFrom } from "../agents/inputFrom";
import { useActivityStore } from "../../stores/activity";
import { agentTabLabel } from "../../stores/agents/agentModels";
import { noteTypedClear } from "../../stores/agents/agentClearUndo";
import { wakeStoppedForInput } from "../../stores/agents/agentTabStop";
import type { TabEntry } from "../../stores/tabs";
import { useKeyboardSteeringStore, type SteeringBaseLevel } from "../../stores/keyboardSteering";
import { steeringTabsActive } from "./steeringScope";
import { openReaderComposer } from "../agents/readerSteering";
import { terminalFor } from "../terminal/terminalRegistry";

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

/** The active tab of the focused pane steering walks — the workspace's, or Root's
 *  while the Root view is up (`steeringScope`). */
export function steeringActiveTab(): { scope: string; tab: TabEntry } | null {
  return steeringTabsActive();
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
    await wakeStoppedForInput(tab.scheduleTargetId);
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

/** Ask for a text box for `tab`, its text led with `lead`: the pane's own Chat
 *  composer when it shows one (steering hides it, this shows it again), else
 *  the prompt box over the window. False when the tab is not an agent, its CLI
 *  does not take `lead`, or neither answered. */
export function requestSteeringPrompt(
  scope: string,
  tab: TabEntry,
  level: SteeringBaseLevel,
  lead?: SteeringAgentCommand,
): boolean {
  if (!steeringAgentOffer(tab).prompt || (lead && !takesAgentCommand(tab, lead))) return false;
  if (openReaderComposer(`${scope}:${tab.key}`, level, lead)) return true;
  const detail: SteeringPromptDetail = { scope, tab, level, lead, handled: false };
  window.dispatchEvent(new CustomEvent<SteeringPromptDetail>(STEERING_PROMPT_EVENT, { detail }));
  return detail.handled;
}

/** How long a prompt waits for an agent pane that is still coming up. */
const START_WAIT_MS = 15_000;
const START_POLL_MS = 200;

/** Codex's Ctrl+A/Ctrl+K only clears the caret's line. A multiline draft
 * needs one kill for each line and each newline, in both directions. */
function codexDraftReset(ptyId: string): string | undefined {
  const term = terminalFor(ptyId);
  if (!term) return undefined;
  const buffer = term.buffer.active;
  const { lines } = readableScreen(buffer, term.rows, { plain: true });
  const frame = codexComposerFrame(lines);
  if (!frame) return undefined;
  const start = Number.parseInt(lines[frame.start].key.slice(1), 10);
  const last = Number.parseInt(lines[frame.footer].key.slice(1), 10) - 2;
  const caret = buffer.baseY + buffer.cursorY;
  if (last <= start || caret < start || caret > last) return undefined;
  return AGENT_LINE_RESET + "\u000b".repeat(2 * (last - caret)) + "\u0015".repeat(2 * (caret - start));
}

/**
 * Submit `text` into the agent tab as one prompt — also while the agent works,
 * as a prompt typed into its CLI then would be (the CLI queues it), and once
 * the pane is up when it is still starting. Throws when it did not go in (no
 * schedule binding, no pane in this window, a pane that never came up, nothing
 * left after sanitizing) — the box keeps the text and shows why.
 */
export async function sendSteeringPrompt(tab: TabEntry, text: string): Promise<void> {
  if (!steeringAgentOffer(tab).prompt || !tab.scheduleTargetId) throw new Error("not an agent tab");
  const { active, handedTo } = useKeyboardSteeringStore.getState();
  const steering = active || handedTo === "prompt";
  const target = tab.scheduleTargetId;
  // A picker up in the CLI would take the words as its own keys, and the
  // agent never see them: refuse at once rather than wait for it to go.
  if (sessionPickerOpen(target)) throw new SessionPickerOpenError();
  // A stopped tab (`agentTabStop`) has no pane to type into until it wakes.
  await wakeStoppedForInput(target);
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    const input = scheduledAgentInput(target);
    if (!input || (input.started ?? input.ready)() || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  const input = scheduledAgentInput(target);
  // A Claude still starting can take the Enter as a newline or drop it
  // (`freshSubmit.ts`); a slash command begins no turn for a hook to confirm.
  const fresh = !!input && freshClaude(input.agent, input.ptyId) && !text.trimStart().startsWith("/");
  const since = Date.now();
  const draftReset = steering && input && agentFamily(input.agent ?? tab.cmd) === "codex" ? codexDraftReset(input.ptyId) : undefined;
  await submitScheduledAgentMessage(target, text, { whileBusy: true, draftReset });
  noteSentPrompt(target, text);
  const ptyId = scheduledAgentInput(target)?.ptyId;
  if (ptyId) noteInputFrom(ptyId, "desktop");
  if (fresh && input) {
    void confirmFreshSubmit(
      input.ptyId,
      since,
      () => pressScheduledAgentSubmit(target),
      () => scheduledAgentInput(target) === input,
    );
  }
}
