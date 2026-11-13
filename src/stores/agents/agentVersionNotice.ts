import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { subscribeTauri } from "../../hooks/useTauriListener";

/**
 * "This CLI is newer than the release Tabtivity was checked against", as a card
 * on the agent's own tab (`TerminalVersionCard`) — the launch-time half of the
 * drift line Manage Agents already shows (`services::agent_versions`).
 *
 * Only *newer* drift is raised here. An older CLI is the user's choice and the
 * settings row already names it; a newer one is what quietly breaks a mode
 * line or an approval-row parser, and a tab that misreads its agent should say
 * why before the user goes looking.
 *
 * Reads from panes share an in-flight request. The backend reuses a probe while
 * the executable is unchanged, so a new tab or window focus can pick up a CLI
 * update without launching a probe for every pane. Informational only.
 *
 * The same rows carry each CLI's last stored registry check (`update`,
 * `services::agent_latest`) — the backend asks once a day on its own and
 * announces it with `agent-updates-checked` — so `updates` is what the Models
 * & agents menu and a new tab's update card read.
 */

/** Backend `services::agent_versions::StaleNote`. */
interface StaleNote {
  version: string;
  surface: string;
  direction: "newer" | "older" | "different";
}

/** Backend `services::agent_latest::UpdateReport`, the fields read here
 *  (Manage CLIs' `AgentUpdateReport` is the same shape). */
export interface AgentUpdateReport {
  agent: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  checkable: boolean;
  error: string | null;
  checkedAt?: number;
}

/** The fields of backend `VersionReport` this notice reads. */
interface VersionReport {
  agent: string;
  label: string;
  version: string | null;
  state: "match" | "moved" | "unverified" | "unknown";
  stale: StaleNote[];
  dismissed: boolean;
  /** The last stored update check; absent while running an older backend. */
  update?: AgentUpdateReport | null;
}

/** The backend's broadcast after the daily update check stored answers. */
export const AGENT_UPDATES_CHECKED_EVENT = "agent-updates-checked";

/** What one tab's card says: the installed release and the newest release
 *  Tabtivity was verified with that it has moved past. */
export interface NewerAgentVersion {
  agent: string;
  label: string;
  installed: string;
  verified: string;
}

// The Rust verification table is compiled into the backend, which does not
// hot-reload. Keep this checked release here too so an already-running window
// stops showing its old backend's card when the frontend hot-reloads.
const FRONTEND_VERIFIED: Readonly<Record<string, string>> = {
  claude: "2.1.322",
  codex: "0.167.2",
  opencode: "2.2.7",
  antigravity: "1.5.6",
  copilot: "1.0.109",
  muse: "1.4.15",
};

interface AgentVersionNoticeStore {
  /** Registry id → the notice to show, only for CLIs newer than verified. */
  newer: Record<string, NewerAgentVersion>;
  /** Registry id → its last stored update check, for every installed CLI
   *  that has one. */
  updates: Record<string, AgentUpdateReport>;
  /** Registry id → the CLI's display name, from the same rows. */
  labels: Record<string, string>;
  /** `agent@latest` keys whose update card was closed with × this window. */
  hiddenUpdates: Record<string, true>;
  /** Registry ids closed with × this window: gone from every tab until the
   *  next start, without claiming the release was looked at. */
  hidden: Record<string, true>;
  load: () => Promise<void>;
  update: (rows: VersionReport[]) => void;
  /** × on a card. */
  hide: (agent: string) => void;
  /** "Don't remind me for this version" — persisted per version, so the next
   *  release raises it again. */
  dismiss: (agent: string) => Promise<void>;
  /** × on a tab's update card: that release stays quiet until restart. */
  hideUpdate: (agent: string, latest: string) => void;
  /** The same version was dismissed elsewhere (Manage Agents). */
  noteDismissed: (agent: string, version: string) => void;
}

/** The notice a report calls for, or null when it is not newer drift. */
export function newerNotice(report: VersionReport): NewerAgentVersion | null {
  if (report.state !== "moved" || report.dismissed || !report.version) return null;
  if (FRONTEND_VERIFIED[report.agent] === report.version) return null;
  const newer = report.stale.filter((note) => note.direction === "newer");
  if (newer.length === 0) return null;
  // `stale` is oldest-verified first; the newest one is the closest check.
  return {
    agent: report.agent,
    label: report.label,
    installed: report.version,
    verified: newer[newer.length - 1].version,
  };
}

let inflight: Promise<void> | null = null;

export const useAgentVersionNoticeStore = create<AgentVersionNoticeStore>((set, get) => ({
  newer: {},
  hidden: {},
  updates: {},
  labels: {},
  hiddenUpdates: {},
  load: () => {
    inflight ??= invoke<VersionReport[]>("agent_versions", { refresh: false })
      .then((rows) => get().update(rows))
      .catch(() => {
        // No version answer is no notice; the settings row still shows why.
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
  update: (rows) => {
    const newer: Record<string, NewerAgentVersion> = {};
    const updates: Record<string, AgentUpdateReport> = {};
    const labels: Record<string, string> = {};
    for (const row of rows) {
      labels[row.agent] = row.label;
      const notice = newerNotice(row);
      if (notice) newer[notice.agent] = notice;
      if (row.update) updates[row.agent] = row.update;
    }
    set({ newer, updates, labels });
  },
  hideUpdate: (agent, latest) =>
    set((state) => ({ hiddenUpdates: { ...state.hiddenUpdates, [`${agent}@${latest}`]: true } })),
  hide: (agent) => set((state) => ({ hidden: { ...state.hidden, [agent]: true } })),
  dismiss: async (agent) => {
    const notice = get().newer[agent];
    if (!notice) return;
    get().noteDismissed(agent, notice.installed);
    try {
      await invoke("dismiss_agent_version", { agent, version: notice.installed });
    } catch {
      // A dismissal that did not stick costs one more notice, nothing else.
    }
  },
  noteDismissed: (agent, version) =>
    set((state) => {
      if (state.newer[agent]?.installed !== version) return state;
      const { [agent]: _drop, ...rest } = state.newer;
      return { newer: rest };
    }),
}));

/** The release a tab's update card offers: a stored check found one newer
 *  than what is installed now, and × has not hidden it this window. */
export function offeredUpdate(state: AgentVersionNoticeStore, agent: string): AgentUpdateReport | null {
  const update = state.updates[agent];
  if (!update?.updateAvailable || !update.latest || !update.current) return null;
  if (state.hiddenUpdates[`${agent}@${update.latest}`]) return null;
  return update;
}

/** The newest stored check among `agents` (Unix seconds), or null. */
export function lastUpdateCheck(updates: Record<string, AgentUpdateReport>, agents: string[]): number | null {
  let last: number | null = null;
  for (const id of agents) {
    const at = updates[id]?.checkedAt;
    if (at && (last === null || at > last)) last = at;
  }
  return last;
}

/** Re-read on the backend's daily-check broadcast, for a component's
 *  lifetime. Reads share one request, so several subscribers cost one. */
export function subscribeAgentUpdates(): () => void {
  return subscribeTauri(() =>
    listen(AGENT_UPDATES_CHECKED_EVENT, () => void useAgentVersionNoticeStore.getState().load()),
  );
}

/** Test hook: forget the window's read. */
export function resetAgentVersionNotice() {
  inflight = null;
  useAgentVersionNoticeStore.setState({ newer: {}, hidden: {}, updates: {}, labels: {}, hiddenUpdates: {} });
}
