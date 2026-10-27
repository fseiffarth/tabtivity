import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UntestedTag } from "../common/UntestedTag";
import { PasswordInput } from "../common/PasswordInput";
import type { UntestedId } from "../../lib/untested";
import { unlockKeyring } from "../../lib/keyring";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS } from "../../lib/tabs/newTabItems";
import { AgentsStatus, AgentsFold } from "./agentsUi";

/** `agent_api_keys_status` (`services::agent_api_keys`). Never a key. */
interface AgentApiKeyStatus {
  /** The keyring can be read now; while locked every `saved` reads false. */
  readable: boolean;
  /** `keychain` (a desktop's OS store) or `vault` (a server's sealed store,
   *  opened only by a paired device — nothing here can unlock it). */
  store?: "keychain" | "vault";
  providers: {
    id: string;
    saved: boolean;
    /** The monthly limit in billed tokens (`agent_api_token_limits`) as the
     *  backend reads it. */
    limitTokens?: number | null;
    /** Billed tokens this month: what the limit counts. */
    billed?: number;
    /** Their cost by the price table — an estimate, shown only. */
    spentUsd?: number;
    /** An older build's dollar limit while no token limit is set: a hint. */
    legacyLimitUsd?: number | null;
    /** `open`, `reached`, or `noLimit` (refused until a limit is set). */
    budget?: "open" | "reached" | "noLimit";
    /** Models priced at the provider's highest rate (not in the table). */
    unknownModels?: string[];
    /** This month by model, most billed first: input and output apart. */
    models?: {
      model: string;
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      requests: number;
      billed: number;
      usd: number;
    }[];
    /** The workspace a saved Anthropic key that is not scoped to one names. */
    workspace?: string | null;
  }[];
  clis: {
    id: string;
    enabled: boolean;
    providers: string[];
    ready: boolean;
    /** A hosted server's administrator offers this user a key for the CLI. */
    adminOffered?: boolean;
    /** This user runs the CLI on the administrator's key. */
    usesAdmin?: boolean;
    /** Through the server's key broker: this month's use and budget. */
    adminBroker?: { month: string; billed: number; budget?: number | null } | null;
  }[];
  /** UTC month counted (`YYYY-MM`) and the day the count restarts. */
  month?: string;
  resetsOn?: string;
  /** This month's count restarted: the ledger file could not be read. */
  ledgerRestarted?: string | null;
  /** When the price table was read off the vendors' pages. */
  pricesDate?: string;
}

/** `agent_api_key_set`'s answer: saved, or an Anthropic key that is not
 *  scoped to a workspace — saved only once one of `workspaces` is picked (an
 *  id typed in when the key could list none). */
type ApiKeySave = { kind: "saved" } | { kind: "pickWorkspace"; workspaces: { id: string; name: string }[] };

/** The monthly limit a new key's row proposes, in million billed tokens. */
export const DEFAULT_API_LIMIT_MTOK = 5;
/** The backend's `api_usage::MAX_LIMIT`, billed tokens. */
const MAX_API_LIMIT_TOKENS = 1_000_000_000_000;
const MILLION = 1_000_000;

/** A typed limit (million billed tokens) as whole billed tokens, or `null`
 *  when it is not a usable one. */
function parseApiLimit(text: string): number | null {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n)) return null;
  const tokens = Math.round(n * MILLION);
  return tokens > 0 && tokens <= MAX_API_LIMIT_TOKENS ? tokens : null;
}

/** Billed tokens as the limit field shows them: millions, no trailing zeros. */
const asMillions = (tokens: number) => String(Number((tokens / MILLION).toFixed(6)));

const usd = (n: number) => `$${n.toFixed(2)}`;
const tokenCount = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Provider names as their vendors spell them. */
const API_KEY_PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai: "OpenAI",
};

/** What a CLI's agents run on: its own login, the user's own API key, or a
 *  hosted server administrator's key (#2389). */
type Credential = "login" | "key" | "admin";

/** The CLIs that can take a stored key through the API proxy (the backend's
 *  `CLI_ROUTES`: only CLIs the spawn alone can point at the proxy), each
 *  with its own pill — literal ids, which is what `scripts/untested.mjs` reads. */
const API_KEY_CLIS: { cli: string; untested: UntestedId }[] = [
  { cli: "claude", untested: "settings.agentApiKeys.claude" },
  { cli: "gemini", untested: "settings.agentApiKeys.gemini" },
  { cli: "codex", untested: "settings.agentApiKeys.codex" },
  { cli: "opencode", untested: "settings.agentApiKeys.opencode" },
];

/** Provider API keys for the agent CLIs: one key per provider, kept in the OS
 *  keyring only — typed here, saved, never read back — and a switch per CLI
 *  that should start on it (`agent_api_key_clis`, off by default). A keyed tab
 *  gets a proxy token, never the key (`services::api_proxy`). */
export function AgentApiKeysRows({ onChange }: { onChange?: () => void }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [status, setStatus] = useState<AgentApiKeyStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A key waiting for its workspace: held here (never in the page) only
  // until the user picks one or cancels.
  const pendingKey = useRef<Record<string, string>>({});
  const [picking, setPicking] = useState<{ provider: string; workspaces: { id: string; name: string }[] } | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const refresh = () => {
    invoke<AgentApiKeyStatus>("agent_api_keys_status")
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(refresh, []);
  const labels = useMemo(() => new Map(AGENT_ITEMS.map((a) => [a.cmd, a.label])), []);
  if (!status) return null;
  const saved = new Set(status.providers.filter((p) => p.saved).map((p) => p.id));
  const enabled = settings?.agent_api_key_clis ?? [];
  const limits = settings?.agent_api_token_limits ?? {};
  // A new key's row proposes the default; a saved key's shows its limit.
  const limitDraft = (id: string, current?: number | null) => {
    const tokens = current ?? limits[id];
    return limitDrafts[id] ?? (tokens != null ? asMillions(tokens) : String(DEFAULT_API_LIMIT_MTOK));
  };
  const writeLimit = (id: string, limit: number) =>
    updateSettings({ agent_api_token_limits: { ...limits, [id]: limit } });
  const act = (id: string, call: () => Promise<unknown>) => {
    setError(null);
    setBusy(id);
    call()
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(null);
        refresh();
        onChange?.();
      });
  };
  const save = (id: string) => {
    const key = (drafts[id] ?? "").trim();
    // A key is only saved with a monthly limit: the limit goes first, so the
    // backend (which refuses a key without one) finds it.
    const limit = parseApiLimit(limitDraft(id));
    if (!key || limit === null) return;
    // Out of the page at once, saved or not: the key is never kept around.
    setDrafts((d) => ({ ...d, [id]: "" }));
    act(id, async () => {
      await writeLimit(id, limit);
      const answer = await invoke<ApiKeySave | null>("agent_api_key_set", { provider: id, key });
      if (answer?.kind === "pickWorkspace") {
        pendingKey.current[id] = key;
        setWorkspaceDraft(answer.workspaces[0]?.id ?? "");
        setPicking({ provider: id, workspaces: answer.workspaces });
      }
    });
  };
  const endPicking = (id: string) => {
    delete pendingKey.current[id];
    setPicking(null);
    setWorkspaceDraft("");
  };
  // Saved with the picked workspace; refused (one the key cannot use), the
  // picker stays for another choice.
  const saveWorkspace = (id: string) => {
    const key = pendingKey.current[id];
    const workspace = workspaceDraft.trim();
    if (!key || !workspace) return;
    act(id, async () => {
      await invoke("agent_api_key_set", { provider: id, key, workspace });
      endPicking(id);
    });
  };
  const setLimit = (id: string) => {
    const limit = parseApiLimit(limitDraft(id));
    if (limit === null) return;
    act(id, async () => {
      await writeLimit(id, limit);
      setLimitDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
    });
  };
  // The own-key switch lives in the shared settings; the administrator's key
  // is the user's choice on the server (`agent_login_use_admin_key`, which
  // also switches the own key off — written here first, so the settings
  // store never holds a stale switch).
  const setCredential = (cli: string, from: Credential, to: Credential) => {
    if (from === to) return;
    const others = enabled.filter((c) => c !== cli);
    act(cli, async () => {
      if (from === "admin") await invoke("agent_login_use_admin_key", { id: cli, on: false });
      if (from === "key") await updateSettings({ agent_api_key_clis: others });
      if (to === "key") await updateSettings({ agent_api_key_clis: [...others, cli] });
      if (to === "admin") await invoke("agent_login_use_admin_key", { id: cli, on: true });
    });
  };
  return (
    <div className="agents-block">
      <div className="settings-subheader">
        {t("settings.agentApiKeys")} <UntestedTag id="settings.agentApiKeys" />
      </div>
      <p className="settings-help">
        {t("settings.agentApiLimitHelp", { date: status.resetsOn ?? "", priced: status.pricesDate ?? "" })}{" "}
        <UntestedTag id="settings.agentApiKeys.limit" />
      </p>
      <AgentsFold label={t("agents.apiHowItWorks")}>
        <p className="settings-help">{t("settings.agentApiKeysHelp")}</p>
        <p className="settings-help">{t("settings.agentApiKeysWarning")}</p>
        <p className="settings-help">{t("settings.agentApiKeysDialogs")}</p>
        <p className="settings-help">{t("settings.agentApiKeysCodexHelp")}</p>
      </AgentsFold>
      {status.ledgerRestarted && (
        <p className="settings-help pill-fence-live-note">
          {t("settings.agentApiLedgerRestarted", { date: status.ledgerRestarted })}
        </p>
      )}
      {status.providers.map((p) => {
        const name = API_KEY_PROVIDERS[p.id] ?? p.id;
        const draft = drafts[p.id] ?? "";
        const limitText = limitDraft(p.id, p.limitTokens);
        const limitOk = parseApiLimit(limitText) !== null;
        const spent = tokenCount(p.billed ?? 0);
        const budget = !p.saved
          ? null
          : p.budget === "noLimit" || p.limitTokens == null
            ? t("settings.agentApiNoLimit")
            : p.budget === "reached"
              ? t("settings.agentApiBudgetReached", {
                  spent,
                  limit: tokenCount(p.limitTokens),
                  date: status.resetsOn ?? "",
                })
              : t("settings.agentApiSpent", {
                  spent,
                  limit: tokenCount(p.limitTokens),
                  left: tokenCount(Math.max(0, p.limitTokens - (p.billed ?? 0))),
                  usd: usd(p.spentUsd ?? 0),
                });
        const state = !status.readable
          ? t(status.store === "vault" ? "settings.agentApiKeyVaultLocked" : "settings.agentApiKeyLocked")
          : p.saved
            ? t("settings.agentApiKeySaved")
            : t("settings.agentApiKeyNotSaved");
        const limitInput = (
          <span className="agents-limit">
            <input
              type="number"
              className="agents-input agents-limit-input"
              min={0.000001}
              step="any"
              value={limitText}
              aria-label={t("settings.agentApiLimitLabel", { provider: name })}
              title={t("settings.agentApiLimitLabel", { provider: name })}
              disabled={busy === p.id}
              onChange={(e) => {
                const value = e.target.value;
                setLimitDrafts((d) => ({ ...d, [p.id]: value }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (p.saved ? setLimit : save)(p.id);
              }}
            />
            <span className="agents-limit-unit">{t("agents.apiLimitUnit")}</span>
          </span>
        );
        const blocked = p.saved && (p.budget === "reached" || p.budget === "noLimit");
        return (
          <Fragment key={p.id}>
            <div className="agents-row agents-key-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{name}</span>
                <AgentsStatus tone={!status.readable ? "warn" : p.saved ? "ok" : "off"}>{state}</AgentsStatus>
                {budget && status.readable && (
                  <span className={`agents-row-note${blocked ? " is-warn" : ""}`}>{budget}</span>
                )}
                {p.saved && p.workspace && (
                  <span className="agents-row-note">{t("settings.agentApiWorkspace", { id: p.workspace })}</span>
                )}
              </div>
              <div className="agents-key-form">
                {status.readable && !p.saved && (
                  <PasswordInput
                    className="agents-input"
                    value={draft}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("settings.agentApiKeyPlaceholder", { provider: name })}
                    aria-label={t("settings.agentApiKeyPlaceholder", { provider: name })}
                    disabled={busy === p.id}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDrafts((d) => ({ ...d, [p.id]: value }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save(p.id);
                    }}
                  />
                )}
                {status.readable && limitInput}
                {status.readable && p.saved && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={busy === p.id || !limitOk || parseApiLimit(limitText) === p.limitTokens}
                    onClick={() => setLimit(p.id)}
                  >
                    {t("settings.agentApiLimitSet")}
                  </button>
                )}
                {status.readable && !p.saved && (
                  <button
                    type="button"
                    className="settings-btn sm primary"
                    disabled={busy === p.id || !draft.trim() || !limitOk}
                    onClick={() => save(p.id)}
                  >
                    {t("settings.agentApiKeySave")}
                  </button>
                )}
                {status.readable && p.saved && (
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={busy === p.id}
                    onClick={() => act(p.id, () => invoke("agent_api_key_clear", { provider: p.id }))}
                  >
                    {t("settings.agentApiKeyRemove")}
                  </button>
                )}
              </div>
            </div>
            {picking?.provider === p.id && !p.saved && (
              <div className="agents-row agents-key-row">
                <p className="settings-help">
                  {t(picking.workspaces.length > 0 ? "settings.agentApiWorkspacePick" : "settings.agentApiWorkspaceType")}{" "}
                  <UntestedTag id="settings.agentApiKeys.workspace" />
                </p>
                <div className="agents-key-form">
                  {picking.workspaces.length > 0 ? (
                    <Dropdown
                      title={t("settings.agentApiWorkspaceLabel")}
                      ariaLabel={t("settings.agentApiWorkspaceLabel")}
                      value={workspaceDraft}
                      disabled={busy === p.id}
                      options={picking.workspaces.map((w) => ({
                        value: w.id,
                        label: w.name === w.id ? w.id : `${w.name} (${w.id})`,
                      }))}
                      onChange={setWorkspaceDraft}
                    />
                  ) : (
                    <input
                      className="agents-input"
                      value={workspaceDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="wrkspc_…"
                      aria-label={t("settings.agentApiWorkspaceLabel")}
                      disabled={busy === p.id}
                      onChange={(e) => setWorkspaceDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWorkspace(p.id);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="settings-btn sm primary"
                    disabled={busy === p.id || !workspaceDraft.trim()}
                    onClick={() => saveWorkspace(p.id)}
                  >
                    {t("settings.agentApiKeySave")}
                  </button>
                  <button type="button" className="settings-btn sm" disabled={busy === p.id} onClick={() => endPicking(p.id)}>
                    {t("settings.agentApiWorkspaceCancel")}
                  </button>
                </div>
              </div>
            )}
            {p.saved && p.limitTokens == null && p.legacyLimitUsd != null && (
              <p className="settings-help pill-fence-live-note">
                {t("settings.agentApiOldUsdLimit", { usd: usd(p.legacyLimitUsd) })}
              </p>
            )}
            {status.readable &&
              (p.models ?? []).map((m) => (
                <p key={m.model} className="settings-help">
                  {[
                    t("settings.agentApiModelUsage", {
                      model: m.model,
                      input: tokenCount(m.input),
                      output: tokenCount(m.output),
                    }),
                    m.cacheRead > 0 && t("settings.agentApiModelCacheRead", { tokens: tokenCount(m.cacheRead) }),
                    m.cacheWrite > 0 && t("settings.agentApiModelCacheWrite", { tokens: tokenCount(m.cacheWrite) }),
                    `≈ ${usd(m.usd)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ))}
            {p.saved && (p.unknownModels?.length ?? 0) > 0 && (
              <p className="settings-help">
                {t("settings.agentApiUnknownModels", { provider: name, models: (p.unknownModels ?? []).join(", ") })}
              </p>
            )}
          </Fragment>
        );
      })}
      {!status.readable && status.store !== "vault" && (
        <div className="agents-actions">
          <button
            type="button"
            className="settings-btn sm primary"
            disabled={busy === "unlock"}
            onClick={() => act("unlock", unlockKeyring)}
          >
            {t("settings.agentApiKeyUnlock")}
          </button>
        </div>
      )}
      <div className="settings-subheader agents-subhead">{t("agents.credHeading")}</div>
      {API_KEY_CLIS.map(({ cli, untested }) => {
        const row = status.clis.find((c) => c.id === cli);
        if (!row) return null;
        const name = labels.get(cli) ?? cli;
        const keyed = row.providers.filter((p) => saved.has(p));
        const hasKey = keyed.length > 0;
        // One credential per CLI (#2389): its own login, the user's own API
        // key, or a hosted server administrator's key — never two at once.
        const current: Credential = row.usesAdmin ? "admin" : enabled.includes(cli) ? "key" : "login";
        const options = [
          { value: "login", label: t("settings.agentCredLogin") },
          ...(hasKey || current === "key"
            ? [
                {
                  value: "key",
                  label: t("settings.agentCredOwnKey", {
                    // Only the providers a key is saved for: the others
                    // stay on the CLI's own login (OpenCode).
                    providers: (hasKey ? keyed : row.providers).map((p) => API_KEY_PROVIDERS[p] ?? p).join(", "),
                  }),
                },
              ]
            : []),
          ...(row.adminOffered || current === "admin" ? [{ value: "admin", label: t("settings.agentCredAdminKey") }] : []),
        ];
        const broker = row.usesAdmin ? row.adminBroker : null;
        return (
          <Fragment key={cli}>
            <div className="agents-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{t("settings.agentCredRunsOn", { cli: name })}</span>
                <UntestedTag id={untested} />
                {(row.adminOffered || row.usesAdmin) && <UntestedTag id="agents.adminKey" />}
                {broker && (
                  <span className="agents-row-note">
                    <UntestedTag id="server.agentKeys.broker" />{" "}
                    {broker.budget != null
                      ? t("settings.agentLoginBrokerUsage", {
                          billed: broker.billed.toLocaleString(),
                          budget: broker.budget.toLocaleString(),
                        })
                      : t("settings.agentLoginBrokerUsageNoCap", { billed: broker.billed.toLocaleString() })}
                  </span>
                )}
              </div>
              <Dropdown
                value={current}
                options={options}
                disabled={busy === cli || options.length < 2}
                ariaLabel={t("settings.agentCredRunsOn", { cli: name })}
                title={row.adminOffered && !row.usesAdmin ? t("settings.agentLoginAdminKeyHelp") : undefined}
                onChange={(next) => setCredential(cli, current, next as Credential)}
              />
            </div>
            {row.usesAdmin && !row.adminOffered && (
              <p className="settings-help pill-fence-live-note">{t("settings.agentLoginAdminKeyGone")}</p>
            )}
          </Fragment>
        );
      })}
      {error && <p className="settings-help">{error}</p>}
    </div>
  );
}
