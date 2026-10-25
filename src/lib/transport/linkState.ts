/**
 * Whether this page is the browser desktop client (hosted plan §7.1) and, if
 * so, the state of its one link to the server.
 *
 * Kept at the bottom of the import graph on purpose (no React, no stores):
 * `installWeb.ts` sets the flag before any app module loads, `wsClient.ts`
 * moves the link state, and app code — the connection banner, the Downloads
 * section that is the device's own, the poller pause — reads it. Inside the
 * Tauri window the flag stays off and the link is always `up`.
 */
import { translateNow } from "../i18n";

export type LinkState = "connecting" | "up" | "down";

let serverClient = false;
let state: LinkState = "up";
const listeners = new Set<(state: LinkState) => void>();

/** Called once by the web entry, before the app loads. */
export function markServerClient(): void {
  serverClient = true;
}

/** True in a browser served by the sidecar; false in the Tauri window. */
export function isServerClient(): boolean {
  return serverClient;
}

let connectWindow = false;

/** Called by the Connect window's entry (hosted plan §7.2), before the app
 * loads. */
export function markConnectWindow(): void {
  connectWindow = true;
}

/** True in the desktop app's Connect window, where the page's origin is the
 * desktop app's own, not the server's. */
export function isConnectWindow(): boolean {
  return connectWindow;
}

let adminInstallsClis = false;

/** Set from the hello: this backend is a hosted server, where agent CLIs are
 * installed, updated and removed by the administrator only (admin helper
 * `cli-install`; user decision 2026-10-03). */
export function markCliInstallsByAdmin(on: boolean): void {
  adminInstallsClis = on;
}

/** Manage CLIs shows versions and "ask your administrator" instead of
 * install/update/remove buttons. False in the window and the P2 sidecar. */
export function cliInstallsByAdmin(): boolean {
  return adminInstallsClis;
}

export function linkState(): LinkState {
  return state;
}

export function setLinkState(next: LinkState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener(next);
}

/** Subscribe to link changes; returns the unsubscribe. */
export function onLinkState(listener: (state: LinkState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The rejection every pending or attempted call gets while the link is down
 * (plan §3.5: "a typed `disconnected` error", and no invoke is sent). An
 * `Error` so the many `String(e)` call sites print a sentence, with `code`
 * for the few that want to tell it from a command's own error.
 */
export class DisconnectedError extends Error {
  readonly code = "disconnected" as const;

  constructor() {
    super(translateNow("server.disconnected"));
    this.name = "DisconnectedError";
  }
}

export function isDisconnectedError(error: unknown): error is DisconnectedError {
  return error instanceof DisconnectedError || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "disconnected");
}

/** Test seam: back to the Tauri-window defaults. */
export function resetLinkStateForTests(): void {
  serverClient = false;
  state = "up";
  listeners.clear();
}
