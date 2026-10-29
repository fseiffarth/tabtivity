import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { basename } from "../../lib/paths";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agents/agentRegistry";
import { useSettingsStore } from "../../stores/settings";
import { AgentDefaults } from "../settings/AgentDefaults";
import { AgentsFold } from "../settings/agentsUi";
import type { AgentInfo } from "../settings/agentTypes";
import { UntestedTag } from "../common/UntestedTag";

/** One `list_agents` per window until Manage CLIs installs or removes one. */
let agentList: Promise<AgentInfo[]> | null = null;
window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, () => { agentList = null; });

/** The key the backend saves and applies a CLI's defaults under: the
 * command's file stem (`services::agent_defaults`). */
function commandStem(cmd: string): string {
  return basename(cmd.trim()).replace(/\.(exe|cmd|bat)$/i, "");
}

/**
 * Manage CLIs' "Default model and effort" (`AgentDefaults`) under the Chat
 * view's model and effort lists, folded: those change this session, this the
 * model and effort new sessions of the CLI start on. Nothing shows for a CLI
 * with no verified startup choice.
 */
export function ReaderLaunchDefaults({ cmd }: { cmd: string }) {
  const t = useT();
  const bin = commandStem(cmd);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const saved = useSettingsStore((s) => s.settings?.agent_launch_defaults?.[bin]);
  useEffect(() => {
    let live = true;
    agentList ??= invoke<AgentInfo[]>("list_agents").catch((err: unknown) => {
      agentList = null;
      throw err;
    });
    void agentList.then(
      (agents) => { if (live) setAgent(agents.find((a) => a.bin === bin) ?? null); },
      () => {},
    );
    return () => { live = false; };
  }, [bin]);
  const cap = agent?.launch_defaults;
  if (!agent || !cap || (!cap.model && cap.efforts.length === 0)) return null;
  const value = [saved?.model, saved?.effort].filter(Boolean).join(" · ") || t("terminal.reader.defaultsCli");
  return (
    <AgentsFold className="terminal-reader-defaults" label={<>{t("terminal.reader.defaultsTitle", { value })} <UntestedTag id="terminal.reader.launchDefaults" /></>}>
      <small className="terminal-reader-question-more">{t("terminal.reader.defaultsNote")}</small>
      <AgentDefaults agent={agent} compact />
    </AgentsFold>
  );
}
