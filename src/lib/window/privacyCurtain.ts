/**
 * The **privacy curtain** (`docs/privacy_curtain_plan.md`): while a PDF or deck
 * is presented, every other app window is covered, so picking the wrong window
 * or the wrong screen in a call's share picker shares a blank panel.
 *
 * One store per window heap. The backend says when presenting starts and ends
 * (`presenting-changed`, `commands/presenter.rs`); a window that mounts mid-talk
 * asks `presenting_state`. The curtain goes up when presenting STARTS and stays
 * up when it ends: Esc on the PDF often comes while the call is still sharing,
 * so only the user's own Show click (or the shortcut) lifts it, per window.
 * After a PDF it also offers Back to fullscreen (`lib/viewers/pdfPresent`).
 *
 * Raising and lifting also set the window's OS capture protection
 * (`privacy_curtain_set`: black in any capture on Windows/macOS, nothing on
 * Linux). The component is `components/layout/PrivacyCurtain`.
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/** Backend → every window: presenting started, ended or changed kind. */
export const PRESENTING_CHANGED = "presenting-changed";
/** Any window → every window: the manual shortcut raised the curtain. */
export const PRIVACY_CURTAIN_RAISE = "privacy-curtain-raise";

export type PresentingKind = "pdf" | "deck";

/** What `presenting_state` answers and `presenting-changed` carries. */
export interface PresentingState {
  presenting: boolean;
  kind: PresentingKind | null;
  /** The setting `privacy_curtain_on_present` (unset is on). */
  curtain: boolean;
}

interface PrivacyCurtainStore {
  /** A presentation window is open. */
  presenting: boolean;
  /** The automatic curtain is switched on (the setting). */
  auto: boolean;
  /** This window's curtain is up. */
  up: boolean;
  /** What the talk behind this curtain showed, kept after it ends. */
  presented: PresentingKind | null;
  raise: () => void;
  lift: () => void;
  /** Fold in a backend state: raises the curtain when presenting starts. */
  applyPresenting: (next: PresentingState) => void;
}

function setProtected(up: boolean) {
  void invoke("privacy_curtain_set", { up }).catch(() => {});
}

export const usePrivacyCurtainStore = create<PrivacyCurtainStore>((set, get) => ({
  presenting: false,
  auto: true,
  up: false,
  presented: null,
  raise: () => {
    if (get().up) return;
    set({ up: true });
    setProtected(true);
  },
  lift: () => {
    if (!get().up) return;
    set({ up: false, presented: null });
    setProtected(false);
  },
  applyPresenting: (next) => {
    const started = next.presenting && !get().presenting;
    set({
      presenting: next.presenting,
      auto: next.curtain,
      presented: (next.curtain && next.kind) || get().presented,
    });
    if (started && next.curtain) get().raise();
  },
}));

/** Whether desktop notifications should wait: a talk is on and the curtain
 *  feature is too (`stores/calendar/alarms` holds its OS notices on this). */
export function notificationsHeld(): boolean {
  const { presenting, auto } = usePrivacyCurtainStore.getState();
  return presenting && auto;
}

/**
 * How the curtain covers this window. `cover`: an opaque panel over everything.
 * `keep`: a deck presenter (`[data-curtain-keep]`) is on screen in this window
 * and stays visible, because it is the speaker's view; everything else is
 * hidden behind or under it.
 */
export type CurtainMode = "cover" | "keep";

/** The key fields the filter reads (a `KeyboardEvent` satisfies it). */
export interface CurtainKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * What the curtain does with a keydown while it is up. App shortcuts must not
 * act on a window nobody can see (Ctrl+Tab would switch its tab, Shift+Space
 * would start steering), so everything with a modifier is dropped.
 *
 *  - `cover`: only plain keys aimed at the curtain itself pass (Tab, Enter,
 *    Space on its Show button).
 *  - `keep`: plain keys pass — the deck presenter drives the talk with them —
 *    except the F-keys (help, panels) and Shift+Space.
 *
 * The curtain shortcut itself is matched before this is asked.
 */
export function curtainKeyVerdict(
  e: CurtainKeyEvent,
  mode: CurtainMode,
  onCurtain: boolean,
): "pass" | "drop" {
  if (e.ctrlKey || e.altKey || e.metaKey) return "drop";
  if (mode === "cover") return onCurtain ? "pass" : "drop";
  if (/^F\d{1,2}$/.test(e.key)) return "drop";
  if (e.shiftKey && e.key === " ") return "drop";
  return "pass";
}
