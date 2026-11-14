import { useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { aiIsOff } from "../../lib/aiSwitch";
import { claimTabMessageWakes, TABS_MCP_CHANGED } from "../../lib/window/tabsMcp";
import { queuePromptForTab } from "../../stores/agents/agentPrompts";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";

/**
 * Tab messaging's per-project idle wake (`docs/tab_messaging_mcp_plan.md`,
 * step 7; off by default, `tab_messages_wake`). On every `tabs-mcp-changed`
 * it asks the backend's claim for each opted-in project and queues what the
 * claim returns: the host's fixed notice, for each tab with a new unread
 * batch, through `queuePromptForTab` — the scheduler's idle gate, so the
 * notice lands only once the tab is idle. Message text never reaches a prompt.
 * The claim itself re-reads the opt-in and the switch and holds the budget
 * (one wake per batch, six per tab per hour); this host only queues.
 *
 * Mounted once in the main window. Listens only while some project opts in.
 */
export function TabMessagesHost() {
  const projects = useProjectsStore((s) => s.projects);
  const aiOff = useSettingsStore((s) => s.settings?.ai_off === true);
  const optedIn = useMemo(
    () => projects.filter((p) => p.tab_messages_wake === true && !p.remote).map((p) => p.id).join("\n"),
    [projects],
  );

  useEffect(() => {
    if (!optedIn || aiOff) return;
    const scopes = optedIn.split("\n");
    let running = false;
    let again = false;
    const pass = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          if (aiIsOff()) return;
          for (const scope of scopes) {
            const wake = await claimTabMessageWakes(scope);
            if (!wake) continue;
            for (const target of wake.scheduleTargetIds) {
              await queuePromptForTab(scope, target, wake.notice).catch(() => undefined);
            }
          }
        } while (again);
      } finally {
        running = false;
      }
    };
    void pass();
    return subscribeTauri(() => listen(TABS_MCP_CHANGED, () => void pass()));
  }, [optedIn, aiOff]);

  return null;
}
