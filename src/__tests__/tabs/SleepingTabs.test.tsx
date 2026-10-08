/**
 * Sleeping tabs, the pane layer (performance plan §5.3, S9): a viewer pane
 * hidden for the "Unload hidden tabs after" delay renders
 * `SleepingPane` in place of `TabPane` — the viewer unmounts, the store is not
 * touched — and is mounted afresh, from the same `TabEntry`, the render it is
 * shown. Terminal kinds never sleep here (S10's half). A hold raised from
 * inside the pane keeps it awake. The popout stub (§4.5): a viewer a popout
 * shows sleeps in the main window at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// A stand-in pane that counts mounts/unmounts per tab key, records the
// `viewerState` it mounted with, and raises a sleep hold while its key is in
// `holding` (what an unsaved editor or a build does from inside a real pane).
const mounts = new Map<string, number>();
const unmounts = new Map<string, number>();
const mountedWith = new Map<string, unknown>();
const holding = new Set<string>();
vi.mock("../../components/tabs/TabPane", async () => {
  const { usePaneSleepHold } = await import("../../lib/sleepWhenHidden");
  function TabPane(props: { tab: { key: string; viewerState?: unknown } }) {
    const key = props.tab.key;
    useEffect(() => {
      mounts.set(key, (mounts.get(key) ?? 0) + 1);
      mountedWith.set(key, props.tab.viewerState);
      return () => {
        unmounts.set(key, (unmounts.get(key) ?? 0) + 1);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    usePaneSleepHold(holding.has(key));
    return <div data-testid={`pane-${key}`} />;
  }
  return { TabPane };
});

import { CenterPanel } from "../../components/layout/CenterPanel";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useSettingsStore } from "../../stores/settings";
import {
  SLEEP_TABS_DEFAULT_MIN,
  isSleepableTab,
  sleepTabsAfterMs,
} from "../../lib/sleepWhenHidden";
import type { Settings } from "../../types";

const MIN = 60_000;
const DELAY = SLEEP_TABS_DEFAULT_MIN * MIN;
const VIEWERS = 25;
const SHELLS = 5;
let viewerKeys: string[];
let shellKeys: string[];

const st = () => useTabsStore.getState();
const sum = (m: Map<string, number>, ks: string[]) => ks.reduce((a, k) => a + (m.get(k) ?? 0), 0);
const sleeping = () => document.querySelectorAll(".sleeping-pane").length;
const isMounted = (key: string) => document.querySelector(`[data-testid="pane-${key}"]`) != null;

function addViewer(i: number): string {
  return st().addTabToScope(ROOT_SCOPE, {
    label: `doc${i}.md`,
    cmd: "",
    cwd: "/r",
    kind: "embed",
    viewer: "markdown",
    embedPath: `/r/doc${i}.md`,
    viewerState: { scrollTop: 100 + i },
  } as Omit<TabEntry, "key">).key;
}

async function mount() {
  render(<CenterPanel />);
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  mounts.clear();
  unmounts.clear();
  mountedWith.clear();
  holding.clear();
  localStorage.clear();
  useSettingsStore.setState({ settings: null });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
  useTabsStore.setState({
    scope: ROOT_SCOPE,
    tabsByScope: { [ROOT_SCOPE]: [] },
    layoutByScope: { [ROOT_SCOPE]: null },
    focusedGroupByScope: { [ROOT_SCOPE]: null },
    detachedGroupsByScope: {},
    fullscreenGroupId: null,
  });
  st().setScope(ROOT_SCOPE);
  viewerKeys = [];
  shellKeys = [];
  for (let i = 0; i < VIEWERS; i++) viewerKeys.push(addViewer(i));
  // Shells last, so the group's active (visible) tab is a shell and every
  // viewer is hidden.
  for (let i = 0; i < SHELLS; i++) {
    shellKeys.push(st().addTabToScope(ROOT_SCOPE, { label: `Shell ${i}`, cmd: "bash", cwd: "", kind: "shell" }).key);
  }
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({ shownKeys: new Set() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sleeping tabs: the pane layer (30 tabs, 25 hidden viewers)", () => {
  it("unmounts the 25 hidden viewers after the delay, never a terminal, and leaves the store alone", async () => {
    await mount();
    expect(sum(mounts, viewerKeys)).toBe(VIEWERS);
    expect(sum(mounts, shellKeys)).toBe(SHELLS);
    const tabsBefore = st().tabsByScope;
    const layoutBefore = st().layoutByScope;

    await advance(DELAY - 1);
    expect(sum(unmounts, viewerKeys)).toBe(0);
    expect(sleeping()).toBe(0);

    await advance(1);
    expect(sum(unmounts, viewerKeys)).toBe(VIEWERS);
    expect(sleeping()).toBe(VIEWERS);
    for (const k of viewerKeys) expect(isMounted(k), k).toBe(false);
    // Terminal kinds are S10's: no shell was put to sleep (no unmount, no stub).
    expect(sum(unmounts, shellKeys)).toBe(0);
    for (const k of shellKeys) expect(isMounted(k), k).toBe(true);
    // Sleep is a render decision: the store did not change.
    expect(st().tabsByScope).toBe(tabsBefore);
    expect(st().layoutByScope).toBe(layoutBefore);
    // No timer is left running for sleeping or terminal slots.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps every pane box — steering's and the drag ghost's markers — while asleep", async () => {
    await mount();
    await advance(DELAY);
    const boxes = document.querySelectorAll<HTMLElement>(".pane-layer > .center-pane");
    expect(boxes).toHaveLength(VIEWERS + SHELLS);
    for (const k of viewerKeys) {
      const box = document.querySelector<HTMLElement>(`.center-pane[data-tab-key="${k}"]`);
      expect(box, k).not.toBeNull();
      expect(box!.dataset.scopeKey).toBe(ROOT_SCOPE);
      expect(box!.querySelector(".sleeping-pane")).not.toBeNull();
    }
  });

  it("wakes a sleeping viewer the render it is shown, from its persisted viewerState", async () => {
    await mount();
    await advance(DELAY);
    const target = viewerKeys[7];
    expect(isMounted(target)).toBe(false);

    await act(async () => {
      st().setActive(target);
    });
    expect(isMounted(target)).toBe(true);
    expect(mounts.get(target)).toBe(2);
    expect(mountedWith.get(target)).toEqual({ scrollTop: 107 });
    // Only that one woke.
    expect(sleeping()).toBe(VIEWERS - 1);
    for (const k of viewerKeys) if (k !== target) expect(mounts.get(k), k).toBe(1);

    // Hidden again: it sleeps again after the full delay, not before.
    await act(async () => {
      st().setActive(shellKeys[0]);
    });
    await advance(DELAY - 1);
    expect(isMounted(target)).toBe(true);
    await advance(1);
    expect(isMounted(target)).toBe(false);
  });

  it("a hold from inside the pane keeps it awake; the countdown starts over when it lifts", async () => {
    const held = viewerKeys[3];
    holding.add(held);
    await mount();
    await advance(DELAY * 3);
    expect(isMounted(held)).toBe(true);
    expect(sleeping()).toBe(VIEWERS - 1);

    holding.delete(held);
    // Re-render the stand-in so it drops its hold (a real pane re-renders when
    // its dirty flag clears).
    await act(async () => {
      st().renameTab(held, "saved.md");
    });
    await advance(DELAY - 1);
    expect(isMounted(held)).toBe(true);
    await advance(1);
    expect(isMounted(held)).toBe(false);
  });

  it("follows the setting: Never keeps every pane, a shorter delay sleeps sooner", async () => {
    useSettingsStore.setState({ settings: { sleep_tabs_after_min: 0 } as Settings });
    await mount();
    await advance(DELAY * 6);
    expect(sleeping()).toBe(0);
    expect(sum(unmounts, viewerKeys)).toBe(0);

    await act(async () => {
      useSettingsStore.setState({ settings: { sleep_tabs_after_min: 5 } as Settings });
    });
    await advance(5 * MIN);
    expect(sleeping()).toBe(VIEWERS);
  });

  it("sleeps a Files (Project) tab, never a plain Files tab or a viewer-less embed", async () => {
    const pf = st().addTabToScope(ROOT_SCOPE, { label: "Files (Project)", cmd: "", cwd: "/r", kind: "projectfiles", folder: "src" }).key;
    const files = st().addTabToScope(ROOT_SCOPE, { label: "Files", cmd: "", cwd: "/r", kind: "files" }).key;
    const ext = st().addTabToScope(ROOT_SCOPE, {
      label: "a.odg",
      cmd: "",
      cwd: "/r",
      kind: "embed",
      embedPath: "/r/a.odg",
    } as Omit<TabEntry, "key">).key;
    st().setActive(shellKeys[0]);
    await mount();
    await advance(DELAY);
    expect(isMounted(pf)).toBe(false);
    expect(isMounted(files)).toBe(true);
    expect(isMounted(ext)).toBe(true);
  });
});

describe("popped-out viewers (§4.5)", () => {
  function popOut(key: string) {
    useTabsStore.setState({
      detachedGroupsByScope: {
        [ROOT_SCOPE]: [
          { id: "g9", label: "popout-g9", subtree: { type: "group", id: "g9", tabKeys: [key], activeKey: key } },
        ],
      },
    });
  }

  it("never mounts the main window's copy of a viewer a popout shows", async () => {
    const key = viewerKeys[0];
    popOut(key);
    await mount();
    expect(mounts.get(key)).toBeUndefined();
    expect(document.querySelector(`.center-pane[data-tab-key="${key}"] .sleeping-pane`)).not.toBeNull();
    // The other viewers are on the ordinary timer.
    expect(isMounted(viewerKeys[1])).toBe(true);
  });

  it("unloads the copy at once when its tab pops out, unless it holds unsaved work", async () => {
    await mount();
    const clean = viewerKeys[0];
    const dirty = viewerKeys[1];
    holding.add(dirty);
    await act(async () => {
      st().renameTab(dirty, "dirty.md");
    });
    await act(async () => {
      popOut(clean);
    });
    expect(isMounted(clean)).toBe(false);
    await act(async () => {
      popOut(dirty);
    });
    expect(isMounted(dirty)).toBe(true);
  });
});

describe("the setting's reading", () => {
  it("defaults to ten minutes, reads 0 as never and a chosen value as minutes", () => {
    expect(SLEEP_TABS_DEFAULT_MIN).toBe(10);
    expect(sleepTabsAfterMs(undefined)).toBe(10 * MIN);
    expect(sleepTabsAfterMs(null)).toBe(10 * MIN);
    expect(sleepTabsAfterMs(0)).toBeNull();
    expect(sleepTabsAfterMs(30)).toBe(30 * MIN);
    expect(sleepTabsAfterMs(-1)).toBe(10 * MIN);
    expect(sleepTabsAfterMs(Number.NaN)).toBe(10 * MIN);
  });

  it("puts only viewer kinds to sleep", () => {
    expect(isSleepableTab({ kind: "embed", viewer: "pdf" })).toBe(true);
    expect(isSleepableTab({ kind: "projectfiles" })).toBe(true);
    for (const kind of ["agent", "local_agent", "shell", "files", "browser", "calendar"] as const) {
      expect(isSleepableTab({ kind }), kind).toBe(false);
    }
    expect(isSleepableTab({ kind: "embed" })).toBe(false);
  });
});
