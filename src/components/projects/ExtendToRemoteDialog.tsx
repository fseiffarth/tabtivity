import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useBigFoldersStore } from "../../stores/bigFolders";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { joinRemotePath, sanitizeName } from "../../lib/projects/scaffold";
import { useRemoteSession, type RemoteStep } from "./useRemoteSession";
import { RemoteProjectSection } from "./RemoteProjectSection";
import { targetLabel } from "../../lib/remote/machineLabel";
import { ConnLamp } from "../common/ConnLamp";
import { UntestedTag } from "../common/UntestedTag";
import { hostKeyConfirmOnce } from "../../lib/remote/hostKeyOnce";
import type { DroppedGlobalMachine } from "../../stores/remote/remoteMachines";
import { useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";

/**
 * "Extend to remote…" modal for an existing **local** project. It attaches a
 * remote SSH spec without uploading any data: the empty remote root is created
 * on the host (as when creating a remote project directly) and the project's
 * current local directory becomes its local mirror in place. The user pushes
 * files up later via the normal manual-sync UI.
 *
 * The whole connect → browse flow is the same machinery the new-project dialog
 * uses — `useRemoteSession` (state/effects) + `RemoteProjectSection` (the SSH /
 * OpenVPN / folder-browser UI) — so there's no duplicated remote logic here. The
 * project name is fixed, so the "details" step is just a confirm summary.
 *
 * Opened from the pill's menu there is no machine behind it, so the connect
 * step also lists the header's **global machines** ("Your machines"): one click
 * fills the SSH address from a host that is already set up, instead of typing
 * an address the app already stores. It fills and never connects — the login
 * still happens here, for `initialMachine`'s reason below.
 *
 * `initialMachine` seeds the SSH address from a global machine
 * (`MachinesIndicator`) dropped onto this (local-only) project's pill — this
 * dialog becomes the "make this machine the project's primary" flow. It only
 * prefills the address field; the user still authenticates here (the global
 * machine's own connection is a separate pooled session keyed by its own id,
 * not by this project), though a saved password for that host target is
 * picked up automatically since the keychain is keyed by host, not project.
 */
export function ExtendToRemoteDialog({
  project,
  initialMachine,
  onClose,
}: {
  project: ProjectEntry;
  initialMachine?: DroppedGlobalMachine;
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  // The remote path leaf and local-mirror-relative name both use the project's
  // sanitized name, matching direct remote creation (kind "new").
  const safeName = sanitizeName(project.name);
  const extendProjectToRemote = useProjectsStore((s) => s.extendProjectToRemote);

  const remote = useRemoteSession({ kind: "new" });
  const {
    isRemoteProject,
    toggleRemoteProject,
    winManual,
    isRemote,
    step,
    setStep,
    remoteBrowsePath,
    setRemoteChosenPath,
    remoteChosenPath,
    remoteReady,
    remotePassword,
    onSshAddressChange,
    buildRemoteSpec,
  } = remote;

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // ── The machines you already have ──────────────────────────────────────
  // Opened from the pill's menu there is no machine behind this dialog, and the
  // only way to name a host was to re-type an address that is already stored
  // (and already authenticated) in the header's "Machines" list. Offering that
  // list here is the same bargain `RemoteMachinesWindow`'s add-a-machine form
  // strikes: one click *fills the address*, it does not connect — the login
  // still happens in this dialog, since a global machine's session is keyed by
  // its own id and is not this project's pooled one.
  const globalMachines = useGlobalMachinesStore((s) => s.machines);
  const globalStatuses = useGlobalMachinesStore((s) => s.status);
  const globalsLoaded = useGlobalMachinesStore((s) => s.loaded);
  useEffect(() => {
    if (!globalsLoaded) void useGlobalMachinesStore.getState().load();
  }, [globalsLoaded]);
  // Which row filled the address, purely so the list can say so — the address
  // field stays the truth (it is editable, and typing over it is allowed).
  const [pickedMachine, setPickedMachine] = useState<string | null>(initialMachine?.id ?? null);

  // Footer step machine, borrowed verbatim from the new-project dialog so the
  // extend flow gets the same Back/Next navigation (the details step must be
  // able to step back to re-pick the remote folder). Windows non-headless skips
  // the browse step (it types the path in connect).
  const remoteSteps: RemoteStep[] = winManual
    ? ["connect", "details"]
    : ["connect", "browse", "details"];
  const stepIdx = remoteSteps.indexOf(step);
  const goBack = () => setStep(remoteSteps[Math.max(0, stepIdx - 1)]);
  const goNext = () => setStep(remoteSteps[Math.min(remoteSteps.length - 1, stepIdx + 1)]);
  const canNext =
    step === "connect"
      ? winManual
        ? remoteChosenPath.trim() !== ""
        : isRemote
      : step === "browse"
        ? remoteChosenPath.trim() !== ""
        : false;

  // This dialog is always remote — enable remote mode on mount so the tooling
  // probe + recent addresses/configs load and RemoteProjectSection renders.
  // Dropped from a global machine: also seed the address field so the user
  // only has to authenticate, not re-type the host.
  useEffect(() => {
    if (!isRemoteProject) toggleRemoteProject(true);
    if (initialMachine) onSshAddressChange(targetLabel(initialMachine));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commit the browsed folder as the parent and advance to the confirm step
  // (mirrors ProjectDialog's useThisRemoteFolder; name is fixed so no form).
  const useThisRemoteFolder = () => {
    setRemoteChosenPath(remoteBrowsePath || "/");
    setStep("details");
  };

  const submit = async () => {
    const spec = buildRemoteSpec(safeName);
    if (!spec) {
      setError(t("extendRemote.connectFirstError"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await extendProjectToRemote(project.id, spec);
      // Reaching this step required a live, authenticated SSH session (the flow
      // browsed/created the remote folder over it). Carry that straight over to the
      // now-remote project rather than dropping it to a "Connect" prompt: open its
      // pooled SSH/SFTP channel and light the SSH lamp green. Fire-and-forget — the
      // lamp reflects connecting → connected as it resolves.
      //
      // Hand it the credential the dialog authenticated with (empty for a key-auth
      // host). Riding the still-live ControlMaster password-less would connect too,
      // but the backend reads a password-less connect with nothing in the keychain as
      // *key* auth and records `key_auth: true` — on a password host that is a lie the
      // project keeps, and auto-connect later believes.
      // A single attempt right after `remote_mkdir_p` can lose to a host session
      // that hasn't finished settling yet — mirrors `ensureRemotePool`'s retry
      // cadence (used on ordinary project activation) instead of parking the lamp
      // on "error" forever after one transient hiccup, with the live ControlMaster
      // underneath never actually going away.
      const status = useRemoteStatusStore.getState();
      status.setSsh(project.id, "connecting");
      const connectPassword = remotePassword || null;
      let connectAttempts = 0;
      const maxConnectAttempts = 6;
      // First contact: this loop dialled a host whose key may never have been
      // accepted here, six times, four seconds apart — silently. Wrapped now, but
      // with the **ask-once** variant (`hostKeyConfirmOnce`): the plain wrapper
      // would raise six identical fingerprint dialogs, and re-ask five more times
      // after a decline, which is not a decline at all.
      const confirmHostKey = hostKeyConfirmOnce();
      const tryConnect = () => {
        void confirmHostKey(() =>
          invoke("remote_connect", {
            projectId: project.id,
            password: connectPassword,
            // With no password to hand over (non-headless, or a key host), this can only
            // be riding the master the dialog's login left up — say so, so the backend
            // doesn't record the very `key_auth: true` lie the comment above describes.
            viaLogin: !connectPassword,
            // The user clicked "Extend to remote" and is watching this lamp;
            // `remote_connect` defaults to background, which a tagged HPC host refuses.
            background: false,
          }),
        )
          .then(() => useRemoteStatusStore.getState().setSsh(project.id, "connected"))
          .catch((err) => {
            if (++connectAttempts >= maxConnectAttempts) {
              console.warn("remote_connect after extend failed", err);
              useRemoteStatusStore.getState().setSsh(project.id, "error");
              return;
            }
            setTimeout(tryConnect, 4000);
          });
      };
      tryConnect();
      // The existing local folder is about to become a synced working copy, so
      // this is the last cheap moment to ask which of its giant folders (a
      // `.venv`, a build dir, a data drop) should never cross. The prompt walks
      // the local side straight away and fills in the host column when the
      // connect above lands.
      useBigFoldersStore.getState().openOnce(project.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const remotePath = joinRemotePath(remoteChosenPath || "/", safeName || project.name);
  // The local files stay in place, so the mirror is the project's current dir.
  const localPath = resolveProjectDirectory(project);

  // Portaled to <body> like every other dialog raised from a pill: this
  // component renders inside `.project-pills-scroll`, a 40px-tall horizontally
  // scrolling strip in the header, and WebKitGTK positions a `position: fixed`
  // descendant of a scroll container against that container rather than the
  // viewport — so the backdrop centered its dialog inside the header band and
  // the whole thing sat pinned to the top of the window.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="project-dialog dialog-framed" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("extendRemote.title", { name: project.name })}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="dialog-scroll">
        <p className="ssh-optional-hint">
          {initialMachine ? (
            <>
              {t("extendRemote.attachPre")} <strong>{initialMachine.label || initialMachine.host}</strong>{" "}
              {t("extendRemote.attachMid")}
            </>
          ) : (
            t("extendRemote.attachGeneric")
          )}
        </p>

        {/* Pick a machine instead of typing its address. Only while the host is
            still being chosen: once the session is up, the address is settled
            and a list offering to overwrite it would be a trap. */}
        {step === "connect" && !isRemote && globalMachines.length > 0 && (
          <div className="remote-machine-global">
            <div className="remote-machine-add-label">
              <span className="remote-machine-global-title">
                {t("extendRemote.machinesTitle")}
              </span>
              <UntestedTag id="extendToRemoteDialog.1" />
            </div>
            <p className="settings-help">{t("extendRemote.machinesHelp")}</p>
            <div className="remote-machine-global-list">
              {globalMachines.map((m) => {
                const target = targetLabel(m);
                const picked = pickedMachine === m.id;
                return (
                  <div key={m.id} className="remote-machine-global-row">
                    {/* The machine's own status — a session this app opened,
                        never a probe (`stores/remote/globalMachines`). */}
                    <ConnLamp status={globalStatuses[m.id] ?? "off"} label={target} />
                    <span className="remote-machine-name">{m.label || m.host}</span>
                    <span className="remote-machine-target">{target}</span>
                    {picked ? (
                      <span
                        className="remote-machine-tag"
                        title={t("extendRemote.machinePickedTitle")}
                      >
                        {t("extendRemote.machinePicked")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        title={t("extendRemote.machineUseTitle")}
                        onClick={() => {
                          onSshAddressChange(target);
                          setPickedMachine(m.id);
                        }}
                      >
                        {t("extendRemote.machineUse")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <RemoteProjectSection
          kind="new"
          safeName={safeName}
          onClose={onClose}
          onUseThisFolder={useThisRemoteFolder}
          remote={remote}
        />

        {step === "details" && (
          <div className="project-dialog-path extend-summary">
            <span>{t("extendRemote.summaryLede")}</span>
            <div className="extend-path-row">
              <span className="extend-path-label">{t("extendRemote.local")}</span>
              <code className="extend-remote-path">{localPath}</code>
            </div>
            <div className="extend-path-row">
              <span className="extend-path-label">{t("extendRemote.remote")}</span>
              <code className="extend-remote-path">{remotePath}</code>
            </div>
          </div>
        )}

        {error && <ErrorNote className="project-dialog-error" error={error} />}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          {stepIdx > 0 && (
            <button type="button" disabled={busy} onClick={goBack}>
              {t("common.back")}
            </button>
          )}
          {step !== "details" ? (
            <button type="button" disabled={!canNext || busy} onClick={goNext}>
              {t("common.next")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !remoteReady}
              title={t(remoteReady ? "extendRemote.readyTitle" : "extendRemote.notReadyTitle")}
            >
              {busy ? t("extendRemote.extending") : t("extendRemote.extendToRemote")}
            </button>
          )}
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
