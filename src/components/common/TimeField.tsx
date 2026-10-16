import { useUse24h } from "../../lib/timeFormat";
import { TimeFieldCore, type TimeFieldCoreProps } from "./TimeFieldCore";

/**
 * The desktop's clock-entry field: `TimeFieldCore` (where the field and the why
 * of it live) showing the face `Settings.time_format_24h` chose — the same
 * answer every clock Tabtivity prints follows, so a card due at 17:00 reads
 * `17:00` on the board and in the field that edits it.
 */
export function TimeField(props: Omit<TimeFieldCoreProps, "use24h">) {
  return <TimeFieldCore {...props} use24h={useUse24h()} />;
}
