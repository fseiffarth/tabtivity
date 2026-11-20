// Per-scope (per-project) tab visit order, most recent first. `writeScope`
// notes the focused group's active tab on every write, so every way a tab is
// shown (click, keyboard, reveal, open, focus a subwindow) counts as a visit.
// Removing a tab from a group — close, move, detach — repicks that group's
// active tab from here, and a vanished focused subwindow hands focus to the
// group of the most recently visited tab left, instead of the left neighbour
// or the first group. Memory only: keys are minted per session.

const MAX_VISITS = 64;

const visitsByScope = new Map<string, string[]>();

/** Record `key` as the scope's most recently visited tab. */
export function noteTabVisit(scope: string, key: string): void {
  const cur = visitsByScope.get(scope);
  if (cur?.[0] === key) return;
  const next = [key, ...(cur ?? []).filter((k) => k !== key)];
  if (next.length > MAX_VISITS) next.length = MAX_VISITS;
  visitsByScope.set(scope, next);
}

/** Drop a closed tab from its scope's order. */
export function forgetTabVisit(scope: string, key: string): void {
  const cur = visitsByScope.get(scope);
  if (!cur || !cur.includes(key)) return;
  visitsByScope.set(scope, cur.filter((k) => k !== key));
}

/** The most recently visited of `candidates`, or null when none was visited. */
export function lastVisitedOf(scope: string, candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const cur = visitsByScope.get(scope);
  if (!cur) return null;
  const want = new Set(candidates);
  return cur.find((k) => want.has(k)) ?? null;
}

/** The active tab a group falls back to once its active tab left it: the most
 *  recently visited of what remains, else the neighbour at the left slot. */
export function repickActive(
  scope: string,
  tabKeys: readonly string[],
  removedIndex: number,
): string | null {
  return (
    lastVisitedOf(scope, tabKeys) ??
    tabKeys[Math.min(Math.max(removedIndex, 0), tabKeys.length - 1)] ??
    null
  );
}

/** Tests only. */
export function resetTabVisits(): void {
  visitsByScope.clear();
}
