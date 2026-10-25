import { invoke } from "@tauri-apps/api/core";

/** Mirrors `commands::agents::AgentUsageReport`. */
export interface AgentUsageReport {
  agent: string;
  label: string;
  supported: boolean;
  raw?: string;
  error?: string;
  /** The refusal as one fixed code (`unknown_agent`, `no_usage_readout`,
   * `cli_not_installed`, `cli_failed`, `cli_timeout`, `cli_error`) — what the
   * phone is shown in place of `error`, which may name paths on this machine. */
  code?: string;
  cached: boolean;
}

/** The phone may see quota figures, but never host paths. A diagnostic or a
 * contribution row can name a local file beside an otherwise useful panel:
 * omit that whole line, marking the omission, rather than withholding every
 * meter. Keep unknown, path-free output readable too. */
export function mobileUsageText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const localPath = /(^|[\s("'`=:])(?:~[/\\]|\/(?:home|Users|tmp|var|etc|opt|usr|root|mnt|media|private|srv|run|Volumes)\/|\/(?:[^\s/]+\/)+|[A-Za-z]:[/\\]|\\\\)/u;
  let readable = false;
  const lines = raw.split(/\r?\n/u).map((line) => {
    if (localPath.test(line)) return "…";
    if (line.trim()) readable = true;
    return line;
  });
  return readable ? lines.join("\n") : undefined;
}

/**
 * Ask one agent CLI what it says about its own usage.
 *
 * Never throws: a failed `invoke` is turned into the same shaped refusal the
 * backend returns for an agent it cannot run, so every caller has one thing to
 * render — the panel, or the reason there is none, always next to the agent it
 * is about. `refresh` means "ask the CLI again" and is still floored on the
 * backend side, so a held-down button cannot become one process per tap.
 */
export function readAgentUsage(agent: string, refresh = false): Promise<AgentUsageReport> {
  return invoke<AgentUsageReport>("agent_usage", { agent, refresh }).catch(
    (cause): AgentUsageReport => ({
      agent,
      label: agent,
      supported: false,
      error: String(cause),
      cached: false,
    }),
  );
}
