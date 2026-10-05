import { useVpnStatusStore } from "../../../stores/remote/vpn/vpnStatus";
import type { ConnState } from "../../../stores/remote/remoteStatus";

/**
 * The VPN gate for network accounts — mail and CalDAV accounts flagged
 * `require_vpn`, whose server sits inside an institutional network and is
 * unreachable from anywhere else.
 *
 * Without the gate such an account fails every interval check while the tunnel
 * is down: a connect timeout per tick, a red header, and nothing catching up
 * when the tunnel comes back. With it the schedulers (`MailIndicator`,
 * `CalDavSyncHost`) **skip** the account quietly while no tunnel is up and check
 * it **at once** when one comes up. The backend enforces the same rule where a
 * socket is opened, so a manual click while the tunnel is down gets its refusal
 * from there — one sentence, `services::openvpn::VPN_GATE_REFUSAL`, rather than
 * a copy kept here.
 *
 * "VPN on" means **a tunnel Tabtivity knows about** — headless, or typed into a
 * terminal tab — which is all `openvpn_active` can see. A tunnel brought up
 * elsewhere (NetworkManager, WireGuard) is invisible, so an account gated on it
 * never syncs; the account dialogs say so beside the checkbox.
 */

/** True while any tunnel Tabtivity knows about is up. Pure, for the tests. */
export function anyTunnelUp(byConfig: Record<string, ConnState>): boolean {
  return Object.values(byConfig).some((state) => state === "connected");
}

/** Whether `account` may reach its server right now, given the tunnel state. */
export function vpnGateAllows(account: { require_vpn?: boolean }, tunnelUp: boolean): boolean {
  return !account.require_vpn || tunnelUp;
}

/** The live answer, for code outside React (a scheduler's tick). */
export function vpnTunnelUp(): boolean {
  return anyTunnelUp(useVpnStatusStore.getState().byConfig);
}

/**
 * The tunnel state as a hook, in **three** values: `true`/`false` once the
 * store has reconciled against the backend, `null` before. The `null` is what
 * lets a scheduler tell "a tunnel just came up" (`false → true`, worth a
 * catch-up check) from "the store just found out a tunnel was up all along"
 * (`null → true`, which must open nothing — see `stores/remote/vpn/vpnStatus`'s
 * `reconciled`).
 */
export function useVpnTunnelUp(): boolean | null {
  return useVpnStatusStore((s) => (s.reconciled ? anyTunnelUp(s.byConfig) : null));
}
