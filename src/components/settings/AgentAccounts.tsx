import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToggleRow } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { AgentsHelp, AgentsStatus } from "./agentsUi";
import { AgentLoginsRows } from "./AgentLoginsRows";
import { AgentApiKeysRows } from "./AgentApiKeysRows";

/** `agent_global_status` (`services::agent_global`). */
interface AgentGlobalLayer {
  dir: string;
  files: number;
  codexAutoReview: boolean;
}

/** The Tabtivity-wide agent config: the instructions, skills, hooks and MCP
 *  servers every agent home gets, filled from this computer in one click. */
function AgentGlobalRow() {
  const t = useT();
  const [layer, setLayer] = useState<AgentGlobalLayer | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    invoke<AgentGlobalLayer>("agent_global_status")
      .then(setLayer)
      .catch(() => setLayer(null));
  };
  useEffect(refresh, []);
  const importNow = () => {
    setNote(null);
    setBusy(true);
    invoke<{ files: number; configs: number }>("agent_global_import")
      .then((r) => setNote(t("settings.agentGlobalImported", { files: r.files, configs: r.configs })))
      .catch((e: unknown) => setNote(String(e)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.agentGlobal")} <UntestedTag id="settings.agentGlobal" />
        <AgentsHelp text={t("settings.agentGlobalHelp")} />
      </div>
      <div className="agents-row">
        <div className="agents-row-main">
          <AgentsStatus tone={layer && layer.files > 0 ? "ok" : "off"}>
            {layer && layer.files > 0
              ? t("settings.agentGlobalFiles", { count: layer.files })
              : t("settings.agentGlobalEmpty")}
          </AgentsStatus>
        </div>
        <div className="agents-actions">
          <button type="button" className="settings-btn sm" disabled={busy} onClick={importNow}>
            {t("settings.agentGlobalImport")}
          </button>
          <button
            type="button"
            className="settings-btn sm"
            onClick={() => void invoke("agent_global_open").catch((e: unknown) => setNote(String(e)))}
          >
            {t("settings.agentGlobalOpen")}
          </button>
        </div>
      </div>
      {note && <p className="settings-help">{note}</p>}
    </div>
  );
}

/** Codex auto-review (`approvals_reviewer` in the Tabtivity-wide layer's Codex
 *  config). On the Codex card, not under the fence settings: it is what makes
 *  fenced Codex usable, so it sits where a Codex user looks. */
export function CodexAutoReviewToggle() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    invoke<AgentGlobalLayer>("agent_global_status")
      .then((l) => setOn(l.codexAutoReview))
      .catch(() => setOn(null));
  };
  useEffect(refresh, []);
  return (
    <div className="agents-option">
      <ToggleRow
        label={<>{t("settings.codexAutoReview")} <UntestedTag id="settings.codexAutoReview" /></>}
        checked={on ?? false}
        disabled={busy || on === null}
        onChange={(e) => {
          setNote(null);
          setBusy(true);
          invoke("agent_global_set_codex_auto_review", { enabled: e.target.checked })
            .catch((err: unknown) => setNote(String(err)))
            .finally(() => {
              setBusy(false);
              refresh();
            });
        }}
      />
      <p className="settings-help">{t("settings.codexAutoReviewHelp")}</p>
      {note && <p className="settings-help">{note}</p>}
    </div>
  );
}

/** `copilot_fence_auth_status`: the Copilot sign-in Tabtivity holds for fenced
 *  tabs (`services::copilot_auth`). Never carries the token itself. */
interface CopilotFenceAuth {
  supported: boolean;
  signedIn: boolean;
  login: string | null;
  valid: boolean | null;
}

/** Copilot sign-in for fenced tabs: who is signed in, and a way out. Hidden
 *  where the fence leaves the keyring reachable (everything but Linux). */
function CopilotFenceAuthRow() {
  const t = useT();
  const [auth, setAuth] = useState<CopilotFenceAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    invoke<CopilotFenceAuth>("copilot_fence_auth_status")
      .then(setAuth)
      .catch(() => setAuth(null));
  };
  useEffect(refresh, []);
  if (!auth?.supported) return null;

  const state = !auth.signedIn
    ? t("settings.copilotFenceAuthNone")
    : auth.valid === false
      ? t("settings.copilotFenceAuthExpired")
      : auth.login
        ? t("settings.copilotFenceAuthSignedIn", { login: auth.login })
        : t("settings.copilotFenceAuthSignedInOffline");

  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.copilotFenceAuth")} <UntestedTag id="settings.copilotFenceAuth" />
        <AgentsHelp text={t("settings.copilotFenceAuthHelp")} />
      </div>
      <div className="agents-row">
        <div className="agents-row-main">
          <AgentsStatus tone={auth.signedIn && auth.valid !== false ? "ok" : auth.signedIn ? "warn" : "off"}>
            {state}
          </AgentsStatus>
        </div>
        {auth.signedIn && (
          <div className="agents-actions">
            <button
              type="button"
              className="settings-btn sm danger"
              onClick={() => {
                setError(null);
                invoke("copilot_fence_sign_out")
                  .then(refresh)
                  .catch((e: unknown) => setError(String(e)));
              }}
            >
              {t("settings.copilotFenceAuthSignOut")}
            </button>
          </div>
        )}
      </div>
      {error && <p className="settings-help">{error}</p>}
    </div>
  );
}

/** The Accounts & keys group: every credential an agent can run on, and the
 *  config every agent home starts from. `onChange` tells the CLI cards that a
 *  login or key changed, so their sign-in line re-reads. */
export function AgentAccounts({ onChange }: { onChange?: () => void }) {
  // Bumped by the API keys rows, so the logins re-read their "uses API key".
  const [apiKeysVersion, setApiKeysVersion] = useState(0);
  return (
    <div className="agents-stack">
      <AgentLoginsRows refreshKey={apiKeysVersion} onChange={onChange} />
      <AgentApiKeysRows
        onChange={() => {
          setApiKeysVersion((v) => v + 1);
          onChange?.();
        }}
      />
      <AgentGlobalRow />
      <CopilotFenceAuthRow />
    </div>
  );
}
