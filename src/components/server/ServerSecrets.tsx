/**
 * The secrets key of a hosted server (plan §6.8): set it up once — the
 * recovery code is shown here, once, and stored nowhere — and, when every
 * paired device is lost, unlock it with that code. Releasing the key after
 * a reboot is the paired phone's or browser's own job at sign-in
 * (`mobile-web/src/secrets.ts`); this panel only says whether it happened.
 *
 * Set-up and a new recovery code are signed by this browser's pairing key
 * (the same origin's IndexedDB as the phone app at `/`), not only its
 * session cookie. When the daemon's identity key is not the one this
 * browser pinned, the panel asks for the recovery code and re-pins only if
 * the code confirms the new key (`mobile-web/src/secretsCore.ts`).
 *
 * Talks to the daemon's device-session routes (`/api/v1/secrets/*`) through
 * the gateway; shown by `ServerSettings`, i.e. only behind a gateway.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { SettingsCard } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { loadSecrets, repinIdentity, signedAction, unlockWith, type Post } from "../../../mobile-web/src/secretsCore";

interface SecretsState { available: boolean; setUp?: boolean; unlocked?: boolean; recoveryCode?: boolean; identity?: string | null }

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

const post: Post = (path, body) => call(path, body);

/** The identity this browser pinned, if it holds one (no IndexedDB, or a
 * browser that never paired at `/`: none). */
async function pinnedIdentity(): Promise<string | null> {
  try {
    return (await loadSecrets())?.identity ?? null;
  } catch {
    return null;
  }
}

export function ServerSecrets() {
  const t = useT();
  const [state, setState] = useState<SecretsState | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [recovery, setRecovery] = useState("");
  const [repin, setRepin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    call<SecretsState>("/api/v1/secrets").then(setState).catch(() => setState(null));
    void pinnedIdentity().then(setPinned);
  }, []);
  useEffect(refresh, [refresh]);

  if (!state?.available) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setError(
        reason === "unpaired" ? t("server.secrets.unpaired")
          : reason === "recovery_outdated" ? t("server.secrets.repin.outdated")
            : t("server.secrets.error", { error: reason }),
      );
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const signed = async (path: string, action: string) => (await call<{ code: string }>(path, await signedAction(action, post))).code;
  const untrusted = !!state.identity && !!pinned && state.identity !== pinned;

  return (
    <>
      <div className="settings-subheader">
        {t("server.secrets.header")} <UntestedTag id="server.secrets" />
      </div>
      <p className="settings-help">{t("server.secrets.help")}</p>
      {untrusted && !code && (
        <SettingsCard>
          <p className="settings-help">
            {t("server.secrets.repin.header")} <UntestedTag id="server.secrets.repin" />
          </p>
          <p className="settings-help">{t("server.secrets.repin.help")}</p>
          <label className="settings-card-label" htmlFor="server-repin-input">{t("server.secrets.recoveryLabel")}</label>
          <input
            id="server-repin-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={repin}
            disabled={busy}
            onChange={(event) => setRepin(event.target.value)}
          />
          <div className="settings-link-row">
            <button
              type="button"
              className="settings-btn sm"
              disabled={busy || !repin.trim()}
              onClick={() => void run(async () => {
                const outcome = await repinIdentity(repin.trim(), post);
                if (outcome === "mismatch") {
                  setError(t("server.secrets.repin.mismatch"));
                  return;
                }
                setRepin("");
                if (!state.unlocked) await unlockWith(post);
                setNote(t("server.secrets.repin.done"));
              })}
            >
              {t("server.secrets.repin.submit")}
            </button>
          </div>
        </SettingsCard>
      )}
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
            onClick={() => void run(async () => setCode(await signed("/api/v1/secrets/setup", "secrets-setup")))}
          >
            {t("server.secrets.setUp")}
          </button>
        </div>
      ) : state.unlocked ? (
        <div className="settings-link-row">
          <p className="settings-help">
            {state.recoveryCode === false ? t("server.secrets.noRecoveryCode") : t("server.secrets.unlocked")}
          </p>
          <button
            type="button"
            className="settings-btn sm"
            disabled={busy}
            onClick={() => void run(async () => setCode(await signed("/api/v1/secrets/recovery-code", "secrets-recovery-code")))}
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
      {note && <p className="settings-help" role="status">{note}</p>}
      {error && <p className="settings-help">{error}</p>}
    </>
  );
}
