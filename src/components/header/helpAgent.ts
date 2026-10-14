import { invoke } from "@tauri-apps/api/core";
import type { CustomAgent } from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import { vibeLocalTabSpec } from "../../lib/agents/localTabSpec";
import { onTerminalExit, onTerminalReady } from "../../lib/terminal/terminalBus";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { openTabInRootConsole, useRootOverlayStore } from "../../stores/rootOverlay";
import {
  agentShortcutSlots,
  buildStaticTabSpec,
  enabledInstalledAgentBins,
  type BuiltInAgentStatus,
  type StaticMenuItem,
} from "../tabs/newTabItems";

/**
 * The header's help button (`HelpAgentButton`): an agent that answers
 * questions about the app from its own docs — the `{slug}-help` MCP server
 * every local agent tab is handed (`docs/context/help_mcp.md`).
 *
 * The agent opens as a ROOT tab in the root console, the floating subwindow
 * over whatever is open: no project folder is its cwd (a project folder is
 * attacker-controlled, and the help knows nothing about projects anyway), and
 * closing the console ends nothing. The 🧠 menu's "Root" chip is not consulted:
 * since the "MCP" chip became its own switch, Root only decides what the root
 * + menu offers — a root tab of an agent without the MCP chip gets no root
 * tools at spawn (`services::root_mcp::grant_root`), only the help lane every
 * local tab gets. So the user's default agent is the help agent wherever it
 * stands on those chips.
 */

/** What the help button opens. */
export type HelpAgentChoice =
  | { kind: "agent"; item: StaticMenuItem }
  | { kind: "localModel"; model: string }
  | { kind: "none" };

/** The CLIs named the help server when the backend does not say (`help_mcp::WIRED_CLIS`). */
const FALLBACK_WIRED_CLIS = ["claude", "codex"];
/** Mistral Vibe: a cloud agent of its own and the Local Model tab's runner. */
const VIBE_BIN = "vibe";

/**
 * Pick the help agent, pure: the default agent when it is installed and
 * enabled; else the first installed agent (+ menu order) whose CLI is named
 * the help server (`wiredClis`: it calls the tools unprompted); else the first
 * installed agent but Mistral; else the local model through Mistral Vibe;
 * else Mistral itself; else nothing — and the button shows how to install one.
 */
export function pickHelpAgent(opts: {
  installedBuiltins: Set<string>;
  installedCmds: Set<string>;
  customAgents: CustomAgent[];
  defaultAgentBin: string;
  wiredClis: readonly string[];
  localModel?: string;
  vibeInstalled: boolean;
}): HelpAgentChoice {
  // No saved order: the default agent leads, the rest follow in menu order.
  const rows = agentShortcutSlots(opts).filter(
    (row): row is NonNullable<typeof row> => row !== null,
  );
  const row =
    rows.find((r) => r.item.cmd === opts.defaultAgentBin) ??
    rows.find((r) => opts.wiredClis.includes(r.item.cmd)) ??
    // Vibe is also the Local Model tab's runner, so being installed says
    // little about a Mistral account: with a local model set it drives that
    // instead, unless the user made Mistral their default.
    rows.find((r) => r.item.cmd !== VIBE_BIN);
  if (row) return { kind: "agent", item: row.item };
  if (opts.localModel && opts.vibeInstalled) return { kind: "localModel", model: opts.localModel };
  if (rows[0]) return { kind: "agent", item: rows[0].item };
  return { kind: "none" };
}

/** Probe what is installed now and pick (`pickHelpAgent`). Asked on the click,
 *  so the header holds no probes of its own. */
export async function resolveHelpAgent(): Promise<HelpAgentChoice> {
  const settings = useSettingsStore.getState().settings;
  const customAgents = settings?.custom_agents ?? [];
  const [statuses, mcp, foundCustom] = await Promise.all([
    invoke<(BuiltInAgentStatus & { id: string })[]>("list_agents").catch(
      (): (BuiltInAgentStatus & { id: string })[] => [],
    ),
    invoke<{ help?: { wiredClis?: string[]; wired_clis?: string[] } }>("root_mcp_status").catch(
      () => null,
    ),
    customAgents.length
      ? invoke<string[]>("probe_binaries", { bins: customAgents.map((a) => a.cmd) }).catch(
          (): string[] => [],
        )
      : Promise.resolve<string[]>([]),
  ]);
  const installed = enabledInstalledAgentBins(statuses, settings?.disabled_agents);
  const defaultCmd = settings?.default_agent_cmd || "claude";
  return pickHelpAgent({
    installedBuiltins: installed,
    installedCmds: new Set(foundCustom),
    customAgents,
    defaultAgentBin: statuses.find((a) => a.id === defaultCmd)?.bin ?? defaultCmd,
    wiredClis: mcp?.help?.wiredClis ?? mcp?.help?.wired_clis ?? FALLBACK_WIRED_CLIS,
    localModel: settings?.ollama_roles?.tabs ?? settings?.ollama_model,
    vibeInstalled: installed.has("vibe"),
  });
}

// ── The open help tab ─────────────────────────────────────────────────────
// A second click brings the same agent back rather than minting another, as
// long as its tab is still in root and its program has not exited (an exited
// agent's tab stays, printing `[process exited]`). Session-only: after a
// relaunch the restored tab is an ordinary root tab and the next click starts
// a fresh one.
let helpTabKey: string | null = null;
let helpTabExited = false;
let stopWatch: (() => void) | null = null;

function trackHelpTab(key: string) {
  stopWatch?.();
  helpTabKey = key;
  helpTabExited = false;
  const ptyId = `${ROOT_SCOPE}:${key}`;
  const offExit = onTerminalExit(ptyId, () => {
    if (helpTabKey === key) helpTabExited = true;
  });
  const offReady = onTerminalReady(ptyId, () => {
    if (helpTabKey === key) helpTabExited = false;
  });
  stopWatch = () => {
    offExit();
    offReady();
  };
}

function liveHelpTab(): TabEntry | null {
  if (!helpTabKey || helpTabExited) return null;
  return useTabsStore.getState().tabsByScope[ROOT_SCOPE]?.find((x) => x.key === helpTabKey) ?? null;
}

export function __resetHelpAgentForTests(): void {
  stopWatch?.();
  stopWatch = null;
  helpTabKey = null;
  helpTabExited = false;
}

/** What a click came to: the agent is on screen, there is no agent to open,
 *  or the local model would not start. */
export type HelpAgentOutcome = "opened" | "none" | "localFailed";

/**
 * The help button's click: bring back the live help tab, else open the picked
 * agent as a root tab in the root console, told what it is for. The prompt is
 * typed into the agent's own CLI (`initialInput`), as a user would.
 */
export async function openHelpAgent(
  t: (key: TranslationKey, vars?: Record<string, string>) => string,
): Promise<HelpAgentOutcome> {
  const live = liveHelpTab();
  if (live) {
    useRootOverlayStore.getState().show(live.key);
    return "opened";
  }
  const choice = await resolveHelpAgent();
  if (choice.kind === "none") return "none";
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  let spec: Omit<TabEntry, "key">;
  if (choice.kind === "agent") {
    spec = buildStaticTabSpec(choice.item, rootDir, "", t);
  } else {
    try {
      spec = await vibeLocalTabSpec(ROOT_SCOPE, choice.model, rootDir);
    } catch {
      return "localFailed";
    }
  }
  openTabInRootConsole(
    {
      ...spec,
      label: t("helpAgent.tabLabel", { agent: spec.label }),
      initialInput: t("helpAgent.prompt"),
    },
    (tab) => trackHelpTab(tab.key),
  );
  return "opened";
}
