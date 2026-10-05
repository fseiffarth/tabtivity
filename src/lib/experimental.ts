/**
 * Experimental features and the rule that governs them.
 *
 * Most experimental features are **off for everyone and on in debug mode**: the
 * flag is a tri-state, and when it is unset the answer is `settings.debug`. That
 * is the whole point of the gate — a feature that is still moving needs to be
 * invisible to someone using Tabtivity to work, and present *by default* for someone
 * using Tabtivity to build Tabtivity, without them having to re-tick a list of toggles
 * every time a new one lands. `terminal_webgl` is the exception: it exercises the
 * GPU/driver path and must be explicitly opted into even in Debug mode.
 *
 * Unset is therefore NOT the same as false. An explicit value always wins, in both
 * directions: a user can opt into one experiment without debug mode, and can switch
 * one off while *in* debug mode — otherwise "turn this off" would silently fail for
 * exactly the people most likely to hit a broken experiment.
 *
 * Most gates hide an *entry point* and nothing else: `python_run_debug` takes the
 * Run button off a viewer that keeps working. Those flags have nothing to
 * withdraw beyond the button.
 *
 * A flag that owns a whole TAB is different, and `EXPERIMENTAL_TAB_KINDS` is that
 * list. Turning one off **withdraws the feature**, open tabs included: leaving a
 * network client on screen after the user switched it off would mean the switch
 * does not mean what it says. The withdrawal is not destructive — a browser tab
 * holds a URL that is persisted until the layout is next written — so turning the
 * flag back on and opening a new tab gets the same surface back.
 *
 * `mail_client` used to be in that list and is not any more: mail lost its tab
 * (the store is global, so the tab only ever duplicated the header's overlay), so
 * the flag now gates a header button and an overlay, which is an entry point like
 * any other. A layout saved while the mail tab still existed is dropped on
 * restore by `RETIRED_TAB_CMDS`, unconditionally — a retired kind is not a flag
 * that might come back on, so its filter must not wait for settings to load.
 *
 * Adding an experiment: add its key to `Settings` (and to the Rust `Settings`, so
 * it round-trips through `save_settings`), list it here, and read it through
 * `useExperimental`. Never read `settings.<flag> ?? false` at the call site — that
 * spelling is what makes a flag miss the debug default. If it owns a tab kind, add
 * it to `EXPERIMENTAL_TAB_KINDS` too, which is what wires the withdrawal
 * (`lib/experimentalSweep`) and the restore filter (`stores/tabs`'s
 * `loadFromLayout`).
 */

import { useSettingsStore } from "../stores/settings";
import type { Settings } from "../types";
import type { TabKind } from "../stores/tabs";

/** Every experimental flag. Keys of `Settings`, all `boolean | undefined`. */
export const EXPERIMENTAL_FLAGS = [
  "python_run_debug",
  "deck_presenter",
  "mail_client",
  "web_browser",
  "terminal_webgl",
  "md_graph",
  "project_remarks",
  "copilot_completion",
] as const;

export type ExperimentalFlag = (typeof EXPERIMENTAL_FLAGS)[number];

/** Is `flag` live? Explicit setting if there is one, else debug mode, else off. */
export function experimentalEnabled(
  settings: Settings | null | undefined,
  flag: ExperimentalFlag,
): boolean {
  // WebGL can fall back to software rendering (notably while DMABUF is disabled),
  // which makes a visible terminal slower rather than faster. Keep the renderer
  // opt-in until that platform path is dependable; an explicit true still wins.
  if (flag === "terminal_webgl" && settings?.terminal_webgl === undefined) return false;
  return settings?.[flag] ?? settings?.debug ?? false;
}

/** `experimentalEnabled` as a store subscription — the call site for a component. */
export function useExperimental(flag: ExperimentalFlag): boolean {
  return useSettingsStore((s) => experimentalEnabled(s.settings, flag));
}

/**
 * Tab kinds an experimental flag owns **end to end** — the new-tab entry and the
 * tab itself. These are the flags whose "off" closes something already open; every
 * other flag only hides a control (see the module header).
 */
export const EXPERIMENTAL_TAB_KINDS: Record<string, ExperimentalFlag> = {
  browser: "web_browser",
};

/** The tab kinds these settings say may not exist right now.
 *
 * Empty while `settings` is null, and that is the load-bearing part: unknown is
 * not off. The settings store starts empty and fills in asynchronously, so a
 * caller that treated null as "everything is disabled" would close the user's
 * restored mail tab in the window between app start and the first read. Both
 * callers (the live sweep and the restore filter) therefore do nothing until
 * settings have actually arrived. */
export function withdrawnTabKinds(settings: Settings | null | undefined): TabKind[] {
  if (!settings) return [];
  return Object.keys(EXPERIMENTAL_TAB_KINDS).filter(
    (kind) => !experimentalEnabled(settings, EXPERIMENTAL_TAB_KINDS[kind]),
  ) as TabKind[];
}
