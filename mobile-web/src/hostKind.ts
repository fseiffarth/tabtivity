import { storageDashKey } from "../../src/lib/brand";

/**
 * Whether this phone is paired with a server daemon rather than a desktop's
 * Mobile host. A server never has a window (`GET /api/v1/status` says
 * `server: true`), so the phone words its "no window" notes for a server — the
 * browser client is where the window-only things are done — and leaves out
 * what only a desktop window answers. Kept across launches, like the untested
 * tags, so the first screen of a cold open is worded right before the status
 * probe answers.
 */
const KEY = storageDashKey("on-server");

let onServer = (() => {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
})();

/** Whether the paired host is a server daemon (last status probe). */
export function isOnServer(): boolean {
  return onServer;
}

/** The status probe's answer; true when it changed what the phone shows. */
export function setOnServer(value: boolean): boolean {
  try { localStorage.setItem(KEY, String(value)); } catch { /* unavailable */ }
  if (onServer === value) return false;
  onServer = value;
  return true;
}
