import { invoke } from "@tauri-apps/api/core";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { onTerminalExit } from "../../lib/terminal/terminalBus";
import { useTabsStore, type TabEntry } from "../tabs";
import { resumeArgsOf } from "./closedAgentTabs";

/**
 * Moving an agent tab to another worktree of its project — the Reader's branch
 * chip (`TerminalReaderFacts`). The tab's CLI is stopped (its own tmux session
 * ended, the PTY killed and its exit waited for: a CLI still running would
 * write on into the conversation being moved), the backend takes the
 * conversation along (`agent_tab_move_session`, `services::agent_relocate`),
 * and the pane respawns in the new folder on the args a restore would give it
 * (`relaunchTabInScope`). The folder is the tab's `cwd`, so a restart keeps it
 * (`restoredAgentCwd`).
 *
 * A move that fails respawns the tab where it was. Local projects only, as the
 * "+" menu's worktree agents (`components/tabs/agentWorktrees.ts`).
 */

/** How long the old CLI's exit is waited for before the move goes ahead. */
const EXIT_WAIT_MS = 3_000;

/** `carried`: the conversation goes on there. `fresh`: the CLI started a new
 * one there. `failed`: the tab came back in its old folder. */
export type WorktreeSwitchResult = "carried" | "fresh" | "failed";

export async function switchAgentWorktree(
  scope: string,
  tab: TabEntry,
  to: string,
  label: string,
): Promise<WorktreeSwitchResult> {
  const ptyId = `${scope}:${tab.key}`;
  let off = () => {};
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, EXIT_WAIT_MS);
    off = onTerminalExit(ptyId, () => {
      clearTimeout(timer);
      resolve();
    });
  });
  let stopped = true;
  try {
    // Never a session the tab only attached to.
    const session = IS_HOST_WINDOWS || tab.tmuxAttach ? null : tab.tmuxSession;
    if (session) await invoke("local_tmux_kill", { session });
    await invoke("pty_kill", { id: ptyId });
    await exited;
  } catch {
    stopped = false;
  } finally {
    off();
  }
  let moved: WorktreeSwitchResult = "failed";
  if (stopped) {
    try {
      moved = await invoke<"carried" | "fresh">("agent_tab_move_session", {
        agent: tab.cmd,
        projectId: scope,
        sessionId: tab.sessionId ?? "",
        from: tab.cwd,
        to,
      });
    } catch {
      moved = "failed";
    }
  }
  useTabsStore.getState().relaunchTabInScope(
    scope,
    tab.key,
    resumeArgsOf(tab),
    moved === "failed" ? undefined : { cwd: to, label },
  );
  return moved;
}
