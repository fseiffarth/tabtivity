import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../../lib/i18n";
import { PLATFORM } from "../../../lib/platform";
import {
  NODE_DOWNLOAD_URL,
  NODE_INSTALL,
  runInstallInTab,
  type InstallShellKind,
  type NodeRuntimeStatus,
} from "../../../lib/installCommand";
import { AGENT_REGISTRY_CHANGED_EVENT, notifyAgentRegistryChanged } from "../../../lib/agents/agentRegistry";
import { UntestedTag } from "../../common/UntestedTag";
import {
  AGENT_SIGN_IN_CMD,
  AGENT_SIGN_IN_EXIT,
  AGENT_SIGN_IN_KEYS,
  FEATURED_AGENT_IDS,
  installNeedsNpm,
  type FeaturedAgentId,
} from "./introData";
import { IntroActions, IntroStatus, IntroStep, IntroSteps, startLessonById } from "./introUi";

/** The slice of the backend `AgentInfo` (`list_agents`) this page reads. */
export interface IntroAgentInfo {
  id: string;
  label: string;
  bin: string;
  install_cmd: string;
  shell_kind: InstallShellKind;
  docs: string;
  installed: boolean;
}

/**
 * Intro page 3 — the agent CLIs. One chip per featured CLI with its live
 * installed state (`list_agents`, a PATH lookup), and for the chosen one the
 * four steps: install, sign in, open a tab, first prompt. Install and sign-in
 * are the one-click open-a-terminal-tab flow (`runInstallInTab`) with the
 * backend registry's own command — the same one Settings → Manage CLIs runs —
 * and the wizard steps aside so the terminal (and any prompt in it) is in view.
 */
export function AgentsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [agents, setAgents] = useState<IntroAgentInfo[] | null>(null);
  const [node, setNode] = useState<NodeRuntimeStatus | null>(null);
  const [selected, setSelected] = useState<FeaturedAgentId>("claude");
  const [recheckMiss, setRecheckMiss] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void invoke<IntroAgentInfo[]>("list_agents")
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);
  useEffect(() => {
    refresh();
    void invoke<NodeRuntimeStatus>("node_runtime_status")
      .then(setNode)
      .catch(() => setNode(null));
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, refresh);
  }, [refresh]);

  const featured = FEATURED_AGENT_IDS.map((id) => agents?.find((a) => a.id === id)).filter(
    (a): a is IntroAgentInfo => !!a,
  );
  const agent = featured.find((a) => a.id === selected) ?? featured[0];
  const needsNode = !!agent && !agent.installed && installNeedsNpm(agent.install_cmd);
  const nodeOk = node ? node.npm && !node.too_old : null;

  const recheck = (id: string) => {
    setRecheckMiss(null);
    void invoke<boolean>("agent_is_installed", { id })
      .then((ok) => {
        setAgents((prev) => prev?.map((a) => (a.id === id ? { ...a, installed: ok } : a)) ?? prev);
        notifyAgentRegistryChanged();
        if (!ok) setRecheckMiss(id);
      })
      .catch(() => {});
  };

  const runInTerminal = (label: string, command: string, shell: InstallShellKind) => {
    runInstallInTab(label, command, shell);
    onClose();
  };

  return (
    <>
      <p className="settings-help">{t("intro.agents.lead")}</p>

      {agents === null ? (
        <IntroStatus ok={null}>{t("intro.checking")}</IntroStatus>
      ) : featured.length === 0 ? (
        <p className="settings-help">{t("intro.agents.registryUnavailable")}</p>
      ) : (
        <div className="intro-choice-row" role="group" aria-label={t("intro.agents.pick")}>
          {featured.map((a) => (
            <button
              key={a.id}
              type="button"
              className="settings-btn sm"
              aria-pressed={a.id === agent?.id}
              onClick={() => setSelected(a.id as FeaturedAgentId)}
            >
              <span className={`ollama-status-dot ${a.installed ? "running" : "stopped"}`} />
              {a.label}
            </button>
          ))}
          <UntestedTag id="desktop.intro.agents" />
        </div>
      )}

      {agent && (
        <IntroSteps>
          <IntroStep num={1} title={t("intro.agents.step1Title", { label: agent.label })} done={agent.installed}>
            <IntroStatus ok={agent.installed}>
              {agent.installed ? t("agents.installed") : t("agents.notInstalled")}
            </IntroStatus>
            {needsNode && (
              <div className="intro-prereq">
                <IntroStatus ok={nodeOk}>
                  {nodeOk === null
                    ? t("intro.agents.nodeChecking")
                    : nodeOk
                      ? t("intro.agents.nodeOk", { version: node?.version ?? "" })
                      : t("intro.agents.nodeMissing", { min: node?.min_major ?? "" })}
                </IntroStatus>
                {nodeOk === false && (
                  <IntroActions>
                    <button
                      type="button"
                      className="settings-btn sm"
                      onClick={() => {
                        const { command, shellKind } = NODE_INSTALL[PLATFORM];
                        runInTerminal(t("install.nodeTabLabel"), command, shellKind);
                      }}
                    >
                      {t("intro.agents.installNode")}
                    </button>
                    <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                      {t("agents.nodeDownloads")}
                    </a>
                  </IntroActions>
                )}
              </div>
            )}
            {!agent.installed && (
              <>
                {agent.install_cmd ? (
                  <>
                    <div className="settings-help">{t("intro.agents.step1Body")}</div>
                    <code className="ollama-install-cmd">{agent.install_cmd}</code>
                    <IntroActions>
                      <button
                        type="button"
                        className="settings-btn primary"
                        onClick={() =>
                          runInTerminal(
                            t("install.agentTabLabel", { label: agent.label }),
                            agent.install_cmd,
                            agent.shell_kind,
                          )
                        }
                      >
                        {t("intro.agents.install", { label: agent.label })}
                      </button>
                      <button type="button" className="settings-btn sm" onClick={() => recheck(agent.id)}>
                        {t("common.recheck")}
                      </button>
                    </IntroActions>
                  </>
                ) : (
                  <div className="settings-help">
                    {t("intro.agents.noInstaller")}{" "}
                    <a href={agent.docs} target="_blank" rel="noreferrer">
                      {t("agents.installDocs")}
                    </a>
                  </div>
                )}
                {recheckMiss === agent.id && (
                  <div className="settings-help">{t("agents.stillNotDetected")}</div>
                )}
              </>
            )}
          </IntroStep>

          <IntroStep num={2} title={t("intro.agents.step2Title")}>
            <div className="settings-help">{t(AGENT_SIGN_IN_KEYS[agent.id as FeaturedAgentId])}</div>
            <div className="settings-help">{t("intro.agents.signInFallback")}</div>
            {AGENT_SIGN_IN_EXIT[agent.id as FeaturedAgentId] && (
              <div className="settings-help">
                {t("intro.agents.signInExit", { command: AGENT_SIGN_IN_EXIT[agent.id as FeaturedAgentId] ?? "" })}
              </div>
            )}
            <IntroActions>
              <button
                type="button"
                className="settings-btn sm"
                disabled={!agent.installed}
                onClick={() =>
                  runInTerminal(
                    t("intro.agents.signInTabLabel", { label: agent.label }),
                    AGENT_SIGN_IN_CMD[agent.id as FeaturedAgentId],
                    "default",
                  )
                }
              >
                {t("intro.agents.signInNow", { command: AGENT_SIGN_IN_CMD[agent.id as FeaturedAgentId] })}
              </button>
            </IntroActions>
          </IntroStep>

          <IntroStep num={3} title={t("intro.agents.step3Title")}>
            <div className="settings-help">{t("intro.agents.step3Body", { label: agent.label })}</div>
            <IntroActions>
              <button type="button" className="settings-btn sm" onClick={() => startLessonById("install-agent", onClose)}>
                {t("intro.walkMeThrough")}
              </button>
            </IntroActions>
          </IntroStep>

          <IntroStep num={4} title={t("intro.agents.step4Title")}>
            <div className="settings-help">{t("intro.agents.step4Body")}</div>
            <code className="ollama-install-cmd">{t("intro.agents.examplePrompt")}</code>
          </IntroStep>
        </IntroSteps>
      )}

      <p className="settings-help">{t("intro.terminalNote")}</p>
      <IntroActions>
        <button
          type="button"
          className="settings-btn sm"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("app:open-settings", { detail: "agents" }));
            onClose();
          }}
        >
          {t("intro.agents.allClis")}
        </button>
      </IntroActions>
    </>
  );
}
