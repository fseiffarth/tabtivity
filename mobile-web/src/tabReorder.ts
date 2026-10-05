/**
 * The geometry and the list surgery behind the project screen's manual tab
 * order — the phone's half of the desktop Agents view's drag reorder.
 *
 * Kept out of the screen because both halves are worth testing without a
 * finger: where a drop lands is arithmetic on the rows' rectangles, and what
 * the list then looks like is one splice that must agree with the desktop's
 * (`stores/tabs.ts` → `reorderTabInScope`), which performs the same move on the
 * layout the phone is asking it to permute.
 */
import type { TabPlace } from "./api";

/** One listed row's extent, as `getBoundingClientRect` gives it; `left` and
 * `right` only matter where the cards stand side by side. */
export interface RowBox {
  id: string;
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}

/** Which row the finger is over and which side of its midline — the slot the
 * dragged row would land in. Above the first row and below the last both clamp
 * to that end, so a drop in the screen's padding still lands somewhere.
 * `null` when the finger is over the dragged row itself: either side of it is
 * where it already is.
 *
 * Where the cards stand two to a line (a wide screen's grid, read left to
 * right, then down), the line is found by height and the card in it by
 * `clientX`, and "before" is its left half rather than its top. */
export function dropSlot(rows: RowBox[], key: string, clientY: number, clientX = 0): { anchor: string; place: TabPlace } | null {
  if (rows.length === 0) return null;
  const lines: RowBox[][] = [];
  for (const row of rows) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].top - row.top) < 1) line.push(row);
    else lines.push([row]);
  }
  if (!lines.some((line) => line.length > 1)) {
    const hit = rows.find((row) => clientY < row.bottom) ?? rows[rows.length - 1];
    if (hit.id === key) return null;
    return { anchor: hit.id, place: clientY < hit.top + (hit.bottom - hit.top) / 2 ? "before" : "after" };
  }
  const line = lines.find((cards) => clientY < Math.max(...cards.map((card) => card.bottom))) ?? lines[lines.length - 1];
  const hit = line.find((card) => clientX < (card.right ?? 0)) ?? line[line.length - 1];
  if (hit.id === key) return null;
  const left = hit.left ?? 0;
  return { anchor: hit.id, place: clientX < left + ((hit.right ?? left) - left) / 2 ? "before" : "after" };
}

/** Pull one item out and drop it beside the anchor as the anchor sits in the
 * shortened list — the desktop store's `place1`, on the phone's rows. Returns
 * the array unchanged (the same reference) when either id is missing, so a
 * caller can treat that as "nothing moved". */
export function placeBeside<T>(items: readonly T[], idOf: (item: T) => string, key: string, anchor: string, place: TabPlace): T[] {
  const from = items.findIndex((item) => idOf(item) === key);
  const next = [...items];
  if (from < 0) return next;
  const [moved] = next.splice(from, 1);
  const at = next.findIndex((item) => idOf(item) === anchor);
  if (at < 0) return [...items];
  next.splice(place === "before" ? at : at + 1, 0, moved);
  return next;
}

/** Rearrange the rows to the order the desktop answered with. Rows the answer
 * does not mention (a tab opened on the desktop between the drop and the
 * answer) keep their own order and follow at the end rather than vanishing,
 * and an empty answer — a catalog that had not caught up — leaves the list as
 * the finger left it. */
export function applyServerOrder<T>(items: readonly T[], idOf: (item: T) => string, ids: readonly string[]): T[] {
  if (ids.length === 0) return [...items];
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items]
    .map((item, index) => ({ item, index, rank: rank.get(idOf(item)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}
