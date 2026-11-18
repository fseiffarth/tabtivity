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
  /** A count of files the conversation changed or the working tree shows. */
  changedFiles: number;
  /** The previous agent's cockpit notes are in the file. */
  notes: boolean;
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
): Record<string, unknown> {
  const request = readerRequest(scope, tab, cwd, undefined, 0);
  if (!request) throw new Error("no_session");
  // Only the identity fields: `chat` would make the backend read the tab's own conversation again.
  const { agent, projectId, tabDir, since, sessionId, localModel, remoteHost } = request;
  return { agent, projectId, tabDir, since, sessionId, localModel, remoteHost, tabId: tab.id ?? null, target, previewOnly };
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
