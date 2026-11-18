import { create } from "zustand";
import { useBoxesStore, BOX_SCOPE_PREFIX } from "./boxes";
import { stopClosedProjectScope, useProjectsStore } from "./projects";
import { translateNow } from "../lib/i18n";
import { ROOT_SCOPE, useTabsStore } from "./tabs";
import type { ProjectBox, ProjectEntry } from "../types";

/**
 * Which box's slice the project strip shows (`null` = every active project),
 * and where the unsliced strip last stood. It lived in `ProjectSwitcher` as
 * `useState`/`useRef`; the ✕ on the selected pill, the palette's "Show all
 * projects", the search's "All projects" row, quick-create-then-enter and
 * Dissolve-while-inside all need to read or clear it from outside, so it lives
 * here, the one home.
 *
 * A *view*, deliberately not the scope: clicking a member switches to that
 * project without collapsing the slice, so hopping between a box's projects
 * never reshuffles the row under the pointer. Session-only — a slice is where
 * you are looking right now, not a setting; nothing is persisted.
 *
 * The switcher keeps the effects that follow the scope and the boxes list
 * (`followScope`, `dropIfGone`, `noteScope`); every gesture goes through
 * `selectBox` / `leaveBox`.
 */
interface BoxSliceStore {
  /** The box whose slice is selected, or `null` for every active project. */
  sliceBoxId: string | null;
  /** Where the UNSLICED strip last stood: the scope "All projects" hands back.
   *  Only scopes seen while no slice was selected count (a member opened from
   *  inside the slice was current in the BOX's view, not in this one). Root is
   *  a legitimate value — it is where a session starts, and where a remembered
   *  project that has since been closed lands. */
  lastUnslicedScope: string;
  /** Set the slice without touching the scope (the effects' primitive). */
  setSlice: (boxId: string | null) => void;
  /** Entering a box scope by any door (the search popover, a restored scope at
   *  launch, a popout's stream) selects its slice. One-way: any other scope
   *  leaves the slice alone, which is what keeps the strip still while its
   *  projects are being visited. */
  followScope: (scope: string) => void;
  /** A dissolved box takes its slice with it, or the strip would stay filtered
   *  by something no menu can select any more. */
  dropIfGone: (boxIds: readonly string[]) => void;
  /** Remember `scope` as the unsliced strip's place, unless a slice is selected
   *  or the scope is a box's. */
  noteScope: (scope: string) => void;
  /** Pick a box's slice and enter its scope (`openBox`), or — `null` — go back
   *  to every project. */
  selectBox: (boxId: string | null) => Promise<void>;
  /** Leave the box: `selectBox(null)`. Clears the slice and, from inside a box
   *  scope, hands the scope back to where the unsliced strip last stood. A no-op
   *  for the scope when it is not a box's. */
  leaveBox: () => Promise<void>;
}

export const useBoxSliceStore = create<BoxSliceStore>((set, get) => ({
  sliceBoxId: null,
  lastUnslicedScope: ROOT_SCOPE,

  setSlice: (boxId) => set((s) => (s.sliceBoxId === boxId ? s : { sliceBoxId: boxId })),

  followScope: (scope) => {
    if (!scope.startsWith(BOX_SCOPE_PREFIX)) return;
    get().setSlice(scope.slice(BOX_SCOPE_PREFIX.length));
  },

  dropIfGone: (boxIds) => {
    const { sliceBoxId, setSlice } = get();
    if (sliceBoxId && !boxIds.includes(sliceBoxId)) setSlice(null);
  },

  noteScope: (scope) => {
    const { sliceBoxId, lastUnslicedScope } = get();
    if (sliceBoxId || scope.startsWith(BOX_SCOPE_PREFIX) || scope === lastUnslicedScope) return;
    set({ lastUnslicedScope: scope });
  },

  selectBox: async (boxId) => {
    const before = get().sliceBoxId;
    get().setSlice(boxId);
    // Picking a box makes the BOX the current scope: its tabs, its pill lit.
    if (boxId) {
      try {
        await useBoxesStore.getState().openBox(boxId);
      } catch (error) {
        // The box was not entered (its folder could not be made, or it was
        // dissolved elsewhere): a strip sliced to it would show a box nobody is
        // in. Most callers fire this with `void`, so the reason is said here.
        if (get().sliceBoxId === boxId) get().setSlice(before);
        useProjectsStore.setState({ switchToast: String(error) });
        throw error;
      }
      return;
    }
    // Back to every project — and to the project that view was last on (user,
    // 2026-09-05). Only from inside a box scope: once the user has hopped to a
    // member, strip and tabs already agree, and re-activating would be a
    // pointless project-runtime switch. `setActive` with the id it already
    // holds is the established way back out of a box (CenterPanel keys its
    // `setScope` off `switchGeneration` for exactly this).
    if (!useTabsStore.getState().scope.startsWith(BOX_SCOPE_PREFIX)) return;
    const back = get().lastUnslicedScope;
    const { projects, setActive } = useProjectsStore.getState();
    const alive = projects.some((p) => p.id === back && p.status !== "inactive");
    await setActive(alive ? back : null);
  },

  leaveBox: () => get().selectBox(null),
}));

/**
 * Leaving a box stops the closed members it reopened (user decision
 * 2026-11-16). Entering a box restores the tabs of members that are closed in
 * the general strip; once the slice is gone those projects have no pill, and
 * their agents used to run on where nothing could reach them. A member the
 * next slice's box also holds stays (it still has a pill), and so does the one
 * on screen. The projects stay closed, with their layout saved for next time.
 */
async function stopReopenedMembers(leftBoxId: string, nextBoxId: string | null): Promise<void> {
  const boxes = useBoxesStore.getState().boxes;
  const left = boxes.find((b) => b.id === leftBoxId);
  if (!left) return;
  const kept = new Set(boxes.find((b) => b.id === nextBoxId)?.member_ids ?? []);
  const stopped: string[] = [];
  for (const id of left.member_ids) {
    if (kept.has(id) || useTabsStore.getState().scope === id) continue;
    const project = useProjectsStore.getState().projects.find((p) => p.id === id);
    if (project?.status !== "inactive") continue;
    if (await stopClosedProjectScope(id, { ask: false }).catch(() => false)) stopped.push(project.name);
  }
  if (stopped.length > 0) {
    useProjectsStore.setState({
      switchToast: translateNow("boxSlice.closedAgain", { names: stopped.join(", ") }),
    });
  }
}

useBoxSliceStore.subscribe((state, prev) => {
  const left = prev.sliceBoxId;
  if (left && left !== state.sliceBoxId) void stopReopenedMembers(left, state.sliceBoxId);
});

/**
 * The project pills the strip shows, in pill order: the ONE list behind the
 * rendered pills, the keyboard ring (`projectStations`: `cycleProject`, the
 * steering digits) and the station badges, so they cannot number the strip
 * differently.
 *
 * Unsliced (`box` null) it is every active project, by position. A slice shows
 * its box's members REGARDLESS of status (a member closed in the general strip
 * is still open inside its box: `openBox` restored its tabs box-locally), plus
 * the project currently in scope even when it is not a member, since a strip
 * that hides the project you are working in has lost you.
 *
 * A slice is in the BOX'S order (`member_ids`, user decision 2026-11-16), the
 * same order the side panel's sections stand in: one view used to show two
 * orders, and dragging a pill inside a box reordered the whole strip behind
 * it. The non-member in scope comes last, a guest after the members.
 */
export function stripProjects(
  projects: readonly ProjectEntry[],
  box: ProjectBox | null,
  scope: string,
): ProjectEntry[] {
  const byPosition = (a: ProjectEntry, b: ProjectEntry) => a.position - b.position;
  if (!box) return projects.filter((p) => p.status !== "inactive").sort(byPosition);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const members = box.member_ids
    .map((id) => byId.get(id))
    .filter((p): p is ProjectEntry => !!p);
  const guest = box.member_ids.includes(scope) ? undefined : byId.get(scope);
  return guest ? [...members, guest] : members;
}

/**
 * Dissolve a box (the delete itself; the confirm is the caller's). A box you
 * are inside — its slice, or its own `box:<id>` scope — is left first, or the
 * scope would stay `box:<id>` of a box that is gone. The one body behind the
 * pill menu's and the sheet's "Dissolve box…". Throws what the write throws.
 */
export async function dissolveBox(boxId: string): Promise<void> {
  const inside =
    useBoxSliceStore.getState().sliceBoxId === boxId ||
    useTabsStore.getState().scope === `${BOX_SCOPE_PREFIX}${boxId}`;
  if (inside) await useBoxSliceStore.getState().leaveBox();
  await useBoxesStore.getState().deleteBox(boxId);
}

/** Back to the start (a session's first state). For tests. */
export function resetBoxSlice(): void {
  useBoxSliceStore.setState({ sliceBoxId: null, lastUnslicedScope: ROOT_SCOPE });
}
