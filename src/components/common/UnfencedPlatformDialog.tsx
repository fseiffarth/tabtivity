import { useEffect } from "react";
import { useUnfencedPlatformStore } from "../../stores/unfencedPlatformPrompt";
import { useT } from "../../lib/i18n";
import { DialogShell } from "./PromptDialogs";
import { UntestedTag } from "./UntestedTag";

/**
 * The one-time acceptance a fence-less platform (Windows) asks for before the
 * first local agent tab starts: agents there run with the user's full rights,
 * and Tabtivity says so instead of starting one silently. Mounted once per window
 * (AppShell and DetachedApp) like the HPC guard; `stores/unfencedPlatformPrompt`
 * owns the lifecycle and remembers the answer in settings.
 */
export function UnfencedPlatformDialog() {
  const t = useT();
  const open = useUnfencedPlatformStore((s) => s.waiting.length > 0);
  const accept = useUnfencedPlatformStore((s) => s.accept);
  const cancel = useUnfencedPlatformStore((s) => s.cancel);
  const registerHost = useUnfencedPlatformStore((s) => s.registerHost);
  useEffect(() => registerHost(), [registerHost]);

  if (!open) return null;

  return (
    <DialogShell onDismiss={cancel}>
      <h2>
        {t("unfencedPlatform.title")} <UntestedTag id="unfencedPlatformDialog.1" />
      </h2>
      <p className="file-delete-body">{t("unfencedPlatform.body")}</p>
      <p className="file-delete-body">{t("unfencedPlatform.alternative")}</p>
      <div className="file-delete-actions">
        <button type="button" autoFocus onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="button" onClick={() => void accept()}>
          {t("unfencedPlatform.accept")}
        </button>
      </div>
    </DialogShell>
  );
}
