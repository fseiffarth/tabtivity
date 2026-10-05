import { useSettingsStore } from "../../stores/settings";

/**
 * **Fast mode** — one switch that withdraws the display aids whose cost is a
 * directory walk, a standing poll, or a read of every file in view.
 *
 * The list below is the whole feature, and it lives here rather than being
 * spelled out at each call site so the settings help text and the code cannot
 * drift apart. Everything on it shares three properties, and nothing may be
 * added that misses one:
 *
 *  1. **It costs work nobody asked for.** A recursive `du`, a timer that runs
 *     whether or not anyone is looking, a file read per row.
 *  2. **Its absence is legible.** The number is simply not there — no spinner,
 *     no placeholder, no "…" that never resolves. A user who does not know fast
 *     mode is on must not read a missing figure as a stuck one.
 *  3. **Nothing is lost but the aid.** No file goes unlisted, no edit unsaved,
 *     no lamp wrong. Fast mode may make Tabtivity say less; it may never make it
 *     say something untrue.
 *
 * What it turns off:
 *
 *  - **Folder sizes in the file tree** (`FileTree`) — the per-folder recursive
 *    walk and the group totals summed from it. The most expensive aid in the
 *    app by a wide margin: one `dir_size_breakdown` per *visible folder*, and
 *    on a remote project each one is a `du` over SSH.
 *  - **The git-dirty dots on the project pills** (`ProjectSwitcher`) — a
 *    `git status` per local project every 12 s, forever, for projects the user
 *    is not currently in.
 *  - **The project hover card** (`ProjectPill`) — polls `project_cpu_percent`
 *    every 1.5 s for as long as the pointer rests, plus a scaffold probe per
 *    open. The pill keeps a plain name tooltip.
 *  - **The tab hover card** (`TabBar`, `DetachedCenterPanel`) — its own ticking
 *    clock and store subscriptions per hover; the tab keeps its `title`.
 *  - **The header CPU/RAM/GPU readout** (`AppResourceDisplay`) — a
 *    `debug_app_resource_usage` poll every 2.5 s for a figure that is, by
 *    construction, a readout of Tabtivity's own overhead.
 *  - **The Python ▶ gate** (`FileTree`) — deciding whether a `.py` has a
 *    `__main__` guard means reading it, which on a remote listing is an SFTP
 *    round trip per file. Files already in the persisted cache keep their ▶;
 *    fast mode stops the *scanning*, not the answers already paid for.
 *  - **The tree's periodic remote re-stat** (`FileTree`) — the 15 s sync-marker
 *    refresh. The focus listener and every explicit re-list survive, so the
 *    markers still catch up on a gesture.
 *  - **UI animations and transitions** — via `data-fast-mode` on the document
 *    root (see `themes.css`), the same collapse `data-blurred` performs.
 *
 * It composes with Energy Saver (`stores/power`) rather than replacing it:
 * that one widens timers off a live battery reading, this one removes features
 * off a standing preference, and where both apply the stronger wins — a timer
 * fast mode deletes is not a timer energy saver needs to widen.
 */

/** Resolve the persisted key. Unset is off: fast mode is never inferred. */
function isActive(fastMode: boolean | undefined): boolean {
  return fastMode === true;
}

/** Reactive: true while fast mode is on. Re-renders its caller when the setting
 *  changes, so a surface withdrawn by fast mode comes back the moment it is
 *  turned off — no relaunch, no remount. */
export function useFastMode(): boolean {
  return isActive(useSettingsStore((s) => s.settings?.fast_mode));
}

/** Non-reactive snapshot of {@link useFastMode}, for reads inside effects,
 *  animation loops and event handlers that must not resubscribe. */
export function fastModeActive(): boolean {
  return isActive(useSettingsStore.getState().settings?.fast_mode);
}

/** Mirror fast mode onto the document root as `data-fast-mode`, where
 *  `themes.css` collapses animations and transitions. Returns nothing; call it
 *  from each window root (`AppShell`, `DetachedApp`) the way the energy-saver
 *  attribute is applied, since every window is its own document. */
export function applyFastModeAttribute(active: boolean): void {
  const root = document.documentElement;
  if (active) root.dataset.fastMode = "on";
  else delete root.dataset.fastMode;
}
