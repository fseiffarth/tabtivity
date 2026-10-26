import { create } from "zustand";
import { useSettingsStore } from "./settings";
import { HINTS, type HintId } from "../lib/shortcuts/hints";

/**
 * Live state for the contextual hint engine. The catalog (`HINTS`) and selection
 * logic live in `src/lib/shortcuts/hints.ts` (pure); this store only holds the *currently
 * shown* hint plus thin actions that persist the seen-set and master toggle
 * through `useSettingsStore` — the single writer of `settings.json`. Mirrors the
 * session-only pattern of `vpnPrompt.ts`/`drag.ts`, except dismissals persist.
 *
 * Mounted only by `AppShell` (not the detached-window `DetachedApp` branch), so
 * hints never appear in popped-out subwindows.
 */
interface HintsStore {
  /** The hint currently on screen, or null when nothing is shown. */
  active: HintId | null;
  /** Feature-tier hints surfaced since the app started, and when the last hint
   *  of any kind closed (ms epoch, 0 = none yet). Session-only on purpose: the
   *  cap and gap in `HintHost` pace one sitting, not the user's whole history. */
  featureShown: number;
  lastClosedAt: number;
  show: (id: HintId) => void;
  /** Dismiss the active hint (× / Esc): mark it seen and clear it. */
  dismiss: (id: HintId) => void;
  /** Mark a hint seen because the user performed its action elsewhere. Clears it
   *  if it happened to be on screen. Safe to call for an already-seen hint. */
  markSeen: (id: HintId) => void;
  /** Turn the whole hint system off (the "Don't show hints" affordance). */
  disableAll: () => void;
  /** Settings → clear the seen-set and re-enable, so hints replay. */
  reset: () => void;
}

function persistSeen(id: HintId) {
  const settings = useSettingsStore.getState().settings;
  const prev = Array.isArray(settings?.hints_seen) ? (settings!.hints_seen as string[]) : [];
  if (prev.includes(id)) return;
  void useSettingsStore.getState().updateSettings({ hints_seen: [...prev, id] });
}

export const useHintsStore = create<HintsStore>((set, get) => ({
  active: null,
  featureShown: 0,
  lastClosedAt: 0,

  show: (id) =>
    set((s) => ({
      active: id,
      featureShown: HINTS.find((h) => h.id === id)?.tier === "feature" ? s.featureShown + 1 : s.featureShown,
    })),

  dismiss: (id) => {
    persistSeen(id);
    if (get().active === id) set({ active: null, lastClosedAt: Date.now() });
  },

  markSeen: (id) => {
    persistSeen(id);
    if (get().active === id) set({ active: null, lastClosedAt: Date.now() });
  },

  disableAll: () => {
    void useSettingsStore.getState().updateSettings({ hints_enabled: false });
    set({ active: null });
  },

  reset: () => {
    void useSettingsStore.getState().updateSettings({ hints_seen: [], hints_enabled: true });
    set({ active: null });
  },
}));
