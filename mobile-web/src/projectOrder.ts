import { translate, useI18nStore, type TranslationKey } from "../../src/lib/i18n";

/**
 * The home list's hand-arranged project order.
 *
 * Unlike a tab order, this one is the phone's alone: it is kept in
 * `localStorage` (`prefs.ts`) and never crosses the bridge, so arranging the
 * list needs no desktop and leaves the Tabtivity window's own project pills where
 * their owner put them. The two surfaces are read for different things — the
 * desktop pills are a switcher the whole day's work runs through, the phone list
 * is a handful of rows reached with one thumb.
 *
 * The host still sorts what it sends (live sessions, then last activity, then
 * name), and that stays the fallback: a project the reader has never placed
 * keeps the host's order rather than being dropped somewhere arbitrary.
 */
import { applyServerOrder } from "./tabReorder";

/** Sort the listed rows into the remembered order. Placed projects lead, in the
 * order they were arranged; everything else keeps the order the host sent and
 * follows — which is also where a project that has only just become active
 * arrives, rather than in the middle of a list the reader arranged by hand.
 *
 * This is the same ranking surgery the tab list reconciles with (`ids` there
 * come from the desktop, here from this phone's store), so it is that function
 * rather than a second one that disagrees with it in some corner. */
export function arrangeProjects<T>(rows: readonly T[], idOf: (row: T) => string, remembered: readonly string[]): T[] {
  return applyServerOrder(rows, idOf, remembered);
}

/**
 * Fold the order the finger just made into the one that is stored.
 *
 * `listed` is every project currently on screen, in its new order; `stored` can
 * also name projects that are not listed right now — one whose sessions have
 * all ended, so the active list no longer carries it. Those keep their place
 * around the block of listed rows instead of being dropped (the reader arranged
 * them once and that project will be back) and instead of being appended after
 * it (which would quietly demote every project that happened to be idle at the
 * moment of an unrelated drag). The listed block goes where its first member
 * already sat, which is what makes a single drag a local edit.
 */
export function mergeProjectOrder(stored: readonly string[], listed: readonly string[]): string[] {
  const inList = new Set(listed);
  const merged: string[] = [];
  let placed = false;
  for (const id of stored) {
    if (inList.has(id)) {
      if (!placed) {
        merged.push(...listed);
        placed = true;
      }
      continue;
    }
    merged.push(id);
  }
  // Nothing on screen had been placed before — the first drag on this phone, or
  // a list of projects none of the stored ids names. The arranged rows lead:
  // they are the ones being looked at.
  if (!placed) merged.unshift(...listed);
  return merged;
}

/** The small line under a row's name: what kind of scope it is. A box and the
 * root console are not projects and have no status of their own; root also
 * says how many of its agents' proposals wait — a count only, because deciding
 * them is the desktop's alone. */
export function scopeCaption(row: { kind?: "project" | "box" | "root"; status: string; pending_reviews?: number }): string {
  const lang = useI18nStore.getState().lang;
  if (row.kind === "box") return `⬡ ${translate(lang, "mobile.home.scopeBox")}`;
  if (row.kind !== "root") {
    // The catalog's status is a protocol word; the two it sends are worded
    // here, and anything newer reads as itself rather than as nothing.
    const status = STATUS_KEYS[row.status];
    return status ? translate(lang, status) : row.status;
  }
  const waiting = row.pending_reviews ?? 0;
  const root = `★ ${translate(lang, "mobile.home.scopeRoot")}`;
  return waiting > 0 ? `${root} · ${translate(lang, "mobile.home.awaitingApproval", { count: waiting })}` : root;
}

const STATUS_KEYS: Record<string, TranslationKey | undefined> = {
  active: "mobile.home.statusActive",
  inactive: "mobile.home.statusInactive",
};
