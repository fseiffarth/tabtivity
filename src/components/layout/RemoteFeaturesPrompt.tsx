import { useModalFocus } from "../../hooks/useModalFocus";
import { useState } from "react";
import { Toggle } from "../common/Toggle";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";

/**
 * First-run ask for the two machine-wide remote surfaces that live in the
 * header — OpenVPN tunnel control and the global SSH machines list. Both
 * default OFF (most projects are local-only), so this is what lets someone
 * who *does* use them opt in once instead of discovering the toggles buried
 * in Settings. Shown once (`Settings.remote_features_prompted`, marked seen
 * by the caller before this ever mounts); re-toggleable any time from
 * Settings' main panel. Reuses the `.modal-backdrop` + `.settings-dialog`
 * chrome, like `HowToStart`.
 */
export function RemoteFeaturesPrompt({ onClose }: { onClose: () => void }) {
  const t = useT();
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [vpn, setVpn] = useState(false);
  const [machines, setMachines] = useState(false);

  // Escape saves the switches as they are now, like the backdrop. (The old
  // mount-time listener saved the ones it was mounted with: both off.)
  const modalRef = useModalFocus(() => finish());

  const finish = () => {
    void updateSettings({ vpn_enabled: vpn, machines_enabled: machines });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={finish}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog remote-features-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.remoteFeatures")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("remoteFeatures.title")}</h2>
          <button type="button" className="dialog-close-btn" onClick={finish}>×</button>
        </div>
        <p className="settings-help">{t("remoteFeatures.help")}</p>

        <div className="settings-toggle-card">
          <label className="settings-toggle-card-row">
            <span>{t("settings.vpnEnabled")}</span>
            <Toggle checked={vpn} onChange={(e) => setVpn(e.target.checked)} />
          </label>
          <label className="settings-toggle-card-row">
            <span>{t("settings.machinesEnabled")}</span>
            <Toggle checked={machines} onChange={(e) => setMachines(e.target.checked)} />
          </label>
        </div>

        <div className="settings-link-row">
          <button type="button" className="how-to-start-got-it" onClick={finish}>
            {t("remoteFeatures.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
