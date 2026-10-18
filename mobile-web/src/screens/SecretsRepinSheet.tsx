import { useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { repinWithCode } from "../secrets";
import { useBackLayer } from "../backStack";

/** The server's identity key is not the one this phone pinned (it was lost
 * and made anew, or something in the middle answers): the phone releases
 * nothing to it until the recovery code, checked here on the phone,
 * confirms the new key (`secretsCore.checkRepin`). The code is not sent. */
export function SecretsRepinSheet({ onClose }: { onClose: () => void }) {
  useBackLayer(onClose);
  const t = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const outcome = await repinWithCode(code.trim());
      if (outcome === "mismatch") setNote({ text: t("server.secrets.repin.mismatch"), error: true });
      else {
        setCode("");
        setDone(true);
        setNote({ text: t("server.secrets.repin.done"), error: false });
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      setNote({ text: reason.includes("recovery_outdated") ? t("server.secrets.repin.outdated") : t("server.secrets.error", { error: reason }), error: true });
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("server.secrets.repin.header")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("server.secrets.repin.later")}>✕</button><h2>{t("server.secrets.repin.header")} {isUntested("server.secrets.repin") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("server.secrets.repin.help")}</p>
      {note && <p className={note.error ? "sheet-note error" : "sheet-note"} role={note.error ? "alert" : "status"}>{note.text}</p>}
      <div className="mobile-schedule-form">
        {!done && <label>{t("server.secrets.recoveryLabel")}<input
          type="text"
          value={code}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}
        /></label>}
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>{done ? t("server.secrets.repin.close") : t("server.secrets.repin.later")}</button>
          {!done && <button className="primary" disabled={busy || !code.trim()} onClick={() => void submit()}>{t("server.secrets.repin.submit")}</button>}
        </div>
      </div>
    </section>
  </div>;
}
