import { useEffect, useState } from "react";

import { useSettingsStore } from "../../stores/settings";
import { dayKey } from "../../lib/usageRollup";
import { StatsRecap } from "./StatsRecap";

const DAY_MS = 86_400_000;

/** Any surface can open the recap by dispatching this (the same bus Settings, the
 *  tour and How-To-Start already use — no global UI store needed). */
export const OPEN_STATS_EVENT = "app:open-stats";

/**
 * Owns when the usage recap is on screen.
 *
 * Two ways in:
 *
 * - **Automatically**, on the first launch of a day (unless turned off). It then
 *   anchors on **yesterday** — at 9am today there is nothing to report yet, and
 *   the day that just finished is the one worth looking at.
 * - **On demand**, via {@link OPEN_STATS_EVENT} from the Settings button. That
 *   anchors on **today**, because you asked for it now.
 *
 * Mounted once, in `AppShell` (main window only — a detached subwindow must not
 * pop its own copy).
 */
export function StatsRecapHost() {
  const [anchorMs, setAnchorMs] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);

  const loaded = useSettingsStore((s) => s.loaded);
  const enabled = useSettingsStore((s) => s.settings?.daily_stats_recap ?? true);
  const lastShown = useSettingsStore((s) => s.settings?.daily_stats_last_shown);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // On-demand: the Settings button.
  useEffect(() => {
    const open = () => {
      setAuto(false);
      setAnchorMs(Date.now());
    };
    window.addEventListener(OPEN_STATS_EVENT, open);
    return () => window.removeEventListener(OPEN_STATS_EVENT, open);
  }, []);

  // Once a day, on launch. Gated on settings being loaded, or the very first
  // render (settings still null) would read the default "on" and pop the recap
  // for someone who turned it off.
  useEffect(() => {
    if (!loaded || !enabled) return;
    // The counters are bucketed in UTC, so the "have I shown this today" gate is
    // too — otherwise the recap's own idea of "today" and the day it stamps could
    // disagree either side of local midnight.
    const today = dayKey(Date.now());
    if (lastShown === today) return;
    setAuto(true);
    setAnchorMs(Date.now() - DAY_MS); // the day that just finished
    void updateSettings({ daily_stats_last_shown: today });
  }, [loaded, enabled, lastShown, updateSettings]);

  if (anchorMs === null) return null;
  return (
    <StatsRecap
      onClose={() => setAnchorMs(null)}
      initialAnchorMs={anchorMs}
      showAutoToggle={auto}
    />
  );
}
