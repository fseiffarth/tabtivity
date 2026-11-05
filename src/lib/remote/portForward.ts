/**
 * The frontend half of a remote tab's port forward (`services::port_forward`,
 * `docs/context/port_forwards.md`): ask the backend to forward a server a tab
 * printed, then open the forwarded page in the system browser.
 *
 * Nothing here chooses an address. The backend resolves the ssh target from the
 * project id, binds `127.0.0.1` on a port it picks, and refuses a host that is
 * not connected; this module only confirms, asks and opens.
 */
import { invoke } from "@tauri-apps/api/core";
import { translateNow, type TranslationKey } from "../i18n";
import { IS_WINDOWS } from "../platform";
import { forwardedUrl, type ServerTarget } from "../terminal/serverUrls";
import type { ProjectEntry } from "../../types";

/** One row of the backend's registry (`ForwardRow`): no paths, no tokens. */
export interface PortForwardRow {
  id: string;
  projectId: string;
  hostId: string;
  hostLabel: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

interface Opened {
  id: string;
  localPort: number;
  reused: boolean;
}

/** The OS can forward (a ControlMaster); Windows waits for phase 1b. */
export const PORT_FORWARD_SUPPORTED = !IS_WINDOWS;

/** What a forward needs to name: where in which project, and what to open. */
export interface ForwardTarget {
  projectId: string;
  hostId: string;
  remoteHost: string;
  remotePort: number;
}

/** The display name of a project's host: its label, else the host name. */
export function hostLabelOf(project: ProjectEntry | undefined, hostId: string): string {
  if (!project) return hostId;
  if (hostId === "primary") return project.remote?.label || project.remote?.host || project.name;
  const worker = project.compute_hosts?.find((h) => h.id === hostId);
  return worker?.label || worker?.host || hostId;
}

/** The "ask once per (host, remote host, port) for each app session" memory. */
const confirmed = new Set<string>();

export function forwardKey(t: ForwardTarget): string {
  return `${t.projectId}\u0001${t.hostId}\u0001${t.remoteHost}\u0001${t.remotePort}`;
}

export function forwardConfirmed(t: ForwardTarget): boolean {
  return confirmed.has(forwardKey(t));
}

export function rememberForwardConfirmed(t: ForwardTarget): void {
  confirmed.add(forwardKey(t));
}

/** Test seam: forget every confirmation. */
export function resetForwardConfirmations(): void {
  confirmed.clear();
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  "not-connected": "portForward.error.notConnected",
  "unsupported-os": "portForward.error.unsupportedOs",
  "not-remote": "portForward.error.notRemote",
  invalid: "portForward.error.invalid",
  failed: "portForward.error.failed",
};

/** A backend `port-forward:<token>[: detail]` refusal as one translated line.
 *  Anything else (a transport refusal, a thrown error) is shown as it came. */
export function portForwardErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const m = /^port-forward:([a-z-]+)(?::\s*(.*))?$/su.exec(raw.trim());
  if (!m) return raw || String(error);
  const key = ERROR_KEYS[m[1]];
  return key ? translateNow(key, { detail: m[2] ?? "" }) : raw;
}

export async function openPortForward(target: ForwardTarget, tabUid: string): Promise<Opened> {
  return invoke<Opened>("port_forward_open", {
    projectId: target.projectId,
    hostId: target.hostId,
    tabUid,
    remoteHost: target.remoteHost,
    remotePort: target.remotePort,
  });
}

export function listPortForwards(): Promise<PortForwardRow[]> {
  return invoke<PortForwardRow[]>("port_forward_list");
}

export function closePortForward(id: string): Promise<boolean> {
  return invoke<boolean>("port_forward_close", { id });
}

/**
 * Confirm (once per session per key), forward, and open the forwarded page in
 * the system browser. Resolves to the local port, or null when the user said
 * no or the forward failed (the failure is reported through `notify`).
 */
export async function forwardAndOpen(opts: {
  target: ForwardTarget;
  page: Pick<ServerTarget, "scheme" | "pathAndQuery">;
  /** The PTY id of the tab asking; the forward ends with it. */
  tabUid: string;
  /** Asks the user; called only for a key not confirmed yet. */
  confirm: () => Promise<boolean>;
  notify: (text: string) => void;
  /** Called after a forward was made (refresh the Ports list). */
  onForwarded?: () => void;
  /** Open the page (default true); false only forwards. */
  open?: boolean;
}): Promise<number | null> {
  if (!PORT_FORWARD_SUPPORTED) {
    opts.notify(translateNow("portForward.error.unsupportedOs", { detail: "" }));
    return null;
  }
  if (!forwardConfirmed(opts.target) && !(await opts.confirm())) return null;
  rememberForwardConfirmed(opts.target);
  try {
    const { localPort } = await openPortForward(opts.target, opts.tabUid);
    opts.onForwarded?.();
    if (opts.open !== false) {
      await invoke("open_external_url", { url: forwardedUrl(opts.page, localPort) });
    }
    return localPort;
  } catch (e) {
    opts.notify(portForwardErrorText(e));
    return null;
  }
}

/** "8888" or "node042:6006" (or "[::1]:8888") as a remote end; null when it is neither. */
export function parseForwardInput(text: string): { remoteHost: string; remotePort: number } | null {
  const raw = text.trim();
  const portOf = (s: string) => (/^\d{1,5}$/u.test(s) && Number(s) >= 1 && Number(s) <= 65535 ? Number(s) : null);
  const bare = portOf(raw);
  if (bare !== null) return { remoteHost: "localhost", remotePort: bare };
  const v6 = /^\[([0-9a-f:]+)\]:(\d+)$/iu.exec(raw);
  if (v6) {
    const port = portOf(v6[2]);
    return port === null ? null : { remoteHost: v6[1], remotePort: port };
  }
  const named = /^([A-Za-z0-9._-]+):(\d+)$/u.exec(raw);
  if (!named || named[1].startsWith("-")) return null;
  const port = portOf(named[2]);
  return port === null ? null : { remoteHost: named[1], remotePort: port };
}
