import { useState } from "react";
import { ApiError, createProject, MAX_PROJECT_NAME, projectFolderName, type ProjectRow } from "../api";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** Make a new project from the phone. Only its name crosses: the desktop
 * creates it as a folder of that name in its projects folder — never an
 * import, never a folder the phone picks — and opens it to this phone alone. */
export function NewProjectSheet({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (project: ProjectRow) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim();
  const folder = projectFolderName(name);
  const tooLong = [...trimmed].length > MAX_PROJECT_NAME;

  const create = async () => {
    if (!trimmed || tooLong || !folder) {
      setError(tooLong ? t("mobile.rename.tooLong", { max: MAX_PROJECT_NAME }) : trimmed ? t("mobile.newProject.invalid") : t("mobile.rename.empty"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      onCreated((await createProject(trimmed)).project);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : "";
      setError(code === "project_exists"
        ? t("mobile.newProject.exists", { folder })
        : code === "invalid_name"
          ? t("mobile.newProject.invalid")
          : code === "mobile_unavailable"
            ? t("mobile.newProject.unavailable")
            : t("mobile.newProject.failed"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.newProject.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}>✕</button><h2>{t("mobile.newProject.title")} {isUntested("mobile.home.newProject") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.newProject.note")}</p>
      {error && <p className="sheet-note error" role="alert">{error}</p>}
      <div className="mobile-schedule-form">
        <label>{t("mobile.newProject.label")}<input
          type="text"
          value={name}
          autoFocus
          maxLength={MAX_PROJECT_NAME}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void create(); } }}
        /></label>
        {folder && <p className="sheet-note">{t("mobile.newProject.folder", { folder })}</p>}
        <div className="mobile-schedule-actions">
          <button disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" disabled={busy || !trimmed} onClick={() => void create()}>{busy ? t("mobile.newProject.creating") : t("mobile.newProject.create")}</button>
        </div>
      </div>
    </section>
  </div>;
}
