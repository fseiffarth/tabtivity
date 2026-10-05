import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../../lib/i18n";
import { formatSize } from "../../lib/mail";
import { UntestedTag } from "../common/UntestedTag";
import { BRAND } from "../../lib/brand";
import { LegacyNamesSummary } from "./LegacyNamesSummary";
import { SettingRow, SettingsHeader } from "./settingsUi";
import type {
  InstallOutcome,
  StagedUpdate,
  UpdateCheck,
  UpdateProgress,
} from "../../types/update";

/**
 * Settings → Updates: is there a newer Tabtivity on the project's GitHub releases
 * page, and install it.
 *
 * The panel checks on mount, which is the one place an automatic request is
 * honest — the user navigated to a screen whose entire subject is that
 * question. Nothing else here polls, and Tabtivity never checks in the background.
 *
 * The three-step shape (check → download → install) is deliberate rather than
 * one button: the middle step can take minutes on a 150 MB artifact, and the
 * last one closes the app on two of the three platforms. A user who has just
 * been told what changed should be the one to decide when that happens.
 *
 * Restarting is *always* the user's: no branch here relaunches Tabtivity, because
 * a window holds live terminals and open tabs.
 */
export function UpdatesPanel({
  onBack,
  onClose,
}: {
  onBack: () => void;
  onClose?: () => void;
}) {
  const t = useT();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedUpdate | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [busy, setBusy] = useState<"download" | "install" | null>(null);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
  // The releases page, asked of the backend so the repository is named in one
  // place. Loaded independently of the check: a failed check is exactly when
  // the way to the page by hand matters.
  const [releasesUrl, setReleasesUrl] = useState<string | null>(null);
  // The panel can close mid-download; a resolved invoke must not set state then.
  // Re-armed on mount rather than only initialized, because StrictMode's
  // mount/unmount/mount would otherwise leave it false for the real mount.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await invoke<UpdateCheck>("check_app_update");
      if (alive.current) setCheck(result);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
    // A download from earlier in this session survives reopening the panel.
    void invoke<StagedUpdate | null>("app_update_staged")
      .then((info) => {
        if (alive.current && info) setStaged(info);
      })
      .catch(() => {});
    void invoke<string>("app_update_releases_url")
      .then((url) => {
        if (alive.current) setReleasesUrl(url);
      })
      .catch(() => {});
  }, [runCheck]);

  useEffect(() => {
    const un = listen<UpdateProgress>("app-update-progress", (e) => {
      if (alive.current) setProgress(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const download = async () => {
    setBusy("download");
    setError(null);
    setProgress({ received: 0, total: check?.asset?.size ?? null });
    try {
      const info = await invoke<StagedUpdate>("download_app_update");
      if (alive.current) setStaged(info);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  };

  const install = async () => {
    setBusy("install");
    setError(null);
    try {
      const result = await invoke<InstallOutcome>("install_app_update");
      if (alive.current) setOutcome(result);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // This release's own page when a check landed, the releases index otherwise.
  const releasePage = check?.htmlUrl ?? releasesUrl;
  const openReleasePage = () => {
    if (releasePage) void invoke("open_external_url", { url: releasePage }).catch(() => {});
  };

  const pct =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  // What the *installed* build can do with a download, which is why a `.deb`
  // user is told to finish by hand instead of being handed a dead button.
  const kind = staged?.installKind ?? check?.installKind ?? "manual";
  const installHelp = {
    appimage: t("updates.installAppimageHelp"),
    nsis: t("updates.installNsisHelp"),
    dmg: t("updates.installDmgHelp"),
    manual: t("updates.installManualHelp"),
  }[kind];

  return (
    <>
      <SettingsHeader
        title={<>{t("nav.updates.title")} <UntestedTag id="nav.updates.title" /></>}
        onBack={onBack}
        onClose={onClose}
      />
      <div className="dialog-scroll">
      {/* The name with its tagline: there is no About panel, and the bare
          name reads like a browser extension's. */}
      <p className="settings-help app-update-tagline">
        <strong>{BRAND.display}</strong> — {t("brand.tagline")}
      </p>
      <p className="settings-help">{t("updates.help")}</p>

      <SettingRow
        label={t("updates.installedVersion")}
        control={<span className="app-update-version">{check?.current ?? "…"}</span>}
      />

      {checking && <p className="settings-help">{t("updates.checking")}</p>}

      {!checking && error && <div className="app-update-error">{error}</div>}

      {!checking && !error && check && !check.updateAvailable && (
        <div className="app-update-status">{t("updates.upToDate")}</div>
      )}

      {!checking && !error && check?.updateAvailable && (
        <div className="app-update-release">
          <div className="app-update-release-head">
            <span className="app-update-release-title">
              {check.name ?? t("updates.versionAvailable", { version: check.latest ?? "" })}
            </span>
            {check.publishedAt && (
              <span className="app-update-release-date">
                {check.publishedAt.slice(0, 10)}
              </span>
            )}
          </div>
          {check.notes && <pre className="app-update-notes">{check.notes}</pre>}
          {!check.asset && (
            <div className="app-update-status">{t("updates.noAssetForPlatform")}</div>
          )}
        </div>
      )}

      {busy === "download" && (
        <div className="app-update-progress">
          <div className="app-update-bar">
            <div
              className={`app-update-bar-fill${pct == null ? " indeterminate" : ""}`}
              style={pct != null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="app-update-progress-text">
            {pct != null
              ? t("updates.downloadingPercent", { percent: String(pct) })
              : t("updates.downloading")}
          </div>
        </div>
      )}

      {staged && busy !== "download" && (
        <div className="app-update-status">
          {t("updates.downloaded", {
            name: staged.name,
            size: formatSize(staged.bytes),
          })}
        </div>
      )}

      {outcome && (
        <div className="app-update-status done">
          {outcome.installerLaunched
            ? t("updates.installerLaunched")
            : outcome.restartRequired
              ? t("updates.restartToApply")
              : t("updates.savedTo", { path: outcome.path })}
        </div>
      )}

      <p className="settings-help">{installHelp}</p>

      <div className="settings-link-row app-update-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={() => void runCheck()}
          disabled={checking || busy != null}
        >
          {checking ? t("updates.checking") : t("updates.checkNow")}
        </button>
        {check?.updateAvailable && check.asset && !staged && (
          <button
            type="button"
            className="settings-btn primary"
            onClick={() => void download()}
            disabled={busy != null}
          >
            {t("updates.download", { size: formatSize(check.asset.size) })}
          </button>
        )}
        {staged && (
          // On `manual` this reveals where the file landed rather than running
          // it — the same command, because "what happens next" is the backend's
          // answer to give, not a second decision made in the renderer.
          <button
            type="button"
            className="settings-btn primary"
            onClick={() => void install()}
            disabled={busy != null}
          >
            {busy === "install"
              ? t("updates.installing")
              : kind === "manual"
                ? t("updates.whereIsIt")
                : t("updates.install")}
          </button>
        )}
        {releasePage && (
          <button type="button" className="settings-btn" onClick={openReleasePage}>
            {t("updates.openReleasePage")}
          </button>
        )}
      </div>
      <LegacyNamesSummary />
      </div>
    </>
  );
}
