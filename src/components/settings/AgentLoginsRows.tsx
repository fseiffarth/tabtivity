import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { loginIdForCmd } from "../../lib/agents/signInLaunch";
import { AGENT_ITEMS } from "../../lib/tabs/newTabItems";
import { AgentsHelp, AgentsStatus } from "./agentsUi";

/** One row of `agent_logins` (`services::agent_auth`): a CLI's shared
 *  sign-in across every Tabtivity agent home. Never a token. */
export interface AgentLogin {
  id: string;
  signed_in: boolean;
  account: string | null;
  importable: boolean;
  /** A tab's login the keeper refused: another account, a file that names a
   *  command where a credential belongs, or an entry or field a login file
   *  may not bring (`config`: OpenCode's `wellknown` entries and the like). */
  blocked: {
    account: string | null;
    stored: string | null;
    command: string | null;
    config?: string | null;
  } | null;
  /** OpenCode only: scopes whose own database took a `wellknown` source (it
   *  loads that origin's remote configuration at every start). */
  wellknown_homes?: { key: string; label: string | null; origins: string[] }[];
  shared: boolean;
  /** The API proxy serves this CLI: a server's administrator can offer a key. */
  admin_key_capable?: boolean;
  /** A hosted server's administrator offers a key for this CLI. */
  admin_key_offered?: boolean;
  /** This user's agents run on that key instead of their own login (chosen
   *  in the API keys section's "runs on" control, #2389). */
  uses_admin_key?: boolean;
  /** Switched on for a stored provider API key, and one is saved
   *  (`services::agent_api_keys`). */
  api_key?: boolean;
  /** That key's monthly budget is spent, or no limit is set: its keyed tabs
   *  are refused (`services::api_usage`). */
  api_budget_reached?: boolean;
}

/** The shared agent logins: one row per CLI whose login Tabtivity can share,
 *  with the one-click import from this computer and a way out. `refreshKey`
 *  re-reads them when the API keys below change. */
export function AgentLoginsRows({
  refreshKey = 0,
  onChange,
}: {
  refreshKey?: number;
  /** Called after an import or sign-out, so a view of the same logins (the
   *  Agents section's cards) can re-read them. */
  onChange?: () => void;
}) {
  const t = useT();
  const [logins, setLogins] = useState<AgentLogin[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    invoke<AgentLogin[]>("agent_logins")
      .then(setLogins)
      .catch(() => setLogins(null));
  };
  useEffect(refresh, [refreshKey]);
  const labels = useMemo(() => new Map(AGENT_ITEMS.map((a) => [a.cmd, a.label])), []);
  const registry = useMemo(
    () => new Map(AGENT_ITEMS.map((a) => [loginIdForCmd(a.cmd), a.label])),
    [],
  );
  if (!logins) return null;
  const rows = logins.filter((l) => l.shared);
  const run = (id: string, cmd: "agent_login_import" | "agent_login_sign_out") => {
    setError(null);
    setBusy(id);
    invoke(cmd, { id })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
        onChange?.();
      });
  };
  const signOutScope = (key: string) => {
    setError(null);
    setBusy(`scope:${key}`);
    invoke("agent_login_scope_sign_out", { scope: key })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
        onChange?.();
      });
  };
  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.agentLogins")} <UntestedTag id="settings.agentLogins" />
        <AgentsHelp text={t("settings.agentLoginsHelp")} />
      </div>
      {rows.map((l) => {
        const label = registry.get(l.id) ?? labels.get(l.id) ?? l.id;
        const login = l.signed_in
          ? l.account
            ? t("settings.agentLoginSignedInAs", { account: l.account })
            : t("settings.agentLoginSignedIn")
          : t("agents.loginNone");
        const keyLabel = l.api_budget_reached
          ? t("settings.agentLoginApiBudgetReached")
          : t("settings.agentLoginUsesApiKey");
        const own = !l.api_key ? login : l.signed_in ? `${login} · ${keyLabel}` : keyLabel;
        // A hosted server's administrator's key (plan §5.2): chosen per CLI
        // in the API keys section; here only what the login row runs on.
        const state = l.uses_admin_key
          ? l.admin_key_offered
            ? t("settings.agentLoginAdminKey")
            : t("settings.agentLoginAdminKeyGone")
          : own;
        const ok = l.uses_admin_key ? !!l.admin_key_offered : l.signed_in || (!!l.api_key && !l.api_budget_reached);
        return (
          <Fragment key={l.id}>
            <div className="agents-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{label}</span>
                <AgentsStatus
                  tone={ok ? "ok" : "off"}
                  title={!l.signed_in && !l.api_key && !l.uses_admin_key ? t("settings.agentLoginNotSignedIn") : undefined}
                >
                  {state}
                </AgentsStatus>
                {l.blocked && (
                  <span className="agents-row-note is-warn">
                    {l.blocked.config
                      ? t("settings.agentLoginBlockedConfig", { field: l.blocked.config })
                      : l.blocked.command
                        ? t("settings.agentLoginBlockedCommand", { field: l.blocked.command })
                        : t("settings.agentLoginBlocked", { account: l.blocked.account ?? "", stored: l.blocked.stored ?? "" })}
                    {l.blocked.config && <UntestedTag id="settings.agentLoginWellknown" />}
                  </span>
                )}
              </div>
              <div className="agents-actions">
                {l.importable && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={busy === l.id}
                    onClick={() => run(l.id, "agent_login_import")}
                  >
                    {t("settings.agentLoginImport")}
                  </button>
                )}
                {l.signed_in && (
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={busy === l.id}
                    onClick={() => run(l.id, "agent_login_sign_out")}
                  >
                    {t("settings.agentLoginSignOut")}
                  </button>
                )}
              </div>
            </div>
            {(l.wellknown_homes ?? []).map((h) => (
              <div key={`wellknown:${h.key}`} className="agents-row">
                <div className="agents-row-main">
                  <span className="agents-row-note is-warn">
                    {t("settings.agentLoginWellknown", {
                      scope: h.label ?? (h.key === "host" ? t("settings.agentLoginWellknownHost") : h.key),
                      origins: h.origins.join(", "),
                    })}{" "}
                    <UntestedTag id="settings.agentLoginWellknown" />
                  </span>
                </div>
                <div className="agents-actions">
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={busy === `scope:${h.key}`}
                    onClick={() => signOutScope(h.key)}
                  >
                    {t("settings.agentLoginWellknownSignOut")}
                  </button>
                </div>
              </div>
            ))}
          </Fragment>
        );
      })}
      {error && <p className="settings-help">{error}</p>}
    </div>
  );
}
