/**
 * Agent credentials, the administrator's half (hosted plan §5.4, P3b): an
 * API key per agent CLI, offered to every user of the server, each of whom
 * picks it or their own login in Manage CLIs (§5.2).
 *
 * Talks to the gateway's `/gateway/v1/agent-keys`, which hands keys to the
 * key keeper (`<slug>-auth`) and lists what is on offer — never a key: once
 * saved a key is not shown again, only when, by whom and who used it lately.
 * Which CLIs can take one comes from the daemon's own registry
 * (`agent_logins`' `api_key_env`). Rendered inside the administrator's
 * Server settings only; nothing without a gateway.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS } from "../tabs/newTabItems";
import { loginIdForCmd } from "../../lib/agents/signInLaunch";
import { UntestedTag } from "../common/UntestedTag";
import { PasswordInput } from "../common/PasswordInput";
import { SettingsCard } from "../layout/settingsUi";

const KEYS_URL = "/gateway/v1/agent-keys";

interface KeyStatus {
  cli: string;
  updated: number;
  by: string;
  users: string[];
}

interface LoginRow {
  id: string;
  api_key_env?: string | null;
}

export function ServerAgentKeys() {
  const t = useT();
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [clis, setClis] = useState<{ id: string; env: string }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const labels = useMemo(() => new Map(AGENT_ITEMS.map((a) => [loginIdForCmd(a.cmd), a.label])), []);

  const refresh = () => {
    fetch(KEYS_URL, { credentials: "same-origin" })
      .then(async (response) => {
        if (response.ok) {
          const body = (await response.json()) as { keys?: KeyStatus[] };
          setKeys(body.keys ?? []);
          setUnreachable(false);
        } else {
          setKeys(null);
          setUnreachable(response.status === 502);
        }
      })
      .catch(() => setKeys(null));
  };

  useEffect(() => {
    refresh();
    invoke<LoginRow[]>("agent_logins")
      .then((rows) => setClis((rows ?? []).filter((r) => r.api_key_env).map((r) => ({ id: r.id, env: r.api_key_env as string }))))
      .catch(() => setClis([]));
  }, []);

  if (!keys && !unreachable) return null;

  const change = async (cli: string, key: string | null) => {
    setBusy(cli);
    setStatus(null);
    try {
      const response = await fetch(`${KEYS_URL}/${encodeURIComponent(cli)}`, {
        method: key === null ? "DELETE" : "PUT",
        credentials: "same-origin",
        headers: key === null ? undefined : { "Content-Type": "application/json" },
        body: key === null ? undefined : JSON.stringify({ key }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!response.ok) {
        setStatus(t("server.settings.error", { error: body.detail ?? body.error ?? String(response.status) }));
        return;
      }
      setDrafts((d) => ({ ...d, [cli]: "" }));
      setStatus(t(key === null ? "server.agentKeys.withdrawn" : "server.agentKeys.saved", { label: labels.get(cli) ?? cli }));
      refresh();
    } catch (e) {
      setStatus(t("server.settings.error", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const byCli = new Map((keys ?? []).map((k) => [k.cli, k]));
  return (
    <>
      <div className="settings-subheader">
        {t("server.agentKeys.header")} <UntestedTag id="server.agentKeys" />
      </div>
      <p className="settings-help">{t("server.agentKeys.help")}</p>
      {unreachable && <p className="settings-help">{t("server.agentKeys.unreachable")}</p>}
      {!unreachable &&
        clis.map(({ id, env }) => {
          const offered = byCli.get(id);
          const label = labels.get(id) ?? id;
          const draft = drafts[id] ?? "";
          return (
            <SettingsCard key={id}>
              <label className="settings-card-label" htmlFor={`server-agent-key-${id}`}>
                {label} · <code>{env}</code>
              </label>
              <p className="settings-help">
                {offered
                  ? t("server.agentKeys.offered", { date: new Date(offered.updated * 1000).toLocaleDateString(), by: offered.by })
                  : t("server.agentKeys.notOffered")}
                {offered &&
                  (offered.users.length
                    ? ` · ${t("server.agentKeys.usedBy", { users: offered.users.join(", ") })}`
                    : ` · ${t("server.agentKeys.unused")}`)}
              </p>
              <PasswordInput
                id={`server-agent-key-${id}`}
                autoComplete="off"
                spellCheck={false}
                placeholder={t(offered ? "server.agentKeys.replacePlaceholder" : "server.agentKeys.placeholder")}
                value={draft}
                disabled={busy === id}
                onChange={(event) => setDrafts((d) => ({ ...d, [id]: event.target.value }))}
              />
              <div className="settings-link-row">
                <button type="button" className="settings-btn sm" disabled={busy === id || !draft.trim()} onClick={() => void change(id, draft.trim())}>
                  {t("server.agentKeys.save")}
                </button>
                {offered && (
                  <button type="button" className="settings-btn sm" disabled={busy === id} onClick={() => void change(id, null)}>
                    {t("server.agentKeys.withdraw")}
                  </button>
                )}
              </div>
            </SettingsCard>
          );
        })}
      {status && <p className="settings-help">{status}</p>}
    </>
  );
}
