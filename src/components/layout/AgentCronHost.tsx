import { useEffect, useRef } from "react";
import { useSettingsStore } from "../../stores/settings";
import {
  dueAgentCronRuns,
  localDayKey,
  scheduledAgentCmds,
} from "../../lib/agents/agentCron";
import { runAgentCronWarmup } from "../../lib/agents/agentCronRun";
import { holdsTimerLease } from "../../stores/timerLease";
import { storageKey } from "../../lib/brand";

/** How often "is a slot due?" is asked. A minute is finer than the grace window
 *  (`AGENT_CRON_GRACE_MIN`) by five, so no slot can fall between two ticks; the
 *  tick itself is a clock read and a set lookup for the common case of nothing
 *  scheduled at all. */
const TICK_MS = 60_000;

/** Where the fired slots live. Deliberately **not** settings: a fire is a
 *  per-machine, per-day fact, and `updateSettings` writes the whole settings
 *  file back — recording one there would rewrite it twice a day and race every
 *  other setting written meanwhile. It only has to survive a window reload,
 *  which is exactly what localStorage is for. */
const FIRED_KEY = storageKey("agentCron.fired");

function readFired(): Set<string> {
  try {
    const raw = localStorage.getItem(FIRED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    // A private window, cleared site data, or a value some other build wrote.
    // An unreadable record means "nothing has fired", which can at worst send
    // one extra message — the safe direction for a feature whose failure mode
    // in the other direction is a schedule that silently never fires again.
    return new Set();
  }
}

/** Persist the record, keeping today's and yesterday's keys and dropping the
 *  rest — in memory as well as on disk, so a window left open for a month does
 *  not accumulate a key per slot per day. The record only has to answer "did
 *  this slot already fire?", which is a question about today; yesterday is kept
 *  so a tick just after midnight cannot resurrect a slot from the minute before
 *  it. Returns the pruned set. */
function writeFired(fired: Set<string>, now: Date): Set<string> {
  const today = localDayKey(now);
  const yesterday = localDayKey(new Date(now.getTime() - 86_400_000));
  const kept = [...fired].filter((key) => {
    const day = key.split("|")[1];
    return day === today || day === yesterday;
  });
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(kept));
  } catch {
    // Storage is full or blocked; the in-memory set still guards this session.
  }
  return new Set(kept);
}

/**
 * The agent warm-up cron's scheduler (Manage CLIs → Scheduled warm-up).
 *
 * Renders nothing, mounted once at the shell — `CalDavSyncHost`'s shape, and for
 * its reason: the surface that *configures* this is a settings panel nobody has
 * open at 06:00, so a timer living there would be a schedule that only fires
 * while its own settings page is being read. Main window only (this file is
 * `AppShell`'s, never `DetachedApp`'s), so two windows cannot both send the
 * morning's message.
 *
 * Three rules, two of them `CalDavSyncHost`'s:
 *
 *  1. **It costs nothing when nothing is scheduled.** No participating agent, no
 *     timer — and the settings read that decides is already in memory.
 *  2. **Mounting fires nothing.** A slot is due only inside a short window after
 *     its time (`dueAgentCronRuns`), so a launch at 10:00 does not spend the
 *     06:00 window five hours after the fact. The one thing that *does* survive
 *     a reload is the record of what already fired.
 *  3. **One send at a time.** Two agents due in the same minute are warmed in
 *     sequence: each is a background CLI process of its own (`agent_warmup`),
 *     and two agent CLIs booting into the same second is a burst nobody asked
 *     for. Nothing is shown: no tab, no terminal, no window.
 */
export function AgentCronHost() {
  const cron = useSettingsStore((s) => s.settings?.agent_cron);
  const fired = useRef<Set<string> | null>(null);
  const inFlight = useRef(false);

  // A stable identity for the live schedule: the timer restarts when what is
  // scheduled changes, and not when an unrelated setting is written.
  const key = scheduledAgentCmds(cron).join("|");

  useEffect(() => {
    if (!key) return;
    if (fired.current === null) fired.current = readFired();

    const tick = () => {
      if (inFlight.current) return;
      // Another Tabtivity window holds the timer lease: it sends the morning's
      // message, this one does not (headless owner plan, H2 interim).
      if (!holdsTimerLease()) return;
      const now = new Date();
      const record = fired.current ?? new Set<string>();
      // Re-read the settings rather than closing over `cron`: a schedule edited
      // between ticks must take effect at the next one, not at the next remount.
      const due = dueAgentCronRuns(useSettingsStore.getState().settings?.agent_cron, now, record);
      if (due.length === 0) return;

      // Marked before the send, not after. A run that fails is not retried every
      // minute for the rest of the grace window — the window either opened or
      // the agent is not installed, and neither is fixed by sending again.
      for (const run of due) record.add(run.key);
      fired.current = writeFired(record, now);

      inFlight.current = true;
      void (async () => {
        try {
          for (const run of due) {
            await runAgentCronWarmup(run.cmd);
          }
        } finally {
          inFlight.current = false;
        }
      })();
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [key]);

  return null;
}
