import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { create } from "zustand";
import type { ProjectBox } from "../types";
import { resolveProjectDirectory } from "../types";
import { restoreProjectScope, useProjectsStore } from "./projects";
import { cmdToKind, hydrateScopeFromDisk, useTabsStore } from "./tabs";
import { BOX_SCOPE_PREFIX } from "../lib/terminal/ptyId";
import { isBoxColor } from "../lib/theme/boxColor";

// Re-exported, not redeclared: the PTY-id parser needs the same constant and
// cannot import this module (it would be a cycle through stores/tabs), so the
// literal lives in the leaf and everything else reads it from here as before.
export { BOX_SCOPE_PREFIX } from "../lib/terminal/ptyId";

export function boxScopeId(boxId: string): string {
  return `${BOX_SCOPE_PREFIX}${boxId}`;
}

/**
 * The box folder behind a `box:<id>` scope, or "" for any other scope / a box
 * with no folder yet. New tabs opened while a box scope is active default here
 * (CenterPanel's `newTabCwd`), not to the previously active project's dir.
 */
export function boxFolderOfScope(scope: string, boxes: ProjectBox[]): string {
  if (!scope.startsWith(BOX_SCOPE_PREFIX)) return "";
  return boxes.find((b) => boxScopeId(b.id) === scope)?.folder ?? "";
}

/**
 * Membership is N:M now (a project may be in several boxes at once); the box
 * `member_ids` lists are the ONLY membership record — the old per-project
 * `box_id` denormalization is gone, and any stale persisted `box_id` keys are
 * stripped in-memory on load so the next `save_projects` drops them. This pure
 * selector derives project id → the ids of every box holding it.
 */
export function boxMembership(boxes: ProjectBox[]): Map<string, string[]> {
  const membership = new Map<string, string[]>();
  for (const box of boxes) {
    for (const memberId of box.member_ids) {
      const list = membership.get(memberId);
      if (list) list.push(box.id);
      else membership.set(memberId, [box.id]);
    }
  }
  return membership;
}

/** Memoized [`boxMembership`] over the live boxes list (recomputed only when
 *  the boxes array identity changes). */
export function useBoxMembership(): Map<string, string[]> {
  const boxes = useBoxesStore((s) => s.boxes);
  return useMemo(() => boxMembership(boxes), [boxes]);
}

/** Strip a stale persisted `box_id` key from every project (in-memory only; the
 *  next `save_projects` then drops it from disk). Membership never lives there. */
function stripBoxIds<T extends { id: string }>(projects: T[]): T[] {
  let changed = false;
  const next = projects.map((p) => {
    if (!("box_id" in p)) return p;
    changed = true;
    const { box_id: _drop, ...rest } = p as T & { box_id?: unknown };
    return rest as T;
  });
  return changed ? next : projects;
}

interface BoxesStore {
  boxes: ProjectBox[];
  loaded: boolean;
  /** Load boxes; strips any stale persisted `box_id` off the in-memory projects. */
  load: () => Promise<void>;
  createBox: (name: string) => Promise<ProjectBox>;
  renameBox: (boxId: string, name: string) => Promise<void>;
  /** Delete (dissolve) a box. Members are untouched — they simply stop being in it. */
  deleteBox: (boxId: string) => Promise<void>;
  /** ADD a project to a box. Additive: other memberships are kept (N:M). */
  addToBox: (projectId: string, boxId: string) => Promise<void>;
  /** Remove a project from ONE box. No silent dissolve — a 1/0-member box survives. */
  removeFromBox: (projectId: string, boxId: string) => Promise<void>;
  /** Set a box's full member list (the box editor's Save). */
  setBoxMembers: (boxId: string, memberIds: string[]) => Promise<void>;
  /** Switch the box's Tabtivity Mobile reach (#31aa) — the box twin of
   *  `projects.setProjectMobileAccess`. Enabling resolves the box folder on
   *  the backend, so the returned record carries `folder` too. */
  setBoxMobileAccess: (boxId: string, enabled: boolean) => Promise<void>;
  /** Set the box's colour (`#rrggbb`), or `undefined` to go back to the colour
   *  hashed from its id. */
  setBoxColor: (boxId: string, color: string | undefined) => Promise<void>;
  /** Hide the box's pill from the header row (it stays in the scope chip's
   *  list), or show it again. */
  setBoxPillHidden: (boxId: string, hidden: boolean) => Promise<void>;
  /** Multi-select commit: put `ids` into a new box (`name`) or append to `boxId`. */
  boxProjects: (
    ids: string[],
    target: { name?: string; boxId?: string },
  ) => Promise<ProjectBox | null>;
  /** Open a box: restore closed members' tabs (box-local — persisted status
   *  untouched), ensure the box folder exists, and activate the box's
   *  persisted scope. */
  openBox: (boxId: string) => Promise<void>;
}

/**
 * First-entry hydration of a `box:<id>` scope (called from CenterPanel's
 * box-restore effect): load the saved tabs from `<state_dir>/sessions/box_<id>/`
 * and hydrate the scope; when nothing restorable was saved, seed one shell at
 * the box folder. Standalone (not a store action) so the restore/seed decision
 * is unit-testable without rendering CenterPanel. The seed only fires while the
 * box scope is still current and unhydrated — `addTab` targets the CURRENT
 * scope, and the user may have navigated away while the load was in flight.
 */
export async function restoreBoxScope(scope: string): Promise<void> {
  if (!scope.startsWith(BOX_SCOPE_PREFIX)) return;
  if (scope in useTabsStore.getState().tabsByScope) return;
  const boxId = scope.slice(BOX_SCOPE_PREFIX.length);
  const box = useBoxesStore.getState().boxes.find((b) => b.id === boxId);
  const folder = box?.folder ?? "";
  const seedShell = () => {
    const tabsStore = useTabsStore.getState();
    if (tabsStore.scope !== scope) return;
    if (scope in tabsStore.tabsByScope) return;
    if (!folder || !box) return;
    tabsStore.addTab(
      { label: box.name, cmd: "", args: [], env: {}, cwd: folder, kind: "shell" },
      { seeded: true },
    );
  };
  try {
    // The shared hydration path (also the fix for saved custom-agent tabs,
    // which the hand-rolled copy here dropped by omitting `resumeArgs` from
    // the restorable probe). False → nothing restorable was saved → seed.
    // Member roots are places a restored agent tab may keep as its cwd: the
    // per-member Claude tab starts there on purpose, and resetting it to the
    // box folder put the agent in the wrong directory on every relaunch.
    const agentRoots = boxMembersOfScope(
      scope,
      useBoxesStore.getState().boxes,
      useProjectsStore.getState().projects,
    ).map((m) => m.dir);
    if (!(await hydrateScopeFromDisk(scope, folder, { agentRoots }))) seedShell();
  } catch {
    seedShell();
  }
}

/** Best-effort regeneration of the agent docs (member link blocks + symlinks)
 *  for each named box that has been opened (has a folder). Never blocks the
 *  membership change that triggered it. */
async function refreshDocsFor(boxes: ProjectBox[], boxIds: string[]): Promise<void> {
  for (const id of new Set(boxIds)) {
    const box = boxes.find((b) => b.id === id);
    if (box?.folder) {
      await invoke<void>("refresh_box_agent_docs", { boxId: id }).catch(() => {});
    }
  }
}

/**
 * The whole-list save, adopting the revisions the backend stamped: a box this
 * save changed moves on a revision in the file, and a store still holding the
 * old number would have its next save refused as stale (`BOXES_STALE`) — the
 * second box edit of a window session never landed. Only `rev` is taken back,
 * so an edit made while the save was in flight is not overwritten.
 */
async function saveBoxes(boxes: ProjectBox[]): Promise<void> {
  const written = await invoke<ProjectBox[] | null | undefined>("save_boxes", { boxes });
  adoptRevisions(written);
}

function adoptRevisions(written: ProjectBox[] | null | undefined): void {
  // A backend from before answers nothing; there is nothing to adopt.
  if (!Array.isArray(written)) return;
  const revs = new Map(written.map((b) => [b.id, b.rev]));
  useBoxesStore.setState((state) => {
    let changed = false;
    const boxes = state.boxes.map((b) => {
      const rev = revs.get(b.id);
      if (rev === undefined || rev === b.rev) return b;
      changed = true;
      return { ...b, rev };
    });
    return changed ? { boxes } : {};
  });
}

export const useBoxesStore = create<BoxesStore>((set, get) => ({
  boxes: [],
  loaded: false,

  load: async () => {
    const boxes = await invoke<ProjectBox[]>("get_boxes").catch(() => [] as ProjectBox[]);
    set({ boxes, loaded: true });
    // Membership is `member_ids`-only now. Strip any stale persisted `box_id`
    // off the in-memory projects (no write here; the next save_projects drops
    // the keys from disk).
    useProjectsStore.setState((state) => ({
      projects: stripBoxIds(state.projects),
    }));
  },

  createBox: async (name) => {
    const box = await invoke<ProjectBox>("create_box", { name });
    set((state) => ({ boxes: [...state.boxes, box] }));
    return box;
  },

  renameBox: async (boxId, name) => {
    const updated = await invoke<ProjectBox>("rename_box", { boxId, name });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? updated : b)),
    }));
  },

  deleteBox: async (boxId) => {
    await invoke<void>("delete_box", { boxId });
    set((state) => ({ boxes: state.boxes.filter((b) => b.id !== boxId) }));
    // Members are untouched: membership lives only in the (now-deleted) box's
    // member_ids, so there is no back-reference to clear anywhere.
  },

  addToBox: async (projectId, boxId) => {
    // ADDITIVE (N:M): the project keeps every other membership; only the target
    // box's member list changes, and only if the project isn't in it already.
    let updated: ProjectBox | null = null;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId || b.member_ids.includes(projectId)) return b;
        updated = { ...b, member_ids: [...b.member_ids, projectId] };
        return updated;
      }),
    }));
    if (!updated) return;
    await saveBoxes(get().boxes);
    await refreshDocsFor(get().boxes, [boxId]);
  },

  removeFromBox: async (projectId, boxId) => {
    // NO silent dissolve: a box left with one or zero members survives (and
    // still renders, dimmed when empty). Dissolving is the box editor's
    // explicit, confirmed action (`deleteBox`).
    let changed = false;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId || !b.member_ids.includes(projectId)) return b;
        changed = true;
        return { ...b, member_ids: b.member_ids.filter((id) => id !== projectId) };
      }),
    }));
    if (!changed) return;
    await saveBoxes(get().boxes);
    await refreshDocsFor(get().boxes, [boxId]);
  },

  setBoxMembers: async (boxId, memberIds) => {
    const updated = await invoke<ProjectBox>("set_box_members", { boxId, memberIds });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? updated : b)),
    }));
    await refreshDocsFor(get().boxes, [boxId]);
  },

  setBoxMobileAccess: async (boxId, enabled) => {
    const updated = await invoke<ProjectBox>("set_box_mobile_access", { boxId, enabled });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? updated : b)),
    }));
  },

  setBoxColor: async (boxId, color) => {
    const next = isBoxColor(color) ? color.toLowerCase() : undefined;
    let changed = false;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId || b.color === next) return b;
        changed = true;
        const { color: _drop, ...rest } = b;
        return next ? { ...rest, color: next } : rest;
      }),
    }));
    if (!changed) return;
    await saveBoxes(get().boxes);
  },

  setBoxPillHidden: async (boxId, hidden) => {
    let changed = false;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId || !!b.hide_pill === hidden) return b;
        changed = true;
        // Absent from disk while shown, like `tabtivity_mobile_access` while off.
        const { hide_pill: _drop, ...rest } = b;
        return hidden ? { ...rest, hide_pill: true } : rest;
      }),
    }));
    if (!changed) return;
    await saveBoxes(get().boxes);
  },

  boxProjects: async (ids, target) => {
    // Multi-select commit: a NEW box named `target.name` holding `ids`, or an
    // APPEND of `ids` to the existing `target.boxId` (deduplicated, additive).
    if (target.boxId) {
      const box = get().boxes.find((b) => b.id === target.boxId);
      if (!box) return null;
      const merged = [...box.member_ids, ...ids.filter((id) => !box.member_ids.includes(id))];
      await get().setBoxMembers(box.id, merged);
      return get().boxes.find((b) => b.id === box.id) ?? null;
    }
    const name = target.name ?? "";
    const box = await invoke<ProjectBox>("create_box", { name });
    set((state) => ({ boxes: [...state.boxes, box] }));
    await get().setBoxMembers(box.id, [...new Set(ids)]);
    return get().boxes.find((b) => b.id === box.id) ?? null;
  },

  openBox: async (boxId) => {
    const box = get().boxes.find((b) => b.id === boxId);
    if (!box) return;
    // Reopen closed members BOX-LOCALLY: entering a box restores the tabs of
    // members the user closed in the general pill strip, so their work is
    // reachable from the slice again — but it never flips their persisted
    // status. A project appears in the general strip only if it was already
    // there; globally it stays closed until an explicit activation. The slice
    // shows members regardless of status (ProjectSwitcher.visibleProjects).
    // `restoreProjectScope` is idempotent (existing scope key and in-flight
    // claims both no-op), sequential and fire-and-forget: nothing about
    // entering the box waits on a member's pty_spawns.
    {
      const closed = useProjectsStore
        .getState()
        .projects.filter((p) => p.status === "inactive" && box.member_ids.includes(p.id));
      if (closed.length > 0) {
        void (async () => {
          for (const p of closed) await restoreProjectScope(p).catch(() => {});
        })();
      }
    }
    // Flush the OUTGOING scope's layout before the switch: entering a box
    // cancels CenterPanel's 300 ms persist debounce (its cleanup clears the
    // timer and re-schedules for the box scope), so a tab opened/closed/moved
    // within 300 ms of this click was simply never written. `persistScope` is
    // scope-addressed, so it is safe however far the switch has progressed;
    // fire-and-forget like the root flush in `projects.setActive`. Leaving a
    // box scope is flushed by `setScope` itself (which also covers box→box
    // here, so only a non-box outgoing scope needs handling).
    const tabsStore = useTabsStore.getState();
    const outgoing = tabsStore.scope;
    if (outgoing !== boxScopeId(boxId) && !outgoing.startsWith(BOX_SCOPE_PREFIX)) {
      const localFile =
        useProjectsStore.getState().projects.find((p) => p.id === outgoing)?.local_file ?? "";
      void tabsStore.persistScope(outgoing, localFile).catch(() => {});
    }
    // Lazily create the box folder and capture the resolved path back into
    // state — with the revision a first open stamps, or the next whole-list
    // save is refused as stale. (A backend from before answers the folder
    // alone; it stamps nothing the store could adopt.)
    const answer = await invoke<ProjectBox | string>("ensure_box_folder", { boxId });
    const folder = typeof answer === "string" ? answer : answer?.folder;
    const rev = typeof answer === "string" ? undefined : answer?.rev;
    set((state) => ({
      boxes: state.boxes.map((b) =>
        b.id === boxId ? { ...b, folder, ...(rev === undefined ? {} : { rev }) } : b,
      ),
    }));
    // Activate the box scope (disjoint from project ids / "root"). Box scopes
    // are persisted first-class now: CenterPanel's box-restore effect loads the
    // saved tabs from `<state_dir>/sessions/box_<id>/` on first entry (and
    // seeds one shell at the box folder when nothing restorable was saved), so
    // this action only switches the scope — seeding here too would race the
    // async restore.
    useTabsStore.getState().setScope(boxScopeId(boxId));
  },
}));

/**
 * Build the search-result rows for the switcher: inactive projects matching the
 * query plus boxes matching by name, as a discriminated union (N3).
 */
export type SearchRow =
  | { kind: "project"; project: import("../types").ProjectEntry }
  | { kind: "box"; box: ProjectBox };

/**
 * The active box scope's members with resolved roots, for surfaces that offer
 * per-member actions (the box "+" menu's "Files/Shell/agent — ⟨member⟩" rows).
 * Pure; [] outside a box scope or for an unknown box.
 */
export function boxMembersOfScope(
  scope: string,
  boxes: ProjectBox[],
  projects: import("../types").ProjectEntry[],
): { id: string; name: string; dir: string }[] {
  if (!scope.startsWith(BOX_SCOPE_PREFIX)) return [];
  const box = boxes.find((b) => boxScopeId(b.id) === scope);
  if (!box) return [];
  return box.member_ids
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({ id: p.id, name: p.name, dir: resolveProjectDirectory(p) }))
    .filter((m) => m.dir.length > 0);
}

// Re-export so consumers building box agent tabs can derive kinds consistently.
export { cmdToKind };
