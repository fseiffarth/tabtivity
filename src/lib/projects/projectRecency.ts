import { storageKey } from "../brand";
import { useProjectsStore } from "../../stores/projects";

/** Which projects were switched to last, newest first: steering's jump box
 *  rings them before anything is typed. Per machine, in localStorage — a
 *  convenience, so a lost or blocked store only loses the order. */
const KEY = storageKey("projects.recent");
const KEEP = 30;

export function recentProjectIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Put `id` at the front of the list. */
export function noteProjectUsed(id: string) {
  const ids = [id, ...recentProjectIds().filter((other) => other !== id)].slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // localStorage unavailable: the order is lost, nothing else.
  }
}

/** Record every project that becomes the active one, the one active now
 *  included. Returns the unsubscribe. */
export function trackProjectRecency(): () => void {
  const now = useProjectsStore.getState().activeId;
  if (now) noteProjectUsed(now);
  return useProjectsStore.subscribe((state, previous) => {
    if (state.activeId && state.activeId !== previous.activeId) noteProjectUsed(state.activeId);
  });
}
