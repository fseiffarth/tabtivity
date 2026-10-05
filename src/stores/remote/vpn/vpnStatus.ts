import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useRemoteStatusStore, type ConnState } from "../remoteStatus";

/**
 * Live state of the machine's OpenVPN tunnels, keyed by **config path**.
 *
 * A tunnel is not a property of a project, however much the Connect dialog makes
 * it look like one. `openvpn` runs elevated (`pkexec openvpn --config …`) and
 * Tabtivity passes it no routing flags, so whatever the `.ovpn` pushes — typically
 * `redirect-gateway def1` plus DNS — applies to the *whole computer*, for as long
 * as the tunnel is up, no matter which project asked for it. Three facts follow,
 * and this store exists for all of them:
 *
 *  1. **It outlives the project view.** `dropRemotePool` clears a project's lamps
 *     on deactivation and the pill only renders the *active* project's — so
 *     per-project state cannot answer "is a tunnel up right now?". This store can,
 *     and the header's `VpnIndicator` reads it.
 *  2. **It is shared.** The backend registry is keyed by config path, so two
 *     projects on the same `.ovpn` ride one tunnel. `holders` is the refcount that
 *     makes teardown safe: logging out of one project must not pull the tunnel out
 *     from under the other (and out from under the rest of the OS).
 *  3. **It can exist with no project at all.** A tunnel brought up from the header
 *     has no holder — it is simply up. So can one that outlived a reload, or a
 *     previous run of the app. `refresh` finds those; a holder count of zero is a
 *     normal state, not an inconsistency.
 *
 * The refcount lives here rather than being scanned off the projects store on
 * demand precisely because of (1): by the time a project is torn down its lamps are
 * already gone, so it is not a record of who is holding what.
 */
interface VpnStatusStore {
  /** Tunnel state per config path. A config absent from the map is `off`. */
  byConfig: Record<string, ConnState>;
  /** Project ids currently holding each config's tunnel — the refcount. */
  holders: Record<string, string[]>;
  /**
   * True once `refresh` has heard from the backend at all. Until then an empty
   * `byConfig` means "not asked yet", not "no tunnel" — and the VPN-gated
   * schedulers (`lib/remote/vpn/vpnGate.ts`) need the difference: a tunnel that was up all
   * along, first *seen* a second after launch, must not read as one that just
   * came up, or a restored window would open a socket by existing.
   */
  reconciled: boolean;

  /** Set a tunnel's state. `off` forgets it (and its holders) entirely. */
  setState: (config: string, state: ConnState) => void;
  /** Register `projectId` as a holder of `config`'s tunnel. Idempotent. */
  acquire: (config: string, projectId: string) => void;
  /**
   * Drop `projectId`'s claim on `config`. Returns **true** when that was the last
   * holder and the caller should therefore actually invoke `openvpn_disconnect`;
   * false when another live project still needs the tunnel.
   */
  release: (config: string, projectId: string) => boolean;
  /** Drop every claim on `config` (the header's explicit "disconnect tunnel"). */
  releaseAll: (config: string) => void;
  /**
   * Reconcile against the backend's live tunnel set (`openvpn_active`), so a tunnel
   * that outlived a reload, a renderer crash, or a previous run of the app still
   * shows up. In-flight (`connecting`) tunnels survive the reconcile: they are not
   * in the backend registry yet, and dropping them would blank the indicator
   * mid-handshake.
   */
  refresh: () => Promise<void>;
}

/** Forget everything we know about `config`'s tunnel. */
function forget(s: VpnStatusStore, config: string) {
  const byConfig = { ...s.byConfig };
  const holders = { ...s.holders };
  delete byConfig[config];
  delete holders[config];
  return { byConfig, holders };
}

export const useVpnStatusStore = create<VpnStatusStore>((set) => ({
  byConfig: {},
  holders: {},
  reconciled: false,

  setState: (config, state) =>
    set((s) => {
      if (state === "off") {
        if (!(config in s.byConfig) && !(config in s.holders)) return {};
        return forget(s, config);
      }
      if (s.byConfig[config] === state) return {};
      return { byConfig: { ...s.byConfig, [config]: state } };
    }),

  acquire: (config, projectId) =>
    set((s) => {
      const prev = s.holders[config] ?? [];
      if (prev.includes(projectId)) return {};
      return { holders: { ...s.holders, [config]: [...prev, projectId] } };
    }),

  release: (config, projectId) => {
    let last = false;
    set((s) => {
      const next = (s.holders[config] ?? []).filter((id) => id !== projectId);
      if (next.length > 0) {
        return { holders: { ...s.holders, [config]: next } };
      }
      // Last holder out (or a tunnel nobody claimed — one brought up from the header,
      // or seated by `refresh` from a previous run). The caller disconnects; forget
      // it here.
      last = true;
      return forget(s, config);
    });
    return last;
  },

  releaseAll: (config) => set((s) => forget(s, config)),

  refresh: async () => {
    const active = await invoke<string[]>("openvpn_active").catch(() => null);
    if (!active) return;
    let dropped: string[] = [];
    set((s) => {
      const byConfig: Record<string, ConnState> = {};
      // What the backend says is up...
      for (const config of active) byConfig[config] = "connected";
      // ...plus anything still mid-handshake: it isn't in the backend registry yet,
      // so the reconcile would otherwise blank a tunnel that is actively coming up.
      for (const [config, state] of Object.entries(s.byConfig)) {
        if (state === "connecting" && !(config in byConfig)) byConfig[config] = state;
      }
      // A tunnel we believed was UP that the backend no longer reports has
      // **died on its own** — it was not disconnected from the UI, because every
      // deliberate teardown (`disconnectVpnTunnel`, `releaseAll`, `setState off`)
      // forgets the config here first, so it is already absent by the time the
      // next reconcile runs. Only an unplanned death reaches this branch.
      dropped = Object.keys(s.byConfig).filter(
        (config) => s.byConfig[config] === "connected" && !(config in byConfig),
      );
      return { byConfig, reconciled: true };
    });
    for (const config of dropped) {
      onTunnelDropped(config);
      // Drop the claims too: the tunnel they were holding no longer exists, so
      // leaving them behind would make a later reconnect look already-held.
      useVpnStatusStore.getState().releaseAll(config);
    }
  },
}));

/**
 * React to a tunnel that died without being asked to (see `refresh`).
 *
 * The point is not the lamp — it is that **every SSH/SFTP call belonging to a
 * project that was riding this tunnel is now aimed at a peer that will never
 * answer**. Those calls are synchronous Tauri commands over a pooled
 * ControlMaster: nothing about a black-holed socket produces an error, so each
 * one blocks until ssh's own keepalive gives up (~45 s), and the file tree
 * issues one per visible folder. That is the freeze this exists to prevent —
 * clearing the project's status flips `useRemoteBlocked`, so the probes are
 * never dispatched in the first place rather than each paying the timeout.
 *
 * Scoped to the tunnel's **holders**: a project that never claimed this config
 * reaches its host by some other route and is none of this tunnel's business.
 *
 * The backend's pooled session is deliberately NOT torn down here. Reaping it is
 * already the pooled reader's job (`services::remote::pooled_sftp_host` evicts a
 * child whose ssh keepalive killed it), and a teardown issued from this path
 * would itself be a call over the dead connection — the exact thing being
 * avoided.
 */
function onTunnelDropped(config: string): void {
  const holders = useVpnStatusStore.getState().holders[config] ?? [];
  const remote = useRemoteStatusStore.getState();
  for (const projectId of holders) remote.clear(projectId);
}

/** True when at least one tunnel is up or coming up — i.e. the machine's routing
 *  is (or is about to be) Tabtivity's doing. */
export function anyVpnLive(byConfig: Record<string, ConnState>): boolean {
  return Object.values(byConfig).some((s) => s === "connected" || s === "connecting");
}

/**
 * Whether a dialog's own "Connect via OpenVPN" section still has anything to offer.
 * Every remote menu that can start a tunnel asks this, so they all answer it alike:
 * the Connect modal, and the SSH section the new-project and extend-to-remote
 * dialogs share.
 *
 * A tunnel is machine-wide, so once *any* config is live the routing is already
 * there and a project-scoped second connect path is noise — the section collapses
 * to `VpnTunnelUpNotice` and the dialog goes straight to SSH. The exception is a
 * tunnel **this** dialog brought up (`ownTunnelBusy`): its controls (handshake log,
 * Stop/Disconnect) must stay reachable where the user started it.
 */
export function useVpnSectionVisible(ownTunnelBusy: boolean): boolean {
  const globallyLive = useVpnStatusStore((s) => anyVpnLive(s.byConfig));
  return !globallyLive || ownTunnelBusy;
}

// ── Lamp helpers ────────────────────────────────────────────────────────────────
// A tunnel has two audiences and every connect path has to serve both: the project
// that asked for it (its pill lamp) and the machine it reroutes (the header
// indicator + the refcount). These keep the two in step so a call site can't
// remember one and forget the other. They live here, next to the store, rather
// than in `projects.ts`: `vpnPrompt` and `useRemoteReconnect` need them too, and
// routing them through `projects.ts` would close an import cycle.

/** A tunnel is being brought up for `projectId`. */
export function markVpnConnecting(projectId: string, config: string): void {
  useRemoteStatusStore.getState().setVpn(projectId, "connecting");
  useVpnStatusStore.getState().setState(config, "connecting");
}

/** A tunnel is up, at `projectId`'s request — which makes that project a holder. */
export function markVpnConnected(projectId: string, config: string): void {
  useRemoteStatusStore.getState().setVpn(projectId, "connected");
  useVpnStatusStore.getState().setState(config, "connected");
  useVpnStatusStore.getState().acquire(config, projectId);
}

/**
 * A tunnel failed to come up for `projectId`. The project's lamp goes red — that
 * failure is its business — but the machine-level entry is *forgotten*: a tunnel
 * that never came up is rerouting nothing, and a red badge parked in the header
 * would claim otherwise. No holder is recorded; there is nothing held.
 */
export function markVpnError(projectId: string, config: string): void {
  useRemoteStatusStore.getState().setVpn(projectId, "error");
  useVpnStatusStore.getState().setState(config, "off");
}

/**
 * Drop `projectId`'s claim on `config`'s tunnel, and tear the tunnel down **only if
 * nobody else is still holding it**.
 *
 * This is the one place a project-scoped action is allowed to touch a machine-scoped
 * resource. Every project-side teardown routes through it — the pill's logout, the
 * Connect modal's Disconnect, archiving a project — because an unconditional
 * `openvpn_disconnect` here yanks the routing out from under any *other* project on
 * the same config, and out from under the rest of the OS with it.
 *
 * Safe to call in any order relative to `dropRemotePool`: the holder list is kept
 * here, deliberately independent of the per-project lamps that `dropRemotePool`
 * clears.
 */
export function releaseVpn(projectId: string, config: string | undefined): void {
  if (!config) return;
  if (useVpnStatusStore.getState().release(config, projectId)) {
    void invoke("openvpn_disconnect", { config }).catch(() => {});
  }
}

/**
 * Tear a tunnel down outright, dropping every holder — the header indicator's
 * "Disconnect", where the user is acting on the *tunnel*, not on a project. The
 * holders' SSH sessions are left alone: they may well survive (the host can be
 * reachable without the tunnel), and if they don't, their own lamps will say so.
 *
 * Reaches interactive (terminal-started) tunnels too: the backend arms every
 * interactive connect with a `--writepid` it owns, so it has a pid to signal.
 */
export function disconnectVpnTunnel(config: string): void {
  useVpnStatusStore.getState().releaseAll(config);
  void invoke("openvpn_disconnect", { config }).catch(() => {});
}

/**
 * Tear down every live tunnel on the **app-close path, before the window (and the
 * popouts) go away** — awaited, so the UI stays on screen until it is done. Returns
 * `true` when every tunnel is down, `false` when the user dismissed the teardown
 * prompt: the tunnel (and the machine-wide routing it installed) is still up, so
 * the caller should warn the user — but the quit is **not** aborted. This is a
 * one-shot ask: a decline here is recorded on the backend so `RunEvent::Exit`'s own
 * teardown pass never re-prompts for the same tunnel with the window already gone.
 *
 * The backend also disconnects all tunnels in its `RunEvent::Exit` handler, but that
 * fires only *after* the webview window has been destroyed, so the elevated
 * `pkexec kill` raised its polkit password prompt against a screen where Tabtivity had
 * already vanished — password *after* close, the wrong order. `openvpn_disconnect_all_on_quit`
 * tears down the **same registered set** that exit-time handler would (not the liveness-
 * filtered `openvpn_active` subset, which could skip a tunnel that then prompts at exit),
 * surfaces a refused prompt as an error, and keeps the tunnel registered — so this runs
 * to completion, prompt and all, while Tabtivity is still visible.
 */
export async function disconnectAllTunnelsOnQuit(): Promise<boolean> {
  return invoke("openvpn_disconnect_all_on_quit")
    .then(() => true)
    .catch(() => false);
}
