import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useT } from "../../lib/i18n";
import { runInstallInTab } from "../../lib/installCommand";
import { useProjectsStore } from "../../stores/projects";
import { SETTINGS_CHANGED_EVENT, useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { SettingsCard } from "./settingsUi";

/** Backend `copilot_setup`. */
interface CopilotSetup { supported: boolean; installed: boolean; installCommand: string | null }
/** Backend `copilot_account`: never starts a server, so `running` may be false. */
interface CopilotAccount {
  running: boolean;
  status?: { kind: string; message: string | null };
  account?: { status?: string | null; user?: string | null } | null;
  messages?: { id: number; message: string; actions: string[] }[];
}

/** #45a: provider choice, install, the active project's consent and the
 *  device sign-in. Consent is written by the backend, which binds it to the
 *  directory it resolves itself; this card never sends a path. */
export function CopilotCompletionCard() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === s.activeId));
  const [setup, setSetup] = useState<CopilotSetup | null>(null);
  const [account, setAccount] = useState<CopilotAccount | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const provider = settings?.code_completion_provider ?? "ollama";
  const policy = project ? settings?.completion_project_policies?.[project.id] : undefined;
  const remote = !!project?.remote;
  const consented = policy?.copilot === true && policy.local_only !== true && !remote;
  const projectId = project?.id;
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  useEffect(() => { setCode(null); setAccount(null); setError(null); setSigningIn(false); }, [projectId]);

  const recheck = useCallback(() => {
    void invoke<CopilotSetup>("copilot_setup").then(setSetup).catch(() => setSetup(null));
  }, []);
  useEffect(recheck, [recheck]);

  const refreshAccount = useCallback(() => {
    if (!projectId) { setAccount(null); return; }
    return invoke<CopilotAccount>("copilot_account", { projectId })
      .then((account) => { if (currentProject.current === projectId) setAccount(account); })
      .catch(() => { if (currentProject.current === projectId) setAccount(null); });
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshAccount();
      if (alive) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [refreshAccount, consented, provider]);

  // The backend keeps text consent only on top of code consent.
  const setPolicy = async (copilot: boolean, localOnly: boolean, text = policy?.copilot_text === true) => {
    if (!projectId) return;
    setError(null);
    try {
      const saved = await invoke<Settings>("copilot_set_project_policy", { projectId, copilot, localOnly, text });
      // The backend already committed atomically. Broadcast a refresh, never
      // write this possibly stale nested map over another window's decision.
      await emit(SETTINGS_CHANGED_EVENT, saved);
      if (!copilot || localOnly) { setCode(null); refreshAccount(); }
    } catch (e) {
      setError(String(e));
    }
  };

  const signIn = async () => {
    if (!projectId) return;
    setError(null);
    setSigningIn(true);
    try {
      const device = await invoke<{ userCode: string; verificationUri: string } | null>("copilot_sign_in", { projectId });
      if (device) {
        if (currentProject.current === projectId) setCode(device.userCode);
        void invoke("open_external_url", { url: device.verificationUri }).catch(() => {});
        await invoke("copilot_finish_sign_in", { projectId });
      }
    } catch (e) {
      if (currentProject.current === projectId) setError(String(e));
    } finally {
      if (currentProject.current === projectId) { setCode(null); setSigningIn(false); }
      refreshAccount();
    }
  };

  const signOut = async () => {
    if (!projectId) return;
    await invoke("copilot_sign_out", { projectId }).catch((e) => setError(String(e)));
    refreshAccount();
  };

  const signedIn = account?.running && !!account.account?.user;
  return (
    <SettingsCard>
      <p className="settings-help">{t("settings.copilotCloudNotice")}</p>
      <label className="settings-toggle-card-row">
        <span>{t("settings.copilotProvider")}</span>
        <select
          className="ollama-pull-input"
          value={provider}
          onChange={(e) => void updateSettings({ code_completion_provider: e.target.value as "ollama" | "copilot" })}
        >
          <option value="ollama">{t("settings.copilotProviderOllama")}</option>
          <option value="copilot">{t("settings.copilotProviderCopilot")}</option>
        </select>
      </label>

      {setup && !setup.supported && <p className="settings-help">{t("settings.copilotUnsupported")}</p>}
      {setup?.supported && !setup.installed && setup.installCommand && (
        <div className="ollama-install-cmd-row">
          <span className="settings-help">{t("settings.copilotNotInstalled")}</span>
          <button
            type="button"
            className="ollama-action-btn primary"
            onClick={() => runInstallInTab(t("settings.copilotInstallTabLabel"), setup.installCommand!, "bash")}
          >
            {t("agents.runInTerminal")}
          </button>
          <button type="button" className="ollama-action-btn" onClick={recheck}>{t("common.recheck")}</button>
        </div>
      )}
      {setup?.installed && <p className="settings-help">{t("settings.copilotInstalled")}</p>}

      {project ? (
        <>
          <label className="settings-toggle-card-row">
            <span>{t("settings.copilotProjectConsent", { project: project.name })}</span>
            <Toggle
              checked={policy?.copilot === true && !remote}
              disabled={remote || policy?.local_only === true}
              onChange={(e) => void setPolicy(e.target.checked, false)}
            />
          </label>
          <label className="settings-toggle-card-row">
            <span>{t("settings.copilotProjectText")} <UntestedTag id="settings.copilotProjectText" /></span>
            <Toggle
              checked={consented && policy?.copilot_text === true}
              disabled={!consented}
              onChange={(e) => void setPolicy(true, false, e.target.checked)}
            />
          </label>
          <label className="settings-toggle-card-row">
            <span>{t("settings.copilotProjectLocalOnly")}</span>
            <Toggle
              checked={policy?.local_only === true}
              onChange={(e) => void setPolicy(false, e.target.checked)}
            />
          </label>
          <p className="settings-help">
            {remote ? t("settings.copilotRemoteProject") : t("settings.copilotProjectConsentHelp")}
          </p>
        </>
      ) : (
        <p className="settings-help">{t("settings.copilotNoProject")}</p>
      )}

      {provider === "copilot" && consented && setup?.installed && (
        <div className="ollama-install-cmd-row">
          <span className="settings-help">
            {code ? t("settings.copilotEnterCode", { code })
              : signedIn ? t("settings.copilotSignedIn", { user: account?.account?.user ?? "" })
              : t("settings.copilotSignedOut")}
          </span>
          {signedIn ? (
            <button type="button" className="ollama-action-btn" onClick={() => void signOut()}>
              {t("settings.copilotSignOut")}
            </button>
          ) : (
            <button type="button" className="ollama-action-btn primary" disabled={signingIn} onClick={() => void signIn()}>
              {t("settings.copilotSignIn")}
            </button>
          )}
        </div>
      )}
      {account?.status?.message && <p className="settings-help">{account.status.message}</p>}
      {account?.messages?.map((message) => (
        <div key={message.id}>
          <p className="settings-help">{message.message}</p>
          {message.actions.map((action, index) => (
            <button key={index} type="button" className="ollama-action-btn" onClick={() => {
              void invoke("copilot_message_action", { projectId, messageId: message.id, action: index }).then(refreshAccount).catch((e) => setError(String(e)));
            }}>{action}</button>
          ))}
          <button type="button" className="ollama-action-btn" onClick={() => {
            void invoke("copilot_message_action", { projectId, messageId: message.id }).then(refreshAccount).catch((e) => setError(String(e)));
          }}>{t("common.close")}</button>
        </div>
      ))}
      {error && <p className="settings-help">{t("settings.copilotError", { error })}</p>}
      <p className="settings-help">{t("settings.copilotSessionOnly")}</p>
    </SettingsCard>
  );
}
