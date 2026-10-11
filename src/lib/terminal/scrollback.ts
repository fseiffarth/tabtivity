import type { TabKind } from "../../stores/tabs";

/**
 * How many lines of history a terminal's xterm keeps (`docs/tab_cost_plan.md`
 * step 2). xterm holds about rows × cols × 12 bytes per terminal, and a shell
 * needs less history than an agent, so shells follow the
 * `shell_scrollback_rows` setting while agent tabs keep a fixed
 * {@link AGENT_SCROLLBACK_ROWS}: Claude-style TUIs draw the conversation into
 * the normal buffer, and the Reader, keyboard select and steering scroll read
 * it back from there.
 *
 * `TerminalView` reads the cap through a ref when it builds the xterm and sets
 * `options.scrollback` live when the setting moves — never a spawn input, so a
 * settings change neither respawns nor wakes a program.
 */

/** Lines a shell keeps when the setting is unset or unusable. */
export const SHELL_SCROLLBACK_DEFAULT = 2000;

/** The values the setting offers. A stored value outside the list (edited by
 *  hand) still works, clamped; the dropdown then shows it unselected. */
export const SHELL_SCROLLBACK_CHOICES = [1000, 2000, 5000, 10_000] as const;

/** Bounds a stored value is clamped to. */
export const SHELL_SCROLLBACK_MIN = 100;
export const SHELL_SCROLLBACK_MAX = 50_000;

/** Lines an agent tab (`agent`, `local_agent`) keeps, whatever the setting. */
export const AGENT_SCROLLBACK_ROWS = 5000;

/** The shell cap from the stored setting: absent or not a finite number → the
 *  default; otherwise rounded down and clamped to
 *  [{@link SHELL_SCROLLBACK_MIN}, {@link SHELL_SCROLLBACK_MAX}]. */
export function shellScrollbackRows(setting: number | null | undefined): number {
  if (typeof setting !== "number" || !Number.isFinite(setting)) return SHELL_SCROLLBACK_DEFAULT;
  return Math.min(SHELL_SCROLLBACK_MAX, Math.max(SHELL_SCROLLBACK_MIN, Math.floor(setting)));
}

/** The cap for a terminal of `kind` (as `terminalViewKind` derives it). Every
 *  kind but the two agent kinds — shells, the dialogs' connection terminals —
 *  follows the setting. */
export function scrollbackRowsFor(kind: TabKind, setting: number | null | undefined): number {
  return kind === "agent" || kind === "local_agent" ? AGENT_SCROLLBACK_ROWS : shellScrollbackRows(setting);
}
