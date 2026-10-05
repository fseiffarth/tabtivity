import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { splitPtyId } from "../../lib/terminal/ptyId";
import type { ClearMark } from "../../../mobile-web/src/terminal/clearedSession";
import { IS_WINDOWS } from "../../lib/platform";
import { useActivityStore } from "../activity";
import { useProjectsStore } from "../projects";
import {
  RESUMABLE_AGENTS,
  effectiveTabLocation,
  isResumableAgentTab,
  useTabsStore,
  type TabEntry,
} from "../tabs";

/**
 * "Undo clear" for every agent tab Tabtivity can resume, on the desktop and —
 * through the mobile bridge — on the phone.
 *
 * A `/clear` (Codex's `/new`, …) starts a fresh conversation, but the one it
 * ended stays on disk, and taking it back is what a restart of Tabtivity already
 * does for a tab: resume the conversation the tab was in.
 *
 *  - Claude resumes in-session: the hook keeps the cleared conversation's id
 *    beside the tab's record (`<uid>.prev`) and `agent_tab_undo_clear` answers
 *    `/resume <id>`, typed into the running session.
 *  - Codex has its record pointed back at the cleared conversation by the
 *    backend, and is relaunched onto it.
 *  - Every other resumable agent (`RESUMABLE_AGENTS`, a custom agent's
 *    `resumeArgs`) is relaunched on its own resume flag — Vibe's by the id its
 *    hook recorded, which the clear has not moved yet, the rest on "continue
 *    the latest conversation", which the cleared one still is while the new chat
 *    holds nothing.
 *
 * A relaunch is the restart path for one tab: its own tmux session ends (a
 * session left running would only be reattached) and the pane respawns with
 * the resume args a restore would give it (`relaunchTabInScope`). Local tabs
 * only; a tab running on a remote host is not relaunched from here.
 *
 * `cleared` is what the terminal's card shows from: a `clear` the hooks relay
 * (`agent-session-roll`, Claude and Codex) or a new-conversation command typed
 * into the pane (`noteTypedClear`), until the next prompt goes in, the session
 * is resumed, or the user dismisses it.
 *
 * `marks` is where the Reader's conversation stood when that clear came
 * (`clearedSession.ts`, the phone's own rule): the Reader shows only what
 * follows it, so the cleared chat is gone before the card offers to bring it
 * back. It outlives the card — Codex reads the cleared session until its first
 * prompt — and goes only when the conversation is resumed (`null`: taken, with
 * nothing to hide).
 */
interface AgentClearUndoStore {
  /** Composed PTY id → true while that tab offers "Undo clear". */
  cleared: Record<string, true>;
  /** Composed PTY id → the Reader's mark for that tab's last clear. */
  marks: Record<string, ClearMark | null>;
  /** How the tab's session just (re)started, from the hook's source record.
   *  Only `clear` offers the undo and only `resume` withdraws it: a Codex `/new`
   *  may report a plain start right after the typed command offered it. */
  noteRoll: (ptyId: string, source: string) => void;
  /** Stop offering the undo for this tab. */
  dismiss: (ptyId: string) => void;
  /** Where the Reader stood at this tab's clear. */
  setMark: (ptyId: string, mark: ClearMark | null) => void;
  /** The cleared conversation is the tab's again: the Reader shows all of it. */
  forgetMark: (ptyId: string) => void;
}

export const useAgentClearUndoStore = create<AgentClearUndoStore>((set, get) => ({
  cleared: {},
  marks: {},
  noteRoll: (ptyId, source) => {
    if (source === "clear") {
      if (get().cleared[ptyId]) return;
      // A new clear: the Reader marks again from what it shows now.
      get().forgetMark(ptyId);
      set((state) => ({ cleared: { ...state.cleared, [ptyId]: true } }));
    } else if (source === "resume") {
      get().dismiss(ptyId);
      get().forgetMark(ptyId);
    }
  },
  dismiss: (ptyId) => {
    if (!get().cleared[ptyId]) return;
    set((state) => {
      const cleared = { ...state.cleared };
      delete cleared[ptyId];
      return { cleared };
    });
  },
  setMark: (ptyId, mark) => set((state) => ({ marks: { ...state.marks, [ptyId]: mark } })),
  forgetMark: (ptyId) => {
    if (!(ptyId in get().marks)) return;
    set((state) => {
      const marks = { ...state.marks };
      delete marks[ptyId];
      return { marks };
    });
  },
}));

/** Whether a tab's clear can be taken back at all: an agent Tabtivity resumes. */
export function canUndoClear(tab: TabEntry): boolean {
  return isResumableAgentTab(tab);
}

/** A new-conversation command was typed into this pane: offer the undo when
 * the tab is one whose conversation can come back.
 *
 * Not while the agent is at work (`busy`, read before the command went in):
 * Claude queues the command behind the turn and Codex refuses it, so the
 * conversation on screen is not cleared yet. Hiding it and offering the undo
 * then took back the clear before — resuming the conversation that one ended
 * and leaving the prompt sent since behind. A queued `/clear` is reported by
 * the hook when it runs (`agent-session-roll`). */
export function noteTypedClear(ptyId: string, busy = !!useActivityStore.getState().busyByTab[ptyId]): void {
  if (busy) return;
  const parts = splitPtyId(ptyId);
  const tab = parts && useTabsStore.getState().tabsByScope[parts.scope]?.find((entry) => entry.key === parts.key);
  if (tab && canUndoClear(tab)) useAgentClearUndoStore.getState().noteRoll(ptyId, "clear");
}

export type UndoClearResult = "undone" | "nothing_to_undo" | "tab_not_ready" | "remote_tab";

type UndoClearPlan = { kind: "type"; command: string } | { kind: "relaunch" };

/** How long Claude's undo waits before asking again when its hook has not
 * recorded the clear yet (a tap right after the command). */
const PLAN_RETRY_MS = 1_000;

function askPlan(scope: string, tab: TabEntry): Promise<UndoClearPlan | null> {
  return invoke<UndoClearPlan | null>("agent_tab_undo_clear", {
    agent: tab.cmd,
    projectId: scope === "root" ? null : scope,
    sessionId: tab.sessionId,
  }).catch(() => null);
}

/** Whether the tab's agent runs on this machine (a local project, or a remote
 * project's local tab) — the only kind this window relaunches. */
function runsLocally(scope: string, tab: TabEntry): boolean {
  const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
  return !project?.remote || effectiveTabLocation(tab, { vmProject: !!project.vm?.enabled }) === "local";
}

/** Respawn the tab on the args a restore would give it. */
async function relaunch(scope: string, tab: TabEntry): Promise<UndoClearResult> {
  if (!runsLocally(scope, tab)) return "remote_tab";
  const args = tab.cmd in RESUMABLE_AGENTS && tab.sessionId
    ? RESUMABLE_AGENTS[tab.cmd](tab.sessionId)
    : (tab.resumeArgs ?? []);
  // The tab's own minted session, if tmux wraps it at all (a Mobile-access
  // project or box); ending one that is not there is a no-op. Never a session
  // the tab only attached to.
  const session = IS_WINDOWS || tab.tmuxAttach ? null : tab.tmuxSession;
  if (session) {
    try {
      await invoke("local_tmux_kill", { session });
    } catch {
      return "tab_not_ready";
    }
  }
  useTabsStore.getState().relaunchTabInScope(scope, tab.key, args);
  return "undone";
}

/**
 * Take back the tab's last `/clear` (see the file header). The session id never
 * leaves the desktop — the phone's Undo lands here too.
 */
export async function undoAgentClear(scope: string, tab: TabEntry): Promise<UndoClearResult> {
  const ptyId = `${scope}:${tab.key}`;
  if (!canUndoClear(tab)) {
    useAgentClearUndoStore.getState().dismiss(ptyId);
    return "nothing_to_undo";
  }
  let plan = await askPlan(scope, tab);
  if (!plan && tab.cmd === "claude") {
    await new Promise((resolve) => setTimeout(resolve, PLAN_RETRY_MS));
    plan = await askPlan(scope, tab);
  }
  let result: UndoClearResult;
  if (plan?.kind === "type") {
    if (!tab.scheduleTargetId) return "tab_not_ready";
    try {
      await submitScheduledAgentCommand(tab.scheduleTargetId, plan.command);
      result = "undone";
    } catch {
      return "tab_not_ready";
    }
  } else if (tab.cmd === "claude") {
    // Claude's own conversation is found by id or not at all: a relaunch
    // would resume whatever its record names now, which is the new chat.
    result = "nothing_to_undo";
  } else {
    result = await relaunch(scope, tab);
  }
  if (result === "undone" || result === "nothing_to_undo") useAgentClearUndoStore.getState().dismiss(ptyId);
  if (result === "undone") useAgentClearUndoStore.getState().forgetMark(ptyId);
  return result;
}
