import { DialogShell } from "./PromptDialogs";
import { UntestedTag } from "./UntestedTag";
import { useT } from "../../lib/i18n";
import { useOpenExternalStore } from "../../stores/openExternal";

/**
 * The ask before a file goes to the system's default app, and the note when
 * it may not (threat recheck gap 21, decision C2): `lib/openExternal.ts`
 * raises both. Mounted once per window (AppShell, DetachedApp), like
 * `ExecTrustHost`. "Cancel" is the default button: opening is the deliberate
 * act.
 */
export function OpenExternalHost() {
  const pending = useOpenExternalStore((s) => s.pending);
  const answer = useOpenExternalStore((s) => s.answer);
  const t = useT();
  if (!pending) return null;
  const { request } = pending;
  if (request.kind === "refused") {
    return (
      <DialogShell onDismiss={() => answer(false)}>
        <h2>
          {t("openExternal.refusedTitle", { name: request.name })} <UntestedTag id="openExternalConfirm" />
        </h2>
        <p className="file-delete-body">{t("openExternal.refusedBody")}</p>
        <div className="file-delete-path">{request.path}</div>
        <div className="file-delete-actions">
          <button type="button" autoFocus onClick={() => answer(false)}>
            {t("openExternal.ok")}
          </button>
        </div>
      </DialogShell>
    );
  }
  return (
    <DialogShell onDismiss={() => answer(false)}>
      <h2>
        {t("openExternal.title", { name: request.name })} <UntestedTag id="openExternalConfirm" />
      </h2>
      <p className="file-delete-body">{t("openExternal.body")}</p>
      <div className="file-delete-path">{request.path}</div>
      <div className="file-delete-actions">
        <button type="button" autoFocus onClick={() => answer(false)}>
          {t("openExternal.cancel")}
        </button>
        <button type="button" className="btn-primary" onClick={() => answer(true)}>
          {t("openExternal.open")}
        </button>
      </div>
    </DialogShell>
  );
}
