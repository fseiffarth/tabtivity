/**
 * `stores/overlayAgent` — which root tab each app overlay (mail, calendar,
 * to-do) docks in its agent column. Session-only dock state, a `shownKeys` set
 * `CenterPanel` reads to step aside, a per-machine column width, and the
 * clean-up that forgets a docked tab once it leaves root — but never mistakes
 * a root not restored yet for one whose tab is gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import {
  DEFAULT_OVERLAY_AGENT_WIDTH,
  MAX_OVERLAY_AGENT_WIDTH,
  MIN_OVERLAY_AGENT_WIDTH,
  clampOverlayAgentWidth,
  dockedRootTab,
  useOverlayAgentStore,
} from "../../stores/overlayAgent";
import { storageKey } from "../../lib/brand";

const WIDTH_KEY = storageKey("overlayAgentWidth");
const EMPTY = { key: null, open: false };

function rootTab(key: string): TabEntry {
  return { key, label: key, cmd: "claude", args: [], env: {}, cwd: "/r", kind: "agent" };
}

function setRoot(tabs: TabEntry[] | undefined) {
  const tabsByScope = { ...useTabsStore.getState().tabsByScope };
  if (tabs) tabsByScope.root = tabs;
  else delete tabsByScope.root;
  useTabsStore.setState({ tabsByScope });
}

beforeEach(() => {
  localStorage.clear();
  useTabsStore.setState({ tabsByScope: { root: [rootTab("t1"), rootTab("t2")] } });
  useOverlayAgentStore.setState({
    docks: { mail: EMPTY, calendar: EMPTY, todo: EMPTY },
    shownKeys: new Set(),
    width: DEFAULT_OVERLAY_AGENT_WIDTH,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const docks = () => useOverlayAgentStore.getState().docks;

describe("dock / hide / reopen", () => {
  it("docks a key per app and opens only that app's column", () => {
    useOverlayAgentStore.getState().dock("calendar", "t1");

    expect(docks().calendar).toEqual({ key: "t1", open: true });
    expect(docks().mail).toEqual(EMPTY);
    expect(docks().todo).toEqual(EMPTY);
  });

  it("hide keeps the key; reopen shows it again", () => {
    const s = useOverlayAgentStore.getState();
    s.dock("todo", "t1");
    s.hide("todo");
    expect(docks().todo).toEqual({ key: "t1", open: false });

    s.reopen("todo");
    expect(docks().todo).toEqual({ key: "t1", open: true });
  });

  it("reopen does nothing without a docked key", () => {
    const before = docks();
    useOverlayAgentStore.getState().reopen("mail");
    expect(docks()).toBe(before);
    expect(docks().mail).toEqual(EMPTY);
  });

  it("docking a new key replaces the old one", () => {
    const s = useOverlayAgentStore.getState();
    s.dock("mail", "t1");
    s.hide("mail");
    s.dock("mail", "t2");
    expect(docks().mail).toEqual({ key: "t2", open: true });
  });

  it("no-op calls keep the state's identity", () => {
    const s = useOverlayAgentStore.getState();
    s.dock("mail", "t1");
    const before = docks();
    s.dock("mail", "t1");
    s.reopen("mail");
    expect(docks()).toBe(before);
    s.hide("mail");
    const hidden = docks();
    s.hide("mail");
    expect(docks()).toBe(hidden);
  });

  it("clear forgets the key and closes", () => {
    const s = useOverlayAgentStore.getState();
    s.dock("calendar", "t1");
    s.clear("calendar");
    expect(docks().calendar).toEqual(EMPTY);
  });

  it("dockedRootTab finds the docked root tab", () => {
    expect(dockedRootTab("mail")).toBeNull();
    useOverlayAgentStore.getState().dock("mail", "t2");
    expect(dockedRootTab("mail")?.key).toBe("t2");
  });
});

describe("shownKeys", () => {
  it("adds and removes keys", () => {
    const s = useOverlayAgentStore.getState();
    s.markShown("t1");
    s.markShown("t2");
    expect([...useOverlayAgentStore.getState().shownKeys].sort()).toEqual(["t1", "t2"]);

    s.unmarkShown("t1");
    expect([...useOverlayAgentStore.getState().shownKeys]).toEqual(["t2"]);
  });

  it("keeps its identity when nothing changes", () => {
    const s = useOverlayAgentStore.getState();
    s.markShown("t1");
    const set = useOverlayAgentStore.getState().shownKeys;

    s.markShown("t1");
    s.unmarkShown("absent");
    expect(useOverlayAgentStore.getState().shownKeys).toBe(set);

    s.unmarkShown("t1");
    expect(useOverlayAgentStore.getState().shownKeys).not.toBe(set);
  });

  it("does not notify subscribers on a no-op mark", () => {
    useOverlayAgentStore.getState().markShown("t1");
    const listener = vi.fn();
    const unsubscribe = useOverlayAgentStore.subscribe(listener);
    useOverlayAgentStore.getState().markShown("t1");
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("column width", () => {
  it("clamps to the column's bounds", () => {
    expect(clampOverlayAgentWidth(10)).toBe(MIN_OVERLAY_AGENT_WIDTH);
    expect(clampOverlayAgentWidth(99999)).toBe(MAX_OVERLAY_AGENT_WIDTH);
    expect(clampOverlayAgentWidth(600.4)).toBe(600);
  });

  it("setWidth clamps and remembers the width on this machine", () => {
    useOverlayAgentStore.getState().setWidth(50);
    expect(useOverlayAgentStore.getState().width).toBe(MIN_OVERLAY_AGENT_WIDTH);
    expect(localStorage.getItem(WIDTH_KEY)).toBe(String(MIN_OVERLAY_AGENT_WIDTH));

    useOverlayAgentStore.getState().setWidth(700);
    expect(localStorage.getItem(WIDTH_KEY)).toBe("700");
  });

  it("reads the remembered width, clamped, on load", async () => {
    localStorage.setItem(WIDTH_KEY, "5000");
    vi.resetModules();
    const fresh = await import("../../stores/overlayAgent");
    expect(fresh.useOverlayAgentStore.getState().width).toBe(MAX_OVERLAY_AGENT_WIDTH);
  });

  it("falls back to the default for a missing or garbled width", async () => {
    localStorage.setItem(WIDTH_KEY, "wide");
    vi.resetModules();
    const fresh = await import("../../stores/overlayAgent");
    expect(fresh.useOverlayAgentStore.getState().width).toBe(DEFAULT_OVERLAY_AGENT_WIDTH);
  });

  it("survives a localStorage that throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.resetModules();
    const fresh = await import("../../stores/overlayAgent");
    expect(fresh.useOverlayAgentStore.getState().width).toBe(DEFAULT_OVERLAY_AGENT_WIDTH);

    fresh.useOverlayAgentStore.getState().setWidth(640);
    expect(fresh.useOverlayAgentStore.getState().width).toBe(640);
  });
});

describe("root tab removal", () => {
  it("clears the dock and unmarks the key when its root tab is gone", () => {
    const s = useOverlayAgentStore.getState();
    s.dock("calendar", "t1");
    s.dock("todo", "t2");
    s.markShown("t1");

    setRoot([rootTab("t2")]);

    expect(docks().calendar).toEqual(EMPTY);
    expect(docks().todo).toEqual({ key: "t2", open: true });
    expect(useOverlayAgentStore.getState().shownKeys.has("t1")).toBe(false);
  });

  it("clears a hidden dock too, so a later Ctrl+N cannot reopen a dead tab", () => {
    const s = useOverlayAgentStore.getState();
    s.dock("mail", "t1");
    s.hide("mail");

    setRoot([rootTab("t2")]);

    expect(docks().mail).toEqual(EMPTY);
  });

  it("keeps the dock while root is not hydrated", () => {
    useOverlayAgentStore.getState().dock("calendar", "t1");

    setRoot(undefined);
    expect(docks().calendar).toEqual({ key: "t1", open: true });

    // The next root array decides; one without the key clears it.
    setRoot([rootTab("t2")]);
    expect(docks().calendar).toEqual(EMPTY);
  });

  it("keeps the dock across a root array that still holds the key; an empty one clears it", () => {
    useOverlayAgentStore.getState().dock("todo", "t1");

    setRoot([rootTab("t2"), { ...rootTab("t1"), label: "renamed" }]);
    expect(docks().todo).toEqual({ key: "t1", open: true });

    // A hydrated, empty root is a real "gone" (every tab closed).
    setRoot([]);
    expect(docks().todo).toEqual(EMPTY);
  });

  it("only looks at root: an unrelated scope's change decides nothing", () => {
    // A key root does not hold: any look at root would clear it.
    useOverlayAgentStore.getState().dock("todo", "ghost");
    const before = docks();
    useTabsStore.setState({
      tabsByScope: { ...useTabsStore.getState().tabsByScope, p1: [rootTab("x")] },
    });
    expect(docks()).toBe(before);

    setRoot([rootTab("t1")]);
    expect(docks().todo).toEqual(EMPTY);
  });

  it("follows the tabs store's own add and remove", () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
    const tabs = useTabsStore.getState();
    const { key: a } = tabs.addTabToScope(ROOT_SCOPE, { label: "a", cmd: "claude", args: [], env: {}, cwd: "/r", kind: "agent" });
    const { key: b } = tabs.addTabToScope(ROOT_SCOPE, { label: "b", cmd: "claude", args: [], env: {}, cwd: "/r", kind: "agent" });
    useOverlayAgentStore.getState().dock("mail", a);
    useOverlayAgentStore.getState().dock("calendar", b);

    useTabsStore.getState().renameTabInScope(ROOT_SCOPE, a, "renamed");
    expect(docks().mail).toEqual({ key: a, open: true });

    useTabsStore.getState().removeTabInScope(ROOT_SCOPE, a);
    expect(docks().mail).toEqual(EMPTY);
    expect(docks().calendar).toEqual({ key: b, open: true });
  });
});
