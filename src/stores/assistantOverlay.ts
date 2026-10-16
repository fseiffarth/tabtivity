import { create } from "zustand";

/**
 * Open/closed state and the chat shown in the **Tabby overlay**
 * (`components/assistant/AssistantOverlay`), opened by a click on the header's
 * assistant button or by `jumpToTab` aimed at one of its chats.
 *
 * A store rather than a prop for the reason the other header overlays use one:
 * the button lives in the header and the overlay is mounted at the shell. It
 * holds only ids: the chats themselves are the assistant scope's tabs
 * (`stores/assistantScope`), and the CLI/model options are read by the overlay
 * while it is up.
 */
interface AssistantOverlayState {
  open: boolean;
  /** The shown chat's tab key; `null` until one is picked (the overlay then
   *  falls back to the newest chat, or to the new-chat form when there is none). */
  selectedKey: string | null;
  /** The new-chat form is up in place of a chat. */
  composing: boolean;
  /** `chatKey` shows that chat; no argument keeps what was shown. */
  openOverlay: (chatKey?: string) => void;
  close: () => void;
  select: (chatKey: string) => void;
  compose: () => void;
  /** A chat was deleted: stop pointing at it. */
  forget: (chatKey: string) => void;
}

export const useAssistantOverlayStore = create<AssistantOverlayState>((set) => ({
  open: false,
  selectedKey: null,
  composing: false,
  openOverlay: (chatKey) =>
    set((s) => ({
      open: true,
      selectedKey: chatKey ?? s.selectedKey,
      composing: chatKey ? false : s.composing,
    })),
  close: () => set({ open: false }),
  select: (chatKey) => set({ selectedKey: chatKey, composing: false }),
  compose: () => set({ composing: true }),
  forget: (chatKey) => set((s) => (s.selectedKey === chatKey ? { selectedKey: null } : s)),
}));
