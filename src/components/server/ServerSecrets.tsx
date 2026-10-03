/**
 * The secrets key of a hosted server (plan §6.8): set it up once — the
 * recovery code is shown here, once, and stored nowhere — and, when every
 * paired device is lost, unlock it with that code. Releasing the key after
 * a reboot is the paired phone's or browser's own job at sign-in
 * (`mobile-web/src/secrets.ts`); this panel only says whether it happened.
 *
 * Talks to the daemon's device-session routes (`/api/v1/secrets/*`) through
 * the gateway; shown by `ServerSettings`, i.e. only behind a gateway.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { SettingsCard } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";

interface SecretsState { available: boolean; setUp?: boolean; unlocked?: boolean }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? String(response.status));
  return answer;
}

export function ServerSecrets() {
  const t = useT();
  const [state, setState] = useState<SecretsState | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    call<SecretsState>("/api/v1/secrets").then(setState).catch(() => setState(null));
  }, []);
  useEffect(refresh, [refresh]);

  if (!state?.available) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(t("server.secrets.error", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <>
      <div className="settings-subheader">
        {t("server.secrets.header")} <UntestedTag id="server.secrets" />
      </div>
      <p className="settings-help">{t("server.secrets.help")}</p>
      {code ? (
        <SettingsCard>
          <p className="settings-help">{t("server.secrets.codeIntro")}</p>
          <pre className="settings-prompt-text" data-testid="server-recovery-code">{code}</pre>
          <p className="settings-help">{t("server.secrets.codeLoss")}</p>
          <div className="settings-link-row">
            <button type="button" className="settings-btn sm" onClick={() => setCode(null)}>
              {t("server.secrets.codeSaved")}
            </button>
          </div>
        </SettingsCard>
      ) : !state.setUp ? (
        <div className="settings-link-row">
          <p className="settings-help">{t("server.secrets.notSetUp")}</p>
          <button
            type="button"
            className="settings-btn sm"
            disabled={busy}
            onClick={() => void run(async () => setCode((await call<{ code: string }>("/api/v1/secrets/setup", {})).code))}
          >
            {t("server.secrets.setUp")}
          </button>
        </div>
      ) : state.unlocked ? (
        <div className="settings-link-row">
          <p className="settings-help">{t("server.secrets.unlocked")}</p>
          <button
            type="button"
            className="settings-btn sm"
            disabled={busy}
            onClick={() => void run(async () => setCode((await call<{ code: string }>("/api/v1/secrets/recovery-code", {})).code))}
          >
            {t("server.secrets.newCode")}
          </button>
        </div>
      ) : (
        <SettingsCard>
          <p className="settings-help">{t("server.secrets.locked")}</p>
          <label className="settings-card-label" htmlFor="server-recovery-input">{t("server.secrets.recoveryLabel")}</label>
          <input
            id="server-recovery-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={recovery}
            disabled={busy}
            onChange={(event) => setRecovery(event.target.value)}
          />
          <div className="settings-link-row">
            <button
              type="button"
              className="settings-btn sm"
              disabled={busy || !recovery.trim()}
              onClick={() => void run(async () => {
                await call("/api/v1/secrets/recover", { code: recovery.trim() });
                setRecovery("");
              })}
            >
              {t("server.secrets.recover")}
            </button>
          </div>
        </SettingsCard>
      )}
      {error && <p className="settings-help">{error}</p>}
    </>
  );
}
