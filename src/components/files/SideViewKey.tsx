import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { steeringSlotKey, type SteeringKeyMap } from "../../lib/shortcuts/steeringBindings";

/**
 * The key cap on a side panel view tab: the number key (the user's `slotN`
 * binding) that switches to that view, shown while keyboard steering walks the
 * side panel. Subscribes by itself, so the panel's view row re-renders for
 * nothing steering does. `n` is the tab's position, from 0; only the first nine
 * views have a key.
 */
export function SideViewKey({ n }: { n: number }) {
  const inSidePanel = useKeyboardSteeringStore((s) => s.active && s.level === "region" && s.region === "side");
  const bindings = useSettingsStore((s) => s.settings?.steering_keys) as SteeringKeyMap | undefined;
  if (!inSidePanel || n >= 9) return null;
  const key = steeringSlotKey(n + 1, bindings);
  if (!key) return null;
  return (
    <span className="side-view-key steering-cap tok-func" aria-hidden="true">
      <span className="steering-cap-k">{key}</span>
    </span>
  );
}
