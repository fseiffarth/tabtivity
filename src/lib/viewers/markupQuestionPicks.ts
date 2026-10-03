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

/** Whether one tap answers the whole ask: a single question, single-select —
 * the card then sends on the tap, as the Focus list does. */
export function answersOnTap(questions: readonly MarkupQuestion[]): boolean {
  return questions.length === 1 && !questions[0].multiSelect;
}
