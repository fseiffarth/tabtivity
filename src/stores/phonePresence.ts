import { useCallback } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { MOBILE_HOST_KEY } from "../lib/brand";
import { usePoll } from "../lib/usePoll";
import { useSettingsStore } from "./settings";

/**
 * Where the paired phones are right now, for the 📱 marks on project pills and
 * tabs: the sidecar's admin `presence` answer (`services::mobile_control::
 * presence`). A project counts while a phone's project screen keeps reading it
 * (about 12 s after the last read) or a phone holds one of its tabs; a tab
 * counts while a phone holds its terminal, `watched` only while that phone's
 * page is on screen.
 *
 * One poll for the window (`usePhonePresencePoll`, mounted by the project
 * strip), and only while Mobile is switched on. A sidecar that does not know
 * the request, or is not running, leaves no mark.
 */

/** One phone in a scope or tab. */
export interface PhoneHere {
  name: string;
  /** Its page is on screen; false = the tab is held by a pocketed phone. */
  watched: boolean;
}

interface ProjectRow {
  project_id: string;
  device_id: string;
  device_name: string;
}

interface TabRow extends ProjectRow {
  tmux_session: string;
  watched: boolean;
}

type PresenceAnswer = { status: "presence"; projects: ProjectRow[]; tabs: TabRow[] } | { status: string };

interface PhonePresenceStore {
  /** By the desktop's scope id. */
  byProject: Record<string, PhoneHere[]>;
  /** By tmux session name (`TabEntry.tmuxSession`). */
  byTmux: Record<string, PhoneHere[]>;
  refresh: () => Promise<void>;
  clear: () => void;
}

/** How often the window asks; the sidecar answers from memory. */
export const PHONE_PRESENCE_POLL_MS = 4_000;

/** One entry per phone, watching if any of its rows is. */
function add(into: Record<string, Map<string, PhoneHere>>, key: string, id: string, name: string, watched: boolean) {
  const phones = (into[key] ??= new Map());
  const known = phones.get(id);
  phones.set(id, { name, watched: watched || (known?.watched ?? false) });
}

function settle(rows: Record<string, Map<string, PhoneHere>>): Record<string, PhoneHere[]> {
  return Object.fromEntries(
    Object.entries(rows).map(([key, phones]) => [
      key,
      [...phones.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ]),
  );
}

/** Builds both maps from the sidecar's rows. Exported for tests. */
export function presenceMaps(projects: ProjectRow[], tabs: TabRow[]): Pick<PhonePresenceStore, "byProject" | "byTmux"> {
  const byProject: Record<string, Map<string, PhoneHere>> = {};
  const byTmux: Record<string, Map<string, PhoneHere>> = {};
  for (const row of projects) add(byProject, row.project_id, row.device_id, row.device_name, true);
  for (const row of tabs) {
    add(byTmux, row.tmux_session, row.device_id, row.device_name, row.watched);
    add(byProject, row.project_id, row.device_id, row.device_name, row.watched);
  }
  return { byProject: settle(byProject), byTmux: settle(byTmux) };
}

const EMPTY = { byProject: {}, byTmux: {} };
const NONE: PhoneHere[] = [];

export const usePhonePresenceStore = create<PhonePresenceStore>((set, get) => ({
  ...EMPTY,
  refresh: async () => {
    let next: Pick<PhonePresenceStore, "byProject" | "byTmux"> = EMPTY;
    try {
      const answer = await invoke<PresenceAnswer>("mobile_admin", { request: { type: "presence" } });
      if (answer?.status === "presence" && "projects" in answer) {
        next = presenceMaps(answer.projects ?? [], answer.tabs ?? []);
      }
    } catch {
      // Sidecar down or older than the request: no marks, never a guess.
    }
    const now = get();
    if (JSON.stringify(now.byProject) === JSON.stringify(next.byProject)
      && JSON.stringify(now.byTmux) === JSON.stringify(next.byTmux)) return;
    set(next);
  },
  clear: () => set(EMPTY),
}));

/** The window's one presence poll; mounted once, by the project strip. */
export function usePhonePresencePoll(): void {
  const enabled = useSettingsStore((s) => s.settings?.[MOBILE_HOST_KEY]?.enabled ?? false);
  const run = useCallback(async () => {
    if (enabled) await usePhonePresenceStore.getState().refresh();
    else usePhonePresenceStore.getState().clear();
  }, [enabled]);
  // Keeps going, slower, while the window is blurred: the phone is in use
  // exactly when nobody is at the desktop, and the marks should be right the
  // moment someone looks.
  usePoll(run, PHONE_PRESENCE_POLL_MS, { onBlur: "widen" });
}

/** The phones in a scope (`[]` when none). */
export function usePhonesInProject(scope: string): PhoneHere[] {
  return usePhonePresenceStore((s) => s.byProject[scope] ?? NONE);
}

/** The phones holding a tab's terminal (`[]` when none or no tmux session). */
export function usePhonesOnTab(tmuxSession: string | undefined): PhoneHere[] {
  return usePhonePresenceStore((s) => (tmuxSession ? s.byTmux[tmuxSession] : undefined) ?? NONE);
}
