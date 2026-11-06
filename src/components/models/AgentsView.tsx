import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModelsOverlayStore, type AgentsSection } from "../../stores/modelsOverlay";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agents/agentRegistry";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { CliOverviewBody } from "../agents/CliOverviewView";
import { ViewSubTabs } from "../layout/viewBarSlots";
import { AgentsPanel } from "../settings/AgentsPanel";
import { SkillsLibraryView } from "../skills/SkillsLibraryView";
import { AgentChips } from "./ModelsHubSections";

const SECTIONS: readonly AgentsSection[] = ["agents", "usage", "skills"];

const SECTION_LABEL: Record<AgentsSection, TranslationKey> = {
  agents: "agentsView.tab.agents",
  usage: "agentsView.tab.usage",
  skills: "agentsView.tab.skills",
};

/**
 * The **Agents** view of the console window: what the Models & agents overlay's
 * Agents & CLIs and Skills sections were, plus the CLIs' plan and token usage
 * the cockpit's former Usage view held. Three sections, shown as tabs in the
 * window's sub-bar, each a surface that already exists:
 *  - **Agents & CLIs** — Settings' `AgentsPanel`, each installed card carrying
 *    the header dropdown's Default · + tab · Root · MCP chips (`AgentChips`);
 *  - **Usage** — `CliOverviewBody`, the side panel's CLIs body (read while
 *    shown, every few minutes, ⟳ asks again);
 *  - **Skills** — the machine-level skills library (`SkillsLibraryView` with no
 *    project: this surface belongs to the machine, so the personal scope is the
 *    only one it can honestly offer).
 *
 * A section mounts the first time it is shown and then stays mounted, hidden,
 * while the view is: an install log is component state. Leaving the view
 * unmounts all of them, as for every other view.
 */
export function AgentsView() {
  const t = useT();
  const section = useModelsOverlayStore((s) => s.agentsSection);
  const setSection = useModelsOverlayStore((s) => s.setAgentsSection);
  // Sections shown so far; derived with the section so a first show renders in
  // the same frame, not one effect later.
  const [visited, setVisited] = useState<ReadonlySet<AgentsSection>>(() => new Set([section]));
  useEffect(() => {
    setVisited((v) => (v.has(section) ? v : new Set(v).add(section)));
  }, [section]);
  const mounted = (id: AgentsSection) => id === section || visited.has(id);

  return (
    <div className="app-view app-view-agents models-overlay-body">
      <ViewSubTabs
        items={SECTIONS.map((id) => ({ id, label: t(SECTION_LABEL[id]) }))}
        value={section}
        onChange={setSection}
        ariaLabel={t("agentsView.tabs")}
        extra={<UntestedTag id="agentsView.tabs" />}
      />
      {SECTIONS.map((id) =>
        mounted(id) ? (
          <div
            key={id}
            role="tabpanel"
            aria-label={t(SECTION_LABEL[id])}
            className={`models-overlay-pane models-overlay-pane-${id}`}
            hidden={id !== section}
          >
            {id === "agents" && <AgentsTab active={section === "agents"} />}
            {id === "usage" && (
              <div className="dialog-scroll">
                <CliOverviewBody active={section === "usage"} />
              </div>
            )}
            {id === "skills" && <SkillsLibraryView projectDir={null} visible={section === "skills"} />}
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * Settings' Agents panel, each installed card carrying the dropdown's chips.
 * `wired` (which CLIs the root MCP server is named to) is read when the section
 * becomes visible and again whenever the agent registry changes — installing
 * or removing a CLI can change the answer. `null` until then, which draws no
 * MCP chip, as the dropdown does before its own read.
 */
function AgentsTab({ active }: { active: boolean }) {
  const [wired, setWired] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      invoke<{ wired_clis?: string[] }>("root_mcp_status")
        .then((s) => {
          if (!cancelled) setWired(s.wired_clis ?? null);
        })
        .catch(() => {
          if (!cancelled) setWired(null);
        });
    if (active) void read();
    const onChanged = () => void read();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    };
  }, [active]);
  return <AgentsPanel installedExtras={(a) => <AgentChips agent={a} wiredClis={wired} />} />;
}
