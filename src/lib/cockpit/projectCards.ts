import type { AgentRosterState } from "../agents/agentRoster";
import type { ProjectHostKind } from "../projectTabHost";
import type { GitDirtyState } from "../../stores/gitDirty";
import type { ConnState } from "../../stores/remote/remoteStatus";
import type { TranslationKey } from "../i18n";
import { rosterCounts, type RosterCounts } from "./roster";

/**
 * The cockpit's Projects view model (`docs/desktop_cockpit_plan.md`, View 2):
 * one card per project, open ones first. Pure; the caller reads the stores.
 *
 * A project whose scope is not hydrated here (`loaded: false`) shows only what
 * needs no hydrated scope — git, remote lamps, time — and no agent counts:
 * "0 agents" would be a claim about tabs nobody has looked at.
 */

export interface ProjectCardHost {
  id: string;
  label: string;
  ssh: ConnState;
  vpn: ConnState;
}

export interface ProjectCardInput {
  id: string;
  name: string;
  kind: ProjectHostKind;
  /** A remote project with no local mirror (`isHostPinned`). */
  hostPinned: boolean;
  /** The project's status is not `inactive`. */
  open: boolean;
  /** Its scope's tabs are in the tab store this session. */
  loaded: boolean;
  position: number;
  boxIds: readonly string[];
  /** The agent tabs' states, when `loaded`. */
  agentStates?: readonly AgentRosterState[];
  /** The newest working / finished stamp of its agent tabs (ms epoch). */
  lastActivityAt?: number;
  git?: GitDirtyState;
  hosts: readonly ProjectCardHost[];
  /** Diverged (amber) byte-sync entries, where the sync store has read them. */
  syncDiverged?: number;
  /** The run host as a name (`runHostLabel`), not the raw `TabLocation`. */
  runHost?: string;
  /** Push requests waiting (pending or running). */
  pushPending: number;
  /** Seconds worked on it today, once read. */
  timeTodaySecs?: number;
}

export interface ProjectCard extends Omit<ProjectCardInput, "agentStates"> {
  /** Agent counts by state — only for a loaded scope. */
  counts?: RosterCounts;
}

export interface ProjectCardGroup {
  /** A box id, or `""` for projects in no box (and the whole list when a box
   *  filter is set). */
  boxId: string;
  cards: ProjectCard[];
}

export function toProjectCard({ agentStates, ...rest }: ProjectCardInput): ProjectCard {
  return rest.loaded && agentStates ? { ...rest, counts: rosterCounts(agentStates.map((state) => ({ state }))) } : rest;
}

/** Open projects first, each part in pill order. */
function byOpenThenPosition(a: ProjectCardInput, b: ProjectCardInput): number {
  if (a.open !== b.open) return a.open ? -1 : 1;
  return a.position - b.position;
}

/**
 * The cards, grouped by box when no box filter is set (a project in several
 * boxes shows in each), else only that box's projects in one group. Box
 * groups follow `boxOrder`; projects in no box come last.
 */
export function buildProjectCards(
  inputs: readonly ProjectCardInput[],
  { boxFilter, boxOrder }: { boxFilter: string | null; boxOrder: readonly string[] },
): ProjectCardGroup[] {
  const sorted = [...inputs].sort(byOpenThenPosition);
  if (boxFilter) {
    return [{ boxId: "", cards: sorted.filter((p) => p.boxIds.includes(boxFilter)).map(toProjectCard) }];
  }
  const groups: ProjectCardGroup[] = boxOrder
    .map((boxId) => ({ boxId, cards: sorted.filter((p) => p.boxIds.includes(boxId)).map(toProjectCard) }))
    .filter((g) => g.cards.length > 0);
  const loose = sorted.filter((p) => !p.boxIds.some((id) => boxOrder.includes(id))).map(toProjectCard);
  if (loose.length > 0) groups.push({ boxId: "", cards: loose });
  return groups;
}

/** The translator the view's `useT()` returns (kept structural: this file stays pure). */
type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** A project's host machines as `runHostLabel` reads them (structural). */
interface RunHostProject {
  remote?: { host?: string } | null;
  compute_hosts?: readonly { id: string; label?: string; host?: string }[];
}

/**
 * Where a project's shells run, as a name. `run_host` is a `TabLocation`:
 * `"local"`, `"remote"` (the primary) or `"host:<id>"` (a compute host); the raw
 * id is never shown. undefined when the project has no choice stored.
 */
export function runHostLabel(project: RunHostProject, location: string | undefined, t: Translate): string | undefined {
  if (!location) return undefined;
  if (location === "local") return t("cockpit.projects.thisMachine");
  if (location === "remote") return project.remote?.host || t("tabLocality.primary");
  if (location.startsWith("host:")) {
    const id = location.slice("host:".length);
    const host = project.compute_hosts?.find((h) => h.id === id);
    return host?.label || host?.host || id;
  }
  return undefined;
}

/** The agents cell: only the non-zero parts, working first. Undefined when
 *  there is nothing to say (no counts, or a loaded scope with no agent tab). */
export interface AgentsSummary {
  working: number;
  asking: number;
  total: number;
  /** The roster's state classes, for the row's dot. */
  state: "question" | "working" | "interrupted" | "done" | "idle";
}

export function agentsSummary(counts: RosterCounts | undefined): AgentsSummary | undefined {
  if (!counts || counts.total === 0) return undefined;
  const state =
    counts.asking > 0 ? "question" : counts.working > 0 ? "working" : counts.interrupted > 0 ? "interrupted" : counts.done > 0 ? "done" : "idle";
  return { working: counts.working, asking: counts.asking, total: counts.total, state };
}

/** The hosts cell: nothing for a project with none, the one host itself, or a
 *  count of how many are on (connected). The full list is the cell's title. */
export type HostsSummary = { kind: "single"; host: ProjectCardHost } | { kind: "many"; total: number; on: number };

export function hostsSummary(hosts: readonly ProjectCardHost[]): HostsSummary | undefined {
  if (hosts.length === 0) return undefined;
  if (hosts.length === 1) return { kind: "single", host: hosts[0] };
  return { kind: "many", total: hosts.length, on: hosts.filter((h) => h.ssh === "connected").length };
}

/** A box group split into what gets a row (its scope is loaded) and what is
 *  folded into the "Not open" line. */
export interface ProjectCardSplit {
  boxId: string;
  rows: ProjectCard[];
  closed: ProjectCard[];
}

export function splitGroups(groups: readonly ProjectCardGroup[]): ProjectCardSplit[] {
  return groups.map((g) => ({ boxId: g.boxId, rows: g.cards.filter((c) => c.loaded), closed: g.cards.filter((c) => !c.loaded) }));
}

/** Keep the projects whose name contains `query` (case-insensitive); a group
 *  left empty is dropped. */
export function filterGroups(groups: readonly ProjectCardGroup[], query: string): ProjectCardGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups
    .map((g) => ({ ...g, cards: g.cards.filter((c) => c.name.toLowerCase().includes(q)) }))
    .filter((g) => g.cards.length > 0);
}

/** The toolbar's count line: distinct projects (one in several boxes counts
 *  once), those with a row, and those with an agent working. */
export function projectTotals(groups: readonly ProjectCardGroup[]): { projects: number; open: number; working: number } {
  const seen = new Map<string, ProjectCard>();
  for (const g of groups) for (const c of g.cards) seen.set(c.id, c);
  let open = 0;
  let working = 0;
  for (const c of seen.values()) {
    if (c.loaded) open += 1;
    if ((c.counts?.working ?? 0) > 0) working += 1;
  }
  return { projects: seen.size, open, working };
}
