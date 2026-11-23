import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { mergeAskedQuestion, type LiveDialog } from "../../../mobile-web/src/terminal/askedQuestion";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import type { ReaderLive } from "./readerLive";

/**
 * `live` with the transcript's waiting question laid over it
 * (`mergeAskedQuestion`): the entry's words and previews on the screen's rows
 * when both are there, a card from the entry alone while the screen shows no
 * dialog: read-only, but a one-question single-choice ask answers by number
 * (`answerableByNumber`). `live` as it is when the screen shows a
 * dialog that is not this question (a permission prompt), or no entry waits.
 *
 * The entry alone stands only while the lamp says the agent asks (`asking`;
 * the one place the lamp gates a card — a screen-read dialog is never ruled
 * out by it, so a picker the user opened or the next page of a dialog whose
 * lamp a phone answer dropped stays answerable):
 * a call with no result in a dead or resumed session keeps its `blocking`
 * entry for good, and a card must not outlive the dialog. On a merged card
 * nothing sent (`answerKeys`, `tabStepKeys`) reads the entry: the rows keep
 * the screen's `index`/`number` and the dialog its `current`.
 */
export function withWaitingEntry(live: ReaderLive, entry: TranscriptEntry | null, asking: boolean): ReaderLive {
  if (!entry) return live;
  const dialog: LiveDialog | null = live.question
    ? { question: live.question, ask: live.ask, context: live.context, tabs: live.tabs, tabFocus: live.tabFocus, tabSubmit: live.tabSubmit, tabKeys: live.tabKeys }
    : null;
  const card = mergeAskedQuestion(entry, dialog, asking);
  if (!card) return live;
  if (card.kind === "merged") return { ...live, question: card.question, ask: card.ask };
  return {
    ...live,
    question: answerableByNumber(entry, card.question) ?? card.question,
    ask: card.ask,
    context: [],
    tabs: card.tabs,
    tabFocus: card.tabFocus,
    tabSubmit: card.tabSubmit,
    tabKeys: card.tabKeys,
    signature: card.signature,
    // The Reader does not point at the terminal for a dialog it is about to draw.
    stray: false,
    screen: [],
  };
}

/**
 * The entry-only card of a one-question, single-choice ask, made answerable:
 * each row sends its number. Claude Code's question dialog takes a row's digit
 * as the answer and, with one question, sends it (verified on 2.1.330), and
 * the dialog is up before the transcript holds the call (screen, then hook,
 * then transcript), so under an asking lamp the digit lands in it. The screen
 * reading can miss a dialog the terminal shows (the user's Chat-only report,
 * 2026-11-23, not reproduced), and the card would stay grey until the user
 * switched to the terminal. Not for several questions or a multi-select: their
 * later pages and ticks need the screen.
 */
function answerableByNumber(entry: TranscriptEntry, question: SelectPrompt): SelectPrompt | null {
  const asked = entry.questions ?? [];
  if (asked.length !== 1 || asked[0].multiSelect === true) return null;
  if (question.options.length === 0 || question.options.length > 9) return null;
  const { readOnly: _readOnly, ...rest } = question;
  return {
    ...rest,
    byNumber: true,
    options: question.options.map((option) => ({ ...option, keys: [String(option.number)] })),
  };
}
