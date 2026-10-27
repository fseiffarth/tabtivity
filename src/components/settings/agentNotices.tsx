import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleRow } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import { HOST_OS } from "../../lib/platform";
import {
  NODE_DOWNLOAD_URL,
  NODE_INSTALL,
  runInstallInTab,
  type NodeRuntimeStatus,
} from "../../lib/installCommand";
import {
  codexHookNeedsTrust,
  openCodexHooksTab,
  type CodexHookState,
} from "../../lib/agents/codexHooks";
import { useT } from "../../lib/i18n";
import { NAMES } from "../../lib/brand";
import { AgentsStatus, AgentsFold } from "./agentsUi";

/**
 * "Codex won't run our session hook" notice for the Manage Agents panel.
 *
 * Codex gates user-level hooks behind a one-time trust approval, and an
 * untrusted one silently never fires — which is why Codex tabs used to restore
 * into a blank conversation. Tabtivity resumes them anyway now (it reconstructs the
 * session from Codex's rollout logs), but that is a heuristic: it can mix up two
 * Codex tabs open in the same directory. Enabling the hook makes it exact.
 *
 * The contextual hint says the same thing, but it is dismissible for good and is
 * suppressed outright when hints are off — so this is where a user who waved it
 * away can still find the fix.
 *
 * Rendered nested inside the Codex row of Manage Agents (not as a free-floating
 * top-of-panel notice) — the hook is Codex-specific, so it belongs with the
 * agent it's about, same as the Remove/Reinstall actions.
 */
export function CodexHookNotice() {
  const t = useT();
  // null = still probing.
  const [state, setState] = useState<CodexHookState | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [trustFailed, setTrustFailed] = useState(false);
  const recheck = () =>
    invoke<CodexHookState>("codex_hook_status").then(setState).catch(() => setState(null));
  useEffect(() => void recheck(), []);
  // Codex keeps the trust verdict per config file and every scope's agent home
  // has its own, so `/hooks` in one tab fixes one home. This writes the verdict
  // Codex would into all of them, for the app's own hooks only.
  const trustAll = () => {
    setTrusting(true);
    setTrustFailed(false);
    invoke<CodexHookState>("codex_hook_trust")
      .then((next) => {
        setState(next);
        setTrustFailed(codexHookNeedsTrust(next));
      })
      .catch(() => setTrustFailed(true))
      .finally(() => setTrusting(false));
  };

  // Healthy, absent, or still probing → nothing to say.
  if (!codexHookNeedsTrust(state)) return null;

  // The two states need two different instructions, and conflating them is what
  // made this notice useless: `disabled` means Codex ALREADY recorded a trust
  // verdict for the hook (its `trusted_hash` is in `config.toml`) and the row is
  // merely switched off, so telling that user to "trust it" sends them looking
  // for an action they already took. Only `untrusted` — no verdict at all — is
  // the review-and-approve case.
  const off = state === "disabled";

  return (
    <div className="agents-notice is-warn">
      <div className="agents-notice-head">
        <AgentsStatus tone="warn">
          {t("agents.codexHookLabel")}: {off ? t("agents.codexHookDisabled") : t("agents.codexHookNotTrusted")}
        </AgentsStatus>
      </div>
      <p className="settings-help">{off ? t("agents.codexHookCauseDisabled") : t("agents.codexHookCauseUntrusted")}</p>
      <div className="agents-actions">
        <button type="button" className="settings-btn sm primary" onClick={trustAll} disabled={trusting}>
          {trusting ? t("agents.codexHookTrusting") : t("agents.codexHookTrust")}
        </button>
        <UntestedTag id="agents.codexHookTrust" />
        <button type="button" className="settings-btn sm" onClick={openCodexHooksTab}>
          {t("agents.openInCodex")}
        </button>
        <button type="button" className="settings-btn sm" onClick={() => void recheck()}>
          {t("common.recheck")}
        </button>
      </div>
      {trustFailed && <p className="settings-help">{t("agents.codexHookTrustFailed")}</p>}
      <AgentsFold label={t("agents.howToFix")}>
        <p className="settings-help">{t("agents.codexHookFallback")}</p>
        <p className="settings-help">
          {t("agents.codexHookFindPre")} <code>/hooks</code>{" "}
          {t("agents.codexHookFindMid")} <strong>{NAMES.sessionHookSh.replace(/\.sh$/, "")}</strong>
          {off ? t("agents.codexHookActionDisabled") : t("agents.codexHookActionUntrusted")}
        </p>
      </AgentsFold>
    </div>
  );
}

/**
 * Claude's `--remote-control` toggle, moved here from the main Settings panel
 * (Group: nav "Manage Agents") since the flag only affects `claude` agent
 * tabs — it belongs with the agent it's about, same reasoning as
 * `CodexHookNotice`. Rendered nested inside the Claude row.
 */
export function ClaudeRemoteControlNotice() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  return (
    <div className="agents-option">
      <ToggleRow
        label={t("settings.claudeRemote")}
        checked={settings?.agent_remote_control ?? true}
        onChange={(e) => void updateSettings({ agent_remote_control: e.target.checked })}
      />
      <p className="settings-help">
        {t("settings.claudeRemoteHelp1")} <code>--remote-control</code>{" "}
        {t("settings.claudeRemoteHelp2")}
      </p>
    </div>
  );
}

/** npm's words for "this package wants a newer Node" — a warning it installs
 *  through anyway (the CLI then fails at start) or the error it stops on. */
export const NODE_ENGINE_FAILURE = /EBADENGINE|Unsupported engine|engine "node" is incompatible/i;

/** The host's Node.js as `node_runtime_status` reports it; null while probing
 *  (or when the probe failed, which shows nothing). */
export function useNodeRuntimeStatus() {
  const [status, setStatus] = useState<NodeRuntimeStatus | null>(null);
  const recheck = () =>
    void invoke<NodeRuntimeStatus>("node_runtime_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => recheck(), []);
  return { status, recheck };
}

/**
 * "Install Node/npm first" helper for the Manage Agents panel. Most agent CLIs
 * install through `npm`, so when `npm` isn't on the host's PATH — or the Node
 * that is there is older than the current LTS the CLIs require — this points
 * the user at the one-click, no-admin Node install for their OS. Follows
 * Tabtivity's install-via-terminal-tab policy. The panel owns the probe
 * ({@link useNodeRuntimeStatus}) because the two cases sit in different places:
 * a missing npm blocks every install and goes above the CLIs, while an old Node
 * is fine for most of them and shows only in the card of an install npm
 * refused for it ({@link NODE_ENGINE_FAILURE}).
 */
export function NodeRuntimeNotice({
  status,
  onRecheck,
}: {
  status: NodeRuntimeStatus;
  onRecheck: () => void;
}) {
  const t = useT();
  const tooOld = status.npm && status.too_old;

  const { command, shellKey, shellKind } = NODE_INSTALL[HOST_OS];
  return (
    <div className="agents-notice is-warn">
      <div className="agents-notice-head">
        <span className="agents-notice-title">Node.js / npm</span>
        <AgentsStatus tone="warn">
          {tooOld
            ? t("agents.nodeTooOld", {
                // "v22.22.1" would read "V22.22.1" under the status text's
                // capitalised first letter.
                version: (status.version ?? "").replace(/^v/, ""),
                min: status.min_major,
              })
            : t("agents.nodeNotDetected")}
        </AgentsStatus>
        {tooOld && <UntestedTag id="settingsSubPanels.1" />}
      </div>
      {tooOld ? (
        <p className="settings-help">
          {t("agents.nodeTooOldHelpPre", { min: status.min_major })}{" "}
          <strong>{t(shellKey)}</strong> {t("agents.nodeTooOldHelpPost")}
        </p>
      ) : (
        <p className="settings-help">
          {t("agents.nodeHelpPre")} <code>npm</code> {t("agents.nodeHelpMid")}{" "}
          <strong>{t(shellKey)}</strong> {t("agents.nodeHelpPost")}
        </p>
      )}
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">{command}</code>
        <button
          type="button"
          className="settings-btn sm primary"
          onClick={() => runInstallInTab(t("install.nodeTabLabel"), command, shellKind)}
        >
          {t("agents.runInTerminal")}
        </button>
        <button type="button" className="settings-btn sm" onClick={onRecheck}>
          {t("common.recheck")}
        </button>
      </div>
      <p className="settings-help">
        {t("agents.nodeManualPre")}{" "}
        <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          {t("agents.nodeDownloads")}
        </a>
        .
      </p>
    </div>
  );
}
