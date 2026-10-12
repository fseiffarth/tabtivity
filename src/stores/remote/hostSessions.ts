import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { startPoll, type Poll } from "../../lib/usePoll";
import { useProjectsStore } from "../projects";
import { PRIMARY_HOST, sshOf, useRemoteStatusStore } from "./remoteStatus";
import type { ProjectEntry } from "../../types";

/**
 * The project's **persistent (tmux) sessions**, as ONE shared reading (TODO #85).
 *
 * The Sessions view is not a single surface: the same `ProjectFilesView` is
 * rendered by the side panel, by every Files (Project) tab, and by every
 * subwindow's docked file column — in the main window and in each popout. Each
 * of those instances used to own the list, the `tmux ls` poll and the "show all
 * sessions" toggle privately, which meant N SSH round trips per host every 7 s
 * and N answers that could disagree: a session killed in the docked column sat
 * on in the side panel until *its* interval came round, and the toggle set in
 * one surface said nothing about the other. Sessions are a property of the
 * **host**, not of the surface looking at it, so they live here instead.
 *
 * Three consequences worth stating:
 *
 *  - **One poll per project, however many viewers are open.** Subscribers are
 *    refcounted (`retain`/`release`, via `useHostSessions`); the interval and the
 *    connectivity subscription exist only while at least one surface is showing.
 *    A background tab / closed panel passes `enabled: false` and costs nothing,
 *    which is the same gate the old per-instance `active` check applied.
 *  - **A kill or a rename updates every surface in the same frame** — it edits
 *    this list, not one component's copy — and the next poll merely reconciles.
 *  - **The `showAll` escape hatch is shared too**, deliberately. It changes what
 *    the *backend* returns (project-scoped vs. the host's whole listing), so a
 *    per-surface flag would need a second poll per value, and two viewers of one
 *    project would answer "what is running here?" differently.
 *
 * Deliberately NOT folded into `stores/remote/hostBusy`, which reads the same `tmux ls`:
 * that reading is machine-wide and keyed by SSH target (it answers "is this
 * machine working?" for a lamp shared with the header and every pill), while this
 * one is scoped to a project by default. Feeding a project-filtered count into it
 * would make a busy host look idle.
 */

/** One host tmux session, mirroring the backend `TmuxSession`. */
export interface TmuxSession {
  name: string;
  windows: number;
  /** Creation time, seconds since the Unix epoch (host clock). */
  created: number;
  attached: boolean;
  /** Last activity time, seconds since the Unix epoch (host clock). */
  activity: number;
  /** The active pane's current foreground command (e.g. `python`, or a shell
   *  name when idling at the prompt). */
  currentCommand: string;
  /** False when the active pane is sitting at a bare shell prompt. */
  working: boolean;
  /** The active pane's working directory on the host (empty when the host's
   *  `tmux ls` did not report it). What attributes a session whose *name* has no
   *  project id — every pre-scoping and hand-started one — to a project. */
  currentPath: string;
}

/** A session row: the session plus which host (primary or worker) runs it. */
export interface SessionRow {
  hostId: string;
  hostLabel: string;
  session: TmuxSession;
}

/** A project host in the Sessions view: its id and how it is labelled. */
export interface SessionHost {
  id: string;
  label: string;
}

/** How often the shared poll re-reads each connected host. Sessions change
 *  mostly through Tabtivity itself (a kill or rename edits this list at once, a
 *  new tab's session shows on the next reading) or out in another app, which
 *  the window's regaining focus re-reads for (`FOCUS_REFRESH_MIN_MS`); the
 *  timer is the backstop, one `ssh` per host every 20 s while a view shows. */
export const HOST_SESSIONS_POLL_MS = 20_000;
/** A window focus re-reads at once unless a reading started this recently. */
export const FOCUS_REFRESH_MIN_MS = 5_000;

/** Stable empty reading, so a project with no entry yet doesn't hand
 *  `useSyncExternalStore` a fresh array on every render (the loop `tabsByScope`
 *  readers document). */
const EMPTY: SessionRow[] = [];

/** The hosts a project's Sessions view covers: the primary first, then each
 *  extra worker machine. Exported so the view groups rows in the same order the
 *  poll walks them, from one derivation rather than two. */
export function sessionHostsOf(project: ProjectEntry | null | undefined): SessionHost[] {
  if (!project?.remote) return [];
  const hosts: SessionHost[] = [{ id: PRIMARY_HOST, label: project.remote.host }];
  for (const w of project.compute_hosts ?? [])
    hosts.push({ id: w.id, label: w.label || w.host || w.id });
  return hosts;
}

interface HostSessionsStore {
  /** Last reading per project id. */
  byProject: Record<string, SessionRow[]>;
  /** The shared "list every session on the host, not just this project's"
   *  toggle, per project id. */
  showAll: Record<string, boolean>;

  /** Start (or join) the shared poll for a project. Paired with `release`. */
  retain: (projectId: string) => void;
  /** Drop one subscriber; the poll stops when the last one leaves. */
  release: (projectId: string) => void;
  /** Poll now. `force` re-polls even with a request already in flight — used when
   *  the *question* changed (a host connected, `showAll` flipped), where waiting
   *  for the in-flight answer would return the wrong list. */
  refresh: (projectId: string, force?: boolean) => Promise<void>;
  setShowAll: (projectId: string, showAll: boolean) => void;
  /** Drop a killed session from the shared list (every surface, one frame). */
  dropRow: (projectId: string, hostId: string, name: string) => void;
  /** Rename a session in the shared list. */
  renameRow: (projectId: string, hostId: string, oldName: string, newName: string) => void;
}

/** Subscriber count per project — the poll runs iff this is ≥ 1. */
const refs = new Map<string, number>();
/** The live poll handles per project (the quiesce-aware poll — it also does the
 *  focus re-read — and the connectivity subscription). */
const polls = new Map<string, { poll: Poll; unsub: () => void }>();
/** When the last reading of each project started (`Date.now()`). */
const lastRead = new Map<string, number>();
/** In-flight request count per project, so the interval never stacks round trips. */
const inFlight = new Map<string, number>();
/** Bumped whenever an in-flight answer stops being the answer to the current
 *  question (`showAll` flipped, the last subscriber left) — a late reply whose
 *  generation moved is dropped rather than written over a newer one. */
const gens = new Map<string, number>();

/** A connectivity signature over a project's hosts, so the poll re-runs the
 *  moment one connects instead of up to `HOST_SESSIONS_POLL_MS` later. The host *set* is read
 *  fresh on every call rather than subscribed to separately: adding or removing a
 *  worker writes that host's lamp (`setSsh` / `clearHost`), so the signature moves
 *  with it, and a host that somehow changed without touching its lamp is picked up
 *  by the next tick. */
function connSig(projectId: string): string {
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  const st = useRemoteStatusStore.getState();
  return sessionHostsOf(project)
    .map((h) => `${h.id}:${sshOf(st, projectId, h.id)}`)
    .join("|");
}

export const useHostSessionsStore = create<HostSessionsStore>((set, get) => ({
  byProject: {},
  showAll: {},

  retain: (projectId) => {
    const n = (refs.get(projectId) ?? 0) + 1;
    refs.set(projectId, n);
    if (n > 1) return; // another surface already drives the poll
    void get().refresh(projectId, true);
    let lastSig = connSig(projectId);
    const unsub = useRemoteStatusStore.subscribe(() => {
      const sig = connSig(projectId);
      if (sig === lastSig) return;
      lastSig = sig;
      void get().refresh(projectId, true);
    });
    // Every HOST_SESSIONS_POLL_MS while the window is in front (`lib/usePoll`:
    // stopped while blurred or hidden); a return to the window re-reads at
    // once unless any reading — this poll's or a forced one — started within
    // FOCUS_REFRESH_MIN_MS.
    const poll = startPoll(() => get().refresh(projectId), HOST_SESSIONS_POLL_MS, {
      immediate: false,
      catchUpAfterMs: FOCUS_REFRESH_MIN_MS,
      lastRunAt: () => lastRead.get(projectId) ?? 0,
    });
    polls.set(projectId, { poll, unsub });
  },

  release: (projectId) => {
    const n = (refs.get(projectId) ?? 0) - 1;
    if (n > 0) {
      refs.set(projectId, n);
      return;
    }
    refs.delete(projectId);
    const handle = polls.get(projectId);
    if (handle) {
      handle.poll.stop();
      handle.unsub();
      polls.delete(projectId);
    }
    gens.set(projectId, (gens.get(projectId) ?? 0) + 1);
    // The last reading is deliberately KEPT. A surface reopening shows it at once
    // and `retain` re-polls in the same breath, which beats blanking the list —
    // an empty Sessions view does not read as "not looked at yet", it reads as
    // "nothing is running", and that is the one thing it must never say wrongly.
  },

  refresh: async (projectId, force = false) => {
    if (!force && (inFlight.get(projectId) ?? 0) > 0) return;
    const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
    const hosts = sessionHostsOf(project);
    const st = useRemoteStatusStore.getState();
    const connected = hosts.filter((h) => sshOf(st, projectId, h.id) === "connected");
    if (connected.length === 0) {
      // Idempotent: write the (shared, stable) empty reading once, then no-op —
      // "we looked and there is nothing" is a different state from "we never
      // looked", but re-writing it every tick would churn every subscriber.
      set((s) =>
        s.byProject[projectId]?.length === 0
          ? {}
          : { byProject: { ...s.byProject, [projectId]: EMPTY } },
      );
      return;
    }
    const gen = gens.get(projectId) ?? 0;
    const includeAll = get().showAll[projectId] ?? false;
    lastRead.set(projectId, Date.now());
    inFlight.set(projectId, (inFlight.get(projectId) ?? 0) + 1);
    try {
      const lists = await Promise.all(
        connected.map((h) =>
          invoke<TmuxSession[]>("remote_tmux_list", { projectId, hostId: h.id, includeAll })
            .then((ss) => ss.map((session) => ({ hostId: h.id, hostLabel: h.label, session })))
            // A host whose read FAILED contributes `null`, not an empty list. The
            // two are the same shape and mean opposite things, and the empty one
            // is exactly what the view must never say wrongly — the same rule
            // `release` keeps the last reading for. This probe spawns its own
            // `ssh` on the shared ControlMaster socket, so a socket being
            // replaced under it (or any transient drop) fails one tick and
            // succeeds on the next, which used to blank the Sessions view for 7 s
            // and report "no persistent sessions on the host".
            .catch(() => null),
        ),
      );
      // Superseded (the question changed) or nobody left watching: don't write.
      if ((gens.get(projectId) ?? 0) !== gen || !refs.get(projectId)) return;
      set((s) => {
        const prev = s.byProject[projectId] ?? EMPTY;
        const rows = lists.flatMap((list, i) =>
          // Carry the failed host's previous rows forward untouched; every other
          // host is replaced by what it just reported.
          list ?? prev.filter((r) => r.hostId === connected[i].id),
        );
        return { byProject: { ...s.byProject, [projectId]: rows } };
      });
    } finally {
      const left = (inFlight.get(projectId) ?? 1) - 1;
      if (left > 0) inFlight.set(projectId, left);
      else inFlight.delete(projectId);
    }
  },

  setShowAll: (projectId, showAll) => {
    if ((get().showAll[projectId] ?? false) === showAll) return;
    set((s) => ({ showAll: { ...s.showAll, [projectId]: showAll } }));
    gens.set(projectId, (gens.get(projectId) ?? 0) + 1);
    void get().refresh(projectId, true);
  },

  dropRow: (projectId, hostId, name) =>
    set((s) => {
      const rows = s.byProject[projectId];
      if (!rows) return {};
      const next = rows.filter((r) => !(r.hostId === hostId && r.session.name === name));
      return next.length === rows.length ? {} : { byProject: { ...s.byProject, [projectId]: next } };
    }),

  renameRow: (projectId, hostId, oldName, newName) =>
    set((s) => {
      const rows = s.byProject[projectId];
      if (!rows) return {};
      return {
        byProject: {
          ...s.byProject,
          [projectId]: rows.map((r) =>
            r.hostId === hostId && r.session.name === oldName
              ? { ...r, session: { ...r.session, name: newName } }
              : r,
          ),
        },
      };
    }),
}));

/**
 * Subscribe a surface to a project's shared session list for as long as it is
 * showing. `enabled` is the old per-instance `active` gate: a background tab or a
 * closed panel simply doesn't retain, so it neither polls nor keeps the poll
 * alive for the others.
 */
export function useHostSessions(projectId: string | null, enabled: boolean): SessionRow[] {
  useEffect(() => {
    if (!enabled || !projectId) return;
    const { retain, release } = useHostSessionsStore.getState();
    retain(projectId);
    return () => release(projectId);
  }, [projectId, enabled]);
  // Select the stored array (stable) or `undefined` (stable) and default OUTSIDE
  // the selector — a selector minting a fresh `[]` loops `useSyncExternalStore`.
  return useHostSessionsStore((s) => (projectId ? s.byProject[projectId] : undefined)) ?? EMPTY;
}

/** The shared "show every session on the host" toggle for a project. */
export function useShowAllSessions(projectId: string | null): [boolean, (v: boolean) => void] {
  const showAll = useHostSessionsStore((s) => (projectId ? (s.showAll[projectId] ?? false) : false));
  return [
    showAll,
    (v: boolean) => {
      if (projectId) useHostSessionsStore.getState().setShowAll(projectId, v);
    },
  ];
}
