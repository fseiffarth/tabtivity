import { createContext, useContext, useEffect, useState } from "react";
import type { TabEntry } from "../stores/tabs";

/**
 * The sleep/wake seam for a pane that releases what it holds after a while off
 * screen (performance plan §4.3; §5.3's `<SleepingPane>` generalises it).
 *
 * `asleep` turns true once the pane has been `hidden` for `afterMs` with no
 * `hold`, and false the moment it is shown again — in the same render, so the
 * host remounts its body before the user sees the empty slot. A hold (unsaved
 * work, a build in flight, a popout mirroring the tab) cancels the countdown;
 * when it lifts while the pane is still hidden, the countdown starts over. A
 * hold raised while already asleep changes nothing: there is nothing left to
 * keep, and the wake reload serves it as a fresh mount would.
 *
 * The host decides what sleeping means — unmounting a viewer body so its own
 * teardown releases documents, workers and timers, and so its mount path
 * restores the persisted position. No timer runs while the pane is shown.
 */
export function useSleepWhenHidden({
  hidden,
  afterMs,
  hold = false,
  identity = "",
}: {
  hidden: boolean;
  afterMs: number;
  hold?: boolean;
  /** What the pane would be remounted as. A change wakes a sleeping pane in
   *  the same render and restarts the countdown — for a terminal, its spawn
   *  identity: a relaunch or container toggle while asleep must reach the
   *  program now, as it would through a mounted pane (performance plan §5.3). */
  identity?: string;
}): boolean {
  // The identity the pane fell asleep with, or null while awake.
  const [asleepAs, setAsleepAs] = useState<string | null>(null);
  useEffect(() => {
    if (!hidden) {
      setAsleepAs(null);
      return;
    }
    if (hold) return;
    const id = window.setTimeout(() => setAsleepAs(identity), afterMs);
    return () => window.clearTimeout(id);
  }, [hidden, hold, afterMs, identity]);
  return asleepAs !== null && asleepAs === identity && hidden;
}

/**
 * A pane's sleep holds (performance plan §5.3). The pane layer (`PaneSlot`)
 * provides the reporter; anything inside the pane that must not be unmounted —
 * unsaved edits, unsaved markup, a build in flight, media playing — reports
 * through {@link usePaneSleepHold}. Outside a sleepable pane (a popout, the
 * side panel, the root console) there is no provider and a hold is a no-op.
 */
export type PaneSleepHoldReporter = (token: object, held: boolean) => void;

export const PaneSleepHoldContext = createContext<PaneSleepHoldReporter | null>(null);

/**
 * Keep the surrounding pane awake while `held`. Every caller holds its own
 * token, so two holds in one pane (an editor and its PDF) lift independently;
 * unmounting releases the hold.
 */
export function usePaneSleepHold(held: boolean): void {
  const report = useContext(PaneSleepHoldContext);
  const [token] = useState(() => ({}));
  useEffect(() => {
    if (!report || !held) return;
    report(token, true);
    return () => report(token, false);
  }, [report, held, token]);
}

/** Default for the "Sleep hidden tabs after" setting, in minutes (§5.3). */
export const SLEEP_TABS_DEFAULT_MIN = 10;

/** The delays the setting offers besides "never". A stored value outside the
 *  list (edited by hand) still works; the dropdown then shows it unselected. */
export const SLEEP_TABS_CHOICES_MIN = [5, 10, 30, 60] as const;

/**
 * The pane layer's sleep delay from the stored setting
 * (`sleep_tabs_after_min`): absent → the default, `0` → never (null), else
 * that many minutes. A non-finite or negative value reads as the default.
 */
export function sleepTabsAfterMs(minutes: number | undefined | null): number | null {
  const m =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0
      ? minutes
      : SLEEP_TABS_DEFAULT_MIN;
  return m === 0 ? null : m * 60_000;
}

/**
 * Whether a viewer tab's whole pane may sleep (be unmounted while hidden). A
 * file viewer restores its position from the tab's `viewerState` (§3.1 stage,
 * then store) and a Files (Project) tab its folder from `TabEntry.folder`.
 * Not a placeholder `embed` without a viewer (its mount opens the file in an
 * external app, so a wake would open it again), not the plain Files browser
 * (its folder lives in component state). Terminal kinds sleep by their own
 * rule, {@link isSleepableTerminalTab}.
 */
export function isSleepableTab(tab: Pick<TabEntry, "kind" | "viewer">): boolean {
  return (tab.kind === "embed" && !!tab.viewer) || tab.kind === "projectfiles";
}

/**
 * Whether a terminal tab's pane may sleep (§5.3, terminal kinds): its xterm is
 * unmounted while the PTY keeps running (`lib/terminal/sleepingPtys`), and the
 * wake re-attaches. Never a Host session (it ran unfenced with the user's full
 * rights; its pane is the one place that says so), and never while another
 * view of the PTY is drawn — a popout, the root console, an overlay's docked
 * agent column: the main pane is the PTY owner those attach to, and it stays
 * mounted while they show it.
 */
export function isSleepableTerminalTab(
  tab: Pick<TabEntry, "kind" | "hostSession">,
  { inPopout, drawnElsewhere }: { inPopout: boolean; drawnElsewhere: boolean },
): boolean {
  const terminal = tab.kind === "agent" || tab.kind === "local_agent" || tab.kind === "shell";
  return terminal && !tab.hostSession && !inPopout && !drawnElsewhere;
}
