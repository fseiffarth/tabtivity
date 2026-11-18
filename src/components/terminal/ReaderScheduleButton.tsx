import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useTabSchedule } from "../../lib/agents/useTabSchedule";
import type { TabEntry } from "../../stores/tabs";
import { AgentScheduleDialog } from "../agents/AgentScheduleDialog";
import { UntestedTag } from "../common/UntestedTag";
import { ClockIcon } from "../common/icons/Icon";

/** The Chat's top bar entry for the tab's scheduled prompts: the same dialog
 * as the tab menu's "Schedule prompt…", with the enabled count and the next
 * run on the button. */
export function ReaderScheduleButton({ scope, tab }: { scope: string; tab: TabEntry }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const schedule = useTabSchedule(scope, tab.scheduleTargetId, true);
  const title = schedule.count === 0
    ? t("terminal.reader.scheduleHint")
    : schedule.next
      ? t("agentSchedule.indicatorNext", { count: schedule.count, value: schedule.next.toLocaleString() })
      : t("agentSchedule.indicator", { count: schedule.count });
  return (
    <>
      <button
        type="button"
        className={schedule.count > 0 ? "prompt-strip-reader reader-schedule active" : "prompt-strip-reader reader-schedule"}
        onClick={() => setOpen(true)}
        onMouseEnter={schedule.refreshNext}
        title={title}
        aria-haspopup="dialog"
      >
        <ClockIcon />
        {t("terminal.reader.schedule")}
        {schedule.count > 0 && <span className="reader-schedule-count">{schedule.count}</span>}
        <UntestedTag id="terminal.reader.schedule" />
      </button>
      {open && <AgentScheduleDialog scope={scope} tab={tab} onClose={() => setOpen(false)} />}
    </>
  );
}
