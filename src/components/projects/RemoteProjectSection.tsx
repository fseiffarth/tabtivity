import { joinRemotePath, parseSshAddress } from "./scaffold";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import { TerminalSignInToggle } from "./TerminalSignInToggle";
import { SavePasswordRow } from "./SavePasswordRow";
import { CredentialPasteBar, sshPasteEntries, vpnPasteEntries } from "./CredentialPasteBar";
import { TerminalView } from "../terminal/TerminalView";
import { ConnectionLog } from "../common/ConnectionLog";
import { ConnLamp } from "../common/ConnLamp";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { Toggle } from "../common/Toggle";
import { VpnTunnelUpNotice } from "../common/VpnTunnelUpNotice";
import { useVpnSectionVisible } from "../../stores/remote/vpn/vpnStatus";
import type { ConnState } from "../../stores/remote/remoteStatus";
import type { useRemoteSession } from "./useRemoteSession";
import { useT, type TranslationKey } from "../../lib/i18n";
import { HpcHostToggle } from "./HpcHostToggle";
import { TerminalIcon, WarningIcon } from "../common/icons/Icon";
import { ErrorNote } from "../common/ErrorNote";

type RemoteSession = ReturnType<typeof useRemoteSession>;

/** Map the dialog's connection status (`idle|connecting|connected|error`) to a
 *  lamp state (`off|connecting|connected|error`). */
function lampOf(status: RemoteSession["sshStatus"]): ConnState {
  return status === "idle" ? "off" : status;
}

/** Human-readable status shown when hovering the "Connect VPN" button, so the
 *  current tunnel state (and any failure reason) is reported without taking up
 *  permanent space in the dialog. */
function vpnStatusHint(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  status: RemoteSession["vpnStatus"],
  error: string,
  config: string,
): string {
  switch (status) {
    case "connecting":
      return t("vpnPrompt.connectTitleConnecting");
    case "connected":
      return t("remoteProjectSection.vpnUpClickToReconnect");
    case "error":
      return error
        ? t("remoteProjectSection.vpnFailedWithError", { error })
        : t("remoteProjectSection.vpnFailedClickRetry");
    default:
      return config
        ? t("remoteProjectSection.vpnBringUpHint")
        : t("remoteProjectSection.vpnSelectConfigFirst");
  }
}

/**
 * Presentational SSH + OpenVPN + remote-browser section of the project dialog.
 * All state and effects live in `useRemoteSession`; this component only renders
 * it and forwards events. `onClose` lets Escape in the fields dismiss the dialog.
 *
 * The remote flow is stepped: step "connect" (SSH + OpenVPN, each with a lamp)
 * → step "browse" (the live remote folder picker) → step "details" (handled by
 * the dialog body). Windows non-headless has no ControlMaster to browse over, so
 * it skips "browse" and types the remote path in the connect step instead.
 */
export function RemoteProjectSection({
  kind,
  safeName,
  onClose,
  onUseThisFolder,
  remote,
}: {
  kind: "new" | "import";
  safeName: string;
  onClose: () => void;
  onUseThisFolder: () => void;
  remote: RemoteSession;
}) {
  const t = useT();
  const {
    isRemoteProject,
    headless,
    winManual,
    sshViaTerminal,
    setSshViaTerminal,
    vpnViaTerminal,
    setVpnViaTerminal,
    step,
    tryBrowseNow,
    sshTooling,
    sshAddress,
    sshAddresses,
    sshPassword,
    sshStatus,
    sshError,
    sshRemember,
    setSshRemember,
    sshSaved,
    sshCredential,
    forgetSshPassword,
    remoteBrowsePath,
    remoteEntries,
    remoteListBusy,
    remoteListError,
    remoteChosenPath,
    setRemoteChosenPath,
    remotePaths,
    jumpToRemotePath,
    vpnEnabled,
    setVpnEnabled,
    vpnConfig,
    vpnConfigs,
    vpnUsername,
    setVpnUsername,
    vpnNeeds,
    vpnNeedsKeyPassphrase,
    selectVpnConfig,
    vpnPassword,
    setVpnPassword,
    vpnKeyPassphrase,
    setVpnKeyPassphrase,
    vpnStatus,
    setVpnStatus,
    vpnError,
    vpnRemember,
    setVpnRemember,
    vpnSaved,
    forgetVpnPassword,
    vpnLog,
    vpnTerm,
    startVpnTerm,
    stopVpnTerm,
    sshTerm,
    startSshTerm,
    stopSshTerm,
    browseVpnConfig,
    connectVpn,
    onSshAddressChange,
    onSshPasswordChange,
    connectSsh,
    enterRemoteFolder,
    remoteGoUp,
    createRemoteFolder,
  } = remote;

  // Same gate as the Connect modal: a tunnel is machine-wide, so once one is up
  // (from the header, another project, or connect-on-launch) this dialog has no
  // tunnel left to offer and collapses its OpenVPN block to a one-line notice —
  // unless the live tunnel is the one *this* dialog just brought up, whose log and
  // state belong here. The project simply stores no config in that case; the
  // Connect modal can still attach one later.
  const vpnBusy = vpnStatus === "connecting" || vpnStatus === "connected";
  const showVpnSection = useVpnSectionVisible(vpnBusy);

  if (!isRemoteProject) return null;

  // "Paste username/password" above each login terminal (see `CredentialPasteBar`).
  // The host here is the *typed* address rather than a stored spec — this dialog is
  // where the project is still being created — so the paste target is parsed from the
  // same string `sshSaved` was asked about, and a saved credential from an earlier
  // project on the same host is reachable without retyping it.
  const sshTarget = parseSshAddress(sshAddress);
  const sshPaste = sshPasteEntries(t, {
    user: sshTarget?.user,
    host: sshTarget?.host,
    port: sshTarget?.port,
    saved: sshSaved,
  });
  const vpnPaste = vpnPasteEntries(t, {
    config: vpnConfig,
    username: vpnUsername,
    saved: vpnSaved,
    needsUsername: vpnNeeds.username,
    needsKeyPassphrase: vpnNeedsKeyPassphrase,
  });

  // Rendered beside whichever credential field comes last, so the button always
  // sits at the end of the VPN form rather than mid-way through it.
  const vpnConnectButton = (
    <button
      type="button"
      className={`vpn-connect-btn vpn-status-${vpnStatus}`}
      disabled={!vpnConfig || vpnStatus === "connecting"}
      title={vpnStatusHint(t, vpnStatus, vpnError, vpnConfig)}
      onClick={() => void connectVpn()}
    >
      {vpnStatus === "connecting" && <span className="vpn-spinner" aria-hidden="true" />}
      {vpnStatus === "connecting"
        ? t("vpnPrompt.connecting")
        : vpnStatus === "connected"
          ? t("remoteConnect.connectedState")
          : vpnStatus === "error"
            ? t("remoteConnect.retryVpn")
            : t("remoteConnect.connectVpn")}
    </button>
  );

  // The two "save the secret" rows, defined once and rendered from **both** halves of
  // the login section. They belong to the *host*, not to how you happen to be signing
  // in this time: switching to the terminal login must not make a saved credential
  // look discarded (and must certainly never delete it — only unticking does that,
  // and only by the user's own click). A terminal login is one Tabtivity never sees, so
  // nothing *new* is stored from it; the saved credential is simply kept for the
  // connects that can use it, which the hint says rather than leaving it to be
  // guessed.
  const vpnSaveRow = (
    <label className="remote-connect-remember">
      <Toggle
        size="sm"
        checked={vpnRemember}
        onChange={(e) => {
          setVpnRemember(e.target.checked);
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
  // The keychain is keyed by host target, not by project — so the password saved here
  // is the one this project's later reconnects (and auto-connect) use, and a host
  // already saved by another project shows up pre-ticked rather than being silently
  // cleared.
  // The HPC tag, on the form where a *new* project's host is logged in to. Same
  // target the save row is keyed by — the typed address, since the project does
  // not exist yet — so ticking it here is the same fact as ticking it on the
  // Machines menu's add form, and the very first connect already behaves
  // (`lib/remote/hpc/hpcHost.ts`).
  const hpcRow = sshTarget?.host ? (
    <HpcHostToggle
      target={{
        // `parseSshAddress` spells "absent" as null; the tag's target key spells
        // it as undefined, and the two must agree or a tag written here would be
        // keyed differently from the same host tagged anywhere else.
        user: sshTarget.user ?? undefined,
        host: sshTarget.host,
        port: sshTarget.port ?? undefined,
      }}
    />
  ) : null;
  // The shared row (`SavePasswordRow`) — same component the Connect modal and the
  // add-a-machine form render, so the toggle is *disabled* during a terminal
  // sign-in here too. It was live before, which meant the user could tick "Save
  // password" on a login that never calls `ssh_connect` and therefore never
  // carries `remember`: nothing was ever saved, and nothing said so. The row also
  // brings the locked-keyring banner, so "we can't read your keychain" stops
  // rendering as a confident "nothing saved".
  const sshSaveRow = (
    <SavePasswordRow
      credential={sshCredential}
      checked={sshRemember}
      viaTerminal={sshViaTerminal}
      onChange={(on) => {
        setSshRemember(on);
        // Untick = delete it now, not at a next connect that may never come — and
        // the connect itself no longer deletes anything, by design.
        if (!on && sshSaved) void forgetSshPassword();
      }}
    />
  );

  // The non-headless login authenticates in a terminal, so its lamp tracks the
  // readiness poll (connecting while the master comes up, green once browsable).
  const sshLamp: ConnState = winManual ? "off" : lampOf(sshStatus);

  return (
    <>
      <div className="remote-steps" role="list" aria-label={t("remoteProjectSection.remoteStepsAria")}>
        <span className={`remote-step${step === "connect" ? " is-active" : ""}`} role="listitem">
          1 {t("remoteProjectSection.stepConnectLabel")}
        </span>
        {!winManual && (
          <span className={`remote-step${step === "browse" ? " is-active" : ""}`} role="listitem">
            2 {t("remoteProjectSection.stepBrowseLabel")}
          </span>
        )}
        <span className={`remote-step${step === "details" ? " is-active" : ""}`} role="listitem">
          {winManual ? "2" : "3"} {t("remoteProjectSection.stepDetailsLabel")}
        </span>
      </div>

      {step === "connect" && (
        <>
          {sshTooling &&
            (() => {
              // Mount-free remote: no sshfs/FUSE needed. Only password auth and
              // VPN-gated (openvpn/pkexec) hosts depend on extra tooling. Password
              // auth rides OpenSSH's own SSH_ASKPASS everywhere; on Windows that
              // needs OpenSSH ≥ 8.4, with sshpass as the legacy fallback — the
              // warning fires only when neither is available. The VPN warning fires
              // only once a config is selected, since OpenVPN is optional.
              const warnings: string[] = [];
              if (sshPassword && !sshTooling.password_auth) {
                warnings.push(t("remoteProjectSection.passwordAuthWarning"));
              }
              if (showVpnSection && vpnEnabled && vpnConfig && !sshTooling.openvpn) {
                warnings.push(t("remoteProjectSection.opensslMissingWarning"));
              }
              if (warnings.length === 0) return null;
              return (
                <div className="ssh-tooling-warning" role="alert">
                  {warnings.map((w) => (
                    <div key={w}><WarningIcon /> {w}</div>
                  ))}
                </div>
              );
            })()}

          <div className="ssh-connect-fields" role="group" aria-label={t("remoteConnect.vpnSectionAria")}>
            {/* A tunnel that is already up machine-wide leaves this section nothing
                to do — say so in one line and go straight to SSH. */}
            {!showVpnSection && <VpnTunnelUpNotice />}
            {showVpnSection && (
              <>
            {/* OpenVPN is opt-in (default off): reaching the host directly needs
                no tunnel when you're already on the right network. Flip the toggle
                only for a VPN-gated host; the config + connect UI stays collapsed
                otherwise, and no VPN config is stored on the project. */}
            <label className={`toggle-card${vpnEnabled ? " is-on" : ""}`}>
              <span className="toggle-card-body">
                <span className="toggle-card-title">
                  <ConnLamp status={lampOf(vpnStatus)} label="OpenVPN" />
                  {t("remoteConnect.vpnToggleTitle")}
                </span>
                <span className="toggle-card-desc">
                  {t("remoteProjectSection.vpnToggleDescLine1")}
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
                  onChange={(e) => setVpnEnabled(e.target.checked)}
                />
                <span className="eld-switch-track" aria-hidden="true" />
              </span>
            </label>
            {vpnEnabled && (
            <div className="vpn-details">
                <label>
                  {t("remoteProjectSection.vpnConfigLabel")}{" "}
                  <span className="ssh-optional-hint">{t("remoteProjectSection.vpnConfigCopiedHint")}</span>
                  {vpnConfigs.length > 0 && (
                    <div className="folder-picker-row">
                      <Dropdown
                        className="dropdown-block vpn-config-recent"
                        value={vpnConfigs.some((c) => c.path === vpnConfig) ? vpnConfig : ""}
                        placeholder={t("remoteConnect.recentConfigsPlaceholder")}
                        title={t("remoteConnect.recentConfigsTitle")}
                        onChange={(v) => {
                          if (v) selectVpnConfig(v);
                        }}
                        options={vpnConfigs.map((c) => ({ value: c.path, label: c.name }))}
                      />
                    </div>
                  )}
                  <div className="folder-picker-row">
                    <input
                      className="ssh-address-input"
                      readOnly
                      value={vpnConfig}
                      placeholder={t("remoteProjectSection.noOvpnSelected")}
                      title={vpnConfig}
                    />
                    <button type="button" onClick={() => void browseVpnConfig()}>
                      {t("remoteProjectSection.browseEllipsis")}
                    </button>
                  </div>
                </label>
                {/* `!vpnTerm` is what makes the headless→terminal escape hatch below
                    work: once a login terminal is open for this config, that is where
                    the tunnel is being authenticated whichever mode the app is in, so
                    the password fields step aside for it instead of sitting there
                    inert. */}
                {headless && !vpnTerm && !vpnViaTerminal ? (
                  <>
                    {vpnNeeds.username && (
                      <label>
                        {t("remoteConnect.vpnUsernameLabel")}{" "}
                        <span className="ssh-optional-hint">{t("remoteProjectSection.storedWithProject")}</span>
                        <input
                          className="ssh-password-input"
                          type="text"
                          value={vpnUsername}
                          placeholder={t("remoteProjectSection.vpnUsernamePlaceholderNoDots")}
                          onChange={(e) => {
                            setVpnUsername(e.target.value);
                            if (vpnStatus !== "idle") setVpnStatus("idle");
                          }}
                        />
                      </label>
                    )}
                    <label>
                      {vpnNeeds.username ? t("remoteConnect.vpnPasswordLabel") : t("remoteConnect.vpnPassphraseLabel")}{" "}
                      <span className="ssh-optional-hint">
                        {vpnSaved
                          ? t("remoteProjectSection.savedInKeychainYour")
                          : t("remoteProjectSection.notStoredUnlessSaved")}
                      </span>
                      <div className="folder-picker-row">
                        <PasswordInput
                          className="ssh-password-input"
                          value={vpnPassword}
                          // A saved secret can't be pre-filled — it never leaves the
                          // backend — so blank means "use the saved one".
                          placeholder={
                            vpnSaved
                              ? t("remoteConnect.vpnSavedPlaceholder")
                              : vpnNeeds.username
                                ? t("remoteProjectSection.vpnAccountPasswordNoDots")
                                : t("remoteConnect.vpnPassphraseLabel")
                          }
                          onChange={(e) => {
                            setVpnPassword(e.target.value);
                            if (vpnStatus !== "idle") setVpnStatus("idle");
                          }}
                        />
                        {/* The connect button sits with the *last* credential field, so
                            a config that also needs a key passphrase moves it below. */}
                        {!vpnNeedsKeyPassphrase && vpnConnectButton}
                      </div>
                    </label>
                    {vpnNeedsKeyPassphrase && (
                      <label>
                        {t("vpnPrompt.keyPassphraseLabel")}{" "}
                        <span className="ssh-optional-hint">
                          {vpnSaved
                            ? t("remoteProjectSection.savedInKeychainYour")
                            : t("remoteProjectSection.notStoredUnlessSaved")}
                        </span>
                        <div className="folder-picker-row">
                          <PasswordInput
                            className="ssh-password-input"
                            value={vpnKeyPassphrase}
                            placeholder={
                              vpnSaved
                                ? t("remoteConnect.vpnSavedPlaceholder")
                                : t("remoteProjectSection.keyPassphrasePlaceholderNoDots")
                            }
                            onChange={(e) => {
                              setVpnKeyPassphrase(e.target.value);
                              if (vpnStatus !== "idle") setVpnStatus("idle");
                            }}
                          />
                          {vpnConnectButton}
                        </div>
                      </label>
                    )}
                    {/* Same opt-in as the Connect modal's, writing the same keychain
                        entry (keyed by config path). Without it, a tunnel set up here
                        asked for its passphrase again on the very next activation. */}
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
                      disabled={!vpnConfig || !!vpnTerm}
                      title={
                        vpnConfig
                          ? t("remoteProjectSection.vpnTermBtnTitleActive")
                          : t("remoteProjectSection.vpnSelectConfigFirst")
                      }
                      onClick={() => void startVpnTerm()}
                    >
                      <span className="dialog-connect-btn-icon" aria-hidden="true"><TerminalIcon /></span>
                      {vpnTerm ? t("remoteConnect.vpnTermOpenBelow") : t("remoteConnect.vpnTermOpenBtn")}
                    </button>
                    {!vpnTerm && (
                      <div className="ssh-optional-hint">
                        {t("remoteProjectSection.vpnTermHintClosed")}
                      </div>
                    )}
                    {vpnTerm && (
                      <div className="dialog-connect-terminal">
                        <div className="dialog-connect-terminal-bar">
                          <span className="ssh-optional-hint">
                            {t("remoteProjectSection.vpnTermHintOpen")}
                          </span>
                          <button
                            type="button"
                            className="vpn-disconnect-btn"
                            onClick={() => stopVpnTerm()}
                          >
                            {t("remoteConnect.disconnect")}
                          </button>
                        </div>
                        <CredentialPasteBar ptyId={vpnTerm.id} entries={vpnPaste} />
                        <div className="dialog-connect-terminal-host">
                          <TerminalView
                            id={vpnTerm.id}
                            cmd=""
                            cwd=""
                            initialInput={vpnTerm.command}
                            visible
                            focused
                            persistOnUnmount
                          />
                        </div>
                      </div>
                    )}
                    {vpnError && <ErrorNote className="project-dialog-error" error={vpnError} />}
                  </div>
                )}
                {/* Outside the branch above, so it is reachable from *both* states: it
                    is what switches into the terminal login, and the only way back out
                    once that terminal has been disconnected. */}
                {headless && (vpnViaTerminal || !!vpnTerm) && vpnSaveRow}
                {headless && (
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
              </>
            )}
            <label>
              <span className="remote-field-label">
                <ConnLamp status={sshLamp} label="SSH" />
                {t("remoteProjectSection.sshAddressLabel")}
              </span>
              {sshAddresses.length > 0 && (
                <div className="folder-picker-row">
                  <Dropdown
                    className="dropdown-block vpn-config-recent"
                    value={sshAddresses.includes(sshAddress) ? sshAddress : ""}
                    placeholder={t("remoteConnect.recentConfigsPlaceholder")}
                    title={t("remoteProjectSection.reuseSshAddressTitle")}
                    onChange={(v) => {
                      if (v) onSshAddressChange(v);
                    }}
                    options={sshAddresses.map((addr) => ({ value: addr, label: addr }))}
                  />
                </div>
              )}
              <input
                className="ssh-address-input"
                value={sshAddress}
                placeholder={t("remoteProjectSection.sshAddressPlaceholder")}
                onChange={(e) => onSshAddressChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && sshAddress.trim() && sshStatus !== "connecting") {
                    e.preventDefault();
                    void connectSsh();
                  }
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
                }}
              />
            </label>
            {/* `!sshTerm` keeps a started terminal login on screen even if the switch
                below is flipped back: the session it is authenticating is real, and the
                password field would orphan it. */}
            {headless && !sshViaTerminal && !sshTerm ? (
              <>
                <label>
                  {t("remoteProjectSection.passwordLabel")}{" "}
                  <span className="ssh-optional-hint">
                    {sshSaved
                      ? t("remoteProjectSection.savedInKeychainYour")
                      : t("remoteProjectSection.notStoredBlankKey")}
                  </span>
                  <div className="folder-picker-row">
                    <PasswordInput
                      className="ssh-password-input"
                      value={sshPassword}
                      // A saved password never leaves the backend, so it can't be
                      // pre-filled: blank + Connect authenticates with it.
                      placeholder={
                        sshSaved
                          ? t("remoteProjectSection.sshSavedPlaceholder")
                          : t("remoteProjectSection.sshPasswordPlaceholderNoDots")
                      }
                      onChange={(e) => onSshPasswordChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && sshAddress.trim() && sshStatus !== "connecting") {
                          e.preventDefault();
                          void connectSsh();
                        }
                        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
                      }}
                    />
                    <button
                      type="button"
                      disabled={!sshAddress.trim() || sshStatus === "connecting"}
                      onClick={() => void connectSsh()}
                    >
                      {sshStatus === "connecting"
                        ? t("remoteProjectSection.connectingDotsShort")
                        : sshStatus === "connected"
                          ? t("remoteConnect.connectedState")
                          : t("common.connect")}
                    </button>
                  </div>
                </label>
                {/* The keychain is keyed by host target, not by project — so the
                    password saved here is the one this project's later reconnects
                    (and auto-connect) use, and a host already saved by another
                    project shows up pre-ticked rather than being silently cleared. */}
                {sshSaveRow}
                {hpcRow}
                {sshStatus === "error" && sshError && (
                  <div className="project-dialog-error">{sshError}</div>
                )}
              </>
            ) : (
              <>
                {winManual && (
                  <label>
                    {t("remoteProjectSection.remotePathLabel")}{" "}
                    <span className="ssh-optional-hint">
                      {kind === "new"
                        ? t("remoteProjectSection.remotePathHintNew")
                        : t("remoteProjectSection.remotePathHintImport")}
                    </span>
                    {remotePaths.length > 0 && (
                      <div className="folder-picker-row">
                        <Dropdown
                          className="dropdown-block vpn-config-recent"
                          value={remotePaths.includes(remoteChosenPath) ? remoteChosenPath : ""}
                          placeholder={t("remoteConnect.recentConfigsPlaceholder")}
                          title={t("remoteProjectSection.reuseRemotePathTitle")}
                          onChange={(v) => {
                            if (v) setRemoteChosenPath(v);
                          }}
                          options={remotePaths.map((p) => ({ value: p, label: p }))}
                        />
                      </div>
                    )}
                    <input
                      className="ssh-address-input"
                      value={remoteChosenPath}
                      placeholder={t("remoteProjectSection.remotePathPlaceholder")}
                      onChange={(e) => setRemoteChosenPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
                      }}
                    />
                  </label>
                )}
                <div className="dialog-connect">
                  <button
                    type="button"
                    className="dialog-connect-btn"
                    disabled={!sshAddress.trim() || !!sshTerm}
                    title={t("remoteProjectSection.sshTermBtnTitle")}
                    onClick={() => void startSshTerm()}
                  >
                    <span className="dialog-connect-btn-icon" aria-hidden="true"><TerminalIcon /></span>
                    {sshTerm ? t("remoteConnect.sshTermOpenBelow") : t("remoteConnect.sshTermOpenBtn")}
                  </button>
                  {!winManual && sshTerm && sshStatus !== "connected" && (
                    <button
                      type="button"
                      className="dialog-connect-btn"
                      title={t("remoteProjectSection.tryBrowseTitle")}
                      onClick={() => tryBrowseNow()}
                    >
                      {t("remoteMachines.loggedInBrowse")}
                    </button>
                  )}
                  {!sshTerm && (
                    <div className="ssh-optional-hint">
                      {t("remoteProjectSection.sshTermHintClosedPre")}
                      {!winManual && t("remoteProjectSection.sshTermHintClosedSuffix")}
                    </div>
                  )}
                  {sshTerm && (
                    <div className="dialog-connect-terminal">
                      <div className="dialog-connect-terminal-bar">
                        <span className="ssh-optional-hint">
                          {t("remoteProjectSection.sshTermHintOpen")}
                        </span>
                        <button
                          type="button"
                          className="vpn-disconnect-btn"
                          onClick={() => stopSshTerm()}
                        >
                          {t("remoteConnect.disconnect")}
                        </button>
                      </div>
                      <CredentialPasteBar ptyId={sshTerm.id} entries={sshPaste} />
                      <div className="dialog-connect-terminal-host">
                        <TerminalView
                          id={sshTerm.id}
                          cmd=""
                          cwd=""
                          initialInput={sshTerm.command}
                          visible
                          focused
                          persistOnUnmount
                        />
                      </div>
                    </div>
                  )}
                  {sshStatus === "error" && sshError && (
                    <div className="project-dialog-error">{sshError}</div>
                  )}
                </div>
              </>
            )}
            {/* Outside the branch above, for the same reason the VPN one is: it is
                both the way into the terminal login and the only way back out once
                that terminal has been disconnected. */}
            {headless && (sshViaTerminal || !!sshTerm) && sshSaveRow}
            {headless && (sshViaTerminal || !!sshTerm) && hpcRow}
            {headless && (
              <TerminalSignInToggle
                channel="ssh"
                checked={sshViaTerminal}
                busy={!!sshTerm}
                failed={sshStatus === "error"}
                onChange={setSshViaTerminal}
              />
            )}
          </div>
        </>
      )}

      {step === "browse" && !winManual && (
        <RemoteFolderBrowser
          path={remoteBrowsePath}
          entries={remoteEntries}
          busy={remoteListBusy}
          error={remoteListError}
          recentPaths={remotePaths}
          onGoUp={remoteGoUp}
          onJumpPath={jumpToRemotePath}
          onEnterFolder={enterRemoteFolder}
          onUseFolder={onUseThisFolder}
          onCreateFolder={(name) => void createRemoteFolder(name)}
          footer={
            remoteChosenPath
              ? kind === "new"
                ? t("remoteProjectSection.willCreateLabel", { path: joinRemotePath(remoteChosenPath, safeName || "<name>") })
                : t("remoteProjectSection.selectedLabel", { path: remoteChosenPath })
              : t("remoteMachines.browserFooter")
          }
        />
      )}
    </>
  );
}
