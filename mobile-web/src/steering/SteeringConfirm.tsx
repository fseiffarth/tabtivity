import { useSyncExternalStore } from "react";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { useT } from "../../../src/lib/i18n";
import { rowAct } from "./steeringDom";
import { getSteering, setConfirm, subscribe } from "./steeringState";

/**
 * The close confirm the W key asks for. The phone closes a tab with one tap and
 * no confirm, but a single letter is easy to hit, so keyboard steering asks
 * first: the shared confirm sheet, driven by `steeringState.confirm`. Y or Enter
 * presses its one option, which looks the card up by its row id at that moment
 * (it may be gone by then) and presses the card's own close button, so the
 * screen closes it exactly as a tap would. Mounted in the tabbed branch's
 * `BackNest`, beside the screen, so its back layer sits on top of the screen's.
 */
export function SteeringConfirm() {
  const t = useT();
  // Only the confirm, so a flash or an activity refresh does not render the sheet.
  const confirm = useSyncExternalStore(subscribe, () => getSteering().confirm, () => null);
  if (!confirm) return null;
  return <ConfirmSheet
    confirm={{
      title: t("mobile.steering.closeConfirm.title", { label: confirm.label }),
      label: t("mobile.steering.closeConfirm.action"),
      // The screen behind the sheet is inert by now, which only blocks a user.
      run: () => { rowAct(confirm.tabId, "close", true); },
    }}
    busy={false}
    onClose={() => setConfirm(null)}
  />;
}
