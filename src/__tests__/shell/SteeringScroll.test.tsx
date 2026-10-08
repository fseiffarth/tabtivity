/**
 * Steering's scroll level: D on the tabs steps into the active terminal, S/F
 * (←/→) scroll it the way its mouse wheel would (`lib/terminal/terminalScroll`),
 * and leaving the level puts the terminal back at its live end.
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
import { releaseTerminalScroll, scrollTerminal, scrollTerminalToLive } from "../../lib/terminal/terminalScroll";
import { steeringKeysFor, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import { documentScroller, scrollDocument } from "../../lib/shortcuts/documentScroll";

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

/** A stand-in xterm: `wheels` records each wheel notch that reached it
 *  (-1 up, +1 down), as xterm's own listener on its element would see them. */
function fakeTerm(opts: { tracking?: boolean; buffer?: "normal" | "alternate"; rows?: number } = {}) {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  document.body.appendChild(element);
  const wheels: number[] = [];
  element.addEventListener("wheel", (e) => wheels.push(Math.sign((e as WheelEvent).deltaY)));
  const term = {
    element,
    rows: opts.rows ?? 40,
    modes: { mouseTrackingMode: opts.tracking ? "vt200" : "none" },
    buffer: { active: { type: opts.buffer ?? "normal" } },
    scrollLines: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  return { term, wheels };
}

const registered: [string, Terminal][] = [];
function register(ptyId: string, term: object) {
  registerTerminal(ptyId, term as Terminal);
  registered.push([ptyId, term as Terminal]);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

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
  for (const [id, term] of registered.splice(0)) unregisterTerminal(id, term);
  cleanup();
  document.body.innerHTML = "";
});

describe("terminalScroll", () => {
  it("sends wheel notches while the program tracks the mouse, and takes them back", () => {
    const { term, wheels } = fakeTerm({ tracking: true, buffer: "alternate", rows: 40 });
    register("p:t", term);
    // Half a screen is 20 lines, four of tmux's five-line notches.
    expect(scrollTerminal("p:t", -0.5)).toBe(true);
    expect(wheels).toEqual([-1, -1, -1, -1]);
    expect(scrollTerminal("p:t", -1)).toBe(true);
    expect(sum(wheels)).toBe(-12);
    scrollTerminal("p:t", 0.5);
    expect(sum(wheels)).toBe(-8);
    wheels.length = 0;
    scrollTerminalToLive("p:t");
    expect(wheels).toEqual(Array(8).fill(1));
    // Nothing owed any more.
    wheels.length = 0;
    releaseTerminalScroll();
    expect(wheels).toEqual([]);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it("moves a plain terminal's own scrollback", () => {
    const { term, wheels } = fakeTerm({ rows: 30 });
    register("p:t", term);
    expect(scrollTerminal("p:t", -0.5)).toBe(true);
    expect(term.scrollLines).toHaveBeenCalledWith(-15);
    expect(wheels).toEqual([]);
    releaseTerminalScroll();
    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  it("leaves an alternate screen that tracks nothing alone", () => {
    const { term, wheels } = fakeTerm({ buffer: "alternate" });
    register("p:t", term);
    expect(scrollTerminal("p:t", -0.5)).toBe(false);
    expect(wheels).toEqual([]);
    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(scrollTerminal("p:missing", -0.5)).toBe(false);
  });

  it("scrolls a Reader shown over the terminal instead, and leaves tmux alone", () => {
    const { term, wheels } = fakeTerm({ tracking: true, buffer: "alternate", rows: 40 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(term.element);
    const reader = document.createElement("div");
    reader.className = "terminal-reader";
    const list = document.createElement("div");
    list.className = "terminal-reader-list";
    reader.appendChild(list);
    host.appendChild(reader);
    // jsdom has no layout: a 500px-high list over 5000px of conversation.
    Object.defineProperty(list, "clientHeight", { value: 500 });
    Object.defineProperty(list, "scrollHeight", { value: 5000 });
    list.scrollTop = 4500;
    register("p:t", term);

    expect(scrollTerminal("p:t", -0.5)).toBe(true);
    expect(list.scrollTop).toBe(4275);
    scrollTerminal("p:t", -1);
    expect(list.scrollTop).toBe(3825);
    scrollTerminalToLive("p:t");
    expect(list.scrollTop).toBe(5000);
    releaseTerminalScroll();
    expect(wheels).toEqual([]);
  });
});

describe("steering scroll level", () => {
  function oneTerminalTab() {
    const tab = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    const fake = fakeTerm({ tracking: true, buffer: "alternate", rows: 40 });
    register(`p:${tab.key}`, fake.term);
    return fake;
  }

  it("D steps into the terminal, S/F scroll it, E climbs out back to live", () => {
    const { wheels } = oneTerminalTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    expect(steering().level).toBe("tabs");
    press({ key: "d" });
    expect(steering().level).toBe("scroll");

    press({ key: "s" });
    expect(sum(wheels)).toBe(-4);
    press({ key: "S", shiftKey: true });
    expect(sum(wheels)).toBe(-12);
    press({ key: "f" });
    expect(sum(wheels)).toBe(-8);
    // Anything else on this level is swallowed: no new tab from N.
    const tabCount = useTabsStore.getState().tabs.length;
    press({ key: "n" });
    expect(useTabsStore.getState().tabs.length).toBe(tabCount);
    expect(steering().level).toBe("scroll");

    press({ key: "e" });
    expect(steering().level).toBe("tabs");
    expect(sum(wheels)).toBe(0);
  });

  it("D inside goes back to the live end and stays; Space leaves live", () => {
    const { wheels } = oneTerminalTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "ArrowDown" });
    press({ key: "ArrowLeft" });
    expect(sum(wheels)).toBe(-4);
    press({ key: "ArrowDown" });
    expect(sum(wheels)).toBe(0);
    expect(steering().level).toBe("scroll");

    press({ key: "ArrowLeft" });
    expect(sum(wheels)).toBe(-4);
    press({ key: " " });
    expect(steering().active).toBe(false);
    expect(sum(wheels)).toBe(0);
  });

  it("D stays on the tabs when the active tab has no terminal", () => {
    useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "d" });
    expect(steering().level).toBe("tabs");
  });

  it("the legend offers the way in only over a terminal, and the scroll keys inside", () => {
    const base: SteeringLegendState = {
      level: "tabs",
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const labels = (s: SteeringLegendState) => steeringKeysFor(s).map((k) => k.labelKey);
    expect(labels(base)).not.toContain("steering.intoTerminal.label");
    expect(labels({ ...base, terminal: true })).toContain("steering.intoTerminal.label");
    const inside = labels({ ...base, level: "scroll", terminal: true });
    expect(inside).toEqual(
      expect.arrayContaining(["steering.scroll.label", "steering.scrollLive.label", "steering.scrollOut.label", "steering.work.label"]),
    );
    expect(inside).not.toContain("steering.newShell.label");
    expect(inside).not.toContain("steering.scrollEnd.label");
  });

  it("the legend offers a scrolling document the same way, with its own keys inside", () => {
    const base: SteeringLegendState = {
      level: "tabs",
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const labels = (s: SteeringLegendState) => steeringKeysFor(s).map((k) => k.labelKey);
    expect(labels({ ...base, document: true })).toContain("steering.intoDocument.label");
    // A terminal wins: one way in, not two.
    const both = labels({ ...base, terminal: true, document: true });
    expect(both).toContain("steering.intoTerminal.label");
    expect(both).not.toContain("steering.intoDocument.label");
    const inside = labels({ ...base, level: "scroll", document: true });
    expect(inside).toEqual(
      expect.arrayContaining(["steering.scrollDocument.label", "steering.scrollEnd.label", "steering.scrollOutDocument.label"]),
    );
    expect(inside).not.toContain("steering.scrollLive.label");
  });
});

/** A box that scrolls: jsdom has no layout, so its sizes are stubbed. */
function scrollBox(parent: HTMLElement, size: { w: number; h: number; content: number }): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  Object.defineProperty(el, "clientWidth", { value: size.w });
  Object.defineProperty(el, "clientHeight", { value: size.h });
  Object.defineProperty(el, "scrollHeight", { value: size.content });
  parent.appendChild(el);
  return el;
}

/** The active tab's pane, on screen, as CenterPanel renders it. */
function documentPane(tabKey: string, scope = "p"): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "center-pane";
  pane.dataset.scopeKey = scope;
  pane.dataset.tabKey = tabKey;
  pane.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
  document.body.appendChild(pane);
  return pane;
}

describe("documentScroll", () => {
  it("scrolls the largest scrolling box in the tab's pane, not its outline", () => {
    const pane = documentPane("t");
    const viewer = document.createElement("div");
    pane.appendChild(viewer);
    scrollBox(viewer, { w: 150, h: 580, content: 2000 }); // an outline beside it
    const doc = scrollBox(viewer, { w: 600, h: 500, content: 9000 });
    // What the document holds is not searched for another box.
    scrollBox(doc, { w: 600, h: 400, content: 800 });
    expect(documentScroller("p", "t")).toBe(doc);

    expect(scrollDocument("p", "t", 0.5)).toBe(true);
    expect(doc.scrollTop).toBe(225);
    scrollDocument("p", "t", 1);
    expect(doc.scrollTop).toBe(675);
  });

  it("finds nothing in a pane whose content fits, another scope's pane, or a hidden one", () => {
    const pane = documentPane("t");
    scrollBox(pane, { w: 600, h: 500, content: 500 });
    expect(documentScroller("p", "t")).toBeNull();
    expect(scrollDocument("p", "t", 0.5)).toBe(false);

    const other = documentPane("u", "q");
    scrollBox(other, { w: 600, h: 500, content: 5000 });
    expect(documentScroller("p", "u")).toBeNull();
    other.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    expect(documentScroller("q", "u")).toBeNull();
  });
});

describe("steering scroll level in a document", () => {
  function oneDocumentTab() {
    const tab = useTabsStore.getState().addTab({ label: "notes.md", cmd: "", cwd: "/p", kind: "files" });
    return scrollBox(documentPane(tab.key), { w: 600, h: 400, content: 4000 });
  }

  it("D steps into the document, S/F scroll it, D jumps to its end, E keeps the place", () => {
    const doc = oneDocumentTab();
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "d" });
    expect(steering().level).toBe("scroll");

    press({ key: "f" });
    expect(doc.scrollTop).toBe(180);
    press({ key: "F", shiftKey: true });
    expect(doc.scrollTop).toBe(540);
    press({ key: "s" });
    expect(doc.scrollTop).toBe(360);
    // A held D's repeats do not run on to the end.
    press({ key: "d", repeat: true });
    expect(doc.scrollTop).toBe(360);
    press({ key: "d" });
    expect(doc.scrollTop).toBe(4000);

    doc.scrollTop = 700;
    press({ key: "e" });
    expect(steering().level).toBe("tabs");
    expect(doc.scrollTop).toBe(700);
  });

  it("D stays on the tabs when nothing in the document scrolls", () => {
    const tab = useTabsStore.getState().addTab({ label: "a.png", cmd: "", cwd: "/p", kind: "files" });
    scrollBox(documentPane(tab.key), { w: 600, h: 400, content: 400 });
    render(<Harness />);
    press({ key: " ", shiftKey: true });
    press({ key: "d" });
    expect(steering().level).toBe("tabs");
  });
});
