import { ApiError, uploadToDesktop } from "../api";
import { usePhonePicks, type PickedFile } from "./phonePicks";
import { isUntested } from "../../../src/lib/untested";
import { useT, type TranslationKey } from "../../../src/lib/i18n";

/** Why a file did not reach the desktop's inbox, by the desktop's code. */
const FAILURE_KEYS: Record<string, TranslationKey> = {
  file_too_large: "mobile.sendToDesktop.tooLarge",
  empty_file: "mobile.sendToDesktop.empty",
  inbox_full: "mobile.sendToDesktop.full",
  timeout: "mobile.sendToDesktop.timeout",
  offline: "mobile.sendToDesktop.offline",
};

/**
 * **Send to desktop** — a file for the desktop that belongs to no project (a
 * ticket, a photo to print). It lands in the desktop's own inbox
 * (`<state_dir>/inbox/`), where the header's inbox button lists it; a file for
 * an agent goes through the Focus composer's **+** into the project's inbox
 * instead. Each pick shows a row until it lands, then says so until dismissed.
 */
export function SendToDesktop() {
  const t = useT();
  const picks = usePhonePicks<PickedFile>({
    testId: "send-to-desktop-input",
    tooLarge: t(FAILURE_KEYS.file_too_large),
    send: (file, row, settle) => uploadToDesktop(file, row.name).then(
      () => settle({ state: "sent" }),
      (error: unknown) => {
        const code = error instanceof ApiError ? error.code : "";
        settle({ state: "failed", failure: t(FAILURE_KEYS[code] ?? "mobile.sendToDesktop.failed") });
      },
    ),
  });
  const dismiss = picks.dismiss;

  return <section className="phone-settings" aria-labelledby="send-to-desktop-heading">
    <h2 id="send-to-desktop-heading">{t("mobile.sendToDesktop.heading")}</h2>
    <ul className="option-list">
      <li><button onClick={() => picks.open()}>
        <span><strong>{t("mobile.home.sendToDesktop")}{isUntested("mobile.home.sendToDesktop") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{t("mobile.sendToDesktop.hint")}</small></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></svg>
      </button></li>
    </ul>
    {picks.input}
    {picks.rows.map((upload) => upload.state === "failed"
      ? <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span><button onClick={() => dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.name })}>✕</button></div>
      : <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{t(upload.state === "sent" ? "mobile.sendToDesktop.sent" : "mobile.sendToDesktop.sending")}</span>{upload.state === "sent" && <button onClick={() => dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.name })}>✕</button>}</div>)}
  </section>;
}
