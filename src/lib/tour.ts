import { focusModeTip, type HintCtx } from "./shortcuts/hints";
import type { TranslationKey } from "./i18n";

/**
 * The guided walkthroughs: ordered, index-driven sequences of spotlight steps
 * that dim the screen and highlight one real control at a time.
 *
 * There are two, and both are run as lessons (`lib/lessons.ts`): `TOUR_STEPS`
 * — the quick tour, first of the Basics — stays on this machine: root
 * terminal → projects → tabs → files and viewers → models → mail/calendar →
 * apps → time → settings. `ADVANCED_TOUR_STEPS` — first of the Advanced
 * lessons — covers everything that reaches another machine (SSH projects,
 * tunnels, compute hosts, containers/VMs, sessions, phone), which used to be
 * one overloaded "work on remote machines" step in the middle of the tour.
 *
 * This is the deliberate bridge between the static first-run `HowToStart` modal
 * and the passive contextual `HINTS`: it reuses the same anchor-selector model
 * (`HintDef.anchor`/`placement`) and shares copy with the existing onboarding
 * strings wherever both surfaces say the same thing, so the four onboarding
 * surfaces (modal, tour, hints, Feature Guide) never drift. Selection logic
 * here is pure and unit-tested (`TourSelection`); `TourHost` owns the impure
 * DOM measurement, timing, and event wiring.
 *
 * Anchors are selectors against live chrome, so they rot silently when the
 * header moves: a step whose anchor is gone degrades to a centered card rather
 * than failing loudly. Re-check them when you move a button.
 */

/** The tour reuses the hint context (project count + active scope) for its
 *  per-step eligibility predicates, so a zero-project user skips project-only
 *  steps cleanly. */
export type TourCtx = HintCtx;

/** Bubble placement relative to the spotlight target. Widens `HintDef`'s
 *  top/bottom union with sides, which read better for the corner chrome the
 *  tour points at (root logo top-left, gear top-right, file-tree right edge). */
export type TourPlacement = "top" | "bottom" | "left" | "right";

/**
 * The doing half of an interactive step: what the user has to actually perform
 * before the walkthrough moves on, and where to look when they're stuck.
 *
 * A narrated step tells; a task step waits. `TourHost` lets pointer events
 * through to the real app while one is pending (the blocker stops swallowing
 * clicks), watches for the completion signal below, rewards it with a `:)` and
 * then advances on its own. Nothing is mandatory — Next always still works, so
 * a task on a control that isn't on this machine (an indicator the user hasn't
 * switched on) can never wedge a lesson.
 *
 * The signals are deliberately DOM-shaped rather than store-shaped: what a
 * lesson teaches is "this click opens that menu", and the menu's presence is
 * exactly the thing the user is being taught to recognize. Keeping them as
 * selectors also keeps this catalog free of store imports.
 */
export interface StepTask {
  /** The instruction, one imperative line ("Click + to open the add menu"). */
  promptKey: TranslationKey;
  /** The way out when stuck: revealed by the bubble's Hint button, and by
   *  itself once the step has sat unsolved for a while. */
  hintKey?: TranslationKey;
  /** Done when the user clicks this selector (or anything inside it). Defaults
   *  to the step's own anchor when the task names no other signal, which is
   *  what "click the thing I'm pointing at" steps want. */
  click?: string;
  /** Done when an element matching this selector is on screen — the menu or
   *  dialog the click was supposed to open. Preferred over `click` wherever the
   *  action has a visible result: it credits the user for the *outcome*, so
   *  reaching it another way (keyboard, a menu they already had open) counts. */
  appear?: string;
  /** Done when this selector matches *more* elements than it did when the step
   *  opened — a pill, tab, or card that wasn't there before. */
  grow?: string;
  /** Done when this window event fires. */
  event?: string;
}

export interface TourStep {
  /** Stable id; also the key used to mark the matching contextual hint seen so
   *  the tour doesn't end into a hint storm (see `COVERED_HINTS`). */
  id: string;
  /** `document.querySelector` selector for the element to spotlight, or null to
   *  render as a centered card. A step whose anchor is absent at runtime falls
   *  back to the centered-card path rather than blocking the tour. */
  anchor: string | null;
  /** Spotlight the union of *every* element the anchor matches instead of just
   *  the first. For a step whose subject is a row of sibling controls (the
   *  mail/calendar/to-do indicators), highlighting one of three while the copy
   *  names all three is worse than highlighting the group. Off by default,
   *  where a comma in `anchor` means "first of these that exists". */
  spanAll?: boolean;
  placement: TourPlacement;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** Extra `t()` params a step's `bodyKey` needs beyond its own text — only
   *  "settings-focus" uses this, for its per-OS `{tip}` (see `focusModeTip` in
   *  `hints.ts`). Computed lazily so it only runs for the active step. */
  bodyParams?: (
    t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  ) => Record<string, string | number>;
  /** Eligible only while this holds for the current context (defaults to
   *  always). Ineligible steps are skipped by the Back/Next navigation. */
  when?: (ctx: TourCtx) => boolean;
  /** Turns the step interactive: the user has to do the thing before the
   *  lesson moves on (see `StepTask`). Absent on narrated steps. */
  task?: StepTask;
  /** Optional side-effect run by `TourHost` when this step becomes active, e.g.
   *  to reveal a panel so the step's anchor exists to spotlight. Kept off the
   *  pure selectors — only the host calls it. */
  prepare?: () => void;
}

/** Force the hover-revealed file panel open so a step has the whole panel to
 *  spotlight (same event the lessons use). */
const revealFilePanel = () => window.dispatchEvent(new Event("app:reveal-side-panel"));

/**
 * The files steps spotlight the *whole* panel, not the 6px reveal marker: a
 * hairline cutout at the window edge reads as a glitch rather than as "your
 * files live here". The marker stays as the fallback for the moment before the
 * panel has slid in (and for a workspace with no project open, where there is
 * no panel at all).
 *
 * Order matters only in the DOM, not here — `querySelector` returns the first
 * match in *document* order, and `AppShell` renders the panel before the
 * marker, so an open panel always wins.
 */
const FILE_PANEL_ANCHOR = '.side-panel.open, [data-hint-anchor="file-tree-edge"]';

/** Both tours end on the gear, and both end by having the user open its menu:
 *  the Lessons they came from — and every other walkthrough — live there. The
 *  menu opens on hover; the gear's click opens Settings instead, where Lessons
 *  sit under Hints & onboarding, so either outcome counts. */
const GEAR_MENU_TASK: StepTask = {
  promptKey: "tour.settingsTask",
  hintKey: "tour.settingsTaskHint",
  appear: ".global-apps-menu .project-switcher-add-menu, .settings-dialog",
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "root-terminal",
    // The scope chip's own button, not an aria-label: the label is translated,
    // so a text selector only matched in English. (The root terminal had a pill
    // of its own here until it folded into that chip's dropdown.)
    anchor: ".box-chip-main",
    placement: "bottom",
    titleKey: "howToStart.step1Title",
    bodyKey: "tour.rootTerminalBody",
  },
  {
    id: "create-project",
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    titleKey: "howToStart.step2Title",
    bodyKey: "hint.createProjectBody",
  },
  {
    id: "switch-projects",
    anchor: ".project-pills-region",
    placement: "bottom",
    titleKey: "tour.switchProjectsTitle",
    bodyKey: "tour.switchProjectsBody",
    // Nothing to point at until at least one project is open.
    when: (c) => c.projectCount > 0,
  },
  {
    id: "add-tab",
    anchor: '[data-hint-anchor="tab-add"]',
    placement: "bottom",
    titleKey: "tour.addTabTitle",
    bodyKey: "hint.addTabBody",
  },
  {
    id: "arrange-tabs",
    anchor: ".tab-bar",
    placement: "bottom",
    titleKey: "tour.arrangeTabsTitle",
    bodyKey: "tour.arrangeTabsBody",
  },
  {
    id: "file-tree",
    anchor: FILE_PANEL_ANCHOR,
    placement: "left",
    titleKey: "tour.fileTreeTitle",
    bodyKey: "hint.fileTreeBody",
    prepare: revealFilePanel,
  },
  {
    id: "viewers",
    anchor: FILE_PANEL_ANCHOR,
    placement: "left",
    titleKey: "tour.viewersTitle",
    bodyKey: "tour.viewersBody",
    prepare: revealFilePanel,
  },
  {
    id: "local-models",
    anchor: ".local-model-btn",
    placement: "bottom",
    titleKey: "tour.localModelsTitle",
    bodyKey: "tour.localModelsBody",
  },
  {
    id: "mail-calendar",
    // Mail/calendar/to-dos each hide until switched on in Settings, so this
    // step points at whichever of the three is in the header and falls back to
    // a centered card when none is — its copy covers all three either way.
    anchor: ".mail-indicator-btn, .calendar-indicator-btn, .todo-indicator-btn",
    spanAll: true,
    placement: "bottom",
    titleKey: "tour.mailCalendarTitle",
    bodyKey: "tour.mailCalendarBody",
  },
  {
    id: "time-tracking",
    // The timer readout lives inside the clock's hover menu now, so the clock
    // button is what's on screen to point at.
    anchor: ".clock-menu-btn",
    placement: "bottom",
    titleKey: "tour.timeTrackingTitle",
    bodyKey: "tour.timeTrackingBody",
  },
  {
    id: "settings-focus",
    anchor: '[data-hint-anchor="settings"]',
    placement: "bottom",
    titleKey: "tour.settingsFocusTitle",
    bodyKey: "tour.settingsFocusBody",
    bodyParams: (t) => ({ tip: focusModeTip(t) }),
    task: GEAR_MENU_TASK,
  },
];

/**
 * The second, opt-in walkthrough: everything that reaches past this computer —
 * SSH projects, tunnels, extra compute machines, containers/VMs, long-running
 * sessions, and the phone. Split out of the main tour deliberately: a first-run
 * user working locally has no use for any of it, and one dense "work on remote
 * machines" step could never carry the subject either. It is the first
 * Advanced lesson, replayable, and nothing about it is persisted — only the
 * quick tour sets `tour_completed`.
 */
export const ADVANCED_TOUR_STEPS: TourStep[] = [
  {
    id: "advanced-intro",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.introTitle",
    bodyKey: "tour.advanced.introBody",
  },
  {
    id: "remote-projects",
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    titleKey: "tour.remoteProjectsTitle",
    bodyKey: "tour.remoteProjectsBody",
  },
  {
    id: "extend-to-remote",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.extendTitle",
    bodyKey: "tour.advanced.extendBody",
  },
  {
    id: "vpn",
    anchor: ".vpn-indicator-btn",
    placement: "bottom",
    titleKey: "tour.advanced.vpnTitle",
    bodyKey: "tour.advanced.vpnBody",
  },
  {
    id: "compute-machines",
    anchor: ".machines-indicator-btn",
    placement: "bottom",
    titleKey: "tour.advanced.machinesTitle",
    bodyKey: "tour.advanced.machinesBody",
  },
  {
    id: "persistent-sessions",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.sessionsTitle",
    bodyKey: "tour.advanced.sessionsBody",
  },
  {
    id: "isolation",
    anchor: null,
    placement: "bottom",
    titleKey: "tour.advanced.isolationTitle",
    bodyKey: "tour.advanced.isolationBody",
  },
  {
    id: "mobile",
    anchor: ".mobile-indicator-btn",
    placement: "bottom",
    titleKey: "tour.advanced.mobileTitle",
    bodyKey: "tour.advanced.mobileBody",
  },
  {
    id: "advanced-outro",
    anchor: '[data-hint-anchor="settings"]',
    placement: "bottom",
    titleKey: "tour.advanced.outroTitle",
    bodyKey: "tour.advanced.outroBody",
    task: GEAR_MENU_TASK,
  },
];

/** Contextual-hint ids the tour teaches, marked seen on finish so they don't
 *  immediately re-fire once the overlay closes. */
export const COVERED_HINTS = ["create-project", "add-tab", "toggle-panels", "file-tree"] as const;

/** The selector whose click completes `step`'s task, or null when the task
 *  watches for something else. A task that names no signal of its own means
 *  "click the control this step is pointing at", so it falls back to the
 *  step's anchor — and a step with neither has nothing to click. */
export function taskClickSelector(step: TourStep): string | null {
  const task = step.task;
  if (!task) return null;
  if (task.click) return task.click;
  if (task.appear || task.grow || task.event) return null;
  return step.anchor;
}

/** Whether a step waits on the user instead of on Next. */
export function isInteractive(step: TourStep): boolean {
  return step.task != null;
}

/** Praise shown when a task is solved, varied by position so a lesson doesn't
 *  repeat one word — deterministic (no randomness) so tests and replays of the
 *  same lesson read identically. */
export const REWARD_KEYS: TranslationKey[] = [
  "tour.rewardNice",
  "tour.rewardExactly",
  "tour.rewardThatsIt",
  "tour.rewardGotIt",
];

/** The praise key for the step at `index` in its lesson. */
export function rewardKey(index: number): TranslationKey {
  return REWARD_KEYS[Math.abs(index) % REWARD_KEYS.length];
}

/** Whether a step applies to the given context (defaults to always-on). */
export function isStepEligible(step: TourStep, ctx: TourCtx): boolean {
  return step.when ? step.when(ctx) : true;
}

/** First index `>= from` whose step is eligible, or `steps.length` when none
 *  remain — the signal the tour has run off the end and should finish. */
export function nextEligibleIndex(steps: TourStep[], ctx: TourCtx, from: number): number {
  for (let i = Math.max(0, from); i < steps.length; i++) {
    if (isStepEligible(steps[i], ctx)) return i;
  }
  return steps.length;
}

/** Last index `<= from` whose step is eligible, or -1 when none precede it. */
export function prevEligibleIndex(steps: TourStep[], ctx: TourCtx, from: number): number {
  for (let i = Math.min(steps.length - 1, from); i >= 0; i--) {
    if (isStepEligible(steps[i], ctx)) return i;
  }
  return -1;
}
