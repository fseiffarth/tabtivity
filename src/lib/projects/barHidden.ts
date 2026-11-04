/**
 * Projects kept off the "All projects" strip (the unsliced project bar).
 *
 * Two lists in settings: projects hidden one by one (`bar_hidden_projects`)
 * and boxes whose members are hidden as a group (`bar_hidden_boxes`). Hiding
 * is a view choice only: the project stays open, keeps its tabs and agents,
 * shows in its boxes' slices and in search, and its pill comes back while it
 * is the project in scope — a strip that hides where you are has lost you.
 */
import { useMemo } from "react";
import { useBoxesStore, boxMembership } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";

const EMPTY: readonly string[] = [];

export interface BarHidden {
  projects: ReadonlySet<string>;
  boxes: ReadonlySet<string>;
}

/** The two hidden lists as sets, live from settings. */
export function useBarHidden(): BarHidden {
  const projects = useSettingsStore((s) => s.settings?.bar_hidden_projects ?? EMPTY);
  const boxes = useSettingsStore((s) => s.settings?.bar_hidden_boxes ?? EMPTY);
  return useMemo(() => ({ projects: new Set(projects), boxes: new Set(boxes) }), [projects, boxes]);
}

/**
 * Why `projectId` is off the All-projects strip: `"project"` when hidden on
 * its own, else the first hidden box it is a member of, else `null` (shown).
 * Pure; `boxIds` is the project's memberships (`useBoxMembership`).
 */
export function barHiddenReason(
  projectId: string,
  boxIds: readonly string[] | undefined,
  hidden: BarHidden,
): { kind: "project" } | { kind: "box"; boxId: string } | null {
  if (hidden.projects.has(projectId)) return { kind: "project" };
  const boxId = boxIds?.find((id) => hidden.boxes.has(id));
  return boxId ? { kind: "box", boxId } : null;
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
  };
  const out = new Set<string>();
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
