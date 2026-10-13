import { useModalFocus } from "../../hooks/useModalFocus";
/**
 * Everything the user ever says about encrypting the local mail store
 * (`docs/mail_encryption_plan.md` Phase 2), in one dialog with three faces.
 *
 * Which face it wears is decided by [`MailEncryptionState`], not by a prop, so
 * the dialog cannot disagree with the backend about what is going on:
 *
 * - **Unlock** — the store is a passphrase store and is currently showing a
 *   memory-only stand-in. The only thing to do is type the passphrase.
 * - **Offer** — encryption is off and the user has never been asked. Two ways
 *   in, and for an install that already holds mail the second one is the honest
 *   recommendation rather than a footnote (see below).
 * - **Status** — it is on; say plainly what that does and does not buy.
 *
 * Rides the canonical dialog chrome (`.modal-backdrop` > `.settings-dialog`,
 * portaled) exactly as `MailAccountDialog` does, so it inherits the one menu
 * scheme rather than inventing a second.
 *
 * # The two things this dialog must not overstate
 *
 * **What encryption buys.** Full-disk encryption already covers the
 * stolen-laptop case for most people. What this adds is *backups, copies, sync
 * folders and multi-user machines*, where FDE is not in play — and it adds
 * nothing at all against a live process or anyone who can run code as you. The
 * copy says so. A security feature that oversells itself is worse than none,
 * because it buys behaviour changes it did not earn.
 *
 * **What the migration does.** Converting an existing store rewrites the
 * database into a fresh file and deletes the old one, which on an SSD or a
 * copy-on-write filesystem **is not erasure**. "Delete and re-sync" never
 * produces a second copy at all, so it is offered *beside* migration rather than
 * buried. The local store is a cache with an authoritative copy on the server —
 * with drafts as the one exception, which is why the warning names them.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import {
  mailEncryptionDecline,
  mailEncryptionEnable,
  mailEncryptionReset,
  mailEncryptionUnlock,
} from "../../lib/mail";
import type { MailEncryptionState } from "../../types/mail";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

export interface MailEncryptionDialogProps {
  state: MailEncryptionState;
  /** Called with the fresh state whenever the backend changed something. */
  onChanged: (next: MailEncryptionState) => void;
  onClose: () => void;
}

type Mode = "keychain" | "passphrase";

export function MailEncryptionDialog({ state, onChanged, onClose }: MailEncryptionDialogProps) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [mode, setMode] = useState<Mode>(
    // A locked or missing credential store cannot hold the key, so defaulting to
    // the silent option would be defaulting to one that fails on click.
    state.keyring === "available" ? "keychain" : "passphrase",
  );
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing typed here outlives the dialog. Cheap, and it means a passphrase is
  // not sitting in a React tree behind whatever the user opens next.
  useEffect(
    () => () => {
      setPassphrase("");
      setConfirm("");
    },
    [],
  );

  const face: "unlock" | "offer" | "status" = state.needs_passphrase
    ? "unlock"
    : state.enabled
      ? "status"
      : "offer";

  const run = async (fn: () => Promise<MailEncryptionState>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      onChanged(next);
      setPassphrase("");
      setConfirm("");
      if (!next.needs_passphrase) onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const passphraseReady =
    mode !== "passphrase" || (passphrase.length > 0 && passphrase === confirm);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog mail-encryption-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-title-row">
          <h2>
            {t("mail.encryption.title")} <UntestedTag id="mail.encryption.title" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-scroll">
          {face === "unlock" && (
            <>
              <p className="mail-note">{t("mail.encryption.unlockIntro")}</p>
              <div className="mail-warning-strip">{t("mail.encryption.unlockDegraded")}</div>
              <label className="mail-field">
                <span className="mail-field-label">{t("mail.encryption.passphrase")}</span>
                <input
                  className="mail-input"
                  type="password"
                  autoFocus
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && passphrase && !busy) {
                      void run(() => mailEncryptionUnlock(passphrase));
                    }
                  }}
                />
              </label>
            </>
          )}

          {face === "offer" && (
            <>
              <p className="mail-note">{t("mail.encryption.offerIntro")}</p>
              <p className="mail-note">{t("mail.encryption.scopeHonest")}</p>

              <div className="mail-field-label">{t("mail.encryption.howToUnlock")}</div>
              <label className="mail-field mail-field-row">
                <input
                  type="radio"
                  checked={mode === "keychain"}
                  disabled={state.keyring !== "available"}
                  onChange={() => setMode("keychain")}
                />
                <span>
                  {t("mail.encryption.modeKeychain")}
                  <small className="mail-note">
                    {state.keyring === "available"
                      ? t("mail.encryption.modeKeychainHint")
                      : t("mail.encryption.modeKeychainLocked")}
                  </small>
                </span>
              </label>
              <label className="mail-field mail-field-row">
                <input
                  type="radio"
                  checked={mode === "passphrase"}
                  onChange={() => setMode("passphrase")}
                />
                <span>
                  {t("mail.encryption.modePassphrase")}
                  <small className="mail-note">{t("mail.encryption.modePassphraseHint")}</small>
                </span>
              </label>

              {mode === "passphrase" && (
                <>
                  <label className="mail-field">
                    <span className="mail-field-label">{t("mail.encryption.passphrase")}</span>
                    <input
                      className="mail-input"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </label>
                  <label className="mail-field">
                    <span className="mail-field-label">
                      {t("mail.encryption.passphraseConfirm")}
                    </span>
                    <input
                      className="mail-input"
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </label>
                  <div className="mail-warning-strip">
                    {t("mail.encryption.passphraseNoRecovery")}
                  </div>
                </>
              )}

              {state.has_existing_mail && (
                <div className="mail-warning-strip">{t("mail.encryption.migrationCaveat")}</div>
              )}
            </>
          )}

          {face === "status" && (
            <>
              <p className="mail-note">
                {state.active
                  ? t("mail.encryption.statusOn")
                  : t("mail.encryption.statusOnButClosed")}
              </p>
              <p className="mail-note">
                {state.mode === "passphrase"
                  ? t("mail.encryption.statusModePassphrase")
                  : state.mode === "device"
                    ? t("mail.encryption.statusModeDevice")
                    : t("mail.encryption.statusModeKeychain")}
              </p>
              {state.ephemeral && (
                <div className="mail-warning-strip">
                  {t("mail.encryption.statusEphemeral")}
                  {state.reason ? ` — ${state.reason}` : ""}
                </div>
              )}
              <p className="mail-note">{t("mail.encryption.scopeHonest")}</p>
              <p className="mail-note">{t("mail.encryption.metadataHonest")}</p>
            </>
          )}

          {error && <ErrorNote className="project-dialog-error" error={error} />}

          <div className="mail-dialog-actions">
            {face === "unlock" && (
              <>
                <button type="button" className="settings-btn" onClick={onClose} disabled={busy}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="settings-btn primary"
                  disabled={busy || !passphrase}
                  onClick={() => void run(() => mailEncryptionUnlock(passphrase))}
                >
                  {t("mail.encryption.unlock")}
                </button>
              </>
            )}

            {face === "offer" && (
              <>
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => {
                    void mailEncryptionDecline().finally(onClose);
                  }}
                >
                  {t("mail.encryption.notNow")}
                </button>
                {state.has_existing_mail && (
                  <button
                    type="button"
                    className="settings-btn danger"
                    disabled={busy || !passphraseReady}
                    title={t("mail.encryption.resetHint")}
                    onClick={() =>
                      void run(() =>
                        mailEncryptionReset(mode, mode === "passphrase" ? passphrase : undefined),
                      )
                    }
                  >
                    {t("mail.encryption.reset")}
                  </button>
                )}
                <button
                  type="button"
                  className="settings-btn primary"
                  disabled={busy || !passphraseReady}
                  onClick={() =>
                    void run(() =>
                      mailEncryptionEnable(mode, mode === "passphrase" ? passphrase : undefined),
                    )
                  }
                >
                  {state.has_existing_mail
                    ? t("mail.encryption.enableAndMigrate")
                    : t("mail.encryption.enable")}
                </button>
              </>
            )}

            {face === "status" && (
              <button type="button" className="settings-btn primary" onClick={onClose}>
                {t("common.close")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
