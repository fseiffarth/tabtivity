import { useModalFocus } from "../../hooks/useModalFocus";
/**
 * The OpenPGP keyring (`docs/mail_encryption_plan.md` §6, phase 4).
 *
 * Rides the canonical dialog chrome, like every other mail dialog. Three things
 * about it are decisions rather than layout:
 *
 * **The fingerprint is the feature.** OpenPGP has no certificate authority —
 * nothing anywhere asserts that a key belongs to a person, so the only thing
 * that can is the user comparing a fingerprint over a channel the attacker does
 * not control. So the fingerprint is shown in full, in groups of four, in a
 * monospace face, next to a checkbox that is the *only* way any message ever
 * earns positive chrome. Forty run-together hex characters do not get compared,
 * they get glanced at.
 *
 * **"Verified" is per key and reversible.** It is a claim the user made, and
 * claims can turn out to be wrong; a one-way promotion would mean a mistaken
 * check could never be taken back.
 *
 * **Export is public-only, and says so.** There is no command in the backend
 * that exports a private key, and that is not an omission — "export my key",
 * typed by somebody who means the public half, is the standard way a private key
 * ends up in an email.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import {
  formatFingerprint,
  mailPgpBind,
  mailPgpDelete,
  mailPgpExport,
  mailPgpGenerate,
  mailPgpImport,
  mailPgpImportPick,
  mailPgpKeys,
  mailPgpSetVerified,
} from "../../lib/mail";
import type { MailAccount, PgpKeyInfo } from "../../types/mail";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

export interface MailKeysDialogProps {
  /** The account new keys are generated for and bound to. */
  account: MailAccount | null;
  onClose: () => void;
}

export function MailKeysDialog({ account, onClose }: MailKeysDialogProps) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [keys, setKeys] = useState<PgpKeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [exported, setExported] = useState<{ fingerprint: string; armored: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setKeys(await mailPgpKeys());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const mine = keys.filter((k) => k.secret);
  const theirs = keys.filter((k) => !k.secret);
  const boundHere = account ? mine.find((k) => k.accounts.includes(account.id)) : undefined;
  // The backend refuses to bind a key whose user ids do not name the account's
  // address; offering the button anyway would only end in that error.
  const namesAccount = (key: PgpKeyInfo) =>
    !!account && key.addresses.includes(account.address.trim().toLowerCase());

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-dialog mail-keys-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-title-row">
          <h2>
            {t("mail.keys.title")} <UntestedTag id="mail.keys.title" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-scroll">
          <p className="mail-note">{t("mail.keys.intro")}</p>

          {/* ── Your own key ─────────────────────────────────────────────── */}
          <div className="mail-field-label">{t("mail.keys.yours")}</div>
          {account && !boundHere && (
            <>
              <p className="mail-note">
                {t("mail.keys.noneYet", { address: account.address })}
              </p>
              <div className="mail-dialog-actions">
                <button
                  type="button"
                  className="settings-btn primary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      mailPgpGenerate(
                        account.id,
                        // The key's UID has to name the *sending* identity —
                        // `label`, the same string the From: header carries —
                        // not the local nickname on the accounts badge: a
                        // correspondent compares the UID against the mail they
                        // received, and a key naming something they never saw
                        // reads as the wrong key.
                        account.label || account.address,
                        account.address,
                      ),
                    )
                  }
                >
                  {t("mail.keys.generate")}
                </button>
              </div>
              <p className="mail-note">{t("mail.keys.generateHint")}</p>
            </>
          )}
          {mine.map((key) => (
            <KeyRow
              key={key.fingerprint}
              info={key}
              boundTo={account && key.accounts.includes(account.id) ? account : null}
              busy={busy}
              onVerify={(verified) =>
                void run(() => mailPgpSetVerified(key.fingerprint, verified))
              }
              onExport={() =>
                void run(async () => {
                  setExported({
                    fingerprint: key.fingerprint,
                    armored: await mailPgpExport(key.fingerprint),
                  });
                })
              }
              onBind={
                account && namesAccount(key)
                  ? () => void run(() => mailPgpBind(key.fingerprint, account.id, true))
                  : undefined
              }
              onDelete={() => void run(() => mailPgpDelete(key.fingerprint))}
            />
          ))}

          {/* ── Correspondents ───────────────────────────────────────────── */}
          <div className="mail-field-label">{t("mail.keys.theirs")}</div>
          {theirs.length === 0 && <p className="mail-note">{t("mail.keys.noneTheirs")}</p>}
          {theirs.map((key) => (
            <KeyRow
              key={key.fingerprint}
              info={key}
              boundTo={null}
              busy={busy}
              onVerify={(verified) =>
                void run(() => mailPgpSetVerified(key.fingerprint, verified))
              }
              onExport={() =>
                void run(async () => {
                  setExported({
                    fingerprint: key.fingerprint,
                    armored: await mailPgpExport(key.fingerprint),
                  });
                })
              }
              onDelete={() => void run(() => mailPgpDelete(key.fingerprint))}
            />
          ))}

          {/* ── Import ───────────────────────────────────────────────────── */}
          <div className="mail-field-label">{t("mail.keys.import")}</div>
          <p className="mail-note">{t("mail.keys.importHint")}</p>
          <textarea
            className="mail-input mail-keys-paste"
            rows={4}
            spellCheck={false}
            placeholder={"-----BEGIN PGP PUBLIC KEY BLOCK-----"}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="mail-dialog-actions">
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              onClick={() => void run(() => mailPgpImportPick())}
            >
              {t("mail.keys.importFile")}
            </button>
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy || !pasted.trim()}
              onClick={() =>
                void run(async () => {
                  await mailPgpImport(pasted);
                  setPasted("");
                })
              }
            >
              {t("mail.keys.importPasted")}
            </button>
          </div>

          {exported && (
            <>
              <div className="mail-field-label">
                {t("mail.keys.exported", { fp: formatFingerprint(exported.fingerprint) })}
              </div>
              {/* Public only — stated, because the whole risk of an export
                  control is somebody copying out the wrong half. */}
              <p className="mail-note">{t("mail.keys.exportedHint")}</p>
              <textarea
                className="mail-input mail-keys-paste"
                rows={6}
                readOnly
                spellCheck={false}
                value={exported.armored}
                onFocus={(e) => e.currentTarget.select()}
              />
            </>
          )}

          {error && <ErrorNote className="project-dialog-error" error={error} />}

          <div className="mail-dialog-actions">
            <button type="button" className="settings-btn primary" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function KeyRow({
  info,
  boundTo,
  busy,
  onVerify,
  onExport,
  onBind,
  onDelete,
}: {
  info: PgpKeyInfo;
  boundTo: MailAccount | null;
  busy: boolean;
  onVerify: (verified: boolean) => void;
  onExport: () => void;
  onBind?: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="mail-key-row">
      <div className="mail-key-identity">
        {info.identities.join(", ") || t("mail.keys.noIdentity")}
        <small className="mail-note">
          {info.algorithm}
          {boundTo ? ` · ${t("mail.keys.boundTo", { label: boundTo.label })}` : ""}
        </small>
      </div>
      {/* Monospace, grouped, and never truncated: this string is the entire
          trust model, and an abbreviated one is worse than none because it looks
          like it was checked. */}
      <code className="mail-key-fingerprint">{formatFingerprint(info.fingerprint)}</code>
      {info.secret && info.verified ? (
        <span className="mail-note">{t("mail.keys.ownKey")}</span>
      ) : (
        <>
          {/* An imported private key is still somebody's claim about its user
              ids: it earns trust by the same fingerprint check as anyone's key,
              or by being bound to an account it names. */}
          {info.secret && (
            <span className="mail-note">
              {t("mail.keys.ownKeyUnverified")} <UntestedTag id="mail.keys.ownKeyUnverified" />
            </span>
          )}
          <label className="mail-key-verified">
            <input
              type="checkbox"
              checked={info.verified}
              disabled={busy}
              onChange={(e) => onVerify(e.target.checked)}
            />
            <span>{t("mail.keys.verifiedCheckbox")}</span>
          </label>
        </>
      )}
      <div className="mail-key-actions">
        {onBind && (
          <button type="button" className="settings-btn" disabled={busy} onClick={onBind}>
            {t("mail.keys.useForAccount")}
          </button>
        )}
        <button type="button" className="settings-btn" disabled={busy} onClick={onExport}>
          {t("mail.keys.export")}
        </button>
        <button
          type="button"
          className="settings-btn danger"
          disabled={busy}
          onClick={onDelete}
        >
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}
