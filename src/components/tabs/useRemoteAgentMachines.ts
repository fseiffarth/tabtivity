import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentMachine } from "./agentMenuEntries";
import { AGENT_CLI_ROWS } from "../../lib/agents/agentCliTable";
import { remoteHostIdOf } from "../../stores/tabs/tabLocation";
import { runInstallInTab } from "../../lib/installCommand";
import { useT } from "../../lib/i18n";

/** Menu-scoped probes; backend connectivity is authoritative in popouts too. */
export function useRemoteAgentMachines(scope: string, machines: AgentMachine[] | undefined, customBins: string[], active: boolean) {
  const t = useT();
  const [inventory, setInventory] = useState<{ key: string; bins: Record<string, string[]> }>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = JSON.stringify([scope, machines, customBins]);
  useEffect(() => {
    if (!active || !machines) return;
    let cancelled = false;
    setInventory(undefined);
    void invoke<[string, string][]>("remote_connected_targets").then(async (connected) => {
      const results = await Promise.all(machines.map(async (machine) => {
        const hostId = remoteHostIdOf(machine.location);
        if (!hostId || !connected.some(([project, host]) => project === scope && host === hostId)) return null;
        try {
          const bins = await invoke<string[]>("probe_remote_agent_binaries", {
            projectId: scope, hostId, bins: [...AGENT_CLI_ROWS.map((row) => row.bin), ...customBins],
          });
          return [machine.location, bins] as const;
        } catch { return null; }
      }));
      if (!cancelled) setInventory({ key, bins: Object.fromEntries(results.filter((row) => row !== null)) });
    }).catch(() => {});
    return () => { cancelled = true; };
    // The serialized input keeps equivalent menu machine arrays stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);
  return machines?.map((machine): AgentMachine => {
    if (machine.location === "local") return machine;
    const bins = inventory?.key === key ? inventory.bins[machine.location] : undefined;
    return {
      ...machine,
      installError: errors[machine.location],
      installedBins: new Set(bins ?? []),
      install: bins === undefined ? undefined : async (bin, label) => {
        const agent = AGENT_CLI_ROWS.find((row) => row.bin === bin);
        if (!agent) return;
        try {
          setErrors((prev) => ({ ...prev, [machine.location]: "" }));
          const command = await invoke<string>("install_agent_project_command", {
            agentId: agent.id, projectId: scope, hostId: remoteHostIdOf(machine.location),
          });
          runInstallInTab(t("agents.installRemoteTabLabel", { label, machine: machine.label }), command, "default");
        } catch (error) {
          setErrors((prev) => ({ ...prev, [machine.location]: String(error) }));
        }
      },
    };
  });
}
