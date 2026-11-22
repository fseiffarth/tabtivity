/**
 * What spoken navigation in the desktop Chat (docs/desktop_tabby_navigate_plan.md)
 * works with, pure over store snapshots: the lists the matcher resolves names
 * against, the queues "the waiting / working / done tab" walk, the tab a
 * project or box lands on, and the one-shot note a jump leaves for the Chat it
 * lands in (module state: the Chat that left it is hidden or gone by then).
 *
 * Reach is projects and boxes: the root's tabs (the unfenced Host session
 * among them) and Tabby's chats (`ASSISTANT_SCOPE`) never enter a list or a
 * queue, so a landing never opens a mic there.
 */
import { agentFamily } from "../../../shared/agentComposer";
import type { AttentionKind } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import { ASSISTANT_SCOPE } from "../assistant";
import { BOX_SCOPE_PREFIX, ROOT_SCOPE } from "../terminal/ptyId";
import { statusTabs, type StatusTab, type TabStatusKind } from "../shortcuts/statusJump";
import { BUILTIN_AGENT_ALIASES, type VoiceListItem, type VoiceLists } from "./voiceCommands";

/** The fields of a tab entry spoken navigation reads. */
export interface NavTab {
  key: string;
  label: string;
  kind: string;
}

/** A tab that can hold a conversation: an agent tab (local models too). */
export function isAgentTab(tab: Pick<NavTab, "kind">): boolean {
  return tab.kind === "agent" || tab.kind === "local_agent";
}

/** Whether `scope` may be named or walked to: a project or a box, never a
 * reserved scope (`storage::is_reserved_scope`: the root, Tabby's). */
export function isNavScope(scope: string): boolean {
  return scope !== ROOT_SCOPE && scope !== ASSISTANT_SCOPE;
}

/** The first word of an agent's label, folded, for its spoken spellings. */
function aliasKey(label: string): string {
  return label.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
}

/**
 * The lists for the matcher: the projects and boxes by name, and the shown
 * scope's tabs (strip order) and agents. `agentLabel` names a tab's agent as
 * the tab bar does (`agentTabLabel`). A reserved scope's tabs are no list.
 */
export function navLists<T extends NavTab>(
  projects: readonly { id: string; name: string }[],
  boxes: readonly { id: string; name: string }[],
  scope: string | null,
  tabs: readonly T[],
  agentLabel: (tab: T) => string,
): VoiceLists {
  const own = scope !== null && isNavScope(scope) ? tabs : [];
  const agents = new Map<string, VoiceListItem>();
  for (const tab of own) {
    if (!isAgentTab(tab)) continue;
    const name = agentLabel(tab);
    const family = agentFamily(name);
    if (!agents.has(family)) agents.set(family, { id: family, name, aliases: BUILTIN_AGENT_ALIASES[aliasKey(name)] ?? [] });
  }
  return {
    projects: projects.filter((p) => isNavScope(p.id)).map((p) => ({ id: p.id, name: p.name })),
    boxes: boxes.map((b) => ({ id: `${BOX_SCOPE_PREFIX}${b.id}`, name: b.name })),
    tabs: own.map((tab) => ({ id: tab.key, name: tab.label })),
    agents: [...agents.values()],
  };
}

export type NavQueueKind = "waiting" | "working" | "done";

const STATUS_OF: Record<NavQueueKind, TabStatusKind> = { waiting: "decision", working: "working", done: "done" };

/**
 * The tabs a spoken "the … tab" walks: steering's status walk
 * (`statusTabs`), so voice and the status keys agree on the order, without
 * the root, the reserved scopes and tabs with no Chat (`hasChat`; the working
 * walk also holds busy shells).
 */
export function navQueue(
  kind: NavQueueKind,
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
  tabsByScope: Record<string, TabEntry[]>,
  hasChat: (scope: string, tab: TabEntry) => boolean,
): StatusTab[] {
  return statusTabs(STATUS_OF[kind], busyByTab, attentionByTab, tabsByScope)
    .filter(({ scope, key }) => {
      if (!isNavScope(scope)) return false;
      const tab = (tabsByScope[scope] ?? []).find((entry) => entry.key === key);
      return !!tab && isAgentTab(tab) && hasChat(scope, tab);
    });
}

/** The agent tab a project or box lands on: the one with the latest activity
 * (its last working or finished turn), else the first in strip order.
 * `undefined` for a scope with none. */
export function scopeAgentTab<T extends NavTab>(
  scope: string,
  tabs: readonly T[],
  lastWorkingByTab: Record<string, number>,
  lastDoneByTab: Record<string, number>,
): T | undefined {
  const agents = tabs.filter(isAgentTab);
  const at = (tab: T) => {
    const id = `${scope}:${tab.key}`;
    return Math.max(lastWorkingByTab[id] ?? 0, lastDoneByTab[id] ?? 0);
  };
  let best = agents[0];
  for (const tab of agents) if (at(tab) > (best ? at(best) : 0)) best = tab;
  return best;
}

/** The `n`-th tab of the scope, from 1, in strip order. */
export function tabAtNumber<T>(tabs: readonly T[], n: number): T | undefined {
  return Number.isInteger(n) && n >= 1 ? tabs[n - 1] : undefined;
}

/** "Claude tab 2" is the scope's second Claude tab; "Claude tab" its one with
 * the latest activity. */
export function agentTabChoice<T extends NavTab>(
  scope: string,
  tabs: readonly T[],
  agentName: string,
  agentLabel: (tab: T) => string,
  lastWorkingByTab: Record<string, number>,
  lastDoneByTab: Record<string, number>,
  n?: number,
): T | undefined {
  const family = agentFamily(agentName);
  const own = tabs.filter((tab) => isAgentTab(tab) && agentFamily(agentLabel(tab)) === family);
  if (n !== undefined) return own[n - 1];
  return scopeAgentTab(scope, own, lastWorkingByTab, lastDoneByTab);
}

// ---------------------------------------------------------------- the landing

/** A jump's note to the Chat it lands in. */
export interface DesktopLanding {
  /** The PTY id (`scope:key`) the jump went to. */
  ptyId: string;
  /** The jump was made with Hands-free on: the landing reads, then listens
   * gated; off, the mic just opens for dictation. */
  handsFree: boolean;
  /** "Claude in Alpha", said when the conversation has no prompt to read. */
  where: string;
  at: number;
}

/** A note older than this was never meant for the Chat that finds it. */
export const DESKTOP_LANDING_MAX_AGE_MS = 30_000;

let pending: DesktopLanding | null = null;
/** The Chats on screen, told of a note at once: a jump to a Chat that was
 * already showing (another subwindow) brings it into view no more. */
const watchers = new Set<() => void>();

/** Leaves the note (replacing any older one). */
export function leaveDesktopLanding(landing: Omit<DesktopLanding, "at">, now: number = Date.now()): void {
  pending = { ...landing, at: now };
  for (const watcher of [...watchers]) watcher();
}

/** Calls `onNote` whenever a note is left, until the returned function is called. */
export function watchDesktopLanding(onNote: () => void): () => void {
  watchers.add(onNote);
  return () => watchers.delete(onNote);
}

/** The Chat shown on `ptyId` takes the note, once. A note for another tab is
 * left for it (that Chat may still come into view); a stale one is dropped. */
export function takeDesktopLanding(ptyId: string, now: number = Date.now()): DesktopLanding | null {
  const landing = pending;
  if (!landing) return null;
  if (now - landing.at > DESKTOP_LANDING_MAX_AGE_MS) {
    pending = null;
    return null;
  }
  if (landing.ptyId !== ptyId) return null;
  pending = null;
  return landing;
}

/** Tests: no note left over. */
export function clearDesktopLanding(): void {
  pending = null;
}
