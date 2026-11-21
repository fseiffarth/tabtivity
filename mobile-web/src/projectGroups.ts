/**
 * The home list's favorites, hidden projects and named groups — this phone's
 * own, like the hand-arranged order (`projectOrder.ts`).
 *
 * Kept in `localStorage` and never sent to the desktop: tidying the phone's
 * list must not move the desktop's project pills, and it needs no desktop to
 * be open. A group is a plain list heading the reader named, not a desktop box
 * (a box is a shared agent workspace; the Boxes layout shows those).
 *
 * The rules the list is drawn by, in this order:
 * - a hidden project leaves every section and sits in the Hidden fold, even
 *   when it is also a favorite or in a group (unhiding puts it back there);
 * - a favorite sits in Favorites and not also in its group;
 * - a grouped project sits under its group;
 * - everything else follows, ungrouped.
 * Within each section the rows keep the list's own order (`arrangeProjects`).
 */
import { storageKey } from "../../src/lib/brand";
import { readJson, writeJson } from "../../src/lib/persist";

export interface ProjectGroup {
  id: string;
  name: string;
}

export interface ProjectSorting {
  /** Project ids starred on this phone. */
  favorites: string[];
  /** Project ids taken off the list (search still finds them). */
  hidden: string[];
  /** The groups, in the order their sections are drawn. */
  groups: ProjectGroup[];
  /** Project id → the id of the one group it sits in. */
  member: Record<string, string>;
  /** Group ids folded shut. */
  folded: string[];
}

export const EMPTY_SORTING: ProjectSorting = { favorites: [], hidden: [], groups: [], member: {}, folded: [] };

/** A group name longer than this is cut: it is a one-line heading. */
export const MAX_GROUP_NAME = 60;

/** How many ids each list keeps. A year of use should not carry every project
 *  the phone ever saw; the same cap as the stored order. */
const CAP = 200;

const KEY = storageKey("mobile.projectSorting");

type Storage_ = Parameters<typeof readJson>[3];

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string");

/** Anything that is not the stored shape (a hand-edited value, a half-written
 *  entry) reads as nothing sorted, field by field: one spoilt list does not
 *  take the others with it. A membership naming a group that no longer exists
 *  is dropped. */
export function parseSorting(raw: unknown): ProjectSorting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SORTING;
  const value = raw as Record<string, unknown>;
  const groups = Array.isArray(value.groups)
    ? value.groups.filter((group): group is ProjectGroup => !!group && typeof group === "object"
      && typeof (group as ProjectGroup).id === "string" && typeof (group as ProjectGroup).name === "string")
      .map((group) => ({ id: group.id, name: group.name }))
    : [];
  const known = new Set(groups.map((group) => group.id));
  const member: Record<string, string> = {};
  if (value.member && typeof value.member === "object" && !Array.isArray(value.member)) {
    for (const [project, group] of Object.entries(value.member as Record<string, unknown>)) {
      if (typeof group === "string" && known.has(group)) member[project] = group;
    }
  }
  return {
    favorites: isIdList(value.favorites) ? value.favorites : [],
    hidden: isIdList(value.hidden) ? value.hidden : [],
    groups,
    member,
    folded: isIdList(value.folded) ? value.folded.filter((id) => known.has(id)) : [],
  };
}

export function readProjectSorting(storage?: Storage_): ProjectSorting {
  return readJson(KEY, parseSorting, EMPTY_SORTING, storage);
}

export function writeProjectSorting(sorting: ProjectSorting, storage?: Storage_): void {
  writeJson(KEY, {
    ...sorting,
    favorites: sorting.favorites.slice(0, CAP),
    hidden: sorting.hidden.slice(0, CAP),
  }, storage);
}

/** Part of `forgetDeviceData`: group names are the reader's own words. */
export function forgetProjectSorting(storage?: Storage_): void {
  writeJson(KEY, undefined, storage);
}

const without = (ids: readonly string[], id: string) => ids.filter((entry) => entry !== id);

/** Drop the groups no project sits in any more: a group is made with its
 *  first project and goes with its last, so there is never an empty heading
 *  to tidy away by hand. A project not listed right now still keeps its group
 *  alive — it will be back. */
function prune(sorting: ProjectSorting): ProjectSorting {
  const used = new Set(Object.values(sorting.member));
  const groups = sorting.groups.filter((group) => used.has(group.id));
  if (groups.length === sorting.groups.length) return sorting;
  return { ...sorting, groups, folded: sorting.folded.filter((id) => used.has(id)) };
}

export function isFavorite(sorting: ProjectSorting, id: string): boolean {
  return sorting.favorites.includes(id);
}

export function isHidden(sorting: ProjectSorting, id: string): boolean {
  return sorting.hidden.includes(id);
}

/** The group a project sits in, if any. */
export function groupOf(sorting: ProjectSorting, id: string): ProjectGroup | undefined {
  const groupId = sorting.member[id];
  return groupId ? sorting.groups.find((group) => group.id === groupId) : undefined;
}

export function setFavorite(sorting: ProjectSorting, id: string, favorite: boolean): ProjectSorting {
  return { ...sorting, favorites: favorite ? [id, ...without(sorting.favorites, id)] : without(sorting.favorites, id) };
}

export function setHidden(sorting: ProjectSorting, id: string, hidden: boolean): ProjectSorting {
  return { ...sorting, hidden: hidden ? [id, ...without(sorting.hidden, id)] : without(sorting.hidden, id) };
}

/** Put a project into a group, or (`null`) into none. An unknown group id
 *  is no group. */
export function moveToGroup(sorting: ProjectSorting, id: string, groupId: string | null): ProjectSorting {
  const member = { ...sorting.member };
  if (groupId && sorting.groups.some((group) => group.id === groupId)) member[id] = groupId;
  else delete member[id];
  return prune({ ...sorting, member });
}

/** A trimmed, one-line name cut to `MAX_GROUP_NAME` characters; empty when
 *  there is nothing left. */
export function cleanGroupName(name: string): string {
  return [...name.replace(/\s+/g, " ").trim()].slice(0, MAX_GROUP_NAME).join("");
}

/** A fresh group, drawn last, holding `projectId`. `newId` is for tests. */
export function createGroup(sorting: ProjectSorting, name: string, projectId: string, newId?: string): ProjectSorting {
  const clean = cleanGroupName(name);
  if (!clean) return sorting;
  let id = newId ?? `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  while (sorting.groups.some((group) => group.id === id)) id = `${id}x`;
  return moveToGroup({ ...sorting, groups: [...sorting.groups, { id, name: clean }] }, projectId, id);
}

export function renameGroup(sorting: ProjectSorting, groupId: string, name: string): ProjectSorting {
  const clean = cleanGroupName(name);
  if (!clean) return sorting;
  return { ...sorting, groups: sorting.groups.map((group) => group.id === groupId ? { ...group, name: clean } : group) };
}

/** Dissolve a group: its projects go back to the ungrouped rows. */
export function ungroup(sorting: ProjectSorting, groupId: string): ProjectSorting {
  const member = Object.fromEntries(Object.entries(sorting.member).filter(([, group]) => group !== groupId));
  return prune({ ...sorting, member });
}

/** Move a group's section one place up (-1) or down (1). */
export function shiftGroup(sorting: ProjectSorting, groupId: string, delta: -1 | 1): ProjectSorting {
  const index = sorting.groups.findIndex((group) => group.id === groupId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= sorting.groups.length) return sorting;
  const groups = [...sorting.groups];
  [groups[index], groups[target]] = [groups[target], groups[index]];
  return { ...sorting, groups };
}

export function toggleFolded(sorting: ProjectSorting, groupId: string): ProjectSorting {
  return { ...sorting, folded: sorting.folded.includes(groupId) ? without(sorting.folded, groupId) : [groupId, ...sorting.folded] };
}

/** Where a row is drawn: which section a drag dropped it into. */
export type SectionKey = { kind: "favorites" } | { kind: "group"; id: string } | { kind: "loose" };

/** A drop beside a row of another section moves the project into that
 *  section: into Favorites stars it (its group stays, for when it is
 *  unstarred); into a group unstars it and puts it there; into the ungrouped
 *  rows unstars and ungroups it. */
export function placeInSection(sorting: ProjectSorting, id: string, section: SectionKey): ProjectSorting {
  if (section.kind === "favorites") return setFavorite(sorting, id, true);
  const unstarred = setFavorite(sorting, id, false);
  return moveToGroup(unstarred, id, section.kind === "group" ? section.id : null);
}

export interface ProjectSections<T> {
  favorites: T[];
  groups: { group: ProjectGroup; rows: T[] }[];
  loose: T[];
  hidden: T[];
}

/** Split the arranged rows into the sections they are drawn in, each in the
 *  rows' own order. A group none of the rows sits in is left out: the active
 *  list shows only what is active. */
export function sectionProjects<T>(rows: readonly T[], idOf: (row: T) => string, sorting: ProjectSorting): ProjectSections<T> {
  const hidden = new Set(sorting.hidden);
  const favorites = new Set(sorting.favorites);
  const out: ProjectSections<T> = { favorites: [], groups: [], loose: [], hidden: [] };
  const byGroup = new Map<string, T[]>();
  for (const row of rows) {
    const id = idOf(row);
    if (hidden.has(id)) out.hidden.push(row);
    else if (favorites.has(id)) out.favorites.push(row);
    else if (sorting.member[id]) {
      const list = byGroup.get(sorting.member[id]) ?? [];
      list.push(row);
      byGroup.set(sorting.member[id], list);
    } else out.loose.push(row);
  }
  for (const group of sorting.groups) {
    const list = byGroup.get(group.id);
    if (list?.length) out.groups.push({ group, rows: list });
  }
  return out;
}
