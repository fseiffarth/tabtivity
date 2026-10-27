import { useState } from "react";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { unlockKeyring } from "../../lib/keyring";
import { useT } from "../../lib/i18n";
import type { SavedCredentialHandle } from "../../lib/projects/useSavedCredential";

/**
 * **The one "Save password" row** — the switch, the hint that says what it will
 * actually do, and the disclosure for the case where it cannot do anything.
 *
 * There were three near-identical copies (Connect modal, new/extend-project
 * section, add-a-machine form) and they had already drifted on the thing that
 * matters most:
 *
 *  - **Disabled during a terminal sign-in.** A terminal login never calls
 *    `ssh_connect`, so it never carries `remember` — the toggle has nothing to
 *    act through. Two surfaces disabled it and said so; two left it live, so the
 *    user ticked Save and nothing was ever saved. It is disabled, not hidden: a
 *    saved password belongs to the *host*, not to how you signed in this time,
 *    and a row that vanishes reads as one that was discarded.
 *  - **"Not saved" vs "we can't tell".** The row renders a `SavedCredential`
 *    tri-state (`useSavedCredential`), so a locked keyring produces a banner with
 *    an **Unlock keyring** button — the treatment the VPN modal has had all along
 *    — instead of a confidently-empty toggle that invites the user to untick a
 *    credential that is actually there.
 *  - **What the backend did.** `saveError` is `SshConnectOutcome.save_error`
 *    verbatim ("the OS keyring is locked, so nothing was saved…"), shown inline,
 *    because a ticked box with an empty keychain behind it is exactly the state
 *    that surfaces at the *next* launch as an unexplained password prompt.
 *
 * Unticking is handled by the caller (it owns the target and the forget call);
 * this only reports the state and hands back the new checked value.
 */
export function SavePasswordRow({
  credential,
  checked,
  onChange,
  disabled,
  viaTerminal,
  labelText,
  className,
  trailingToggle,
}: {
  credential: SavedCredentialHandle;
  checked: boolean;
  /** The new value of the switch. Deleting a saved credential on untick is the
   *  caller's business — it is the only act that may remove one. */
  onChange: (on: boolean) => void;
  /** The connect is in flight / already up: the row is frozen with it. */
  disabled?: boolean;
  /** This connect is signing in in a terminal, where `remember` never runs. */
  viaTerminal?: boolean;
  /** Defaults to "Save password"; the VPN variants pass their own wording. */
  labelText?: string;
  /** The label's class — surfaces differ in chrome, not in behaviour. */
  className?: string;
  /** Machines-window layout: label first, switch at the trailing edge, hint on
   *  its own line below. */
  trailingToggle?: boolean;
}) {
  const t = useT();
  const [unlocking, setUnlocking] = useState(false);
  const label = labelText ?? t("remoteConnect.savePassword");

  // What the row promises, in the state it is actually in. `checking` and
  // `unreadable` are their own answers — the whole reason the tri-state exists.
  const hint = viaTerminal
    ? credential.saved
      ? t("remoteConnect.saveHintKeptTerminal")
      : t("remoteConnect.saveHintNothingTerminal")
    : credential.checking
      ? t("savePassword.hintChecking")
      : credential.unreadable
        ? t("savePassword.hintUnreadable")
        : credential.saved
          ? t("remoteConnect.saveHintSaved")
          : t("vpnPrompt.storedSecurely");

  const doUnlock = async () => {
    setUnlocking(true);
    // The OS raises its own dialog; either way re-ask afterwards, since "the user
    // dismissed it" and "it unlocked" are both answered by re-reading the store.
    await unlockKeyring();
    setUnlocking(false);
    credential.refresh();
  };

  return (
    <>
      <label
        className={className ?? "remote-connect-remember"}
        title={viaTerminal ? t("savePassword.titleTerminal") : t("savePassword.titleHeadless")}
      >
        {trailingToggle ? (
          <>
            <span className="remote-machine-add-label">
              {label}
              <UntestedTag id="savePasswordRow.1" />
            </span>
            <Toggle
              size="sm"
              checked={checked}
              disabled={disabled || viaTerminal}
              onChange={(e) => onChange(e.target.checked)}
            />
          </>
        ) : (
          <>
            <Toggle
              size="sm"
              checked={checked}
              disabled={disabled || viaTerminal}
              onChange={(e) => onChange(e.target.checked)}
            />
            {label}
            <span className="ssh-optional-hint">{hint}</span>
          </>
        )}
      </label>
      {trailingToggle && <div className="settings-help">{hint}</div>}
      {/* The connect's own report. Never inferred from the request: the box can be
          ticked and the write still refused. */}
      {credential.saveError && (
        <div className="project-dialog-error">
          {t("savePassword.saveFailedLabel")} {credential.saveError}
        </div>
      )}
      <KeyringNotice credential={credential} unlocking={unlocking} onUnlock={() => void doUnlock()} />
    </>
  );
}

/**
 * The locked/absent-store disclosure — the SSH twin of the banner
 * `VpnIndicator` has always shown, and reusing its wording where it fits.
 *
 * Only rendered when the store actually got in the way (`unreadable`), because
 * that is the state the user has no other way of learning about: a locked Secret
 * Service answers every lookup exactly like an empty one, so without this the
 * whole surface silently reports "nothing saved" and offers to save again.
 */
function KeyringNotice({
  credential,
  unlocking,
  onUnlock,
}: {
  credential: SavedCredentialHandle;
  unlocking: boolean;
  onUnlock: () => void;
}) {
  const t = useT();
  if (!credential.unreadable) return null;
  if (credential.keyring === "unavailable") {
    // Nothing to unlock — this machine has no credential store at all, so the
    // honest thing is to say saving isn't available rather than offer a button
    // that can only fail.
    return <div className="ssh-optional-hint">{t("savePassword.unavailableBanner")}</div>;
  }
  return (
    <div className="vpn-indicator-locked" role="status">
      <div>
        {t("vpnIndicator.lockedBannerPre")} <strong>{t("vpnIndicator.lockedBannerStrong")}</strong>
        {t("savePassword.lockedBannerPost")}
      </div>
      <button
        type="button"
        className="vpn-indicator-connect"
        disabled={unlocking}
        title={t("vpnIndicator.unlockTitle")}
        onClick={onUnlock}
      >
        {unlocking ? t("vpnIndicator.unlocking") : t("vpnIndicator.unlockKeyring")}
      </button>
    </div>
  );
}
