import { useModalFocus } from "../../hooks/useModalFocus";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { SavePasswordRow } from "../projects/SavePasswordRow";
import {
  rememberArg,
  useSavedCredentialSource,
  type SavedPasswordState,
} from "../projects/useSavedCredential";
import {
  DEFAULT_CALDAV_SYNC_MIN,
  caldavDiscover,
  caldavForgetPassword,
  caldavPasswordState,
  isHttpBaseUrl,
} from "../../lib/calendar/caldav";
import { useCalDavStore } from "../../stores/calendar/caldav";
import { useT } from "../../lib/i18n";
import type { CalDavAccount, CalDavCollection } from "../../types/caldav";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The CalDAV account editor — `MailAccountDialog`'s structural twin, and
 * deliberately so: it is the same three-part problem (a user-typed server, a
 * password that is opt-in to persist, a background interval), so it is the same
 * three-part answer rather than a second hand-rolled one.
 *
 * What it adds over the mail dialog is the middle step CalDAV needs and IMAP
 * does not: **discovery**. A server does not have "the calendar" the way it has
 * "the inbox" — it has a home set with N collections, some of them shared with
 * you by someone else — so the flow is find-then-pick, and each tick becomes a
 * calendar in the sidebar.
 *
 * Three rules it exists to honour:
 *
 *  1. **Save password is opt-in and defaults OFF.** Unsaved means the password
 *     lives in the backend's in-memory map for the session; a blank field means
 *     "use the saved one", not "authenticate with nothing". The save sends
 *     `true | null`, never `false` — `false` *clears* the credential.
 *  2. **No server is guessed at.** There are no presets here and there never
 *     will be: a base URL is a login on someone's infrastructure, and the one
 *     thing worse than making the user find it is defaulting it from their
 *     email address and syncing the wrong account. (This repo is public, so a
 *     preset list could only ever name institutions anyway.)
 *  3. **App-specific passwords are mentioned, not assumed.** Several providers
 *     mint a separate DAV password in their own settings; the hint says so
 *     without building a UI that only has a field for a primary password and
 *     then fails opaquely.
 */
export function CalDavAccountDialog({
  account,
  onClose,
  onSaved,
}: {
  /** The account being edited, or `null` to create one. */
  account: CalDavAccount | null;
  onClose: () => void;
  onSaved: (accountId: string) => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const upsert = useCalDavStore((s) => s.upsert);
  const subscribe = useCalDavStore((s) => s.subscribe);
  const unsubscribe = useCalDavStore((s) => s.unsubscribe);
  const removeAccount = useCalDavStore((s) => s.remove);

  const [form, setForm] = useState<CalDavAccount>(
    () =>
      account ?? {
        id: "",
        label: "",
        base_url: "",
        user: "",
        save_password: false,
        sync_interval_min: DEFAULT_CALDAV_SYNC_MIN,
        calendars: [],
      },
  );
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<"" | "discover" | "save">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [collections, setCollections] = useState<CalDavCollection[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((account?.calendars ?? []).map((c) => c.href)),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const accountId = account?.id ?? "";

  const read = useCallback(async (): Promise<SavedPasswordState> => {
    const state = await caldavPasswordState(accountId);
    return { saved: state.has_saved, keyring: state.keyring };
  }, [accountId]);
  const forget = useCallback(() => caldavForgetPassword(accountId), [accountId]);
  // The shared machinery, not a second copy of it: the tri-state, the 4 s bound
  // and the "unreadable is not absence" rule are the SSH dialogs'.
  const credential = useSavedCredentialSource(
    accountId ? `caldav:${accountId}` : "",
    read,
    forget,
  );

  // Pre-tick ONLY from a resolved "saved" — a tick the user did not make is how
  // a credential gets deleted by a later untick nobody meant.
  const rememberChecked = remember || credential.saved;

  // An already-configured account opens with its subscriptions listed, so the
  // dialog can be used to unsubscribe without a network round trip first.
  useEffect(() => {
    if (!account || collections !== null) return;
    if (account.calendars.length === 0) return;
    setCollections(
      account.calendars.map((c) => ({
        href: c.href,
        display_name: c.display_name,
        color: "",
        ctag: c.ctag,
        sync_token: c.sync_token ?? null,
        components: c.components ?? [],
        read_only: c.read_only,
      })),
    );
  }, [account, collections]);

  const patch = (p: Partial<CalDavAccount>) => setForm((f) => ({ ...f, ...p }));

  const incomplete = !form.base_url.trim() || !form.user.trim();
  // Plain `http://` is refused outright (decision E2b): the password and the
  // calendar would cross the network in the clear. Find and Save stay off,
  // and an existing http account opened here says why it stopped syncing.
  const insecure = isHttpBaseUrl(form.base_url);

  async function doDiscover() {
    setBusy("discover");
    setError("");
    setStatus("");
    const found = await caldavDiscover(
      form.base_url,
      form.user,
      password || null,
      accountId || null,
    ).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    if (!found) return;
    // Keep whatever is already subscribed listed even if this run did not find
    // it — an unsubscribe must not require the server to be reachable.
    const extra = (account?.calendars ?? [])
      .filter((c) => !found.some((f) => f.href === c.href))
      .map((c) => ({
        href: c.href,
        display_name: c.display_name,
        color: "",
        ctag: c.ctag,
        sync_token: c.sync_token ?? null,
        components: c.components ?? [],
        read_only: c.read_only,
      }));
    setCollections([...found, ...extra]);
    setStatus(t("caldav.foundCalendars", { count: found.length }));
  }

  async function doSave() {
    if (incomplete) {
      setError(t("caldav.incomplete"));
      return;
    }
    if (insecure) {
      setError(t("caldav.httpRefused"));
      return;
    }
    setBusy("save");
    setError("");

    const result = await upsert(
      { ...form, save_password: rememberChecked },
      password || null,
      // NEVER `false`. Clearing is only ever the explicit forget below.
      rememberArg(rememberChecked),
    ).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    if (!result) {
      setBusy("");
      return;
    }
    const saved = result.account;

    // Apply the ticks: subscribe what is new, unsubscribe what was unticked.
    const already = new Set((saved.calendars ?? []).map((c) => c.href));
    const toAdd = (collections ?? []).filter((c) => picked.has(c.href) && !already.has(c.href));
    const toDrop = (saved.calendars ?? []).filter((c) => !picked.has(c.href));
    try {
      if (toAdd.length) await subscribe(saved.id, toAdd);
      for (const ref of toDrop) await unsubscribe(saved.id, ref.href);
    } catch (err) {
      setBusy("");
      setError(typeof err === "string" ? err : String(err));
      return;
    }

    setBusy("");
    // Adopt what the keychain DID, not what was asked for: a ticked box over an
    // empty keychain is exactly the state that resurfaces at the next launch as
    // an unexplained failure to sync.
    credential.applyOutcome({ saved: result.saved, save_error: result.save_error ?? null });
    if (result.save_error) {
      setError(result.save_error);
      return;
    }
    onSaved(saved.id);
  }

  /** Unticking is the ONLY delete path, and it is explicit. */
  function onRememberChange(on: boolean) {
    setRemember(on);
    if (!on && credential.saved) void credential.forget();
  }

  function togglePick(href: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="settings-dialog caldav-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {account ? t("caldav.dialogEdit") : t("caldav.dialogNew")} <UntestedTag id="caldav.dialogNew" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <div className="settings-help">{t("caldav.intro")}</div>

          <label className="caldav-field">
            <span className="caldav-field-label">{t("caldav.accountName")}</span>
            <input
              className="cal-input"
              type="text"
              value={form.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
          </label>

          <label className="caldav-field">
            <span className="caldav-field-label">{t("caldav.serverUrl")}</span>
            <input
              className="cal-input"
              type="text"
              autoFocus
              spellCheck={false}
              autoCapitalize="none"
              placeholder="https://…"
              value={form.base_url}
              onChange={(e) => patch({ base_url: e.target.value })}
            />
            <span className="caldav-field-hint">{t("caldav.serverUrlHint")}</span>
          </label>
          {insecure && (
            <div className="caldav-warning-strip" role="alert">
              {t("caldav.httpRefused")} <UntestedTag id="caldav.httpRefused" />
            </div>
          )}

          <label className="caldav-field">
            <span className="caldav-field-label">{t("caldav.user")}</span>
            <input
              className="cal-input"
              type="text"
              spellCheck={false}
              autoCapitalize="none"
              value={form.user}
              onChange={(e) => patch({ user: e.target.value })}
            />
          </label>

          <label className="caldav-field">
            <span className="caldav-field-label">{t("caldav.password")}</span>
            <PasswordInput
              className="cal-input"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="caldav-field-hint">{t("caldav.passwordHint")}</span>
          </label>
          <SavePasswordRow
            credential={credential}
            checked={rememberChecked}
            onChange={onRememberChange}
            labelText={t("caldav.savePassword")}
          />

          <label className="caldav-field">
            <span className="caldav-field-label">{t("caldav.syncInterval")}</span>
            <input
              className="cal-input cal-input-num"
              type="number"
              min={0}
              value={form.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN}
              onChange={(e) => patch({ sync_interval_min: Number(e.target.value) || 0 })}
            />
            <span className="caldav-field-hint">{t("caldav.syncIntervalHint")}</span>
          </label>

          {/* The VPN gate (`lib/remote/vpn/vpnGate.ts`), the mail dialog's row. */}
          <label className="caldav-field caldav-field-check">
            <span className="caldav-check-row">
              <input
                type="checkbox"
                checked={form.require_vpn ?? false}
                onChange={(e) => patch({ require_vpn: e.target.checked })}
              />
              <span>{t("caldav.requireVpn")}</span>
            </span>
            <span className="caldav-field-hint">{t("caldav.requireVpnHint")}</span>
          </label>

          {/* Two-way sync, opt-in and default off (`docs/caldav_plan.md` Phase
              3). The plan's own open question — "is write access even wanted
              against an institutional calendar?" — is answered by asking, here,
              because nobody but the account's owner knows whether the thing on
              the other end is a shared work calendar or their own server.

              The hint says what the switch actually does in BOTH positions, and
              the "off" half is the load-bearing one: with push off, a
              CalDAV-backed calendar stays read-only in the grid. That is not a
              missing feature, it is the alternative to a calendar that accepts
              edits and silently keeps them to itself. */}
          <label className="caldav-field caldav-field-check">
            <span className="caldav-check-row">
              <input
                type="checkbox"
                checked={form.allow_write ?? false}
                onChange={(e) => patch({ allow_write: e.target.checked })}
              />
              <span>{t("caldav.allowWrite")}</span>
              <UntestedTag id="calDavAccountDialog.1" />
            </span>
            <span className="caldav-field-hint">{t("caldav.allowWriteHint")}</span>
          </label>

          <div className="caldav-discover-row">
            <button
              type="button"
              className="cal-btn"
              disabled={busy !== "" || incomplete || insecure}
              onClick={() => void doDiscover()}
            >
              {busy === "discover" ? t("caldav.discovering") : t("caldav.discover")}
            </button>
          </div>

          {collections && (
            <div className="caldav-collections">
              {collections.length === 0 ? (
                <div className="caldav-field-hint">{t("caldav.noCalendars")}</div>
              ) : (
                collections.map((c) => (
                  <label key={c.href} className="caldav-collection-row">
                    <input
                      type="checkbox"
                      checked={picked.has(c.href)}
                      onChange={() => togglePick(c.href)}
                    />
                    <span className="caldav-collection-name">
                      {c.display_name || c.href}
                      {c.read_only ? ` ${t("caldav.readOnlyMark")}` : ""}
                    </span>
                    <span className="caldav-collection-href" title={c.href}>
                      {c.href}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}

          {status && <div className="caldav-note">{status}</div>}
          {error && <ErrorNote className="project-dialog-error" error={error} />}

          <div className="caldav-dialog-actions">
            <button type="button" className="cal-btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            {account && (
              <button
                type="button"
                className="cal-btn cal-btn-danger"
                onClick={() => setConfirmDelete(true)}
              >
                {t("caldav.removeAccount")}
              </button>
            )}
            <button
              type="button"
              className="cal-btn cal-btn-primary"
              disabled={busy !== "" || incomplete || insecure}
              onClick={() => void doSave()}
            >
              {busy === "save" ? t("caldav.saving") : t("common.save")}
            </button>
          </div>

          {confirmDelete && account && (
            <div className="caldav-confirm-strip">
              <span>{t("caldav.removeAccountConfirm")}</span>
              <button type="button" className="cal-btn" onClick={() => setConfirmDelete(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="cal-btn cal-btn-danger"
                onClick={() => {
                  void removeAccount(account.id).then(onClose);
                }}
              >
                {t("caldav.removeAccount")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
