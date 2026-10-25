import { create } from "zustand";
import { rememberReader, rememberedReader, rememberedReaders } from "../../lib/agents/agentReader";

/**
 * Whether agent panes show the Reader over their terminal (`TerminalReaderView`).
 * One choice per agent CLI, remembered across restarts (`rememberedReader`):
 * picking the Reader in a Claude tab switches every Claude pane, and Codex or
 * OpenCode panes keep their own choice. A pane that does not offer the Reader
 * keeps its terminal.
 *
 * The Diffs tab (`TerminalReaderChanges`) is not in here: it is each pane's
 * own (`TerminalView`), never shared or remembered.
 */
interface AgentReaderState {
  byAgent: Record<string, boolean>;
  set: (agent: string, on: boolean) => void;
}

export const useAgentReaderStore = create<AgentReaderState>((set) => ({
  byAgent: rememberedReaders(),
  set: (agent, on) => {
    rememberReader(agent, on);
    set((state) => ({ byAgent: { ...state.byAgent, [agent]: on } }));
  },
}));

/** Whether a pane running `agent` shows the Reader: that CLI's choice, where offered. */
export function useReaderOpen(agent: string, offered: boolean): boolean {
  const open = useAgentReaderStore((state) => state.byAgent[agent] ?? rememberedReader(agent));
  return offered && open;
}
