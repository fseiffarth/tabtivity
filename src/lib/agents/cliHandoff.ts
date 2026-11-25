import { readerRequest } from "./agentReader";
import type { TabEntry } from "../../stores/tabs";
import type { TranslationKey } from "../i18n";

/** What `agent_cli_handoff_prepare` reports about the file it writes (or would write). */
export interface CliHandoffPreview {
  /** Conversation entries in the file; the original request counts. */
  entries: number;
  /** Entries the read returned (at most 1000). */
  total: number;
  /** Earlier turns, or the oldest entries, are not in the file. */
  truncated: boolean;
  /** The file holds the conversation's first request. */
  firstRequest: boolean;
  /** Files the conversation's CLI recorded editing (0 also when that record is not read); not `git status`. */
  changedFiles: number;
  /** The previous agent's cockpit notes are in the file. */
  notes: boolean;
  /** The file holds the source session's answer to the summary prompt the request named. */
  summary?: boolean;
  /** The source session's prompt cache as its newest answer left it (Claude, Codex). */
  cache?: { lastAtMs: number; ttlSecs: number; contextTokens: number };
}

export interface CliHandoffPrepared {
  preview: CliHandoffPreview;
  /** `~/handoff/cli-<id>/HANDOFF.md`, as the new agent sees it; `null` when `previewOnly`. */
  file: string | null;
}

/** The source tab fields the request is built from. */
export type CliHandoffSource = Pick<TabEntry, "kind" | "cmd" | "localDriver" | "localLaunch" | "sessionId" | "launchedAt" | "args" | "cwd" | "id">;

/** The arguments of `agent_cli_handoff_prepare`: the Reader's tab identity
 * (the backend reads the conversation itself, none crosses IPC), the saved
 * tab's `id` for its cockpit notes, and the target CLI's binary. */
export function cliHandoffRequest(
  scope: string,
  tab: CliHandoffSource,
  cwd: string,
  target: string,
  previewOnly: boolean,
  summaryNonce?: string,
): Record<string, unknown> {
  const request = readerRequest(scope, tab, cwd, undefined, 0);
  if (!request) throw new Error("no_session");
  // Only the identity fields: `chat` would make the backend read the tab's own conversation again.
  const { agent, projectId, tabDir, since, sessionId, localModel, remoteHost } = request;
  return { agent, projectId, tabDir, since, sessionId, localModel, remoteHost, tabId: tab.id ?? null, target, previewOnly, summaryNonce: summaryNonce ?? null };
}

/** The summary prompt is offered only with at least this much of the source's prompt cache left. */
export const SUMMARY_MIN_CACHE_LEFT_MS = 120_000;
/** How long the dialog waits for the source session's summary. */
export const SUMMARY_WAIT_MS = 180_000;
/** How often the dialog looks for that summary in the source's conversation. */
export const SUMMARY_POLL_MS = 3_000;

/** Milliseconds of the source session's prompt cache left at `nowMs`; `null`
 * when the transcript says nothing about it (a CLI without cache data, a
 * local model). Never negative. */
export function summaryCacheLeftMs(cache: CliHandoffPreview["cache"], nowMs: number): number | null {
  if (!cache || !(cache.ttlSecs > 0) || !(cache.lastAtMs > 0)) return null;
  return Math.max(0, cache.lastAtMs + cache.ttlSecs * 1000 - nowMs);
}

/** A fresh nonce for the summary prompt's marker: 16 lowercase hex characters,
 * the shape `services::agent_cli_handoff::summary_nonce` accepts. */
export function newSummaryNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The marker the backend finds the summary prompt by (`SUMMARY_MARKER`). */
export function summaryMarker(nonce: string): string {
  return `[handoff-summary ${nonce}]`;
}

/** The backend rejects with a short code (a string); tests and transports may wrap it in an `Error`. */
export function cliHandoffErrorCode(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "";
}

/** The dialog's sentence for a failure; the generic text for any code it does not know. */
export function cliHandoffErrorKey(error: unknown): TranslationKey {
  switch (cliHandoffErrorCode(error)) {
    case "unsupported": return "cliHandoff.error.unsupported";
    case "no_session":
    case "no_transcript":
    case "read_failed": return "cliHandoff.error.noConversation";
    default: return "terminal.limitHandoff.failed";
  }
}

/** A failure that choosing Continue again cannot fix. */
export function cliHandoffErrorIsFinal(error: unknown): boolean {
  return cliHandoffErrorKey(error) !== "terminal.limitHandoff.failed";
}
