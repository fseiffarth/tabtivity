import { AGENT_CLI_ROWS, SESSION_ID_ARG, type AgentCliRow } from "./agentCliTable";

/**
 * The built-in agent CLIs, read synchronously — a restored tab's kind
 * (`cmdToKind`), its resume args and the + menu's rows cannot await
 * `list_agents`. The rows are generated from the backend registry
 * (`commands/agents.rs` `AGENTS`, see `agentCliTable.ts`), which stays the one
 * source: a CLI added there restores as an agent, never as a shell, and the
 * backend's own restore allow-list (`terminal_service`) and the phone's
 * resumable set (`mobile_control`) read the same table.
 */
export { AGENT_CLI_ROWS, type AgentCliRow };

/** Every built-in agent CLI's binary: a tab whose `cmd` is one of these is an
 *  agent tab. */
export const AGENT_BINS: ReadonlySet<string> = new Set(AGENT_CLI_ROWS.map((row) => row.bin));

/**
 * Agents whose prior session can be resumed, mapping `cmd` → the launch args
 * that relaunch it with that session. Two resume styles:
 *
 *  - id-based: Claude (`--resume <id>`), Codex (`codex resume`) and Vibe
 *    (`--resume <id>`) resume a captured session; the backend injects the
 *    latter two from their per-tab hook records.
 *  - cwd "continue last": the rest have no caller-supplied launch id, so
 *    the tab re-launches with their "continue the most recent session" flag.
 *    Because each agent tab launches in the project directory, that
 *    most-recent session IS the tab's prior conversation. These ignore the
 *    minted id (it only satisfies the persistence gate and is set as the tab's
 *    `TAB_UID`). Caveat: two tabs of the same agent in one project both resume
 *    that project's single latest session, so they can't be told apart on
 *    restore.
 *
 * A CLI with no per-session resume (Aider) is absent. Null-prototype, so
 * `cmd in RESUMABLE_AGENTS` is never true for an inherited key.
 */
export const RESUMABLE_AGENTS: Readonly<Record<string, (id: string) => string[]>> = Object.assign(
  Object.create(null) as Record<string, (id: string) => string[]>,
  Object.fromEntries(
    AGENT_CLI_ROWS.flatMap((row) => {
      const resume = row.resume;
      if (!resume) return [];
      return [[row.bin, (id: string) => resume.map((arg) => (arg === SESSION_ID_ARG ? id : arg))]];
    }),
  ),
);
