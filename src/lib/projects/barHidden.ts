/**
 * Projects kept off the "All projects" strip (the unsliced project bar).
 *
 * Two lists in settings: projects hidden one by one (`bar_hidden_projects`)
 * and boxes whose members are hidden as a group (`bar_hidden_boxes`). Hiding
 * is a view choice only: the project stays open, keeps its tabs and agents,
 * shows in its boxes' slices and in search, and its pill comes back while it
 * is the project in scope — a strip that hides where you are has lost you.
 *
 * On top of the lists, **hide mode** (`bar_solo`) hides every other open
 * project at once: the strip keeps only the project in scope, wherever the
 * user goes. It is one switch, not a third list, so turning it off restores
 * exactly the strip the lists describe. Slices ignore it like the lists.
 */
import { useMemo } from "react";
import { useBoxesStore, boxMembership } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";

const EMPTY: readonly string[] = [];

export interface BarHidden {
  projects: ReadonlySet<string>;
  boxes: ReadonlySet<string>;
  /** Hide mode: every project but the one in scope is off the strip. */
  solo: boolean;
}

/** The two hidden lists as sets and the hide-mode switch, live from settings. */
export function useBarHidden(): BarHidden {
  const projects = useSettingsStore((s) => s.settings?.bar_hidden_projects ?? EMPTY);
  const boxes = useSettingsStore((s) => s.settings?.bar_hidden_boxes ?? EMPTY);
  const solo = useSettingsStore((s) => s.settings?.bar_solo === true);
  return useMemo(() => ({ projects: new Set(projects), boxes: new Set(boxes), solo }), [projects, boxes, solo]);
}

/**
 * Why `projectId` is off the All-projects strip: `"project"` when hidden on
 * its own, else the first hidden box it is a member of, else `"solo"` while
 * hide mode is on, else `null` (shown). The lists win over hide mode, so the
 * dropdown files a project under the reason that outlives the mode. Pure;
 * `boxIds` is the project's memberships (`useBoxMembership`). The caller keeps
 * the project in scope in, whatever this says.
 */
export function barHiddenReason(
  projectId: string,
  boxIds: readonly string[] | undefined,
  hidden: BarHidden,
): { kind: "project" } | { kind: "box"; boxId: string } | { kind: "solo" } | null {
  if (hidden.projects.has(projectId)) return { kind: "project" };
  const boxId = boxIds?.find((id) => hidden.boxes.has(id));
  if (boxId) return { kind: "box", boxId };
  return hidden.solo ? { kind: "solo" } : null;
}

/**
 * The ids the unsliced All-projects strip leaves out right now, read straight
 * from the stores (no hook) — for the keyboard ring, which must walk the pills
 * the strip draws (`ProjectSwitcher`'s `barHiddenSplit`). Callers keep the
 * project in scope (and the active one) in, as the strip does.
 */
export function barHiddenIdsNow(projectIds: readonly string[]): Set<string> {
  const settings = useSettingsStore.getState().settings;
  const hidden: BarHidden = {
    projects: new Set(settings?.bar_hidden_projects ?? EMPTY),
    boxes: new Set(settings?.bar_hidden_boxes ?? EMPTY),
    solo: settings?.bar_solo === true,
  };
  const out = new Set<string>();
  if (hidden.solo) return new Set(projectIds);
  if (hidden.projects.size === 0 && hidden.boxes.size === 0) return out;
  const membership = boxMembership(useBoxesStore.getState().boxes);
  for (const id of projectIds) {
    if (barHiddenReason(id, membership.get(id), hidden)) out.add(id);
  }
  return out;
}

/** `list` with `id` added or taken out, keeping only ids still in `alive` so
 *  forgotten projects and dissolved boxes do not linger in the file. */
function toggled(list: readonly string[] | undefined, id: string, on: boolean, alive: ReadonlySet<string>): string[] {
  const kept = (list ?? []).filter((x) => x !== id && alive.has(x));
  return on ? [...kept, id] : kept;
}

/** Hide (`true`) or show one project on the All-projects strip. */
export function setProjectBarHidden(projectId: string, hidden: boolean, aliveProjectIds: ReadonlySet<string>): Promise<void> {
  const store = useSettingsStore.getState();
  const next = toggled(store.settings?.bar_hidden_projects, projectId, hidden, aliveProjectIds);
  return store.updateSettings({ bar_hidden_projects: next.length ? next : undefined });
}

/** Hide (`true`) or show every member of one box on the All-projects strip. */
export function setBoxBarHidden(boxId: string, hidden: boolean, aliveBoxIds: ReadonlySet<string>): Promise<void> {
  const store = useSettingsStore.getState();
  const next = toggled(store.settings?.bar_hidden_boxes, boxId, hidden, aliveBoxIds);
  return store.updateSettings({ bar_hidden_boxes: next.length ? next : undefined });
}

/** Turn hide mode on (only the project in scope stays on the All-projects
 *  strip) or off. Off is stored as absent, so an untouched file keeps its bytes. */
export function setBarSolo(on: boolean): Promise<void> {
  return useSettingsStore.getState().updateSettings({ bar_solo: on ? true : undefined });
}
