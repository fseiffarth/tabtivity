import { create } from "zustand";

import type { FilesPanelView } from "../types";

/**
 * The chat shown in **Tabby's side-panel view**
 * (`components/assistant/AssistantView`), opened by the panel's edge-rail icon
 * or its switcher, or by `showAssistant` (a `jumpToTab` aimed at one of its
 * chats).
 *
 * A store rather than view state because the side panel remounts on every
 * project switch (it is keyed by project id) and the chat shown must survive
 * that. It holds only ids: the chats themselves are the assistant scope's tabs
 * (`stores/assistantScope`), and the CLI/model options are read by the view
 * while it is up.
 */
interface AssistantViewState {
  /** The shown chat's tab key; `null` until one is picked (the view then falls
   *  back to the newest chat, or to the new-chat form when there is none). */
  selectedKey: string | null;
  /** The new-chat form is up in place of a chat. */
  composing: boolean;
  select: (chatKey: string) => void;
  compose: () => void;
  /** A chat was deleted: stop pointing at it. */
  forget: (chatKey: string) => void;
}

export const useAssistantViewStore = create<AssistantViewState>((set) => ({
  selectedKey: null,
  composing: false,
  select: (chatKey) => set({ selectedKey: chatKey, composing: false }),
  compose: () => set({ composing: true }),
  forget: (chatKey) => set((s) => (s.selectedKey === chatKey ? { selectedKey: null } : s)),
}));

const ASSISTANT_VIEW: FilesPanelView = "assistant";

/** Open the side panel on the Tabby view — on `chatKey` when given, else on
 *  what it showed last. The shell owns the panel, so this asks it through the
 *  same `app:reveal-side-panel` event the tours use, naming the view. */
export function showAssistant(chatKey?: string) {
  if (chatKey) useAssistantViewStore.getState().select(chatKey);
  window.dispatchEvent(new CustomEvent("app:reveal-side-panel", { detail: { view: ASSISTANT_VIEW } }));
}
