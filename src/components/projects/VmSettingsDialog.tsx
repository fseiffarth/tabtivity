import { useModalFocus } from "../../hooks/useModalFocus";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { ProjectEntry, VmEgress, VmSpec, VmStatus } from "../../types";
import { Toggle } from "../common/Toggle";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";
import { usePoll } from "../../lib/usePoll";

/**
 * The pill's "VM settings…" dialog (`docs/vm_projects_plan.md`): the VM's
 * state (running/off + boot/shutdown), the resource knobs (memory/cpus/disk —
 * applied at the next boot), the egress mode with its allowlist, Rebuild, and
 * the blocked-connections log. Chrome copied from `ContainerSettingsWindow`,
 * its structural sibling — one shared dialog scheme, not a new treatment.
 *
 * The egress caveat is stated here in full because this is where the knob is:
 * `proxy` narrows the agent's channel to the allowlisted endpoints; it cannot
 * close it — an agent can still put data inside a model prompt.
 */
export function VmSettingsDialog({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const spec = project.vm;
  const [memory, setMemory] = useState(String(spec?.memory_mb ?? 4096));
  const [cpus, setCpus] = useState(String(spec?.cpus ?? 2));
  const [disk, setDisk] = useState(String(spec?.disk_gb ?? 32));
  const [egress, setEgress] = useState<VmEgress>(spec?.egress ?? "proxy");
  const [allowGithub, setAllowGithub] = useState(spec?.allow_github ?? false);
  const [allowHosts, setAllowHosts] = useState((spec?.allow_hosts ?? []).join("\n"));
  const [mailReader, setMailReader] = useState(spec?.mail_reader ?? false);
  const [status, setStatus] = useState<VmStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshStatus = useCallback(() => {
    invoke<VmStatus>("vm_status", { projectId: project.id })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [project.id]);

  // Status (and the blocked-CONNECT tripwire) refresh while the dialog is
  // open — a local registry read, no SSH round trip.
  usePoll(refreshStatus, 4000);

  const bootOrShutdown = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (status?.running) {
        await invoke("vm_shutdown", { projectId: project.id });
      } else {
        await invoke("vm_boot", { projectId: project.id });
      }
      refreshStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    if (busy) return;
    // The overlay IS the working tree for a mirrorless VM project — the
    // confirm says so by name (`docs/vm_projects_plan.md`, delete/rebuild).
    const ok = await confirm(t("pill.vmRebuildConfirm"), {
      title: t("pill.vmRebuildTitle"),
      kind: "warning",
    });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      if (status?.running) {
        await invoke("vm_shutdown", { projectId: project.id });
      }
      await invoke("vm_rebuild", { projectId: project.id });
      refreshStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
    const mem = Number(memory.trim());
    const cpu = Number(cpus.trim());
    const dsk = Number(disk.trim());
    if (![mem, cpu, dsk].every((n) => Number.isInteger(n) && n > 0)) {
      setError(t("pill.vmNumbersError"));
      return;
    }
    setBusy(true);
    setError("");
    const next: VmSpec = {
      enabled: true,
      memory_mb: mem,
      cpus: cpu,
      disk_gb: dsk,
      egress,
      allow_github: allowGithub,
      allow_hosts: allowHosts
        .split("\n")
        .map((h) => h.trim())
        .filter(Boolean),
      ...(mailReader ? { mail_reader: true } : {}),
    };
    try {
      await invoke("vm_set_spec", { projectId: project.id, spec: next });
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("pill.vmSettingsTitle", { name: project.name })} <UntestedTag id="pill.vmSettingsTitle" /></h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <p className="settings-help">
          {status?.running
            ? t("pill.vmStatusRunning", { port: status.ssh_port ?? 0 })
            : t("pill.vmStatusOff")}
        </p>
        <div className="project-dialog-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" onClick={() => void bootOrShutdown()} disabled={busy}>
            {status?.running ? t("pill.vmShutdown") : t("pill.vmBoot")}
          </button>
          <button type="button" onClick={() => void rebuild()} disabled={busy}>
            {t("pill.vmRebuildEllipsis")}
          </button>
        </div>

        <label>
          {t("pill.vmMemory")}
          <input
            type="text"
            value={memory}
            onChange={(e) => setMemory(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          {t("pill.vmCpus")}
          <input
            type="text"
            value={cpus}
            onChange={(e) => setCpus(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          {t("pill.vmDisk")}
          <input
            type="text"
            value={disk}
            onChange={(e) => setDisk(e.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="settings-help">{t("pill.vmKnobsApplyNote")}</p>

        <label>
          {t("pill.vmEgress")}
          <Dropdown
            className="dropdown-block"
            value={egress}
            onChange={(v) => setEgress(v as VmEgress)}
            options={[
              { value: "proxy", label: t("pill.vmEgressProxy") },
              { value: "off", label: t("pill.vmEgressOff") },
              { value: "open", label: t("pill.vmEgressOpen") },
            ]}
          />
        </label>
        {egress === "proxy" && (
          <>
            <p className="settings-help">{t("pill.vmEgressProxyCaveat")}</p>
            <label className="container-settings-toggle">
              <span>{t("pill.vmAllowGithub")}</span>
              <Toggle
                checked={allowGithub}
                onChange={(e) => setAllowGithub(e.target.checked)}
                size="sm"
              />
            </label>
            <label>
              {t("pill.vmAllowHosts")}
              <textarea
                value={allowHosts}
                rows={3}
                placeholder={t("pill.vmAllowHostsPlaceholder")}
                onChange={(e) => setAllowHosts(e.target.value)}
                spellCheck={false}
              />
            </label>
          </>
        )}
        {egress === "off" && <p className="settings-help">{t("pill.vmEgressOffNote")}</p>}

        {/* The contained mail reader (`services::mail_reader`). The backend is
            the gate — it refuses a save that is wider than the default proxy
            box — and this line says why before the click does. */}
        <label className="container-settings-toggle">
          <span>
            {t("pill.vmMailReader")} <UntestedTag id="pill.vmMailReader" />
          </span>
          <Toggle checked={mailReader} onChange={(e) => setMailReader(e.target.checked)} size="sm" />
        </label>
        <p className="settings-help">{t("pill.vmMailReaderHelp")}</p>
        {mailReader && (egress !== "proxy" || allowGithub || allowHosts.trim() !== "") && (
          <p className="settings-help project-dialog-error">{t("pill.vmMailReaderWide")}</p>
        )}

        {status && status.blocked.total > 0 && (
          <>
            <p className="settings-help">
              {t("pill.vmBlockedCount", { count: status.blocked.total })}
            </p>
            <ul className="settings-help" style={{ margin: 0, paddingLeft: "1.2em" }}>
              {status.blocked.recent.slice(-8).reverse().map((b, i) => (
                <li key={`${b.target}-${i}`}>{b.target}</li>
              ))}
            </ul>
          </>
        )}

        {error && <ErrorNote className="project-dialog-error" error={error} />}
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
