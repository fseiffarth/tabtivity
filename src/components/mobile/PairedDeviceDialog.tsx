import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { UntestedTag } from "../common/UntestedTag";
import { isMobileEligible, PairedDeviceAccess } from "./PairedDeviceAccess";
import { usePairedPhones } from "./usePairedPhones";

/**
 * One paired phone's access — the same `PairedDeviceAccess` block as under its
 * Settings → Mobile row — opened from that phone's row in the header's Mobile
 * menu. Chrome is `MobileSetupGuide`'s (`.modal-backdrop` + `.settings-dialog`),
 * so the block's settings classes render as they do in Settings.
 *
 * The device is re-read here (`usePairedPhones`) rather than taken from the
 * menu: the menu's list has no `hidden_sections`, and every change the block
 * makes has to show in it at once.
 */
export function PairedDeviceDialog({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const { phones, refresh } = usePairedPhones();
  const device = phones?.find((phone) => phone.id === deviceId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Revoked meanwhile (here, in Settings, or by Lock down): nothing left to show.
  useEffect(() => {
    if (phones && !device) onClose();
  }, [phones, device, onClose]);

  if (!phones || !device) return null;
  const eligibleIds = new Set(projects.filter(isMobileEligible).map((project) => project.id));

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={device.name}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{device.name} <UntestedTag id="mobile.indDeviceAccess" /></h2>
          <button
            type="button"
            className="dialog-close-btn"
            aria-label={t("common.close")}
            onClick={onClose}
          >×</button>
        </div>
        <div className="dialog-scroll">
          <PairedDeviceAccess
            device={device}
            pairedIds={phones.map((phone) => phone.id)}
            eligibleProjectIds={eligibleIds}
            onChanged={refresh}
          />
        </div>
      </div>
    </div>
  );
}
