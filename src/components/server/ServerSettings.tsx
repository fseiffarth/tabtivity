/**
 * The browser client's Server settings (hosted plan §6.7, §3.3): the user's
 * own feature switches, and — for the administrator — the server-wide
 * policy the gateway keeps (feature switches, the Ollama model allowlist).
 *
 * Talks to the gateway's own small API (`/gateway/v1/policy`), not to the
 * daemon: the policy is the gateway's file, and only the gateway knows who
 * is the administrator. Rendered nothing unless this page is the browser
 * client and a gateway answers (a single-user sidecar has none).
 */
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { isServerClient } from "../../lib/transport/linkState";
import { useSettingsStore } from "../../stores/settings";
import { SettingsCard, ToggleRow } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";

type Feature = "mail" | "calendar" | "todo";
const FEATURES: Feature[] = ["mail", "calendar", "todo"];

interface Policy {
  schema: number;
  features: { mail: boolean; calendar: boolean; todo: boolean; calendar_sharing: boolean };
  ollama_allowed_models?: string[];
}

const POLICY_URL = "/gateway/v1/policy";

export function ServerSettings() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [admin, setAdmin] = useState(false);
  const [models, setModels] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isServerClient()) return;
    let live = true;
    fetch(POLICY_URL, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { policy: Policy; role: string };
        if (!live) return;
        setPolicy(body.policy);
        setAdmin(body.role === "admin");
        setModels((body.policy.ollama_allowed_models ?? []).join("\n"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!policy) return null;

  const disabled = new Set(settings?.disabled_features ?? []);
  const setMine = (feature: Feature, on: boolean) => {
    const next = new Set(disabled);
    if (on) next.delete(feature);
    else next.add(feature);
    void updateSettings({ disabled_features: [...next].sort() });
  };

  const save = async (next: Policy) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(POLICY_URL, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await response.json().catch(() => ({}))) as { policy?: Policy; error?: string; detail?: string };
      if (!response.ok || !body.policy) {
        setStatus(t("server.settings.error", { error: body.detail ?? body.error ?? String(response.status) }));
        return;
      }
      setPolicy(body.policy);
      setStatus(t("server.settings.saved"));
    } catch (e) {
      setStatus(t("server.settings.error", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const modelList = models
    .split("\n")
    .map((m) => m.trim())
    .filter(Boolean);

  return (
    <>
      <div className="settings-subheader">
        {t("server.settings.header")} <UntestedTag id="server.settings" />
      </div>
      <p className="settings-help">{t("server.settings.help")}</p>
      {FEATURES.map((feature) => (
        <ToggleRow
          key={feature}
          label={t(`server.settings.${feature}`)}
          checked={policy.features[feature] && !disabled.has(feature)}
          disabled={!policy.features[feature]}
          title={policy.features[feature] ? undefined : t("server.settings.offByAdmin")}
          onChange={(event) => setMine(feature, event.target.checked)}
        />
      ))}
      {admin && (
        <>
          <div className="settings-subheader">
            {t("server.settings.adminHeader")} <UntestedTag id="server.settings.admin" />
          </div>
          <p className="settings-help">{t("server.settings.adminHelp")}</p>
          {FEATURES.map((feature) => (
            <ToggleRow
              key={`admin-${feature}`}
              label={t(`server.settings.${feature}`)}
              checked={policy.features[feature]}
              disabled={busy}
              onChange={(event) => void save({ ...policy, features: { ...policy.features, [feature]: event.target.checked } })}
            />
          ))}
          <ToggleRow
            label={t("server.settings.sharing")}
            checked={policy.features.calendar_sharing}
            disabled={busy}
            onChange={(event) => void save({ ...policy, features: { ...policy.features, calendar_sharing: event.target.checked } })}
          />
          <SettingsCard>
            <label className="settings-card-label" htmlFor="server-allowed-models">{t("server.settings.models")}</label>
            <textarea
              id="server-allowed-models"
              className="settings-prompt-text"
              rows={4}
              value={models}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setModels(event.target.value)}
            />
            <p className="settings-help">{t("server.settings.modelsHelp")}</p>
          </SettingsCard>
          <div className="settings-link-row">
            <button
              type="button"
              className="settings-btn sm"
              disabled={busy}
              onClick={() => void save({ ...policy, ollama_allowed_models: modelList.length ? modelList : undefined })}
            >
              {t("server.settings.save")}
            </button>
          </div>
        </>
      )}
      {status && <p className="settings-help">{status}</p>}
    </>
  );
}
