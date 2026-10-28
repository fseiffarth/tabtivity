import { create } from "zustand";
import { useSettingsStore } from "./settings";
import { HINTS, type HintId } from "../lib/shortcuts/hints";
import { rollHint } from "../lib/hintChance";

/**
 * Live state for the contextual hint engine. The catalog (`HINTS`) and selection
 * logic live in `src/lib/shortcuts/hints.ts` (pure); this store only holds the *currently
 * shown* hint plus thin actions that persist the seen-set, the read counts and
 * the master toggle through `useSettingsStore` — the single writer of
 * `settings.json`. Mirrors the session-only pattern of `vpnPrompt.ts`/`drag.ts`,
 * except retirements and reads persist.
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
  /** Close the active hint for this sitting (× / Esc); its chance stays. */
  dismiss: (id: HintId) => void;
  /** The Read button: count one more read, which halves the hint's chance of
   *  showing again (`lib/hintChance.ts`), and close it for this sitting. */
  read: (id: HintId) => void;
  /** Mark a hint seen because the user performed its action elsewhere. Clears it
   *  if it happened to be on screen. Safe to call for an already-seen hint. */
  markSeen: (id: HintId) => void;
  /** Turn the whole hint system off (the "Turn off hints" button); Settings
   *  turns it on again. */
  disableAll: () => void;
  /** Settings → clear the seen-set and the read counts and re-enable, so every
   *  hint replays at full chance. */
  reset: () => void;
}

/** Each hint's draw for this sitting (`rollHint`), so a hint that lost it stays
 *  away until the next start instead of being redrawn on every look. A hint
 *  closed or read this sitting is stored as lost. */
const sittingDraws = new Map<string, boolean>();

/** Whether `id` may show this sitting: drawn once against its read count. */
export function hintDrawn(id: HintId): boolean {
  let drawn = sittingDraws.get(id);
  if (drawn === undefined) {
    const read = useSettingsStore.getState().settings?.hints_read;
    const count = read && typeof read === "object" ? read[id] : undefined;
    drawn = rollHint(typeof count === "number" ? count : 0);
    sittingDraws.set(id, drawn);
  }
  return drawn;
}

function persistSeen(id: HintId) {
  const settings = useSettingsStore.getState().settings;
  const prev = Array.isArray(settings?.hints_seen) ? (settings!.hints_seen as string[]) : [];
  if (prev.includes(id)) return;
  void useSettingsStore.getState().updateSettings({ hints_seen: [...prev, id] });
}

function persistRead(id: HintId) {
  const prev = useSettingsStore.getState().settings?.hints_read;
  const counts = prev && typeof prev === "object" ? prev : {};
  const count = typeof counts[id] === "number" ? counts[id] : 0;
  void useSettingsStore.getState().updateSettings({ hints_read: { ...counts, [id]: count + 1 } });
}

export const useHintsStore = create<HintsStore>((set, get) => {
  const close = (id: HintId) => {
    sittingDraws.set(id, false);
    if (get().active === id) set({ active: null, lastClosedAt: Date.now() });
  };

  return {
    active: null,
    featureShown: 0,
    lastClosedAt: 0,

    show: (id) =>
      set((s) => ({
        active: id,
        featureShown: HINTS.find((h) => h.id === id)?.tier === "feature" ? s.featureShown + 1 : s.featureShown,
      })),

    dismiss: close,

    read: (id) => {
      persistRead(id);
      close(id);
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
      sittingDraws.clear();
      void useSettingsStore.getState().updateSettings({ hints_seen: [], hints_read: {}, hints_enabled: true });
      set({ active: null });
    },
  };
});
