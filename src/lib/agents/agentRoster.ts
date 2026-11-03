import type { TabEntry } from "../../stores/tabs";
import { agentTabStateOf, agentTurnStartedAt, lastTabReadAt, useActivityStore, type AttentionKind } from "../../stores/activity";
import { agentTabModelTag, tabModeMarks, useAgentModelsStore } from "../../stores/agents/agentModels";
import { mobileSubagentCount } from "../mobileSubagents";
import type { MobileAgentState } from "../mobileAgentTurns";

/**
 * One agent tab's roster facts — what every cross-project list of agent tabs
 * shows per row: the phone's Agents list and Needs you (through the mobile
 * bridge) and the desktop cockpit. One derivation, so the two screens can
 * never give one tab two answers.
 *
 * Keyed by PTY id (`<scope>:<tab key>`). Which tabs a surface lists is the
 * surface's own rule (the phone's Mobile access, the cockpit's every scope);
 * this module only says what one tab is doing.
 */

export type AgentRosterState = MobileAgentState;

/** The activity readings {@link deriveAgentRosterState} weighs, for one tab. */
export interface AgentStateFacts {
  busy: boolean;
  attention: AttentionKind | undefined;
  /** When the tab's last turn finished (`lastDoneByTab`). */
  lastDoneAt: number | undefined;
  /** When the user last arrived at the tab (`lastTabReadAt`). */
  lastReadAt: number | undefined;
}

/**
 * What one agent tab is doing, in precedence order: the desktop's own lamps
 * first (working, a decision, a turn the user cut off, unread output), then a
 * finished turn nobody has *arrived at* since.
 *
 * That last answer is the one `attentionByTab` cannot give: its flag means
 * UNREAD output and is deliberately never raised for the tab under the user's
 * eyes — but "under the user's eyes" is only "it is the visible tab of its
 * group", which an unattended desktop satisfies all night. A list asking "did
 * anything finish?" would then be told no, forever, about precisely the tab
 * its owner left open. So a finished turn nobody has arrived at since
 * (`lastTabReadAt`, moved by a tab switch here or by the phone opening the
 * tab) is reported as done on its own evidence.
 */
export function deriveAgentRosterState(facts: AgentStateFacts): AgentRosterState {
  const live = agentTabStateOf(
    { busyByTab: { t: facts.busy }, attentionByTab: facts.attention ? { t: facts.attention } : {} },
    "t",
  );
  if (live !== "idle") return live;
  if (facts.attention === "interrupted") return "interrupted";
  if (facts.attention === "done") return "done";
  if (facts.lastDoneAt !== undefined && facts.lastDoneAt > (facts.lastReadAt ?? 0)) return "done";
  return "idle";
}

/** {@link deriveAgentRosterState} on the activity store as it is now. */
export function agentRosterState(ptyId: string): AgentRosterState {
  const activity = useActivityStore.getState();
  return deriveAgentRosterState({
    busy: !!activity.busyByTab[ptyId],
    attention: activity.attentionByTab[ptyId],
    lastDoneAt: activity.lastDoneByTab[ptyId],
    lastReadAt: lastTabReadAt(ptyId),
  });
}

/** An agent tab as a roster counts one: a local-model tab is one too — the
 * phone's catalog lists it as `agent` (`services::mobile_control::discovery`). */
export function isRosterAgentKind(kind: TabEntry["kind"]): boolean {
  return kind === "agent" || kind === "local_agent";
}

/** The model tag a roster row shows for `tab`, with both of its sources asked
 * to re-read (the model store throttles its own re-reads), so a polling list
 * is at most one poll behind, never wrong. The model is read off the live
 * tmux pane first (`agentTabModelTag`). */
export function rosterModelTag(scope: string, tab: TabEntry): string | undefined {
  const models = useAgentModelsStore.getState();
  void models.refresh(scope, tab);
  void models.refreshScreen(scope, tab);
  return agentTabModelTag(scope, tab, models.byTab, models.screenByTab);
}

/** Everything a roster row says about one agent tab. Optional fields are
 * absent, never zero or false-y placeholders: a reading not taken is not a
 * reading of nothing. */
export interface AgentRosterFacts {
  ptyId: string;
  state: AgentRosterState;
  model?: string;
  plan?: boolean;
  goal?: boolean;
  /** Subagents at work, only when some are. */
  subagents?: number;
  /** When the tab was last seen working — `now` while it is (or while a
   *  subagent works on past the Stop, `turnDuration`'s rule). */
  workingAt?: number;
  doneAt?: number;
  turnStartedAt?: number;
}

/**
 * The roster facts of one agent tab of `scope`, read off the stores at `now`.
 * The model and PLAN / GOAL marks are read in that order: the model tag's
 * screen re-read refreshes the marks too. `reread: false` reads what the model
 * store holds without asking it to re-read — for a caller that derives in
 * render and asks on its own clock (the cockpit).
 */
export function agentRosterFacts(
  scope: string,
  tab: TabEntry,
  now: number,
  { reread = true }: { reread?: boolean } = {},
): AgentRosterFacts {
  const ptyId = `${scope}:${tab.key}`;
  const activity = useActivityStore.getState();
  const state = agentRosterState(ptyId);
  const facts: AgentRosterFacts = { ptyId, state };
  const models = useAgentModelsStore.getState();
  const model = reread ? rosterModelTag(scope, tab) : agentTabModelTag(scope, tab, models.byTab, models.screenByTab);
  if (model) facts.model = model;
  const marks = tabModeMarks(useAgentModelsStore.getState(), ptyId);
  if (marks?.plan) facts.plan = true;
  if (marks?.goal) facts.goal = true;
  const subagents = mobileSubagentCount(scope, tab, now);
  if (subagents) facts.subagents = subagents;
  // Subagents at work past the Stop keep the turn going (`turnDuration`).
  const workingAt = state === "working" || subagents ? now : activity.lastWorkingByTab[ptyId];
  if (workingAt !== undefined) facts.workingAt = workingAt;
  const doneAt = activity.lastDoneByTab[ptyId];
  if (doneAt !== undefined) facts.doneAt = doneAt;
  const turnStartedAt = agentTurnStartedAt(ptyId);
  if (turnStartedAt !== undefined) facts.turnStartedAt = turnStartedAt;
  return facts;
}
