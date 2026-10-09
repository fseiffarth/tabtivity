/**
 * Default printer per network: which network this machine is on, and the rule
 * for when a saved per-network default is applied.
 *
 * The backend only reports raw readings (`network_identity`); the rule "what
 * counts as the same network" lives here, once, for both the pane that saves a
 * default and the host that applies it:
 *
 *  - **Wi-Fi** is its SSID. Two sites sharing an SSID (eduroam) are one network
 *    to this rule — the honest limit of what a laptop can tell apart cheaply.
 *  - **Wired** is the default gateway's MAC (Linux reads it from `/proc`,
 *    macOS and Windows from `route`/`arp`), since two routers can share an IP
 *    but not a MAC — carried only as a salted hash (`gateway_id`), so no
 *    hardware address lands in settings. Where none can be read (an
 *    unresolved neighbour, another OS) all wired links are one network, `lan`.
 *  - **Disconnected**, or Wi-Fi whose name nothing could read, has no key: a
 *    default cannot be saved for it and nothing is applied on it.
 */

import { invoke } from "@tauri-apps/api/core";
import type { TranslationKey } from "../i18n";

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export interface NetworkIdentity {
  kind: string;
  ssid: string;
  gateway_ip: string;
  /** Salted hash of the gateway MAC — never the MAC itself. */
  gateway_id: string;
}

export interface PrinterNetworkDefault {
  printer: string;
  label: string;
}

export type PrinterNetworkDefaults = Record<string, PrinterNetworkDefault>;

/** One reading, or null when the command is missing (older backend) or failed. */
export async function networkIdentity(): Promise<NetworkIdentity | null> {
  try {
    return await invoke<NetworkIdentity>("network_identity");
  } catch {
    return null;
  }
}

/** The settings key for a network, or null for one that cannot be told apart. */
export function networkKey(id: NetworkIdentity | null): string | null {
  if (!id) return null;
  if (id.kind === "wlan") {
    const ssid = id.ssid.trim();
    return ssid ? `wlan:${ssid}` : null;
  }
  if (id.kind === "lan") {
    const gw = id.gateway_id.trim();
    return gw ? `lan:${gw}` : "lan";
  }
  return null;
}

/** What the user reads for a network — the SSID, or the wired gateway. */
export function networkLabel(id: NetworkIdentity, t: T): string {
  if (id.kind === "wlan") return id.ssid.trim();
  return id.gateway_ip
    ? t("printing.networkWiredVia", { gateway: id.gateway_ip })
    : t("printing.networkWired");
}

/**
 * The printer to make default after moving to `key`, or null for "leave it".
 *
 * Applied on a *change* of network only (the caller tracks the previous key):
 * re-asserting on every poll would silently undo a default the user picked by
 * hand while still on the same network.
 */
export function printerToApply(
  defaults: PrinterNetworkDefaults | undefined,
  key: string | null,
): string | null {
  if (!key || !defaults) return null;
  return defaults[key]?.printer || null;
}
