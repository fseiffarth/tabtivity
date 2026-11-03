import type { AgentRosterState } from "../agents/agentRoster";
import type { ProjectHostKind } from "../projectTabHost";
import type { GitDirtyState } from "../../stores/gitDirty";
import type { ConnState } from "../../stores/remote/remoteStatus";
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
