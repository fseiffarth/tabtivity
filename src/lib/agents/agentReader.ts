import type { TranslationKey } from "../i18n";
import type { SessionTranscript } from "../../../mobile-web/src/api";
import type { TabEntry } from "../../stores/tabs";
import { storageKey } from "../brand";

/**
 * The desktop agent pane's Reader: the phone's Focus Reader — the agent's
 * stored conversation as chat bubbles, read off the CLI's own transcript by
 * `agent_tab_transcript` (`services::agent_transcript`) — drawn over the
 * pane's terminal, which keeps running underneath. Optional per tab: the
 * terminal stays the default, and the last choice is remembered per agent
 * CLI, as the phone remembers its view.
 */

export type { SessionTranscript };

/** The agents whose transcript the backend reads; any other family answers
 * `unsupported` there. The phone bridge's list (`MobileBridgeHost`). */
const READER_AGENTS = new Set(["claude", "codex", "opencode"]);

/** A local-model tab's driver (`list_local_drivers` id): the one it was
 * started with, or the one its saved launch line names. Empty for any other
 * tab, and for a local tab started before the driver was recorded. */
export function localTabDriver(tab: Pick<TabEntry, "kind" | "localDriver" | "localLaunch">): string {
  return tab.kind === "local_agent" ? tab.localDriver ?? tab.localLaunch?.driver ?? "" : "";
}

/** The agent whose transcript `tab` keeps, as `agent_tab_transcript` names
 * it: a local-model tab runs its driver through `ollama launch <driver>`, so
 * its `cmd` names no agent. Only an OpenCode driver is readable there:
 * OpenCode is found by folder, while Claude's and Codex's transcripts need
 * the launch id a local tab never mints. */
export function readerAgent(tab: Pick<TabEntry, "kind" | "cmd" | "localDriver" | "localLaunch">): string {
  if (tab.kind !== "local_agent") return tab.cmd;
  return localTabDriver(tab) === "opencode" ? "opencode" : "";
}

/** Whether `tab` can be shown as a Reader: an agent tab whose CLI keeps a
 * transcript Tabtivity reads — a local-model tab only when OpenCode drives it. */
export function readerOffered(
  tab: Pick<TabEntry, "kind" | "cmd" | "localDriver" | "localLaunch"> | undefined,
): boolean {
  return !!tab && (tab.kind === "agent" || tab.kind === "local_agent") && READER_AGENTS.has(readerAgent(tab));
}

/** How many turns a read asks for first, and how many more each "earlier". */
export const READER_STEP = 60;

/** The `agent_tab_transcript` arguments for `tab` in `scope` — the phone
 * bridge's resolution: OpenCode's session is the newest one of the folder the
 * tab runs in, begun since it launched unless it was restored with
 * `--continue`. Null for a tab with no session id yet (the agent's hook has
 * not recorded one): there is no transcript to name — except a local-model
 * OpenCode tab, which never gets one and is read by folder from the scope's
 * local-model home (`localModel`). `subagent` is the handle on one of its
 * `agent` entries, whose own conversation is read instead. */
export function readerRequest(
  scope: string,
  tab: Pick<TabEntry, "kind" | "cmd" | "localDriver" | "localLaunch" | "sessionId" | "launchedAt" | "args" | "cwd">,
  cwd: string | undefined,
  version: string | undefined,
  limit: number,
  subagent?: string,
): Record<string, unknown> | null {
  const localModel = tab.kind === "local_agent";
  if (!tab.sessionId && !localModel) return null;
  return {
    agent: readerAgent(tab),
    projectId: scope === "root" ? null : scope,
    tabDir: tab.cwd || cwd || null,
    since: tab.launchedAt && !tab.args?.includes("--continue") ? tab.launchedAt : null,
    sessionId: tab.sessionId ?? "",
    subagent: subagent ?? null,
    version: version ?? null,
    limit,
    localModel,
  };
}

/** Why the stored session is not shown, for the Reader's empty state. */
export function readerReasonKey(transcript: SessionTranscript | null): TranslationKey {
  if (!transcript) return "terminal.reader.loading";
  switch (transcript.reason) {
    case "unsupported": return "terminal.reader.unsupported";
    case "no_session": return "terminal.reader.noSession";
    case "no_transcript": return "terminal.reader.missing";
    default: return "terminal.reader.unreadable";
  }
}

/** The prompts ↑ walks in the Reader's composer, oldest first — what ↑ does
 * in the CLI's own input box: the session's prompts as its transcript records
 * them, then any still showing as sending. A prompt sent twice in a row is
 * kept once, as a shell's history keeps it. */
export function composerHistory(
  entries: readonly { kind: string; text?: string }[],
  sending: readonly string[] = [],
): string[] {
  const history: string[] = [];
  const add = (text: string | undefined) => {
    const prompt = text?.trim();
    if (prompt && history[history.length - 1] !== prompt) history.push(prompt);
  };
  for (const entry of entries) if (entry.kind === "prompt") add(entry.text);
  for (const text of sending) add(text);
  return history;
}

/** Shortens `path` for the facts row: its last `keep` segments behind `…/`
 * (the whole path stays in the fact's tooltip). */
export function shortPath(path: string, keep = 2): string {
  const trimmed = path.replace(/[/\\]+$/u, "") || path;
  const parts = trimmed.split(/[/\\]/u).filter(Boolean);
  if (parts.length <= keep) return trimmed;
  return `…/${parts.slice(-keep).join("/")}`;
}

/** A fresh read merged over the last one: `unchanged` keeps what is shown. */
export function mergeTranscript(previous: SessionTranscript | null, next: SessionTranscript): SessionTranscript {
  return next.unchanged && previous ? previous : next;
}

const STORAGE_KEY = storageKey("agentReader.byAgent");
/** The one window-wide choice that briefly replaced the per-CLI one: a CLI
 * without its own choice yet starts from it. */
const SHARED_KEY = storageKey("agentReader.open");

function readChoices(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** The view the user last picked for this agent CLI's tabs: true for the
 * Reader. Unset (or unreadable storage) is the terminal. */
export function rememberedReader(agent: string): boolean {
  const chosen = readChoices()[agent];
  if (typeof chosen === "boolean") return chosen;
  try {
    return localStorage.getItem(SHARED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Every CLI's remembered view, for the store's start. */
export function rememberedReaders(): Record<string, boolean> {
  return Object.fromEntries([...READER_AGENTS].map((agent) => [agent, rememberedReader(agent)]));
}

export function rememberReader(agent: string, on: boolean): void {
  try {
    const choices = readChoices();
    choices[agent] = on;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // A convenience only: without storage every tab opens on its terminal.
  }
}

const CHANGES_KEY = storageKey("agentReader.changes");
const CHANGES_WIDTH_KEY = storageKey("agentReader.changesWidth");
/** The Changes panel's width before the user drags it. */
export const CHANGES_DEFAULT_WIDTH = 520;
export const CHANGES_MIN_WIDTH = 260;

/** Every CLI's remembered choice for the Reader's Changes panel (the diffs
 * beside the chat): shown or not, closed unless picked. */
export function rememberedChanges(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHANGES_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function rememberChanges(agent: string, on: boolean): void {
  try {
    localStorage.setItem(CHANGES_KEY, JSON.stringify({ ...rememberedChanges(), [agent]: on }));
  } catch {
    // A convenience only: without storage the panel starts closed.
  }
}

/** The Changes panel's width as last dragged, in px. */
export function rememberedChangesWidth(): number {
  try {
    const width = Number(localStorage.getItem(CHANGES_WIDTH_KEY));
    return Number.isFinite(width) && width >= CHANGES_MIN_WIDTH ? width : CHANGES_DEFAULT_WIDTH;
  } catch {
    return CHANGES_DEFAULT_WIDTH;
  }
}

export function rememberChangesWidth(width: number): void {
  try {
    localStorage.setItem(CHANGES_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // A convenience only.
  }
}
