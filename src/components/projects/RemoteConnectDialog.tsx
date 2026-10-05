import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/TerminalView";
import { Toggle } from "../common/Toggle";
import { ConnLamp } from "../common/ConnLamp";
import { ConnectionLog } from "../common/ConnectionLog";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { TerminalSignInToggle } from "./TerminalSignInToggle";
import { SavePasswordRow } from "./SavePasswordRow";
import { rememberArg } from "./useSavedCredential";
import { CarefulHostToggle } from "./CarefulHostToggle";
import { HpcHostToggle } from "./HpcHostToggle";
import { primaryTargetOf, targetOfSpec } from "../../lib/remote/carefulHost";
import { CredentialPasteBar, sshPasteEntries, vpnPasteEntries } from "./CredentialPasteBar";
import { useRemoteReconnect } from "./useRemoteReconnect";
import { useConnectDialogStore } from "../../stores/remote/connectDialog";
import { useProjectsStore, disconnectRemote } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useVpnSectionVisible } from "../../stores/remote/vpn/vpnStatus";
import { VpnTunnelUpNotice } from "../common/VpnTunnelUpNotice";
import { formatRemoteTarget, resolveLocalMirror, type ProjectEntry } from "../../types";
import { useT } from "../../lib/i18n";
import { TerminalIcon } from "../common/icons/Icon";

/**
 * Centered "Connect" modal for an existing remote (SSH) project — the single
 * entry point the per-pill status lamp and the disconnected-pane placeholder
 * open. It is the connect-only sibling of the new-project dialog's SSH section:
 * no address entry, no folder browse, no project creation — the target is the
 * project's known `remote` spec.
 *
 * Two paths, matching the `connections_headless` setting (default ON):
 *  - headless → Tabtivity feeds the password to the backend (SSH password + VPN
 *    passphrase fields, a live handshake log for VPN), and
 *  - non-headless → embedded login terminals where the user types the secret
 *    directly and Tabtivity never handles it.
 * Both drive `useRemoteReconnect`, so the shared SSH/VPN lamp state (and the
 * pooled `remote_connect`) is identical to the header lamps. The modal
 * auto-closes once SSH reaches "connected".
 */
export function RemoteConnectDialog() {
  const projectId = useConnectDialogStore((s) => s.projectId);
  const hostId = useConnectDialogStore((s) => s.hostId);
  const project = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  );
  if (!projectId || !project?.remote) return null;
  // Multi-host remote: the modal targets the primary or a worker host. Resolve the
  // selected worker (if any) so its own spec drives the connect + lamp.
  const worker =
    hostId && hostId !== "primary"
      ? project.compute_hosts?.find((h) => h.id === hostId)
      : undefined;
  return (
    <RemoteConnectDialogInner key={`${project.id}:${hostId ?? "primary"}`} project={project} host={worker} />
  );
}

function RemoteConnectDialogInner({
  project,
  host,
}: {
  project: ProjectEntry;
  host?: import("../../types").ComputeHost;
}) {
  const t = useT();
  const close = useConnectDialogStore((s) => s.close);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);
  // Which machine the careful switch below governs: the worker this dialog was
  // opened for, or the project's primary when it was opened for that. A worker is
  // a `ComputeHost extends RemoteSpec`, so both spellings carry user/host/port.
  const carefulTarget = host ? targetOfSpec(host) : primaryTargetOf(project);
  const {
    sshStatus,
    vpnStatus,
    sshUser,
    setSshUser,
    commitSshUser,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeeds,
    vpnNeedsKeyPassphrase,
    selectVpnConfig,
    browseVpnConfig,
    winManual,
    vpnTerm,
    sshTerm,
    startVpnTerm,
    stopVpn,
    startSshTerm,
    stopSsh,
    tryConnectNow,
    sshError,
    vpnError,
    vpnLog,
    sshSaved,
    sshCredential,
    vpnSaved,
    autoConnect,
    autoConnectEligible,
    autoConnectBlock,
    setAutoConnect,
    setWorkerLabel,
    connectVpnHeadless,
    connectSshHeadless,
    forgetPasswords,
    forgetSshPassword,
    forgetVpnPassword,
  } = useRemoteReconnect(project, host);

  // Editable name: for a worker its `label`, for the primary the project name.
  // Seeded from the current value and re-synced when the store's copy changes (a
  // rename commits into the store); committed on blur / Enter so a write fires once,
  // not per keystroke. The two differ on blank: a worker label may be cleared (it
  // then falls back to the host), but a project name may not — the backend rejects
  // it, so we restore the field instead.
  const currentName = host ? host.label ?? "" : project.name;
  const [nameDraft, setNameDraft] = useState(currentName);
  useEffect(() => setNameDraft(currentName), [currentName]);
  const commitName = () => {
    const next = nameDraft.trim();
    if (next === currentName) return;
    if (host) {
      setWorkerLabel(next);
    } else if (next) {
      void useProjectsStore.getState().renameProject(project.id, next).catch(() => {});
    } else {
      setNameDraft(currentName); // project name can't be blank — undo the edit
    }
  };

  // The primary's own machine name (`remote.label`) — distinct from the project
  // name above: a project can be renamed without touching which name identifies
  // its primary host across the multi-host surfaces (System Monitor's source
  // picker, the pill's connection lamps). Worker-only equivalent is `host.label`,
  // already covered by the "Name" field above since a worker has no project name
  // of its own to conflict with it.
  const currentMachineLabel = host ? "" : project.remote?.label ?? "";
  const [machineDraft, setMachineDraft] = useState(currentMachineLabel);

  // "Disconnect & end jobs" retains its explicit confirmation, although every
  // disconnect now ends this host's tmux sessions before dropping the pool.
  // Target is the worker's own spec or the primary's `remote`.
  const [killArm, setKillArm] = useState(false);
  const killTarget = host
    ? { user: host.user, host: host.host, port: host.port }
    : {
        user: project.remote?.user,
        host: project.remote?.host ?? "",
        port: project.remote?.port,
      };
  useEffect(() => setMachineDraft(currentMachineLabel), [currentMachineLabel]);
  const commitMachineLabel = () => {
    const next = machineDraft.trim();
    if (next === currentMachineLabel) return;
    setWorkerLabel(next);
  };

  const [sshPassword, setSshPassword] = useState("");
  const [vpnPassword, setVpnPassword] = useState("");
  // Per-connect "sign in in a terminal" (see `TerminalSignInToggle`): pure view state
  // — which half of the login section is on screen — so it lives here rather than in
  // `useRemoteReconnect`, and it resets with the dialog, as a per-connect switch
  // should. Default off: headless is the mode, this is the escape hatch from it.
  const [sshViaTerminal, setSshViaTerminal] = useState(false);
  const [vpnViaTerminal, setVpnViaTerminal] = useState(false);
  // Only a separate secret when the config has BOTH an `auth-user-pass` account and
  // an encrypted key — OpenVPN prompts for the two independently. For a key-only
  // config `vpnPassword` already is the key passphrase, and this field stays hidden.
  const [vpnKeyPassphrase, setVpnKeyPassphrase] = useState("");
  // "Connect via OpenVPN" opt-in, default OFF: this project is VPN-gated, but on
  // the right network the tunnel is unnecessary and SSH connects directly. The
  // VPN fields stay collapsed until the user turns this on — *unless* a tunnel is
  // already up (or coming up) for this project, in which case the section opens
  // itself. A live tunnel must never hide behind a collapsed section: that is
  // exactly the state where the user needs it, to bring the tunnel back down.
  const [vpnEnabled, setVpnEnabled] = useState(vpnStatus !== "off");
  useEffect(() => {
    if (vpnStatus === "connecting" || vpnStatus === "connected") setVpnEnabled(true);
  }, [vpnStatus]);
  // "Save password" opt-in (default off). Pre-checked when a credential is
  // *known* to be saved for this target — the tri-state's point: an unresolved or
  // unreadable keychain leaves the box unticked, and an unticked box now sends
  // `remember: null` ("leave it alone"), never the `false` that used to delete
  // the credential the connect had just authenticated with.
  const [sshRemember, setSshRemember] = useState(false);
  const [vpnRemember, setVpnRemember] = useState(false);
  useEffect(() => setSshRemember(sshSaved), [sshSaved]);
  useEffect(() => setVpnRemember(vpnSaved), [vpnSaved]);
  const localMirror = resolveLocalMirror(project);

  // Re-open the config picker for a project that already has one ("Change…").
  // The stored config is remembered, but it must stay swappable: a host can move
  // behind a different VPN, or the first pick can simply have been the wrong file.
  const [changingVpnConfig, setChangingVpnConfig] = useState(false);
  const showVpnPicker = vpnEnabled && (!vpnConfig || changingVpnConfig);
  // Prefer the recents-list name (the stored copy's file name); fall back to the
  // path's own basename for a config that isn't in the list yet.
  const vpnConfigName = vpnConfig
    ? vpnConfigs.find((c) => c.path === vpnConfig)?.name ??
      vpnConfig.split(/[\\/]/).pop() ??
      vpnConfig
    : "";

  // Auto-close only on a *fresh* connect made from within this dialog — the held
  // panes mount and the work surface takes over, so the modal has nothing left
  // to do. If it was already connected when opened (the user clicked the pill to
  // manage/disconnect an up connection), keep it open so the Disconnect action
  // stays reachable — clicking the lamps of a connected project must show the
  // same menu as when disconnected.
  const prevSshStatus = useRef(sshStatus);
  useEffect(() => {
    const prev = prevSshStatus.current;
    prevSshStatus.current = sshStatus;
    if (sshStatus === "connected" && prev !== "connected") close();
  }, [sshStatus, close]);

  const connected = sshStatus === "connected";
  const connecting = sshStatus === "connecting";
  // The tunnel is up or on its way — every VPN field/button is locked while so.
  const vpnBusy = vpnStatus === "connecting" || vpnStatus === "connected";
  // A tunnel is machine-wide, so once *any* config is live there's nothing left for
  // this project's OpenVPN section to offer — except when it's THIS project's own
  // attempt that made it live, in which case its controls (log, Stop/Disconnect)
  // must stay reachable here. `vpnBusy` already mirrors that via the machine store.
  const showVpnSection = useVpnSectionVisible(vpnBusy);

  // The two "save the secret" rows, defined once and rendered from **both** halves of
  // the login section. They belong to the *host*, not to how you happen to be signing
  // in this time: switching to the terminal login must not make a saved password look
  // discarded (and must certainly never delete it — only unticking does that, and only
  // by the user's own click). A terminal login is one Tabtivity never sees, so nothing
  // *new* is stored from it; the saved credential is simply kept for the connects that
  // can use it, which the hint says out loud rather than leaving to be guessed.
  // The shared row (`SavePasswordRow`), which also carries the locked-keyring
  // banner: a keychain that can't be read used to render here as a confident
  // "nothing saved", which is the state that invited an untick — and, before the
  // `remember: false` fix, a delete.
  const sshSaveRow = (
    <SavePasswordRow
      credential={sshCredential}
      checked={sshRemember}
      disabled={connecting || connected}
      viaTerminal={sshViaTerminal}
      onChange={(on) => {
        setSshRemember(on);
        // Untick = delete it now. Waiting for the next connect to clear it
        // leaves the password in the keychain the user just asked to drop —
        // and the connect no longer clears anything, by design.
        if (!on && sshSaved) void forgetSshPassword();
      }}
    />
  );
  const vpnSaveRow = (
    <label className="remote-connect-remember">
      <Toggle
        size="sm"
        checked={vpnRemember}
        disabled={vpnBusy}
        onChange={(e) => {
          setVpnRemember(e.target.checked);
          // Unticking is a request to *not* have the secret stored —
          // honour it now, not at the next connect (which may never come).
          if (!e.target.checked && vpnSaved) void forgetVpnPassword();
        }}
      />
      {vpnNeedsKeyPassphrase ? t("vpnPrompt.saveVpnCredentials") : t("vpnPrompt.savePassphrase")}
      <span className="ssh-optional-hint">
        {vpnSaved
          ? vpnViaTerminal
            ? t("remoteConnect.saveHintKeptTerminal")
            : t("remoteConnect.saveHintSaved")
          : vpnViaTerminal
            ? t("remoteConnect.saveHintNothingTerminal")
            : t("vpnPrompt.storedSecurely")}
      </span>
    </label>
  );
  // One submit for the whole VPN form: the fields are separate prompts OpenVPN
  // raises, but they're answered in a single connect.
  const submitVpn = () => void connectVpnHeadless(vpnPassword, vpnKeyPassphrase, rememberArg(vpnRemember));

  // What the "Paste …" row above each login terminal offers (see `CredentialPasteBar`).
  // A terminal login is one Tabtivity never sees — but a credential the user saved from a
  // headless connect is still sitting in the keychain, and retyping it into every
  // terminal login is exactly the friction the keychain exists to remove. The login
  // *name* is pasted from here (it is on screen already, in a plain text field); the
  // secret is only ever named — the backend reads it and types it.
  const sshPaste = sshPasteEntries(t, {
    user: sshUser,
    host: host ? host.host : project.remote?.host,
    port: host ? host.port : project.remote?.port,
    saved: sshSaved,
  });
  const vpnPaste = vpnPasteEntries(t, {
    config: vpnConfig,
    username: vpnUsername,
    saved: vpnSaved,
    needsUsername: vpnNeeds.username,
    needsKeyPassphrase: vpnNeedsKeyPassphrase,
  });

  return createPortal(
    <div className="modal-backdrop modal-backdrop-elevated" onMouseDown={close}>
      <div
        className="project-dialog dialog-framed remote-connect-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {host
              ? t("remoteConnect.titleWorker", { host: host.label || host.host })
              : t("remoteConnect.titleProject")}
          </h2>
          <button type="button" className="dialog-close-btn" onClick={close}>×</button>
        </div>

        <div className="dialog-scroll">
        <div className="remote-connect-target">
          <div className="remote-connect-location">
            <span className="remote-connect-location-label">{t("remoteConnect.remoteLabel")}</span>
            <span
              className="remote-connect-location-path"
              title={host ? formatRemoteTarget(host) : project.remote ? formatRemoteTarget(project.remote) : undefined}
            >
              {host ? formatRemoteTarget(host) : project.remote && formatRemoteTarget(project.remote)}
            </span>
          </div>
          {/* A worker is code-read-only (one-way sync, outputs stay on it) — it
              has no local mirror to show; only the primary does. */}
          {!host && localMirror && (
            <div className="remote-connect-location">
              <span className="remote-connect-location-label">{t("remoteConnect.localLabel")}</span>
              <span className="remote-connect-location-path" title={localMirror}>{localMirror}</span>
            </div>
          )}
        </div>

        {/* Rename here — a worker's name was only settable once (at add time), and the
            primary's project name was only editable elsewhere. Blank clears a worker
            label (it falls back to the host); a project name can't be blank. */}
        <label className="remote-connect-field remote-worker-name">
          <span className="remote-machine-add-label">
            {t("remoteConnect.nameLabel")}
            <UntestedTag id="remoteConnectDialog.1" />
          </span>
          <input
            type="text"
            value={nameDraft}
            placeholder={host ? host.host : t("remoteConnect.namePlaceholder")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <span className="ssh-optional-hint">
            {host
              ? t("remoteConnect.nameHintWorker")
              : t("remoteConnect.nameHintProject")}
          </span>
        </label>

        {/* The primary's own machine name — worker rows already get this via the
            "Name" field above (a worker has no project name to conflict with it);
            the primary needs a second field since its "Name" above is the project
            name. Optional: blank falls back to the bare host everywhere hosts are
            listed side by side (System Monitor, pill lamps, "Remote machines"). */}
        {!host && (
          <label className="remote-connect-field remote-worker-name">
            <span className="remote-machine-add-label">
              {t("remoteConnect.machineNameLabel")}
              <UntestedTag id="remoteConnectDialog.2" />
            </span>
            <input
              type="text"
              value={machineDraft}
              placeholder={project.remote?.host ?? ""}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setMachineDraft(e.target.value)}
              onBlur={commitMachineLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="ssh-optional-hint">
              {t("remoteConnect.machineNameHint")}
            </span>
          </label>
        )}

        {/* ── OpenVPN (always offered; opt-in, default off) ─────────────────────
            Shown for every remote project, not only ones that stored a config at
            create time: a project made on a no-VPN network may need a tunnel when
            reconnected from a VPN-gated one. With no config yet, enabling the
            toggle reveals a picker; the choice is persisted to the project.
            But once *any* tunnel is already up machine-wide, this whole section is
            redundant — the routing this project needs is already there — so it
            collapses to a one-line status and the dialog goes straight to SSH. */}
        {!showVpnSection && (
          <div className="remote-reconnect-section">
            <VpnTunnelUpNotice />
          </div>
        )}
        {showVpnSection && (
        <div className="remote-reconnect-section" role="group" aria-label={t("remoteConnect.vpnSectionAria")}>
          <label className={`toggle-card${vpnEnabled ? " is-on" : ""}`}>
            <span className="toggle-card-body">
              <span className="toggle-card-title">
                <ConnLamp status={vpnStatus} label="OpenVPN" />
                {t("remoteConnect.vpnToggleTitle")}
              </span>
              <span className="toggle-card-desc">
                {t("remoteConnect.vpnDescLine1")}
                <br />
                {t("remoteConnect.vpnDescLine2Pre")}{" "}
                <strong>{t("remoteConnect.vpnDescLine2Strong")}</strong>
                {t("remoteConnect.vpnDescLine2Post")}
              </span>
            </span>
            <span className="eld-switch">
              <input
                type="checkbox"
                checked={vpnEnabled}
                disabled={vpnStatus === "connecting" || vpnStatus === "connected"}
                onChange={(e) => setVpnEnabled(e.target.checked)}
              />
              <span className="eld-switch-track" aria-hidden="true" />
            </span>
          </label>
          {/* The config in use, always visible once one is stored — with the way
              back to the picker. Chosen once, remembered, but never locked in. */}
          {vpnEnabled && vpnConfig && (
            <div className="vpn-config-current">
              <span className="remote-connect-location-label">{t("remoteConnect.configLabel")}</span>
              <span className="vpn-config-current-name" title={vpnConfig}>{vpnConfigName}</span>
              <button
                type="button"
                className="vpn-config-change-btn"
                disabled={vpnBusy || changingVpnConfig}
                title={t("remoteConnect.changeConfigTitle")}
                onClick={() => setChangingVpnConfig(true)}
              >
                {t("remoteConnect.changeConfig")}
              </button>
            </div>
          )}
          {showVpnPicker && (
            <div className="vpn-config-pick">
              <span className="ssh-optional-hint">
                {vpnConfig
                  ? t("remoteConnect.pickConfigHintChange")
                  : t("remoteConnect.pickConfigHintNew")}
              </span>
              {vpnConfigs.length > 0 && (
                <div className="folder-picker-row">
                  <Dropdown
                    className="dropdown-block vpn-config-recent"
                    value=""
                    placeholder={t("remoteConnect.recentConfigsPlaceholder")}
                    title={t("remoteConnect.recentConfigsTitle")}
                    onChange={(v) => {
                      if (!v) return;
                      selectVpnConfig(v);
                      setChangingVpnConfig(false);
                    }}
                    options={vpnConfigs.map((c) => ({ value: c.path, label: c.name }))}
                  />
                </div>
              )}
              <div className="folder-picker-row">
                <button
                  type="button"
                  className="dialog-connect-btn"
                  onClick={async () => {
                    await browseVpnConfig();
                    setChangingVpnConfig(false);
                  }}
                >
                  {t("remoteConnect.chooseConfigBtn")}
                </button>
                {/* Only an escape hatch when there is a config to fall back to. */}
                {vpnConfig && (
                  <button type="button" onClick={() => setChangingVpnConfig(false)}>
                    {t("common.cancel")}
                  </button>
                )}
              </div>
              {vpnStatus === "error" && vpnError && (
                <div className="project-dialog-error">{vpnError}</div>
              )}
            </div>
          )}
          {/* `!vpnTerm` is what makes the headless→terminal escape hatch below work:
              once a login terminal has been opened for this config, *that* is where
              the tunnel is being authenticated, whichever mode the app is in — so the
              password fields step aside for it rather than sitting there inert. */}
          {vpnEnabled && vpnConfig && !changingVpnConfig && (headless && !vpnTerm && !vpnViaTerminal ? (
              <>
                {vpnNeeds.username && (
                  <label className="remote-connect-field">
                    {t("remoteConnect.vpnUsernameLabel")}
                    <input
                      type="text"
                      value={vpnUsername}
                      autoComplete="off"
                      placeholder={t("vpnPrompt.usernamePlaceholder")}
                      disabled={vpnBusy}
                      onChange={(e) => setVpnUsername(e.target.value)}
                    />
                  </label>
                )}
                <label className="remote-connect-field">
                  {vpnNeeds.username ? t("remoteConnect.vpnPasswordLabel") : t("remoteConnect.vpnPassphraseLabel")}
                  <PasswordInput
                    value={vpnPassword}
                    autoComplete="off"
                    // A saved secret can't be pre-filled — it never leaves the
                    // backend — so say so: blank means "use the saved one".
                    placeholder={
                      vpnSaved
                        ? t("remoteConnect.vpnSavedPlaceholder")
                        : vpnNeeds.username
                          ? t("remoteConnect.vpnAccountPasswordPlaceholder")
                          : t("remoteConnect.vpnPassphrasePlaceholder")
                    }
                    disabled={vpnBusy}
                    onChange={(e) => setVpnPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitVpn();
                    }}
                  />
                </label>
                {vpnNeedsKeyPassphrase && (
                  <label className="remote-connect-field">
                    {t("vpnPrompt.keyPassphraseLabel")}
                    <PasswordInput
                      value={vpnKeyPassphrase}
                      autoComplete="off"
                      placeholder={
                        vpnSaved
                          ? t("remoteConnect.vpnSavedPlaceholder")
                          : t("vpnPrompt.keyPassphrasePlaceholder")
                      }
                      disabled={vpnBusy}
                      onChange={(e) => setVpnKeyPassphrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitVpn();
                      }}
                    />
                    <span className="ssh-optional-hint">
                      {t("vpnPrompt.keyPassphraseHint")}
                    </span>
                  </label>
                )}
                <div className="remote-connect-field">
                  {!vpnBusy && (
                    <button
                      type="button"
                      className="dialog-connect-btn"
                      onClick={submitVpn}
                    >
                      {vpnStatus === "error" ? t("remoteConnect.retryVpn") : t("remoteConnect.connectVpn")}
                    </button>
                  )}
                  {/* The tunnel's own teardown, independent of SSH: a VPN that came
                      up while SSH still fails has to be droppable on its own (retry
                      on another network, swap the config, or just get off the VPN). */}
                  {vpnBusy && (
                    <button
                      type="button"
                      className="vpn-disconnect-btn"
                      title={
                        vpnStatus === "connected"
                          ? t("remoteConnect.vpnStopTitleConnected")
                          : t("remoteConnect.vpnStopTitleConnecting")
                      }
                      onClick={stopVpn}
                    >
                      {vpnStatus === "connected" ? t("remoteConnect.disconnectVpn") : t("vpnPrompt.stop")}
                    </button>
                  )}
                </div>
                {vpnSaveRow}
                {(vpnStatus === "connecting" || vpnLog.length > 0) && (
                  <ConnectionLog lines={vpnLog} busy={vpnStatus === "connecting"} />
                )}
                {vpnStatus === "error" && vpnError && (
                  <div className="project-dialog-error">{vpnError}</div>
                )}
              </>
            ) : (
              <div className="dialog-connect">
                <button
                  type="button"
                  className="dialog-connect-btn"
                  disabled={!!vpnTerm}
                  title={t("remoteConnect.vpnTermBtnTitle")}
                  onClick={() => void startVpnTerm()}
                >
                  <span className="dialog-connect-btn-icon" aria-hidden="true"><TerminalIcon /></span>
                  {vpnTerm ? t("remoteConnect.vpnTermOpenBelow") : t("remoteConnect.vpnTermOpenBtn")}
                </button>
                {vpnTerm && (
                  <div className="dialog-connect-terminal">
                    <div className="dialog-connect-terminal-bar">
                      <span className="ssh-optional-hint">
                        {t("remoteConnect.vpnTermHint")}
                      </span>
                      <button type="button" className="vpn-disconnect-btn" onClick={stopVpn}>
                        {t("remoteConnect.disconnect")}
                      </button>
                    </div>
                    <CredentialPasteBar ptyId={vpnTerm.id} entries={vpnPaste} />
                    <div className="dialog-connect-terminal-host">
                      {/* A re-adopted terminal (tunnel still running from an earlier
                          open of this dialog) attaches to its live PTY instead of
                          spawning a second one — and so must not re-type the command. */}
                      <TerminalView
                        id={vpnTerm.id}
                        cmd=""
                        cwd=""
                        initialInput={vpnTerm.adopted ? undefined : vpnTerm.command}
                        attachOnly={vpnTerm.adopted}
                        visible
                        focused
                        persistOnUnmount
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
            {/* Outside the branch above, so it is reachable from *both* states: it is
                what switches into the terminal login, and the only way back out of it
                once the terminal has been disconnected. Only where there is a tunnel
                to sign in to — with the section collapsed or no config picked, there
                is nothing for it to switch. */}
            {headless && (vpnViaTerminal || !!vpnTerm) && vpnEnabled && vpnConfig && !changingVpnConfig && vpnSaveRow}
            {headless && vpnEnabled && vpnConfig && !changingVpnConfig && (
              <TerminalSignInToggle
                channel="vpn"
                checked={vpnViaTerminal}
                busy={!!vpnTerm}
                failed={vpnStatus === "error"}
                onChange={setVpnViaTerminal}
              />
            )}
        </div>
        )}

        {/* ── SSH ───────────────────────────────────────────────────────────── */}
        <div className="remote-reconnect-section" role="group" aria-label={t("remoteConnect.sshSectionAria")}>
          <div className="remote-field-label">
            <ConnLamp status={sshStatus} label="SSH" />
            {t("remoteConnect.sshSectionLabel")}
          </div>
          {/* The login name — the other half of the credential, and deliberately
              OUTSIDE the headless/non-headless split, because it is not a password:
              it is part of the address in both modes. Headless sends it to
              `ssh_connect`/`remote_connect`; non-headless types it into the login
              terminal *and* uses it to find the ControlMaster that login leaves
              behind (the socket is hashed over user+host+port, so the two disagreeing
              is a red lamp behind a login that visibly worked). The project's address
              is fixed at creation, so without this a project created with no user —
              which authenticates as your *local* account name — or with the wrong one
              could not be corrected at all. Committed on blur/Enter; connecting
              commits it first, so it counts even without leaving the field. */}
          <label className="remote-connect-field">
            <span className="remote-machine-add-label">
              {t("remoteConnect.usernameLabel")}
              <UntestedTag id="remoteConnectDialog.3" />
            </span>
            <input
              type="text"
              value={sshUser}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("remoteConnect.usernamePlaceholder")}
              disabled={connecting || connected}
              onChange={(e) => setSshUser(e.target.value)}
              onBlur={() => void commitSshUser()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="ssh-optional-hint">
              {t("remoteConnect.usernameHint", { host: host ? host.host : (project.remote?.host ?? "") })}
            </span>
          </label>
          {/* `!sshTerm` keeps a started terminal login on screen even if the switch
              below is flipped back: the session it is authenticating is real, and the
              password fields would orphan it. */}
          {headless && !sshViaTerminal && !sshTerm ? (
            <>
              <label className="remote-connect-field">
                {t("remoteConnect.sshPasswordLabel")}
                <PasswordInput
                  value={sshPassword}
                  autoFocus
                  autoComplete="off"
                  // The saved password stays in the keychain (the backend never hands
                  // it back), so the field can't be pre-filled. Blank + Connect uses it.
                  placeholder={
                    sshSaved
                      ? t("remoteConnect.sshSavedPlaceholder")
                      : t("remoteConnect.sshPasswordPlaceholder")
                  }
                  disabled={connecting || connected}
                  onChange={(e) => setSshPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void connectSshHeadless(sshPassword, rememberArg(sshRemember));
                  }}
                />
                <button
                  type="button"
                  className="dialog-connect-btn"
                  disabled={connecting || connected}
                  onClick={() => void connectSshHeadless(sshPassword, rememberArg(sshRemember))}
                >
                  {connected ? t("remoteConnect.connectedState") : connecting ? t("vpnPrompt.connecting") : t("common.connect")}
                </button>
                {connecting && (
                  <button
                    type="button"
                    className="vpn-disconnect-btn"
                    title={t("remoteConnect.sshStopTitle")}
                    onClick={stopSsh}
                  >
                    {t("vpnPrompt.stop")}
                  </button>
                )}
              </label>
              {sshSaveRow}
              {/* Eligibility is the ONE shared formula (`autoConnectEligibility`),
                  which is what finally brings the **HPC tag** here: a tagged host is
                  one `stores/projects` refuses to dial unattended, so this switch
                  was armable and guaranteed to do nothing. It now reads like the
                  Machines menu's — disabled, and saying which wall it hit. */}
              <label
                className="remote-connect-remember"
                title={
                  autoConnectBlock === "hpc"
                    ? t("autoConnect.hpcTitle")
                    : autoConnectEligible
                      ? t("remoteConnect.autoConnectTitleEligible")
                      : t("remoteConnect.autoConnectTitleNotEligible")
                }
              >
                <Toggle
                  size="sm"
                  checked={autoConnect && autoConnectEligible}
                  disabled={!autoConnectEligible}
                  onChange={(e) => setAutoConnect(e.target.checked)}
                />
                {t("remoteConnect.autoConnectLabel")}
                {autoConnectBlock === "hpc" && (
                  <span className="machines-auto-blocked"> {t("autoConnect.offWhileHpc")}</span>
                )}
                <span className="ssh-optional-hint">
                  {autoConnectEligible
                    ? t("remoteConnect.autoConnectHintEligible")
                    : autoConnectBlock === "hpc"
                      ? t("autoConnect.hpcTitle")
                      : t("remoteConnect.autoConnectHintNotEligible")}
                </span>
              </label>
              {/* Auto-connect never prompts — so if it can reach for the VPN, this
                  line is the user's only chance to know that launching Tabtivity may
                  reroute their machine before they've clicked anything. */}
              {autoConnectEligible && autoConnect && vpnEnabled && (
                <div className="remote-connect-vpn-warning">
                  {t("remoteConnect.autoConnectVpnWarningPre")}{" "}
                  <strong>{t("remoteConnect.autoConnectVpnWarningStrong")}</strong>{" "}
                  {t("remoteConnect.autoConnectVpnWarningPost")}
                </div>
              )}
              {sshStatus === "error" && sshError && (
                <div className="project-dialog-error">{sshError}</div>
              )}
            </>
          ) : winManual ? (
            // Windows has no ControlMaster socket to ride an interactive login,
            // so fall back to the headless-style key-auth connect.
            <div className="dialog-connect">
              <button
                type="button"
                className="dialog-connect-btn"
                disabled={connecting || connected}
                onClick={() => void connectSshHeadless("")}
              >
                {connected ? t("remoteConnect.connectedState") : connecting ? t("vpnPrompt.connecting") : t("common.connect")}
              </button>
              {connecting && (
                <button
                  type="button"
                  className="vpn-disconnect-btn"
                  title={t("remoteConnect.sshStopTitle")}
                  onClick={stopSsh}
                >
                  {t("vpnPrompt.stop")}
                </button>
              )}
              {sshStatus === "error" && sshError && (
                <div className="project-dialog-error">{sshError}</div>
              )}
            </div>
          ) : (
            <div className="dialog-connect">
              <button
                type="button"
                className="dialog-connect-btn"
                disabled={!!sshTerm}
                title={t("remoteConnect.sshTermBtnTitle")}
                onClick={() => void startSshTerm()}
              >
                <span className="dialog-connect-btn-icon" aria-hidden="true"><TerminalIcon /></span>
                {sshTerm ? t("remoteConnect.sshTermOpenBelow") : t("remoteConnect.sshTermOpenBtn")}
              </button>
              {sshTerm && !connected && (
                <button
                  type="button"
                  className="dialog-connect-btn"
                  title={t("remoteConnect.tryConnectTitle")}
                  onClick={tryConnectNow}
                >
                  {t("remoteConnect.tryConnectBtn")}
                </button>
              )}
              {sshTerm && (
                <div className="dialog-connect-terminal">
                  <div className="dialog-connect-terminal-bar">
                    <span className="ssh-optional-hint">
                      {t("remoteConnect.sshTermHint")}
                    </span>
                    <button type="button" className="vpn-disconnect-btn" onClick={stopSsh}>
                      {t("remoteConnect.disconnect")}
                    </button>
                  </div>
                  <CredentialPasteBar ptyId={sshTerm.id} entries={sshPaste} />
                  <div className="dialog-connect-terminal-host">
                    <TerminalView
                      id={sshTerm.id}
                      cmd=""
                      cwd=""
                      initialInput={sshTerm.adopted ? undefined : sshTerm.command}
                      attachOnly={sshTerm.adopted}
                      visible
                      focused
                      persistOnUnmount
                    />
                  </div>
                </div>
              )}
              {/* Auto-connect, non-headless flavour. It is offered here with no
                  eligibility gate because there is nothing to be eligible against:
                  Tabtivity holds no passwords in this mode, so "connect on launch" means
                  this same login opens in the root terminal for you to authenticate —
                  the substitution `autoConnectInteractive` (stores/projects) makes,
                  and the one the header's "Connect on launch" already makes for a
                  tunnel. */}
              {/* Ungated *except* for the HPC tag, which is not a credential
                  question: a tagged host is never dialled unattended at all, so
                  even the "the login opens in the root terminal for you" flavour
                  of auto-connect has nothing to open. */}
              <label
                className="remote-connect-remember"
                title={
                  autoConnectBlock === "hpc"
                    ? t("autoConnect.hpcTitle")
                    : t("remoteConnect.autoConnectInteractiveTitle")
                }
              >
                <Toggle
                  size="sm"
                  checked={autoConnect && autoConnectEligible}
                  disabled={!autoConnectEligible}
                  onChange={(e) => setAutoConnect(e.target.checked)}
                />
                {t("remoteConnect.autoConnectLabel")}
                {autoConnectBlock === "hpc" && (
                  <span className="machines-auto-blocked"> {t("autoConnect.offWhileHpc")}</span>
                )}
                <UntestedTag id="remoteConnectDialog.4" />
                <span className="ssh-optional-hint">
                  {autoConnectBlock === "hpc"
                    ? t("autoConnect.hpcTitle")
                    : t("remoteConnect.autoConnectInteractiveHint")}
                </span>
              </label>
            </div>
          )}
          {/* Outside the branch above, for the same reason the VPN one is: it is both
              the way into the terminal login and the only way back out once that
              terminal has been disconnected. */}
          {headless && (sshViaTerminal || !!sshTerm) && sshSaveRow}
          {headless && !winManual && (
            <TerminalSignInToggle
              channel="ssh"
              checked={sshViaTerminal}
              busy={!!sshTerm}
              failed={sshStatus === "error"}
              onChange={setSshViaTerminal}
            />
          )}
          {/* Outside the headless/non-headless branches, like the two rows above:
              how gently to treat a machine is a property of the machine, not of how
              you happen to log into it. Whichever host this dialog is showing —
              the project's primary or one of its workers — gets its own answer,
              because a login node and the compute node behind it are not the same
              kind of machine even when they belong to the same cluster. */}
          <CarefulHostToggle target={carefulTarget} />
          {/* The stronger statement about the same machine: careful is how much
              Tabtivity reads, this is what it is allowed to do (`lib/remote/hpc/hpcHost.ts`). */}
          <HpcHostToggle target={carefulTarget} />
        </div>

        <div className="project-dialog-actions">
          {/* Shown whenever *either* channel is up or coming up — a tunnel that came
              up while SSH stayed down still has to be teardownable, and gating this
              on SSH alone left exactly that state with no way out. */}
          {(sshStatus !== "off" || vpnStatus !== "off") && (
            <button
              type="button"
              onClick={() => {
                // Cancellation-aware teardown of both channels (abandons an
                // in-flight connect too, not just a live pool), then mirror it into
                // the projects store so a switch-away can't resurrect the pool.
                stopSsh();
                if (vpnConfig) stopVpn();
                disconnectRemote(project.id);
                close();
              }}
            >
              {t("remoteConnect.disconnect")}
            </button>
          )}
          {/* Explicitly confirmed teardown. A plain Disconnect also ends tmux
              sessions; this variant retains the extra confirmation affordance. */}
          {sshStatus === "connected" &&
            (killArm ? (
              <button
                type="button"
                className="vpn-disconnect-btn"
                title={t("remoteConnect.killConfirmTitle")}
                onClick={() => {
                  setKillArm(false);
                  void invoke("remote_kill_all_jobs", killTarget).catch(() => {});
                  stopSsh();
                  if (vpnConfig) stopVpn();
                  disconnectRemote(project.id);
                  close();
                }}
              >
                {t("remoteConnect.killConfirmBtn")}
              </button>
            ) : (
              <button
                type="button"
                title={t("remoteConnect.killArmTitle")}
                onClick={() => setKillArm(true)}
              >
                {t("remoteConnect.killArmBtn")}
                <UntestedTag id="remoteConnectDialog.5" />
              </button>
            ))}
          {/* Only offered when there is something to forget — the keychain state
              (queried on mount) is the source of truth, not the toggles. Stays
              open afterwards so the emptied "Save password" toggles are visible
              and the user can reconnect with a fresh password right here. */}
          {(sshSaved || vpnSaved) && (
            <button
              type="button"
              title={t("remoteConnect.forgetPasswordTitle")}
              onClick={() => void forgetPasswords()}
            >
              {t("remoteConnect.forgetPasswordBtn")}
            </button>
          )}
          <button type="button" onClick={close}>{t("common.close")}</button>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
