import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { SavePasswordRow } from "../projects/SavePasswordRow";
import {
  rememberArg,
  useSavedCredentialSource,
  type SavedPasswordState,
} from "../projects/useSavedCredential";
import { mailAccountTest, mailAccountUpsert, mailForgetPassword, mailPasswordState } from "../../lib/mail";
import type { KeyringState } from "../../lib/keyring";
import { useT } from "../../lib/i18n";
import type { MailAccount, MailAgentScope, MailKeyringState, MailSecurity } from "../../types/mail";
import { ErrorNote } from "../common/ErrorNote";

/** The account dialog's agent-access states, in the order they are shown. */
const AGENT_SCOPES = ["off", "marked", "all"] as const;
type AgentScopeChoice = (typeof AGENT_SCOPES)[number];
const AGENT_SCOPE_LABEL = {
  off: "mail.agentScopeOff",
  marked: "mail.agentScopeMarked",
  all: "mail.agentScopeAll",
} as const;

/**
 * The account editor.
 *
 * Rides the canonical dialog chrome (`.modal-backdrop` > `.settings-dialog`, an
 * accent `.settings-title-row` + divider) and, being portaled, sets its text
 * color explicitly — `body` carries none, so an inherited color renders black.
 *
 * Three rules it exists to honour:
 *
 *  1. **Save password is opt-in and defaults OFF.** Unsaved means the password
 *     lives in the backend's in-memory map for the session; a blank field means
 *     "use the saved one", not "authenticate with nothing". The checkbox is
 *     pre-ticked only when the target *already* has a saved secret, so an untick
 *     is an explicit delete — and the save itself sends `true | null`, never
 *     `false`, because `false` means *clear the credential* and would destroy the
 *     password it just authenticated with (`rememberArg`).
 *  2. **What the keychain actually did** is what the row reports —
 *     `MailAccountSaved.save_error` verbatim, never an assumption from the
 *     request. A ticked box over an empty keychain is the state that resurfaces
 *     at the next launch as an unexplained prompt.
 *  3. **Presets name public providers only** (the repo is public). A provider
 *     that requires OAuth is offered *disabled*, with the reason — an honest dead
 *     end beats a password field that can only fail with an opaque
 *     `AUTHENTICATIONFAILED`.
 */

interface ProviderPreset {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  security: MailSecurity;
  /** True → the account cannot be created here yet; say so instead of failing. */
  oauthRequired?: boolean;
}

/** Generic, public consumer providers only. No institution or lab hostnames may
 *  ever appear here — this file ships in a public repository. */
const PRESETS: ProviderPreset[] = [
  {
    id: "gmail.com",
    label: "gmail.com",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    security: "tls",
  },
  {
    id: "outlook.com",
    label: "outlook.com",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    security: "starttls",
    // Basic auth for IMAP/SMTP is being retired here; treat it as OAuth-only.
    oauthRequired: true,
  },
];

const SECURITIES: MailSecurity[] = ["tls", "starttls", "none"];

/** A blank account, so the dialog never has to reason about `undefined` fields. */
function emptyAccount(): MailAccount {
  return {
    id: "",
    label: "",
    address: "",
    imap: { host: "", port: 993, user: "", security: "tls" },
    smtp: { host: "", port: 465, user: "", security: "tls" },
    auth: "password",
    save_password: false,
  };
}

/** `MailKeyringState` → the `KeyringState` the shared row speaks. `unknown` maps
 *  to `locked` deliberately: that is the state with an unlock button behind it,
 *  and treating "we could not tell" as "unlocked" is what sends a user back into
 *  the silent path that is already failing. */
function toKeyringState(state: MailKeyringState): KeyringState {
  if (state === "available") return "unlocked";
  if (state === "unavailable") return "unavailable";
  return "locked";
}

export function MailAccountDialog({
  account,
  onClose,
  onSaved,
  onDelete,
}: {
  /** The account being edited, or `null` to create one. */
  account: MailAccount | null;
  onClose: () => void;
  onSaved: (accountId: string) => void;
  onDelete: (accountId: string) => void;
}) {
  const t = useT();
  const [form, setForm] = useState<MailAccount>(() => account ?? emptyAccount());
  const [presetId, setPresetId] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const accountId = account?.id ?? "";

  const read = useCallback(async (): Promise<SavedPasswordState> => {
    const state = await mailPasswordState(accountId);
    return { saved: state.has_saved, keyring: toKeyringState(state.keyring) };
  }, [accountId]);
  const forget = useCallback(() => mailForgetPassword(accountId), [accountId]);
  // The shared machinery, not a second copy of it: the tri-state, the 4 s bound
  // and the "unknown is not absence" rule are the same ones the SSH dialogs use.
  const credential = useSavedCredentialSource(
    accountId ? `mail:${accountId}` : "",
    read,
    forget,
  );

  // Pre-tick ONLY from a resolved "saved" — a `checking`/`unreadable` store must
  // never produce a ticked box, because a tick the user did not make is how a
  // credential gets deleted by a later untick nobody meant.
  const rememberChecked = remember || credential.saved;

  const preset = useMemo(() => PRESETS.find((p) => p.id === presetId), [presetId]);

  const patch = (p: Partial<MailAccount>) => setForm((f) => ({ ...f, ...p }));

  // Off / marked / all, from the two prefs fields. `agent_access` on with no
  // scope is "marked": the two-state build wrote no scope, and narrowing is
  // the safe reading.
  const agentScope: AgentScopeChoice =
    form.ai?.agent_access === true ? (form.ai?.agent_scope ?? "marked") : "off";
  const setAgentScope = (value: AgentScopeChoice) => {
    const { agent_access: _access, agent_scope: _scope, ...rest } = form.ai ?? {};
    patch({
      ai:
        value === "off"
          ? rest
          : { ...rest, agent_access: true, agent_scope: value satisfies MailAgentScope },
    });
  };

  function applyPreset(id: string) {
    setPresetId(id);
    const found = PRESETS.find((p) => p.id === id);
    if (!found) return;
    setForm((f) => ({
      ...f,
      imap: { ...f.imap, host: found.imapHost, port: found.imapPort, security: found.security },
      smtp: { ...f.smtp, host: found.smtpHost, port: found.smtpPort, security: found.security },
    }));
  }

  const incomplete = !form.address.trim() || !form.imap.host.trim();
  const blocked = !!preset?.oauthRequired;

  async function doTest() {
    setBusy("test");
    setError("");
    setStatus("");
    const probe = await mailAccountTest(form, password || null).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    if (!probe) return;
    setStatus(
      probe.imap_ok && probe.smtp_ok
        ? t("mail.testOk")
        : probe.imap_ok
          ? t("mail.testImapOnly")
          : probe.smtp_ok
            ? t("mail.testSmtpOnly")
            : t("mail.testFailed"),
    );
    if (probe.error) setError(probe.error);
  }

  async function doSave() {
    if (incomplete || blocked) {
      setError(t("mail.accountIncomplete"));
      return;
    }
    setBusy("save");
    setError("");
    const result = await mailAccountUpsert(
      { ...form, save_password: rememberChecked },
      password || null,
      // NEVER `false`. Clearing is only ever the explicit forget below.
      rememberArg(rememberChecked),
    ).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    if (!result) return;
    // Adopt what the keychain DID, not what was asked for.
    credential.applyOutcome({ saved: result.saved, save_error: result.save_error ?? null });
    if (result.save_error) {
      setError(result.save_error);
      return;
    }
    onSaved(result.account.id);
  }

  /** Unticking is the ONLY delete path, and it is explicit. */
  function onRememberChange(on: boolean) {
    setRemember(on);
    if (!on && credential.saved) void credential.forget();
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog mail-account-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {account ? t("mail.accountDialogEdit") : t("mail.accountDialogNew")} <UntestedTag id="mail.accountDialogNew" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.provider")}</span>
            <select
              className="mail-input"
              value={presetId}
              onChange={(e) => applyPreset(e.target.value)}
            >
              <option value="">{t("mail.providerCustom")}</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {blocked && <div className="mail-warning-strip">{t("mail.providerOauthOnly")}</div>}

          <label className="mail-field">
            <span className="mail-field-label">{t("mail.accountName")}</span>
            <input
              className="mail-input"
              type="text"
              value={form.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
            {/* The two name fields are one field apart and go to opposite
                places — one leaves the machine on every message, the other
                never does — so each says which it is rather than leaving the
                user to find out from a sent mail. */}
            <span className="mail-field-hint">{t("mail.accountNameHint")}</span>
          </label>
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.accountAddress")}</span>
            <input
              className="mail-input"
              type="text"
              autoFocus
              spellCheck={false}
              value={form.address}
              onChange={(e) => {
                const address = e.target.value;
                // A username is almost always the address; keep them in step until
                // the user edits one, rather than making them type it three times.
                patch({
                  address,
                  imap: { ...form.imap, user: form.imap.user || address },
                  smtp: { ...form.smtp, user: form.smtp.user || address },
                });
              }}
            />
          </label>
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.accountDisplayName")}</span>
            <input
              className="mail-input"
              type="text"
              value={form.display_name ?? ""}
              onChange={(e) => patch({ display_name: e.target.value })}
            />
            <span className="mail-field-hint">{t("mail.accountDisplayNameHint")}</span>
          </label>

          <ServerFields
            title={t("mail.incoming")}
            host={form.imap.host}
            port={form.imap.port}
            user={form.imap.user}
            security={form.imap.security}
            onChange={(next) => patch({ imap: { ...form.imap, ...next } })}
          />
          <ServerFields
            title={t("mail.outgoing")}
            host={form.smtp.host}
            port={form.smtp.port}
            user={form.smtp.user}
            security={form.smtp.security}
            onChange={(next) => patch({ smtp: { ...form.smtp, ...next } })}
          />

          <label className="mail-field">
            <span className="mail-field-label">{t("mail.password")}</span>
            <PasswordInput
              className="mail-input"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="settings-help">{t("mail.passwordHint")}</div>
          <SavePasswordRow
            credential={credential}
            checked={rememberChecked}
            onChange={onRememberChange}
            labelText={t("mail.savePassword")}
          />
          {credential.saved && (
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                setRemember(false);
                void credential.forget();
              }}
            >
              {t("mail.forgetPassword")}
            </button>
          )}

          <label className="mail-field">
            <span className="mail-field-label">{t("mail.signature")}</span>
            <textarea
              className="mail-input mail-textarea"
              rows={3}
              value={form.signature ?? ""}
              onChange={(e) => patch({ signature: e.target.value })}
            />
          </label>
          <label className="mail-field">
            <span className="mail-field-label">{t("mail.checkInterval")}</span>
            <input
              className="mail-input"
              type="number"
              min={0}
              value={form.check_interval_min ?? 5}
              onChange={(e) => patch({ check_interval_min: Number(e.target.value) || 0 })}
            />
          </label>
          {/* The VPN gate (`lib/remote/vpn/vpnGate.ts`). Its hint names the limit — only a
              tunnel Tabtivity started counts — because the failure mode of the
              switch is silent: an account gated on a VPN Tabtivity cannot see
              simply never syncs, and nothing else would say why. */}
          <label className="mail-field mail-field-check">
            <span className="mail-check-row">
              <input
                type="checkbox"
                checked={form.require_vpn ?? false}
                onChange={(e) => patch({ require_vpn: e.target.checked })}
              />
              <span>{t("mail.requireVpn")}</span>
            </span>
            <span className="settings-help">{t("mail.requireVpnHint")}</span>
          </label>

          {/* Agent access (root MCP, `docs/mail_mcp_plan.md` §1). Here and not
              in the Mail AI (local) section on purpose: that section promises
              nothing leaves the machine, and this switch consents to the
              opposite. Off by default; it governs READING only — a root tab's
              draft-only access needs no consent. */}
          {/* Three states, not a checkbox: Off, the messages the user marked,
              the whole account. Turning it on lands on "marked" — the narrower
              consent — and "all" is one deliberate step further. Two prefs
              fields: `agent_access` stays the gate, `agent_scope` the width. */}
          <fieldset className="mail-field mail-field-check mail-radio-group">
            <legend className="mail-field-label">
              {t("mail.agentAccess")} <UntestedTag id="mail.agentScope" />
            </legend>
            {AGENT_SCOPES.map((value) => (
              <label key={value} className="mail-check-row">
                <input
                  type="radio"
                  name="mail-agent-scope"
                  value={value}
                  checked={agentScope === value}
                  onChange={() => setAgentScope(value)}
                />
                <span>{t(AGENT_SCOPE_LABEL[value])}</span>
              </label>
            ))}
            <span className="settings-help">{t("mail.agentAccessHint")}</span>
            <span className="settings-help">{t("mail.agentScopeHint")}</span>
          </fieldset>

          {/* The trusted `authserv-id`. Optional, and while it is empty **no**
              SPF/DKIM/DMARC verdict is shown anywhere — the hint says so rather
              than leaving the field looking like a cosmetic preference, because
              the alternative to setting it is not "less detail", it is showing
              the sender's own claims as if a server had checked them. */}
          <label className="mail-field">
            {/* No UntestedTag here: the dialog title already carries one, and
                two pills in one dialog reads as two separate warnings. */}
            <span className="mail-field-label">{t("mail.authservIdLabel")}</span>
            <input
              className="mail-input"
              type="text"
              spellCheck={false}
              autoCapitalize="none"
              placeholder={t("mail.authservIdPlaceholder")}
              value={form.authserv_id ?? ""}
              // Trimmed, and an empty field clears the setting rather than
              // storing "" — which `apply_trust` would otherwise have to treat
              // as configured-but-unmatched, i.e. warn about every message.
              onChange={(e) =>
                patch({ authserv_id: e.target.value.trim() ? e.target.value : undefined })
              }
            />
            <span className="mail-field-hint">{t("mail.authservIdHint")}</span>
          </label>

          {status && <div className="mail-note">{status}</div>}
          {error && <ErrorNote className="project-dialog-error" error={error} />}

          <div className="mail-dialog-actions">
            <button type="button" className="settings-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="settings-btn"
              disabled={busy !== "" || incomplete || blocked}
              onClick={() => void doTest()}
            >
              {busy === "test" ? t("mail.testing") : t("mail.testConnection")}
            </button>
            {account && (
              <button
                type="button"
                className="settings-btn danger"
                onClick={() => setConfirmDelete(true)}
              >
                {t("mail.removeAccount")}
              </button>
            )}
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy !== "" || incomplete || blocked}
              onClick={() => void doSave()}
            >
              {t("mail.saveAccount")}
            </button>
          </div>

          {confirmDelete && account && (
            <div className="mail-confirm-strip">
              <span>{t("mail.removeAccountConfirm")}</span>
              <button type="button" className="settings-btn" onClick={() => setConfirmDelete(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="settings-btn danger"
                onClick={() => onDelete(account.id)}
              >
                {t("common.delete")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One server block (IMAP or SMTP). Identical shape both times, so it is one
 *  component rather than two copies that drift on the security dropdown. */
function ServerFields({
  title,
  host,
  port,
  user,
  security,
  onChange,
}: {
  title: string;
  host: string;
  port: number;
  user: string;
  security: MailSecurity;
  onChange: (next: Partial<{ host: string; port: number; user: string; security: MailSecurity }>) => void;
}) {
  const t = useT();
  const securityLabel = (s: MailSecurity) =>
    s === "tls" ? t("mail.securityTls") : s === "starttls" ? t("mail.securityStarttls") : t("mail.securityNone");

  return (
    <div className="mail-server-block">
      <div className="settings-section-title">{title}</div>
      <label className="mail-field">
        <span className="mail-field-label">{t("mail.server")}</span>
        <input
          className="mail-input"
          type="text"
          spellCheck={false}
          value={host}
          onChange={(e) => onChange({ host: e.target.value })}
        />
      </label>
      <div className="mail-field-row">
        <label className="mail-field">
          <span className="mail-field-label">{t("mail.port")}</span>
          <input
            className="mail-input"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => onChange({ port: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="mail-field">
          <span className="mail-field-label">{t("mail.security")}</span>
          <select
            className="mail-input"
            value={security}
            onChange={(e) => onChange({ security: e.target.value as MailSecurity })}
          >
            {SECURITIES.map((s) => (
              <option key={s} value={s}>
                {securityLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mail-field">
        <span className="mail-field-label">{t("mail.username")}</span>
        <input
          className="mail-input"
          type="text"
          spellCheck={false}
          value={user}
          onChange={(e) => onChange({ user: e.target.value })}
        />
      </label>
    </div>
  );
}
