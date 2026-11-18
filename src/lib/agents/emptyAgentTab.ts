import { agentTurnStartedAt } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import { envName } from "../brand";

/**
 * "Open a new agent tab" reuses an agent tab of the same CLI that has not been
 * asked anything yet, instead of piling up a second blank one.
 *
 * Empty means: opened in this run (`launchedAt` — a restored or resumed tab
 * carries a conversation we cannot see), no prompt submitted to it, and no
 * turn ever seen on it. Tabtivity sees prompts only as bytes going into the
 * PTY, so the two signals cover each other: `notePrompted` is raised where a
 * submit is counted (typed, scheduled, held, Reader), and `agentTurnStartedAt`
 * catches a turn begun by a route that heap never saw (a phone composer, a
 * popout). Never persisted: after a restart `launchedAt` is gone, so nothing
 * restored is ever called empty.
 */
const promptedPtys = new Set<string>();

/** A prompt was submitted to the agent on `ptyId`. */
export function notePrompted(ptyId: string): void {
  promptedPtys.add(ptyId);
}

/** Test seam. */
export function _resetPromptedForTest(): void {
  promptedPtys.clear();
}

const AGENT_KINDS = new Set<string>(["agent", "local_agent"]);

/** The launch arguments minus the session id this tab was minted with, so two
 *  launches of the same agent compare equal. */
function argsWithoutSession(tab: Pick<TabEntry, "args" | "sessionId">): string[] {
  const args = tab.args ?? [];
  if (!tab.sessionId) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === tab.sessionId) {
      // Drop the flag that carried it (`--session-id <uuid>`) too.
      if (out.length > 0 && out[out.length - 1].startsWith("-")) out.pop();
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function envWithoutUid(env: Record<string, string> | undefined): [string, string][] {
  const uid = envName("TAB_UID");
  return Object.entries(env ?? {})
    .filter(([name]) => name !== uid)
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Whether `tab` is an agent that has never been asked anything. */
export function isEmptyAgentTab(scope: string, tab: TabEntry): boolean {
  if (!AGENT_KINDS.has(tab.kind)) return false;
  if (tab.launchedAt === undefined || tab.cloud || tab.login) return false;
  const ptyId = `${tab.scope ?? scope}:${tab.key}`;
  return !promptedPtys.has(ptyId) && agentTurnStartedAt(ptyId) === undefined;
}

/**
 * Whether `tab` is an empty tab of the very launch `spec` describes: the same
 * CLI, folder (worktree), machine, arguments and environment. A tab launched
 * differently — another model, an own-login variant, a remote host — is not
 * what the click asked for.
 */
export function isReusableFor(scope: string, tab: TabEntry, spec: Omit<TabEntry, "key">): boolean {
  if (!isEmptyAgentTab(scope, tab)) return false;
  if (tab.kind !== spec.kind || tab.cmd !== spec.cmd || tab.cwd !== spec.cwd) return false;
  if (tab.location !== spec.location || !!tab.apiKey !== !!spec.apiKey) return false;
  if (JSON.stringify(argsWithoutSession(tab)) !== JSON.stringify(argsWithoutSession(spec))) return false;
  return JSON.stringify(envWithoutUid(tab.env)) === JSON.stringify(envWithoutUid(spec.env));
}

/** The empty tab of `tabs` a launch of `spec` should take over, if any. */
export function findEmptyAgentTab(
  scope: string,
  tabs: readonly TabEntry[],
  spec: Omit<TabEntry, "key">,
): TabEntry | undefined {
  if (!AGENT_KINDS.has(spec.kind) || spec.cloud || spec.login) return undefined;
  return tabs.find((tab) => isReusableFor(scope, tab, spec));
}
