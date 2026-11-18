import { agentFamily } from "../../../shared/agentComposer";
import { agentDeliveryTurn, useActivityStore } from "../../stores/activity";
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
