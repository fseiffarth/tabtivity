import { create } from "zustand";
import type { ConnState } from "./remoteStatus";
import { storageKey } from "../../lib/brand";

/** Which side of a remote project a file view is showing. */
export type FileSourceSide = "local" | "remote";

/** Where an explicit Local/Remote choice is remembered across relaunches. */
const STORAGE_KEY = storageKey("fileSourceByProject");

/** Bound on the persisted map — a project the user never opens again must not
 *  keep a row forever. Oldest insertions are dropped first. */
const MAX_PERSISTED = 200;

/**
 * The side a project's file view opens on when nobody has chosen one yet:
 * connected (or mid-handshake, where it is heading) → the host tree over SFTP,
 * anything else → the local mirror, so a disconnected project browses its
 * offline copy instead of opening on a Connect prompt.
 */
export function autoFileSource(ssh: ConnState | undefined): FileSourceSide {
  return ssh === "connected" || ssh === "connecting" ? "remote" : "local";
}

/**
 * Whether the SSH lamp has settled enough for {@link autoFileSource} to be a
 * real decision rather than a guess about a handshake still in flight. Only a
 * settled reading is latched — `connecting` would freeze "remote" onto a
 * project that is about to fail, and an absent entry (an inactive project whose
 * status was cleared) says nothing at all yet.
 */
export function fileSourceSettled(ssh: ConnState | undefined): boolean {
  return ssh === "connected" || ssh === "off" || ssh === "error";
}

function readPersisted(): Record<string, FileSourceSide> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, FileSourceSide> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === "local" || v === "remote") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge one project's choice into the persisted map. Re-reads first, so two
 *  windows (main + a popout share one origin, hence one localStorage) can't
 *  clobber each other's rows with a stale in-memory snapshot. */
function persistChoice(projectId: string, source: FileSourceSide) {
  try {
    const stored = readPersisted();
    delete stored[projectId]; // re-insert last, so the cap drops the oldest
    stored[projectId] = source;
    const keys = Object.keys(stored);
    const kept = keys.length > MAX_PERSISTED ? keys.slice(keys.length - MAX_PERSISTED) : keys;
    const out: Record<string, FileSourceSide> = {};
    for (const k of kept) out[k] = stored[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // localStorage unavailable — the choice still holds for this session.
  }
}

/**
 * Which side (host over SFTP / local mirror) each remote project's file views
 * are showing — the memory that keeps a Local/Remote choice from being silently
 * re-decided.
 *
 * Two maps, because two things are being remembered and only one of them is the
 * user's own statement:
 *
 *  - `byProject` — the project-wide side, read by the side panel's tree
 *    (`useFileSource`) and used as the starting point for every other viewer.
 *    A row written by {@link FileSourcePrefStore.set} is an explicit click and
 *    is **persisted**; a row written by {@link FileSourcePrefStore.latch} is the
 *    auto default, session-only and never overwritten once present.
 *  - `byViewer` — the per-viewer side of the surfaces that own their own switch
 *    (each Files (Project) tab, each subwindow's docked column), keyed
 *    `<viewerId>\0<projectId>`. Session-only: a tab key / group id is re-minted
 *    on relaunch, so persisting one would only accumulate dead rows.
 *
 * The invariant both halves exist for: **a side is decided once and then only
 * ever changes because the user clicked the switch.** The seeding used to run in
 * a mount effect off the live SSH lamp, so anything that remounted a file view —
 * hiding and re-showing the panels, a scope switch, an activation that briefly
 * cleared the active project — silently re-derived the side and threw a Local
 * choice away the moment the pool was up. `latch` is a no-op when a row already
 * exists, which is what makes a remount cost nothing.
 */
interface FileSourcePrefStore {
  byProject: Record<string, FileSourceSide>;
  byViewer: Record<string, FileSourceSide>;
  /** The user picked a side for this project: remembered across relaunches. */
  set: (projectId: string, source: FileSourceSide) => void;
  /** Record the auto default, ONLY if this project has no side yet. */
  latch: (projectId: string, source: FileSourceSide) => void;
  /** The user picked a side in one viewer (this session, that viewer only). */
  setViewer: (viewerKey: string, source: FileSourceSide) => void;
  /** Record a viewer's starting side, ONLY if it has none yet. */
  latchViewer: (viewerKey: string, source: FileSourceSide) => void;
}

export const useFileSourcePrefStore = create<FileSourcePrefStore>((set) => ({
  byProject: readPersisted(),
  byViewer: {},
  set: (projectId, source) => {
    persistChoice(projectId, source);
    set((s) =>
      s.byProject[projectId] === source
        ? {}
        : { byProject: { ...s.byProject, [projectId]: source } },
    );
  },
  latch: (projectId, source) =>
    set((s) =>
      s.byProject[projectId] !== undefined
        ? {}
        : { byProject: { ...s.byProject, [projectId]: source } },
    ),
  setViewer: (viewerKey, source) =>
    set((s) =>
      s.byViewer[viewerKey] === source
        ? {}
        : { byViewer: { ...s.byViewer, [viewerKey]: source } },
    ),
  latchViewer: (viewerKey, source) =>
    set((s) =>
      s.byViewer[viewerKey] !== undefined
        ? {}
        : { byViewer: { ...s.byViewer, [viewerKey]: source } },
    ),
}));

/** The `byViewer` key for one viewer's view of one project. */
export function viewerSourceKey(viewerId: string, projectId: string): string {
  return `${viewerId}\u0000${projectId}`;
}
