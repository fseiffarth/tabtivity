import { invoke } from "@tauri-apps/api/core";
import { RESUMABLE_AGENTS } from "../../lib/agents/agentClis";
import { agentSwitchChoices, sameDir, worktreeName, type GitWorktree, type Translate } from "../../lib/agents/agentWorktrees";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { onTerminalExit } from "../../lib/terminal/terminalBus";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
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

/** The folder a tab of `project` can be moved between worktrees of, or ""
 * where the move does not apply: local projects only (not remote, not a VM),
 * and only an agent whose conversation a restart resumes — the move is a
 * respawn in the new folder. The phone's ⎇ chip asks the same
 * (`discovery`'s `worktree_movable`, the bridge's `TabWorktrees`). */
export function worktreeMoveDir(tab: TabEntry, project: ProjectEntry | undefined, assistant: boolean): string {
  const dir = project && !project.remote && !project.vm?.enabled ? resolveProjectDirectory(project) : "";
  return tab.kind === "agent" && !assistant && !!tab.sessionId
    && (tab.cmd in RESUMABLE_AGENTS || !!tab.resumeArgs?.length) ? dir : "";
}

/** The folders a tab of the project at `projectDir` can move to
 * (`agentSwitchChoices`); empty when they cannot be read. */
export async function agentSwitchChoicesIn(projectDir: string): Promise<GitWorktree[]> {
  try {
    return agentSwitchChoices((await invoke<GitWorktree[]>("git_worktree_list", { projectDir, site: "mirror" })) ?? [], projectDir);
  } catch {
    return [];
  }
}

/** Move `tab` to `to`, one of `choices` (`agentSwitchChoicesIn`) — the one
 * move both the Reader's ⎇ chip and the phone's run: the label follows the
 * branch (`movedTabLabel`), and a pick of the folder it is in moves nothing. */
export function moveAgentToWorktree(
  scope: string,
  tab: TabEntry,
  choices: GitWorktree[],
  to: GitWorktree,
  t: Translate,
): Promise<WorktreeSwitchResult | "unchanged"> {
  if (sameDir(to.path, tab.cwd)) return Promise.resolve("unchanged");
  const from = choices.find((w) => sameDir(w.path, tab.cwd));
  return switchAgentWorktree(scope, tab, to.path, movedTabLabel(tab.label, from, to, t));
}

/** The tab's label for its move from the worktree `from` to `to`: the "+"
 * menu's `<agent> · <branch>` names the new branch (none in the project
 * folder); a label the user gave stays as it is. */
function movedTabLabel(label: string, from: GitWorktree | undefined, to: GitWorktree, t: Translate): string {
  const branchOf = (w: GitWorktree) => w.branch || worktreeName(w.path);
  const oldTail = from && !from.is_main ? t("newTabMenu.agentWorktreeLabel", { agent: "", branch: branchOf(from) }) : "";
  if (from && !from.is_main && !label.endsWith(oldTail)) return label;
  const base = oldTail ? label.slice(0, -oldTail.length) : label;
  return to.is_main ? base : t("newTabMenu.agentWorktreeLabel", { agent: base, branch: branchOf(to) });
}

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
