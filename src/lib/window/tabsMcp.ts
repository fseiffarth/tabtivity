/**
 * The typed invoke surface for tab messaging (`services::tabs_mcp`,
 * `commands/tabs_mcp.rs`): agent tabs of one project leave each other short
 * plain-text messages through the `-tabs` MCP lane, and the window shows every
 * one of them. Message text is agent-authored: it is rendered as plain React
 * text and never put into a prompt. What a prompt may carry is the host's
 * fixed `notice`, returned by `deliverTabMessages` and `claimTabMessageWakes`.
 */

import { invoke } from "@tauri-apps/api/core";

/** `services::tabs_mcp::CHANGED_EVENT`. */
export const TABS_MCP_CHANGED = "tabs-mcp-changed";

/** One message (`services::tabs_mcp::MessageView`). Tab ids are saved
 *  workspace tab ids (`TabEntry.id`), never handles. */
export interface TabMessage {
  id: string;
  fromTab: string;
  toTab: string;
  /** RFC 3339, UTC. */
  sentAt: string;
  replyTo?: string;
  /** Written by the sending agent: shown as plain text only. */
  text: string;
  /** The recipient acked it. */
  read: boolean;
}

/** What Deliver queues: the host's fixed notice for one schedule target. */
export interface TabMessagesDelivery {
  notice: string;
  scheduleTargetId: string;
}

/** The idle wake's claims for one project. */
export interface TabMessagesWake {
  notice: string;
  scheduleTargetIds: string[];
}

/** `scope`'s messages, oldest first (all, or those `tabId` sent or received).
 *  Resolves `[]` on a backend without the command (an older build). */
export async function tabMessages(scope: string, tabId?: string): Promise<TabMessage[]> {
  try {
    return (await invoke<TabMessage[] | null>("tabs_mcp_traffic", { scope, tabId: tabId ?? null })) ?? [];
  } catch {
    return [];
  }
}

/** The notice and the tab's schedule target for the user's Deliver click.
 *  Rejects with `off`, `nothing_unread` or `not_found`. */
export function deliverTabMessages(scope: string, tabId: string): Promise<TabMessagesDelivery> {
  return invoke<TabMessagesDelivery>("tabs_mcp_deliver", { scope, tabId });
}

/** Empty `scope`'s mailbox; how many messages went. */
export function clearTabMessages(scope: string): Promise<number> {
  return invoke<number>("tabs_mcp_clear", { scope });
}

/** The per-project idle wake's claims (empty when its opt-in is off). */
export async function claimTabMessageWakes(scope: string): Promise<TabMessagesWake | null> {
  try {
    return await invoke<TabMessagesWake>("tabs_mcp_wake_claim", { scope });
  } catch {
    return null;
  }
}

/** Whether some project opts in to the idle wake (set by `TabMessagesHost`):
 *  only then does the window report the user's typing below. */
let wakeActive = false;
/** When each PTY's typing was last reported (throttled). */
const humanReported = new Map<string, number>();
const HUMAN_REPORT_MS = 2000;

export function setTabMessagesWakeActive(active: boolean): void {
  wakeActive = active;
  if (!active) humanReported.clear();
}

/**
 * The user typed into PTY `ptyId` (desktop or phone; called from
 * `noteInputFrom`): a turn the user started, so the tab's wake-started turn is
 * over and what it sends next may wake its recipient again
 * (`tabs_mcp::human_input`). Reported only while a project opts in to the
 * wake, at most once per {@link HUMAN_REPORT_MS} per PTY.
 */
export function noteTabMessagesHumanInput(ptyId: string, now = Date.now()): void {
  if (!wakeActive) return;
  const last = humanReported.get(ptyId);
  if (last !== undefined && now - last < HUMAN_REPORT_MS) return;
  humanReported.set(ptyId, now);
  invoke("tabs_mcp_human_input", { id: ptyId }).catch(() => {
    // An older backend: nothing to end.
  });
}
