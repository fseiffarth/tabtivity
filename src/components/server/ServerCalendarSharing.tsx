/**
 * Calendar and to-do sharing (hosted plan §6.7, P4c): open one of your
 * calendars — its events, its to-do list, or both — to named users of the
 * server as viewer or editor, take it back, stop sharing; and see the
 * calendars opened to you. Sharing a calendar for the first time moves it
 * into the server's calendar service (asked first); stopping moves it back.
 * A task's mail and file links, the appointment it came from and its
 * project never leave your account.
 *
 * Each call is a `shared_calendar_*` command of your own daemon, which asks
 * the service; the service decides who may see or change what. Shared
 * calendars then appear in the calendar and on the board like your own
 * (`calendar_load` merges them), read-only where you may only read.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { isServerClient } from "../../lib/transport/linkState";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { ConfirmDialog } from "../common/PromptDialogs";
import { SettingsCard } from "../layout/settingsUi";

type Role = "viewer" | "editor" | "owner";

interface Grant {
  events?: Role | null;
  tasks?: Role | null;
}

interface CalInfo {
  id: string;
  owner: string;
  name: string;
  color: string;
  events?: Role | null;
  tasks?: Role | null;
  rev: number;
  members?: Record<string, Grant>;
}

interface Listing {
  me: string;
  list: CalInfo[];
}

const SHARED_PREFIX = "shared:";
const ROLE_CHOICES = ["", "viewer", "editor"] as const;

export function ServerCalendarSharing() {
  const t = useT();
  const calendars = useCalendarStore((s) => s.calendars);
  const [listing, setListing] = useState<Listing | null>(null);
  const [pick, setPick] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { user: string; events: string; tasks: string }>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = () =>
    invoke<Listing>("shared_calendar_list")
      .then(setListing)
      .catch(() => setListing(null));

  useEffect(() => {
    if (!isServerClient()) return;
    void refresh();
    void useCalendarStore.getState().load();
  }, []);

  if (!listing) return null;

  const run = async (job: () => Promise<string | null>) => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus(await job());
      await refresh();
      await useCalendarStore.getState().reload();
    } catch (e) {
      setStatus(t("server.settings.error", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const roleWord = (role?: Role | null) => (role ? t(`server.sharing.role.${role}` as const) : t("server.calendarSharing.closed"));
  const mine = listing.list.filter((c) => c.owner === listing.me);
  const incoming = listing.list.filter((c) => c.owner !== listing.me);
  const shareable = calendars.filter(
    (c) => !c.id.startsWith(SHARED_PREFIX) && c.id !== "default" && !c.readonly && !(c as { caldav_account_id?: string }).caldav_account_id,
  );
  const pickedName = shareable.find((c) => c.id === confirming)?.name ?? "";

  return (
    <>
      <div className="settings-subheader">
        {t("server.calendarSharing.header")} <UntestedTag id="server.calendarSharing" />
      </div>
      <p className="settings-help">{t("server.calendarSharing.help")}</p>
      <div className="settings-link-row">
        <Dropdown
          ariaLabel={t("server.calendarSharing.pick")}
          placeholder={t("server.calendarSharing.pick")}
          value={pick}
          disabled={busy}
          options={shareable.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setPick}
        />
        <button type="button" className="settings-btn sm" disabled={busy || !pick} onClick={() => setConfirming(pick)}>
          {t("server.calendarSharing.share")}
        </button>
      </div>
      {mine.map((cal) => {
        const draft = drafts[cal.id] ?? { user: "", events: "viewer", tasks: "" };
        const members = Object.entries(cal.members ?? {});
        return (
          <SettingsCard key={cal.id}>
            <div className="settings-card-label">{cal.name}</div>
            <p className="settings-help">
              {members.length
                ? members.map(([user, g]) => t("server.calendarSharing.member", { user, events: roleWord(g.events), tasks: roleWord(g.tasks) })).join(" · ")
                : t("server.sharing.noMembers")}
            </p>
            <div className="settings-link-row">
              {members.map(([user]) => (
                <button
                  key={user}
                  type="button"
                  className="settings-btn sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await invoke("shared_calendar_revoke", { id: cal.id, user });
                      return t("server.sharing.done");
                    })
                  }
                >
                  {t("server.sharing.revoke", { user })}
                </button>
              ))}
            </div>
            <div className="settings-link-row">
              <input
                className="ollama-pull-input"
                aria-label={t("server.sharing.userPlaceholder")}
                placeholder={t("server.sharing.userPlaceholder")}
                value={draft.user}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDrafts((d) => ({ ...d, [cal.id]: { ...draft, user: e.target.value.trim() } }))}
              />
              <Dropdown
                ariaLabel={t("server.calendarSharing.events")}
                value={draft.events}
                disabled={busy}
                options={ROLE_CHOICES.map((r) => ({ value: r, label: `${t("server.calendarSharing.events")}: ${roleWord(r || null)}` }))}
                onChange={(events) => setDrafts((d) => ({ ...d, [cal.id]: { ...draft, events } }))}
              />
              <Dropdown
                ariaLabel={t("server.calendarSharing.tasks")}
                value={draft.tasks}
                disabled={busy}
                options={ROLE_CHOICES.map((r) => ({ value: r, label: `${t("server.calendarSharing.tasks")}: ${roleWord(r || null)}` }))}
                onChange={(tasks) => setDrafts((d) => ({ ...d, [cal.id]: { ...draft, tasks } }))}
              />
              <button
                type="button"
                className="settings-btn sm"
                disabled={busy || !draft.user || (!draft.events && !draft.tasks)}
                onClick={() =>
                  void run(async () => {
                    await invoke("shared_calendar_grant", { id: cal.id, user: draft.user, events: draft.events, tasks: draft.tasks });
                    setDrafts((d) => ({ ...d, [cal.id]: { user: "", events: "viewer", tasks: "" } }));
                    return t("server.sharing.done");
                  })
                }
              >
                {t("server.calendarSharing.open")}
              </button>
            </div>
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await invoke("shared_calendar_unshare", { id: cal.id });
                    return t("server.calendarSharing.unshared");
                  })
                }
              >
                {t("server.calendarSharing.unshare")}
              </button>
            </div>
          </SettingsCard>
        );
      })}
      {incoming.length > 0 && <div className="settings-card-label">{t("server.sharing.incoming")}</div>}
      {incoming.map((cal) => (
        <p key={cal.id} className="settings-help">
          {t("server.calendarSharing.incomingRow", { name: cal.name, owner: cal.owner, events: roleWord(cal.events), tasks: roleWord(cal.tasks) })}
        </p>
      ))}
      {status && <p className="settings-help">{status}</p>}
      {confirming && (
        <ConfirmDialog
          title={t("server.calendarSharing.confirmTitle", { name: pickedName })}
          body={t("server.calendarSharing.confirmBody")}
          confirmLabel={t("server.calendarSharing.share")}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const id = confirming;
            setConfirming(null);
            void run(async () => {
              await invoke("shared_calendar_share", { calendarId: id });
              setPick("");
              return t("server.calendarSharing.shared");
            });
          }}
        />
      )}
    </>
  );
}

/**
 * Keep the calendar store in step with shared calendars (§6.7): a long poll
 * of the user's daemon, which answers as soon as another member's change
 * (or a revoke) reaches the service; the store then reloads, so an edit
 * appears within one change. Mounted once by the browser client's shell;
 * idle until the calendar store has loaded.
 */
export function SharedCalendarWatch() {
  const loaded = useCalendarStore((s) => s.loaded);
  const live = useRef(true);
  useEffect(() => {
    if (!loaded || !isServerClient()) return;
    live.current = true;
    let pause = 0;
    const loop = async () => {
      while (live.current) {
        try {
          const started = Date.now();
          const changed = await invoke<boolean>("shared_calendar_wait");
          pause = 0;
          if (changed && live.current) await useCalendarStore.getState().reload();
          // A wait that came back at once with nothing is no wait at all.
          if (!changed && Date.now() - started < 1_000) await new Promise((r) => setTimeout(r, 5_000));
        } catch {
          // Not a server, or the service is down: back off, try again.
          pause = Math.min(60_000, pause ? pause * 2 : 2_000);
          await new Promise((r) => setTimeout(r, pause));
        }
      }
    };
    void loop();
    return () => {
      live.current = false;
    };
  }, [loaded]);
  return null;
}
