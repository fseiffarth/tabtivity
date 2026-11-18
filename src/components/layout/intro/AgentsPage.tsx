import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settings";
import { HOST_OS } from "../../../lib/platform";
import {
  NODE_DOWNLOAD_URL,
  NODE_INSTALL,
  runInstallInTab,
  type InstallShellKind,
  type NodeRuntimeStatus,
} from "../../../lib/installCommand";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../../lib/agents/agentRegistry";
import { loginIdForCmd, signInLaunch } from "../../../lib/agents/signInLaunch";
import { AGENT_ITEMS, buildSignInTabSpec } from "../../../lib/tabs/newTabItems";
import type { TranslationKey } from "../../../lib/i18n";
import { useProjectsStore } from "../../../stores/projects";
import { openTabInRootConsole, useRootOverlayStore } from "../../../stores/rootOverlay";
import { useAgentInstaller } from "../../../hooks/useAgentInstaller";
import { UntestedTag } from "../../common/UntestedTag";
import { ErrorNote } from "../../common/ErrorNote";
import { CheckIcon } from "../../common/icons/Icon";
import type { AgentLogin } from "../../settings/AgentLoginsRows";
import {
  AGENT_SIGN_IN_EXIT,
  FEATURED_AGENT_IDS,
  installNeedsNpm,
  type FeaturedAgentId,
} from "./introData";
import { IntroActions, IntroStatus, IntroStep, IntroSteps, startLessonById } from "./introUi";

/** What Sign in now does, per CLI, in the words of its `signInLaunch` flow. */
const SIGN_IN_HOW_KEYS: Record<FeaturedAgentId, TranslationKey> = {
  claude: "intro.agents.signInHow.claude",
  codex: "intro.agents.signInHow.codex",
  opencode: "intro.agents.signInHow.opencode",
  antigravity: "intro.agents.signInHow.antigravity",
  gemini: "intro.agents.signInHow.gemini",
};

/** The alternate way in's button, by `SignInLaunch.alternate.kind`. */
const SIGN_IN_ALTERNATE_KEYS: Record<"console" | "browser", TranslationKey> = {
  console: "intro.agents.signInAlternate.console",
  browser: "intro.agents.signInAlternate.browser",
};

/** The slice of the backend `AgentInfo` (`list_agents`) this page reads. */
export interface IntroAgentInfo {
  id: string;
  label: string;
  bin: string;
  install_cmd: string;
  /** The `sudo` form of an npm install (empty when none applies). */
  install_cmd_sudo?: string;
  shell_kind: InstallShellKind;
  docs: string;
  installed: boolean;
}

/**
 * Intro page 3 — the agent CLIs. One chip per featured CLI with its live
 * installed state (`list_agents`, a PATH lookup), and for the chosen one the
 * four steps: install, sign in, open a tab, first prompt. Install is the
 * headless installer Settings → Manage CLIs runs (`useAgentInstaller`): a live
 * log here, the wizard stays open and the page re-detects on success; a
 * failure offers Try again and the same terminal-tab fallbacks Settings has
 * (plain and `sudo`), which step aside so a password prompt is in view.
 * Sign-in is the CLI's own login command (`signInLaunch`) in a terminal tab;
 * the step reads the shared login state (`agent_logins`) and ticks itself.
 *
 * The page opens on the current default CLI (`default_agent_cmd`, Claude when
 * unset) and an explicit pick saves it as the default: clicking an installed
 * CLI's chip, an install that finished, or a Recheck that finds it installed.
 * Clicking through uninstalled chips saves nothing, so browsing never moves
 * the default to a CLI the user only looked at — nor does an install that failed.
 */
export function AgentsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [agents, setAgents] = useState<IntroAgentInfo[] | null>(null);
  const [node, setNode] = useState<NodeRuntimeStatus | null>(null);
  const defaultAgentCmd = useSettingsStore((s) => s.settings?.default_agent_cmd ?? "claude");
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [selected, setSelected] = useState<FeaturedAgentId>(() =>
    (FEATURED_AGENT_IDS as readonly string[]).includes(defaultAgentCmd) ? (defaultAgentCmd as FeaturedAgentId) : "claude",
  );
  const installer = useAgentInstaller();
  // The shared sign-in per CLI (`services::agent_auth`); null until read.
  const [logins, setLogins] = useState<Map<string, AgentLogin> | null>(null);
  // A failure no step owns (the default not saved, the logins unreadable).
  const [error, setError] = useState<string | null>(null);
  // The install whose success would become the default, with the default it
  // replaces; an explicit pick meanwhile (here or anywhere) cancels it.
  const pendingDefault = useRef<{ id: string; replaces: string } | null>(null);

  const refresh = useCallback(() => {
    void invoke<IntroAgentInfo[]>("list_agents")
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);
  const readLogins = useCallback(() => {
    void invoke<AgentLogin[]>("agent_logins")
      .then((rows) => setLogins(new Map((Array.isArray(rows) ? rows : []).map((l) => [l.id, l]))))
      .catch((e) => {
        setLogins(new Map());
        setError(String(e));
      });
  }, []);
  useEffect(() => {
    // An install (here or in Settings) or a recheck broadcasts this: re-read
    // both, so the chips and the sign-in step follow on their own.
    const onRegistry = () => {
      refresh();
      readLogins();
    };
    onRegistry();
    void invoke<NodeRuntimeStatus>("node_runtime_status")
      .then(setNode)
      .catch(() => setNode(null));
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, onRegistry);
    return () => window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, onRegistry);
  }, [refresh, readLogins]);

  const featured = FEATURED_AGENT_IDS.map((id) => agents?.find((a) => a.id === id)).filter(
    (a): a is IntroAgentInfo => !!a,
  );
  const agent = featured.find((a) => a.id === selected) ?? featured[0];
  const needsNode = !!agent && !agent.installed && installNeedsNpm(agent.install_cmd);
  const nodeOk = node ? node.npm && !node.too_old : null;
  // npm is missing or too old: an npm install would only fail, so Install
  // waits for the Node.js step above it.
  const nodeBlocks = needsNode && nodeOk === false;
  const defaultAgent = agents?.find((a) => a.id === defaultAgentCmd || a.bin === defaultAgentCmd);
  const busy = installer.installing !== null;

  // Same value the Manage CLIs "Default" chip writes (the registry id). Read
  // live: an install finishes long after the click that started it. A failed
  // write is shown; the store has already put the old value back.
  const currentDefault = () => useSettingsStore.getState().settings?.default_agent_cmd ?? "claude";
  const saveDefault = (id: string) => {
    if (id === currentDefault()) return;
    updateSettings({ default_agent_cmd: id }).catch((e) => setError(String(e)));
  };
  /** An explicit pick: saved now, and it outranks an install still running. */
  const pickDefault = (id: string) => {
    pendingDefault.current = null;
    saveDefault(id);
  };

  // Only a confirmed install becomes the default (the backend answers Ok once
  // the binary is detected; the broadcast re-reads the list) — and only if
  // nothing else was picked since the click. That holds after the user moved
  // on to the next page too: Install then Next is the wizard's normal path.
  const install = (id: string) => {
    pendingDefault.current = { id, replaces: currentDefault() };
    void installer.install(id).then((ok) => {
      const pending = pendingDefault.current;
      if (!ok || pending?.id !== id) return;
      pendingDefault.current = null;
      if (currentDefault() === pending.replaces) saveDefault(id);
    });
  };

  const recheck = (id: string) => {
    void installer.recheck(id).then((ok) => {
      if (ok === null) return;
      setAgents((prev) => prev?.map((a) => (a.id === id ? { ...a, installed: ok } : a)) ?? prev);
      if (ok) pickDefault(id);
    });
  };

  const runInTerminal = (label: string, command: string, shell: InstallShellKind) => {
    runInstallInTab(label, command, shell);
    onClose();
  };

  // The selected CLI's sign-in: its own login command (`signInLaunch`), opened
  // as the + menu's sign-in tab is (`buildSignInTabSpec`, env and all — Gemini's
  // NO_BROWSER) in the root console, where installs open too.
  const launch = agent ? signInLaunch(agent.bin) : null;
  const signInCmd = agent && launch ? [agent.bin, ...launch.args].join(" ") : "";
  const alternate = agent && launch?.alternate ? launch.alternate : null;
  const alternateCmd = agent && alternate ? [agent.bin, ...alternate.args].join(" ") : "";
  const openSignIn = (useAlternate: boolean) => {
    if (!agent) return;
    const way = signInLaunch(agent.bin, useAlternate);
    const item = AGENT_ITEMS.find((i) => i.cmd === agent.bin);
    if (item) {
      const rootDir = useProjectsStore.getState().rootDir ?? "";
      openTabInRootConsole({ ...buildSignInTabSpec(item, way, rootDir, t), location: "local" }, (tab) =>
        useRootOverlayStore.getState().markInstallTab(tab.key),
      );
    } else {
      runInstallInTab(t("intro.agents.signInTabLabel", { label: agent.label }), [agent.bin, ...way.args].join(" "), "default");
    }
    onClose();
  };
  const login = agent ? logins?.get(loginIdForCmd(agent.id)) : undefined;
  // As Manage CLIs reads a login: an untracked CLI (`shared` false) has no state.
  const knownLogin = login?.shared ? login : null;
  const signedIn =
    !!knownLogin &&
    (knownLogin.signed_in || !!knownLogin.api_key || (!!knownLogin.uses_admin_key && !!knownLogin.admin_key_offered));
  const loginText = !knownLogin
    ? null
    : knownLogin.uses_admin_key && knownLogin.admin_key_offered
      ? t("settings.agentLoginAdminKey")
      : knownLogin.signed_in
        ? knownLogin.account
          ? t("settings.agentLoginSignedInAs", { account: knownLogin.account })
          : t("settings.agentLoginSignedIn")
        : knownLogin.api_key
          ? t("settings.agentLoginUsesApiKey")
          : t("agents.loginNone");
  const agentError = agent ? installer.errors[agent.id] : undefined;
  const agentLog = agent ? installer.logs[agent.id] : undefined;
  const running = !!agent && installer.installing === agent.id;
  const elsewhere = !!agent && installer.elsewhere.has(agent.id);
  // A login only counts for an installed CLI: step 2 waits for step 1.
  const signInDone = !!agent?.installed && signedIn;

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
              // The dot is colour only: the tooltip (and accessible
              // description) and the tick say it in words and shape.
              title={a.installed ? t("agents.installed") : t("agents.notInstalled")}
              onClick={() => {
                setSelected(a.id as FeaturedAgentId);
                if (a.installed) pickDefault(a.id);
              }}
            >
              <span className={`ollama-status-dot ${a.installed ? "running" : "stopped"}`} />
              {a.label}
              {a.installed && <CheckIcon size={12} />}
            </button>
          ))}
          <UntestedTag id="desktop.intro.agents" />
        </div>
      )}
      {defaultAgent?.installed && (
        <IntroStatus ok={true}>{t("intro.agents.isDefault", { label: defaultAgent.label })}</IntroStatus>
      )}

      {agent && (
        <IntroSteps>
          <IntroStep num={1} title={t("intro.agents.step1Title", { label: agent.label })} done={agent.installed}>
            <IntroStatus ok={agent.installed}>
              {agent.installed ? t("agents.installed") : t("agents.notInstalled")}
            </IntroStatus>
            {needsNode && (
              <div className="intro-prereq">
                <IntroStatus ok={nodeOk} id="intro-agents-node">
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
                        const { command, shellKind } = NODE_INSTALL[HOST_OS];
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
                    <div className="settings-help">{t("intro.agents.step1BodyInline")}</div>
                    <code className="ollama-install-cmd">{agent.install_cmd}</code>
                    <IntroActions>
                      <button
                        type="button"
                        className="settings-btn primary"
                        disabled={busy || nodeBlocks}
                        aria-describedby={nodeBlocks ? "intro-agents-node" : undefined}
                        onClick={() => install(agent.id)}
                      >
                        {running ? t("agents.installing") : t("agents.installLabel", { label: agent.label })}
                      </button>
                      <button type="button" className="settings-btn sm" disabled={busy} onClick={() => recheck(agent.id)}>
                        {t("common.recheck")}
                      </button>
                      <UntestedTag id="desktop.intro.agentsInlineInstall" />
                    </IntroActions>
                    {nodeBlocks && <div className="settings-help">{t("intro.agents.installNeedsNode")}</div>}
                  </>
                ) : (
                  <div className="settings-help">
                    {t("intro.agents.noInstaller")}{" "}
                    <a href={agent.docs} target="_blank" rel="noreferrer">
                      {t("agents.installDocs")}
                    </a>
                  </div>
                )}
                {running && (
                  <IntroStatus ok={null}>
                    {elsewhere ? t("intro.agents.installElsewhere", { label: agent.label }) : t("agents.runningInstaller")}
                  </IntroStatus>
                )}
                {(running || agentError) && !elsewhere && agentLog && (
                  <pre className="ollama-install-log" ref={running ? installer.logRef : undefined} role="log">
                    {agentLog}
                  </pre>
                )}
                {agentError && !running && (
                  <>
                    <ErrorNote className="project-dialog-error" error={agentError} role="alert" />
                    {agent.install_cmd && (
                      <>
                        <div className="settings-help">{t("intro.agents.installFallback")}</div>
                        <IntroActions>
                          <button type="button" className="settings-btn sm" disabled={busy || nodeBlocks} onClick={() => install(agent.id)}>
                            {t("intro.agents.retryInstall")}
                          </button>
                          <button
                            type="button"
                            className="settings-btn sm"
                            onClick={() =>
                              runInTerminal(t("install.agentTabLabel", { label: agent.label }), agent.install_cmd, agent.shell_kind)
                            }
                          >
                            {t("agents.runInTerminal")}
                          </button>
                          {agent.install_cmd_sudo && (
                            <button
                              type="button"
                              className="settings-btn sm"
                              title={t("agents.runWithSudoTitle")}
                              onClick={() =>
                                runInTerminal(
                                  t("install.agentTabLabel", { label: agent.label }),
                                  agent.install_cmd_sudo ?? "",
                                  agent.shell_kind,
                                )
                              }
                            >
                              {t("agents.runWithSudo")}
                            </button>
                          )}
                        </IntroActions>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </IntroStep>

          <IntroStep num={2} title={t("intro.agents.step2Title")} done={signInDone}>
            {agent.installed && loginText && (
              <IntroStatus ok={signedIn}>
                {loginText} <UntestedTag id="desktop.intro.agentsSignIn" />
              </IntroStatus>
            )}
            {!signInDone && (
              <>
                <div className="settings-help">{t(SIGN_IN_HOW_KEYS[agent.id as FeaturedAgentId])}</div>
                <div className="settings-help">{t("intro.agents.signInFallback")}</div>
                {/* A login command ends by itself; a plain launch stays a session. */}
                {!launch?.exits && AGENT_SIGN_IN_EXIT[agent.id as FeaturedAgentId] && (
                  <div className="settings-help">
                    {t("intro.agents.signInExit", { command: AGENT_SIGN_IN_EXIT[agent.id as FeaturedAgentId] ?? "" })}
                  </div>
                )}
                <IntroActions>
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={!agent.installed}
                    aria-describedby={agent.installed ? undefined : "intro-agents-signin-needs"}
                    onClick={() => openSignIn(false)}
                  >
                    {t("intro.agents.signInNow", { command: signInCmd })}
                  </button>
                  {alternate && (
                    <button
                      type="button"
                      className="settings-btn sm"
                      disabled={!agent.installed}
                      aria-describedby={agent.installed ? undefined : "intro-agents-signin-needs"}
                      title={alternateCmd}
                      onClick={() => openSignIn(true)}
                    >
                      {t(SIGN_IN_ALTERNATE_KEYS[alternate.kind])}
                    </button>
                  )}
                  {agent.installed && (
                    <button type="button" className="settings-btn sm" onClick={readLogins}>
                      {t("common.recheck")}
                    </button>
                  )}
                </IntroActions>
                {!agent.installed && (
                  <div className="settings-help" id="intro-agents-signin-needs">
                    {t("intro.agents.signInNeedsInstall", { label: agent.label })}
                  </div>
                )}
              </>
            )}
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

      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <p className="settings-help">{t("intro.terminalNoteInline")}</p>
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
