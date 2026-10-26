import { useEffect, useState } from "react";
import { ToggleRow } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { AGENT_FENCE_DEFAULT_PATHS, parseAgentFencePaths } from "../../lib/agents/agentFence";
import { AgentsHelp, AgentsStatus, AgentsFold } from "./agentsUi";

/** The Agent sandbox group. There is no switch for the sandbox itself: what is
 *  here is what it may additionally reveal. */
export function AgentFenceCard() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const stored = settings?.agent_fence_paths;
  const effective = stored ?? [...AGENT_FENCE_DEFAULT_PATHS];
  const [paths, setPaths] = useState(effective.join("\n"));
  useEffect(() => {
    setPaths((stored ?? [...AGENT_FENCE_DEFAULT_PATHS]).join("\n"));
  }, [stored]);
  const dirty = parseAgentFencePaths(paths).join("\n") !== effective.join("\n");

  const savePaths = () => {
    const next = parseAgentFencePaths(paths);
    setPaths(next.join("\n"));
    void updateSettings({ agent_fence_paths: next });
  };

  return (
    <div className="agents-stack">
      <p className="settings-help">{t("settings.agentFenceHelp")}</p>
      <AgentsFold label={t("agents.fenceLimits")}>
        <p className="settings-help">{t("settings.agentFenceLimits")}</p>
        <p className="settings-help">{t("settings.agentFenceSharedState")}</p>
      </AgentsFold>
      <div className="agents-option">
        <ToggleRow
          label={<>{t("settings.agentFenceCargoCredentials")} <UntestedTag id="settings.agentFenceCargoCredentials" /></>}
          checked={settings?.agent_fence_cargo_credentials ?? false}
          onChange={(e) => void updateSettings({ agent_fence_cargo_credentials: e.target.checked })}
        />
        <p className="settings-help">{t("settings.agentFenceCargoCredentialsHelp")}</p>
      </div>
      {settings?.agent_fence_platform_accepted && (
        // Only once given: the acceptance a fence-less platform (Windows) asks
        // for before the first agent tab. Switching it off asks again next time.
        <div className="agents-option">
          <ToggleRow
            label={<>{t("settings.agentFencePlatformAccepted")} <UntestedTag id="settings.agentFencePlatformAccepted" /></>}
            checked
            onChange={() => void updateSettings({ agent_fence_platform_accepted: false })}
          />
          <p className="settings-help">{t("settings.agentFencePlatformAcceptedHelp")}</p>
        </div>
      )}
      <div className="agents-option">
        <ToggleRow
          label={<>{t("settings.rootFenceProjects")} <UntestedTag id="settings.rootFenceProjects" /></>}
          checked={settings?.root_fence_projects_readable ?? false}
          onChange={(e) => void updateSettings({ root_fence_projects_readable: e.target.checked })}
        />
        <p className="settings-help">{t("settings.rootFenceProjectsHelp")}</p>
      </div>
      <div className="agents-block">
        <div className="settings-subheader">
          <label htmlFor="agent-fence-paths">{t("settings.agentFencePaths")}</label>
          <AgentsHelp text={t("settings.agentFencePathsHelp")} />
          {dirty && <AgentsStatus tone="warn">{t("agents.fenceUnsaved")}</AgentsStatus>}
        </div>
        <textarea
          id="agent-fence-paths"
          className="ollama-pull-input"
          rows={8}
          value={paths}
          spellCheck={false}
          onChange={(event) => setPaths(event.target.value)}
          onBlur={savePaths}
          aria-label={t("settings.agentFencePaths")}
        />
        <div className="agents-actions">
          <button
            type="button"
            className="settings-btn sm"
            onClick={() => {
              setPaths(AGENT_FENCE_DEFAULT_PATHS.join("\n"));
              void updateSettings({ agent_fence_paths: undefined });
            }}
          >
            {t("settings.agentFenceReset")}
          </button>
        </div>
      </div>
    </div>
  );
}
