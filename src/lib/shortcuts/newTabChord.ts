/**
 * The new-tab chords: Ctrl+Shift+N (shell), Ctrl+Shift+M (System Monitor) and
 * Ctrl+1–9 (the + menu's agents by number, 1 = the default agent).
 *
 * `useKeyboard` resolves the keystroke; the focused pane's `TabBar` opens the
 * tab through its own + menu handlers, so a chord and a click build the same
 * tab (worktree question, session ids and all). The two meet over a window
 * event rather than a store because the launch needs that bar's live state.
 *
 * While a mail / calendar / to-do overlay is in front, Ctrl+1–9 go to it
 * instead (`requestOverlayAgent`): it docks the agent beside the app, where a
 * workspace tab would open hidden under the overlay.
 */
import { allGroups, useTabsStore } from "../../stores/tabs";
import type { SteeringApp } from "./steeringRegion";
import {
  AGENT_TAB_ACTIONS,
  chordMatches,
  resolveChord,
  type ShortcutMap,
} from "./shortcuts";

/** What a chord asks for. `slot` is 0-based: 0 = Ctrl+1. `menu` (steering
 *  mode's + key, no chord) opens — or, when open, closes — the pane's + menu. */
export type NewTabRequest =
  | { kind: "shell" }
  | { kind: "monitor" }
  | { kind: "agent"; slot: number }
  | { kind: "menu" };

/** Detail: {@link NewTabSlotsDetail}. The target pane's bar fills `labels`
 *  in, synchronously, with the agents its Ctrl+1–9 would open. */
export const NEW_TAB_SLOTS_EVENT = "app:new-tab-slots";

export interface NewTabSlotsDetail {
  groupId: string;
  /** Slot 0 = Ctrl+1; null for a number with no agent behind it. */
  labels: (string | null)[] | null;
}

/** Detail: {@link NewTabShortcutDetail}. Cancelled (`preventDefault`) by the
 *  bar that opened the tab. */
export const NEW_TAB_SHORTCUT_EVENT = "app:new-tab-shortcut";

export interface NewTabShortcutDetail {
  request: NewTabRequest;
  /** The pane that takes the tab. */
  groupId: string;
  /** Land the tab right of the pane's active tab, not at its end (steering). */
  besideActive?: boolean;
}

/** The new-tab request `e` is, if any. */
export function newTabRequestFor(
  e: KeyboardEvent,
  overrides: ShortcutMap | undefined,
): NewTabRequest | null {
  if (chordMatches(resolveChord("newShellTab", overrides), e)) return { kind: "shell" };
  if (chordMatches(resolveChord("newMonitorTab", overrides), e)) return { kind: "monitor" };
  const slot = AGENT_TAB_ACTIONS.findIndex((action) =>
    chordMatches(resolveChord(action, overrides), e),
  );
  return slot >= 0 ? { kind: "agent", slot } : null;
}

/**
 * Ask the main window's focused pane (the first pane when none is focused) to
 * open `request`. True when a bar opened it — false for an agent number with
 * no agent behind it, so the key can go on to wherever it was typed.
 * `besideActive`: see {@link NewTabShortcutDetail}; for `menu`, it holds for
 * whatever that menu opens.
 */
export function requestNewTab(
  request: NewTabRequest,
  opts?: { besideActive?: boolean },
): boolean {
  const groupId = targetGroupId();
  if (!groupId) return false;
  const event = new CustomEvent<NewTabShortcutDetail>(NEW_TAB_SHORTCUT_EVENT, {
    detail: { request, groupId, besideActive: opts?.besideActive },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}

/** Detail: {@link OverlayAgentDetail}. Cancelled (`preventDefault`) by the
 *  addressed overlay when it docked (or re-showed) that slot's agent. */
export const OVERLAY_AGENT_EVENT = "app:overlay-agent";

export interface OverlayAgentDetail {
  /** The overlay the agent docks in (`frontAppOverlay`). */
  app: SteeringApp;
  /** 0-based, as {@link NewTabRequest}'s: 0 = Ctrl+1. */
  slot: number;
}

/**
 * Ask the mail / calendar / to-do overlay `app` to dock agent `slot` beside
 * itself — Ctrl+1–9 while that overlay is in front, where a workspace tab
 * would open hidden under it. True when the overlay answered; false leaves the
 * key to go on, like an agent number with no agent behind it.
 */
export function requestOverlayAgent(app: SteeringApp, slot: number): boolean {
  const event = new CustomEvent<OverlayAgentDetail>(OVERLAY_AGENT_EVENT, {
    detail: { app, slot },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}

/** The pane a request goes to: the focused one, else the first. */
function targetGroupId(): string | undefined {
  const tabs = useTabsStore.getState();
  return tabs.focusedGroupId ?? allGroups(tabs.layout)[0]?.id;
}

/** The agents the target pane's Ctrl+1–9 (and steering's 1–9) would open, by
 *  label — asked of that pane's bar, which owns the installed-agent probes. */
export function newTabSlotLabels(): (string | null)[] {
  const groupId = targetGroupId();
  if (!groupId) return [];
  const detail: NewTabSlotsDetail = { groupId, labels: null };
  window.dispatchEvent(new CustomEvent<NewTabSlotsDetail>(NEW_TAB_SLOTS_EVENT, { detail }));
  return detail.labels ?? [];
}
