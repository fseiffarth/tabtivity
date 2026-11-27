import { agentFamily } from "../../../shared/agentComposer";
import { agentDeliveryTurn, lastUserInputAt, useActivityStore } from "../../stores/activity";

/**
 * A Claude still starting takes typed words into its composer a while before
 * its Enter submits them (probed 2026-10-18/19 on 2.1.299 and 2.1.300 with a
 * full agent home: typed as the pane first went quiet, the words sat unsent in
 * most tries on either; two seconds later the same writes went). A prompt typed
 * into a tab no turn has begun in yet — the phone markup's new-tab Submit, a
 * tab's opening prompt — lands in exactly that window, so its submit is
 * checked on the hooks: with no turn begun this long after it, Enter goes
 * again. On an empty composer, or one already working, Enter does nothing, so
 * a late hook costs nothing.
 */
export const FRESH_SUBMIT_CHECK_MS = 2_500;
export const FRESH_SUBMIT_TRIES = 3;

/** The CLIs that drop a fresh tab's first Enter and report a turn begun.
 * OpenCode's `mini` keeps the words in its box and drops the Enter for a
 * second or two after drawing it — longer on a loaded machine (2.4.1 and
 * 2.4.2, probed 2026-11-26); its session plugin writes the turn. An Enter on
 * its empty box does nothing, busy or idle. */
const DROPS_FRESH_ENTER = new Set(["claude", "opencode"]);

/** Whether `agent` drops a fresh tab's first Enter and no turn has begun in it yet. */
export function freshStart(agent: string | undefined, ptyId: string): boolean {
  return dropsFreshEnter(agent) && agentDeliveryTurn(ptyId) === undefined;
}

export function dropsFreshEnter(agent: string | undefined): boolean {
  return DROPS_FRESH_ENTER.has(agentFamily(agent ?? ""));
}

/**
 * Press Enter again (`press`) until a hook turn begun at or after `since`
 * shows the prompt went, at most {@link FRESH_SUBMIT_TRIES} times. Stops when
 * `stillOurs` says the tab moved on, a question came up an Enter would answer,
 * or the user typed into the tab — their words are theirs to send.
 */
export async function confirmFreshSubmit(
  ptyId: string,
  since: number,
  press: () => Promise<boolean>,
  stillOurs: () => boolean = () => true,
): Promise<void> {
  const typedAt = lastUserInputAt(ptyId);
  for (let attempt = 0; attempt < FRESH_SUBMIT_TRIES; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, FRESH_SUBMIT_CHECK_MS));
    if ((agentDeliveryTurn(ptyId)?.startedAt ?? 0) >= since) return;
    if (!stillOurs() || lastUserInputAt(ptyId) !== typedAt) return;
    if (useActivityStore.getState().attentionByTab[ptyId] === "decision") return;
    if (!(await press().catch(() => false))) return;
  }
}
