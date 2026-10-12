import { useModalFocus } from "../../hooks/useModalFocus";
import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { useGlobalMachineMonitorStore } from "../../stores/remote/globalMachineMonitor";
import { useT } from "../../lib/i18n";

// The same lazily split chunk a System Monitor tab loads (`TabPane`).
const SystemMonitorPane = lazy(() =>
  import("./SystemMonitorPane").then((m) => ({ default: m.SystemMonitorPane })),
);

/**
 * Mounted once (AppShell). Renders the full system-monitor dialog for whichever
 * global machine `useGlobalMachineMonitorStore` points at — opened from the
 * header's Machines menu (`MachinesIndicator`), replacing the old inline small
 * CPU/GPU usage bars with the same htop-like view a project's "System Monitor"
 * tab shows, via `SystemMonitorPane`'s ad-hoc `globalMachine` mode. Mirrors
 * `RemoteMachinesDialogHost`'s mount-once/store-driven pattern.
 */
export function GlobalMachineMonitorDialogHost() {
  const machine = useGlobalMachineMonitorStore((s) => s.machine);
  const close = useGlobalMachineMonitorStore((s) => s.close);
  if (!machine) return null;
  return <GlobalMachineMonitorDialog key={machine.id} machine={machine} onClose={close} />;
}

function GlobalMachineMonitorDialog({
  machine,
  onClose,
}: {
  machine: { id: string; user?: string; host: string; port?: number; label?: string };
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="project-dialog dialog-framed sysmon-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("tabKind.monitor")} — {machine.label || machine.host}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="sysmon-dialog-body">
          <Suspense fallback={<div className="pane-loading" aria-busy="true" />}>
            <SystemMonitorPane
              projectId={null}
              visible
              globalMachine={{ user: machine.user, host: machine.host, port: machine.port }}
            />
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  );
}
