import { useState } from "react";
import { UntestedTag } from "../common/UntestedTag";
import { useCalDavStore } from "../../stores/calendar/caldav";
import { useT } from "../../lib/i18n";
import { ErrorNote } from "../common/ErrorNote";

/**
 * "Someone else changed this too" — the answer to a CalDAV `412`
 * (`docs/caldav_plan.md` Phase 3).
 *
 * Mounted once at the shell, beside `CalDavSyncHost`, and for the same reason:
 * the edit that conflicts can be made from the calendar tab, the calendar
 * overlay, the to-do board or the header's day list, and the surface that would
 * otherwise carry the message is whichever of those the user has already closed.
 *
 * ## Why this exists at all
 *
 * A conflict means the resource changed on the server since this machine last
 * read it — from a phone, a web UI, a colleague's client. Both versions are real
 * edits and neither is obviously right, so the one thing that must not happen is
 * for the app to pick. The plan quotes mail encryption's rule for this, and it is
 * exactly the rule: *a silent downgrade is the single worst thing a sync feature
 * can do, because it looks exactly like success.*
 *
 * ## The three answers, and what each actually does
 *
 * - **Keep mine** re-reads the server's current ETag and writes against *that*.
 *   It is an overwrite, and it says so — but it is still a conditional one, so a
 *   third edit landing between this question and its answer conflicts again
 *   rather than being destroyed by the resolution of an older conflict.
 * - **Use the server's** forces a sync of the collection. That is what actually
 *   puts the server's version into `calendar.json`, through the same merge every
 *   other sync goes through, rather than through a special path that would have
 *   to re-derive what the merge already knows.
 * - **Decide later** drops the question and keeps the local edit. The row stays
 *   marked as an unpushed edit (gap 32): no sync this session pushes it or
 *   overwrites it, and the next edit to it — or the next run — asks again.
 *
 * A question can also come from a **sync** rather than a push: the merge keeps
 * a row whose unpushed edit the server changed too, or whose resource the
 * server deleted (`serverDeleted` — the row is local-only then; keeping it
 * puts it back on the server, taking the server's deletes it here too).
 *
 * There is deliberately **no "merge"** option. Two versions of an appointment
 * differ in fields whose combination nobody can be assumed to want — half of one
 * time and half of another is not a third valid meeting — and offering a merge
 * would mean inventing an edit the user never made.
 */
export function CalDavConflictDialog() {
  const t = useT();
  const conflicts = useCalDavStore((s) => s.conflicts);
  const pushError = useCalDavStore((s) => s.pushError);
  const keepMine = useCalDavStore((s) => s.resolveKeepMine);
  const takeServer = useCalDavStore((s) => s.resolveTakeServer);
  const defer = useCalDavStore((s) => s.deferConflict);
  const [busy, setBusy] = useState("");

  // One question at a time, oldest first. A stack of modals over one another is
  // unanswerable, and each answer may change the next (taking the server's copy
  // re-syncs the whole collection, which can resolve a sibling conflict on its
  // own).
  const conflict = conflicts[0];
  if (!conflict) return null;

  const run = async (fn: () => Promise<void>, tag: string) => {
    setBusy(tag);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };

  return (
    // No backdrop dismiss: clicking past this leaves an edit in a state the user
    // has not been told about, which is the thing the dialog exists to prevent.
    // "Decide later" is a button, so the way out is a decision to defer.
    <div className="modal-backdrop">
      <div className="project-dialog caldav-conflict-dialog">
        <h2 className="caldav-conflict-title">
          {t("caldavConflict.title")} <UntestedTag id="caldavConflict.title" />
        </h2>

        <p className="caldav-conflict-lede">
          {conflict.op === "delete"
            ? t("caldavConflict.ledeDelete", { title: conflict.title })
            : conflict.serverDeleted
              ? t("caldavConflict.ledeServerDeleted", { title: conflict.title })
              : t("caldavConflict.ledeEdit", { title: conflict.title })}
          {conflict.serverDeleted && (
            <>
              {" "}
              <UntestedTag id="caldavConflict.serverDeleted" />
            </>
          )}
        </p>
        <p className="caldav-conflict-detail">{t("caldavConflict.explain")}</p>

        {pushError && <ErrorNote className="caldav-conflict-error" error={pushError} />}

        <div className="caldav-conflict-actions">
          <button
            type="button"
            className="cal-btn"
            disabled={busy !== ""}
            onClick={() => void run(() => keepMine(conflict), "mine")}
            title={t("caldavConflict.keepMineHint")}
          >
            {busy === "mine" ? t("caldavConflict.working") : t("caldavConflict.keepMine")}
          </button>
          <button
            type="button"
            className="cal-btn"
            disabled={busy !== ""}
            onClick={() => void run(() => takeServer(conflict), "server")}
            title={t("caldavConflict.takeServerHint")}
          >
            {busy === "server" ? t("caldavConflict.working") : t("caldavConflict.takeServer")}
          </button>
          <button
            type="button"
            className="cal-btn cal-btn-ghost"
            disabled={busy !== ""}
            onClick={() => defer(conflict.rowId)}
            title={t("caldavConflict.laterHint")}
          >
            {t("caldavConflict.later")}
          </button>
        </div>

        {conflicts.length > 1 && (
          <div className="caldav-conflict-more">
            {t("caldavConflict.more", { count: conflicts.length - 1 })}
          </div>
        )}
      </div>
    </div>
  );
}
