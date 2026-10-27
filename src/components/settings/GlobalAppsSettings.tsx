import { useEffect, useState } from "react";
import { SettingsHeader, SettingsList } from "../layout/settingsUi";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../stores/settings";
import type { GlobalAppEntry } from "../../types";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { SubPanelProps } from "./subPanelProps";

/** The external programs a user can name here. `browser` is what PDF links
 *  open in (`lib/linkTarget`); the header launcher that once ran the rest is
 *  gone, but configured commands are kept in settings rather than dropped. */
const GLOBAL_APP_ROLES: Array<{ key: string; labelKey: TranslationKey; fallback: string }> = [
  { key: "browser", labelKey: "globalApp.role.browser", fallback: "◎" },
  { key: "password_manager", labelKey: "globalApp.role.password_manager", fallback: "⚿" },
  { key: "video_conf", labelKey: "globalApp.role.video_conf", fallback: "▣" },
  { key: "screenshot", labelKey: "globalApp.role.screenshot", fallback: "▤" },
  { key: "screen_recorder", labelKey: "globalApp.role.screen_recorder", fallback: "●" },
  { key: "chat", labelKey: "globalApp.role.chat", fallback: "☏" },
];

export function GlobalAppsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const [apps, setApps] = useState<Record<string, GlobalAppEntry>>(settings?.global_apps ?? {});

  useEffect(() => {
    setApps(settings?.global_apps ?? {});
  }, [settings?.global_apps]);

  const saveApps = (next: Record<string, GlobalAppEntry>) => {
    setApps(next);
    void updateSettings({ global_apps: next });
  };

  const updateRole = (role: string, patch: Partial<GlobalAppEntry>) => {
    const current = apps[role] ?? { exec: "", visible: true };
    saveApps({ ...apps, [role]: { ...current, ...patch } });
  };

  const chooseExecutable = async (role: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      updateRole(role, { exec: picked });
    }
  };

  return (
    <>
      <SettingsHeader title={t("globalApps.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("globalApps.help")}</p>
      <SettingsList boxed>
        {GLOBAL_APP_ROLES.map((role) => {
          const entry = apps[role.key] ?? { exec: "", visible: true };
          const roleLabel = t(role.labelKey);
          return (
            <div className="global-app-settings-row" key={role.key}>
              <span className="settings-role-icon" aria-hidden>{role.fallback}</span>
              <span className="settings-role-label">{roleLabel}</span>
              <input
                value={entry.exec}
                placeholder={t("globalApps.notFoundPlaceholder")}
                onChange={(e) => setApps({ ...apps, [role.key]: { ...entry, exec: e.target.value } })}
                onBlur={(e) => updateRole(role.key, { exec: e.target.value.trim() })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateRole(role.key, { exec: e.currentTarget.value.trim() });
                }}
              />
              <button
                type="button"
                className="settings-btn sm icon"
                title={t("globalApps.browseTitle", { role: roleLabel })}
                onClick={() => void chooseExecutable(role.key)}
              >
                …
              </button>
            </div>
          );
        })}
      </SettingsList>
      </div>
    </>
  );
}
