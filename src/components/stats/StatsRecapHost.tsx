import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { APP_TIMER_ID } from "../../stores/timer";
import { dayKey } from "../../lib/usageRollup";
import {
  dayAnchorMs,
  lastActiveDay,
  pickWelcomeBack,
  type TimeByDay,
  type WelcomeBack,
} from "../../lib/welcomeBack";

// Code-split (perf plan §6): the host stays in the startup chunk — it owns the
// open event and the once-a-day launch check — but the recap itself loads only
// when it is about to show.
const StatsRecap = lazy(() => import("./StatsRecap").then((m) => ({ default: m.StatsRecap })));

/** Any surface can open the recap by dispatching this (the same bus Settings, the
 *  tour and How-To-Start already use — no global UI store needed). */
export const OPEN_STATS_EVENT = "app:open-stats";

/**
 * Owns when the usage recap is on screen.
 *
 * Two ways in:
 *
 * - **Automatically**, on the first launch of a day (unless turned off). It then
 *   anchors on the **last day you worked** — usually yesterday: at 9am today
 *   there is nothing to report yet, and the day that just finished is the one
 *   worth looking at; after a weekend it is Friday, not an empty Sunday. It
 *   opens with a typed welcome-back line naming that day's project, with
 *   Continue / Switch buttons. With no earlier tracked time at all (a fresh
 *   install, where HowToStart has the screen) it does not open.
 * - **On demand**, via {@link OPEN_STATS_EVENT} from the Settings button. That
 *   anchors on **today**, because you asked for it now.
 *
 * Mounted once, in `AppShell` (main window only — a detached subwindow must not
 * pop its own copy).
 */
export function StatsRecapHost() {
  const [anchorMs, setAnchorMs] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const [welcome, setWelcome] = useState<WelcomeBack | null>(null);
  // One launch check per mount: it reads the time log asynchronously, and a
  // re-run (StrictMode, a settings write landing) must not start a second read.
  const checking = useRef(false);

  const loaded = useSettingsStore((s) => s.loaded);
  const enabled = useSettingsStore((s) => s.settings?.daily_stats_recap ?? true);
  const lastShown = useSettingsStore((s) => s.settings?.daily_stats_last_shown);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const projectsLoaded = useProjectsStore((s) => s.loaded);

  // On-demand: the Settings button.
  useEffect(() => {
    const open = () => {
      setAuto(false);
      setWelcome(null);
      setAnchorMs(Date.now());
    };
    window.addEventListener(OPEN_STATS_EVENT, open);
    return () => window.removeEventListener(OPEN_STATS_EVENT, open);
  }, []);

  // Once a day, on launch. Gated on settings being loaded, or the very first
  // render (settings still null) would read the default "on" and pop the recap
  // for someone who turned it off — and on projects, which the welcome-back
  // line names.
  useEffect(() => {
    if (!loaded || !enabled || !projectsLoaded || checking.current) return;
    // The counters are bucketed in UTC, so the "have I shown this today" gate is
    // too — otherwise the recap's own idea of "today" and the day it stamps could
    // disagree either side of local midnight.
    const today = dayKey(Date.now());
    if (lastShown === today) return;
    checking.current = true;
    void invoke<TimeByDay>("get_time_activity_all")
      .catch(() => null)
      .then((log) => {
        const timeByDay = log ?? {};
        // Nothing tracked before today: nothing to look back on. Not stamped,
        // so the first launch of a later day, which has a yesterday, shows it.
        const day = lastActiveDay(timeByDay, today, APP_TIMER_ID);
        if (!day) return;
        const ids = new Set(useProjectsStore.getState().projects.map((p) => p.id));
        setWelcome(pickWelcomeBack(timeByDay, day, ids));
        setAuto(true);
        setAnchorMs(dayAnchorMs(day));
        void updateSettings({ daily_stats_last_shown: today });
      });
  }, [loaded, enabled, projectsLoaded, lastShown, updateSettings]);

  if (anchorMs === null) return null;
  return (
    <Suspense fallback={null}>
      <StatsRecap
        onClose={() => setAnchorMs(null)}
        initialAnchorMs={anchorMs}
        showAutoToggle={auto}
        welcome={welcome}
      />
    </Suspense>
  );
}
