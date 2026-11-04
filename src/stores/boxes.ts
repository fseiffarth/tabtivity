import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { create } from "zustand";
import type { ProjectBox } from "../types";
import { resolveProjectDirectory } from "../types";
import { restoreProjectScope, useProjectsStore } from "./projects";
import { cmdToKind, hydrateScopeFromDisk, ROOT_SCOPE, useTabsStore } from "./tabs";
import { BOX_SCOPE_PREFIX } from "../lib/terminal/ptyId";
import { isBoxColor } from "../lib/theme/boxColor";
import { isPathWithin } from "../lib/paths";
import type { useT } from "../lib/i18n";

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
  /** Why the last load failed; the boxes shown are then the last good copy. */
  loadError: string | null;
  /** Load boxes; strips any stale persisted `box_id` off the in-memory projects. */
  load: () => Promise<void>;
  createBox: (name: string) => Promise<ProjectBox>;
  /** The quick-create door's write: a new box named `name` that already holds
   *  `memberIds` and wears `color`, in one `create_box`. Against a backend from
   *  before those arguments existed it tops them up with the older calls, so the
   *  answer always shows what was asked. A name the rules refuse throws a
   *  {@link BoxNameError} before anything is sent. Does not enter the box
   *  (`useQuickCreateBox` does). */
  createBoxQuick: (opts: { name: string; memberIds?: string[]; color?: string }) => Promise<ProjectBox>;
  /** Save a box editor's draft as one diffed `patch_box` (name + the members
   *  added and removed against what the editor loaded, see {@link diffBoxMembers}):
   *  a member another window added meanwhile survives. Older backends refuse
   *  that shape; the save then falls back to `rename_box` + one singular
   *  `patch_box` per member. Throws on failure (a {@link BoxNameError} for a
   *  refused name) so the caller can show the reason; the store is only touched
   *  by the box as the file holds it after the write. An empty diff sends nothing. */
  saveBox: (boxId: string, diff: BoxDraftDiff) => Promise<ProjectBox>;
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
   *  the backend, so the returned record carries `folder` too. `devices` is
   *  the per-phone list: `null` reaches every paired phone, a list only those.
   *  Callers re-enabling or refreshing must pass the box's current list —
   *  `null` widens it to every phone. */
  setBoxMobileAccess: (boxId: string, enabled: boolean, devices: string[] | null) => Promise<void>;
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

/** One box edit as `patch_box` takes it. */
interface BoxPatch {
  /** Singular forms: every backend takes these. */
  addMember?: string;
  removeMember?: string;
  color?: string;
  hidePill?: boolean;
  /** Added with the box sheet's diffed save: an older backend refuses all three
   *  ("unknown field"). */
  name?: string;
  addMembers?: string[];
  removeMembers?: string[];
}

/** What a box editor changed: the new name and the member ids added and removed
 *  against the list it loaded (not against the live box, which may have moved). */
export interface BoxDraftDiff {
  name?: string;
  addMembers?: string[];
  removeMembers?: string[];
  /** The new colour (`#rrggbb`), or `""` for the one hashed from the id; absent
   *  leaves it. Compared with the box as the store holds it: no change, no write. */
  color?: string;
}

/** `loaded` (the members when the editor opened) to `draft` (its checklist) as
 *  the two lists a diffed save sends. Order of `draft` is kept; ids are unique. */
export function diffBoxMembers(loaded: readonly string[], draft: readonly string[]): { addMembers: string[]; removeMembers: string[] } {
  const was = new Set(loaded);
  const now = new Set(draft);
  return {
    addMembers: [...now].filter((id) => !was.has(id)),
    removeMembers: [...was].filter((id) => !now.has(id)),
  };
}

// ── Box names ─────────────────────────────────────────────────────────────────

/** The longest box name, in characters (mirrors `MAX_BOX_NAME_CHARS` in
 *  `src-tauri/src/commands/boxes.rs`). */
export const MAX_BOX_NAME_CHARS = 80;

export type BoxNameProblem = "empty" | "tooLong" | "invalid" | "taken";

/**
 * Why `name` cannot be written as the name of a box — the backend's
 * `clean_box_name`, repeated here because a backend from before the rule
 * accepts anything: empty after trimming, over {@link MAX_BOX_NAME_CHARS}
 * characters, a control character, or the name of another box (case-
 * insensitive; `ownId` is the box being renamed and may keep its own name).
 * Callers apply it to a name that is being written and differs from the stored
 * one only, so a legacy empty or duplicate name never blocks an unrelated save.
 */
export function boxNameProblem(name: string, boxes: readonly ProjectBox[], ownId?: string): BoxNameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if ([...trimmed].length > MAX_BOX_NAME_CHARS) return "tooLong";
  if (/\p{Cc}/u.test(trimmed)) return "invalid";
  const folded = trimmed.toLowerCase();
  if (boxes.some((b) => b.id !== ownId && b.name.trim().toLowerCase() === folded)) return "taken";
  return null;
}

const NAME_PROBLEM_TEXT: Record<BoxNameProblem, string> = {
  empty: "A box needs a name.",
  tooLong: `A box name has at most ${MAX_BOX_NAME_CHARS} characters.`,
  invalid: "A box name cannot contain control characters.",
  taken: "A box with that name already exists.",
};

/** A refused box name. `problem` picks the localized message
 *  (`useBoxNameCheck` maps it); `message` is the English fallback for a toast. */
export class BoxNameError extends Error {
  readonly problem: BoxNameProblem;
  constructor(problem: BoxNameProblem) {
    super(NAME_PROBLEM_TEXT[problem]);
    this.name = "BoxNameError";
    this.problem = problem;
  }
}

/**
 * The name a new box gets when the user has typed nothing: the first free
 * `label(n)` for n = 1, 2, … ("Box 1", "Box 2"), free meaning no box holds it
 * (case-insensitively). `label` is the localized "Box {n}".
 */
export function defaultBoxName(boxes: readonly ProjectBox[], label: (n: number) => string): string {
  const taken = new Set(boxes.map((b) => b.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = label(n);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Whether an invoke failure is a backend from before `patch_box` took `name` /
 *  `addMembers` / `removeMembers` (`deny_unknown_fields`): the running backend
 *  does not hot-reload, so the frontend must tolerate it. */
function isUnknownFieldRefusal(error: unknown): boolean {
  return /unknown field/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Save one box edit the store already shows (`patch_box`, applied to the box
 * as the file holds it — the browser client cannot run the whole-document
 * `save_boxes`). On a refusal or an error the box goes back to `before` and
 * the reason is shown; `false` then.
 */
async function persistBoxPatch(boxId: string, before: ProjectBox, patch: BoxPatch): Promise<boolean> {
  try {
    const stored = await invoke<ProjectBox | undefined>("patch_box", { boxId, patch });
    if (stored) useBoxesStore.setState((state) => ({ boxes: state.boxes.map((b) => (b.id === boxId ? stored : b)) }));
    return true;
  } catch (error) {
    useBoxesStore.setState((state) => ({ boxes: state.boxes.map((b) => (b.id === boxId ? before : b)) }));
    useProjectsStore.setState({ switchToast: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Latest `load` — an answer from an older one is dropped. */
let loadSeq = 0;

export const useBoxesStore = create<BoxesStore>((set, get) => ({
  boxes: [],
  loaded: false,
  loadError: null,

  load: async () => {
    const seq = ++loadSeq;
    let boxes: ProjectBox[];
    try {
      boxes = await invoke<ProjectBox[]>("get_boxes");
    } catch (error) {
      // A failed read is not "no boxes": keep what is shown.
      if (seq === loadSeq) set({ loadError: String(error instanceof Error ? error.message : error) });
      return;
    }
    if (seq !== loadSeq) return;
    set({ boxes, loaded: true, loadError: null });
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

  createBoxQuick: async ({ name, memberIds = [], color }) => {
    const problem = boxNameProblem(name, get().boxes);
    if (problem) throw new BoxNameError(problem);
    const wanted = [...new Set(memberIds)];
    const wantedColor = isBoxColor(color) ? color.toLowerCase() : undefined;
    const args: { name: string; memberIds?: string[]; color?: string } = { name: name.trim() };
    if (wanted.length > 0) args.memberIds = wanted;
    if (wantedColor) args.color = wantedColor;
    const box = await invoke<ProjectBox>("create_box", args);
    set((state) => ({ boxes: [...state.boxes, box] }));
    // A backend from before `memberIds`/`color` ignored them and made a plain
    // box: bring it to what was asked with the calls it understands. An id the
    // new backend dropped on purpose (a reserved scope) is asked for once more
    // and dropped again; harmless.
    for (const id of wanted) {
      if (box.member_ids.includes(id)) continue;
      const held = get().boxes.find((b) => b.id === box.id);
      if (!held) break;
      set((state) => ({
        boxes: state.boxes.map((b) => (b.id === box.id ? { ...b, member_ids: [...b.member_ids, id] } : b)),
      }));
      await persistBoxPatch(box.id, held, { addMember: id });
    }
    if (wantedColor && box.color !== wantedColor) await get().setBoxColor(box.id, wantedColor);
    if (wanted.length > 0) await refreshDocsFor(get().boxes, [box.id]);
    return get().boxes.find((b) => b.id === box.id) ?? box;
  },

  saveBox: async (boxId, diff) => {
    const before = get().boxes.find((b) => b.id === boxId);
    if (!before) throw new Error(`box '${boxId}' not found`);
    const name = diff.name?.trim();
    const renamed = name !== undefined && name !== before.name;
    if (renamed) {
      const problem = boxNameProblem(name, get().boxes, boxId);
      if (problem) throw new BoxNameError(problem);
    }
    const addMembers = diff.addMembers ?? [];
    const removeMembers = diff.removeMembers ?? [];
    const color = diff.color === undefined ? undefined : isBoxColor(diff.color) ? diff.color.toLowerCase() : "";
    const recoloured = color !== undefined && color !== (isBoxColor(before.color) ? before.color.toLowerCase() : "");
    if (!renamed && !recoloured && addMembers.length === 0 && removeMembers.length === 0) return before;
    const patch: BoxPatch = {};
    if (renamed) patch.name = name;
    if (addMembers.length > 0) patch.addMembers = addMembers;
    if (removeMembers.length > 0) patch.removeMembers = removeMembers;
    if (recoloured && color !== undefined) patch.color = color;
    let stored: ProjectBox;
    try {
      stored = await invoke<ProjectBox>("patch_box", { boxId, patch });
    } catch (error) {
      if (!isUnknownFieldRefusal(error)) throw error;
      // The older backend: the same edit as `rename_box` + one singular patch
      // per member (the order of a diffed save: adds, then removes).
      stored = before;
      if (renamed) stored = await invoke<ProjectBox>("rename_box", { boxId, name });
      for (const id of addMembers) stored = await invoke<ProjectBox>("patch_box", { boxId, patch: { addMember: id } });
      for (const id of removeMembers) stored = await invoke<ProjectBox>("patch_box", { boxId, patch: { removeMember: id } });
      if (recoloured && color !== undefined) stored = await invoke<ProjectBox>("patch_box", { boxId, patch: { color } });
    }
    set((state) => ({ boxes: state.boxes.map((b) => (b.id === boxId ? stored : b)) }));
    if (addMembers.length > 0 || removeMembers.length > 0) await refreshDocsFor(get().boxes, [boxId]);
    return stored;
  },

  renameBox: async (boxId, name) => {
    // A name that differs from the stored one is checked here too: a backend
    // from before the rule would take anything, and the UI localizes the reason.
    const held = get().boxes.find((b) => b.id === boxId);
    if (held && name !== held.name) {
      const problem = boxNameProblem(name, get().boxes, boxId);
      if (problem) throw new BoxNameError(problem);
    }
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
    const before = get().boxes.find((b) => b.id === boxId);
    if (!before || before.member_ids.includes(projectId)) return;
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? { ...b, member_ids: [...b.member_ids, projectId] } : b)),
    }));
    if (!(await persistBoxPatch(boxId, before, { addMember: projectId }))) return;
    await refreshDocsFor(get().boxes, [boxId]);
  },

  removeFromBox: async (projectId, boxId) => {
    // NO silent dissolve: a box left with one or zero members survives (and
    // still renders, dimmed when empty). Dissolving is the box editor's
    // explicit, confirmed action (`deleteBox`).
    const before = get().boxes.find((b) => b.id === boxId);
    if (!before || !before.member_ids.includes(projectId)) return;
    set((state) => ({
      boxes: state.boxes.map((b) =>
        b.id === boxId ? { ...b, member_ids: b.member_ids.filter((id) => id !== projectId) } : b,
      ),
    }));
    // A box is an agent scope: a removal that did not land must not look done
    // (the agent would still reach the project), so a refusal reverts it.
    if (!(await persistBoxPatch(boxId, before, { removeMember: projectId }))) return;
    await refreshDocsFor(get().boxes, [boxId]);
  },

  setBoxMembers: async (boxId, memberIds) => {
    const updated = await invoke<ProjectBox>("set_box_members", { boxId, memberIds });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? updated : b)),
    }));
    await refreshDocsFor(get().boxes, [boxId]);
  },

  setBoxMobileAccess: async (boxId, enabled, devices) => {
    const updated = await invoke<ProjectBox>("set_box_mobile_access", {
      boxId,
      enabled,
      devices: enabled ? devices : null,
    });
    set((state) => ({
      boxes: state.boxes.map((b) => (b.id === boxId ? updated : b)),
    }));
  },

  setBoxColor: async (boxId, color) => {
    const next = isBoxColor(color) ? color.toLowerCase() : undefined;
    const before = get().boxes.find((b) => b.id === boxId);
    if (!before || before.color === next) return;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId) return b;
        const { color: _drop, ...rest } = b;
        return next ? { ...rest, color: next } : rest;
      }),
    }));
    await persistBoxPatch(boxId, before, { color: next ?? "" });
  },

  setBoxPillHidden: async (boxId, hidden) => {
    const before = get().boxes.find((b) => b.id === boxId);
    if (!before || !!before.hide_pill === hidden) return;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId) return b;
        // Absent from disk while shown, like `tabtivity_mobile_access` while off.
        const { hide_pill: _drop, ...rest } = b;
        return hidden ? { ...rest, hide_pill: true } : rest;
      }),
    }));
    await persistBoxPatch(boxId, before, { hidePill: hidden });
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
    const box = await get().createBoxQuick({ name: target.name ?? "", memberIds: ids });
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
    // state — with the revision a first open stamps, so the store's copy is
    // the file's. (A backend from before answers the folder alone; it stamps
    // nothing the store could adopt.)
    const answer = await invoke<ProjectBox | string>("ensure_box_folder", { boxId });
    const folder = typeof answer === "string" ? answer : answer?.folder;
    const answeredRev = typeof answer === "string" ? undefined : answer?.rev;
    set((state) => ({
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId) return b;
        // The answer is the box as the FILE holds it, which may carry an edit
        // this store never saw (another writer: a project import joining the
        // box, a second window). A revision is not an edit, so it is taken
        // only when it is exactly the first open's own stamp: no folder held
        // here, and one step past the held revision; the rest of the box
        // stays as shown until a reload or a `patch_box` answer replaces it.
        const stampedHere =
          answeredRev !== undefined && !b.folder && answeredRev === (b.rev ?? 0) + 1;
        return { ...b, folder, ...(stampedHere ? { rev: answeredRev } : {}) };
      }),
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

/** One member of the active box with its resolved root, as [`boxMembersOfScope`] lists them. */
export type BoxMemberDir = ReturnType<typeof boxMembersOfScope>[number];

/**
 * Which member a directory belongs to: the member whose root contains `cwd`, the
 * deepest one if roots nest (path-component match through `lib/paths`, so
 * `/p/ab` is not inside `/p/a` and Windows case and separators compare right).
 * `null` is "the whole box": the box folder (and anything below it, e.g. a
 * member link) or a directory under no member. `boxFolder` joins the contest as
 * a root of its own, so a member root that happens to be an ancestor of the box
 * folder does not claim it. A remote member's tabs run in its local copy, which
 * `members` does not carry as a root (same table as `boxMembersOfScope`), so
 * they get `null` too — remoteness is not guessed from paths.
 */
export function memberOfCwd(cwd: string, members: readonly BoxMemberDir[], boxFolder = ""): BoxMemberDir | null {
  if (!cwd) return null;
  let best: BoxMemberDir | null = null;
  let bestLen = -1;
  for (const m of members) {
    if (m.dir && isPathWithin(cwd, m.dir) && m.dir.length > bestLen) {
      best = m;
      bestLen = m.dir.length;
    }
  }
  // The box folder wins ties and any root no deeper than itself.
  if (boxFolder && isPathWithin(cwd, boxFolder) && boxFolder.length >= bestLen) return null;
  return best;
}

/** [`memberOfCwd`] for the box behind `scope`: `null` outside a box scope. */
export function memberOfCwdInScope(
  cwd: string,
  scope: string,
  boxes: ProjectBox[],
  projects: import("../types").ProjectEntry[],
): BoxMemberDir | null {
  if (!scope.startsWith(BOX_SCOPE_PREFIX)) return null;
  return memberOfCwd(cwd, boxMembersOfScope(scope, boxes, projects), boxFolderOfScope(scope, boxes));
}

/** Where a new tab of a box scope starts. */
export interface NewTabTarget {
  /** The directory: the member's root, else the box folder ("" until the box has one). */
  cwd: string;
  /** The member the tab starts in; `null` = the whole box. */
  member: BoxMemberDir | null;
}

/**
 * Where a plain "+" / chord opens its tab in a box scope (decision 3): the root
 * of the member the active tab belongs to (`memberOfCwd(activeTabCwd)`, never
 * the tab's own cwd — a viewer tab's cwd is its file's folder), else the box
 * folder. `null` outside a box scope: the caller keeps its own target. Kinds
 * whose cwd is not a launch directory (Monitor, Disk usage, …) skip this and use
 * the box folder.
 */
export function newTabTarget(
  scope: string,
  activeTabCwd: string | undefined,
  boxes: ProjectBox[],
  projects: import("../types").ProjectEntry[],
): NewTabTarget | null {
  if (!scope.startsWith(BOX_SCOPE_PREFIX)) return null;
  const member = memberOfCwdInScope(activeTabCwd ?? "", scope, boxes, projects);
  return { cwd: member?.dir ?? boxFolderOfScope(scope, boxes), member };
}

/**
 * The name a scope is shown under: the project's name, the box's name, or
 * "Root". `null` for a scope with none (the assistant, an unknown id). The one
 * helper behind the palette's tab `detail` and the tab hover card.
 */
export function scopeDisplayName(
  scope: string,
  projects: readonly import("../types").ProjectEntry[],
  boxes: readonly ProjectBox[],
  t: ReturnType<typeof useT>,
): string | null {
  if (scope === ROOT_SCOPE) return t("palette.scope.root");
  if (scope.startsWith(BOX_SCOPE_PREFIX)) return boxes.find((b) => boxScopeId(b.id) === scope)?.name ?? null;
  return projects.find((p) => p.id === scope)?.name ?? null;
}

// Re-export so consumers building box agent tabs can derive kinds consistently.
export { cmdToKind };
