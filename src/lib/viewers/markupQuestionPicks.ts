/**
 * The markup questions card's pick model, with no imports at all, so the
 * phone's bundle (`mobile-web/src/components/MarkupQuestionsCard.tsx`) shares
 * it with the desktop card (`PdfMarkupQuestions.tsx`) without pulling in the
 * window's `invoke` (`markupQuestions.ts` re-exports everything here).
 *
 * A question has 2–6 options; the card holds, per question, the rows picked
 * and the typed **Other…** text, and turns them into the answers the desktop
 * checks against the ask (`services::markup_mcp::Answer`).
 */

/** The longest typed **Other…** answer (`markup_mcp::MAX_OTHER_CHARS`). */
export const MAX_OTHER = 500;
/** How long a card that just opened for a new ask takes no taps or clicks:
 * the reader may be mid-stroke where it lands, and a pen, finger or click
 * already on its way down must not pick or send for them. */
export const ARRIVAL_GUARD_MS = 1_200;

/** The arrival guard, once for every host and surface: the question card
 * (`arrive` when it opens for a new ask, `settling` while it takes nothing)
 * and the ✓ badges (`see` the keys now shown — a key gone from the list is
 * forgotten, a new one stamps `now`, so a badge that went and comes back, or
 * a group that grew, arrives anew; `settlingFor` the keys a click would
 * approve, or `null` for Approve all: the newest arrival of any). A key never
 * seen counts as settling. Time is passed in, so the caller owns the clock. */
export type ArrivalGuard<K> = {
  arrive: (now: number) => void;
  settling: (now: number) => boolean;
  see: (keys: Iterable<K>, now: number) => void;
  settlingFor: (keys: Iterable<K> | null, now: number) => boolean;
};

export function arrivalGuard<K = never>(): ArrivalGuard<K> {
  let newest = Number.NEGATIVE_INFINITY;
  let seen = new Map<K, number>();
  const settling = (now: number) => now - newest < ARRIVAL_GUARD_MS;
  return {
    arrive: (now) => { newest = now; },
    settling,
    see: (keys, now) => {
      const next = new Map<K, number>();
      for (const key of keys) {
        const was = seen.get(key);
        next.set(key, was ?? now);
        if (was === undefined) newest = now;
      }
      seen = next;
    },
    settlingFor: (keys, now) => {
      if (keys === null) return settling(now);
      let last = Number.NEGATIVE_INFINITY;
      for (const key of keys) {
        const at = seen.get(key);
        if (at === undefined) return true;
        last = Math.max(last, at);
      }
      return now - last < ARRIVAL_GUARD_MS;
    },
  };
}

export type MarkupChoice = { label: string; description?: string };
export type MarkupQuestion = {
  question: string;
  header?: string;
  options: MarkupChoice[];
  multiSelect: boolean;
  /** 1-based. */
  page?: number;
  /** Words on that page the question is about. */
  quote?: string;
};
/** One question's answer: option indices and/or a typed **Other…**. */
export type MarkupAnswer = { options: number[]; other?: string };

/** The mark Claude Code asks agents to put on the option they would pick,
 * shown as a tag beside the label (the reader's `LiveQuestion` and the phone's
 * `QuestionRows` do the same). */
const RECOMMENDED = /\s+\(Recommended\)$/u;

export function splitRecommended(label: string): { label: string; recommended: boolean } {
  const hit = RECOMMENDED.exec(label);
  return hit ? { label: label.slice(0, hit.index), recommended: true } : { label, recommended: false };
}

/** What the card holds for one question: the rows picked, and the typed
 * **Other…** text (`null` while Other is not chosen). */
export type QuestionPick = { options: number[]; other: string | null };

export const NO_PICK: QuestionPick = { options: [], other: null };

/** A row clicked: single-select takes it alone (dropping Other), multiSelect
 * toggles it. */
export function toggleOption(question: MarkupQuestion, pick: QuestionPick, index: number): QuestionPick {
  if (!question.multiSelect) return { options: [index], other: null };
  const options = pick.options.includes(index)
    ? pick.options.filter((i) => i !== index)
    : [...pick.options, index].sort((a, b) => a - b);
  return { ...pick, options };
}

/** **Other…** clicked: single-select drops the rows, multiSelect keeps them;
 * a second click takes it back. */
export function toggleOther(question: MarkupQuestion, pick: QuestionPick): QuestionPick {
  if (pick.other !== null) return { ...pick, other: null };
  return { options: question.multiSelect ? pick.options : [], other: "" };
}

/** The picks as the desktop takes them — one per question, in order — or
 * `null` while a question has no answer or an Other… is chosen but blank. */
export function answersOf(questions: readonly MarkupQuestion[], picks: readonly QuestionPick[]): MarkupAnswer[] | null {
  const out: MarkupAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const pick = picks[i] ?? NO_PICK;
    const other = pick.other?.trim();
    if (pick.other !== null && !other) return null;
    if (pick.options.length === 0 && !other) return null;
    out.push(other ? { options: pick.options, other } : { options: pick.options });
  }
  return out;
}
