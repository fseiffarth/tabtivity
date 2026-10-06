import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

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
 */

/** Backend `services::agent_versions::StaleNote`. */
interface StaleNote {
  version: string;
  surface: string;
  direction: "newer" | "older" | "different";
}

/** The fields of backend `VersionReport` this notice reads. */
interface VersionReport {
  agent: string;
  label: string;
  version: string | null;
  state: "match" | "moved" | "unverified" | "unknown";
  stale: StaleNote[];
  dismissed: boolean;
}

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
  claude: "2.1.291",
  codex: "0.159.3",
};

interface AgentVersionNoticeStore {
  /** Registry id → the notice to show, only for CLIs newer than verified. */
  newer: Record<string, NewerAgentVersion>;
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
    for (const row of rows) {
      const notice = newerNotice(row);
      if (notice) newer[notice.agent] = notice;
    }
    set({ newer });
  },
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

/** Test hook: forget the window's read. */
export function resetAgentVersionNotice() {
  inflight = null;
  useAgentVersionNoticeStore.setState({ newer: {}, hidden: {} });
}
