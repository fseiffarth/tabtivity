/**
 * Keyboard steering mode: the modal layer for the rebindable keys in
 * `steeringBindings.ts`, captured on `document` in the CAPTURE phase so xterm
 * never sees them and the mode works from a focused terminal. Moved out of
 * `useKeyboard` (which keeps the window chords and mounts this hook first, so
 * the listener order is unchanged). See `useKeyboard`'s doc comment for the
 * levels and the region cursor.
 */
import { hasActiveModal } from "./useModalFocus";
import { inCockpitRoster, runCockpitRoster, selectCockpitCursor, stepCockpitArea } from "../lib/shortcuts/steeringCockpit";
import { useEffect } from "react";
import { ROOT_SCOPE, allGroups, findGroup, useTabsStore } from "../stores/tabs";
import { steeringInRoot, steeringTabs, steeringTabsActive } from "../lib/shortcuts/steeringScope";
import { POPOUT_HANDS_OVER } from "../lib/shortcuts/steeringPopout";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { subscribeTauri } from "./useTauriListener";
import { getDetachedWindowContext } from "../stores/detachedContext";
import {
  DETACHED_STEER,
  MAIN_STEERING_LABEL,
  STEERING_OWNER,
  STEERING_STATUS,
  detachedSteerEvent,
  type DetachedSteerPayload,
  type DetachedSteerRequest,
  type SteerAct,
} from "../stores/detached";
import { popoutAfter, raisePopout } from "../lib/window/focusPopout";
import { MAIN_TAB_HOME } from "../lib/shortcuts/tabJump";
import { usePopoutViewStore, type PopoutSteeringStatus } from "../stores/popoutView";
import { reopenClosedAgentTab } from "../stores/agents/closedAgentTabs";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import {
  projectStations,
  useKeyboardSteeringStore,
  type SteeringHandoff,
  type SteeringRegion,
} from "../stores/keyboardSteering";
import { useActivityStore } from "../stores/activity";
import { jumpToTab } from "../lib/shortcuts/tabJump";
import { focusNextPopout } from "../lib/window/focusPopout";

import { STEER_FROM_POPOUT, isTextKey, steeringChordFires } from "../lib/shortcuts/steeringChord";
import {
  afterStatusJump,
  jumpBackTarget,
  nextStatusTab,
  shownStatusTab,
  statusTabs,
  type StatusTab,
  type TabStatusKind,
} from "../lib/shortcuts/statusJump";
import { answerSteeringQuestion, settleAfterAnswer, steeringTabAsks } from "../lib/shortcuts/steeringAnswer";
import {
  steeringActionFor,
  steeringKeyIs,
  steeringSlot,
  type SteeringAction,
  type SteeringKeyContext,
  type SteeringKeyMap,
} from "../lib/shortcuts/steeringBindings";
import { closeApp, openApp as showApp, shownApp } from "../lib/shortcuts/appViews";
import { openProjectDialog } from "../lib/projects/projectDialogEvent";
import { requestProjectJump } from "../lib/projects/projectJumpEvent";
import {
  activateRegionCursor,
  activeProjectElement,
  activeSubagentFrame,
  activeTabCard,
  activeTabElement,
  clearRegionCursor,
  closeAddTabSubmenu,
  closeRegionDropdown,
  closeSubagentList,
  dismissLayer,
  focusRegionSearch,
  isSteeringSynthetic,
  markLayer,
  moveRegionCursor,
  moveRegionCursorByLine,
  openContextMenu,
  openCursorPopup,
  openSubagentList,
  placeRegionCursor,
  placeSubagentCursor,
  pointRegionCursor,
  regionCursor,
  regionForLayer,
  regionHasControls,
  regionRoot,
  resumeRegionCursor,
  scrollRegion,
  settingsDialog,
  steeringAppEnabled,
  stepSettingsPage,
  topLayer,
  type SteeringApp,
} from "../lib/shortcuts/steeringRegion";
import { placeSidePanelCursor, steerSidePanel } from "../lib/shortcuts/steeringSidePanel";
import { cycleReaderView, queueMovesFor, readerInsideFor, readerViewFor } from "../lib/agents/readerSteering";
import {
  openProjectShellInRootConsole,
  rootViewShown,
  toggleRootConsole,
  useRootOverlayStore,
} from "../stores/rootOverlay";
import { newTabRequestFor, requestNewTab, requestOverlayAgent } from "../lib/shortcuts/newTabChord";
import { requestSteeringPrompt, steeringActiveTab } from "../lib/shortcuts/steeringAgent";
import {
  requestSteeringConfirm,
  steeringConfirmButton,
  steeringConfirmButtonFor,
} from "../lib/shortcuts/steeringConfirm";
import { terminalFor } from "../lib/terminal/terminalRegistry";
import { releaseTerminalScroll, scrollTerminal, scrollTerminalToLive } from "../lib/terminal/terminalScroll";
import { documentScroller, scrollDocument, scrollDocumentToEnd } from "../lib/shortcuts/documentScroll";
import { chordMatches, isLoneModifier, resolveChord, type ShortcutMap } from "../lib/shortcuts/shortcuts";

export type SteeringSurface = "main" | "popout";

export interface SteeringOptions {
  /** Which window this steering runs in: the main window, or a popout. */
  surface: SteeringSurface;
  /** The panel toggle (steering's panels key). */
  onTogglePanels?: () => void;
  /** Open (showing the panels if they were hidden) or close the side panel —
   *  steering's B key, and Escape back out of it. */
  onSidePanel?: (open: boolean) => void;
}

/** Steering's new tabs land right of the tab it was on, not at the pane's end. */
const BESIDE_ACTIVE = { besideActive: true } as const;

/**
 * How long the window may lose the keyboard and keep steering on. A desktop
 * screenshot (PrtSc, a region dragged, Enter) or a glance at a notification
 * blurs the window for seconds: coming back, steering is where it was. After
 * a longer absence the window comes back out of steering — keys typed then are
 * meant as text, not as moves.
 */
export const STEERING_BLUR_GRACE_MS = 60_000;

/**
 * How long a window asked to take steering (by another window's J, Up or a
 * handed-over key) waits for the keyboard to arrive before it drops the
 * request. Without the keyboard it never enters, so the sender — which keeps
 * steering until a window announces itself — stays where the keys still go.
 */
export const STEER_HANDOVER_WAIT_MS = 800;

export function useSteering({ surface, onTogglePanels, onSidePanel }: SteeringOptions) {
  useEffect(() => {
    // A popout window (`DetachedApp`): its own subwindows and tabs, read through
    // `steeringScope` and written through the tabs store's popout routing. It
    // has no projects level, no root console and no side panel; the keys whose
    // target lives only in the main window hand over (`POPOUT_HANDS_OVER`).
    const popout = surface === "popout";
    // When the window lost the keyboard while steering was on (`onBlur`).
    let steeringBlurredAt: number | null = null;

    // ── Keyboard steering mode ────────────────────────────────────────────
    // A capture-phase listener on `document`, which threads two needles at
    // once: it runs BEFORE xterm's textarea handlers (target phase), so a
    // steered key is stopped before the PTY can see it — and BEFORE this
    // hook's own editable-target guard by construction, so the toggle chord
    // works from a focused terminal (the whole point). But it runs AFTER the
    // settings panel's chord-capture listener (window, capture phase), so
    // rebinding the steering chord itself still captures instead of toggling.
    // Steering's own bookkeeping, outside the store because nothing renders it:
    // whether the side panel is open because steering opened it (Escape out of
    // it closes it again), and the pending retry that lands the region cursor
    // once a surface has mounted.
    let panelOpenedBySteering = false;
    // When the last text character was typed outside the mode (event time).
    let lastTypedAt = -Infinity;
    let placeTimer: number | null = null;
    const cancelPlace = () => {
      if (placeTimer !== null) {
        window.clearTimeout(placeTimer);
        placeTimer = null;
      }
    };
    // A surface steering just opened is not on screen yet (the panel mounts its
    // tree on open, mail and the board are lazy chunks): try for about a second.
    // `resume`: back on a surface steering left for one over it — the cursor
    // goes where it was.
    const placeCursorSoon = (region: SteeringRegion, tries = 20, resume = false) => {
      cancelPlace();
      const root = regionRoot(region);
      // The side panel's cursor lands in its list (`steeringSidePanel`), not on its header.
      const place = (el: HTMLElement) =>
        region === "side"
          ? placeSidePanelCursor(el, resume)
          : region === "subagents"
            ? placeSubagentCursor(el)
            : resume
            ? resumeRegionCursor(el)
            : region === "cockpit"
              ? placeRegionCursor(el.querySelector<HTMLElement>(".cockpit-roster-list") ?? el) || placeRegionCursor(el)
              : placeRegionCursor(el);
      if (root && place(root)) return;
      if (tries <= 0) return;
      placeTimer = window.setTimeout(() => {
        placeTimer = null;
        const s = useKeyboardSteeringStore.getState();
        if (s.active && s.region === region) placeCursorSoon(region, tries - 1, resume);
      }, 50);
    };
    // The layer the overlay region is walking, to notice another taking its
    // place (a confirm raised over a dialog, or closed back to it).
    let overlayLayer: HTMLElement | null = null;
    const dropOverlay = () => {
      overlayLayer = null;
      markLayer(null);
    };
    // The mode opens on the tabs, so a subwindow has to hold the focus — or on
    // the dialog or menu on top, when one is up (back from typing in one of its
    // fields, say); Escape then closes it.
    const enterSteering = () => {
      cancelArrival();
      focusSomeGroup();
      useKeyboardSteeringStore.getState().enter();
      announceOwner();
      syncLayer();
    };

    // ── Between windows ────────────────────────────────────────────────────
    // One window steers at a time, and steering follows the keyboard: a window
    // that takes it announces itself (`STEERING_OWNER`) and every other one
    // leaves. A window that hands steering over keeps it until it hears the
    // target's announcement, so a focus move the window manager refused leaves
    // steering where the keys still go.
    const myLabel = popout ? (getDetachedWindowContext()?.label ?? "") : MAIN_STEERING_LABEL;
    const announceOwner = () => {
      try {
        void emit(STEERING_OWNER, { label: myLabel }).catch(() => {});
      } catch {
        /* no Tauri event bus */
      }
    };
    const sendSteer = (event: string, payload: unknown) => {
      try {
        void emit(event, payload).catch(() => {});
      } catch {
        /* no Tauri event bus */
      }
    };
    // Another window took steering: this one steps aside, and a box it lent
    // the keyboard to no longer brings it back.
    const onOwner = (label: string) => {
      if (label === myLabel) return;
      // The popout that now steers draws the main window's counts.
      if (!popout) publishStatus(true);
      cancelArrival();
      const s = useKeyboardSteeringStore.getState();
      if (s.active) exitSteering();
      else if (s.handedTo) s.dropHandoff();
    };
    // Main: the counts a popout's bar shows (`STEERING_STATUS`), sent when they
    // change and only while some popout is open.
    let lastStatus = "";
    const publishStatus = (force = false) => {
      const tabs = useTabsStore.getState();
      if (!Object.values(tabs.detachedGroupsByScope).some((list) => (list?.length ?? 0) > 0)) {
        lastStatus = "";
        return;
      }
      const activity = useActivityStore.getState();
      const count = (kind: TabStatusKind) =>
        statusTabs(kind, activity.busyByTab, activity.attentionByTab, tabs.tabsByScope).length;
      const status: PopoutSteeringStatus = {
        decision: count("decision"),
        working: count("working"),
        done: count("done"),
        back: !!jumpBackTarget(useKeyboardSteeringStore.getState().jumpBack, null, tabs.tabsByScope),
      };
      const sig = `${status.decision}|${status.working}|${status.done}|${status.back}`;
      if (!force && sig === lastStatus) return;
      lastStatus = sig;
      sendSteer(STEERING_STATUS, status);
    };
    // A request to take steering waits for the keyboard (`STEER_HANDOVER_WAIT_MS`).
    let pendingArrival: (() => void) | null = null;
    const cancelArrival = () => {
      const cancel = pendingArrival;
      pendingArrival = null;
      cancel?.();
    };
    const whenFocused = (run: () => void) => {
      cancelArrival();
      if (document.hasFocus()) {
        run();
        return;
      }
      const go = () => {
        cancelArrival();
        run();
      };
      const timer = window.setTimeout(cancelArrival, STEER_HANDOVER_WAIT_MS);
      window.addEventListener("focus", go);
      pendingArrival = () => {
        window.clearTimeout(timer);
        window.removeEventListener("focus", go);
      };
    };
    // Every arrival lands on this window's tabs level; a handed-over key then
    // runs here as if pressed here.
    const arrive = (act: SteerAct) => {
      // A status jump's target here: its subwindow takes the focus, the tab
      // shows (the main window already made it the active one).
      if (act.kind === "tab") {
        const walked = steeringTabs();
        const group = allGroups(walked.layout).find((g) => g.tabKeys.includes(act.key));
        if (group) useTabsStore.getState().setGroupActiveInScope(walked.scope, group.id, act.key);
      }
      const s = useKeyboardSteeringStore.getState();
      if (!s.active) enterSteering();
      else {
        cancelPlace();
        clearRegionCursor();
        dropOverlay();
        panelOpenedBySteering = false;
        focusSomeGroup();
        s.setLevel("tabs");
        announceOwner();
      }
      if (act.kind === "action") steerCommon(new KeyboardEvent("keydown", { shiftKey: act.shift }), act.action);
    };
    // The main window comes forward (un-minimized, focused) for a popout's
    // request; the arrival then waits for the keyboard.
    const raiseMainWindow = () => {
      try {
        const win = getCurrentWindow();
        void win
          .unminimize()
          .then(() => win.setFocus())
          .catch(() => {});
      } catch {
        /* no Tauri window */
      }
    };
    // Main: a popout's request (`DETACHED_STEER` → `STEER_FROM_POPOUT`). Its J
    // goes on to the scope's next popout, after the last one to this window.
    const onSteerFromPopout = (e: Event) => {
      const request = (e as CustomEvent<DetachedSteerPayload | null>).detail;
      const act: SteerAct = request?.act ?? { kind: "enter" };
      // A status jump or Back: the window comes forward only if the tab lives
      // here (`goToTab`).
      if (request && act.kind === "action" && (STATUS_ACTIONS[act.action] || act.action === "jumpBack")) {
        runFromPopout(request, act);
        return;
      }
      if (request && act.kind === "action" && act.action === "popout") {
        const next = popoutAfter(request.scope, request.label);
        if (next) {
          void raisePopout(request.scope, next).then((raised) => {
            if (raised) sendSteer(detachedSteerEvent(next), { act: { kind: "enter" } } satisfies DetachedSteerRequest);
          });
          return;
        }
        raiseMainWindow();
        whenFocused(() => arrive({ kind: "enter" }));
        return;
      }
      raiseMainWindow();
      whenFocused(() => arrive(act));
    };
    // Popout: hand steering, or a key, to the main window.
    const sendToMain = (act: SteerAct) => {
      const ctx = getDetachedWindowContext();
      if (!ctx) return;
      sendSteer(DETACHED_STEER, {
        scope: ctx.scope,
        groupId: ctx.groupId,
        label: ctx.label,
        act,
        shown: shownStatusTab(),
      } satisfies DetachedSteerPayload);
    };
    const exitSteering = () => {
      cancelPlace();
      clearRegionCursor();
      dropOverlay();
      panelOpenedBySteering = false;
      useKeyboardSteeringStore.getState().exit();
    };
    // Out of the current region: back to the surface under it that is still
    // on screen (settings under a dialog, the top bar under its menu), the
    // cursor where it was there — else to the base level.
    const returnFromRegion = () => {
      cancelPlace();
      clearRegionCursor();
      const back = useKeyboardSteeringStore.getState().leaveRegion((r) => !!regionRoot(r));
      if (back) placeCursorSoon(back, 20, true);
    };
    // What floats on top decides where the keys go. A dialog or menu that came
    // up — from a press, W's confirm, the pointer, the app itself — takes the
    // region cursor; one that went away hands it back to the surface under it.
    // Runs before every steering key and just after it (`syncSoon`). True when
    // it moved steering.
    let cockpitView = useRootOverlayStore.getState().view;
    const syncLayer = (): boolean => {
      const s = useKeyboardSteeringStore.getState();
      if (!s.active) return false;
      const layer = topLayer();
      const current = s.level === "region" ? s.region : null;
      if (current === "overlay") {
        if (layer && regionForLayer(layer) === "overlay") {
          if (layer === overlayLayer) return false;
          overlayLayer = layer;
          markLayer(layer);
          clearRegionCursor();
          placeCursorSoon("overlay", 20, true);
          return true;
        }
        // Closed — or a surface with a region of its own is on top again.
        dropOverlay();
        returnFromRegion();
        syncLayer();
        return true;
      }
      if (!layer) return false;
      const root = current ? regionRoot(current) : null;
      const next = regionForLayer(layer);
      if (current === "cockpit" && next === "cockpit" &&
          (cockpitView !== useRootOverlayStore.getState().view || !regionCursor())) {
        cockpitView = useRootOverlayStore.getState().view;
        clearRegionCursor();
        placeCursorSoon("cockpit");
        return false;
      }
      if (current === "addTab" && next === "addTab" && root && !root.contains(regionCursor())) {
        // The flyout opens inside the same portal, so only the cursor root
        // changes. On return the parent still remembers its trigger.
        clearRegionCursor();
        placeCursorSoon("addTab", 20, true);
        return !!regionCursor();
      }
      if (root && layer.contains(root) && next === current) return false;
      if (next === current) return false;
      if (next === "overlay") {
        overlayLayer = layer;
        markLayer(layer);
      }
      enterRegion(next);
      return true;
    };
    // After a key: once what it opened or closed has rendered, and again a
    // moment later for a surface that mounts late (a lazy chunk). `then` runs
    // after the first pass.
    const syncTimers = new Set<number>();
    const syncSoon = (then?: () => void) => {
      for (const [delay, run] of [
        [0, () => {
          syncLayer();
          then?.();
        }],
        [150, syncLayer],
      ] as const) {
        const id = window.setTimeout(() => {
          syncTimers.delete(id);
          run();
        }, delay);
        syncTimers.add(id);
      }
    };
    // A held key repeats faster than a heavy surface can take a step — the
    // mail overlay reads the style and box of thousands of elements for each.
    // Repeats the window had no time for queue up, and the cursor walked on by
    // itself long after the key was let go (user, 2026-10-01). So a repeat is
    // dropped when it was fired while the last step was still running, or
    // before that step reached the screen.
    let stepDoneAt = -Infinity;
    let stepUnpainted = false;
    const staleRepeat = (e: KeyboardEvent): boolean => {
      if (!e.repeat) return false;
      if (stepUnpainted) return true;
      // `timeStamp` is on `performance.now()`'s clock in the engine; an older
      // one counts from the epoch (jsdom) and cannot be compared.
      const now = performance.now();
      return Math.abs(now - e.timeStamp) < 60_000 && e.timeStamp < stepDoneAt;
    };
    const stepTaken = () => {
      stepDoneAt = performance.now();
      stepUnpainted = true;
      const painted = () => {
        stepUnpainted = false;
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(painted);
      else window.setTimeout(painted, 16);
    };
    // A box takes the keyboard and steering waits for it (`handOff`): the mode
    // is off, what steering opened stays open for it to come back to.
    const handOffSteering = (box: SteeringHandoff) => {
      cancelPlace();
      clearRegionCursor();
      useKeyboardSteeringStore.getState().handOff(box);
    };
    // Escape out of a region: close what steering opened for it, back to the
    // level it was entered from.
    const leaveRegion = (region: SteeringRegion) => {
      cancelPlace();
      clearRegionCursor();
      if (region === "side") {
        if (panelOpenedBySteering) onSidePanel?.(false);
        panelOpenedBySteering = false;
      } else if (region === "addTab") {
        // The menu request toggles; only send it while the menu is still up.
        if (regionRoot("addTab")) requestNewTab({ kind: "menu" });
      } else if (region === "settings") {
        if (settingsDialog()) window.dispatchEvent(new Event("app:close-settings"));
      } else if (region === "overlay") {
        dropOverlay();
      } else if (region === "subagents") {
        const frame = regionRoot(region);
        if (frame) closeSubagentList(frame);
      } else if (region !== "header" && region !== "card" && region !== "chrome" && region !== "cockpit") {
        closeApp(region);
      }
      returnFromRegion();
    };
    const enterRegion = (region: SteeringRegion) => {
      clearRegionCursor();
      useKeyboardSteeringStore.getState().enterRegion(region);
      placeCursorSoon(region);
    };
    const openSidePanel = () => {
      if (!regionRoot("side")) {
        onSidePanel?.(true);
        panelOpenedBySteering = true;
      }
      enterRegion("side");
    };
    // What the side panel's keys need from this hook (`steeringSidePanel`): a
    // file opened with Enter hands steering to its tab — the panel steering
    // opened closes, as on Back.
    const sidePanelHooks = {
      leaveToTabs: () => {
        leaveRegion("side");
        cancelPlace();
        clearRegionCursor();
        focusSomeGroup();
        useKeyboardSteeringStore.getState().setLevel("tabs");
      },
    };
    const openApp = (app: SteeringApp) => {
      if (!steeringAppEnabled(app, useSettingsStore.getState().settings)) return;
      showApp(app);
      enterRegion(app);
    };

    // A focused subwindow for the levels below the projects: the first one
    // when the scope has none focused. A popout's view always holds one (its
    // first by default, `steeringTabs`): it is written back as the focus.
    const focusSomeGroup = () => {
      const tabs = useTabsStore.getState();
      if (popout) {
        const walked = steeringTabs();
        if (walked.focusedGroupId) tabs.focusGroupInScope(walked.scope, walked.focusedGroupId);
        return;
      }
      const first = allGroups(tabs.layout)[0]?.id;
      if (!tabs.focusedGroupId && first) tabs.focusGroup(first);
    };
    // A project switched to from the project level: steering goes straight
    // down to its tabs, so the next switch is ↑ and ←/→ again. The subwindow
    // is picked once the switch has swapped the tabs in.
    const landOnTabs = (switched: Promise<unknown>) => {
      useKeyboardSteeringStore.getState().setLevel("tabs");
      void switched.then(focusSomeGroup, () => {});
    };

    // The project level: ←/→ walk the station ring and land on the tabs of
    // the project switched to, ↓ goes into its windows.
    function steerProjects(e: KeyboardEvent, action: SteeringAction | null) {
      const steering = useKeyboardSteeringStore.getState();
      // The numbers — jump to the Nth station of the SAME ring cycleProject
      // walks: 1 = the root scope, 2 = the first project pill (display order)
      // — the numbers the pill badges show. Lands on its tabs, as ←/→ do.
      const slot = steeringSlot(action);
      if (slot !== null) {
        const target = projectStations()[slot - 1];
        if (target !== undefined) landOnTabs(landOnStation(target));
        return;
      }
      switch (action) {
        case "work":
          exitSteering();
          return;
        case "left":
        case "right": {
          const switched = cycleProject(action === "right" ? 1 : -1);
          if (switched) landOnTabs(switched);
          return;
        }
        case "down":
          focusSomeGroup();
          steering.setLevel("panes");
          return;
        // Above the projects: the top bar — its apps, menus and switches.
        case "up":
          enterRegion("header");
          return;
        // The + menu's New project dialog, walked like any dialog.
        case "newProject":
          openProjectDialog("new");
          return;
        case "menu": {
          const pill = activeProjectElement();
          if (pill) openContextMenu(pill);
          return;
        }
      }
      steerCommon(e, action);
    }

    // The active tab's terminal, when it has a live one to scroll.
    const steeringActivePty = (): string | null => {
      const active = steeringActiveTab();
      const ptyId = active ? `${active.scope}:${active.tab.key}` : null;
      return ptyId && terminalFor(ptyId) ? ptyId : null;
    };
    // Otherwise the active tab itself, when a document in it scrolls.
    const steeringActiveDocument = (): { scope: string; key: string } | null => {
      const active = steeringActiveTab();
      if (!active || steeringActivePty()) return null;
      return documentScroller(active.scope, active.tab.key) ? { scope: active.scope, key: active.tab.key } : null;
    };

    // Bring up a tab a status jump or Back names; steering follows it down
    // to the tab level. Up on Root, a project's tab is not shown by a jump the
    // window covers: it steps aside (as the cockpit's Enter does), and the tab
    // levels are the workspace's again.
    //
    // The tab may live in a popout (`jumpToTab` returns its window): that
    // window is raised and asked to steer on the tab, and this one keeps
    // steering until it announces itself. `asker`: the popout whose key asked
    // for the jump — a tab here then brings this window forward too.
    const goToTab = (target: StatusTab, asker?: string) => {
      if (target.scope !== ROOT_SCOPE && steeringInRoot()) useRootOverlayStore.getState().close();
      const home = jumpToTab(target.scope, target.key);
      if (home && home !== MAIN_TAB_HOME) {
        sendSteer(detachedSteerEvent(home), { act: { kind: "tab", key: target.key } } satisfies DetachedSteerRequest);
        return;
      }
      if (asker) {
        raiseMainWindow();
        whenFocused(() => arrive({ kind: "enter" }));
        return;
      }
      useKeyboardSteeringStore.getState().setLevel("tabs");
    };
    // A status jump (Shift: backwards) or Back from `shown`, the tab showing in
    // the window the key was pressed in. The main window owns the lists and the
    // Back record (a popout asks, `runFromPopout`).
    const statusJump = (action: SteeringAction, shift: boolean, shown: StatusTab | null, asker?: string) => {
      const steering = useKeyboardSteeringStore.getState();
      const tabsByScope = useTabsStore.getState().tabsByScope;
      if (action === "jumpBack") {
        const target = jumpBackTarget(steering.jumpBack, shown, tabsByScope);
        if (!target) return;
        steering.setJumpBack(shown ? { origin: shown, landed: target } : null);
        goToTab(target, asker);
        return;
      }
      const status = STATUS_ACTIONS[action];
      if (!status) return;
      // Next (Shift: previous) tab needing an answer / working / finished, in
      // any project; steering follows it down to the tab level.
      const activity = useActivityStore.getState();
      const target = nextStatusTab(
        statusTabs(status, activity.busyByTab, activity.attentionByTab, tabsByScope),
        shown,
        shift ? -1 : 1,
      );
      if (!target) return;
      // Remember where the jump left from, for Back (and a digit's answer).
      steering.setJumpBack(afterStatusJump(steering.jumpBack, shown, target));
      goToTab(target, asker);
    };
    // The return after a digit answered the tab a jump landed on: only while
    // the Back record still names `shown` as where it landed.
    const returnFrom = (shown: StatusTab, asker?: string) => {
      const steering = useKeyboardSteeringStore.getState();
      const record = steering.jumpBack;
      if (!record || record.landed.scope !== shown.scope || record.landed.key !== shown.key) return;
      const target = jumpBackTarget(record, shown, useTabsStore.getState().tabsByScope);
      steering.setJumpBack(null);
      if (target) goToTab(target, asker);
    };
    // Main: a status jump, Back or answer-return a popout's key asked for.
    const runFromPopout = (request: DetachedSteerPayload, act: Extract<SteerAct, { kind: "action" }>) => {
      const shown = request.shown ?? null;
      if (act.auto) {
        if (shown) returnFrom(shown, request.label);
        return;
      }
      statusJump(act.action, act.shift, shown, request.label);
    };
    // Once the tab a status jump landed on stopped asking, back to the tab the
    // jump left — only while steering is still on the answered tab, so a user
    // who walked on meanwhile stays where they went. In a popout the main
    // window checks the Back record and moves.
    const returnAfterAnswer = (from: StatusTab) => {
      const steering = useKeyboardSteeringStore.getState();
      if (!steering.active || steering.level === "region") return;
      const shown = shownStatusTab();
      if (popout) {
        if (shown && shown.scope === from.scope && shown.key === from.key) {
          sendToMain({ kind: "action", action: "jumpBack", shift: false, auto: true });
        }
        return;
      }
      const record = steering.jumpBack;
      if (!shown || shown.scope !== from.scope || shown.key !== from.key) return;
      if (!record || record.landed.scope !== from.scope || record.landed.key !== from.key) return;
      const target = jumpBackTarget(record, shown, useTabsStore.getState().tabsByScope);
      steering.setJumpBack(null);
      if (target) goToTab(target);
    };
    // A digit on the active tab while it asks (`steeringAnswer`): the row by
    // that number, typed into the session straight away. False when the tab
    // asks nothing — the digit then opens agent N as before.
    const answerDigit = (e: KeyboardEvent, slot: number): boolean => {
      const active = steeringActiveTab();
      if (!active) return false;
      const steering = useKeyboardSteeringStore.getState();
      // Inside the terminal the pane may sit in tmux's copy mode, which would
      // eat the answer: out to the tabs first, which takes it back to live.
      if (steering.level === "scroll" && steeringTabAsks(active.scope, active.tab)) steering.setLevel("tabs");
      // A held digit would run on into the next question.
      if (e.repeat) return steeringTabAsks(active.scope, active.tab);
      const result = answerSteeringQuestion(active.scope, active.tab, slot);
      switch (result.kind) {
        case "none":
          return false;
        case "ignored":
          return true;
        case "freeTextField":
          // The Chat view's own field has the words: steering steps aside.
          exitSteering();
          return true;
        case "freeText":
          // Its words are typed in the terminal itself: steering steps aside.
          terminalFor(result.ptyId)?.focus();
          exitSteering();
          return true;
        case "answered": {
          const from = { scope: active.scope, key: active.tab.key };
          void result.typed
            .then(() => settleAfterAnswer(result.ptyId, result.agentLabel, result.signature))
            .then((state) => {
              if (state === "cleared") returnAfterAnswer(from);
            })
            .catch(() => {});
          return true;
        }
      }
    };

    // The view cycle's step: the active agent tab's Reader goes `dir` views on.
    function cycleActiveReaderView(dir: 1 | -1) {
      const pty = steeringActivePty();
      const target = pty ? readerViewFor(pty) : null;
      if (!target) return;
      const current = target.view();
      const next = cycleReaderView(current, target.offered(), dir);
      if (next !== current) target.show(next);
    }

    // The panes and tabs levels. With one subwindow there is nothing for ←/→
    // to walk between, so they step its tabs at once. Tab (Shift: back) steps
    // the tabs on both levels.
    function steerPanes(e: KeyboardEvent, action: SteeringAction | null, level: "panes" | "tabs" | "scroll") {
      const steering = useKeyboardSteeringStore.getState();
      const tabs = useTabsStore.getState();
      // The tabs steering walks: the workspace's, or Root's while the Root view
      // is up (`steeringScope`) — every group action below goes to that scope.
      const walked = steeringTabs();
      const { scope, layout, inRoot } = walked;
      const ids = allGroups(layout).map((g) => g.id);
      const walksPanes = level === "panes" && ids.length >= 2;
      const focused = walked.focusedGroupId;
      const group = focused ? findGroup(layout, focused) : null;

      // A digit on a tab that asks picks that row of its dialog (on every tab
      // level, inside its terminal too); elsewhere it opens agent N below.
      const slot = steeringSlot(action);
      if (slot !== null && answerDigit(e, slot)) return;

      // The Reader's view cycle (Tab, Shift+Tab backwards) on the active agent
      // tab, at every level but the projects: the level stays, Inside follows
      // the new view. A tab with no view strip swallows the key.
      // Only the bare key (Shift: back): Ctrl/Alt/Meta+Tab are the app's and
      // the desktop's tab chords, not a view step.
      if (action === "readerView") {
        if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) cycleActiveReaderView(e.shiftKey ? -1 : 1);
        return;
      }

      // Inside the active tab's terminal (its ↓): ←/→ scroll it half a screen
      // back / forward (Shift: a whole one), ↓ back to its live end, ↑ out to
      // the tabs — which takes it back to live too (the subscription at the
      // bottom). Of the tab keys, only Work here and the prompt box act.
      // A document tab (`documentScroll`) scrolls the same way, ↓ to its end
      // (not on a held key's repeats — the ↓ that stepped in would run on to
      // the end); it keeps its place when steering leaves.
      if (level === "scroll") {
        const pty = steeringActivePty();
        const doc = pty ? null : steeringActiveTab();
        // A Diffs / Files view shown in that tab's Reader answers first
        // (`lib/agents/readerSteering`): it walks its own items, the rest of
        // the keys fall through to the scroll below.
        const inside = pty && action ? readerInsideFor(pty) : null;
        if (inside && action) {
          const result = inside.key(action, e);
          if (result === "leave") {
            steering.setLevel("tabs");
            return;
          }
          if (result === "handled") return;
        }
        switch (action) {
          case "left":
          case "right": {
            const pages = (action === "right" ? 1 : -1) * (e.shiftKey ? 1 : 0.5);
            if (pty) scrollTerminal(pty, pages);
            else if (doc) scrollDocument(doc.scope, doc.tab.key, pages);
            return;
          }
          case "down":
            if (pty) scrollTerminalToLive(pty);
            else if (doc && !e.repeat) scrollDocumentToEnd(doc.scope, doc.tab.key);
            return;
          case "up":
            steering.setLevel("tabs");
            return;
          case "work":
          case "agentPrompt":
          case "queueSend":
          case "queuePull":
            break;
          default:
            return;
        }
      }

      // New tabs in the focused pane, the Ctrl+Shift+N / M / Ctrl+1–9 set
      // without the modifiers. Steering keeps the keyboard (walk on, Space
      // to prompt the new agent, or Enter to type). An agent number with nothing
      // behind it does nothing.
      if (slot !== null) {
        // In Root the request goes to Root's subwindow (`RootNewTabKeys`), the
        // same tab the console's + menu would open.
        requestNewTab({ kind: "agent", slot: slot - 1 }, BESIDE_ACTIVE);
        return;
      }
      switch (action) {
        case "up": {
          // One subwindow: the panes level would step the same tabs again.
          if (level === "tabs" && ids.length >= 2) {
            steering.setLevel("panes");
            return;
          }
          // A popout: above its tabs is its title bar (dock back, hide, the
          // window buttons); it has no projects level.
          if (popout) {
            if (regionRoot("chrome")) enterRegion("chrome");
            return;
          }
          // Root: above its tabs is the window's own chrome (view tabs, rail
          // toggle, bar buttons); the projects are one more up from there.
          if (inRoot && regionRoot("chrome")) {
            enterRegion("chrome");
            return;
          }
          steering.setLevel("projects");
          return;
        }
        // Work here — steering steps aside, focus stays where it was put.
        // (The mode opens on this level, so Escape climbing out through three
        // levels would be three presses to leave.)
        case "work":
          exitSteering();
          return;
        case "down":
          if (walksPanes) steering.setLevel("tabs");
          else if (steeringActivePty() || steeringActiveDocument()) steering.setLevel("scroll");
          return;
        case "left":
        case "right":
        case "nextTab": {
          const fwd = action === "nextTab" ? !e.shiftKey : action === "right";
          const neighbour = (id: string | null) => {
            const from = id ? ids.indexOf(id) : -1;
            const base = from >= 0 ? from : 0;
            return ids[(base + (fwd ? 1 : -1) + ids.length) % ids.length];
          };
          // A fullscreen subwindow hides the others: it moves along with the
          // focus, or the focus would land on one nobody can see.
          const carryFullscreen = (id: string) => {
            if (!inRoot && !popout && tabs.fullscreenGroupId && tabs.fullscreenGroupId !== id) tabs.toggleFullscreen(id);
          };
          // Shift+←/→ on the tabs level walks the subwindows too, without the
          // round trip up to the panes level and back down. Tab always steps
          // the tabs.
          const walk = level === "panes" ? walksPanes : e.shiftKey && ids.length >= 2;
          if (action !== "nextTab" && walk) {
            // Document order, wrapping, committed at once via focusGroup (no
            // Shift-preview: the badges re-anchor each step).
            const next = neighbour(focused);
            tabs.focusGroupInScope(scope, next);
            carryFullscreen(next);
          } else if (group) {
            const len = group.tabKeys.length;
            const cur = group.activeKey ? group.tabKeys.indexOf(group.activeKey) : 0;
            const step = cur + (fwd ? 1 : -1);
            if (ids.length >= 2 && (step < 0 || step >= len)) {
              // Past the subwindow's last (first) tab the keys walk on into
              // the next (previous) subwindow's first (last) tab, so every tab
              // is a run of presses away; the last tab of all wraps to the first.
              const next = neighbour(group.id);
              const nextGroup = findGroup(layout, next);
              const key = nextGroup?.tabKeys[fwd ? 0 : nextGroup.tabKeys.length - 1];
              if (key) tabs.setGroupActiveInScope(scope, next, key);
              else tabs.focusGroupInScope(scope, next);
              carryFullscreen(next);
            } else if (len > 1) {
              tabs.setGroupActiveInScope(scope, group.id, group.tabKeys[(step + len) % len]);
            }
          }
          return;
        }
        case "newTabMenu":
          // The whole + menu, walked with the region cursor.
          if (requestNewTab({ kind: "menu" }, BESIDE_ACTIVE)) enterRegion("addTab");
          return;
        case "newShell":
          requestNewTab({ kind: "shell" }, BESIDE_ACTIVE);
          return;
        case "newMonitor":
          requestNewTab({ kind: "monitor" }, BESIDE_ACTIVE);
          return;
        case "files": // toggle the focused subwindow's docked file viewer
          if (focused && group) tabs.setGroupFilesInScope(scope, focused, !group.filesOpen);
          return;
        // Asked first (`steeringConfirm`): the box comes up as the overlay
        // region, the Confirm key (or W again) closes, Esc keeps the tab.
        case "closeTab": {
          const active = steeringActiveTab();
          if (active) requestSteeringConfirm("closeTab", active.scope, active.tab);
          return;
        }
        // The card over the active tab's terminal (Undo clear after K, a
        // sign-in link): its buttons under the region cursor.
        case "tabCard":
          if (activeTabCard()) enterRegion("card");
          return;
        // The agent tab's subagents: its Subagents list opened under the
        // cursor (Enter opens one in the Chat), or an open one's bar.
        case "subagents": {
          const frame = activeSubagentFrame();
          if (!frame) return;
          if (!openSubagentList(frame)) {
            enterRegion("subagents");
            return;
          }
          // The list draws after this key: the cursor lands on it then, not
          // on the toggle it would find now.
          clearRegionCursor();
          useKeyboardSteeringStore.getState().enterRegion("subagents");
          cancelPlace();
          placeTimer = window.setTimeout(() => {
            placeTimer = null;
            const s = useKeyboardSteeringStore.getState();
            if (s.active && s.region === "subagents") placeCursorSoon("subagents");
          }, 0);
          return;
        }
        case "menu": {
          // The active tab's right-click menu (rename, colour, split, …).
          const tab = activeTabElement();
          if (tab) openContextMenu(tab);
          return;
        }
        // A text box over the window for the active agent tab; Enter sends it
        // and steering comes back on this level (the box re-enters it).
        case "agentPrompt": {
          const active = steeringActiveTab();
          if (active && requestSteeringPrompt(active.scope, active.tab, level)) handOffSteering("prompt");
          return;
        }
        // The Chat's queued prompts: Send now (Esc / the CLI's queue move)
        // and Cancel and edit (back into the text box, where Enter re-sends).
        case "queueSend":
        case "queuePull": {
          const active = steeringActiveTab();
          const moves = active ? queueMovesFor(`${active.scope}:${active.tab.key}`) : null;
          if (!moves || e.repeat) return;
          if (action === "queueSend") moves.send();
          else {
            moves.pull();
            exitSteering();
          }
          return;
        }
      }
      steerCommon(e, action);
    }

    // The keys every tab-bar level shares.
    function steerCommon(e: KeyboardEvent, action: SteeringAction | null) {
      // A popout does not run a key whose target is the main window's, or one
      // that crosses windows: it hands it to the main window, which runs it
      // there (J: the next popout, or the main window after the last one).
      if (popout && action && POPOUT_HANDS_OVER.has(action)) {
        sendToMain({ kind: "action", action, shift: e.shiftKey });
        return;
      }
      // The status jumps, and Back to the tab they left (again: back to this
      // one), from the tab showing here.
      if (action && (STATUS_ACTIONS[action] || action === "jumpBack")) {
        statusJump(action, e.shiftKey, shownStatusTab());
        return;
      }
      switch (action) {
        case "mail":
        case "calendar":
        case "todo":
          openApp(action);
          return;
        // The cockpit: not one of the three walked apps, so the region is the
        // generic overlay one, which walks whatever is on top.
        case "cockpit":
          useRootOverlayStore.getState().openView("now");
          enterRegion("cockpit");
          return;
        case "sidePanel":
          openSidePanel();
          return;
        // The project's popped-out subwindow (the next one, with several): its
        // window takes the keyboard and is asked to take steering too. This
        // window keeps steering until that one announces itself
        // (`STEERING_OWNER`), so a refused focus move leaves it here.
        case "popout": {
          const visit = useKeyboardSteeringStore.getState().visit;
          const scope = steeringTabs().scope;
          const before = useKeyboardSteeringStore.getState();
          const tab = steeringTabsActive()?.tab.key;
          const group = steeringTabs().focusedGroupId;
          const view = useRootOverlayStore.getState().view;
          void focusNextPopout(scope).then((label) => {
            const now = useKeyboardSteeringStore.getState();
            if (label && now.active && now.visit === visit && steeringTabs().scope === scope &&
                now.level === before.level && now.region === before.region &&
                steeringTabsActive()?.tab.key === tab && steeringTabs().focusedGroupId === group &&
                useRootOverlayStore.getState().view === view) {
              sendSteer(detachedSteerEvent(label), { act: { kind: "enter" } } satisfies DetachedSteerRequest);
            }
          });
          return;
        }
        case "panels": // toggle the side panels
          onTogglePanels?.();
          return;
        // Open settings — same door the header ⚙ menu fires — and walk it:
        // ←/→ its pages, ↑/↓ the page's controls, Escape closes it.
        case "settings":
          window.dispatchEvent(new CustomEvent("app:open-settings", { detail: "main" }));
          enterRegion("settings");
          return;
        // The jump box (`SteeringProjectJump`): a project's name, or its digit
        // on the ring; the pick (or Escape) brings steering back on this level.
        case "jumpProject": {
          const level = useKeyboardSteeringStore.getState().level;
          if (level !== "region" && requestProjectJump(level)) handOffSteering("jump");
          return;
        }
        // Anything else: swallowed, mode stays on.
      }
    }

    // The region cursor: ↑/↓ walk the surface's controls, Enter presses one
    // (Esc backs out of it; on the tab-bar levels Esc leaves the mode).
    let cockpitBackwards = false;
    function steerRegion(action: SteeringAction | null, region: SteeringRegion) {
      const root = regionRoot(region);
      if (action === "back") {
        if (region === "addTab" && root && closeAddTabSubmenu(root)) return;
        // An open dropdown list closes first; the next Back leaves.
        if (root && closeRegionDropdown(root)) return;
        // A dialog or menu closes the way its own Escape closes it (it may
        // ask first); steering follows once it is gone (`syncLayer`).
        if (region === "cockpit" && root) {
          const back = root.querySelector<HTMLButtonElement>(".cockpit-narrow-back button");
          if (back) { back.click(); placeCursorSoon("cockpit"); }
          else { useRootOverlayStore.getState().close(); returnFromRegion(); }
        } else if (region === "overlay" && root) dismissLayer(root, () => syncSoon());
        else leaveRegion(region);
        return;
      }
      if (!root) {
        // Closed under the cursor (the pointer, the surface's own ×).
        if (region === "overlay") syncLayer();
        else leaveRegion(region);
        return;
      }
      if (region === "cockpit") {
        if (action === "cockpitPanel") { stepCockpitArea(root, cockpitBackwards); return; }
        if (inCockpitRoster() && action && ["up", "down", "cockpitUp", "cockpitDown", "cockpitJump", "cockpitShow", "cockpitContinue", "cockpitFilter"].includes(action)) {
          const mapped = action === "up" ? "cockpitUp" : action === "down" ? "cockpitDown" : action;
          const selected = runCockpitRoster(mapped);
          if (mapped === "cockpitFilter") handOffSteering("search");
          else if (mapped === "cockpitJump") syncLayer();
          else if (mapped === "cockpitShow") {
            window.setTimeout(() => {
              const detail = regionRoot("cockpit")?.querySelector<HTMLElement>(".cockpit-now-detail");
              if (detail && useKeyboardSteeringStore.getState().active) placeRegionCursor(detail);
            }, 0);
          } else {
            selectCockpitCursor(root, selected || undefined);
            window.setTimeout(() => {
              if (useKeyboardSteeringStore.getState().active && inCockpitRoster()) selectCockpitCursor(root, selected || undefined);
            }, 0);
          }
          return;
        }
      }
      switch (action) {
        case "up":
        case "down": {
          cancelPlace();
          const delta = action === "down" ? 1 : -1;
          if (region === "header") {
            // One row of buttons: ←/→ walk it, ↓ drops the menu of the one
            // under the cursor — or, on a plain button, goes back down.
            if (action === "down" && !openCursorPopup()) leaveRegion(region);
            return;
          }
          if (region === "chrome") {
            // The root window's bar, the same shape: ↓ drops a menu or goes
            // back down to Root's tabs; ↑ goes on up to the projects. Above a
            // popout's title bar is the main window: ↑ hands the keyboard over.
            if (action === "up") {
              if (popout) {
                sendToMain({ kind: "enter" });
                return;
              }
              clearRegionCursor();
              useKeyboardSteeringStore.getState().setLevel("projects");
            } else if (!openCursorPopup()) leaveRegion(region);
            return;
          }
          if (region === "overlay") {
            // Nothing to press but text to read (the cheat sheet): scroll it.
            if (!regionHasControls(root) && scrollRegion(root, delta)) return;
            // Rows of fields with their buttons beside them, a menu's items:
            // ↑/↓ row to row, ←/→ along the row.
            moveRegionCursorByLine(root, delta);
            return;
          }
          // Mail's rows carry their own buttons and sit under toolbars: ↑/↓
          // go row to row there, ←/→ through what is on the row.
          (region === "mail" ? moveRegionCursorByLine : moveRegionCursor)(root, delta);
          return;
        }
        // The right-click menu of the control under the cursor (a file, a
        // message, an event); it opens as the overlay on top.
        case "menu": {
          const el = regionCursor();
          if (el) openContextMenu(el);
          return;
        }
        case "left":
        case "right": {
          cancelPlace();
          const delta = action === "right" ? 1 : -1;
          if (region === "settings") {
            if (stepSettingsPage(delta)) {
              clearRegionCursor();
              // The click re-renders the page after this key; land on the new one.
              placeTimer = window.setTimeout(() => {
                placeTimer = null;
                placeCursorSoon("settings");
              }, 0);
            }
          } else {
            moveRegionCursor(root, delta);
          }
          return;
        }
        // Type into the surface's search field (the + menu's filter). It never
        // takes the keyboard by itself: E S D F keep steering until asked.
        case "search":
          // Settings: the dialog's own search box, above the left-hand list.
          // Esc in it comes back here (`onSteeringKeyDown`); the legend says so.
          if (focusRegionSearch(region === "settings" ? (settingsDialog() ?? root) : root)) {
            handOffSteering("search");
            const field = document.activeElement;
            // Gone some other way (a click, a pick that moved focus on):
            // nothing waits to come back.
            field?.addEventListener(
              "blur",
              () => {
                if (useKeyboardSteeringStore.getState().handedTo === "search") {
                  useKeyboardSteeringStore.getState().dropHandoff();
                }
              },
              { once: true },
            );
          }
          return;
        // Steering's own "are you sure" (W, K): yes, whatever the cursor is on.
        // The box closes and `syncSoon` takes steering back down.
        case "confirm":
          steeringConfirmButton(root)?.click();
          return;
        case "press": {
          const done = activateRegionCursor();
          if (done === "type") {
            exitSteering();
          } else if (done === "press") {
            // What the press opened (a dialog, a menu) takes the cursor. A pick
            // that closed the surface: a + menu row has opened its tab, which
            // now has the keyboard; anything else goes back a level.
            syncSoon(() => {
              const s = useKeyboardSteeringStore.getState();
              if (!s.active || s.region !== region) return;
              // A subagent picked from the list: its bar now holds the cursor.
              if (region === "subagents" && regionRoot(region)) {
                if (!regionCursor()) placeCursorSoon(region);
                return;
              }
              if (regionRoot(region)) return;
              if (region === "addTab") exitSteering();
              else returnFromRegion();
            });
          }
          return;
        }
      }
    }

    function onSteeringKeyDown(e: KeyboardEvent) {
      // Steering's own Escape to a dialog, ↓ to a menu button: theirs.
      if (isSteeringSynthetic(e)) return;
      const steering = useKeyboardSteeringStore.getState();
      // Esc in a surface's search field steering handed the keyboard to:
      // back to steering on that surface, the cursor on its first control.
      // Ahead of the modal check — the + menu and settings are dialogs too.
      if (!steering.active && steering.handedTo === "search" && e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        steering.resume();
        (document.activeElement as HTMLElement | null)?.blur();
        const { region } = useKeyboardSteeringStore.getState();
        if (region) placeCursorSoon(region);
        return;
      }
      // A dialog's keys are its own: the app's chords wait until it closes.
      // Steering is the exception — it walks the dialog (`syncLayer`).
      const modalUp = hasActiveModal();
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;

      // The chord toggles: enter when inactive, exit when active (not in a
      // typing burst, `steeringChordFires`).
      if (steeringChordFires(resolveChord("steeringMode", overrides), e, steering.active, lastTypedAt)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        else enterSteering();
        return;
      }
      // The root console toggles from anywhere, a focused terminal included —
      // and from inside steering mode, which it leaves (two modes owning the
      // keyboard at once is one too many). Not from behind a dialog, nor are
      // the chords below. A popout has no root console.
      if (!popout && !modalUp && chordMatches(resolveChord("rootConsole", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        toggleRootConsole();
        return;
      }
      if (!popout && !modalUp && chordMatches(resolveChord("projectShell", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        openProjectShellInRootConsole();
        return;
      }
      // A new tab in the focused pane, keyboard focus and all — from a focused
      // terminal too, which is where the hands are when the next one is
      // wanted. It lands in the workspace, so the root console steps aside.
      // An agent number with no agent behind it passes the key on.
      // While a mail / calendar / to-do view is shown, an agent number goes
      // to it instead: it docks that root agent beside the app, where a
      // workspace tab would open hidden under the window. Unanswered, the key
      // passes on too — never into that hidden tab. The window stays either
      // way, so the docked column shows.
      const newTab = modalUp ? null : newTabRequestFor(e, overrides);
      const overlayApp = newTab?.kind === "agent" ? shownApp() : null;
      const toRoot = !overlayApp && steeringInRoot();
      if (
        newTab &&
        (overlayApp && newTab.kind === "agent"
          ? requestOverlayAgent(overlayApp, newTab.slot)
          : requestNewTab(newTab))
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        // The chord went to Root's subwindow while the Root view is up
        // (`RootNewTabKeys`), or docked an agent in the shown app's column
        // (`overlayApp`), so the window stays; otherwise the tab is the
        // workspace's and the console steps aside.
        const overlay = useRootOverlayStore.getState();
        if (overlay.open && !toRoot && !overlayApp) overlay.close();
        return;
      }
      // Reopen the last agent tab closed in this scope — from a focused
      // terminal too, since the tab it lands in after a close is usually one.
      // With nothing to reopen the key goes on to wherever it was typed. A
      // popout asks the main window itself (`DetachedApp`, DETACHED_REOPEN).
      if (!popout && !modalUp && chordMatches(resolveChord("reopenClosedTab", overrides), e)) {
        if (reopenClosedAgentTab(useTabsStore.getState().scope)) {
          e.preventDefault();
          e.stopPropagation();
          if (steering.active) exitSteering();
          return;
        }
      }
      if (!steering.active) {
        if (isTextKey(e)) lastTypedAt = e.timeStamp;
        return;
      }

      // Lone modifiers pass through unswallowed so a Shift+key still composes.
      if (isLoneModifier(e.key)) return;

      // The mode owns the keyboard: every non-modifier key below — mapped or
      // not — is swallowed here, so nothing ever leaks to the app underneath.
      e.preventDefault();
      e.stopPropagation();

      // A dialog or menu that came up since the last key (or went away) moves
      // steering before the key is read; after it, whatever the key opened.
      // An arrow that met a dialog nobody announced only lands the cursor on
      // it: the legend still showed the level behind when the key was pressed.
      if (staleRepeat(e)) return;
      const landed = syncLayer();
      steerKey(e, landed);
      syncSoon();
      stepTaken();
    }

    // A press of the real pointer while steering is on: navigation starts over
    // from where it landed. Inside the surface the cursor walks, the cursor
    // goes to what was pressed; anywhere else — a project pill, a tab, a
    // terminal — the region and everything stacked under it is dropped, and
    // steering is back on the tabs (of the project the press switches to). A
    // dialog or menu still up afterwards takes it again (`syncSoon`).
    function onSteeringPointerDown(e: PointerEvent) {
      if (isSteeringSynthetic(e)) return;
      const steering = useKeyboardSteeringStore.getState();
      if (!steering.active) return;
      const target = e.target instanceof Element ? e.target : null;
      // The legend's own fold button is steering's, not a place to go.
      if (!target || target.closest(".steering-bar")) return;
      cancelPlace();
      const region = steering.level === "region" ? steering.region : null;
      const root = region ? regionRoot(region) : null;
      // A project pill is never under the top bar's cursor: a press on one
      // starts over on that project's tabs.
      if (root?.contains(target) && !target.closest(".project-pill, .box-chip")) {
        pointRegionCursor(root, target);
        return;
      }
      clearRegionCursor();
      dropOverlay();
      panelOpenedBySteering = false;
      steering.setLevel("tabs");
      const side = regionRoot("side");
      if (side?.contains(target)) {
        enterRegion("side");
        pointRegionCursor(side, target);
      }
      syncSoon(() => {
        const s = useKeyboardSteeringStore.getState();
        const back = s.active && s.level === "region" && s.region ? regionRoot(s.region) : null;
        if (back?.contains(target)) pointRegionCursor(back, target);
      });
    }

    function steerKey(e: KeyboardEvent, landed: boolean) {
      const steering = useKeyboardSteeringStore.getState();
      // The key's meaning on this level, from the user's steering bindings.
      const context: SteeringKeyContext =
        steering.level === "region"
          ? steering.region === "cockpit" && inCockpitRoster() ? "cockpit" : "region"
          : steering.level === "projects"
            ? "projects"
            : steering.level === "scroll"
              ? "inside"
              : "panes";
      const bindings = useSettingsStore.getState().settings?.steering_keys as SteeringKeyMap | undefined;
      const action = steeringActionFor(e, context, bindings);

      // The shortcut cheat sheet, from every level (its host listens for the
      // event): ↑/↓ scroll it, Escape closes it.
      if (action === "help") {
        window.dispatchEvent(new Event("app:open-shortcut-help"));
        return;
      }
      // Esc (by default) leaves the mode from the tab-bar levels; a region
      // never resolves it (its Esc is Back).
      if (action === "exit") {
        exitSteering();
        return;
      }
      // H (by default) folds the key list into the corner badge and back; the
      // mode itself stays on.
      if (action === "legend") {
        steering.toggleLegend();
        return;
      }
      switch (steering.level) {
        case "projects":
          steerProjects(e, action);
          return;
        case "panes":
        case "tabs":
        case "scroll":
          steerPanes(e, action, steering.level);
          return;
        case "region": {
          const region = steering.region;
          if (!region) {
            steering.setLevel(steering.regionReturn);
            return;
          }
          if (landed && (action === "up" || action === "down" || action === "left" || action === "right")) return;
          cockpitBackwards = e.shiftKey;
          if (region === "cockpit" && steeringKeyIs(e, "cockpitPanel", bindings)) { steerRegion("cockpitPanel", region); return; }
          if (region === "side" && steerSidePanel(e, action, bindings, sidePanelHooks)) return;
          // The key that opened the side panel leaves it again, as Back does.
          const sideBack = !action && region === "side" && steeringKeyIs(e, "sidePanel", bindings);
          // W over its own "Close tab?" box closes: W twice closes a tab.
          const root = region === "overlay" && !action ? regionRoot(region) : null;
          const closeAgain =
            !!root && steeringKeyIs(e, "closeTab", bindings) && !!steeringConfirmButtonFor(root, "closeTab");
          steerRegion(sideBack ? "back" : closeAgain ? "confirm" : action, region);
          return;
        }
      }
    }

    function onBlur() {
      // Steering survives a short blur (a desktop screenshot taken with Enter,
      // a notification): `onFocus` ends it only after a long absence.
      steeringBlurredAt = useKeyboardSteeringStore.getState().active ? Date.now() : null;
    }
    function onFocus() {
      const away = steeringBlurredAt === null ? 0 : Date.now() - steeringBlurredAt;
      steeringBlurredAt = null;
      if (away > STEERING_BLUR_GRACE_MS && useKeyboardSteeringStore.getState().active) exitSteering();
    }

    // A terminal steering scrolled goes back to its live end the moment
    // steering is no longer inside it (↑, Space, a status jump, a blur…) —
    // scrolled up, tmux's copy mode would take the next keys typed into it.
    const unsubscribeScroll = useKeyboardSteeringStore.subscribe((s) => {
      if (!s.active || s.level !== "scroll") releaseTerminalScroll();
    });
    // While steering is on, a dialog or menu coming or going — raised by the
    // app itself (a host-key prompt), closed by its own timer or the pointer —
    // moves steering (and so the legend) at once, not at the next key. Only
    // mounts and unmounts count; nothing is watched while steering is off.
    const layerWatch =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (useKeyboardSteeringStore.getState().active) syncLayer();
          });
    let watching = false;
    const watchLayers = (on: boolean) => {
      if (!layerWatch || on === watching) return;
      watching = on;
      if (on) layerWatch.observe(document.body, { childList: true, subtree: true });
      else layerWatch.disconnect();
    };
    watchLayers(useKeyboardSteeringStore.getState().active);
    const unsubscribeLayers = useKeyboardSteeringStore.subscribe((s) => watchLayers(s.active));

    document.addEventListener("keydown", onSteeringKeyDown, true);
    document.addEventListener("pointerdown", onSteeringPointerDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    if (!popout) window.addEventListener(STEER_FROM_POPOUT, onSteerFromPopout);
    const unlistenOwner = subscribeTauri(() =>
      listen<{ label: string }>(STEERING_OWNER, (ev) => onOwner(ev.payload.label)),
    );
    // A popout is asked by the main window (its J, a status jump) to steer.
    const unlistenRequest = popout
      ? subscribeTauri(() =>
          listen<DetachedSteerRequest>(detachedSteerEvent(myLabel), (ev) => whenFocused(() => arrive(ev.payload.act))),
        )
      : () => {};
    // The status counts and Back for a popout's bar: the main window counts
    // (`STEERING_STATUS`) on change while any popout is open, and once more
    // whenever a popout starts steering; the popout shows what it is told.
    const unlistenStatus = popout
      ? subscribeTauri(() =>
          listen<PopoutSteeringStatus>(STEERING_STATUS, (ev) => usePopoutViewStore.getState().setStatus(ev.payload)),
        )
      : () => {};
    const unsubscribeStatus = popout
      ? () => {}
      : (() => {
          const subs = [
            useActivityStore.subscribe((s, prev) => {
              if (s.busyByTab !== prev.busyByTab || s.attentionByTab !== prev.attentionByTab) publishStatus();
            }),
            useTabsStore.subscribe((s, prev) => {
              if (s.tabsByScope !== prev.tabsByScope || s.detachedGroupsByScope !== prev.detachedGroupsByScope) publishStatus();
            }),
            useKeyboardSteeringStore.subscribe((s, prev) => {
              if (s.jumpBack !== prev.jumpBack) publishStatus();
            }),
          ];
          return () => subs.forEach((un) => un());
        })();
    return () => {
      cancelArrival();
      unlistenOwner();
      unlistenRequest();
      unlistenStatus();
      unsubscribeStatus();
      cancelPlace();
      for (const id of syncTimers) window.clearTimeout(id);
      unsubscribeScroll();
      unsubscribeLayers();
      watchLayers(false);
      document.removeEventListener("keydown", onSteeringKeyDown, true);
      document.removeEventListener("pointerdown", onSteeringPointerDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(STEER_FROM_POPOUT, onSteerFromPopout);
    };
  }, [surface, onTogglePanels, onSidePanel]);
}

/** Steering's status jumps and the tab state each walks. */
const STATUS_ACTIONS: Partial<Record<SteeringAction, TabStatusKind>> = {
  nextDecision: "decision",
  nextWorking: "working",
  nextDone: "done",
};

/**
 * Cycle the active scope to the next one (by display order).
 *
 * The **root terminal is a station in the cycle**, not a hole in it: it is the
 * pill strip's first pill, so a shortcut that walks the strip has to stop there
 * too. It was skipped, and worse than skipped — cycling *out* of the root scope
 * worked (no pill matches a `null` activeId, so `-1 + 1` landed on the first
 * project) while cycling *back into* it was impossible, making the shortcut a
 * one-way door out of the root terminal.
 *
 * `null` leads the ring for the same reason the pill is pinned to the left edge.
 *
 * The ring itself lives in `stores/keyboardSteering.projectStations` — the
 * steering digits and pill badges number the same list, so the three surfaces
 * can never disagree about which project is station N. While a box slice is
 * selected that list is the slice's visible pills (members, inactive ones
 * included), so the chord walks what the strip shows; unsliced it skips the
 * projects hidden from the All-projects row (`barHidden`). From a box's own scope
 * (no project in the ring is current) the first step lands on the first / last
 * visible pill.
 */
export function cycleProject(delta: 1 | -1): Promise<unknown> | null {
  const ps = useProjectsStore.getState();
  const stations = projectStations();
  if (stations.length < 2) return null;
  // The root station is the Root VIEW: while the window shows it, that is
  // where the ring stands, whatever project the workspace behind it is on.
  const here = rootViewShown(useRootOverlayStore.getState()) ? null : ps.activeId;
  const idx = stations.indexOf(here);
  const next =
    idx < 0 && stations.length > 1
      ? stations[delta > 0 ? 1 : stations.length - 1]
      : stations[(idx + delta + stations.length) % stations.length];
  return next !== here ? landOnStation(next) : null;
}

/**
 * Land on one station of the project ring. A project switches the workspace to
 * it (and a Root view that was up steps aside, so the project is what shows).
 * The **root station opens the Root view** and nothing else: the workspace
 * stays on its project (`setActive(null)` used to switch the whole workspace to
 * the root scope, which cost the project you were in).
 */
export function landOnStation(target: string | null): Promise<unknown> {
  if (target === null) {
    useRootOverlayStore.getState().show();
    return Promise.resolve();
  }
  const ps = useProjectsStore.getState();
  const overlay = useRootOverlayStore.getState();
  if (rootViewShown(overlay)) overlay.close();
  return target !== ps.activeId ? ps.setActive(target) : Promise.resolve();
}
