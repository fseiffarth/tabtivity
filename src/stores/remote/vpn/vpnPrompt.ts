import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../projects";
import { markVpnConnected, useVpnStatusStore } from "./vpnStatus";
import { openVpnLoginInTerminal } from "../../../lib/remote/vpn/vpnAutoConnect";

/**
 * Mediates the activation-time OpenVPN connection. By default the VPN password
 * is not persisted, so each time a VPN-gated project is activated we ask for it
 * via a modal — unless the user ticked "Save passphrase", in which case the
 * backend reconnects silently from the OS keychain and this prompt is skipped
 * (see `autoConnectPrimary`'s VPN escalation and services::remote_credentials).
 *
 * The store owns the whole connect lifecycle — not just collecting the password
 * — so a failed tunnel surfaces *in the modal* (status + error, with a retry)
 * instead of failing silently in the background. `request()` resolves once the
 * tunnel is up and rejects if the user cancels.
 */
interface PendingPrompt {
  config: string;
  /** What the tunnel is being brought up *for* — a project name, or the config's
   *  own name when the connect came from the header (no project behind it). */
  projectName: string;
  /**
   * Project id, so a username typed here can be persisted to the spec — and so the
   * project is recorded as a holder of the tunnel.
   *
   * `null` for a connect started from the header's VPN menu: the tunnel is a
   * machine-level thing and can legitimately be brought up on its own, with no
   * project asking for it (and therefore no spec to persist a username into).
   */
  projectId: string | null;
  /** Auth username seed for `auth-user-pass` configs (from the stored spec). */
  username?: string;
  /**
   * Why the modal is open at all, when it was *meant* to be a silent connect: the
   * saved credentials were rejected, or unreadable, or there were none. Shown at the
   * top of the prompt, because "it just asked me again" with no reason given is
   * exactly the failure mode a saved credential is supposed to remove — and the
   * backend already knows which of the three it was.
   *
   * Absent for a prompt that was never going to be silent (a first-ever connect).
   */
  reason?: string;
  /**
   * Seed for the "Save passphrase" toggle, overriding the "is one already saved?"
   * default. Set to `true` when the prompt *is* the save action (the VPN menu's
   * "Save login credentials"): there is nothing saved yet, so the default would
   * come back unticked and the connect the user asked to remember would remember
   * nothing.
   */
  remember?: boolean;
  /** Resolved once the tunnel is up. */
  resolve: () => void;
  /** Rejected if the user cancels (or the prompt is superseded). */
  reject: (reason?: unknown) => void;
}

type ConnectStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Why `request()` rejected when the user chose the terminal instead (`handoffToTerminal`).
 *
 * It is *not* a failure and must not be treated as one: the tunnel is coming up in a
 * root-terminal tab, the lamp is already "connecting", and `pollVpnUp` owns the
 * outcome from here. A caller that reads every rejection as "no tunnel" would flip
 * that lamp red over a login the user is in the middle of typing — so every caller
 * of `request` checks for this first (see `VpnIndicator.connect`).
 */
export const VPN_TERMINAL_HANDOFF = "vpn-terminal-handoff";

/** Whether a `request()` rejection is the terminal handoff rather than a failure. */
export function isVpnTerminalHandoff(e: unknown): boolean {
  return e instanceof Error && e.message === VPN_TERMINAL_HANDOFF;
}

interface VpnPromptState {
  pending: PendingPrompt | null;
  status: ConnectStatus;
  error: string;
  /** Open the prompt for a project; resolves when connected, rejects on cancel.
   *  `username` seeds the field for `auth-user-pass` configs; `opts` carries why a
   *  connect that should have been silent is asking (`reason`) and an override for
   *  the save toggle (`remember`). */
  request: (
    config: string,
    projectName: string,
    projectId: string | null,
    username?: string,
    opts?: { reason?: string; remember?: boolean },
  ) => Promise<void>;
  /** Attempt the tunnel with `username`/`password`, plus `keyPassphrase` for a
   *  config that has an encrypted key *and* an `auth-user-pass` account (OpenVPN
   *  prompts for those two separately; answering only one hangs the handshake on
   *  the other). `remember` opts into saving the secrets in the OS keychain for
   *  no-prompt reconnects (default off). On success closes + resolves (persisting
   *  the username to the spec); on failure keeps the modal open with the error so
   *  the user can retry. */
  submit: (
    password: string,
    remember?: boolean,
    username?: string,
    keyPassphrase?: string,
  ) => Promise<void>;
  cancel: () => void;
  /**
   * Give up on the headless login for this config and hand it to a root terminal —
   * the non-headless flow, switched on for **this connect only** (the global
   * `connections_headless` setting is untouched).
   *
   * This is the escape hatch for a config Tabtivity cannot log in to on its own: a
   * server that answers with a challenge/OTP prompt, or any handshake whose real
   * question never reaches these two password fields. The symptom is the sequence
   * this modal was showing — the saved-credential connect errors, the prompt opens,
   * and the password typed into it is rejected too, forever. In the terminal OpenVPN
   * asks its own questions and the user answers them directly.
   *
   * Closes the modal and rejects the caller with [`VPN_TERMINAL_HANDOFF`]: the tunnel
   * is not up yet, so resolving would be a lie, but the attempt is very much alive
   * (`openVpnLoginInTerminal` leaves the lamp connecting and polls) so it is not a
   * failure either. Rejects with the underlying error instead if the handoff itself
   * failed, leaving the modal open so the user still has somewhere to be.
   */
  handoffToTerminal: () => Promise<void>;
  /** Dismiss the modal once the tunnel is up. Unlike `cancel`, it tears **nothing**
   *  down — the connect already succeeded and resolved — it just closes the panel. */
  close: () => void;
  /** Adopt a tunnel that came up out-of-band: our own `openvpn_connect` can hang
   *  without ever resolving (the "Initialization Sequence Completed" marker was
   *  muted/slow), yet the header's periodic `openvpn_status` reconcile flips the
   *  machine-level lamp green. When that happens under a still-"connecting" modal,
   *  reflect it — flip to connected and resolve the caller — so the modal never
   *  strands on "Connecting…" over a tunnel that is actually up. Idempotent. */
  markConnected: () => void;
}

/**
 * The tunnel is up: light the machine-level lamp (so no caller of `request` resolves
 * without the header indicator showing it), take the project's hold on it, persist the
 * non-secret username, resolve the caller — and then **leave the modal open** on a
 * `connected` status. Success used to slam the panel shut, which read as "did it work?";
 * now it says so, with a Close button, and the user dismisses it when they're ready.
 */
function finishConnected(p: PendingPrompt, username?: string): void {
  if (p.projectId) markVpnConnected(p.projectId, p.config);
  else useVpnStatusStore.getState().setState(p.config, "connected");
  if (username?.trim() && p.projectId) {
    void useProjectsStore
      .getState()
      .setProjectOpenvpn(p.projectId, p.config, username.trim())
      .catch(() => {});
  }
  useVpnPromptStore.setState({ status: "connected", error: "" });
  p.resolve();
}

export const useVpnPromptStore = create<VpnPromptState>((set, get) => ({
  pending: null,
  status: "idle",
  error: "",
  request: (config, projectName, projectId, username, opts) =>
    new Promise<void>((resolve, reject) => {
      // If a prompt is already open, cancel it before replacing.
      get().pending?.reject(new Error("superseded"));
      set({
        pending: {
          config,
          projectName,
          projectId,
          username,
          reason: opts?.reason,
          remember: opts?.remember,
          resolve,
          reject,
        },
        status: "idle",
        error: "",
      });
    }),
  submit: async (password, remember = false, username, keyPassphrase) => {
    const p = get().pending;
    if (!p || get().status === "connecting") return;
    set({ status: "connecting", error: "" });
    try {
      await invoke("openvpn_connect", {
        config: p.config,
        username: username?.trim() || null,
        password,
        keyPassphrase: keyPassphrase || null,
        // `true` or `null`, NEVER the raw flag — the SSH rule
        // (`components/projects/useSavedCredential`'s `rememberArg`) applies here
        // for the same reason. `false` is `Remember::Clear`, and `openvpn_connect`
        // applies it *after* authenticating with the passphrase/username it
        // resolved from the keychain — so an unticked box deletes all three
        // secrets it just used. And this box is seeded by an unbounded async read
        // (`vpn_has_saved_password`), so submitting before that lands sends
        // `false` for a config that does have saved credentials. Forgetting stays
        // the explicit action's job.
        remember: remember ? true : null,
      });
      // Aborted while this attempt was in flight (Stop/Escape during connect): the
      // backend attempt runs to its own timeout regardless and may even have brought
      // the tunnel up, so don't resurrect a cancelled UI — tear down whatever opened
      // and leave. `cancel` already reset the lamp; a late green here would undo it.
      if (get().pending !== p) {
        void invoke("openvpn_disconnect", { config: p.config }).catch(() => {});
        return;
      }
      finishConnected(p, username);
    } catch (e) {
      // Aborted mid-connect — the modal is already gone; don't reopen it with an error.
      if (get().pending !== p) return;
      // The connect *reported* a failure — but `connect_streaming` calls it a failure
      // if it doesn't see "Initialization Sequence Completed" within its window, and a
      // tunnel can be genuinely up while that marker was muted, reordered, or just slow.
      // So before showing red, ask the backend directly whether the tunnel is up. This
      // is the "it connected but the modal didn't notice" case, made to notice.
      const up = await invoke<boolean>("openvpn_status", { config: p.config }).catch(() => false);
      if (get().pending !== p) return;
      if (up) {
        finishConnected(p, username);
        return;
      }
      // Keep the modal open so the user can fix the passphrase and retry.
      set({ status: "error", error: String(e) });
    }
  },
  cancel: () => {
    const p = get().pending;
    if (!p) return;
    // A cancel *during* an in-flight connect is an abort, not just a dismissal: the
    // backend attempt keeps running to its own timeout and may bring the tunnel up,
    // so tear down whatever half-opened and reset the machine-level lamp now. The
    // pending-identity guard in `submit` then drops the late result instead of
    // flipping the lamp green behind a UI the user already closed.
    const wasConnecting = get().status === "connecting";
    set({ pending: null, status: "idle", error: "" });
    if (wasConnecting) {
      void invoke("openvpn_disconnect", { config: p.config }).catch(() => {});
      useVpnStatusStore.getState().setState(p.config, "off");
    }
    p.reject(new Error("cancelled"));
  },
  handoffToTerminal: async () => {
    const p = get().pending;
    // Never while a headless attempt is in flight: that attempt can still come up on
    // its own, and `submit`'s superseded-guard tears down whatever it opened — by
    // config, which is the *same* config the terminal tunnel would be registering
    // under. So it would kill the login the user just switched to. The button is
    // disabled while connecting for exactly this reason; this is the guard behind it.
    if (!p || get().status === "connecting" || get().status === "connected") return;
    try {
      await openVpnLoginInTerminal(p.config, {
        label: p.projectName,
        projectId: p.projectId,
      });
    } catch (e) {
      // The command couldn't even be built — nothing was opened and no lamp moved, so
      // keep the modal (and its password fields) exactly where they were.
      set({ status: "error", error: String(e) });
      return;
    }
    if (get().pending !== p) return;
    set({ pending: null, status: "idle", error: "" });
    p.reject(new Error(VPN_TERMINAL_HANDOFF));
  },
  close: () => {
    // Only meaningful once connected: the tunnel stays up, the caller already resolved
    // (`finishConnected`), so this is a pure UI dismissal — no teardown, no reject.
    if (!get().pending) return;
    set({ pending: null, status: "idle", error: "" });
  },
  markConnected: () => {
    const p = get().pending;
    if (!p || get().status === "connected") return;
    finishConnected(p);
  },
}));
