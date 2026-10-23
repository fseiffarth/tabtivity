/**
 * Agent tabs that run a *cloud* session — the CLI vendor's own hosted
 * sandbox — instead of the agent in the project folder.
 *
 * Only CLIs with a launch-time entry point are listed. Several others reach a
 * cloud only from *inside* a running session (Cursor's and Mistral's `&`
 * prefix, Gemini's `/jules`, Copilot's `/delegate`) or have no cloud at all;
 * those need no tab of their own and are left out. Checked 2026-09-26 against
 * the installed `--help` (Claude 2.1.283, Copilot 1.0.88) and the vendors'
 * docs (Codex `codex cloud`, Kiro `--cloud`, Mistral `vibe --remote`).
 *
 * Two actions:
 *   - `new`  starts a cloud session. Some CLIs take the task on the command
 *            line and need it up front (`needsTask`).
 *   - `open` picks an existing one (Claude's `--teleport` pulls it into this
 *            terminal; Copilot's `--connect` attaches; Codex's `cloud` TUI lists
 *            and starts tasks).
 *
 * A cloud tab is deliberately **not** resumable: restore rebuilds an agent's
 * args from `RESUMABLE_AGENTS` (a `--resume` of a *local* session), which a
 * cloud tab never had, and re-running its launch args would start a second
 * cloud session. The session itself lives on with the vendor either way.
 */

export type CloudAction = "new" | "open";

export interface CloudLaunch {
  action: CloudAction;
  /** The CLI takes the task on its command line, so it is asked for first. */
  needsTask: boolean;
  /** Launch args; `task` is the trimmed task text ("" when not needed). */
  args: (task: string) => string[];
  /** An `open` that can take one session by id, as its cloud tab printed it
   *  (`cleanCloudSession` checks the id first). */
  session?: (id: string) => string[];
}

const CLOUD_LAUNCHES: Readonly<Record<string, readonly CloudLaunch[]>> = {
  claude: [
    { action: "new", needsTask: true, args: (task) => ["--cloud", task] },
    { action: "open", needsTask: false, args: () => ["--teleport"], session: (id) => ["--teleport", id] },
  ],
  codex: [{ action: "open", needsTask: false, args: () => ["cloud"] }],
  "kiro-cli": [{ action: "new", needsTask: false, args: () => ["--cloud"] }],
  vibe: [{ action: "new", needsTask: true, args: (task) => ["--remote", task] }],
  copilot: [{ action: "open", needsTask: false, args: () => ["--connect"] }],
};

/** The cloud launches a built-in agent command offers (empty for most). */
export function cloudLaunchesFor(cmd: string): readonly CloudLaunch[] {
  return Object.prototype.hasOwnProperty.call(CLOUD_LAUNCHES, cmd) ? CLOUD_LAUNCHES[cmd] : [];
}

/** One agent's launch for `action`, or undefined when it has none. */
export function cloudLaunch(cmd: string, action: string): CloudLaunch | undefined {
  return cloudLaunchesFor(cmd).find((launch) => launch.action === action);
}

/** Longest task accepted — a phone's request is bounded the same way. */
export const MAX_CLOUD_TASK = 4000;

/**
 * The task text as it may go on a command line, or null when it cannot:
 * empty, over-long, or carrying terminal control characters (newlines and
 * tabs are prose and stay).
 */
export function cleanCloudTask(task: string | undefined): string | null {
  const text = (task ?? "").trim();
  if (!text || [...text].length > MAX_CLOUD_TASK) return null;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return null;
  return text;
}

/**
 * A cloud session id as it may go on a command line (`session_011SU65r…`), or
 * null: letters, digits, `_` and `-`, never a leading `-` that would read as a
 * flag. The sidecar's `protocol::is_cloud_session_id` is the same rule.
 */
export function cleanCloudSession(id: string | undefined): string | null {
  return id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : null;
}
