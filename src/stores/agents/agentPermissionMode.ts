import { create } from "zustand";

/**
 * The permission mode Claude's own hook last recorded for each agent tab
 * (`agent-permission-mode`, off `<uid>.mode`, written on every `Stop`), keyed
 * by composed PTY id. Read only: Tabtivity never picks or switches a mode.
 *
 * What it is for: a local-model Claude tab in `auto` mode has every tool call
 * checked by a classifier that runs on the local model, which gives no usable
 * verdict — so each command is refused and the agent reads as broken. The
 * terminal's card says so (`TerminalLocalAutoModeCard`). `dismissed` holds a
 * tab the user closed that card on; leaving `auto` forgets it, so a later
 * switch back warns again.
 */
interface AgentPermissionModeStore {
  modes: Record<string, string>;
  dismissed: Record<string, true>;
  note: (ptyId: string, mode: string) => void;
  dismiss: (ptyId: string) => void;
}

export const useAgentPermissionModeStore = create<AgentPermissionModeStore>((set, get) => ({
  modes: {},
  dismissed: {},
  note: (ptyId, mode) => {
    const state = get();
    if (state.modes[ptyId] === mode) return;
    const dismissed = { ...state.dismissed };
    if (mode !== "auto") delete dismissed[ptyId];
    set({ modes: { ...state.modes, [ptyId]: mode }, dismissed });
  },
  dismiss: (ptyId) => set((state) => ({ dismissed: { ...state.dismissed, [ptyId]: true } })),
}));
