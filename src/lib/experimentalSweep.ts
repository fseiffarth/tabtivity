/**
 * Withdrawing an experiment that owns a tab.
 *
 * `lib/experimental` decides *whether* a feature is live; this decides what
 * happens to what is already on screen when the answer changes to no. Only the
 * flags in `EXPERIMENTAL_TAB_KINDS` have anything to withdraw — mail and the
 * browser, the app's two network clients — and for them "off" has to mean the
 * tab is gone, not merely that the menu entry is. A switch that leaves a mail
 * client running is not a switch.
 *
 * Three surfaces, one rule:
 *
 *  - **Open tabs** in every loaded scope → `closeTabsOfKinds`.
 *  - **Live browser windows** → closed too. They are separate OS windows the
 *    browser feature owns; a hardened webview left running after the browser was
 *    switched off is precisely the thing the switch is for. (They have their own
 *    `browser_live_pages` opt-in on top of this one; that gate says whether they
 *    may be *opened*, which does nothing about one already up.)
 *  - **Restored tabs**, handled elsewhere: `stores/tabs`'s `loadFromLayout` drops
 *    them as the layout is read, so a scope restored after this ran does not
 *    bring them back and the two halves never race.
 *
 * A popout window is a separate React root with its own tabs store, so it sweeps
 * itself (`DetachedApp`) and this deliberately leaves its tabs alone — see
 * `closeTabsOfKinds`.
 *
 * Installed once per window at startup (`AppShell`), and re-run on every settings
 * change: the flag can go off from the Settings panel, from another window's
 * write, from Debug mode being turned off on a profile not yet migrated to
 * explicit flags (`lib/experimental`), or from settings simply arriving late.
 * Running it repeatedly is free — after the first pass there is nothing to close.
 */

import { useBrowserStore } from "../stores/browser";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import { withdrawnTabKinds } from "./experimental";

/** Close whatever the current settings say may no longer exist. */
export function sweepWithdrawnExperiments(): void {
  const kinds = withdrawnTabKinds(useSettingsStore.getState().settings);
  if (kinds.length === 0) return;
  useTabsStore.getState().closeTabsOfKinds(kinds);
  if (kinds.includes("browser")) {
    const browser = useBrowserStore.getState();
    for (const win of browser.live) void browser.closeLive(win.label);
  }
}

/** Sweep now, then on every settings change. Returns the unsubscribe. */
export function initExperimentalSweep(): () => void {
  sweepWithdrawnExperiments();
  return useSettingsStore.subscribe((s, prev) => {
    if (s.settings === prev.settings) return;
    sweepWithdrawnExperiments();
  });
}
