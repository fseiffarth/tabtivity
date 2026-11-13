/**
 * The registry between keyboard steering and an agent tab's Reader pane
 * (`lib/agents/readerSteering`): the view cycle, last-registration-wins, the
 * facts the legend reads, and "steering is Inside this pane".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import {
  cycleReaderView,
  publishReaderViewFacts,
  readerInsideFor,
  readerViewFacts,
  readerViewFor,
  registerReaderInside,
  registerReaderViews,
  useReaderViewFacts,
  useSteeringInside,
  type ReaderInsideTarget,
  type ReaderViewId,
  type ReaderViewTarget,
} from "../../lib/agents/readerSteering";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useRootOverlayStore } from "../../stores/rootOverlay";

const ALL: ReaderViewId[] = ["chat", "changes", "files", "terminal"];

describe("cycleReaderView", () => {
  it("walks Chat, Diffs, Files, Terminal and wraps", () => {
    expect(cycleReaderView("chat", ALL, 1)).toBe("changes");
    expect(cycleReaderView("changes", ALL, 1)).toBe("files");
    expect(cycleReaderView("files", ALL, 1)).toBe("terminal");
    expect(cycleReaderView("terminal", ALL, 1)).toBe("chat");
  });

  it("goes back with -1 and wraps the other way", () => {
    expect(cycleReaderView("terminal", ALL, -1)).toBe("files");
    expect(cycleReaderView("chat", ALL, -1)).toBe("terminal");
  });

  it("skips views that are not offered", () => {
    const noDiffs: ReaderViewId[] = ["chat", "files", "terminal"];
    expect(cycleReaderView("chat", noDiffs, 1)).toBe("files");
    expect(cycleReaderView("files", noDiffs, -1)).toBe("chat");
    const chatTerminal: ReaderViewId[] = ["chat", "terminal"];
    expect(cycleReaderView("chat", chatTerminal, 1)).toBe("terminal");
    expect(cycleReaderView("terminal", chatTerminal, 1)).toBe("chat");
  });

  it("keeps an open view selectable although it is no longer offered", () => {
    // Diffs is shown but greyed: the way out and back in both pass through it.
    expect(cycleReaderView("chat", ["chat", "terminal"], 1)).toBe("terminal");
    expect(cycleReaderView("changes", ["chat", "terminal"], 1)).toBe("terminal");
    expect(cycleReaderView("changes", ["chat", "terminal"], -1)).toBe("chat");
  });

  it("stays put when nothing else is offered", () => {
    expect(cycleReaderView("chat", ["chat"], 1)).toBe("chat");
    expect(cycleReaderView("files", [], -1)).toBe("files");
  });
});

describe("registries", () => {
  const view = (): ReaderViewTarget => ({ view: () => "chat", offered: () => ALL, show: vi.fn() });
  const inside = (): ReaderInsideTarget => ({ view: "changes", key: vi.fn(() => "pass" as const) });

  it("finds nothing for an unknown pane", () => {
    expect(readerViewFor("nope")).toBeNull();
    expect(readerInsideFor("nope")).toBeNull();
  });

  it("registers and unregisters a view target", () => {
    const a = view();
    const off = registerReaderViews("p:a", a);
    expect(readerViewFor("p:a")).toBe(a);
    off();
    expect(readerViewFor("p:a")).toBeNull();
  });

  it("lets the last registration win, and a replaced one cannot unregister it", () => {
    const first = view();
    const second = view();
    const offFirst = registerReaderViews("p:b", first);
    const offSecond = registerReaderViews("p:b", second);
    expect(readerViewFor("p:b")).toBe(second);
    offFirst();
    expect(readerViewFor("p:b")).toBe(second);
    offSecond();
    expect(readerViewFor("p:b")).toBeNull();
  });

  it("does the same for the inside target", () => {
    const first = inside();
    const second = inside();
    const offFirst = registerReaderInside("p:c", first);
    const offSecond = registerReaderInside("p:c", second);
    expect(readerInsideFor("p:c")).toBe(second);
    offFirst();
    expect(readerInsideFor("p:c")).toBe(second);
    offSecond();
    expect(readerInsideFor("p:c")).toBeNull();
  });
});

describe("facts", () => {
  afterEach(() => {
    cleanup();
    publishReaderViewFacts("p:f", null);
  });

  it("publish notifies subscribers, an unchanged value does not", () => {
    const { result } = renderHook(() => useReaderViewFacts("p:f"));
    expect(result.current).toBeNull();
    act(() => publishReaderViewFacts("p:f", { view: "chat", offered: ["chat", "terminal"] }));
    expect(result.current).toEqual({ view: "chat", offered: ["chat", "terminal"] });
    const before = result.current;
    act(() => publishReaderViewFacts("p:f", { view: "chat", offered: ["chat", "terminal"] }));
    expect(result.current).toBe(before);
    act(() => publishReaderViewFacts("p:f", { view: "changes", offered: ["chat", "changes", "terminal"] }));
    expect(result.current?.view).toBe("changes");
    act(() => publishReaderViewFacts("p:f", null));
    expect(result.current).toBeNull();
  });

  it("withdraws only the facts it published when asked to", () => {
    const mine = { view: "chat" as const, offered: ["chat" as const] };
    publishReaderViewFacts("p:f", mine);
    publishReaderViewFacts("p:f", { view: "files", offered: ["files"] });
    publishReaderViewFacts("p:f", null, mine);
    expect(readerViewFacts("p:f")?.view).toBe("files");
  });

  it("is null for a pane without a strip or no pane", () => {
    expect(readerViewFacts(null)).toBeNull();
    expect(readerViewFacts(undefined)).toBeNull();
    expect(readerViewFacts("p:none")).toBeNull();
  });
});

describe("useSteeringInside", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
      fullscreenGroupId: null,
    });
    useKeyboardSteeringStore.getState().exit();
  });
  afterEach(cleanup);

  it("is true only with steering on, the scroll level and that pane's tab active", () => {
    const tab = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    const other = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    useTabsStore.getState().setActive(tab.key);
    const { result } = renderHook(() => useSteeringInside(`p:${tab.key}`));
    const otherPane = renderHook(() => useSteeringInside(`p:${other.key}`));
    const none = renderHook(() => useSteeringInside(undefined));
    expect(result.current).toBe(false);

    act(() => useKeyboardSteeringStore.getState().enter());
    expect(result.current).toBe(false);
    act(() => useKeyboardSteeringStore.getState().setLevel("scroll"));
    expect(result.current).toBe(true);
    expect(otherPane.result.current).toBe(false);
    expect(none.result.current).toBe(false);

    act(() => useTabsStore.getState().setActive(other.key));
    expect(result.current).toBe(false);
    expect(otherPane.result.current).toBe(true);

    act(() => useTabsStore.getState().setActive(tab.key));
    act(() => useKeyboardSteeringStore.getState().setLevel("tabs"));
    expect(result.current).toBe(false);
    act(() => useKeyboardSteeringStore.getState().setLevel("scroll"));
    act(() => useKeyboardSteeringStore.getState().exit());
    expect(result.current).toBe(false);
  });

  it("is false while the Root view covers the workspace's tabs", () => {
    const tab = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    act(() => {
      useKeyboardSteeringStore.getState().enter();
      useKeyboardSteeringStore.getState().setLevel("scroll");
    });
    const { result } = renderHook(() => useSteeringInside(`p:${tab.key}`));
    expect(result.current).toBe(true);
    act(() => useRootOverlayStore.setState({ open: true, view: "root" } as never));
    expect(result.current).toBe(false);
    act(() => useRootOverlayStore.setState({ open: false } as never));
  });
});
