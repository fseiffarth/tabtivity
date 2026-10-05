import { create } from "zustand";
import {
  rememberChanges,
  rememberChangesWidth,
  rememberReader,
  rememberedChanges,
  rememberedChangesWidth,
  rememberedReader,
  rememberedReaders,
} from "../../lib/agents/agentReader";

/**
 * Whether agent panes show the Reader over their terminal (`TerminalReaderView`).
 * One choice per agent CLI, remembered across restarts (`rememberedReader`):
 * picking the Reader in a Claude tab switches every Claude pane, and Codex or
 * OpenCode panes keep their own choice. A pane that does not offer the Reader
 * keeps its terminal.
 *
 * The Reader's Changes panel (`TerminalReaderChanges`, the diffs beside the
 * chat) is remembered the same way, per CLI; its width once for all.
 */
interface AgentReaderState {
  byAgent: Record<string, boolean>;
  set: (agent: string, on: boolean) => void;
  changesByAgent: Record<string, boolean>;
  setChanges: (agent: string, on: boolean) => void;
  changesWidth: number;
  setChangesWidth: (width: number, remember?: boolean) => void;
}

export const useAgentReaderStore = create<AgentReaderState>((set) => ({
  byAgent: rememberedReaders(),
  set: (agent, on) => {
    rememberReader(agent, on);
    set((state) => ({ byAgent: { ...state.byAgent, [agent]: on } }));
  },
  changesByAgent: rememberedChanges(),
  setChanges: (agent, on) => {
    rememberChanges(agent, on);
    set((state) => ({ changesByAgent: { ...state.changesByAgent, [agent]: on } }));
  },
  changesWidth: rememberedChangesWidth(),
  setChangesWidth: (width, remember = false) => {
    if (remember) rememberChangesWidth(width);
    set({ changesWidth: width });
  },
}));

/** Whether a pane running `agent` shows the Reader: that CLI's choice, where offered. */
export function useReaderOpen(agent: string, offered: boolean): boolean {
  const open = useAgentReaderStore((state) => state.byAgent[agent] ?? rememberedReader(agent));
  return offered && open;
}

/** Whether a Reader of `agent` shows its Changes panel. */
export function useReaderChangesOpen(agent: string): boolean {
  return useAgentReaderStore((state) => state.changesByAgent[agent] ?? false);
}
