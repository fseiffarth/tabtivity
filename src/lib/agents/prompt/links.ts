import type { ProjectAgentPrompt, PromptLink } from "../../../stores/agents/agentPrompts";
import { MAX_PREFACE_COMMANDS, sanitizePrefaceCommand } from "../agentPrefaces";

export type PromptLinkKind = "related" | "after";

export interface ChainStrand {
  scheduleTargetId: string;
  label: string;
  sessionId?: string;
  agent?: string;
}

export interface ChainNext {
  link: PromptLink;
  prompt: ProjectAgentPrompt;
  strand?: ChainStrand;
  stopped: "closed" | null;
}

export function validPromptLink(link: PromptLink): boolean {
  return !!link.id && !!link.from && !!link.to && link.from !== link.to
    && (link.kind === "related" || link.kind === "after");
}

export function prunePromptLinks(links: PromptLink[], endpointIds: Iterable<string>): PromptLink[] {
  const ids = new Set(endpointIds);
  return links.filter((link) => validPromptLink(link) && ids.has(link.from) && ids.has(link.to));
}

/**
 * The command chips an edge offers: what the target tab's agent offers, then
 * any command the edge already carries that it no longer does — a chip that
 * disappeared would drop a command the edge still types.
 */
export function edgeCommandChoices(offered: readonly string[], preface: readonly string[] = []): string[] {
  const choices = offered.map(sanitizePrefaceCommand).filter(Boolean);
  for (const command of preface) if (!choices.includes(command)) choices.push(command);
  return choices;
}

/** An edge's commands with `command` switched on or off, in chip order. */
export function toggleEdgeCommand(choices: readonly string[], preface: readonly string[] = [], command: string): string[] {
  const on = new Set(preface);
  if (on.has(command)) on.delete(command);
  else on.add(command);
  return choices.filter((choice) => on.has(choice)).slice(0, MAX_PREFACE_COMMANDS);
}

export type AfterLinkRefusal = "cycle" | "join";

/** The history's own edge between two session cards (`roll:<row>`), which no
 *  gesture writes and no sequence rule judges. */
export function isSessionRollLink(link: Pick<PromptLink, "id">): boolean {
  return link.id.startsWith("roll:");
}

/**
 * Why an `after` edge `from → to` may not be written, or `null` when it may.
 * `cycle`: `to` already leads back to `from`, so neither would ever start.
 * `join`: `to` already waits on another prompt — it goes after ONE turn, and
 * two sources finishing would queue it twice. `ignoreLinkId` is the edge being
 * edited, skipped so re-saving it is not a join with itself; when that edge is
 * already stored as `after` with the same ends (only its preface or tab
 * changes) nothing is judged at all, since data written before this check can
 * hold a join and editing one of its edges adds none. The history's `roll:`
 * edges are exempt, as the edge edited and as counted edges. The caller asks
 * only for `after` edges; the backend's `after_link_refusal` decides the same
 * way and refuses with `prompt_link_cycle` and `prompt_link_join`.
 */
export function afterLinkRefusal(
  links: readonly PromptLink[],
  from: string,
  to: string,
  ignoreLinkId?: string,
): AfterLinkRefusal | null {
  if (ignoreLinkId !== undefined) {
    if (ignoreLinkId.startsWith("roll:")) return null;
    const stored = links.find((link) => link.id === ignoreLinkId);
    if (stored && stored.kind === "after" && stored.from === from && stored.to === to) return null;
  }
  const after = links.filter((link) => link.kind === "after" && link.id !== ignoreLinkId && !isSessionRollLink(link));
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === from) return "cycle";
    if (seen.has(node)) continue;
    seen.add(node);
    for (const link of after) if (link.from === node) stack.push(link.to);
  }
  return after.some((link) => link.to === to) ? "join" : null;
}

/** Resolve the drafts an actual successful delivery should queue. */
export function nextAfter(
  deliveredId: string,
  links: PromptLink[],
  drafts: ProjectAgentPrompt[],
  strands: ChainStrand[],
  fallbackTarget?: string,
): ChainNext[] {
  const byId = new Map(drafts.map((prompt) => [prompt.id, prompt]));
  const strandById = new Map(strands.map((strand) => [strand.scheduleTargetId, strand]));
  return links.flatMap((link) => {
    const sourceMatches = link.from === deliveredId || deliveredId.startsWith(`${link.from}@`);
    // A paused edge holds its target back: the source finishing queues nothing.
    if (link.kind !== "after" || !sourceMatches || link.paused) return [];
    const prompt = byId.get(link.to);
    if (!prompt) return [];
    const strand = strandById.get(link.target ?? fallbackTarget ?? "");
    return [{ link, prompt, strand, stopped: strand ? null : "closed" }];
  });
}
