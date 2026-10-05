/** Pure frontend helpers for the agent-fence settings and project-pill states. */

import { envName } from "../brand";

export interface AgentFenceStatus {
  /** Prospective spawn policy, not an inspection of already-running tabs. */
  enforced: boolean;
  reason: string;
  roots: string[];
  bwrap_available: boolean;
  /** The backend's distro-aware install command for the missing fence tool;
   *  absent/null when the tool works or no command is worth running. */
  install_cmd?: string | null;
}

/** The pill's one-click install for a missing fence tool, or `null` when the
 *  button must not be offered: the tool works, the distribution is unknown, or
 *  a backend that predates the field sends no command. Never a guessed `apt`. */
export function agentFenceInstallCommand(status: AgentFenceStatus | null | undefined): string | null {
  if (!status || status.bwrap_available) return null;
  return status.install_cmd || null;
}

/** The marker `pty_spawn`'s refusal carries on a platform with no fence
 *  (Windows) while the user has not yet accepted that agents run with their
 *  full rights. Mirrors `agent_fence::PLATFORM_UNACCEPTED_SENTINEL`. */
export const FENCE_PLATFORM_UNACCEPTED = envName("FENCE_PLATFORM_UNACCEPTED");

/** Whether a spawn error is that refusal — the one a `UnfencedPlatformDialog`
 *  answer lifts — rather than something to print as it is. */
export function unfencedPlatformRefusal(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return text.includes(FENCE_PLATFORM_UNACCEPTED);
}

export const AGENT_FENCE_DEFAULT_PATHS = [
  "~/.local/bin",
  "~/.local/share/claude",
  "~/.local/share/pnpm",
  "~/.nvm",
  "~/.cargo",
  "~/.rustup",
  "~/anaconda3",
  "~/miniconda3",
  "~/.pyenv",
  "~/.bun",
  "~/go",
  "~/.gitconfig",
  "~/.config/git",
] as const;

export function parseAgentFencePaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path, index, all) => path !== "" && all.indexOf(path) === index);
}

export type AgentFenceReasonKey =
  | "pill.agentFenceReasonRemote"
  | "pill.agentFenceReasonMacos"
  | "pill.agentFenceReasonWindows"
  | "pill.agentFenceReasonPlatform"
  | "pill.agentFenceReasonContainer"
  | "pill.agentFenceReasonHostSession"
  | "pill.agentFenceReasonBwrap"
  | "pill.agentFenceReasonSeatbelt"
  | "pill.agentFenceReasonUnknown";

export function agentFenceReasonKey(reason: string): AgentFenceReasonKey | null {
  const keys: Record<string, AgentFenceReasonKey> = {
    "remote host": "pill.agentFenceReasonRemote",
    macOS: "pill.agentFenceReasonMacos",
    Windows: "pill.agentFenceReasonWindows",
    "this platform": "pill.agentFenceReasonPlatform",
    container: "pill.agentFenceReasonContainer",
    "host session": "pill.agentFenceReasonHostSession",
    "bubblewrap unavailable": "pill.agentFenceReasonBwrap",
    "sandbox-exec unavailable": "pill.agentFenceReasonSeatbelt",
    "unknown project or box": "pill.agentFenceReasonUnknown",
  };
  return keys[reason] ?? null;
}

/** The project pill's fence marker (`agent_fence_marks`): how many live agent
 *  tabs run outside the fence right now — measured from the agent processes,
 *  so a tab started before the fence became the only mode (and kept alive by
 *  a tmux reattach) still counts. The fence has no "off" any more. */
export interface AgentFenceMark {
  live_unfenced: number;
}

export type AgentFenceMarkLevel = "live";

export function agentFenceMarkLevel(mark: AgentFenceMark | undefined): AgentFenceMarkLevel | null {
  if (!mark) return null;
  return mark.live_unfenced > 0 ? "live" : null;
}
