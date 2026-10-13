import type { ReactNode } from "react";
import { ApiError, uploadToProjectInbox } from "../api";
import { usePhonePicks, type PickedFile } from "./phonePicks";
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

interface Upload extends PickedFile {
  /** The project-relative `.tabtivity/inbox/<file>` once it landed. */
  reference?: string;
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
  const picks = usePhonePicks<Upload>({
    testId: "project-inbox-input",
    tooLarge: t(FAILURE_KEYS.file_too_large),
    send: (file, row, settle) => uploadToProjectInbox(projectId, file, row.name).then(
      (attachment) => settle({ state: "sent", reference: attachment.reference }),
      (error: unknown) => {
        const code = error instanceof ApiError ? error.code : "";
        settle({ state: "failed", failure: t(FAILURE_KEYS[code] ?? "mobile.projectInbox.failed") });
      },
    ),
  });
  const dismiss = picks.dismiss;

  // No clipboard (an insecure origin, a refused permission) leaves the
  // reference on screen, which is still the whole answer.
  const copy = (reference: string) => { void navigator.clipboard?.writeText(`@${reference} `).catch(() => undefined); };

  const view = <>
    {picks.input}
    {picks.rows.map((upload) => {
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

  return { open: () => picks.open(), view };
}
