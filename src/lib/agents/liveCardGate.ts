import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { mergeAskedQuestion, type LiveDialog } from "../../../mobile-web/src/terminal/askedQuestion";
import type { ReaderLive } from "./readerLive";

/**
 * `live` with the transcript's waiting question laid over it
 * (`mergeAskedQuestion`): the entry's words and previews on the screen's rows
 * when both are there, a read-only card from the entry alone while the screen
 * has not drawn the dialog yet. `live` as it is when the screen shows a
 * dialog that is not this question (a permission prompt), or no entry waits.
 *
 * The entry alone stands only while the lamp says the agent asks (`asking`;
 * the one place the lamp gates a card — a screen-read dialog is never ruled
 * out by it, so a picker the user opened or the next page of a dialog whose
 * lamp a phone answer dropped stays answerable):
 * a call with no result in a dead or resumed session keeps its `blocking`
 * entry for good, and a card must not outlive the dialog. Nothing sent
 * (`answerKeys`, `tabStepKeys`) reads the entry: the rows keep the screen's
 * `index`/`number` and the dialog its `current`.
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
    question: card.question,
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
