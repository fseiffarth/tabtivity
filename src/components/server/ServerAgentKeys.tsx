/**
 * Agent credentials, the administrator's half (hosted plan §5.4, P3b): an
 * API key per agent CLI, offered to the users the administrator puts on its
 * list (nobody until then), each of whom picks it or their own login in
 * Manage CLIs (§5.2).
 *
 * Talks to the gateway's `/gateway/v1/agent-keys`, which hands keys to the
 * key keeper (`<slug>-auth`) and lists what is on offer — never a key: once
 * saved a key is not shown again, only when, by whom and who used it lately.
 * Which CLIs can take one comes from the daemon's own registry
 * (`agent_logins`' `api_key_env`). Rendered inside the administrator's
 * Server settings only; nothing without a gateway.
 *
 * P5: a CLI the key broker serves can be switched to broker delivery —
 * users then get a token of their own, never the key — with a monthly budget
 * per user (or a default) and this month's use per user; a user's token can
 * be renewed, which cuts off their running agents without rotating the key.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS } from "../tabs/newTabItems";
import { loginIdForCmd } from "../../lib/agents/signInLaunch";
import { UntestedTag } from "../common/UntestedTag";
import { PasswordInput } from "../common/PasswordInput";
import { Dropdown } from "../common/Dropdown";
import { SettingsCard } from "../layout/settingsUi";

const KEYS_URL = "/gateway/v1/agent-keys";
/** The CLIs the key broker serves (`keys_wire::BROKER_CLIS`): only those
 * whose base-URL override is documented. */
const BROKER_CLIS = new Set(["claude"]);

interface MonthUsage {
  user: string;
  month: string;
  billed: number;
  requests: number;
  budget?: number | null;
}

interface KeyStatus {
  cli: string;
  updated: number;
  by: string;
  users: string[];
  /** The accounts allowed to use it; nobody else's agents can. */
  allowed?: string[];
  /** Delivered through the key broker (P5). */
  broker?: boolean;
  default_budget?: number | null;
  budgets?: Record<string, number>;
  usage?: MonthUsage[];
}

/** A budget field's text as a token count; empty → no budget. */
function parseBudget(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/[\s_,.']/g, "");
  if (!trimmed) return null;
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : undefined;
}

interface LoginRow {
  id: string;
  api_key_env?: string | null;
}

export function ServerAgentKeys() {
  const t = useT();
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [unreachable, setUnreachable] = useState(false);
  const [clis, setClis] = useState<{ id: string; env: string }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const labels = useMemo(() => new Map(AGENT_ITEMS.map((a) => [loginIdForCmd(a.cmd), a.label])), []);

  const refresh = () => {
    fetch(KEYS_URL, { credentials: "same-origin" })
      .then(async (response) => {
        if (response.ok) {
          const body = (await response.json()) as { keys?: KeyStatus[]; accounts?: string[] };
          setKeys(body.keys ?? []);
          setAccounts(body.accounts ?? []);
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

  const setUsers = async (cli: string, users: string[]) => {
    setBusy(cli);
    setStatus(null);
    try {
      const response = await fetch(`${KEYS_URL}/${encodeURIComponent(cli)}/users`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!response.ok) {
        setStatus(t("server.settings.error", { error: body.detail ?? body.error ?? String(response.status) }));
        return;
      }
      setPicks((p) => ({ ...p, [cli]: "" }));
      setStatus(t("server.agentKeys.usersSaved", { label: labels.get(cli) ?? cli }));
      refresh();
    } catch (e) {
      setStatus(t("server.settings.error", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  /** One administrator's change to a key (delivery, budget, token): PUT or
   * POST `body` to `<cli>/<path>`, then the list again. */
  const send = async (cli: string, path: string, method: "PUT" | "POST", body: unknown, done: string) => {
    setBusy(cli);
    setStatus(null);
    try {
      const response = await fetch(`${KEYS_URL}/${encodeURIComponent(cli)}/${path}`, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!response.ok) {
        setStatus(t("server.settings.error", { error: answer.detail ?? answer.error ?? String(response.status) }));
        return;
      }
      setStatus(done);
      refresh();
    } catch (e) {
      setStatus(t("server.settings.error", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const saveBudget = (cli: string, user: string | null, text: string) => {
    const tokens = parseBudget(text);
    if (tokens === undefined) {
      setStatus(t("server.agentKeys.budgetInvalid"));
      return;
    }
    void send(cli, "budget", "PUT", user ? { user, tokens } : { tokens }, t("server.agentKeys.budgetSaved")).then(() =>
      setBudgetDrafts((d) => ({ ...d, [`${cli}/${user ?? ""}`]: "" })),
    );
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
              {offered && (
                <>
                  <p className="settings-help">
                    <UntestedTag id="server.agentKeys.users" />{" "}
                    {offered.allowed?.length
                      ? t("server.agentKeys.allowed", { users: offered.allowed.join(", ") })
                      : t("server.agentKeys.allowedNone")}
                  </p>
                  <div className="settings-link-row">
                    {(offered.allowed ?? []).map((user) => (
                      <button
                        key={user}
                        type="button"
                        className="settings-btn sm"
                        disabled={busy === id}
                        onClick={() => void setUsers(id, (offered.allowed ?? []).filter((u) => u !== user))}
                      >
                        {t("server.agentKeys.removeUser", { user })}
                      </button>
                    ))}
                    {accounts.some((a) => !(offered.allowed ?? []).includes(a)) && (
                      <>
                        <Dropdown
                          ariaLabel={t("server.agentKeys.pickUser")}
                          placeholder={t("server.agentKeys.pickUser")}
                          value={picks[id] ?? ""}
                          disabled={busy === id}
                          options={accounts.filter((a) => !(offered.allowed ?? []).includes(a)).map((a) => ({ value: a, label: a }))}
                          onChange={(v) => setPicks((p) => ({ ...p, [id]: v }))}
                        />
                        <button
                          type="button"
                          className="settings-btn sm"
                          disabled={busy === id || !picks[id]}
                          onClick={() => void setUsers(id, [...(offered.allowed ?? []), picks[id]])}
                        >
                          {t("server.agentKeys.addUser")}
                        </button>
                      </>
                    )}
                  </div>
                  {BROKER_CLIS.has(id) && (
                    <BrokerControls
                      cli={id}
                      label={label}
                      offered={offered}
                      busy={busy === id}
                      drafts={budgetDrafts}
                      setDraft={(slot, value) => setBudgetDrafts((d) => ({ ...d, [slot]: value }))}
                      onDelivery={(broker) =>
                        void send(id, "delivery", "PUT", { broker }, t("server.agentKeys.deliverySaved", { label }))
                      }
                      onBudget={(user, text) => saveBudget(id, user, text)}
                      onRenew={(user) => void send(id, "renew-token", "POST", { user }, t("server.agentKeys.tokenRenewed", { user }))}
                    />
                  )}
                </>
              )}
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

/** The broker part of one offered key's card (P5): delivery switch,
 * the default budget, and per allowed user their month and own budget. */
function BrokerControls(props: {
  cli: string;
  label: string;
  offered: KeyStatus;
  busy: boolean;
  drafts: Record<string, string>;
  setDraft: (slot: string, value: string) => void;
  onDelivery: (broker: boolean) => void;
  onBudget: (user: string | null, text: string) => void;
  onRenew: (user: string) => void;
}) {
  const t = useT();
  const { cli, offered, busy, drafts, setDraft } = props;
  const usage = new Map((offered.usage ?? []).map((u) => [u.user, u]));
  const budgetOf = (user: string) => offered.budgets?.[user] ?? offered.default_budget ?? null;
  const budgetField = (user: string | null, placeholder: string) => {
    const slot = `${cli}/${user ?? ""}`;
    return (
      <div className="settings-link-row">
        <input
          className="ollama-pull-input"
          inputMode="numeric"
          aria-label={placeholder}
          placeholder={placeholder}
          value={drafts[slot] ?? ""}
          disabled={busy}
          onChange={(event) => setDraft(slot, event.target.value)}
        />
        <button type="button" className="settings-btn sm" disabled={busy} onClick={() => props.onBudget(user, drafts[slot] ?? "")}>
          {t("server.agentKeys.saveBudget")}
        </button>
      </div>
    );
  };
  return (
    <>
      <p className="settings-help">
        <UntestedTag id="server.agentKeys.broker" />{" "}
        {t(offered.broker ? "server.agentKeys.brokerOn" : "server.agentKeys.brokerOff")}
      </p>
      <div className="settings-link-row">
        <button type="button" className="settings-btn sm" disabled={busy} onClick={() => props.onDelivery(!offered.broker)}>
          {t(offered.broker ? "server.agentKeys.direct" : "server.agentKeys.broker")}
        </button>
      </div>
      {offered.broker && (
        <>
          <p className="settings-help">
            {offered.default_budget != null
              ? t("server.agentKeys.defaultBudgetIs", { tokens: offered.default_budget.toLocaleString() })
              : t("server.agentKeys.defaultBudgetNone")}
          </p>
          {budgetField(null, t("server.agentKeys.defaultBudget"))}
          {(offered.allowed ?? []).map((user) => {
            const used = usage.get(user);
            const budget = budgetOf(user);
            return (
              <div key={user}>
                <p className="settings-help">
                  {budget != null
                    ? t("server.agentKeys.usage", { user, billed: (used?.billed ?? 0).toLocaleString(), budget: budget.toLocaleString() })
                    : t("server.agentKeys.usageNoCap", { user, billed: (used?.billed ?? 0).toLocaleString() })}
                </p>
                {budgetField(user, t("server.agentKeys.userBudget", { user }))}
                <div className="settings-link-row">
                  <button type="button" className="settings-btn sm" disabled={busy} onClick={() => props.onRenew(user)}>
                    {t("server.agentKeys.renewToken", { user })}
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
