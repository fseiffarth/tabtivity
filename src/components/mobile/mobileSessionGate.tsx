import { invoke } from "@tauri-apps/api/core";
import { translateNow } from "../../lib/i18n";
import { runInstallInTab, TMUX_INSTALL_CMD } from "../../lib/installCommand";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { localSessionsAvailable } from "../../lib/terminal/localSessions";
import { useSettingsStore } from "../../stores/settings";
import type { ConfirmSpec } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";

/**
 * Before a project's or box's Mobile switch goes ON: the phone opens tabs
 * through persistent local sessions, and the backend refuses the switch
 * without them (`commands::projects::mobile_access_prerequisites`). Rather than
 * let that refusal surface as an error, ask to turn on what is missing:
 *
 * - Windows: the session host and Persistent local sessions, in one confirm
 *   (the same two switches Settings → Experimental and → Terminal hold);
 * - Linux/macOS with Persistent local sessions off: that switch;
 * - Linux/macOS without tmux: the one-click install, in a tab. The switch
 *   stays off — tmux is only there once the install has finished.
 *
 * Resolves true when the caller may go on and switch access on. A failed
 * probe counts as fine: the backend still has the last word.
 */
export async function ensureMobileSessions(confirmAction: (spec: ConfirmSpec) => Promise<boolean>): Promise<boolean> {
  const settings = useSettingsStore.getState().settings;
  const updateSettings = useSettingsStore.getState().updateSettings;
  if (IS_HOST_WINDOWS) {
    if (localSessionsAvailable(settings)) return true;
    const ok = await confirmAction({
      title: <>{translateNow("mobile.windowsTerminalsTurnOnTitle")} <UntestedTag id="mobile.accessGate" /></>,
      body: translateNow("mobile.windowsTerminalsTurnOnBody"),
      confirmLabel: translateNow("mobile.windowsTerminalsTurnOn"),
    });
    if (!ok) return false;
    await updateSettings({ windows_session_host: true, persist_local_sessions: true });
    return true;
  }
  const tmux = await invoke<boolean>("local_tmux_available").catch(() => true);
  if (tmux === false) {
    const ok = await confirmAction({
      title: <>{translateNow("mobile.gate.tmuxTitle")} <UntestedTag id="mobile.accessGate" /></>,
      body: translateNow("mobile.gate.tmuxBody"),
      confirmLabel: translateNow("settings.installTmux"),
    });
    if (ok) runInstallInTab(translateNow("settings.installTmux"), TMUX_INSTALL_CMD, "default");
    return false;
  }
  if (localSessionsAvailable(settings)) return true;
  const ok = await confirmAction({
    title: <>{translateNow("mobile.gate.persistTitle")} <UntestedTag id="mobile.accessGate" /></>,
    body: translateNow("mobile.gate.persistBody"),
    confirmLabel: translateNow("mobile.windowsTerminalsTurnOn"),
  });
  if (!ok) return false;
  await updateSettings({ persist_local_sessions: true });
  return true;
}
