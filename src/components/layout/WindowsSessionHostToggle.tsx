import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { experimentalEnabled } from "../../lib/experimental";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { useDialogs } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { ToggleCard } from "./settingsUi";

/**
 * The one way to switch the Windows session host's agents off: ask, end every
 * session in the host (`local_tmux_kill_app_sessions`) BEFORE the setting is
 * saved, then save. A no saves nothing; a failed end saves nothing and says so.
 *
 * Saving first would strand live host agents: the next window load stamps
 * their tabs as not wrapped (`PaneSlot`), the spawn names no session, and the
 * tab resumes the same conversation in-process beside the host's agent. So
 * both switches that turn new tabs away from the host — the experimental flag
 * and, while the flag is on, Persistent local sessions — go through here.
 */
function useEndHostSessionsThenSave() {
  const t = useT();
  const { confirmAction, showMessage, dialogs } = useDialogs();
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const endThenSave = async (title: string, patch: Partial<Settings>) => {
    const ok = await confirmAction({
      title,
      body: t("settings.windowsSessionHostOffBody"),
      confirmLabel: t("settings.windowsSessionHostOffConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke<void>("local_tmux_kill_app_sessions");
    } catch (err) {
      await showMessage({
        title: t("settings.windowsSessionHostOffFailedTitle"),
        body: t("settings.windowsSessionHostOffFailedBody", { error: String(err) }),
        error: true,
      });
      return;
    }
    await updateSettings(patch);
  };
  return { endThenSave, dialogs };
}

/**
 * Settings → Experimental → Windows session host (Windows only; the caller
 * gates the platform). Turning it on reaches new agent tabs only (each tab's
 * wrap is stamped when it is drawn, `PaneSlot`); turning it off goes through
 * `useEndHostSessionsThenSave`.
 */
export function WindowsSessionHostToggle() {
  const t = useT();
  const on = useSettingsStore((s) => experimentalEnabled(s.settings, "windows_session_host"));
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { endThenSave, dialogs } = useEndHostSessionsThenSave();

  const change = async (next: boolean) => {
    if (next) await updateSettings({ windows_session_host: true });
    else await endThenSave(t("settings.windowsSessionHostOffTitle"), { windows_session_host: false });
  };

  return (
    <>
      <ToggleCard
        label={<>{t("settings.windowsSessionHost")} <UntestedTag id="settings.experimental.windowsSessionHost" /></>}
        checked={on}
        onChange={(e) => void change(e.target.checked)}
        help={t("settings.windowsSessionHostHelp")}
      />
      {dialogs}
    </>
  );
}

/**
 * Settings → Terminal → Persistent local sessions, wherever a local session
 * backend exists (the caller gates that: tmux, or the Windows session host).
 * On Windows with the host on, turning it off goes through
 * `useEndHostSessionsThenSave`; on Unix it only saves, as before (tmux sessions
 * are reattached by name whatever the setting).
 */
export function PersistLocalSessionsToggle() {
  const t = useT();
  const checked = useSettingsStore((s) => s.settings?.persist_local_sessions ?? true);
  const hostOn = useSettingsStore((s) => experimentalEnabled(s.settings, "windows_session_host"));
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { endThenSave, dialogs } = useEndHostSessionsThenSave();

  const change = async (next: boolean) => {
    if (!next && IS_HOST_WINDOWS && hostOn) {
      await endThenSave(t("settings.persistLocalOffTitle"), { persist_local_sessions: false });
      return;
    }
    await updateSettings({ persist_local_sessions: next });
  };

  return (
    <>
      <ToggleCard
        label={
          IS_HOST_WINDOWS
            ? <>{t("settings.persistLocal")} <UntestedTag id="terminal.windowsSessionHost" /></>
            : t("settings.persistLocal")
        }
        checked={checked}
        onChange={(e) => void change(e.target.checked)}
        help={
          IS_HOST_WINDOWS ? (
            t("settings.persistLocalHelpWindows")
          ) : (
            <>
              {t("settings.persistLocalHelp1")} <code>tmux</code>
              {t("settings.persistLocalHelp2")}
            </>
          )
        }
      />
      {dialogs}
    </>
  );
}
