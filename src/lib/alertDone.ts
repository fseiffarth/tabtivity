import type { AlertItem } from "./alerts";
import { boardColumns, toggleTaskDone } from "./todoBoard";
import { useCalendarStore } from "../stores/calendar/calendar";
import { useMailStore } from "../stores/mail";
import { useTodoStore } from "../stores/todo";

/**
 * **What the Alerts strip's ✓ does**, in one place, because two surfaces now
 * press it: the side panel's group (`files/AlertsSection`) and Tabtivity Mobile's
 * own Alerts rows, which reach it through the desktop bridge
 * (`mobile/MobileBridgeHost`). A second copy on the phone side would be a
 * second answer to "what does Done mean for a meeting", and the two would drift
 * — the same reason `ProjectFilesView` is shared rather than mirrored.
 *
 * It is deliberately *not* in `lib/alerts`: that module is a read and nothing
 * else ("A read, never a write"), and the whole point of this one is the write.
 *
 * **Each kind is resolved on its own terms, and none of them deletes anything.**
 *
 * - A **card** is completed through `toggleTaskDone`, so it also lands in the
 *   board's configured Done column — ticking it here and ticking it on the
 *   board are the same act.
 * - **Mail** has its priority mark cleared. That is a purely local mark
 *   (`mail_priority_set` never touches the network), so Done means "this is no
 *   longer one of the things shouting at me", not "this mail was handled" and
 *   certainly not read, archived or deleted. `stores/todo` holds the cached
 *   priority list, so it is re-read afterwards or the row survives its own
 *   dismissal.
 * - An **event** has no completion state — an appointment is not a task — so
 *   Done is the strip's persisted mute, which takes the row out of the feed and
 *   leaves the appointment in the calendar untouched. Deleting the meeting
 *   because its reminder was acknowledged would be the worst possible reading
 *   of a ✓.
 *
 * `mute` is passed in rather than reached for, because the muted list is
 * `useAlertsFeed`'s to write (it is a `settings.json` key with a bound and an
 * idempotent adder) and both callers already hold that feed.
 *
 * Throws on a row it cannot resolve — a missing id, a card that has left the
 * store — so the caller reports a failure instead of showing a ✓ that did
 * nothing.
 */
export async function finishAlert(
  item: AlertItem,
  mute: (id: string) => void,
): Promise<void> {
  if (item.kind === "mail") {
    if (!item.source.mailId) throw new Error("Missing mail id");
    await useMailStore.getState().setPriority(item.source.mailId, null);
    await useTodoStore.getState().loadUrgentMail();
    return;
  }
  if (item.kind === "event") {
    mute(item.id);
    return;
  }
  if (!item.source.taskId) throw new Error("Missing task id");
  const calendar = useCalendarStore.getState();
  const task = calendar.tasks.find((row) => row.id === item.source.taskId);
  if (!task) throw new Error("Missing task");
  await calendar.updateTask(toggleTaskDone(task, boardColumns(calendar.taskColumns)));
}
