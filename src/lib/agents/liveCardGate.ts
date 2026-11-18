import { agentFamily } from "../../../shared/agentComposer";
import { agentDeliveryTurn, useActivityStore } from "../../stores/activity";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { mergeAskedQuestion, type LiveDialog } from "../../../mobile-web/src/terminal/askedQuestion";
import type { ReaderLive } from "./readerLive";

/**
 * Whether the hooks of a Claude tab rule out a question card: the tab's hooks
 * have spoken (`agentDeliveryTurn`) and its lamp does not say `decision`.
 *
 * Whether an agent is asking comes from its hooks; the screen only says what.
 * `readReaderLive` is pure and reads any tail as a dialog if it fits the shape
 * (`dialogOnScreen`, `steeringAnswer` and the capture replay call it too), so
 * the gate is on the callers that show or answer a card. A tab whose hooks have
 * not spoken (a restored session, a remote run, a first-run screen) has no lamp
 * to go by and keeps the screen's reading.
 *
 * `asking` is the lamp (`attentionByTab[ptyId] === "decision"`), passed in so a
 * component can subscribe to it.
 */
export function hookLampHidesCard(ptyId: string, agentLabel: string, asking: boolean): boolean {
  return !asking && agentFamily(agentLabel) === "claude" && agentDeliveryTurn(ptyId) !== undefined;
}

/** {@link hookLampHidesCard} on the store as it is now. */
export function lampHidesCardNow(ptyId: string, agentLabel: string): boolean {
  return hookLampHidesCard(ptyId, agentLabel, useActivityStore.getState().attentionByTab[ptyId] === "decision");
}

/**
 * `live` with its dialog taken off the card. A dialog the lamp does not
 * announce may still be real (one the user opened with a slash command), so the
 * screen is reported as one the chat cannot draw (`stray`), whose rows it shows
 * and points at the terminal for — not dropped silently.
 */
export function withoutCard(live: ReaderLive): ReaderLive {
  if (!live.question) return live;
  return {
    ...live,
    question: null,
    ask: [],
    context: [],
    tabs: [],
    tabFocus: null,
    tabSubmit: false,
    signature: "",
    stray: true,
    screen: [...live.ask, ...live.context, ...live.question.options.map((option) => option.label)],
  };
}

/**
 * `live` with the transcript's waiting question laid over it
 * (`mergeAskedQuestion`): the entry's words and previews on the screen's rows
 * when both are there, a read-only card from the entry alone while the screen
 * has not drawn the dialog yet. `live` as it is when the screen shows a
 * dialog that is not this question (a permission prompt), or no entry waits.
 *
 * The entry alone stands only while the lamp says the agent asks (`asking`):
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
