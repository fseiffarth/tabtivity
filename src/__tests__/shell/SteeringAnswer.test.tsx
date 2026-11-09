/**
 * Steering's digits on a tab that asks (`steeringAnswer`): the row by that
 * number goes straight into the session, no prompt box; and Back
 * (`statusJump.afterStatusJump`), by its key and by itself once a question a
 * status jump led to is answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

const h = vi.hoisted(() => ({
  jumps: [] as [string, string][],
  typed: [] as [string, string[]][],
  /** The dialog each pane shows, by pty id; none = no dialog. */
  screens: new Map<string, { question: SelectPrompt; signature: string }>(),
  focus: vi.fn(),
}));

vi.mock("../../lib/shortcuts/tabJump", async () => {
  const { useTabsStore } = await import("../../stores/tabs");
  return {
    jumpToTab: (scope: string, key: string) => {
      h.jumps.push([scope, key]);
      useTabsStore.getState().setActive(key);
    },
  };
});
vi.mock("../../lib/agents/paneKeys", () => ({
  typePaneKeys: async (ptyId: string, keys: string[]) => void h.typed.push([ptyId, keys]),
}));
vi.mock("../../lib/terminal/terminalRegistry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/terminal/terminalRegistry")>();
  return {
    ...real,
    terminalFor: (ptyId: string) => ({ buffer: { active: { ptyId } }, cols: 100, focus: h.focus }),
  };
});
vi.mock("../../lib/agents/readerLive", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/agents/readerLive")>();
  return {
    ...real,
    readReaderLive: (buffer: { ptyId: string }) => {
      const screen = h.screens.get(buffer.ptyId);
      return screen ? { ...real.NO_LIVE, question: screen.question, signature: screen.signature } : real.NO_LIVE;
    },
  };
});

import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useActivityStore } from "../../stores/activity";
import { NEW_TAB_SHORTCUT_EVENT } from "../../lib/shortcuts/newTabChord";
import { afterStatusJump, jumpBackTarget } from "../../lib/shortcuts/statusJump";
import { STEERING_KEYS, steeringKeysFor, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(init: Partial<KeyboardEventInit> & { key: string }) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();

const permission: SelectPrompt = {
  options: [
    { index: 0, number: 1, label: "Yes" },
    { index: 1, number: 2, label: "Yes, and don't ask again" },
    { index: 2, number: 3, label: "No" },
  ],
  current: 0,
  start: 0,
  question: 0,
  context: 0,
};

const askUser: SelectPrompt = {
  options: [
    { index: 0, number: 1, label: "Red" },
    { index: 1, number: 2, label: "Blue" },
    { index: 2, number: 3, label: "Type something." },
  ],
  current: 0,
  start: 0,
  question: 0,
  context: 0,
};

let newTabs: unknown[] = [];
const onNewTab = (e: Event) => void newTabs.push((e as CustomEvent).detail);

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
  useActivityStore.setState({ attentionByTab: {}, busyByTab: {} });
  useKeyboardSteeringStore.getState().exit();
  useKeyboardSteeringStore.getState().setJumpBack(null);
  h.jumps.length = 0;
  h.typed.length = 0;
  h.screens.clear();
  h.focus.mockClear();
  newTabs = [];
  window.addEventListener(NEW_TAB_SHORTCUT_EVENT, onNewTab);
});

afterEach(() => {
  window.removeEventListener(NEW_TAB_SHORTCUT_EVENT, onNewTab);
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function agentTab(label: string) {
  return useTabsStore.getState().addTab({ label, cmd: "claude", cwd: "/p", kind: "agent" });
}

describe("steering digits on a tab that asks", () => {
  it("pick that row straight away instead of opening agent N", () => {
    const tab = agentTab("a");
    h.screens.set(`p:${tab.key}`, { question: permission, signature: "perm" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "2" });
    expect(h.typed).toEqual([[`p:${tab.key}`, ["\u001b[B", "\r"]]]);
    expect(newTabs).toEqual([]);
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
    // A second press before the session took the first does not answer twice.
    press({ key: "1" });
    expect(h.typed).toHaveLength(1);
  });

  it("answer from inside the terminal too, stepping out to the tabs first", () => {
    const tab = agentTab("a");
    h.screens.set(`p:${tab.key}`, { question: permission, signature: "perm" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    act(() => steering().setLevel("scroll"));
    press({ key: "3" });
    expect(h.typed).toEqual([[`p:${tab.key}`, ["\u001b[B", "\u001b[B", "\r"]]]);
    expect(steering().level).toBe("tabs");
  });

  it("a number the dialog does not have is spent, a held digit does not run on", () => {
    const tab = agentTab("a");
    h.screens.set(`p:${tab.key}`, { question: permission, signature: "perm" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "7" });
    press({ key: "1", repeat: true });
    expect(h.typed).toEqual([]);
    expect(newTabs).toEqual([]);
  });

  it("the free-text row moves the highlight there and hands the terminal the keyboard", () => {
    const tab = agentTab("a");
    h.screens.set(`p:${tab.key}`, { question: askUser, signature: "ask" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "3" });
    expect(h.typed).toEqual([[`p:${tab.key}`, ["\u001b[B", "\u001b[B"]]]);
    expect(h.focus).toHaveBeenCalled();
    expect(steering().active).toBe(false);
  });

  it("a turn waiting on a decision with no dialog read gets the digit typed as is", () => {
    const tab = agentTab("a");
    useActivityStore.setState({ attentionByTab: { [`p:${tab.key}`]: "decision" } });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "1" });
    expect(h.typed).toEqual([[`p:${tab.key}`, ["1"]]]);
    expect(newTabs).toEqual([]);
  });

  it("a tab that asks nothing keeps 1–9 as the new agent tabs", () => {
    agentTab("a");
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "1" });
    expect(h.typed).toEqual([]);
    expect(newTabs).toHaveLength(1);
  });
});

describe("steering's Back", () => {
  it("returns to the tab the status jumps left, and again to the jumped-to one", () => {
    const asking = agentTab("asking");
    const home = agentTab("home");
    useActivityStore.setState({ attentionByTab: { [`p:${asking.key}`]: "decision" } });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    // Nothing jumped yet: Back does nothing.
    press({ key: "Backspace" });
    expect(h.jumps).toEqual([]);
    press({ key: "q" });
    expect(useTabsStore.getState().activeKey).toBe(asking.key);
    press({ key: "Backspace" });
    expect(useTabsStore.getState().activeKey).toBe(home.key);
    press({ key: "Backspace" });
    expect(useTabsStore.getState().activeKey).toBe(asking.key);
  });

  it("comes back by itself once the answered tab stops asking", async () => {
    vi.useFakeTimers();
    const asking = agentTab("asking");
    const home = agentTab("home");
    useActivityStore.setState({ attentionByTab: { [`p:${asking.key}`]: "decision" } });
    h.screens.set(`p:${asking.key}`, { question: permission, signature: "perm" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "q" });
    expect(useTabsStore.getState().activeKey).toBe(asking.key);
    press({ key: "1" });
    expect(h.typed).toEqual([[`p:${asking.key}`, ["\r"]]]);
    // The session took it: the dialog is gone.
    h.screens.delete(`p:${asking.key}`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(useTabsStore.getState().activeKey).toBe(home.key);
    expect(steering()).toMatchObject({ active: true, level: "tabs", jumpBack: null });
  });

  it("stays while the tab asks the next question", async () => {
    vi.useFakeTimers();
    const asking = agentTab("asking");
    agentTab("home");
    useActivityStore.setState({ attentionByTab: { [`p:${asking.key}`]: "decision" } });
    h.screens.set(`p:${asking.key}`, { question: askUser, signature: "q1" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "q" });
    press({ key: "2" });
    h.screens.set(`p:${asking.key}`, { question: askUser, signature: "q2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(useTabsStore.getState().activeKey).toBe(asking.key);
  });

  it("a run of jumps keeps the first tab it left", () => {
    const a = { scope: "p", key: "a" };
    const b = { scope: "p", key: "b" };
    const c = { scope: "q", key: "c" };
    const first = afterStatusJump(null, a, b);
    expect(first).toEqual({ origin: a, landed: b });
    expect(afterStatusJump(first, b, c)).toEqual({ origin: a, landed: c });
    // Coming round to the first tab again leaves nothing to go back to.
    expect(afterStatusJump(first, b, a)).toBeNull();
    // A jump from somewhere else starts a new run.
    expect(afterStatusJump(first, c, b)).toEqual({ origin: c, landed: b });
    // Back needs the origin still open and not the one showing.
    const tabsByScope = { p: [{ key: "a" }, { key: "b" }] } as never;
    expect(jumpBackTarget(first, b, tabsByScope)).toEqual(a);
    expect(jumpBackTarget(first, a, tabsByScope)).toBeNull();
    expect(jumpBackTarget(first, b, { p: [{ key: "b" }] } as never)).toBeNull();
  });
});

describe("the legend", () => {
  const base: SteeringLegendState = {
    level: "tabs",
    sideRegion: false,
    multiPane: false,
    apps: { mail: false, calendar: false, todo: false },
    statusCounts: { decision: 0, working: 0, done: 0 },
  };
  const labels = (s: SteeringLegendState) => steeringKeysFor(s).map((k) => k.labelKey);

  it("lists 1–9 as Answer on a tab that asks, else as the new agents", () => {
    expect(labels({ ...base, question: true })).toContain("steering.answer.label");
    expect(labels({ ...base, question: true })).not.toContain("steering.newAgent.label");
    expect(labels(base)).toContain("steering.newAgent.label");
    expect(labels(base)).not.toContain("steering.answer.label");
    expect(labels({ ...base, level: "scroll", terminal: true, question: true })).toContain("steering.answer.label");
  });

  it("lists Back only while there is a tab to go back to", () => {
    expect(labels(base)).not.toContain("steering.jumpBack.label");
    expect(labels({ ...base, jumpBack: true })).toContain("steering.jumpBack.label");
    expect(STEERING_KEYS.some((k) => k.actions.includes("jumpBack"))).toBe(true);
  });
});
