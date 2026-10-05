import { useEffect, useMemo } from "react";

import type { CalendarTask } from "../../types";
import type { MailHeader } from "../../types/mail";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useMailStore } from "../../stores/mail";
import {
  releaseUrgentMailPoll,
  retainUrgentMailPoll,
  useTodoStore,
} from "../../stores/todo";
import { useExperimental } from "../../lib/experimental";
import { selectUrgentMail, taskFromMail } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { MailIcon } from "../common/icons/Icon";

interface Props {
  tasks: CalendarTask[];
  defaultCalendarId: string;
  intakeColumnId: string;
}

/**
 * The urgent-mail rail.
 *
 * It reads mail **without touching the mail store's list state**:
 * `useMailStore.openPriority` replaces `headers` and `selectedPriority`, i.e. it
 * retargets the mail overlay's list, so a rail that used it would move the user's
 * mailbox under them once a minute.
 *
 * The gate is checked **before the invoke**, not around the rendering: opening
 * the mail store creates `~/.local/share/tabtivity/mail/` as a side effect, and a
 * todo board must not materialize a mail database for someone who has the mail
 * client switched off.
 */
export function TodoMailRail({ tasks, defaultCalendarId, intakeColumnId }: Props) {
  const t = useT();
  const mailClient = useExperimental("mail_client");
  const accounts = useMailStore((s) => s.accounts);
  const overlayOpen = useTodoStore((s) => s.overlayOpen);
  const urgent = useTodoStore((s) => s.urgentMail);
  const important = useTodoStore((s) => s.importantMail);
  const error = useTodoStore((s) => s.urgentError);

  useEffect(() => {
    if (!mailClient || !overlayOpen) return;
    // The 60 s re-read (and the re-read on a `mail:new` arrival) is the ONE
    // shared refcounted poll in `stores/todo` — `useAlertsFeed` rides the same
    // one, so the board beside an open side panel costs no second interval.
    retainUrgentMailPoll();
    return releaseUrgentMailPoll;
  }, [mailClient, overlayOpen]);

  const rows = useMemo(
    () => selectUrgentMail(urgent, important, tasks),
    [urgent, important, tasks],
  );

  if (!mailClient) {
    return (
      <section className="todo-rail">
        <h3 className="todo-rail-title">{t("todoMail.title")}</h3>
        <p className="todo-rail-muted">{t("todoMail.disabled")}</p>
      </section>
    );
  }

  const openInMail = async (header: MailHeader) => {
    // Close first: all three overlays are `.modal-backdrop` at the same
    // z-index, so leaving this one up would stack a board over the mailbox.
    useTodoStore.getState().closeOverlay();
    const mail = useMailStore.getState();
    // Awaited in this order on purpose: `openMessage` resolves its header out
    // of the loaded page, so opening before the page lands opens nothing.
    await mail.openPriority(header.priority ?? "urgent").catch(() => {});
    mail.openInbox();
    mail.openMessage(header.id);
  };

  // The card's shape is `lib/todoBoard`'s, shared with the agenda rail's own
  // conversion — one definition of what a converted card *is*, so a board cannot
  // end up holding two kinds of them.
  const makeCard = async (header: MailHeader) => {
    await useCalendarStore
      .getState()
      .createTask(
        taskFromMail(
          header,
          { calendarId: defaultCalendarId, columnId: intakeColumnId, now: new Date() },
          t("mail.noSubject"),
        ),
      )
      .catch((err) => useTodoStore.getState().setError(String(err)));
  };

  return (
    <section className="todo-rail">
      <h3 className="todo-rail-title">
        {t("todoMail.title")}
        <button
          type="button"
          className="todo-rail-refresh"
          title={t("todoMail.refresh")}
          aria-label={t("todoMail.refresh")}
          onClick={() => void useTodoStore.getState().loadUrgentMail()}
        >
          ⟳
        </button>
      </h3>

      {accounts.length === 0 ? (
        <p className="todo-rail-muted">{t("todoMail.noAccounts")}</p>
      ) : error ? (
        <p className="todo-rail-muted">{t("todoMail.failed")}</p>
      ) : rows.length === 0 ? (
        <p className="todo-rail-muted">{t("todoMail.empty")}</p>
      ) : (
        <ul className="todo-rail-list">
          {rows.map((header) => (
            <li key={header.id} className="todo-mail-row">
              <span
                className={
                  "todo-mail-dot" +
                  (header.priority === "urgent" ? " urgent" : " important")
                }
                title={
                  header.priority === "urgent"
                    ? t("todoMail.urgent")
                    : t("todoMail.important")
                }
                aria-hidden
              >
                ●
              </span>
              <span className="todo-mail-text">
                <span className="todo-mail-from">
                  {header.from?.name || header.from?.address || ""}
                </span>
                <span className="todo-mail-subject">
                  {header.subject || t("mail.noSubject")}
                </span>
              </span>
              <span className="todo-mail-actions">
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() => void makeCard(header)}
                  title={t("todoMail.makeTodo")}
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="cal-link-btn"
                  onClick={() => void openInMail(header)}
                  title={t("todoMail.open")}
                >
                  <MailIcon />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
