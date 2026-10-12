/**
 * Connect to a server (hosted plan §7.2, P5), the desktop's half: pair this
 * computer with a Tabtivity server by an invite code, then open the server's
 * workspace in a **Connect** window of its own, beside this app's own
 * workspace (Q12). The window runs this app's own frontend; its commands go
 * to the server, its clipboard, notifications and window controls stay here.
 *
 * Desktop only: a browser or phone client of a server never shows it.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { isServerClient } from "../../lib/transport/linkState";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

interface Paired {
  origin: string;
  device_id: string;
  device_name: string;
}

export function ConnectToServer() {
  const t = useT();
  const [paired, setPaired] = useState<Paired | null>(null);
  const [origin, setOrigin] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isServerClient()) return;
    invoke<Paired | null>("connect_status")
      .then((p) => setPaired(p ?? null))
      .catch(() => setPaired(null));
  }, []);

  if (isServerClient()) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-subheader">
        {t("connect.header")} <UntestedTag id="connect.window" />
      </div>
      <p className="settings-help">{t("connect.help")}</p>
      {paired ? (
        <>
          <p className="settings-help">{t("connect.paired", { origin: paired.origin, name: paired.device_name })}</p>
          <div className="settings-link-row">
            <button type="button" className="settings-btn sm" disabled={busy} onClick={() => void run(() => invoke("connect_open"))}>
              {t("connect.open")}
            </button>
            <button
              type="button"
              className="settings-btn sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await invoke("connect_forget");
                  setPaired(null);
                })
              }
            >
              {t("connect.forget")}
            </button>
          </div>
          <p className="settings-help">{t("connect.forgetHelp")}</p>
        </>
      ) : (
        <>
          <div className="settings-link-row">
            <input
              className="ollama-pull-input"
              aria-label={t("connect.origin")}
              placeholder={t("connect.origin")}
              value={origin}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setOrigin(e.target.value.trim())}
            />
          </div>
          <div className="settings-link-row">
            <input
              className="ollama-pull-input"
              aria-label={t("connect.code")}
              placeholder={t("connect.code")}
              value={code}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setCode(e.target.value.trim())}
            />
            <input
              className="ollama-pull-input"
              aria-label={t("connect.deviceName")}
              placeholder={t("connect.deviceName")}
              value={name}
              disabled={busy}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className="settings-btn sm"
              disabled={busy || !origin || !code || !name.trim()}
              onClick={() =>
                void run(async () => {
                  setPaired(await invoke<Paired>("connect_pair", { origin, code, deviceName: name.trim() }));
                  setCode("");
                })
              }
            >
              {t("connect.pair")}
            </button>
          </div>
        </>
      )}
      {error && <ErrorNote className="project-dialog-error" error={error} />}
    </>
  );
}
