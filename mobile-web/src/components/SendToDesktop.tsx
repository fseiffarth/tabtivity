import { useRef, useState } from "react";
import { ANY_FILE_ACCEPT, ApiError, MAX_INBOX_FILE, pickPhoneFiles, uploadToDesktop } from "../api";
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

interface Upload {
  id: number;
  name: string;
  state: "sending" | "sent" | "failed";
  failure?: string;
}

/**
 * **Send to desktop** — a file for the desktop that belongs to no project (a
 * ticket, a photo to print). It lands in the desktop's own inbox
 * (`<state_dir>/inbox/`), where the header's inbox button lists it; a file for
 * an agent goes through the Focus composer's **+** into the project's inbox
 * instead. Each pick shows a row until it lands, then says so until dismissed.
 */
export function SendToDesktop() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [uploads, setUploads] = useState<Upload[]>([]);

  const update = (id: number, patch: Partial<Upload>) =>
    setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, ...patch } : upload));
  const dismiss = (id: number) => setUploads((current) => current.filter((upload) => upload.id !== id));

  const send = (files: ArrayLike<File> | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = ++seq.current;
      const name = file.name || "attachment";
      if (file.size > MAX_INBOX_FILE) {
        setUploads((current) => [...current, { id, name, state: "failed", failure: t(FAILURE_KEYS.file_too_large) }]);
        continue;
      }
      setUploads((current) => [...current, { id, name, state: "sending" }]);
      void uploadToDesktop(file, name).then(
        () => update(id, { state: "sent" }),
        (error: unknown) => {
          const code = error instanceof ApiError ? error.code : "";
          update(id, { state: "failed", failure: t(FAILURE_KEYS[code] ?? "mobile.sendToDesktop.failed") });
        },
      );
    }
  };

  return <section className="phone-settings" aria-labelledby="send-to-desktop-heading">
    <h2 id="send-to-desktop-heading">{t("mobile.sendToDesktop.heading")}</h2>
    <ul className="option-list">
      <li><button onClick={() => pickPhoneFiles(input.current, send)}>
        <span><strong>{t("mobile.home.sendToDesktop")}{isUntested("mobile.home.sendToDesktop") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{t("mobile.sendToDesktop.hint")}</small></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></svg>
      </button></li>
    </ul>
    <input ref={input} type="file" accept={ANY_FILE_ACCEPT} multiple hidden aria-hidden="true" tabIndex={-1} data-testid="send-to-desktop-input" onChange={(event) => { send(event.target.files); event.target.value = ""; }} />
    {uploads.map((upload) => upload.state === "failed"
      ? <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span><button onClick={() => dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.name })}>✕</button></div>
      : <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{t(upload.state === "sent" ? "mobile.sendToDesktop.sent" : "mobile.sendToDesktop.sending")}</span>{upload.state === "sent" && <button onClick={() => dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.name })}>✕</button>}</div>)}
  </section>;
}
