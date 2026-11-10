/**
 * Steering's view cycle: Tab / Shift+Tab call the active agent tab's Reader
 * `show` with the next / previous view, at the panes, tabs and Inside levels,
 * without changing the level (`lib/agents/readerSteering`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { releaseTerminalScroll } from "../../lib/terminal/terminalScroll";
import { registerReaderViews, type ReaderViewId } from "../../lib/agents/readerSteering";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

const cleanups: (() => void)[] = [];

/** One agent tab with a (fake) terminal and a registered Reader view target. */
function agentTab(opts: { view?: ReaderViewId; offered?: ReaderViewId[]; strip?: boolean } = {}) {
  const tab = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
  const id = `p:${tab.key}`;
  const term = {
    element: document.createElement("div"),
    rows: 30,
    modes: { mouseTrackingMode: "none" },
    buffer: { active: { type: "normal" } },
    scrollLines: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  registerTerminal(id, term as unknown as Terminal);
  cleanups.push(() => unregisterTerminal(id, term as unknown as Terminal));
  let view: ReaderViewId = opts.view ?? "chat";
  const show = vi.fn((v: ReaderViewId) => {
    view = v;
  });
  if (opts.strip !== false) {
    cleanups.push(
      registerReaderViews(id, {
        view: () => view,
        offered: () => opts.offered ?? ["chat", "changes", "files", "terminal"],
        show,
      }),
    );
  }
  return { show, id };
}

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
  useSettingsStore.setState({ settings: null });
  useProjectsStore.setState({ projects: [] });
  useKeyboardSteeringStore.getState().exit();
});

afterEach(() => {
  releaseTerminalScroll();
  for (const off of cleanups.splice(0)) off();
  cleanup();
  document.body.innerHTML = "";
});

describe("steering view cycle", () => {
  it("Tab goes to the next view and Shift+Tab to the previous, keeping the tabs level", () => {
    const { show } = agentTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    expect(steering().level).toBe("tabs");
    press({ key: "Tab" });
    expect(show).toHaveBeenLastCalledWith("changes");
    press({ key: "Tab" });
    expect(show).toHaveBeenLastCalledWith("files");
    press({ key: "Tab", shiftKey: true });
    expect(show).toHaveBeenLastCalledWith("changes");
    expect(steering().level).toBe("tabs");
    expect(steering().active).toBe(true);
  });

  it("wraps around the strip and skips views that are not offered", () => {
    const { show } = agentTab({ view: "terminal", offered: ["chat", "files", "terminal"] });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "Tab" });
    expect(show).toHaveBeenLastCalledWith("chat");
    press({ key: "Tab" });
    expect(show).toHaveBeenLastCalledWith("files");
    press({ key: "Tab", shiftKey: true });
    expect(show).toHaveBeenLastCalledWith("chat");
  });

  it("works at the panes level and Inside, and the level stays", () => {
    const { show } = agentTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    act(() => steering().setLevel("panes"));
    press({ key: "Tab" });
    expect(show).toHaveBeenCalledTimes(1);
    expect(steering().level).toBe("panes");
    act(() => steering().setLevel("scroll"));
    press({ key: "Tab" });
    expect(show).toHaveBeenCalledTimes(2);
    expect(steering().level).toBe("scroll");
  });

  it("does nothing on the projects level", () => {
    const { show } = agentTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    act(() => steering().setLevel("projects"));
    press({ key: "Tab" });
    expect(show).not.toHaveBeenCalled();
  });

  it("swallows the key on a tab without a view strip", () => {
    agentTab({ strip: false });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    expect(() => act(() => void document.body.dispatchEvent(ev))).not.toThrow();
    expect(ev.defaultPrevented).toBe(true);
    expect(steering().level).toBe("tabs");
  });

  it("ignores a held key's repeats", () => {
    const { show } = agentTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "Tab" });
    press({ key: "Tab", repeat: true });
    press({ key: "Tab", repeat: true });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("follows a rebound key, and a freed Tab does nothing", () => {
    const { show } = agentTab();
    useSettingsStore.setState({ settings: { steering_keys: { readerView: ["i"] } } as never });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "Tab" });
    expect(show).not.toHaveBeenCalled();
    press({ key: "i" });
    expect(show).toHaveBeenCalledTimes(1);
  });
});
