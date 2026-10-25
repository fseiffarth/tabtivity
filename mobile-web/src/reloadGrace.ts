/**
 * Pull-to-refresh on the phone must not bring the lock back. A reload starts
 * the page from scratch, and from scratch every open asks for the PIN or
 * fingerprint — so the gesture that means "show me the latest" cost an unlock.
 *
 * The page being left while unlocked and in use stamps the moment it went; the
 * next page may skip the lock only when every one of these holds:
 * - the browser says this load was a reload (not a launch, a link, or history);
 * - it was not a page the browser discarded and brought back (`wasDiscarded`);
 * - the stamp is seconds old, so a phone put down and picked up later asks.
 * The stamp is read once and removed either way.
 *
 * The flag this replaces was a bare "unlocked" in sessionStorage with none of
 * those checks, and an app the OS killed and reopened carried it — whoever
 * picked the phone up next walked straight in.
 */
import { storageKey } from "../../src/lib/brand";

const RELOAD_GRACE_KEY = storageKey("mobile.reloadGrace");
/** A reload's gap between leaving and the new page asking is a second or two;
 * this leaves room for a slow phone without covering a phone set down. */
export const RELOAD_GRACE_MS = 15_000;

type GraceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): GraceStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function navigationType(): string | undefined {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type;
  } catch {
    return undefined;
  }
}

function wasDiscarded(): boolean {
  return (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
}

/** Stamp the moment an unlocked, in-use page is left. */
export function noteUnlockedLeave(now = Date.now(), storage = sessionStore()): void {
  try {
    storage?.setItem(RELOAD_GRACE_KEY, String(now));
  } catch {
    // A blocked store just means the next load asks, as a cold open does.
  }
}

/** Whether this load is a reload of a page left unlocked moments ago. One-shot. */
export function takeReloadGrace(
  now = Date.now(),
  storage = sessionStore(),
  type = navigationType(),
  discarded = wasDiscarded(),
): boolean {
  let stamp: string | null = null;
  try {
    stamp = storage?.getItem(RELOAD_GRACE_KEY) ?? null;
    storage?.removeItem(RELOAD_GRACE_KEY);
  } catch {
    return false;
  }
  if (type !== "reload" || discarded || stamp === null || !/^\d+$/.test(stamp)) return false;
  const age = now - Number(stamp);
  return age >= 0 && age <= RELOAD_GRACE_MS;
}

/**
 * A connect that fails on a path the phone itself has wedged — a tunnel just
 * coming back, a connection the browser kept from before the phone slept —
 * often goes through from a fresh page where Retry on the same page does not.
 * So the first such failure reloads the page once by itself instead of
 * showing the splash; a second one in a row shows it. The mark lives in
 * sessionStorage, which a reload keeps, and a connect that works clears it,
 * so each failure streak gets its one reload and never a loop.
 */
const CONNECT_RELOAD_KEY = storageKey("mobile.connectReload");

/** Whether this failure may reload the page. Marks the reload as spent; a
 * blocked store says no, since nothing could stop the next page reloading. */
export function takeConnectReload(storage = sessionStore()): boolean {
  try {
    if (!storage || storage.getItem(CONNECT_RELOAD_KEY) !== null) return false;
    storage.setItem(CONNECT_RELOAD_KEY, "1");
    return storage.getItem(CONNECT_RELOAD_KEY) !== null;
  } catch {
    return false;
  }
}

/** Whether this page is the reload a failed connect asked for. */
export function isConnectReload(storage = sessionStore()): boolean {
  try {
    return (storage?.getItem(CONNECT_RELOAD_KEY) ?? null) !== null;
  } catch {
    return false;
  }
}

/** A connect went through: the next failure streak gets its reload again. */
export function clearConnectReload(storage = sessionStore()): void {
  try {
    storage?.removeItem(CONNECT_RELOAD_KEY);
  } catch {
    // Nothing to undo: a store that cannot be written never handed one out.
  }
}

/**
 * An unlock that only the network failed must not be asked for again. After
 * the fingerprint the reader met "Connecting…" or the failure splash, went to
 * the Tailscale app as the splash says, or swiped the app away and opened it
 * again — and every fresh page asked once more, so one unlock was paid two or
 * three times while the tunnel came back. A page left in that state (or
 * failing in it) stamps when the reader was last there; the next page within
 * the window signs
 * straight in, whatever kind of load it is, since a relaunch is the point.
 * localStorage, because a relaunched PWA starts a new session store. The
 * caller's window is the idle lock's: an unlocked app left in the background
 * stays open that long as well. Read once and removed; a connect that works
 * removes it too.
 */
const CONNECT_GRACE_KEY = storageKey("mobile.connectGrace");

function localStore(): GraceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Stamp an unlocked page that is failing to connect, or being left while it does. */
export function noteConnectGrace(now = Date.now(), storage = localStore()): void {
  try {
    storage?.setItem(CONNECT_GRACE_KEY, String(now));
  } catch {
    // A blocked store just means the next page asks, as before.
  }
}

/** Whether this page may skip the lock: a connect failed after an unlock
 * within `windowMs`. One-shot. */
export function takeConnectGrace(windowMs: number, now = Date.now(), storage = localStore()): boolean {
  let stamp: string | null = null;
  try {
    stamp = storage?.getItem(CONNECT_GRACE_KEY) ?? null;
    storage?.removeItem(CONNECT_GRACE_KEY);
  } catch {
    return false;
  }
  if (stamp === null || !/^\d+$/.test(stamp)) return false;
  const age = now - Number(stamp);
  return age >= 0 && age <= windowMs;
}

/** A connect went through: nothing failed for a later page to skip the lock over. */
export function clearConnectGrace(storage = localStore()): void {
  try {
    storage?.removeItem(CONNECT_GRACE_KEY);
  } catch {
    // Nothing to undo: a store that cannot be written holds no stamp.
  }
}
