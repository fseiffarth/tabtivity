/**
 * Experimental features and the rule that governs them.
 *
 * Every experimental feature is **off until someone ticks it**: the flag is a
 * tri-state, an explicit value is the answer, and an unset flag is off — Debug
 * mode included. A feature that is still moving needs to be invisible to someone
 * using Tabtivity to work, and Debug mode is now just Debug mode: turning it on
 * shows no experiment (tab cost plan step 3, user decision 2026-10-10).
 *
 * **The migration that made that safe.** Unset used to mean `settings.debug`, so
 * a Debug-mode profile had every experiment on without a single tick. Those
 * profiles keep what they had: `migrateExperimentalOnce` (AppShell, after the
 * first `loadSettings()`) writes an explicit `true` for every flag Debug mode was
 * carrying and the marker `experimental_explicit`. Until a profile carries that
 * marker it keeps the OLD rule (unset → `debug`), in every window and in the
 * backend's `experimental()`: the first render, a popout that loads before the
 * main window has migrated, and the restore filter in `stores/tabs` must never
 * see a debug user's browser flag as off — `withdrawnTabKinds` would close their
 * browser tabs before the ticks landed. From a profile's first main-window load
 * on, the legacy branch is dead.
 *
 * `terminal_webgl` was never carried by Debug mode (it rides the GPU/driver path
 * and is opt-in everywhere), so the migration leaves it unset.
 *
 * An explicit value always wins, in both directions: a user can opt into one
 * experiment, and switch one off again.
 *
 * Most gates hide an *entry point* and nothing else: `python_run_debug` takes the
 * Debug button off a viewer that keeps working. Those flags have nothing to
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
 * spelling would miss the unmarked-profile rule above. Give it a switch in
 * Settings → Experimental: with no debug default, a flag without one cannot be
 * reached. If it owns a tab kind, add it to `EXPERIMENTAL_TAB_KINDS` too, which
 * is what wires the withdrawal (`lib/experimentalSweep`) and the restore filter
 * (`stores/tabs`'s `loadFromLayout`).
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

/** Is `flag` live? The explicit setting if there is one, else off — except on a
 *  profile not yet marked `experimental_explicit`, where an unset flag still
 *  follows Debug mode until `migrateExperimentalOnce` has written the ticks (see
 *  the module header). */
export function experimentalEnabled(
  settings: Settings | null | undefined,
  flag: ExperimentalFlag,
): boolean {
  // WebGL can fall back to software rendering (notably while DMABUF is disabled),
  // which makes a visible terminal slower rather than faster. Keep the renderer
  // opt-in until that platform path is dependable; an explicit true still wins.
  if (flag === "terminal_webgl" && settings?.terminal_webgl == null) return false;
  const explicit = settings?.[flag];
  if (explicit != null) return explicit;
  if (settings?.experimental_explicit === true) return false;
  return settings?.debug ?? false;
}

/** The flags an unmarked Debug-mode profile had on without a tick: every one but
 *  `terminal_webgl`, which Debug mode never carried. */
const DEBUG_CARRIED_FLAGS = EXPERIMENTAL_FLAGS.filter((f) => f !== "terminal_webgl");

/**
 * The one-shot patch that moves a profile onto the explicit rule without
 * changing what it shows — `null` once the profile is marked.
 *
 * In Debug mode every *unset* carried flag becomes an explicit `true` (an
 * explicit value, `false` included, is the user's and is never touched); outside
 * it nothing was on by default, so the marker alone is the whole migration.
 * Idempotent: applied twice it writes the same values, which is what lets a
 * failed write simply run again at the next launch.
 */
export function explicitExperimentalPatch(settings: Settings): Partial<Settings> | null {
  if (settings.experimental_explicit === true) return null;
  const patch: Partial<Settings> = { experimental_explicit: true };
  if (settings.debug === true) {
    for (const flag of DEBUG_CARRIED_FLAGS) {
      if (settings[flag] == null) patch[flag] = true;
    }
  }
  return patch;
}

/**
 * Apply `explicitExperimentalPatch` once, from the main window's load effect
 * (`AppShell`, after `loadSettings()` resolves). Popouts and the other window
 * roots never call it; they keep the unmarked rule until the main window's write
 * reaches them through `SETTINGS_CHANGED_EVENT`, which shows the same thing.
 *
 * A store that has not loaded writes nothing (the patch would land on a guess).
 * A failed write is logged and left: the store rolls its optimistic guess back,
 * the profile stays unmarked — so the old rule still holds — and the next launch
 * tries again. Concurrent calls (StrictMode runs the load effect twice in a dev
 * build) share one write.
 */
let migrationInFlight: Promise<void> | null = null;

export function migrateExperimentalOnce(): Promise<void> {
  if (migrationInFlight) return migrationInFlight;
  const { settings, loaded, updateSettings } = useSettingsStore.getState();
  if (!loaded || !settings) return Promise.resolve();
  const patch = explicitExperimentalPatch(settings);
  if (!patch) return Promise.resolve();
  migrationInFlight = updateSettings(patch)
    .catch((err) => {
      console.warn("experimental flags: migration write failed, retrying next launch", err);
    })
    .finally(() => {
      migrationInFlight = null;
    });
  return migrationInFlight;
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
