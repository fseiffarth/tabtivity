import { buildPreface } from "../agentPrefaces";
import type { TabEntry } from "../../../stores/tabs";
import type { CustomAgent, Settings } from "../../../types";
import { AGENT_ITEMS, buildStaticTabSpec, customAgentToItem, type StaticMenuItem } from "../../../components/tabs/newTabItems";
import type { TranslationKey } from "../../i18n";

/**
 * A prompt-chart draft with no tab of its own goes to a NEW agent tab. The
 * chart's toolbar names the agent that tab runs and the model it is told to
 * use; both are settings (`prompt_chart_agent`, `prompt_chart_model`), so
 * every window and project shares one answer, with the 🧠 menu's default
 * agent behind an unset one.
 */
export function promptChartNewTabAgent(settings: Pick<Settings, "prompt_chart_agent" | "default_agent_cmd"> | null | undefined): string {
  return settings?.prompt_chart_agent?.trim() || settings?.default_agent_cmd?.trim() || "claude";
}

/** The menu item a bare agent command launches as: a built-in, a custom
 *  agent, or — for a command neither list knows — the command itself. */
export function agentItemFor(cmd: string, customAgents: readonly CustomAgent[] = []): StaticMenuItem {
  const builtin = AGENT_ITEMS.find((item) => item.cmd === cmd);
  if (builtin) return builtin;
  const custom = customAgents.find((agent) => agent.cmd === cmd);
  if (custom) return customAgentToItem(custom);
  return { label: cmd, cmd, kind: "agent" };
}

/**
 * The tab a draft's "New agent tab" opens, and the preface its prompt is
 * queued with. The tab spec is the "+" menu's own (`buildStaticTabSpec`), so
 * the tab is exactly what that menu would have opened — session id minted,
 * `TABTIVITY_TAB_UID` set — plus a schedule target id minted HERE, so the prompt
 * can be queued at the tab before the store has assigned one. The model is
 * typed as the agent's own `/model` ahead of the prompt, never a launch flag
 * (see `lib/agents/agentPrefaces`).
 */
export function newAgentTabForDraft(input: {
  agent: string;
  model?: string;
  customAgents?: readonly CustomAgent[];
  cwd: string;
  projectName: string;
  t: (key: TranslationKey) => string;
}): { tab: Omit<TabEntry, "key"> & { scheduleTargetId: string }; preface: string[] } {
  const item = agentItemFor(input.agent, input.customAgents);
  const spec = buildStaticTabSpec(item, input.cwd, input.projectName, input.t);
  return {
    tab: { ...spec, scheduleTargetId: crypto.randomUUID() },
    preface: buildPreface([], [], input.model),
  };
}
