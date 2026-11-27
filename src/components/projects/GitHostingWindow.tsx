import { useEffect, useState } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useT } from "../../lib/i18n";
import type { GitHostingInfo, GitProvider, ProjectEntry } from "../../types";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { ErrorNote } from "../common/ErrorNote";
import { DialogShell } from "../common/PromptDialogs";
import { GitTokenScopes, tokenPageUrl } from "../common/GitTokenScopes";
import { providerName } from "./projectTypeTags";
import { guessProvider } from "./PublishWindow";
import { openExternalUrl } from "../../lib/externalLinks";

/**
 * A project's own git hosting: a profile URL and an access token that
 * override Settings → Git Hosting for this project only. Opened from the
 * pill menu's "Git hosting…" and the side panel's project settings.
 */
export function GitHostingWindow({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const getProjectGitHosting = useProjectsStore((s) => s.getProjectGitHosting);
  const setProjectGitHosting = useProjectsStore((s) => s.setProjectGitHosting);
  const [info, setInfo] = useState<GitHostingInfo | null>(null);
  const [profileUrl, setProfileUrl] = useState("");
  const [newToken, setNewToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getProjectGitHosting(project.id)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        setProfileUrl(i.profile_url ?? "");
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [project.id, getProjectGitHosting]);

  // A typed token always wins over a "remove" request, so clearing only applies
  // when the user hasn't also entered a replacement.
  const effectiveClear = clearToken && !newToken.trim();

  const tokenStatus = (() => {
    if (newToken.trim()) return t("pill.tokenStatusWillSet");
    if (effectiveClear) return t("pill.tokenStatusWillRemove");
    if (info?.has_token) return t("pill.tokenStatusHasToken");
    if (info?.has_global_token) return t("pill.tokenStatusInherits");
    return t("pill.tokenStatusNone");
  })();

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await setProjectGitHosting(project.id, {
        profileUrl: profileUrl.trim() || null,
        token: newToken.trim() || null,
        clearToken: effectiveClear,
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  const globalUrl = info?.global_profile_url ?? "";
  // Which provider's token page to link to: the URL field being edited (live,
  // so it updates as the user types) wins, else the field it inherits, else
  // the project's own best guess.
  const tokenProvider: GitProvider = (profileUrl || globalUrl).toLowerCase().includes("gitlab")
    ? "gitlab"
    : guessProvider(project);

  return (
    <DialogShell frame="project-dialog" title={t("pill.gitHostingTitle", { name: project.name })} onDismiss={onClose}>
      <div className="project-dialog-path">{t("pill.gitHostingDesc")}</div>

      <label>
        {t("git.profileUrl")}
        <input
          type="text"
          value={profileUrl}
          placeholder={
            globalUrl ? t("pill.inheritsGlobal", { url: globalUrl }) : t("git.profileUrlPlaceholder")
          }
          onChange={(e) => setProfileUrl(e.target.value)}
        />
      </label>

      <label>
        {info?.has_token ? t("pill.replaceToken") : t("git.accessToken")}
        <PasswordInput
          value={newToken}
          placeholder={info?.has_token ? t("pill.enterNewToken") : t("git.tokenPlaceholder")}
          onChange={(e) => {
            setNewToken(e.target.value);
            if (e.target.value) setClearToken(false);
          }}
        />
      </label>
      <span className="ssh-optional-hint">
        {t("pill.getTokenHint")}{" "}
        <button
          type="button"
          className="inline-link-btn"
          onClick={() =>
            void openExternalUrl(tokenPageUrl(tokenProvider, profileUrl || globalUrl)).catch(() => {})
          }
        >
          {t("pill.getTokenCta", { provider: providerName(tokenProvider) })}
        </button>
      </span>
      <GitTokenScopes provider={tokenProvider} />
      <div className="project-dialog-path">{tokenStatus}</div>
      {info?.has_token && !newToken.trim() && (
        <label className="settings-switch-row">
          <span>{t("pill.removeProjectToken")}</span>
          <Toggle
            checked={clearToken}
            onChange={(e) => setClearToken(e.target.checked)}
          />
        </label>
      )}

      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <div className="project-dialog-actions">
        <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
        <button type="button" onClick={() => void save()} disabled={saving || !info}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </DialogShell>
  );
}
