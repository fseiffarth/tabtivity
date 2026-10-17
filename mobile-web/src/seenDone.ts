// Which finished agent tabs this phone has already looked at, so Home's Needs
// you lists a "done" tab until it is opened and then lets it go. It is this
// phone's own reading — a tab seen on the desktop is not seen here — so it
// never crosses the bridge.
//
// Keyed by the tab's opaque id against the `done_at` it was seen at: the next
// finished turn carries a newer `done_at`, and the tab is unseen again. A tab
// with no `done_at` (an older desktop) is seen once for good.

import { storageKey } from "../../src/lib/brand";

const KEY = storageKey("mobile.seenDone");

/** How many tabs are remembered. A phone used for a year should not carry
 * every tab it ever opened; the newest marks are the ones a list still shows. */
export const SEEN_DONE_CAP = 200;

/** Tab id → the `done_at` it was seen at (0 when the desktop sent none),
 * newest mark first. */
export type SeenDone = ReadonlyArray<readonly [string, number]>;

type SeenStorage = Pick<Storage, "getItem" | "setItem">;

/** Anything that is not a list of [id, number] pairs reads as nothing seen,
 * rather than being trusted into the check. */
export function parseSeenDone(raw: string | null): SeenDone {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is [string, number] => Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === "string"
      && typeof entry[1] === "number"
      && Number.isFinite(entry[1]));
  } catch {
    return [];
  }
}

/** The list with `tabId` marked seen at `doneAt`, moved to the front and the
 * oldest marks past the cap dropped. Pure. */
export function withSeen(seen: SeenDone, tabId: string, doneAt: number | undefined): SeenDone {
  return [[tabId, doneAt ?? 0] as const, ...seen.filter(([id]) => id !== tabId)].slice(0, SEEN_DONE_CAP);
}

/** Whether a finished tab still waits to be looked at: never opened here, or
 * finished again since. */
export function isUnseenDone(seen: SeenDone, tab: { id: string; agent_status?: string; done_at?: number }): boolean {
  if (tab.agent_status !== "done") return false;
  const mark = seen.find(([id]) => id === tab.id);
  if (!mark) return true;
  return (tab.done_at ?? 0) > mark[1];
}

export function readSeenDone(storage?: SeenStorage): SeenDone {
  try {
    return parseSeenDone((storage ?? localStorage).getItem(KEY));
  } catch {
    // Storage can be unavailable in a private browser: nothing is seen.
    return [];
  }
}

/** Marks one tab seen and stores it; answers the list as stored. */
export function markDoneSeen(tabId: string, doneAt: number | undefined, storage?: SeenStorage): SeenDone {
  const next = withSeen(readSeenDone(storage), tabId, doneAt);
  try {
    (storage ?? localStorage).setItem(KEY, JSON.stringify(next));
  } catch {
    // See readSeenDone.
  }
  return next;
}

const INTERRUPTED_KEY = storageKey("mobile.seenInterrupted");

/** Interrupted tabs this phone has opened. The desktop lets an interrupted tab's
 * lamp go once its screen is viewed; the phone's card does the same. Unlike a
 * finished turn there is no timestamp to compare, so a tab leaves the list as
 * soon as it reports any other state (`withoutResumed`) and its next
 * interruption shows again. */
export function readSeenInterrupted(storage?: SeenStorage): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse((storage ?? localStorage).getItem(INTERRUPTED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeSeenInterrupted(ids: ReadonlyArray<string>, storage?: SeenStorage): ReadonlyArray<string> {
  try {
    (storage ?? localStorage).setItem(INTERRUPTED_KEY, JSON.stringify(ids));
  } catch {
    // See readSeenDone.
  }
  return ids;
}

export function markInterruptedSeen(tabId: string, storage?: SeenStorage): ReadonlyArray<string> {
  return writeSeenInterrupted([tabId, ...readSeenInterrupted(storage).filter((id) => id !== tabId)].slice(0, SEEN_DONE_CAP), storage);
}

/** The list minus every tab that is listed now in a state other than
 * interrupted — it ran again, so the next interruption is news. Pure. */
export function withoutResumed(seen: ReadonlyArray<string>, tabs: ReadonlyArray<{ id: string; agent_status?: string }>): ReadonlyArray<string> {
  const resumed = new Set(tabs.filter((tab) => tab.agent_status !== "interrupted").map((tab) => tab.id));
  return seen.filter((id) => !resumed.has(id));
}

/** Whether a tab's card still wears its state badge: a finished or interrupted
 * one is dropped once this phone has opened it. */
export function showsStatusBadge(seen: SeenDone, interrupted: ReadonlyArray<string>, tab: { id: string; agent_status?: string; done_at?: number }): boolean {
  if (tab.agent_status === "done") return isUnseenDone(seen, tab);
  if (tab.agent_status === "interrupted") return !interrupted.includes(tab.id);
  return true;
}
