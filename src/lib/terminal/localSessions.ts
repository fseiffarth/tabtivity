/**
 * Whether this machine has persistent LOCAL sessions — the one answer every
 * "is there a local tmux-like session behind this tab" gate asks.
 *
 * On Linux and macOS tmux backs them; on Windows it is the native session host
 * (`docs/windows_session_host_plan.md`), behind the experimental
 * `windows_session_host` flag. Either way `persist_local_sessions` is the user's
 * switch (Defaults 3). Two questions, kept apart:
 *
 * - `localSessionBackendOn`: a backend exists here at all (platform + flag) —
 *   what decides whether the settings offer the persistence switch.
 * - `localSessionsAvailable`: new tabs get one (backend + `persist_local_sessions`).
 *
 * Neither decides a KILL. On Windows a tab's wrap is stamped once per slot
 * (`PaneSlot`, `mobileAgentTmuxReady`) from `localSessionsAvailable`, so a tab
 * may own a host session the current settings would not give it: the kill
 * paths key on `mayOwnWindowsLocalSession` (a local agent tab with a session
 * name), and killing an absent session is fine.
 *
 * Which tabs the backend carries is `shouldPersistLocalTab`'s (`tmuxSession.ts`):
 * on Windows agents only. The backend's own answer — a host that will not start
 * or does not reply — reaches the tab as a fallback / fail-closed notice
 * (`sessionHostNotice.ts`), not through these predicates.
 */

import { experimentalEnabled } from "../experimental";
import { HOST_OS, type OsName } from "../platform";
import { ROOT_SCOPE } from "./ptyId";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

type MaybeSettings = Settings | null | undefined;

/** A local session backend exists here: tmux off Windows, the experimental
 *  session host on Windows. Settings not loaded yet count as off on Windows. */
export function localSessionBackendOn(settings: MaybeSettings, hostOs: OsName = HOST_OS): boolean {
  return hostOs !== "windows" || experimentalEnabled(settings, "windows_session_host");
}

/** New local tabs get a persistent session: a backend and `persist_local_sessions`
 *  (unset is on). */
export function localSessionsAvailable(settings: MaybeSettings, hostOs: OsName = HOST_OS): boolean {
  return localSessionBackendOn(settings, hostOs) && settings?.persist_local_sessions !== false;
}

/** `localSessionsAvailable` for code outside React (stores, event handlers). */
export function localSessionsAvailableNow(): boolean {
  return localSessionsAvailable(useSettingsStore.getState().settings);
}

/** `localSessionBackendOn` as a store subscription. */
export function useLocalSessionBackendOn(): boolean {
  return useSettingsStore((s) => localSessionBackendOn(s.settings));
}

/** `localSessionsAvailable` as a store subscription. */
export function useLocalSessionsAvailable(): boolean {
  return useSettingsStore((s) => localSessionsAvailable(s.settings));
}

/** Kill side, Windows: whether a tab may own a session-host session, whatever
 *  the settings are now — a local agent tab outside the root console. The
 *  caller also requires the tab's own minted name (`tmuxSession`, no
 *  `tmuxAttach`). */
export function mayOwnWindowsLocalSession(kind: string, scopeKey: string, localRunning: boolean): boolean {
  return (kind === "agent" || kind === "local_agent") && scopeKey !== ROOT_SCOPE && localRunning;
}
