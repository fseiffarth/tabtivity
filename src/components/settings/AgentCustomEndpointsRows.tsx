import { Fragment, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UntestedTag } from "../common/UntestedTag";
import { PasswordInput } from "../common/PasswordInput";
import { useDialogs } from "../common/PromptDialogs";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { AgentsStatus, AgentsFold } from "./agentsUi";
import {
  asMillions,
  currentApiLimits,
  DEFAULT_API_LIMIT_MTOK,
  parseApiLimit,
  tokenCount,
  type AgentApiKeyStatus,
} from "./agentApiKeysShared";

/** The backend's `agent_api_keys::MAX_CUSTOM`. */
const MAX_CUSTOM_ENDPOINTS = 8;

/** Manage CLIs → API keys → Custom endpoints: OpenAI-compatible endpoints
 *  (an institute's API, a local gateway) that OpenCode lists as providers of
 *  their own in `/model`. Same rules as the provider rows: the key goes in
 *  and never comes back (OS keyring), a monthly limit in billed tokens is
 *  required, and a tab gets a proxy token, never the key. The endpoint list
 *  is written by the add/remove/refresh commands only
 *  (`agent_api_custom_endpoint_*`); a limit is an ordinary setting. There is no
 *  price table for a custom endpoint, so only tokens are counted. */
export function AgentCustomEndpointsRows({
  status,
  onChanged,
}: {
  status: AgentApiKeyStatus;
  /** Called after every command, so the parent re-reads the status. */
  onChanged: () => void;
}) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const { confirmAction, dialogs } = useDialogs();
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [limitText, setLimitText] = useState(String(DEFAULT_API_LIMIT_MTOK));
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Custom endpoints are a desktop feature: a hosted server refuses them.
  if (status.store === "vault") return null;
  const endpoints = status.providers.filter((p) => p.endpoint);
  const limits = settings?.agent_api_token_limits ?? {};
  const act = (id: string, call: () => Promise<unknown>) => {
    setError(null);
    setBusy(id);
    return call()
      .then(() => true)
      .catch((e: unknown) => {
        setError(String(e));
        return false;
      })
      .finally(() => {
        setBusy(null);
        onChanged();
      });
  };
  const limit = parseApiLimit(limitText);
  const canAdd =
    status.readable &&
    busy === null &&
    label.trim() !== "" &&
    baseUrl.trim() !== "" &&
    key.trim() !== "" &&
    limit !== null &&
    endpoints.length < MAX_CUSTOM_ENDPOINTS;
  const add = () => {
    if (!canAdd || limit === null) return;
    const args = { label: label.trim(), baseUrl: baseUrl.trim(), key: key.trim(), limitTokens: limit };
    // Out of the page at once, saved or not: the key is never kept around.
    setKey("");
    void act("add", () => invoke("agent_api_custom_endpoint_add", args)).then((ok) => {
      if (!ok) return;
      setLabel("");
      setBaseUrl("");
      setLimitText(String(DEFAULT_API_LIMIT_MTOK));
    });
  };
  const remove = async (slot: number, name: string) => {
    const yes = await confirmAction({
      title: t("settings.agentCustomRemoveTitle", { name }),
      body: t("settings.agentCustomRemoveBody", { name }),
      confirmLabel: t("settings.agentCustomRemove"),
      danger: true,
    });
    if (yes) void act(`custom-${slot}`, () => invoke("agent_api_custom_endpoint_remove", { slot }));
  };
  const setLimit = (id: string) => {
    const tokens = parseApiLimit(limitDrafts[id] ?? "");
    if (tokens === null) return;
    void act(id, async () => {
      await updateSettings({ agent_api_token_limits: { ...(await currentApiLimits(limits)), [id]: tokens } });
      setLimitDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
    });
  };
  return (
    <>
      <div className="settings-subheader agents-subhead">
        {t("settings.agentCustomHeading")} <UntestedTag id="opencode-custom-endpoint" />
      </div>
      <AgentsFold label={t("settings.agentCustomHowItWorks")}>
        <p className="settings-help">{t("settings.agentCustomHelp")}</p>
      </AgentsFold>
      {endpoints.map((p) => {
        const ep = p.endpoint;
        if (!ep) return null;
        const id = p.id;
        const current = p.limitTokens ?? limits[id];
        const draft = limitDrafts[id] ?? (current != null ? asMillions(current) : String(DEFAULT_API_LIMIT_MTOK));
        const draftTokens = parseApiLimit(draft);
        const spent = tokenCount(p.billed ?? 0);
        const budget =
          p.budget === "noLimit" || p.limitTokens == null
            ? t("settings.agentApiNoLimit")
            : p.budget === "reached"
              ? t("settings.agentApiBudgetReached", {
                  spent,
                  limit: tokenCount(p.limitTokens),
                  date: status.resetsOn ?? "",
                })
              : t("settings.agentCustomSpent", {
                  spent,
                  limit: tokenCount(p.limitTokens),
                  left: tokenCount(Math.max(0, p.limitTokens - (p.billed ?? 0))),
                });
        const blocked = p.budget === "reached" || p.budget === "noLimit";
        const state = !status.readable
          ? t("settings.agentApiKeyLocked")
          : p.saved
            ? t("settings.agentApiKeySaved")
            : t("settings.agentApiKeyNotSaved");
        const working = busy === id;
        return (
          <Fragment key={id}>
            <div className="agents-row agents-key-row">
              <div className="agents-row-main">
                <span className="agents-row-name">{ep.label}</span>
                <AgentsStatus tone={!status.readable ? "warn" : p.saved ? "ok" : "off"}>{state}</AgentsStatus>
                <span className="agents-row-note">{ep.host}</span>
                <span className="agents-row-note">{t("settings.agentCustomModelCount", { count: ep.modelCount })}</span>
                {p.priced === false && <span className="agents-row-note">{t("settings.agentCustomNoPrice")}</span>}
                {status.readable && (
                  <span className={`agents-row-note${blocked ? " is-warn" : ""}`}>{budget}</span>
                )}
              </div>
              <div className="agents-key-form">
                {status.readable && (
                  <span className="agents-limit">
                    <input
                      type="number"
                      className="agents-input agents-limit-input"
                      min={0.000001}
                      step="any"
                      value={draft}
                      aria-label={t("settings.agentApiLimitLabel", { provider: ep.label })}
                      title={t("settings.agentApiLimitLabel", { provider: ep.label })}
                      disabled={working}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLimitDrafts((d) => ({ ...d, [id]: value }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setLimit(id);
                      }}
                    />
                    <span className="agents-limit-unit">{t("agents.apiLimitUnit")}</span>
                  </span>
                )}
                {status.readable && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={working || draftTokens === null || draftTokens === p.limitTokens}
                    onClick={() => setLimit(id)}
                  >
                    {t("settings.agentApiLimitSet")}
                  </button>
                )}
                {status.readable && (
                  <button
                    type="button"
                    className="settings-btn sm"
                    disabled={working || !p.saved}
                    onClick={() => void act(id, () => invoke("agent_api_custom_endpoint_refresh_models", { slot: ep.slot }))}
                  >
                    {t("settings.agentCustomRefresh")}
                  </button>
                )}
                {status.readable && (
                  <button
                    type="button"
                    className="settings-btn sm danger"
                    disabled={working}
                    onClick={() => void remove(ep.slot, ep.label)}
                  >
                    {t("settings.agentCustomRemove")}
                  </button>
                )}
              </div>
            </div>
            {ep.modelCount === 0 && (
              <p className="settings-help pill-fence-live-note">{t("settings.agentCustomNoModels", { host: ep.host })}</p>
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
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ))}
          </Fragment>
        );
      })}
      {status.readable && endpoints.length < MAX_CUSTOM_ENDPOINTS && (
        <div className="agents-row agents-key-row">
          <div className="agents-row-main">
            <span className="agents-row-name">{t("settings.agentCustomAdd")}</span>
          </div>
          <div className="agents-key-form">
            <input
              className="agents-input"
              value={label}
              autoComplete="off"
              spellCheck={false}
              maxLength={48}
              placeholder={t("settings.agentCustomNamePlaceholder")}
              aria-label={t("settings.agentCustomNamePlaceholder")}
              disabled={busy === "add"}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <input
              className="agents-input"
              value={baseUrl}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://llm.example.org/v1"
              aria-label={t("settings.agentCustomUrlLabel")}
              disabled={busy === "add"}
              onChange={(e) => setBaseUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <PasswordInput
              className="agents-input"
              value={key}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("settings.agentCustomKeyPlaceholder")}
              aria-label={t("settings.agentCustomKeyPlaceholder")}
              disabled={busy === "add"}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <span className="agents-limit">
              <input
                type="number"
                className="agents-input agents-limit-input"
                min={0.000001}
                step="any"
                value={limitText}
                aria-label={t("settings.agentApiLimitLabel", { provider: label.trim() || t("settings.agentCustomHeading") })}
                disabled={busy === "add"}
                onChange={(e) => setLimitText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
              <span className="agents-limit-unit">{t("agents.apiLimitUnit")}</span>
            </span>
            <button type="button" className="settings-btn sm primary" disabled={!canAdd} onClick={add}>
              {t("settings.agentCustomAddButton")}
            </button>
          </div>
        </div>
      )}
      {error && <p className="settings-help">{error}</p>}
      {dialogs}
    </>
  );
}
