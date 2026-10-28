/**
 * How often a hint the user has already read comes back — shared by the
 * desktop's hint bubbles (`stores/hints`) and the phone's tip cards
 * (`mobile-web/src/components/HintMessage`). Every press of a hint's Read
 * button halves its chance of showing again: unread it always shows, read once
 * one sitting in two, read twice one in four. Settings' reset brings every hint
 * back at full chance. Import-free so the phone bundle can take it.
 */
export function hintChance(reads: number): number {
  return reads > 0 ? 0.5 ** reads : 1;
}

/** One draw against `hintChance`, made once per hint per sitting by the caller
 *  so a hint that lost its draw does not win it five seconds later. */
export function rollHint(reads: number, random: () => number = Math.random): boolean {
  return reads <= 0 || random() < hintChance(reads);
}
