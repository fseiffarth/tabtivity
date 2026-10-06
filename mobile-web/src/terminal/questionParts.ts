import { dedentLines, joinProseWraps, type ReadableLine } from "./readableScreen";
import {
  codexQuestionProgress,
  questionTabFocus,
  questionTabRowKeys,
  questionTabsSubmit,
  readQuestionTabs,
  type QuestionStepKeys,
  type QuestionTab,
  type SelectPrompt,
} from "./selectPrompt";

/** A question on screen, split the way a reader shows it in place of the
 * rows (`readSelectPrompt`): the phone's Focus and the desktop Reader. */
export interface QuestionParts {
  /** The dialog's own question — the block right above its rows, dedented
   * and with the TUI's word wrap undone: the list's heading. */
  ask: ReadableLine[];
  /** The screen the dialog was drawn onto — a permission prompt's file or
   * diff, kept as drawn; an agent's own question's message, as prose. */
  context: ReadableLine[];
  /** The question headers of an agent's own question (`readQuestionTabs`),
   * lifted off the screen; for Codex, which draws none, `Q1`…`Qn` read off
   * its `Question 2/3` heading. Empty for any other dialog. */
  tabs: QuestionTab[];
  /** The step of `tabs` on screen (`questionTabFocus`): an index into `tabs`,
   * `tabs.length` for the Submit step, null when the row does not say. */
  tabFocus: number | null;
  /** Whether the row ends in a Submit step (`questionTabsSubmit`). */
  tabSubmit: boolean;
  /** Which keys walk the steps (`questionTabKeys`). */
  tabKeys: QuestionStepKeys;
}

export const NO_QUESTION_PARTS: QuestionParts = { ask: [], context: [], tabs: [], tabFocus: null, tabSubmit: false, tabKeys: "arrows" };

/** A range of read lines without the blank rows at its ends — the gutter a
 * dialog leaves around its own text, which is a paragraph break only when
 * there is something on both sides of it. */
function withoutEdgeBlanks(lines: readonly ReadableLine[]): ReadableLine[] {
  let first = 0;
  let end = lines.length;
  while (first < end && lines[first].text === "") first += 1;
  while (end > first && lines[end - 1].text === "") end -= 1;
  return lines.slice(first, end);
}

/**
 * Splits `tail` (the lines `question` was read from) into what a reader shows
 * around its list. Between the question and the screen above it Claude Code
 * draws a tab row over a question an agent asks; it is the question's label,
 * so it is lifted off as `tabs`. Such a question and the agent's prose above
 * it are rejoined into paragraphs (`joinProseWraps`) — any other dialog's
 * screen, a diff or a command, stays as drawn.
 */
export function questionParts(tail: readonly ReadableLine[], question: SelectPrompt): QuestionParts {
  let ask = withoutEdgeBlanks(tail.slice(question.question, question.start));
  let context = withoutEdgeBlanks(tail.slice(question.context, question.question));
  let row = ask.length > 1 ? ask[0] : undefined;
  let tabs = row ? readQuestionTabs(row.text) : null;
  if (tabs) {
    ask = withoutEdgeBlanks(ask.slice(1));
  } else if (context.length > 0) {
    row = context[context.length - 1];
    tabs = readQuestionTabs(row.text);
    if (tabs) context = withoutEdgeBlanks(context.slice(0, -1));
  }
  if (!tabs) {
    // Codex asks several questions one page at a time, under a heading that
    // counts them; it has no Submit step — Enter on the last one sends all.
    const progress = codexQuestionProgress(question.title);
    if (progress && progress.count > 1) {
      return {
        ask, context,
        tabs: Array.from({ length: progress.count }, (_, index) => ({ label: `Q${index + 1}`, answered: false })),
        tabFocus: progress.focus,
        tabSubmit: false,
        tabKeys: "pages",
      };
    }
  }
  return {
    ask: joinProseWraps(dedentLines(ask)),
    context: tabs ? joinProseWraps(context) : context,
    tabs: tabs ?? [],
    tabFocus: tabs && row ? questionTabFocus(row.spans, tabs) : null,
    tabSubmit: !!tabs && !!row && questionTabsSubmit(row.text),
    tabKeys: tabs && row ? questionTabRowKeys(row.text) : "arrows",
  };
}
