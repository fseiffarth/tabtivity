import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { submitScheduledAgentCommand } from "./scheduledAgentInput";
import { relaunch, runsLocally, useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import type { TabEntry } from "../../stores/tabs";

/**
 * The Reader's Resume menu (the prompt strip, beside Diffs): the earlier
 * conversations the tab's CLI keeps for the folder it runs in
 * (`agent_tab_chats`, `services::agent_chats`), newest first. Picking one
 * shows it in the Reader instead of the tab's own conversation, read-only
 * (`useReaderChatsStore`); Resume takes the tab onto it the way Undo clear
 * takes it back onto a cleared one (`agent_tab_resume_chat`): Claude gets
 * `/resume <id>` typed into the running session; Codex, OpenCode, Copilot and
 * Antigravity have their record pointed at the chat and are relaunched onto it
 * (`--session <id>`, `--session-id <id>`, `--conversation <id>`). Local tabs only. The ids never
 * leave the desktop.
 */

/** One earlier conversation of the folder (`agent_chats::StoredChat`). */
export interface StoredChat {
  id: string;
  /** Its first prompt, one line. */
  title: string;
  /** Its last prompt, when that is not the first. */
  last?: string;
  /** When its first prompt went (ISO). */
  started?: string;
  /** When it was last written (epoch ms). */
  updated: number;
  /** The conversation the tab is in now. */
  current: boolean;
}

export interface ChatList {
  supported: boolean;
  chats: StoredChat[];
  /** Where the next page starts, while older chats are left. */
  next?: number;
}

const CHAT_AGENTS = new Set(["claude", "codex", "opencode", "agy", "copilot"]);

/** The agents whose Resume menu is new and not yet checked live. */
export const UNTESTED_CHAT_AGENTS = new Set(["opencode", "agy", "copilot"]);

/** Whether `tab` offers the Resume menu: a Claude, Codex, OpenCode, Copilot
 * or Antigravity tab with its launch id, running on this machine. */
export function chatsOffered(scope: string, tab: TabEntry | undefined): tab is TabEntry {
  return !!tab && tab.kind === "agent" && CHAT_AGENTS.has(tab.cmd) && !!tab.sessionId && runsLocally(scope, tab);
}

/** The arguments every chats command takes for `tab` in `scope`. `cwd` is the
 * pane's resolved folder, which outranks the stored one (a remote project's
 * local tab runs in its mirror). */
function chatArgs(scope: string, tab: TabEntry, cwd: string | undefined) {
  return {
    agent: tab.cmd,
    projectId: scope === "root" ? null : scope,
    tabDir: cwd || tab.cwd || null,
    sessionId: tab.sessionId ?? "",
  };
}

/** A page of the folder's chats, from the `offset`-th stored session on. */
export function listChats(scope: string, tab: TabEntry, cwd: string | undefined, offset = 0): Promise<ChatList> {
  return invoke<ChatList>("agent_tab_chats", { ...chatArgs(scope, tab, cwd), offset })
    .catch((): ChatList => ({ supported: false, chats: [] }));
}

export type ResumeChatResult = "resumed" | "not_found" | "tab_not_ready" | "remote_tab";

type ResumePlan = { kind: "type"; command: string } | { kind: "relaunch" };

/** Take the tab onto its folder's earlier chat `chatId` (see the file header). */
export async function resumeAgentChat(
  scope: string,
  tab: TabEntry,
  cwd: string | undefined,
  chatId: string,
): Promise<ResumeChatResult> {
  if (!chatsOffered(scope, tab)) return "remote_tab";
  const plan = await invoke<ResumePlan | null>("agent_tab_resume_chat", { ...chatArgs(scope, tab, cwd), chat: chatId })
    .catch(() => null);
  if (!plan) return "not_found";
  // A conversation hidden behind a clear is not the one coming back.
  const ptyId = `${scope}:${tab.key}`;
  if (plan.kind === "type") {
    if (!tab.scheduleTargetId) return "tab_not_ready";
    try {
      await submitScheduledAgentCommand(tab.scheduleTargetId, plan.command);
    } catch {
      return "tab_not_ready";
    }
  } else {
    const result = await relaunch(scope, tab);
    if (result !== "undone") return result === "remote_tab" ? "remote_tab" : "tab_not_ready";
  }
  useAgentClearUndoStore.getState().dismiss(ptyId);
  useAgentClearUndoStore.getState().forgetMark(ptyId);
  useReaderChatsStore.getState().back(ptyId);
  return "resumed";
}

/** The chat a pane's Reader shows instead of the tab's own conversation, and
 * the menu's list it was picked from (the Reader's bar steps through it). */
export interface BrowsedChat {
  chat: StoredChat;
  list: StoredChat[];
}

interface ReaderChatsStore {
  /** Composed PTY id → the earlier chat its Reader shows. */
  byPty: Record<string, BrowsedChat>;
  browse: (ptyId: string, chat: StoredChat, list: StoredChat[]) => void;
  /** Back to the tab's own conversation. */
  back: (ptyId: string) => void;
}

export const useReaderChatsStore = create<ReaderChatsStore>((set, get) => ({
  byPty: {},
  browse: (ptyId, chat, list) => {
    if (chat.current) {
      get().back(ptyId);
      return;
    }
    set((state) => ({ byPty: { ...state.byPty, [ptyId]: { chat, list } } }));
  },
  back: (ptyId) => {
    if (!get().byPty[ptyId]) return;
    set((state) => {
      const byPty = { ...state.byPty };
      delete byPty[ptyId];
      return { byPty };
    });
  },
}));

/** The browsed chat `delta` places along its list, skipping the tab's own
 * (that one is the way back); `undefined` past either end. */
export function stepChat(browsed: BrowsedChat, delta: number): StoredChat | undefined {
  const others = browsed.list.filter((chat) => !chat.current);
  const at = others.findIndex((chat) => chat.id === browsed.chat.id);
  return at < 0 ? undefined : others[at + delta];
}

/** Where the browsed chat stands among the list's other chats. */
export function chatPosition(browsed: BrowsedChat): { index: number; count: number } {
  const others = browsed.list.filter((chat) => !chat.current);
  return { index: others.findIndex((chat) => chat.id === browsed.chat.id), count: others.length };
}
