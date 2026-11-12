/**
 * What one steering key costs in a popout ("steering navigation in a popped out
 * window is incredibly slow"), counted on a real `DetachedApp` against a real
 * main-window host on the two-heap harness.
 *
 * A popout renders from a tree and tab list the main window streams. A tab
 * switch there is an edit the popout applies at once, sends to the main window
 * (`DETACHED_EDIT`) and — before this was fixed — got back as a reseed 150 ms
 * later: a full copy of every tab payload, which re-rendered every pane of the
 * popout, re-subscribed its schedules listener and re-measured the legend. The
 * main window's own key is one store write. These cases pin that a key costs
 * the popout one edit and nothing that comes back, and no more legend work than
 * the main window's key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";

import { loadHeap, resetTabs, type Heap } from "../helpers/detachedHarness";

const shared = vi.hoisted(() => ({
  handlers: new Map<string, Set<(ev: { payload: unknown }) => void>>(),
  emitted: [] as Array<{ event: string; payload: unknown }>,
  listens: [] as string[],
  paneRenders: {} as Record<string, number>,
  capMeasures: 0,
  rects: 0,
  legendRenders: 0,
  panelRenders: 0,
  label: "",
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === "get_settings" ? {} : undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => {
    shared.emitted.push({ event, payload });
    // Tauri serialises a payload: the receiver never shares objects with the sender.
    const copy = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
    for (const h of [...(shared.handlers.get(event) ?? [])]) h({ payload: copy });
    return Promise.resolve();
  },
  listen: (event: string, handler: (ev: { payload: unknown }) => void) => {
    shared.listens.push(event);
    let set = shared.handlers.get(event);
    if (!set) {
      set = new Set();
      shared.handlers.set(event, set);
    }
    set.add(handler);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
  getCurrentWindow: () => ({
    get label() {
      return shared.label;
    },
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    innerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onScaleChanged: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
    onCloseRequested: () => Promise.resolve(() => {}),
    isFullscreen: () => Promise.resolve(false),
    isMinimized: () => Promise.resolve(false),
    isVisible: () => Promise.resolve(true),
    setFullscreen: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
    unminimize: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: () => Promise.resolve(null) },
  getAllWebviewWindows: () => Promise.resolve([]),
}));
// The pane: memoised as the real one is, so a fresh tab payload re-renders it.
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: memo(function TabPane({ tab }: { tab: { key: string } }) {
    shared.paneRenders[tab.key] = (shared.paneRenders[tab.key] ?? 0) + 1;
    return <div />;
  }),
}));
vi.mock("../../components/header/WindowControls", () => ({
  WindowControls: () => <div className="wm-controls" />,
}));
vi.mock("../../components/tabs/useAddTabMenuData", () => ({
  useAddTabMenuData: () => ({
    enabledAgents: new Set(["claude"]),
    installedCustom: null,
    customAgents: [],
    defaultAgentBin: "claude",
    agentOrder: undefined,
    localModel: undefined,
    localModelOffInRoot: undefined,
    localDrivers: [],
    vibeForLocalModel: undefined,
    compactAgentBins: new Set<string>(),
    refreshAgents: () => {},
    memberTable: null,
  }),
}));
vi.mock("../../lib/shortcuts/shortcuts", async (orig) => {
  const real = await orig<typeof import("../../lib/shortcuts/shortcuts")>();
  return {
    ...real,
    // Called once per legend render while steering is on and the bar is open.
    steeringKeysFor: (...args: Parameters<typeof real.steeringKeysFor>) => {
      shared.legendRenders += 1;
      return real.steeringKeysFor(...args);
    },
  };
});
vi.mock("../../components/layout/usePaneRects", async (orig) => {
  const real = await orig<typeof import("../../components/layout/usePaneRects")>();
  return {
    ...real,
    // Called once per `DetachedCenterPanel` render.
    usePaneRects: (...args: Parameters<typeof real.usePaneRects>) => {
      shared.panelRenders += 1;
      return real.usePaneRects(...args);
    },
  };
});
vi.mock("../../lib/shortcuts/steeringCaps", async (orig) => {
  const real = await orig<typeof import("../../lib/shortcuts/steeringCaps")>();
  return {
    ...real,
    measureCaps: (...args: Parameters<typeof real.measureCaps>) => {
      shared.capMeasures += 1;
      return real.measureCaps(...args);
    },
  };
});

import { DetachedApp } from "../../components/layout/DetachedApp";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { popoutActiveTab, usePopoutViewStore } from "../../stores/popoutView";
import { useSettingsStore } from "../../stores/settings";

const shell = (label: string) => ({ label, cmd: "bash", cwd: "/p", kind: "shell" as const });

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Past the host's reseed debounce (150 ms), with room. */
const PAST_RESEED = 450;

let main: Heap;
let unhost: () => void;
let popoutId = "";
let tabKeys: string[] = [];
const viewWrites = { n: 0 };
const timers = { n: 0 };
let unsubView: () => void = () => {};

/** Every counter the cost of one key is made of. */
function snapshot() {
  return {
    listens: shared.listens.length,
    caps: shared.capMeasures,
    rects: shared.rects,
    legend: shared.legendRenders,
    panel: shared.panelRenders,
    panes: Object.values(shared.paneRenders).reduce((a, b) => a + b, 0),
    timers: timers.n,
    viewWrites: viewWrites.n,
  };
}
type Counts = ReturnType<typeof snapshot>;
const since = (a: Counts): Counts => {
  const b = snapshot();
  return Object.fromEntries(Object.keys(a).map((k) => [k, b[k as keyof Counts] - a[k as keyof Counts]])) as Counts;
};
const eventsSince = (n: number) => shared.emitted.slice(n).map((e) => e.event);
const seedsSince = (n: number) => eventsSince(n).filter((e) => e.startsWith("detached-seed"));

/** The popped-out group's active tab, as the main window's record has it. */
function mainActive(): string | null | undefined {
  const entry = main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]![0];
  return main.tabs.allGroups(entry.subtree)[0]?.activeKey;
}

beforeEach(async () => {
  shared.handlers.clear();
  shared.emitted.length = 0;
  shared.listens.length = 0;
  shared.paneRenders = {};
  shared.capMeasures = 0;
  shared.rects = 0;
  shared.legendRenders = 0;
  shared.panelRenders = 0;
  viewWrites.n = 0;
  timers.n = 0;
  // The main window: three tabs in the popped-out group, one left behind.
  main = await loadHeap();
  resetTabs(main, "p");
  main.projects.useProjectsStore.setState({ projects: [] });
  const s = () => main.tabs.useTabsStore.getState();
  s().addTab(shell("a"));
  const b = s().addTab(shell("b"));
  const c = s().addTab(shell("c"));
  const d = s().addTab(shell("d"));
  tabKeys = [b.key, c.key, d.key];
  const rootGid = (s().layout as { id: string }).id;
  s().splitWithTab(b.key, rootGid, "right");
  const groupId = (s().layout as { children: Array<{ id: string }> }).children[1].id;
  s().moveTab(c.key, groupId);
  s().moveTab(d.key, groupId);
  s().detachGroup(groupId, { skipBackend: true });
  const entry = s().detachedGroupsByScope["p"]![0];
  popoutId = entry.id;
  shared.label = entry.label;
  unhost = await main.detached.listenDetachedHost();

  usePopoutViewStore.getState().reset();
  useKeyboardSteeringStore.getState().exit();
  useSettingsStore.setState({ settings: null });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
    shared.rects += 1;
    return { width: 10, height: 5, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 5, toJSON: () => ({}) };
  });
  const realSetTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
    timers.n += 1;
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof window.setTimeout);
  if (typeof ResizeObserver === "undefined") {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  }
  unsubView = usePopoutViewStore.subscribe(() => {
    viewWrites.n += 1;
  });
});

afterEach(() => {
  cleanup();
  unsubView();
  unhost();
  useKeyboardSteeringStore.getState().exit();
  usePopoutViewStore.getState().reset();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The popout up and steering on, on its tabs level. */
async function steeringPopout() {
  render(<DetachedApp param={{ scope: "p", groupId: popoutId }} />);
  await sleep(200);
  expect(usePopoutViewStore.getState().tabs).toHaveLength(3);
  press(" ", { code: "Space", shiftKey: true });
  await sleep(400);
  expect(useKeyboardSteeringStore.getState()).toMatchObject({ active: true, level: "tabs" });
}

/** What one → costs the main window's legend, on the workspace's own tabs. */
async function mainWindowKey(): Promise<Counts> {
  const { useTabsStore } = await import("../../stores/tabs");
  const { useSteering } = await import("../../hooks/useSteering");
  const { SteeringLegend } = await import("../../components/layout/SteeringLegend");
  const tabs = ["a", "b", "c"].map((key) => ({ key, label: key, cmd: "bash", cwd: "/p", kind: "shell" as const }));
  const layout = { type: "group" as const, id: "g1", tabKeys: ["a", "b", "c"], activeKey: "c" };
  useTabsStore.setState({
    scope: "p",
    tabs,
    tabsByScope: { p: tabs },
    layout,
    layoutByScope: { p: layout },
    focusedGroupId: "g1",
    activeKey: "c",
  });
  function Main() {
    useSteering({ surface: "main", onTogglePanels: () => {} });
    return <SteeringLegend />;
  }
  render(<Main />);
  await sleep(100);
  press(" ", { code: "Space", shiftKey: true });
  await sleep(400);
  const before = snapshot();
  press("ArrowRight");
  expect(useTabsStore.getState().activeKey).toBe("a");
  await sleep(PAST_RESEED);
  const cost = since(before);
  cleanup();
  return cost;
}

describe("a steering key in a popout", () => {
  it("moves the lit tab at once and costs one edit out, nothing back", async () => {
    await steeringPopout();
    const lit = popoutActiveTab()?.key;
    const before = snapshot();
    const mark = shared.emitted.length;

    press("ArrowRight");
    // Not after a round trip: the popout shows the result before the main
    // window has said anything.
    const next = popoutActiveTab()?.key;
    expect(next).toBeDefined();
    expect(next).not.toBe(lit);
    expect(eventsSince(mark)).toEqual(["detached-edit"]);

    await sleep(PAST_RESEED);
    // The main window took the edit and answered with no reseed: a copy of
    // every tab payload that re-rendered every pane of the popout.
    expect(mainActive()).toBe(next);
    expect(eventsSince(mark)).toEqual(["detached-edit"]);
    const cost = since(before);
    // Only the two panes whose visibility flipped render; no listener churn.
    expect(cost.panes).toBeLessThanOrEqual(2);
    expect(cost.listens).toBe(0);
    expect(cost.panel).toBe(1);
  });

  it("costs the legend what the main window's key does", async () => {
    await steeringPopout();
    const before = snapshot();
    press("ArrowRight");
    await sleep(PAST_RESEED);
    const popout = since(before);
    cleanup();
    const mainCost = await mainWindowKey();
    // The popout's tree reaches the legend through the popout view, one write
    // after the key; the main window's through the store it reads directly.
    expect(popout.legend).toBeLessThanOrEqual(mainCost.legend + 1);
    expect(popout.caps).toBeLessThanOrEqual(mainCost.caps + 1);
  });

  it("walks the tabs in a run of keys with no reseed in between", async () => {
    await steeringPopout();
    const mark = shared.emitted.length;
    const seen: Array<string | undefined> = [];
    // One pause is longer than the host's debounce, where a reseed of the key
    // before would land over the next one's optimistic step.
    for (let i = 0; i < 4; i += 1) {
      press("ArrowRight");
      seen.push(popoutActiveTab()?.key);
      await sleep(i === 1 ? 200 : 40);
    }
    await sleep(PAST_RESEED);
    expect(new Set(seen).size).toBe(3);
    expect(popoutActiveTab()?.key).toBe(seen[3]);
    expect(mainActive()).toBe(seen[3]);
    expect(seedsSince(mark)).toEqual([]);
  });
});

describe("a popout is still reseeded by what it did not do itself", () => {
  it("a tab activated by the main window (a status jump) reaches it", async () => {
    await steeringPopout();
    const lit = popoutActiveTab()?.key;
    const target = tabKeys.find((k) => k !== lit)!;
    const mark = shared.emitted.length;
    // `jumpToTab` writes the main store directly; the host's sweep tells the popout.
    act(() => {
      main.tabs.useTabsStore.getState().applyDetachedEdit("p", popoutId, { kind: "activate", key: target });
    });
    await sleep(PAST_RESEED);
    expect(seedsSince(mark)).toHaveLength(1);
    expect(popoutActiveTab()?.key).toBe(target);
  });

  it("a change the main window made is not lost to a switch made meanwhile", async () => {
    await steeringPopout();
    const mark = shared.emitted.length;
    act(() => {
      main.tabs.useTabsStore.getState().applyDetachedEdit("p", popoutId, { kind: "rename", key: tabKeys[0], label: "renamed" });
    });
    press("ArrowRight");
    await sleep(PAST_RESEED);
    // The rename's reseed was scheduled before the switch and still goes out.
    expect(seedsSince(mark)).toHaveLength(1);
    expect(usePopoutViewStore.getState().tabs.find((t) => t.key === tabKeys[0])?.label).toBe("renamed");
    expect(popoutActiveTab()?.key).toBe(mainActive());
  });
});
