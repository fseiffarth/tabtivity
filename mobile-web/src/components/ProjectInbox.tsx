import { useRef, useState, type ReactNode } from "react";
import { ANY_FILE_ACCEPT, ApiError, MAX_INBOX_FILE, pickPhoneFiles, uploadToProjectInbox } from "../api";
import { useT, type TranslationKey } from "../../../src/lib/i18n";

/** Why a file did not reach the project's inbox, by the desktop's code. */
const FAILURE_KEYS: Record<string, TranslationKey> = {
  file_too_large: "mobile.sendToDesktop.tooLarge",
  empty_file: "mobile.sendToDesktop.empty",
  inbox_full: "mobile.projectInbox.full",
  project_unavailable: "mobile.projectInbox.unavailable",
  project_not_found: "mobile.projectInbox.notShared",
  timeout: "mobile.sendToDesktop.timeout",
  offline: "mobile.sendToDesktop.offline",
};

interface Upload {
  id: number;
  name: string;
  state: "sending" | "sent" | "failed";
  /** The project-relative `.tabtivity/inbox/<file>` once it landed. */
  reference?: string;
  failure?: string;
}

/**
 * The project screen's **＋ → Send a file from this phone**: a document into
 * the project's own inbox (`.tabtivity/inbox/`, the same drop box the Focus
 * composer's **+** fills), for whichever agent works here next — the screen
 * has no session to name, and a project with every tab closed still takes it.
 * `open` must run inside the tap that asked for it (the picker needs the
 * gesture); `view` is the row per pick, which stays until dismissed and
 * offers the `@` reference an agent reads it by.
 */
export function useProjectInbox(projectId: string): { open: () => void; view: ReactNode } {
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
      void uploadToProjectInbox(projectId, file, name).then(
        (attachment) => update(id, { state: "sent", reference: attachment.reference }),
        (error: unknown) => {
          const code = error instanceof ApiError ? error.code : "";
          update(id, { state: "failed", failure: t(FAILURE_KEYS[code] ?? "mobile.projectInbox.failed") });
        },
      );
    }
  };

  // No clipboard (an insecure origin, a refused permission) leaves the
  // reference on screen, which is still the whole answer.
  const copy = (reference: string) => { void navigator.clipboard?.writeText(`@${reference} `).catch(() => undefined); };

  const view = <>
    <input ref={input} type="file" accept={ANY_FILE_ACCEPT} multiple hidden aria-hidden="true" tabIndex={-1} data-testid="project-inbox-input" onChange={(event) => { send(event.target.files); event.target.value = ""; }} />
    {uploads.map((upload) => {
      const close = <button onClick={() => dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.name })}>✕</button>;
      if (upload.state === "failed") return <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span>{close}</div>;
      if (upload.state === "sending") return <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{t("mobile.projectInbox.sending")}</span></div>;
      return <div key={upload.id} className="inbox-upload" role="status">
        <strong>{upload.name}</strong>
        <span>{t("mobile.projectInbox.sent", { reference: `@${upload.reference ?? ""}` })}</span>
        {upload.reference && <button onClick={() => copy(upload.reference ?? "")} aria-label={t("mobile.projectInbox.copyLabel", { name: upload.name })}>{t("mobile.projectInbox.copy")}</button>}
        {close}
      </div>;
    })}
  </>;

  return { open: () => pickPhoneFiles(input.current, send), view };
}
