/**
 * Steering asks before it closes a tab (W) or clears an agent's conversation
 * (K): one press of a bare key is too easy to land by mistake for either.
 *
 * The question is a dialog (`SteeringConfirmOverlay`), so steering walks it as
 * the overlay region like any other: Esc cancels, Enter presses the button
 * under the cursor (Cancel, to start with), and the Confirm key (Y by default,
 * `steeringBindings`) presses the button marked {@link STEERING_CONFIRM_ATTR}.
 * Once the box is gone steering is back on the level the key was pressed on.
 */
import { closeTabInScope } from "../remote/closeRemoteTab";
import type { TabEntry } from "../../stores/tabs";
import { clearAgentTab, steeringAgentOffer } from "./steeringAgent";

export type SteeringConfirmKind = "closeTab" | "agentClear";

/** What `requestSteeringConfirm` sends: what to do to which tab, and whether a
 *  box answered. */
export interface SteeringConfirmDetail {
  kind: SteeringConfirmKind;
  scope: string;
  tab: TabEntry;
  handled: boolean;
}

/** Window event the `SteeringConfirmOverlay` answers by asking. */
export const STEERING_CONFIRM_EVENT = "app:steering-confirm";

/** Marks the button the Confirm key presses. */
export const STEERING_CONFIRM_ATTR = "data-steering-confirm";

/** Ask before `kind` happens to `tab`; false when there is nothing to ask
 *  (Clear on a tab that is not an agent) or no box is mounted. */
export function requestSteeringConfirm(kind: SteeringConfirmKind, scope: string, tab: TabEntry): boolean {
  if (kind === "agentClear" && !steeringAgentOffer(tab).clear) return false;
  const detail: SteeringConfirmDetail = { kind, scope, tab, handled: false };
  window.dispatchEvent(new CustomEvent<SteeringConfirmDetail>(STEERING_CONFIRM_EVENT, { detail }));
  return detail.handled;
}

/** Do what the box asked about, once it is answered yes. */
export function runSteeringConfirm({ kind, scope, tab }: Omit<SteeringConfirmDetail, "handled">): void {
  if (kind === "closeTab") closeTabInScope(scope, tab.key);
  else void clearAgentTab(scope, tab);
}

/** The confirm button of the box inside `root`, if one is there. */
export function steeringConfirmButton(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${STEERING_CONFIRM_ATTR}]`);
}
