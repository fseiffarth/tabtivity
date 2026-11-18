/**
 * The phone's keyboard-steering engine: one hook, called once in `App()`
 * (before its early returns), that listens on `window` in the capture phase
 * and walks the cursor over Home, a project's tabs, a tab, a section and
 * whatever sheet is up. The rules it follows are in `docs/mobile_steering_plan.md`
 * ("Fixed decisions" and "Engine rules").
 *
 * What it promises, because typing must never be eaten:
 * - With the mode off it acts on the two entry chords only, and calls
 *   `preventDefault` on nothing else (not even their own keyup, which it
 *   prevents so the focused button is not clicked by the Space release).
 * - It never calls `stopPropagation`: the idle-lock listener and React must see
 *   every key.
 * - With the mode on it prevents only the keydowns the table resolves, and the
 *   keyup of each key it prevented, even after the mode has been left.
 * - While a text field has the caret, every key passes through except Esc.
 *
 * The cursor is real focus: a `[data-steer-row]` button on a list level, a
 * focusable control in a sheet or section. See `steeringDom.ts`.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getActivity, type ActivityTab } from "../api";
import { goBack } from "../backStack";
import type { MobileSection } from "../lastPlace";
import { useVisiblePoll } from "../visiblePoll";
import type { TranslationKey } from "../../../src/lib/i18n";
import {
  acceptsRepeat,
  isEntryChord,
  isIgnoredKey,
  phoneDigit,
  phoneSteeringActionFor,
  typingField,
  type PhoneLevel,
  type PhoneSteeringAction,
} from "./phoneSteeringKeys";
import { nextStatusTab, type StatusKind } from "./phoneStatusJump";
import {
  actButton,
  controls,
  cursorRow,
  focusRow,
  ownKeysUp,
  press,
  rowById,
  rowId,
  rows,
  scrollStep,
  type SteerAct,
  toLatest,
  topModal,
  walk,
} from "./steeringDom";
import {
  flash,
  getInside,
  getSteering,
  setActive,
  setActivity,
  setConfirm,
  setJumpBack,
  setView,
  subscribe,
  toggleLegendFolded,
  type Place,
} from "./steeringState";

/** The level the App is on when no sheet is up. A sheet makes it `region`. */
export type SteeringBase = "projects" | "tabs" | "inside" | "section";

export interface PhoneSteeringInput {
  /** True while the phone is paired; false turns the engine (and the mode) off. */
  enabled: boolean;
  base: SteeringBase;
  /** The section screen's name for the legend, when `base` is `section`. */
  sectionLabel: TranslationKey | null;
  /** Where the reader stands now; a status jump remembers it. */
  place: Place;
  /** Opens a tab as a tap on its row would (a done tab is marked seen there). */
  openTab(projectId: string, row: ActivityTab): void;
  openSection(tab: MobileSection): void;
  /** Goes back to a place `setJumpBack` stored. */
  restore(place: Place): void;
  /** Shows Home's search (the `/` key); Home answers `takeFindRequest()`. */
  findProject(): void;
}

/** Levels whose cursor is a `[data-steer-row]` button. */
const LIST_LEVELS: ReadonlySet<PhoneLevel> = new Set<PhoneLevel>(["projects", "tabs"]);
/** A cached activity list this young is used by a status jump without a fetch. */
const ACTIVITY_FRESH_MS = 2000;
/** How often the legend's counts refresh while the mode is on. */
const ACTIVITY_POLL_MS = 5000;

const STATUS_KIND: Partial<Record<PhoneSteeringAction, StatusKind>> = {
  nextDecision: "ask",
  nextWorking: "working",
  nextDone: "done",
};
const NONE_KEY: Record<StatusKind, TranslationKey> = {
  ask: "mobile.steering.none.decision",
  working: "mobile.steering.none.working",
  done: "mobile.steering.none.done",
};
const SECTION_OF: Partial<Record<PhoneSteeringAction, MobileSection>> = { mail: "mail", calendar: "calendar", todo: "todo" };

const isBodyLike = (el: Element | null): boolean => el === null || el === document.body || el === document.documentElement;

/** Builds the engine on `window`; returns what removes it (and leaves the mode). */
function createEngine(input: { current: PhoneSteeringInput }): () => void {
  /** `code`s (else `key`s) whose keydown was prevented: their keyup is too. */
  const swallowed = new Set<string>();
  /** The id of the row the cursor last stood on, per list level. */
  const memory: Partial<Record<PhoneLevel, string>> = {};
  let observer: MutationObserver | null = null;
  let repairFrame = 0;
  let jumpSeq = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const active = () => getSteering().active;
  const base = () => input.current.base;
  const levelNow = (): PhoneLevel => (topModal() ? "region" : base());
  /** The rows the cursor walks at the current level. Beside Home's list (the
   * split tier) the list and the open project are two panes on one screen, each
   * its own level; their rows must not run into each other. Elsewhere there is
   * no pane marker and every row on the page is the level's. A tab can stand
   * in both panes (Needs you and its card) under one row id, so a remembered
   * row and the screen's own ＋ are looked up in the pane too. */
  const lane = (): ParentNode => document.querySelector<HTMLElement>(`[data-steer-pane='${base() === "tabs" ? "detail" : "list"}']`) ?? document;
  const laneRows = (): HTMLElement[] => rows(lane());
  const laneRowById = (id: string): HTMLElement | null => rowById(id, lane());
  /** Clicks the first reachable `act` button under `scope` (`screenAct`, `rowAct`, scoped). */
  const clickAct = (scope: ParentNode, act: SteerAct) => actButton(scope, act)?.click();
  const keyId = (e: KeyboardEvent) => e.code || e.key;
  const swallow = (e: KeyboardEvent) => {
    e.preventDefault();
    swallowed.add(keyId(e));
  };
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  /** Tells the legend what the engine sees now. */
  function publishView(): void {
    if (!active()) return;
    const paused = ownKeysUp();
    const field = typingField(document.activeElement);
    setView({
      level: !paused && topModal() ? "region" : base(),
      paused,
      typing: field ? (field.closest(".composer-field") ? "composer" : "field") : "none",
      sectionLabel: base() === "section" ? input.current.sectionLabel : null,
    });
  }

  /** Puts the cursor back on a row when nothing has focus (engine rule 7). */
  function repair(): void {
    if (repairFrame) cancelAnimationFrame(repairFrame);
    repairFrame = 0;
    if (!active()) return;
    const level = base();
    if (isBodyLike(document.activeElement) && LIST_LEVELS.has(level) && !topModal() && !ownKeysUp()) {
      const list = laneRows();
      const remembered = memory[level];
      const target = (remembered === undefined ? null : laneRowById(remembered)) ?? list[0];
      if (target) focusRow(target);
    }
    publishView();
  }
  const scheduleRepair = () => {
    if (!repairFrame) repairFrame = requestAnimationFrame(repair);
  };

  function startObserver(): void {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(scheduleRepair);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver(): void {
    observer?.disconnect();
    observer = null;
    if (repairFrame) cancelAnimationFrame(repairFrame);
    repairFrame = 0;
  }

  function enter(): void {
    const at = document.activeElement;
    if (at instanceof HTMLElement && typingField(at)) at.blur();
    setActive(true);
    startObserver();
    const level = base();
    if (LIST_LEVELS.has(level) && !topModal() && !ownKeysUp()) {
      const list = laneRows();
      if (list.length > 0 && cursorRow(list, document.activeElement) === null) {
        const remembered = memory[level];
        focusRow((remembered === undefined ? null : laneRowById(remembered)) ?? list[0]);
      }
    }
    publishView();
  }
  function leave(): void {
    jumpSeq += 1;
    stopObserver();
    setActive(false);
  }

  /** The row the cursor stands on: the focused one, or the remembered one when nothing has focus. */
  function currentRow(): HTMLElement | null {
    const list = laneRows();
    const focused = cursorRow(list, document.activeElement);
    if (focused) return focused;
    const remembered = memory[base()];
    return isBodyLike(document.activeElement) && remembered !== undefined ? laneRowById(remembered) : null;
  }

  /** Esc in a text field: let go of it and carry on steering from the next control or the row. */
  function leaveField(field: HTMLElement): void {
    const modal = topModal();
    const next = modal ? walk(controls(modal), 1, field) : null;
    field.blur();
    if (next && next !== field) focusRow(next);
    else repair();
    publishView();
  }

  /** An Enter that sent the draft leaves the field empty: put the caret away so steering resumes. */
  function resumeIfSent(field: HTMLTextAreaElement): void {
    const check = () => {
      if (!active() || document.activeElement !== field || field.value !== "") return;
      field.blur();
      repair();
    };
    later(check, 0);
    later(check, 250);
  }

  async function statusJump(kind: StatusKind, backwards: boolean): Promise<void> {
    const seq = ++jumpSeq;
    const cached = getSteering().activity;
    let list: ActivityTab[];
    if (cached && Date.now() - cached.fetchedAt < ACTIVITY_FRESH_MS) {
      list = cached.tabs;
    } else {
      try {
        const answer = await getActivity();
        list = Array.isArray(answer.tabs) ? answer.tabs : [];
        setActivity(list);
      } catch {
        list = cached?.tabs ?? [];
      }
    }
    if (seq !== jumpSeq || !active()) return;
    const place = input.current.place;
    const target = nextStatusTab(list, place.kind === "terminal" ? place.tab.id : null, kind, backwards);
    if (!target) {
      flash(NONE_KEY[kind]);
      return;
    }
    setJumpBack(place);
    input.current.openTab(target.project_id, target);
  }

  /** Moves the cursor one step on a list level, a section or a sheet; inside a tab it scrolls (`page`: Shift, a page). */
  function step(dir: 1 | -1, level: PhoneLevel, page = false): void {
    if (level === "inside") {
      scrollStep(dir, page);
      return;
    }
    if (LIST_LEVELS.has(level)) {
      const from = isBodyLike(document.activeElement) ? currentRow() : document.activeElement;
      const next = walk(laneRows(), dir, from);
      if (next) focusRow(next);
      return;
    }
    const root = level === "region" ? topModal() : (document.querySelector<HTMLElement>("main.screen") ?? document.body);
    if (!root) return;
    const next = walk(controls(root), dir, document.activeElement);
    if (next) focusRow(next);
  }

  /** Enter and the right arrow: open the row, press the control. */
  function open(level: PhoneLevel): void {
    if (LIST_LEVELS.has(level)) {
      const row = currentRow();
      if (!row) return;
      if (document.activeElement !== row) focusRow(row);
      press(row);
      return;
    }
    const root = level === "region" ? topModal() : (document.querySelector<HTMLElement>("main.screen") ?? document.body);
    if (!root) return;
    const at = document.activeElement;
    if (at instanceof HTMLElement && root.contains(at) && at !== root) {
      press(at);
      return;
    }
    const first = controls(root)[0];
    if (first) focusRow(first);
  }

  function askClose(): void {
    const row = currentRow();
    const card = row?.closest(".tab-card");
    if (!row || !card) return;
    if (!card.querySelector("[data-steer-act='close']:not(:disabled)")) return;
    const label = card.querySelector(".tab-card-title strong")?.textContent ?? row.getAttribute("aria-label") ?? rowId(row);
    setConfirm({ tabId: rowId(row), label });
  }

  function run(action: PhoneSteeringAction, e: KeyboardEvent, level: PhoneLevel): void {
    const kind = STATUS_KIND[action];
    if (kind) {
      void statusJump(kind, e.shiftKey);
      return;
    }
    const section = SECTION_OF[action];
    if (section) {
      input.current.openSection(section);
      return;
    }
    switch (action) {
      case "exit":
        leave();
        return;
      case "legend":
        toggleLegendFolded();
        return;
      case "up":
        step(-1, level, e.shiftKey);
        return;
      case "down":
        step(1, level, e.shiftKey);
        return;
      case "back":
        goBack();
        return;
      case "open":
        open(level);
        return;
      case "latest":
        toLatest();
        return;
      case "confirm":
        document.querySelector<HTMLElement>("[data-steer-confirm]")?.click();
        return;
      case "jumpBack": {
        const place = getSteering().jumpBack;
        if (!place) return;
        setJumpBack(null);
        input.current.restore(place);
        return;
      }
      case "search":
        delete memory.projects;
        input.current.findProject();
        return;
      case "newProject":
      case "newTab":
        clickAct(lane(), "new");
        return;
      case "closeTab":
        askClose();
        return;
      case "menu": {
        // The cursor's own card: its id may also stand on a Needs you row in the other pane.
        const card = currentRow()?.closest(".tab-card, .home-project-card");
        if (card) clickAct(card, "menu");
        return;
      }
      case "openRow": {
        const n = phoneDigit(e, null);
        if (n === null) return;
        // The digits count the project rows, not Needs you's; the Agents list has none, so they count its rows.
        const projects = laneRows().filter((row) => row.closest(".home-project-card"));
        const row = (projects.length > 0 ? projects : laneRows())[n - 1];
        if (!row) return;
        focusRow(row);
        press(row);
        return;
      }
      case "answer": {
        const n = phoneDigit(e, null);
        if (n === null) return;
        const result = getInside()?.answer(n) ?? "none";
        if (result === "none") flash("mobile.steering.noQuestion");
        else if (result === "missing") flash("mobile.steering.noOption", { n });
        return;
      }
      case "queueSend":
      case "queuePull": {
        const inside = getInside();
        const did = action === "queueSend" ? inside?.sendQueued() : inside?.pullQueued();
        if (!did) flash("mobile.steering.noQueue");
        return;
      }
      case "type": {
        const typed = getInside()?.focusComposer();
        if (typed === "blocked") flash("mobile.steering.blocked");
        else if (typed === "offline") flash("mobile.indReconnecting");
        return;
      }
      default:
        return;
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (isIgnoredKey(e)) return;
    if (isEntryChord(e, e.target)) {
      swallow(e);
      if (active()) leave();
      else enter();
      return;
    }
    if (!active()) return;
    // A files library, a viewer or Mark up owns its keys: nothing is touched.
    if (ownKeysUp()) {
      publishView();
      return;
    }
    const field = typingField(e.target);
    if (field) {
      if (e.key === "Escape") {
        swallow(e);
        leaveField(field);
      } else if (e.key === "Enter" && field instanceof HTMLTextAreaElement && field.value !== "") {
        resumeIfSent(field);
      }
      return;
    }
    const level = levelNow();
    const action = phoneSteeringActionFor(e, level, null);
    if (!action) return;
    swallow(e);
    if (e.repeat && !acceptsRepeat(action)) return;
    run(action, e, level);
    if (active()) publishView();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const id = keyId(e);
    if (!swallowed.delete(id)) return;
    e.preventDefault();
  };
  const onPointerDown = () => {
    if (active()) leave();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden" && active()) leave();
  };
  const onWindowBlur = () => swallowed.clear();
  const onFocusChange = (e: FocusEvent) => {
    if (!active()) return;
    const level = base();
    if (e.type === "focusin" && LIST_LEVELS.has(level) && !topModal() && e.target instanceof Element) {
      const row = cursorRow(laneRows(), e.target);
      if (row) memory[level] = rowId(row);
    }
    queueMicrotask(publishView);
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focusin", onFocusChange, true);
  window.addEventListener("focusout", onFocusChange, true);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("focusin", onFocusChange, true);
    window.removeEventListener("focusout", onFocusChange, true);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    leave();
    // Unpaired or unmounted: a close confirm must not wait for the next session.
    setConfirm(null);
  };
}

/**
 * Mounts keyboard steering. Called once in `App()` before its early returns;
 * the listeners are added once per `enabled`, the rest is read through a ref.
 * While the mode is on it refreshes the cross-project activity list every 5 s,
 * so the legend can show how many tabs wait, work or are done.
 */
export function usePhoneSteering(input: PhoneSteeringInput): void {
  const latest = useRef(input);
  latest.current = input;
  const { enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    return createEngine(latest);
  }, [enabled]);
  // Only the flag, so the App does not render on every flash or count.
  const on = useSyncExternalStore(subscribe, () => getSteering().active, () => false);
  useVisiblePoll(
    (signal) => getActivity(signal).then((answer) => {
      if (!signal.aborted && Array.isArray(answer.tabs)) setActivity(answer.tabs);
    }),
    ACTIVITY_POLL_MS,
    { enabled: enabled && on },
  );
}
