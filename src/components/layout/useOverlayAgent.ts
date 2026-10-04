import { useCallback, useEffect, useRef, useState } from "react";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { addTabToRoot } from "../../stores/rootOverlay";
import {
  dockedRootTab,
  useOverlayAgentStore,
  type OverlayAgentDock,
} from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { OVERLAY_AGENT_EVENT, type OverlayAgentDetail } from "../../lib/shortcuts/newTabChord";
import type { SteeringApp } from "../../lib/shortcuts/steeringRegion";
import { onTerminalExit, onTerminalReady } from "../../lib/terminal/terminalBus";
import { useT } from "../../lib/i18n";
import { AGENT_ITEMS, agentShortcutSlots, buildStaticTabSpec } from "../tabs/newTabItems";
import { useAddTabMenuData } from "../tabs/useAddTabMenuData";

// ── Has a docked tab's program exited? ─────────────────────────────────────
// An exited agent's tab stays in root (its pane prints `[process exited]`), so
// the dock store keeps it docked. The reuse rule must not put that corpse back
// on screen for a Ctrl+N, so every docked key watches its PTY's exit — from the
// moment it docks, whether or not an overlay is mounted when the program ends.
// A respawn of the same PTY (`terminal-ready`) makes it live again.
const exitedKeys = new Set<string>();
const exitWatches = new Map<string, () => void>();
// The + menu row (`AgentShortcutSlot.key`: a built-in's cmd, or `custom:<id>`)
// each docked tab was opened from. The reuse rule compares rows, not commands:
// a custom agent may run the same binary as a built-in with its own args.
const dockedRows = new Map<string, string>();

function watchDockedExit(key: string) {
  if (exitWatches.has(key)) return;
  const ptyId = `${ROOT_SCOPE}:${key}`;
  const offExit = onTerminalExit(ptyId, () => exitedKeys.add(key));
  const offReady = onTerminalReady(ptyId, () => exitedKeys.delete(key));
  exitWatches.set(key, () => {
    offExit();
    offReady();
  });
}

/** Drop the watches of keys no overlay docks any more. */
function pruneExitWatches() {
  const docked = new Set(
    Object.values(useOverlayAgentStore.getState().docks).map((d) => d.key),
  );
  for (const [key, off] of exitWatches) {
    if (docked.has(key)) continue;
    off();
    exitWatches.delete(key);
    exitedKeys.delete(key);
    dockedRows.delete(key);
  }
}

/** The docked tab `key`'s program has exited (and not been respawned). */
export function dockedTabExited(key: string): boolean {
  return exitedKeys.has(key);
}

export function __resetOverlayAgentExitWatchForTests(): void {
  for (const off of exitWatches.values()) off();
  exitWatches.clear();
  exitedKeys.clear();
  dockedRows.clear();
}

/** What an overlay needs from {@link useOverlayAgent}. */
export interface OverlayAgentHandle {
  /** This overlay's dock record (`stores/overlayAgent`). */
  dock: OverlayAgentDock;
  /** The docked root tab, open column or not; `null` when nothing is docked. */
  tab: TabEntry | null;
  /** Ctrl+1 found no root-allowed default agent: what the column says instead. */
  hint: string | null;
  /** Bumped each time a chord (or `toggle`) puts a tab in the column — the
   *  column takes the keyboard again even when it was already showing it. */
  focusRequest: number;
  /** The column should render: a docked tab with the column open, or the hint. */
  showColumn: boolean;
  /** The title-bar button: hides an open column; otherwise re-shows a live
   *  docked tab, else does what Ctrl+1 does. Dismisses a showing hint. */
  toggle: () => void;
  /** The column's × with no tab in it: forget the hint. */
  dismissHint: () => void;
}

/**
 * The docked agent of the mail / calendar / to-do overlay `app`: the overlay
 * mounts it, and while `live` (the overlay is up) it answers Ctrl+1–9
 * (`OVERLAY_AGENT_EVENT`) addressed to `app` by docking that slot's agent — a
 * ROOT tab, the only kind handed Tabtivity's own MCP tools — in a column beside
 * the app (`OverlayAgentColumn`). See `docs/overlay_agent_plan.md`.
 *
 * - The numbers are the root console's own + menu's (`useAddTabMenuData(ROOT_SCOPE)`
 *   → `agentShortcutSlots`, the inputs `TabBar` passes), so only root-allowed
 *   agents are offered, and the tab is built as that menu builds it.
 * - One docked agent per overlay: with the column closed, the same agent still
 *   running is shown again; anything else mints a new root tab, and the one it
 *   replaces keeps running in the root console.
 * - Ctrl+1 with no root-allowed default agent is still answered — with a hint
 *   naming the switch — rather than passing the key on. Any other number with
 *   no agent behind it passes on.
 *
 * The agent probes run only while `live` (the mail overlay stays mounted when
 * hidden). A chord that beats the first probe is held and run when it lands —
 * one at a time, dropped if the overlay goes first. Its key is swallowed even
 * if its number then turns out empty: the answer has to be given while the
 * event is dispatched.
 */
export function useOverlayAgent(app: SteeringApp, live: boolean): OverlayAgentHandle {
  const t = useT();
  const { enabledAgents, installedCustom, customAgents, defaultAgentBin, agentOrder } =
    useAddTabMenuData(ROOT_SCOPE, { active: live });
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const dock = useOverlayAgentStore((s) => s.docks[app]);
  const tab = useTabsStore((s) =>
    dock.key ? (s.tabsByScope[ROOT_SCOPE]?.find((x) => x.key === dock.key) ?? null) : null,
  );
  // The agent the hint names (`null` = no hint).
  const [hintAgent, setHintAgent] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  // A chord that arrived before the agent probe answered.
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);

  /** Answer agent number `slot`; false = not ours, let the key go on. */
  const runSlot = useRef<(slot: number) => boolean>(() => false);
  runSlot.current = (slot) => {
    if (enabledAgents === null) {
      // Not probed yet: hold it rather than guess "not allowed".
      setPendingSlot(slot);
      return true;
    }
    const row = agentShortcutSlots({
      installedBuiltins: enabledAgents,
      installedCmds: installedCustom,
      customAgents,
      defaultAgentBin,
      agentOrder,
    })[slot];
    if (!row) {
      if (slot !== 0) return false;
      setHintAgent(
        AGENT_ITEMS.find((a) => a.cmd === defaultAgentBin)?.label ??
          customAgents.find((a) => a.cmd === defaultAgentBin)?.label ??
          defaultAgentBin,
      );
      return true;
    }
    setHintAgent(null);
    setFocusRequest((n) => n + 1);
    const store = useOverlayAgentStore.getState();
    const docked = dockedRootTab(app);
    if (
      !store.docks[app].open &&
      docked &&
      dockedRows.get(docked.key) === row.key &&
      !dockedTabExited(docked.key)
    ) {
      store.reopen(app);
      return true;
    }
    addTabToRoot(buildStaticTabSpec(row.item, rootDir, "", t), (opened) => {
      useOverlayAgentStore.getState().dock(app, opened.key);
      dockedRows.set(opened.key, row.key);
      watchDockedExit(opened.key);
      pruneExitWatches();
    });
    return true;
  };

  // A held chord runs once the probe lands — unless the overlay went away.
  useEffect(() => {
    if (pendingSlot === null || enabledAgents === null) return;
    setPendingSlot(null);
    if (live) runSlot.current(pendingSlot);
  }, [pendingSlot, enabledAgents, live]);

  useEffect(() => {
    if (!live) {
      setHintAgent(null);
      setPendingSlot(null);
      return;
    }
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<OverlayAgentDetail>).detail;
      if (detail.app !== app) return;
      if (runSlot.current(detail.slot)) e.preventDefault();
    };
    window.addEventListener(OVERLAY_AGENT_EVENT, onRequest);
    return () => window.removeEventListener(OVERLAY_AGENT_EVENT, onRequest);
  }, [app, live]);

  const toggle = useCallback(() => {
    const store = useOverlayAgentStore.getState();
    if (store.docks[app].open) {
      store.hide(app);
      setHintAgent(null);
      return;
    }
    if (hintAgent !== null) {
      setHintAgent(null);
      return;
    }
    const docked = dockedRootTab(app);
    if (docked && !dockedTabExited(docked.key)) {
      store.reopen(app);
      setFocusRequest((n) => n + 1);
      return;
    }
    runSlot.current(0);
  }, [app, hintAgent]);

  const dismissHint = useCallback(() => setHintAgent(null), []);

  const hint = hintAgent === null ? null : t("overlayAgent.rootNotAllowed", { agent: hintAgent });
  return {
    dock,
    tab,
    hint,
    focusRequest,
    showColumn: (dock.open && tab !== null) || hint !== null,
    toggle,
    dismissHint,
  };
}
