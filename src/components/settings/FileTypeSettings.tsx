import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsHeader, SettingsList } from "../layout/settingsUi";
import { diffDefaultApps, patchDefaultApps } from "../../lib/defaultApps";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import type { SubPanelProps } from "./subPanelProps";

export function FileTypeSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [apps, setApps] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ ext: "", app: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<Record<string, string>>("get_default_apps")
      .then(setApps)
      .catch((err) => setError(String(err)));
  }, []);

  const saveApps = (next: Record<string, string>) => {
    // Only the change, so a save from another window or the phone in between
    // is kept (headless owner plan, H1b); the answer is the map as stored.
    const patch = diffDefaultApps(apps, next);
    setApps(next);
    patchDefaultApps(patch, () => next)
      .then(setApps)
      .catch((err) => setError(String(err)));
  };

  const normalizeExt = (ext: string) => {
    const trimmed = ext.trim();
    if (!trimmed) return "";
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  };

  const chooseExecutable = async (ext: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      saveApps({ ...apps, [ext]: picked });
    }
  };

  const addEntry = () => {
    const ext = normalizeExt(draft.ext);
    const app = draft.app.trim();
    if (!ext || !app) return;
    saveApps({ ...apps, [ext]: app });
    setDraft({ ext: "", app: "" });
  };

  return (
    <>
      <SettingsHeader title={t("filetypes.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("filetypes.help")}</p>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      <SettingsList boxed>
        {Object.entries(apps).sort(([a], [b]) => a.localeCompare(b)).map(([ext, app]) => (
          <div className="filetype-settings-row" key={ext}>
            <input
              value={ext}
              onChange={(e) => {
                const nextExt = normalizeExt(e.target.value);
                const { [ext]: old, ...rest } = apps;
                if (nextExt) saveApps({ ...rest, [nextExt]: old });
              }}
            />
            <input
              value={app}
              onChange={(e) => setApps({ ...apps, [ext]: e.target.value })}
              onBlur={(e) => saveApps({ ...apps, [ext]: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveApps({ ...apps, [ext]: e.currentTarget.value.trim() });
              }}
            />
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("filetypes.browseTitle")}
              onClick={() => void chooseExecutable(ext)}
            >
              …
            </button>
            <button
              type="button"
              className="settings-btn sm icon danger"
              onClick={() => {
                const { [ext]: _removed, ...rest } = apps;
                saveApps(rest);
              }}
              title={t("common.remove")}
            >
              ×
            </button>
          </div>
        ))}
        <div className="filetype-settings-row">
          <input
            value={draft.ext}
            placeholder={t("filetypes.extPlaceholder")}
            onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
          />
          <input
            value={draft.app}
            placeholder={t("filetypes.appPlaceholder")}
            onChange={(e) => setDraft({ ...draft, app: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") addEntry();
            }}
          />
          <button type="button" className="settings-btn sm primary" onClick={addEntry}>
            {t("common.add")}
          </button>
        </div>
      </SettingsList>
      </div>
    </>
  );
}
