import { useVpnStatusStore } from "../../stores/remote/vpn/vpnStatus";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore, whenSettingsLoaded } from "../../stores/settings";
import { retryAutoConnectAfterVpn, retryUnreachableNow } from "../../stores/projects";

/**
 * Wire the two *event-driven* halves of remote auto-connect that the imperative
 * connect paths can't own by themselves. The launch-time half already lives where
 * it belongs — a project's active-project auto-connect fires from `projects.load()`
 * / `setActive`, the armed VPN tunnel from `autoConnectVpnOnLaunch`. What was
 * missing is a reaction to a **tunnel coming up**:
 *
 *  1. **On any tunnel becoming active**, re-attempt the things that were only
 *     unreachable *because* the routing wasn't there yet — the active remote
 *     project (`retryAutoConnectAfterVpn`) and every armed global machine. This is
 *     what makes a project reachable *only through the VPN* connect promptly the
 *     instant the tunnel is up, instead of sitting red until the user acts. It fires
 *     whoever brought the tunnel up — the armed launch tunnel, a header connect, or
 *     another project — because a tunnel is machine-wide.
 *  2. **At launch**, sweep the global machines armed for auto-connect (the project
 *     side already self-starts from its store) — but only when the Machines feature
 *     is actually on, and only once settings have loaded to say so (`machineSweep`).
 *     The sweep then re-runs the active project's auto-connect, because an armed
 *     machine counts as the opt-in of the project host that is the same login.
 *  3. **On the network coming back** (`online`: a wake, a Wi-Fi hop), run every
 *     host re-try that is waiting out an unreachable host's backoff now
 *     (`retryUnreachableNow`), instead of up to five minutes later.
 *
 * We subscribe to the machine-level VPN store rather than poll, so the retry is
 * immediate on the exact `→ connected` transition (an earlier poll-based reaction
 * lagged the tunnel by seconds). Idempotent by construction: the retry paths skip a
 * live/winning lamp, and `setState` collapses a no-op transition, so a tunnel that
 * comes up as a *side effect* of an auto-connect (a project bringing up its own
 * VPN) can't feed back into a loop.
 */

let installed = false;

export function initRemoteAutoReconnect(): void {
  if (installed) return;
  installed = true;

  // React to a tunnel becoming active. `refresh()` at launch seats a tunnel that
  // outlived a previous run (prev has no entry → this fires for it too), which is
  // exactly right: a remote reachable only through that tunnel should connect.
  useVpnStatusStore.subscribe((state, prev) => {
    const roseToConnected = Object.entries(state.byConfig).some(
      ([config, s]) => s === "connected" && prev.byConfig[config] !== "connected",
    );
    if (roseToConnected) onVpnTunnelUp();
  });

  window.addEventListener("online", () => retryUnreachableNow());

  // Launch-time global-machine sweep, decoupled from the header component so it runs
  // even before the Machines menu is ever opened.
  void machineSweep();
}

/**
 * The armed-machine sweep, behind the **feature switch**.
 *
 * `machines_enabled` is off by default and hides the header indicator — which was
 * the whole surface for seeing a machine connect, disconnecting one, or disarming
 * its toggle. Sweeping anyway meant a user who turned the feature off (or never
 * turned it on, and imported a machine list once) still had every armed host
 * dialled at launch and again on every tunnel-up, with nowhere to watch it happen
 * and nothing to stop it with. A feature that is off connects nothing.
 *
 * Gated on settings being **loaded**, not merely present: an unloaded store reads
 * as "off" for every field, so firing before it arrives would race the switch on
 * exactly the launch path this is. Waiting costs a few hundred ms; the sweep is
 * silent by construction and nothing is watching for it.
 */
async function machineSweep(): Promise<void> {
  await whenSettingsLoaded();
  if (!useSettingsStore.getState().settings?.machines_enabled) return;
  const gm = useGlobalMachinesStore.getState();
  if (!gm.loaded) await gm.load();
  await useGlobalMachinesStore.getState().autoConnect();
  // The same sweep must reach the active project's hosts that an armed machine opts
  // in (`machineArmsHost`), through the project's own path: at launch the project
  // may have tried before the machine list loaded, and on tunnel-up a host that went
  // red while the network was away needs its lamp reset — `autoConnect` itself skips
  // a machine whose (never-polled) status still reads connected, so nothing else
  // would bring the project back.
  retryAutoConnectAfterVpn();
}

function onVpnTunnelUp(): void {
  retryAutoConnectAfterVpn();
  void machineSweep();
}
