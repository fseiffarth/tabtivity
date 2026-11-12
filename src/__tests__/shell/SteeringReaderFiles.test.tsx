/**
 * Steering inside the Reader's Files view: the real `useKeyboard` handler and
 * the real `TerminalReaderFiles` meeting through `lib/agents/readerSteering`.
 * The viewer pane is a stub with a scrolling box; the xterm behind the Reader
 * is a fake that records the wheel notches it would get.
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
vi.mock("../../components/embed/FileViewerPane", () => ({
  FileViewerPane: (props: { path: string }) => {
    const box = (el: HTMLDivElement | null) => {
      if (!el) return;
      Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
      Object.defineProperty(el, "clientWidth", { value: 600, configurable: true });
      Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true });
    };
    return (
      <div className="file-viewer" data-testid="file-viewer" ref={box} style={{ overflowY: "auto" }}>
        {props.path}
      </div>
    );
  },
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { releaseTerminalScroll } from "../../lib/terminal/terminalScroll";
import { readerInsideFor } from "../../lib/agents/readerSteering";
import { steeringKeysFor, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import { TerminalReaderFiles, type ReaderFile } from "../../components/terminal/TerminalReaderFiles";
import type { ChatLink } from "../../../mobile-web/src/terminal/chatLinks";
import type { FileEntry } from "../../lib/viewers/fileUtils";

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

const entryOf = (name: string, extension = ".md"): FileEntry => ({
  name,
  path: `/proj/${name}`,
  is_dir: false,
  size: 10,
  extension,
  mime: "text/markdown",
});
const fileOf = (entry: FileEntry): ReaderFile => ({ entry, label: entry.name });
const a = entryOf("a.md");
const b = entryOf("b.md");
// No in-app viewer: the ↗ button is hidden for it, so `o` does nothing.
const stl = entryOf("part.stl", ".stl");
const pr: ChatLink = { url: "https://github.com/o/r/pull/7", host: "github.com", rest: "/o/r/pull/7", from: "agent" };
const doc: ChatLink = { url: "https://docs.example.org/guide", host: "docs.example.org", rest: "/guide", from: "you" };

/** An agent tab with a fake xterm; the id is the steering id the Reader gets. */
function agentPane() {
  const tab = useTabsStore.getState().addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
  const id = `p:${tab.key}`;
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  element.appendChild(screen);
  document.body.appendChild(element);
  const wheels: number[] = [];
  element.addEventListener("wheel", (e) => wheels.push(Math.sign((e as WheelEvent).deltaY)));
  const term = {
    element,
    rows: 40,
    modes: { mouseTrackingMode: "vt200" },
    buffer: { active: { type: "alternate" } },
    scrollLines: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  registerTerminal(id, term as unknown as Terminal);
  cleanups.push(() => unregisterTerminal(id, term as unknown as Terminal));
  return { id, term, wheels };
}

interface Opts {
  files?: ReaderFile[];
  links?: ChatLink[];
  picked?: FileEntry | null;
  visible?: boolean;
}

function mount(opts: Opts = {}) {
  const pane = agentPane();
  const onPick = vi.fn();
  const onOpenTab = vi.fn();
  const onOpenLink = vi.fn();
  const props = () => ({
    steerId: pane.id,
    files: opts.files ?? [fileOf(a), fileOf(b)],
    links: opts.links ?? [pr, doc],
    picked: opts.picked === undefined ? a : opts.picked,
    projectId: "p",
    visible: opts.visible ?? true,
    onPick,
    onOpenTab,
    onOpenLink,
    onClose: () => {},
  });
  const view = render(
    <>
      <Harness />
      <TerminalReaderFiles {...props()} />
    </>,
  );
  const rerender = (over: Partial<ReturnType<typeof props>> = {}) =>
    view.rerender(
      <>
        <Harness />
        <TerminalReaderFiles {...props()} {...over} />
      </>,
    );
  /** The row the highlight is on (the `.steer-cursor` one). */
  const cursorRow = () => {
    const rows = view.container.querySelectorAll<HTMLElement>(".steer-cursor");
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0]?.dataset.steerRow ?? null;
  };
  return { ...pane, ...view, onPick, onOpenTab, onOpenLink, rerender, cursorRow };
}

/** Shift+Space, then ↓ into the pane's Reader. */
function stepInside() {
  press({ key: " ", shiftKey: true });
  press({ key: "ArrowDown" });
  expect(steering().level).toBe("scroll");
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

describe("steering inside the Reader's Files view", () => {
  it("steps in without wheeling the xterm, the highlight on the file already shown", () => {
    const m = mount({ picked: b });
    expect(m.cursorRow()).toBeNull(); // no cursor drawn outside steering
    stepInside();
    expect(m.wheels).toEqual([]);
    expect(m.term.scrollToBottom).not.toHaveBeenCalled();
    expect(m.cursorRow()).toBe(b.path);
    expect(m.container.querySelector(".steer-cursor")?.getAttribute("aria-current")).toBe("true");
  });

  it("E / D walk the files, then the links; moving opens and shows nothing", () => {
    const m = mount();
    stepInside();
    expect(m.cursorRow()).toBe(a.path);
    press({ key: "d" });
    expect(m.cursorRow()).toBe(b.path);
    press({ key: "d" });
    expect(m.cursorRow()).toBe(pr.url);
    press({ key: "d" });
    press({ key: "d" }); // the last row stays
    expect(m.cursorRow()).toBe(doc.url);
    press({ key: "e" });
    expect(m.cursorRow()).toBe(pr.url);
    expect(m.onPick).not.toHaveBeenCalled();
    expect(m.onOpenTab).not.toHaveBeenCalled();
    expect(m.onOpenLink).not.toHaveBeenCalled();
    expect(m.wheels).toEqual([]);
    expect(steering().level).toBe("scroll");
  });

  it("Shift+D / Shift+E jump between the Files and Links sections", () => {
    const m = mount();
    stepInside();
    press({ key: "D", shiftKey: true });
    expect(m.cursorRow()).toBe(pr.url);
    press({ key: "d" });
    press({ key: "E", shiftKey: true });
    expect(m.cursorRow()).toBe(a.path);
  });

  it("O opens the file as a tab, Shift+O in a new subwindow, V shows it here", () => {
    const m = mount();
    stepInside();
    press({ key: "d" });
    press({ key: "o" });
    expect(m.onOpenTab).toHaveBeenLastCalledWith(b, false);
    press({ key: "O", shiftKey: true });
    expect(m.onOpenTab).toHaveBeenLastCalledWith(b, true);
    expect(m.onPick).not.toHaveBeenCalled();
    press({ key: "v" });
    expect(m.onPick).toHaveBeenCalledWith(b);
    expect(m.onOpenTab).toHaveBeenCalledTimes(2);
    expect(steering().level).toBe("scroll");
  });

  it("opens a link through onOpenLink (both O and Shift+O); V does nothing on it", () => {
    const m = mount();
    stepInside();
    press({ key: "D", shiftKey: true });
    press({ key: "o" });
    expect(m.onOpenLink).toHaveBeenLastCalledWith(pr.url);
    press({ key: "O", shiftKey: true });
    expect(m.onOpenLink).toHaveBeenCalledTimes(2);
    press({ key: "v" });
    expect(m.onPick).not.toHaveBeenCalled();
    expect(m.onOpenTab).not.toHaveBeenCalled();
  });

  it("ignores key repeat on O and V", () => {
    const m = mount();
    stepInside();
    press({ key: "o", repeat: true });
    press({ key: "v", repeat: true });
    expect(m.onOpenTab).not.toHaveBeenCalled();
    expect(m.onPick).not.toHaveBeenCalled();
  });

  it("opens no tab for a file no viewer shows", () => {
    const m = mount({ files: [fileOf(stl)], links: [], picked: stl });
    stepInside();
    press({ key: "o" });
    expect(m.onOpenTab).not.toHaveBeenCalled();
    press({ key: "v" });
    expect(m.onPick).toHaveBeenCalledWith(stl);
  });

  it("S / F scroll the shown file half a screen (Shift: a whole one) and never the terminal", () => {
    const m = mount();
    stepInside();
    const box = m.getByTestId("file-viewer");
    press({ key: "f" });
    expect(box.scrollTop).toBe(180);
    press({ key: "F", shiftKey: true });
    expect(box.scrollTop).toBe(540);
    press({ key: "s" });
    expect(box.scrollTop).toBe(360);
    expect(m.wheels).toEqual([]);
    expect(m.term.scrollLines).not.toHaveBeenCalled();
    expect(steering().level).toBe("scroll");
  });

  it("answers S / F as handled even with nothing to scroll (a picture, no file shown)", () => {
    const m = mount({ files: [], links: [pr], picked: null });
    stepInside();
    press({ key: "f" });
    press({ key: "s" });
    expect(m.wheels).toEqual([]);
    expect(m.term.scrollLines).not.toHaveBeenCalled();
    expect(steering().level).toBe("scroll");
  });

  it("E on the first row returns to the tabs; a held E does not", () => {
    const m = mount();
    stepInside();
    press({ key: "e", repeat: true });
    expect(steering().level).toBe("scroll");
    expect(m.cursorRow()).toBe(a.path);
    press({ key: "e" });
    expect(steering().level).toBe("tabs");
    expect(steering().active).toBe(true);
    // Back at the tabs level the cursor is no longer drawn.
    expect(m.cursorRow()).toBeNull();
  });

  it("Enter is Work here: it leaves steering and opens nothing; Z U N are swallowed", () => {
    const m = mount();
    stepInside();
    press({ key: "z" });
    press({ key: "u" });
    press({ key: "n" });
    expect(m.onOpenTab).not.toHaveBeenCalled();
    expect(m.onPick).not.toHaveBeenCalled();
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(steering().level).toBe("scroll");
    press({ key: "Enter" });
    expect(steering().active).toBe(false);
    expect(m.onOpenTab).not.toHaveBeenCalled();
    expect(m.onOpenLink).not.toHaveBeenCalled();
  });

  it("keeps the highlight on its row when a row arrives above it, and snaps back when its row goes", () => {
    const m = mount();
    stepInside();
    press({ key: "d" });
    expect(m.cursorRow()).toBe(b.path);
    const c = entryOf("c.md");
    m.rerender({ files: [fileOf(c), fileOf(a), fileOf(b)] });
    expect(m.cursorRow()).toBe(b.path);
    m.rerender({ files: [fileOf(c), fileOf(a)], picked: a });
    expect(m.cursorRow()).toBe(a.path);
  });

  it("registers no target while the pane is hidden, and drops it on hide or unmount", () => {
    const m = mount({ visible: false });
    expect(readerInsideFor(m.id)).toBeNull();
    m.rerender({ visible: true });
    expect(readerInsideFor(m.id)?.view).toBe("files");
    m.rerender({ visible: false });
    expect(readerInsideFor(m.id)).toBeNull();
    m.rerender({ visible: true });
    m.unmount();
    expect(readerInsideFor(m.id)).toBeNull();
  });

  it("lists the Files rows in the legend", () => {
    const state: SteeringLegendState = {
      level: "scroll",
      sideRegion: false,
      multiPane: false,
      apps: { mail: false, calendar: false, todo: false },
      terminal: true,
      reader: { view: "files" },
      agent: { clear: true, plan: true, goal: true, prompt: true },
      statusCounts: { decision: 0, working: 0, done: 0 },
    };
    const labels = steeringKeysFor(state).map((k) => k.labelKey);
    expect(labels).toEqual(
      expect.arrayContaining([
        "steering.readerFiles.walk.label",
        "steering.readerFiles.section.label",
        "steering.readerFiles.scroll.label",
        "steering.readerFiles.open.label",
        "steering.readerFiles.show.label",
      ]),
    );
    const diffs = steeringKeysFor({ ...state, reader: { view: "changes" } }).map((k) => k.labelKey);
    expect(diffs).not.toContain("steering.readerFiles.walk.label");
  });
});
