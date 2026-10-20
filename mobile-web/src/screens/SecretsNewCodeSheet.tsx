import { useState } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { makeNewRecoveryCode } from "../secrets";
import { useBackLayer } from "../backStack";

/** A device was disconnected after the recovery code was made (user
 * decision 2026-10-03): the old code's re-pin check is known to whoever
 * holds that device and an old copy of the server's files, so the phone
 * offers a new code once per sign-in. The code is made with this phone's
 * pairing-key signature and shown here once; Later keeps the advice for the
 * next sign-in and the Server settings. */
export function SecretsNewCodeSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  // A code on screen is closed only by its own button, once written down.
  useBackLayer(code ? null : onClose);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await makeNewRecoveryCode());
    } catch (cause) {
      setError(t("server.secrets.error", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={code ? undefined : onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("server.secrets.newCodeHeader")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>{code ? <span className="sheet-close" aria-hidden="true" /> : <button className="sheet-close" onClick={onClose} aria-label={t("server.secrets.newCodeLater")}>✕</button>}<h2>{t("server.secrets.newCodeHeader")} {isUntested("server.secrets.newCodeAdvice") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      {code ? <>
        <p className="sheet-note">{t("server.secrets.codeIntro")}</p>
        <pre className="sheet-note" data-testid="mobile-recovery-code">{code}</pre>
        <p className="sheet-note">{t("server.secrets.codeLoss")}</p>
      </> : <p className="sheet-note">{t("server.secrets.newCodeAdvice")}</p>}
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="mobile-schedule-form">
        <div className="mobile-schedule-actions">
          {code
            ? <button className="primary" onClick={onClose}>{t("server.secrets.codeSaved")}</button>
            : <>
              <button disabled={busy} onClick={onClose}>{t("server.secrets.newCodeLater")}</button>
              <button className="primary" disabled={busy} onClick={() => void make()}>{t("server.secrets.newCodeNow")}</button>
            </>}
        </div>
      </div>
    </section>
  </div>;
}
