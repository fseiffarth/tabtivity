import type { ProjectBox, ProjectEntry } from "../../types";
import { formatRemoteTarget, resolveLocalMirror } from "../../types";
import { projectDirectory } from "./scaffold";

/** One result of the project search: a project, a box, or "All projects" (the
 *  way out of a box slice, offered only while one is sliced). Shared by the
 *  header's `ProjectSearch` and steering's jump overlay. */
export type SearchRow =
  | { kind: "project"; project: ProjectEntry }
  | { kind: "box"; box: ProjectBox }
  | { kind: "all" };

/** A row's name as listed: the project's or box's, or `allProjectsLabel`. */
export function searchRowName(row: SearchRow, allProjectsLabel: string): string {
  return row.kind === "all" ? allProjectsLabel : row.kind === "box" ? row.box.name : row.project.name;
}

/** A row's id within one list, unique across projects and boxes. */
export function searchRowId(row: SearchRow): string {
  return `${row.kind}-${row.kind === "box" ? row.box.id : row.kind === "project" ? row.project.id : "all"}`;
}

/** Location line(s) shown under a project's name — and the text the query is
 *  matched against. A remote (SSH) project lives in two places at once, so both
 *  its host target and its paired local mirror are listed; its `directory` is
 *  only an internal state dir and is never shown. */
export function searchPaths(project: ProjectEntry): { label?: string; path: string }[] {
  if (project.remote) {
    const mirror = resolveLocalMirror(project);
    return [
      { label: "remote", path: formatRemoteTarget(project.remote) },
      ...(mirror ? [{ label: "local", path: mirror }] : []),
    ];
  }
  const dir = projectDirectory(project);
  return dir ? [{ path: dir }] : [];
}

function matchesQuery(project: ProjectEntry, q: string): boolean {
  return (
    project.name.toLowerCase().includes(q) ||
    searchPaths(project).some((loc) => loc.path.toLowerCase().includes(q))
  );
}

/** The names of a box's members that are known projects, in member order. */
export function memberNames(box: ProjectBox, byId: ReadonlyMap<string, ProjectEntry>): string[] {
  return box.member_ids.map((id) => byId.get(id)?.name).filter((name): name is string => !!name);
}

/**
 * The search's rows for `query`. Typed: open projects, boxes (by name or a
 * member's name), inactive projects, then "All projects" while its name starts
 * with the query. Nothing typed: "All projects" and the boxes (steering's jump
 * box asks `jumpStartRows` instead).
 */
export function projectSearchRows({
  projects,
  boxes,
  query,
  sliced,
  allProjectsLabel,
}: {
  projects: ProjectEntry[];
  boxes: ProjectBox[];
  query: string;
  /** A box slice is on: "All projects" is offered. */
  sliced: boolean;
  allProjectsLabel: string;
}): SearchRow[] {
  const q = query.trim().toLowerCase();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const openRows: SearchRow[] = q
    ? projects
        .filter((p) => p.status !== "inactive" && matchesQuery(p, q))
        .sort((a, b) => a.position - b.position)
        .map((project) => ({ kind: "project", project }))
    : [];
  // A box matches by its own name or by a member's name: "which box was
  // alpha in?" is a question the search should answer.
  const boxRows: SearchRow[] = boxes
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        memberNames(b, byId).some((name) => name.toLowerCase().includes(q)),
    )
    .sort((a, b) => a.position - b.position)
    .map((box) => ({ kind: "box", box }));
  // The way out of a slice. Empty field: first row. Typed: last, and only
  // while the query starts its name, so it never takes Enter from a match.
  const allRows: SearchRow[] =
    sliced && (!q || allProjectsLabel.toLowerCase().startsWith(q)) ? [{ kind: "all" }] : [];
  if (!q) return [...allRows, ...boxRows];
  // Boxes are opt-in: a box's members stay independently searchable below.
  const inactiveRows: SearchRow[] = projects
    .filter((p) => p.status === "inactive" && matchesQuery(p, q))
    .sort((a, b) => a.position - b.position)
    .map((project) => ({ kind: "project", project }));
  return [...openRows, ...boxRows, ...inactiveRows, ...allRows];
}

/**
 * Steering's jump box before a letter is typed: the projects worth one digit.
 * The open projects, most recently used first (the never-recorded ones after,
 * in bar order), then inactive projects used recently, newest first; never the
 * active one — picking it would do nothing — so the first slot is the project
 * you came from. At most `limit`.
 */
export function jumpStartRows({
  projects,
  recentIds,
  activeId,
  limit,
}: {
  projects: ProjectEntry[];
  recentIds: readonly string[];
  activeId: string | null;
  limit: number;
}): SearchRow[] {
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  const byRecency = (a: ProjectEntry, b: ProjectEntry) =>
    (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.position - b.position;
  const others = projects.filter((p) => p.id !== activeId);
  const open = others.filter((p) => p.status !== "inactive").sort(byRecency);
  const recentInactive = others.filter((p) => p.status === "inactive" && rank.has(p.id)).sort(byRecency);
  return [...open, ...recentInactive].slice(0, limit).map((project) => ({ kind: "project", project }));
}

/** Whether picking `row` changes what the workspace shows: anything but the
 *  current project. */
export function rowSwitches(row: SearchRow): boolean {
  return row.kind !== "project" || row.project.status !== "current";
}
