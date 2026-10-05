import { useEffect, useRef } from "react";
import { installCalDavPush, useCalDavStore } from "../../stores/calendar/caldav";
import { DEFAULT_CALDAV_SYNC_MIN } from "../../lib/calendar/caldav";
import { useVpnTunnelUp, vpnGateAllows, vpnTunnelUp } from "../../lib/remote/vpn/vpnGate";
import { holdsTimerLease } from "../../stores/timerLease";

/** How often the scheduler wakes up. Each account is still synced on its own
 *  interval; this is only the granularity at which "is it due yet" is asked. */
const TICK_MS = 60_000;

/**
 * The scheduled half of CalDAV sync — `MailIndicator`'s check-interval timer,
 * for calendars (`docs/caldav_plan.md` Phase 2).
 *
 * It renders nothing. It is mounted at the shell rather than inside the
 * calendar pane for the reason the alarm ticker is: a calendar that only
 * refreshed while its overlay happened to be open would be stale exactly when
 * it is looked at, and the surfaces that read a synced calendar (the header
 * badge, the to-do board's agenda rail, the alarms) are not the calendar pane.
 *
 * Three rules, all of them mail's:
 *
 *  1. **It costs nothing when no CalDAV account exists.** The accounts read is
 *     one local file; with none configured, the timer never starts and nothing
 *     here touches the network.
 *  2. **The first tick is a whole interval away.** Checking at mount is
 *     checking at launch, and a restored window must not open a socket by
 *     existing. `lastRun` is seeded with the mount time for exactly that.
 *  3. **An explicit `0` means never.** A stored zero is a choice; only an
 *     absent value is unset, and an unset one gets `DEFAULT_CALDAV_SYNC_MIN`.
 *
 * The ctag check on the backend is what keeps a short interval cheap: a tick
 * against an unchanged collection is one small `PROPFIND`, not a re-download of
 * the calendar.
 *
 * A **VPN-only account** (`require_vpn`, `lib/remote/vpn/vpnGate.ts`) is never due while no
 * tunnel is up, and is made due at once — and synced on the spot — when one
 * comes up. Same rising-edge rule as `MailIndicator`: only a reconciled
 * `false → true` counts, so the store first learning of a tunnel at launch does
 * not sync at mount.
 */
export function CalDavSyncHost() {
  const accounts = useCalDavStore((s) => s.accounts);
  /** Per account, when it last *attempted* a sync — not when one succeeded.
   *  A failing server must not be retried every tick. */
  const lastRun = useRef<Record<string, number>>({});
  const inFlight = useRef(false);
  /** The scheduler's tick, kept where the VPN catch-up below can call it. */
  const tickRef = useRef<() => void>(() => {});
  const tunnelUp = useVpnTunnelUp();
  const prevTunnelUp = useRef<boolean | null>(null);

  // A purely local read: it is what tells the timer whether there is anything
  // to schedule at all.
  useEffect(() => {
    void useCalDavStore.getState().load();
  }, []);

  // The **push** half (`docs/caldav_plan.md` Phase 3) is installed here rather
  // than at module scope, and here rather than in the calendar pane, for this
  // component's own two reasons: exactly one handler may answer for a row's
  // server side (module scope in a file two roots import would install two), and
  // an edit made from the to-do board or the header's day list must push the
  // same way one made in the calendar tab does — none of which is that pane.
  // With no account, or with push not opted into, the handler resolves to a
  // no-op inside `pushRow`, so this costs nothing for everyone else.
  useEffect(() => installCalDavPush(), []);

  const scheduled = accounts.filter(
    (a) => a.calendars.length > 0 && (a.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN) > 0,
  );
  // A stable key, so adding an unrelated account (or a sync writing a ctag back)
  // does not restart the timer and push every account's next check out.
  const key = scheduled
    .map((a) => `${a.id}:${a.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN}:${a.calendars.length}`)
    .join("|");

  useEffect(() => {
    if (!key) return;
    const now = Date.now();
    for (const account of scheduled) {
      if (lastRun.current[account.id] === undefined) lastRun.current[account.id] = now;
    }

    const tick = () => {
      // Another Tabtivity window holds the timer lease: it syncs, this one does
      // not (headless owner plan, H2 interim).
      if (!holdsTimerLease()) return;
      // Serialized across accounts: a slow server plus a short interval could
      // otherwise stack requests, and a burst of authenticated requests is how
      // a client gets rate-limited by an institutional gateway.
      if (inFlight.current) return;
      const at = Date.now();
      const up = vpnTunnelUp();
      const due = useCalDavStore
        .getState()
        .accounts.filter((a) => a.calendars.length > 0)
        .filter((a) => {
          const minutes = a.sync_interval_min ?? DEFAULT_CALDAV_SYNC_MIN;
          if (minutes <= 0) return false;
          // Not "not due yet": not reachable. `lastRun` is left alone, so the
          // account is due the moment the tunnel makes it reachable.
          if (!vpnGateAllows(a, up)) return false;
          const last = lastRun.current[a.id] ?? at;
          return at - last >= minutes * 60_000;
        });
      if (due.length === 0) return;

      inFlight.current = true;
      void (async () => {
        try {
          for (const account of due) {
            lastRun.current[account.id] = Date.now();
            for (const ref of account.calendars) {
              // `force: false` — the ctag check is the whole reason a scheduled
              // sync is affordable. A manual "Sync now" is the forcing one.
              await useCalDavStore.getState().syncCalendar(account.id, ref.href, false);
            }
          }
        } finally {
          inFlight.current = false;
        }
      })();
    };

    tickRef.current = tick;
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(id);
      tickRef.current = () => {};
    };
    // `scheduled` is derived from `accounts` and re-created each render; `key`
    // is its identity, which is what the timer actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The catch-up. Making the gated accounts due and running the tick now, rather
  // than waiting for the next 60 s wake-up: the tunnel coming up is the event
  // the calendar has been waiting for.
  useEffect(() => {
    const rose = tunnelUp === true && prevTunnelUp.current === false;
    prevTunnelUp.current = tunnelUp;
    if (!rose) return;
    for (const account of useCalDavStore.getState().accounts) {
      if (account.require_vpn) lastRun.current[account.id] = 0;
    }
    tickRef.current();
  }, [tunnelUp]);

  return null;
}
