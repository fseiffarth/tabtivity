/**
 * Keyboard steering's shared state on the phone: whether the mode is on, the
 * legend's folded flag and flash line, the place a status jump left, the last
 * cross-project activity list, the pending close confirm, Home's find request
 * and the `inside` registry the Terminal fills. A module store read through
 * `useSyncExternalStore` (the phone has no zustand); every setter notifies.
 *
 * While the mode is on it sets `html[data-steering]` (the cursor outline) and,
 * unless the legend is folded, `html[data-steer-bar]` (room for the bar).
 */
import { useSyncExternalStore } from "react";
import type { ActivityTab, TabRow } from "../api";
import type { MobileSection } from "../lastPlace";
import type { TranslationKey } from "../../../src/lib/i18n";
import type { PhoneLevel } from "./phoneSteeringKeys";

/** Where the reader stood: in a terminal, or on a list (a section, or a project's tabs). */
export type Place =
  | { kind: "terminal"; project: string; tab: TabRow }
  | { kind: "list"; section: MobileSection; projectId: string | null };

/** A legend line that clears itself: an i18n key with its `{vars}`. */
export interface SteeringFlash {
  key: TranslationKey;
  vars?: Record<string, string | number>;
  /** Bumped per flash, so the same message twice restarts its timer. */
  seq: number;
}

/** The tab a W press asks to close; the sheet looks the card up by `tabId` when answered. */
export interface SteeringConfirm {
  tabId: string;
  label: string;
}

export type AnswerResult = "answered" | "freeText" | "none" | "missing";

/** What the open Terminal offers steering. Registered while it is mounted (step 3), cleared on unmount. */
export interface InsideTarget {
  /** Answer the live question with option `n` (1-9). */
  answer(n: number): AnswerResult;
  /** Put the caret in the composer, unless a live question or hint disabled it. */
  /** "blocked": a question is up; "offline": the box waits for the connection. */
  focusComposer(): "focused" | "blocked" | "offline";
  hasQuestion(): boolean;
  /** Send now of the chat's queued prompts; false when none is offered. */
  sendQueued(): boolean;
  /** Cancel and edit of the queued prompts (they go back into the composer); false when none is offered. */
  pullQueued(): boolean;
  hasQueue(): boolean;
}

/**
 * What the engine last saw: the level keys resolve on, whether an own-keys
 * surface has taken the keyboard, whether a text field has the caret (and
 * whether it is the chat composer) and the section's name. The legend reads it.
 */
export interface SteeringView {
  level: PhoneLevel;
  /** A files library or viewer is up: every key passes through. */
  paused: boolean;
  /** Who has the caret: nothing, the composer (Enter sends) or another field. */
  typing: "none" | "composer" | "field";
  /** The section screen's name (`section` level), else null. */
  sectionLabel: TranslationKey | null;
}

export interface SteeringSnapshot {
  active: boolean;
  legendFolded: boolean;
  flash: SteeringFlash | null;
  jumpBack: Place | null;
  /** The last `getActivity()` list and the `Date.now()` it was fetched at; null before the first. */
  activity: { tabs: ActivityTab[]; fetchedAt: number } | null;
  confirm: SteeringConfirm | null;
  /** The engine's last reading while the mode is on; null while it is off. */
  view: SteeringView | null;
  /** Counts find requests; Home answers when it changes (see `takeFindRequest`). */
  findSeq: number;
  /** Whether an `inside` target is registered. */
  hasInside: boolean;
  /** `hasQuestion()` of the registered target as of the last registry change. */
  question: boolean;
  /** Queued prompts are on screen with their Send now / Cancel and edit. */
  queue: boolean;
}

const FLASH_MS = 3000;

const initial = (): SteeringSnapshot => ({
  active: false,
  legendFolded: false,
  flash: null,
  jumpBack: null,
  activity: null,
  confirm: null,
  view: null,
  findSeq: 0,
  hasInside: false,
  question: false,
  queue: false,
});

let state: SteeringSnapshot = initial();
let inside: InsideTarget | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let flashSeq = 0;
let findHandled = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function syncRoot(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.toggleAttribute("data-steering", state.active);
  // A view with its own keys (files library, viewers, Mark up) hides the bar: its own
  // bottom bars must stay reachable.
  root.toggleAttribute("data-steer-bar", state.active && !state.view?.paused);
  root.toggleAttribute("data-steer-folded", state.active && state.legendFolded);
}

function set(patch: Partial<SteeringSnapshot>): void {
  state = { ...state, ...patch };
  syncRoot();
  emit();
}

function clearFlashTimer(): void {
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = null;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSteering(): SteeringSnapshot {
  return state;
}

export function useSteering(): SteeringSnapshot {
  return useSyncExternalStore(subscribe, getSteering, getSteering);
}

/**
 * Turns the mode on or off. Leaving drops the flash; the folded flag stays, and
 * so does a close confirm already on screen: it is an ordinary sheet by then,
 * and the tap that leaves the mode may be the one on its own button.
 */
export function setActive(active: boolean): void {
  if (state.active === active) return;
  if (!active) clearFlashTimer();
  set(active ? { active } : { active, flash: null, view: null });
}

export function setLegendFolded(legendFolded: boolean): void {
  if (state.legendFolded !== legendFolded) set({ legendFolded });
}

export function toggleLegendFolded(): void {
  setLegendFolded(!state.legendFolded);
}

/** Shows `key` in the legend for about 3 s, replacing a line already up. */
export function flash(key: TranslationKey, vars?: Record<string, string | number>): void {
  clearFlashTimer();
  flashTimer = setTimeout(() => {
    flashTimer = null;
    set({ flash: null });
  }, FLASH_MS);
  set({ flash: { key, vars, seq: ++flashSeq } });
}

export function clearFlash(): void {
  clearFlashTimer();
  if (state.flash) set({ flash: null });
}

/** Remembers the place a status jump left (one place deep); null forgets it. */
export function setJumpBack(jumpBack: Place | null): void {
  set({ jumpBack });
}

export function setActivity(tabs: ActivityTab[], fetchedAt: number = Date.now()): void {
  set({ activity: { tabs, fetchedAt } });
}

/** Publishes the engine's reading; a reading equal to the last one changes nothing. */
export function setView(view: SteeringView | null): void {
  const old = state.view;
  if (old === view) return;
  if (old && view && old.level === view.level && old.paused === view.paused && old.typing === view.typing && old.sectionLabel === view.sectionLabel) return;
  set({ view });
}

export function setConfirm(confirm: SteeringConfirm | null): void {
  if (state.confirm !== confirm) set({ confirm });
}

/** Asks Home to open its search (the `/` key). Home may be unmounted now; it reads the request when it mounts. */
export function requestFind(): void {
  set({ findSeq: state.findSeq + 1 });
}

/** Whether a find request is waiting, consumed once. Home calls it in an effect on mount and when `findSeq` changes. */
export function takeFindRequest(): boolean {
  if (state.findSeq === findHandled) return false;
  findHandled = state.findSeq;
  return true;
}

/** The registered `inside` target, or null. */
export function getInside(): InsideTarget | null {
  return inside;
}

/** The Terminal registers its target on mount and passes null on unmount; notifies subscribers either way. */
export function registerInside(target: InsideTarget | null): void {
  inside = target;
  set({ hasInside: target !== null, question: target?.hasQuestion() ?? false, queue: target?.hasQueue() ?? false });
}

/** Re-reads `hasQuestion()` after the question appeared or went; the bar shows the answer key from it. */
export function refreshInside(): void {
  const question = inside?.hasQuestion() ?? false;
  const queue = inside?.hasQueue() ?? false;
  if (question !== state.question || queue !== state.queue) set({ question, queue });
}

/** Test hook: back to a fresh, inactive store with no timers, registry or root attributes. */
export function resetSteeringForTests(): void {
  clearFlashTimer();
  inside = null;
  flashSeq = 0;
  findHandled = 0;
  state = initial();
  syncRoot();
  emit();
}
