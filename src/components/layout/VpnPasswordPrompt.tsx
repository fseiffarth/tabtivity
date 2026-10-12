import { useModalFocus } from "../../hooks/useModalFocus";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { UntestedTag } from "../common/UntestedTag";
import { SavePasswordRow } from "../projects/SavePasswordRow";
import {
  useSavedCredentialSource,
  type SavedPasswordState,
} from "../projects/useSavedCredential";
import { useVpnPromptStore } from "../../stores/remote/vpn/vpnPrompt";
import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { ConnectionLog, type LogLine } from "../common/ConnectionLog";
import { PasswordInput } from "../common/PasswordInput";
import { needsSeparateKeyPassphrase, type VpnAuthNeeds } from "../../types";
import { useT } from "../../lib/i18n";

/**
 * Activation-time OpenVPN password prompt. Rendered once at the app root; shows
 * a modal whenever a VPN-gated project is being activated and needs its (never
 * persisted) password. The store owns the connect, so this modal stays open
 * while the tunnel comes up and surfaces any failure inline (with a retry)
 * rather than letting it fail silently in the background.
 */
export function VpnPasswordPrompt() {
  const t = useT();
  const pending = useVpnPromptStore((s) => s.pending);
  const status = useVpnPromptStore((s) => s.status);
  const error = useVpnPromptStore((s) => s.error);
  const submit = useVpnPromptStore((s) => s.submit);
  const cancel = useVpnPromptStore((s) => s.cancel);
  const handoffToTerminal = useVpnPromptStore((s) => s.handoffToTerminal);
  const close = useVpnPromptStore((s) => s.close);
  const markConnected = useVpnPromptStore((s) => s.markConnected);
  // The machine-level lamp for *this* config. It is reconciled every 10 s by
  // `VpnIndicator` against the backend's real tunnel set, which makes it the one
  // observer that can notice a tunnel coming up when our own connect call doesn't.
  const machineState = useVpnStatusStore((s) => (pending ? s.byConfig[pending.config] : undefined));
  const [password, setPassword] = useState("");
  // Auth username for `auth-user-pass` configs. `needs` (queried per prompt)
  // decides which fields are shown; the username is seeded from the pending
  // prompt's stored spec.
  const [username, setUsername] = useState("");
  const [needs, setNeeds] = useState<VpnAuthNeeds>({ username: false, keyPassphrase: false });
  // A config with an encrypted key *and* an account has two secrets — OpenVPN
  // prompts for them separately. Without an account, `password` already is the
  // key passphrase, so this field stays hidden rather than asking twice.
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const needsKeyPassphrase = needsSeparateKeyPassphrase(needs);
  // Opt-in "Save passphrase" (default off). Pre-checked when a credential is
  // already saved for this config, so the box mirrors the true keychain state.
  const [remember, setRemember] = useState(false);
  // **The tri-state behind that box** (G.24). This read used to be a bare
  // `vpn_has_saved_password` boolean, and against a *locked* Secret Service a
  // boolean cannot be right: a locked collection answers every lookup exactly
  // like an empty one, so the row reported "(not stored)" over a config whose
  // password is sitting on the ring — and offered to save it again. The SSH side
  // grew `remote_saved_password_state` for this; `vpn_saved_password_state` is
  // its twin, and reusing `useSavedCredentialSource`/`SavePasswordRow` means the
  // 4 s bound, the "unknown is not absence" rule and the Unlock-keyring banner
  // are the SSH implementation rather than a fourth copy of it.
  const vpnConfig = pending?.config ?? "";
  const readVpnCredential = useCallback(
    () => invoke<SavedPasswordState>("vpn_saved_password_state", { config: vpnConfig }),
    [vpnConfig],
  );
  const forgetVpnCredential = useCallback(
    () => invoke<void>("vpn_forget_password", { config: vpnConfig }).then(() => undefined),
    [vpnConfig],
  );
  const credential = useSavedCredentialSource(vpnConfig, readVpnCredential, forgetVpnCredential);
  // Live OpenVPN handshake output streamed from the backend, shown read-only so
  // the connect isn't an opaque spinner. Reset per prompt and per attempt.
  const [log, setLog] = useState<LogLine[]>([]);
  // Monotonic id source for `log` lines: a dedicated counter (never reset on
  // slice) gives each line a stable React key so the `.slice(-500)` cap trims
  // only the head without re-creating the surviving line nodes.
  const logSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus whenever a new prompt opens (keyed on config so a superseding
  // prompt re-focuses, but a connect attempt on the same prompt doesn't wipe the
  // typed passphrase).
  useEffect(() => {
    if (pending) {
      setPassword("");
      setKeyPassphrase("");
      setUsername(pending.username ?? "");
      setLog([]);
      inputRef.current?.focus();
      const config = pending.config;
      let cancelled = false;
      // The caller's seed wins where it has one: a prompt opened *as* the save action
      // ("Save login credentials" in the VPN menu) has nothing saved yet, so asking
      // the keychain would tick the box off and quietly not save what was asked for.
      // With no seed the box follows the hook's resolved state (below) — and only a
      // *confident* `saved`, never a `false` from a store we could not read.
      const seeded = pending.remember;
      if (seeded !== undefined) setRemember(seeded);
      void invoke<VpnAuthNeeds>("openvpn_auth_needs", { config })
        .then((v) => !cancelled && setNeeds(v))
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
  }, [pending?.config]);

  // Seed the box from the *resolved* credential, once per prompt. Gated on a ref
  // rather than run on every state change so a later `applyOutcome`/`refresh`
  // cannot silently retick a box the user has just unticked. `checking` seeds
  // nothing — and neither does `unreadable`, since `credential.saved` is false
  // there and an unticked box must not be an assertion that nothing is stored.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!pending) {
      seededFor.current = null;
      return;
    }
    if (pending.remember !== undefined) {
      seededFor.current = pending.config;
      return;
    }
    if (credential.checking || seededFor.current === pending.config) return;
    seededFor.current = pending.config;
    setRemember(credential.saved);
  }, [pending, credential.checking, credential.saved]);

  // Stream the live handshake for this prompt's config into the log.
  useEffect(() => {
    const config = pending?.config;
    if (!config) return;
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen<{ config: string; line: string }>("openvpn-progress", (ev) => {
      if (ev.payload.config !== config) return;
      setLog((prev) => [...prev, { id: logSeq.current++, text: ev.payload.line }].slice(-500));
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [pending?.config]);

  // Watchdog for the "it connected but the modal didn't notice" case that `submit`'s
  // own `openvpn_status` re-check cannot cover: that one only runs when the connect
  // *rejects*. A connect that neither resolves nor rejects — the handshake completed
  // but the marker line never arrived — left `status` pinned at "connecting" forever,
  // so the button read "Connecting…" over a live tunnel. The header's reconcile does
  // see it, so adopt its verdict here.
  useEffect(() => {
    if (status === "connecting" && machineState === "connected") markConnected();
  }, [status, machineState, markConnected]);

  const modalRef = useModalFocus(() => (status === "connected" ? close() : cancel()), !!pending);
  if (!pending) return null;

  const connecting = status === "connecting";
  const connected = status === "connected";
  const onSubmit = () => {
    if (!connecting && !connected) {
      setLog([]);
      void submit(password, remember, username, keyPassphrase);
    }
  };
  // Enter submits from any field (once connected it closes); Escape aborts/closes.
  const onFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (connected) close();
      else onSubmit();
    }
    // Escape works even while connecting: it *aborts* the in-flight attempt (the
    // store tears down any half-open tunnel), so a wedged handshake is never a trap.
    // Once connected it is a plain dismissal (the tunnel stays up).
    if (e.key === "Escape") {
      e.preventDefault();
      if (connected) close();
      else cancel();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={connecting ? undefined : connected ? close : cancel}
    >
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="project-dialog vpn-prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        {/* Title row with an explicit ×. The backdrop click is deliberately inert
            while connecting, and the only other way out was the action row — so a
            corner close is the dismissal users reach for and it must be present in
            every state. It mirrors Escape: a plain dismissal once connected, an
            abort (which tears down any half-open tunnel) before that. */}
        <div className="vpn-prompt-header">
          <h2>{connected ? t("vpnPrompt.titleConnected") : t("vpnPrompt.titlePassword")}</h2>
          <button
            type="button"
            className="vpn-prompt-close"
            aria-label={t("vpnPrompt.close")}
            title={t(
              connected
                ? "vpnPrompt.closeTitleConnected"
                : connecting
                  ? "vpnPrompt.closeTitleConnecting"
                  : "vpnPrompt.closeTitleDefault",
            )}
            onClick={connected ? close : cancel}
          >
            ×
          </button>
        </div>
        <p className="vpn-prompt-text">
          {connected ? (
            <>
              {t("vpnPrompt.upFor")} <strong className="vpn-prompt-name">{pending.projectName}</strong>.
            </>
          ) : (
            <>
              {t("vpnPrompt.connectingFor")}{" "}
              <strong className="vpn-prompt-name">{pending.projectName}</strong>.
            </>
          )}
          <br />
          <span className="vpn-prompt-scope">{t("vpnPrompt.trafficScope")}</span>
        </p>
        {/* Why this modal is on screen when the connect was supposed to be silent.
            Without it, a rejected or unreadable saved credential looks identical to
            never having saved one — the user ticked a box, and the box appears to
            have done nothing. */}
        {!connected && pending.reason && (
          <div className="vpn-prompt-reason" role="status">
            {pending.reason}
          </div>
        )}
        {needs.username && (
          <label>
            {t("vpnPrompt.username")}
            <input
              type="text"
              value={username}
              autoComplete="off"
              placeholder={t("vpnPrompt.usernamePlaceholder")}
              disabled={connecting}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onFieldKey}
            />
          </label>
        )}
        <label>
          {needs.username ? t("vpnPrompt.password") : t("vpnPrompt.passphrase")}{" "}
          <span className="ssh-optional-hint">
            {/* "(not stored)" is a claim about the keychain, so it may only be
                made when the keychain was actually readable — a locked store
                answers every lookup like an empty one. */}
            {credential.unreadable
              ? t("savePassword.hintUnreadable")
              : t(remember ? "vpnPrompt.savedInKeychain" : "vpnPrompt.notStored")}
          </span>
          <PasswordInput
            ref={inputRef}
            value={password}
            autoFocus
            disabled={connecting}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </label>
        {needsKeyPassphrase && (
          <label>
            {t("vpnPrompt.keyPassphraseLabel")}
            <PasswordInput
              value={keyPassphrase}
              autoComplete="off"
              placeholder={t("vpnPrompt.keyPassphrasePlaceholder")}
              disabled={connecting}
              onChange={(e) => setKeyPassphrase(e.target.value)}
              onKeyDown={onFieldKey}
            />
            <span className="ssh-optional-hint">{t("vpnPrompt.keyPassphraseHint")}</span>
          </label>
        )}
        {/* The SSH side's row, reused rather than re-drawn — which is what brings
            the locked-keyring banner and its Unlock button here.
            Unticking is deliberately **inert**: `stores/remote/vpn/vpnPrompt` sends
            `remember ? true : null`, never `false`, so an untick leaves the
            keychain alone. Deleting a VPN credential stays an explicit act, in
            the header's VPN menu, exactly as it was. */}
        <SavePasswordRow
          credential={credential}
          checked={remember}
          disabled={connecting}
          onChange={setRemember}
          labelText={t(
            needsKeyPassphrase ? "vpnPrompt.saveVpnCredentials" : "vpnPrompt.savePassphrase",
          )}
        />
        {(connecting || log.length > 0) && <ConnectionLog lines={log} busy={connecting} />}
        {connected && (
          <div className="vpn-prompt-connected" role="status">
            <span className="vpn-connected-check" aria-hidden="true">✓</span> {t("vpnPrompt.tunnelUp")}
          </div>
        )}
        {status === "error" && error && (
          <div className="project-dialog-error vpn-prompt-error">{error}</div>
        )}
        {/* Said out loud only once an attempt has actually failed. The action itself
            (below) is always there, but a *failed* login is the moment the reason for
            it stops being hypothetical: this config may be asking something these two
            fields cannot answer — a challenge/OTP, or a second prompt — and no amount
            of retyping will fix that. */}
        {status === "error" && (
          <div className="vpn-prompt-reason vpn-prompt-terminal-hint" role="status">
            {t("vpnPrompt.challengeHintPre")} <strong>{t("vpnPrompt.logInTerminal")}</strong>{" "}
            {t("vpnPrompt.challengeHintPost")}
          </div>
        )}
        <div className="vpn-prompt-actions">
          {connected ? (
            // The tunnel is up and the connect already resolved — this is a plain
            // dismissal, so a single Close, no teardown.
            <button
              type="button"
              className="primary vpn-connect-btn"
              onClick={close}
              autoFocus
              title={t("vpnPrompt.closeStaysUpTitle")}
            >
              {t("vpnPrompt.close")}
            </button>
          ) : (
            <>
              {/* Switch this one connect to the non-headless flow: the connect command
                  goes to a root-terminal tab and OpenVPN asks its own questions there.
                  Disabled while an attempt is in flight — that attempt would tear the
                  terminal tunnel back down when it settles (same config), so the user
                  Stops first. The global headless setting is never touched. */}
              <button
                type="button"
                className="vpn-prompt-terminal-btn"
                onClick={() => void handoffToTerminal()}
                disabled={connecting}
                title={t(connecting ? "vpnPrompt.terminalBtnStopFirst" : "vpnPrompt.terminalBtnHandoff")}
              >
                {t("vpnPrompt.logInTerminal")} <UntestedTag id="vpnPrompt.logInTerminal" />
              </button>
              <button
                type="button"
                onClick={cancel}
                title={t(connecting ? "vpnPrompt.cancelTitleConnecting" : "vpnPrompt.closeTitleDefault")}
              >
                {t(connecting ? "vpnPrompt.stop" : "common.cancel")}
              </button>
              <button
                type="button"
                className="primary vpn-connect-btn"
                onClick={onSubmit}
                disabled={connecting}
                title={t(
                  connecting
                    ? "vpnPrompt.connectTitleConnecting"
                    : status === "error"
                      ? "vpnPrompt.connectTitleError"
                      : "vpnPrompt.connectTitleDefault",
                )}
              >
                {connecting && <span className="vpn-spinner" aria-hidden="true" />}
                {t(connecting ? "vpnPrompt.connecting" : status === "error" ? "vpnPrompt.retry" : "vpnPrompt.connect")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
