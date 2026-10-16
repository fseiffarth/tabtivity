/**
 * `TerminalView` on the REAL xterm 6 and its real addons (fit, web-links,
 * WebGL) — every other TerminalView test mocks them, so this is the one place
 * the pane's wiring meets the package it ships with:
 *
 *  - keys reach the PTY as the agent CLIs need them: Shift+Tab as the legacy
 *    backtab (CSI-u in a Codex pane), and Alt+arrow as the word jump xterm 6
 *    no longer sends itself (`altArrowWordJump`), exactly once;
 *  - with the WebGL flag on, the real WebGL addon fails in a webview without
 *    WebGL2 (jsdom has none) and the pane keeps painting with xterm's DOM
 *    renderer — output still lands on screen;
 *  - copy-on-select and keyboard select read the real buffer and selection.
 *
 * Only the Tauri side (invoke, the output bus) and the settings store are
 * stand-ins.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installXtermLayout } from "../helpers/realXterm";

const { invoke, bus } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  bus: { output: new Map<string, (data: string) => void>() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalOutput: (id: string, h: (data: string) => void) => {
    bus.output.set(id, h);
    return () => bus.output.delete(id);
  },
  onTerminalReplay: () => () => {},
  onTerminalReady: () => () => {},
  onTerminalExit: () => () => {},
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: { color_scheme: "dark", terminal_webgl: true } };
  return {
    useSettingsStore: Object.assign((sel: (s: object) => unknown) => sel(state), { getState: () => state }),
    resolveTheme: (s: string) => s,
  };
});

import { TerminalView } from "../../components/terminal/TerminalView";
import { CSI_U_SHIFT_TAB, LEGACY_SHIFT_TAB } from "../../lib/terminal/terminalControl";
import { terminalFor } from "../../lib/terminal/terminalRegistry";

/** Everything the pane wrote to `id`'s PTY so far, as text. */
function ptyInput(id: string): string {
  const decoder = new TextDecoder();
  return invoke.mock.calls
    .filter(([cmd, args]) => cmd === "pty_write" && (args as { id: string }).id === id)
    .map(([, args]) => decoder.decode((args as { data: Uint8Array }).data))
    .join("");
}

/** What the pane put on the clipboard, in order. */
const copied = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "copy_text_to_clipboard").map(([, args]) => (args as { text: string }).text);

async function mount(id: string, cmd: string) {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<TerminalView id={id} cmd={cmd} cwd="/p" visible focused={false} />));
  });
  const textarea = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  expect(textarea, "the real xterm opened into the pane").not.toBeNull();
  const term = terminalFor(id);
  expect(term).toBeDefined();
  const press = (init: KeyboardEventInit) =>
    act(() => {
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  /** PTY output for the pane, parsed into its real buffer. */
  const output = async (data: string) => {
    await waitFor(() => expect(bus.output.has(id)).toBe(true));
    await act(async () => {
      bus.output.get(id)!(data);
    });
    await waitFor(() => expect(term!.buffer.active.getLine(0)?.translateToString(true)).not.toBe(""));
  };
  return { container, press, term: term!, output };
}

const ALT_LEFT = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, altKey: true };
const ALT_RIGHT = { key: "ArrowRight", code: "ArrowRight", keyCode: 39, altKey: true };
const SHIFT_TAB = { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true };
const KEY_SELECT = { key: "X", code: "KeyX", keyCode: 88, ctrlKey: true, shiftKey: true };
const key = (k: string, mods: KeyboardEventInit = {}) => ({ key: k, ...mods });

describe("TerminalView on the real xterm 6", () => {
  let restoreLayout: () => void;
  beforeAll(() => {
    restoreLayout = installXtermLayout({ pane: { width: 800, height: 600 } });
  });
  afterAll(() => restoreLayout());
  beforeEach(() => {
    invoke.mockClear();
    bus.output.clear();
  });
  afterEach(() => cleanup());

  it("builds the terminal with the options it asks for", async () => {
    const { term } = await mount("p:opts", "bash");
    // Off, a Mac has no way to select out of a mouse-driven agent TUI.
    expect(term.options.macOptionClickForcesSelection).toBe(true);
    expect(term.options.cursorBlink).toBe(true);
    expect(term.options.allowProposedApi).toBe(false);
  });

  it("sends Alt+←/→ as the shell's word jump, once, not xterm 6's plain Alt arrow", async () => {
    const { press } = await mount("p:words", "bash");
    await press(ALT_LEFT);
    await press(ALT_RIGHT);
    await waitFor(() => expect(ptyInput("p:words")).toBe("\x1b[1;5D\x1b[1;5C"));
  });

  it("sends Shift+Tab as the legacy backtab, and as CSI-u in a Codex pane", async () => {
    const shell = await mount("p:backtab", "claude");
    await shell.press(SHIFT_TAB);
    await waitFor(() => expect(ptyInput("p:backtab")).toBe(LEGACY_SHIFT_TAB));

    const codex = await mount("p:codex", "codex");
    await codex.press(SHIFT_TAB);
    await waitFor(() => expect(ptyInput("p:codex")).toBe(CSI_U_SHIFT_TAB));
  });

  it("keeps painting with the DOM renderer when the real WebGL addon cannot get a context", async () => {
    const { container, output } = await mount("p:dom", "bash");
    await output("still painted\r\n");
    await waitFor(() => expect(container.querySelector(".xterm-rows")?.textContent).toContain("still painted"));
    expect(container.querySelector(".xterm-screen canvas")).toBeNull();
  });

  it("copies a selection as made, a soft-wrapped row rejoined", async () => {
    const { term, output } = await mount("p:copy", "bash");
    const long = "x".repeat(term.cols) + "yz";
    await output(`alpha beta\r\n${long}\r\n`);
    act(() => term.select(6, 0, 4));
    await waitFor(() => expect(copied()).toEqual(["beta"]));
    act(() => term.selectLines(1, 2));
    await waitFor(() => expect(copied()).toEqual(["beta", long]));
  });

  it("zooms an agent pane on Ctrl+wheel before xterm 6's scrollable element swallows it", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TerminalView id="p:zoom" cmd="claude" cwd="/p" visible focused={false} zoomable />));
    });
    const term = terminalFor("p:zoom")!;
    await waitFor(() => expect(bus.output.has("p:zoom")).toBe(true));
    await act(async () => {
      bus.output.get("p:zoom")!(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\r\n"));
    });
    await waitFor(() => expect(term.buffer.active.baseY).toBeGreaterThan(0));
    const screen = container.querySelector<HTMLElement>(".xterm-screen")!;
    const wheel = (ctrlKey: boolean) =>
      act(() => {
        screen.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      });
    const live = term.buffer.active.viewportY;
    const size = term.options.fontSize!;

    // Over scrollback: the font grows and the buffer stays where it was.
    await wheel(true);
    expect(term.options.fontSize).toBe(size + 1);
    expect(term.buffer.active.viewportY).toBe(live);

    // While the program tracks the mouse (tmux): zoomed, and no Ctrl+wheel
    // report reaches it.
    await act(async () => {
      bus.output.get("p:zoom")!("\x1b[?1000h\x1b[?1006h");
    });
    await waitFor(() => expect(term.modes.mouseTrackingMode).toBe("vt200"));
    await wheel(true);
    expect(term.options.fontSize).toBe(size + 2);
    expect(ptyInput("p:zoom")).toBe("");

    // A plain wheel is still xterm's: here, a report for the program.
    await wheel(false);
    await waitFor(() => expect(ptyInput("p:zoom")).toMatch(/^\x1b\[<64;\d+;\d+M$/));
    expect(term.options.fontSize).toBe(size + 2);
  });

  it("keyboard select walks the real buffer and copies what it drew", async () => {
    const { term, press, output } = await mount("p:keysel", "bash");
    await output("alpha beta gamma\r\nsecond row\r\n");
    await press(KEY_SELECT);
    // To the top, anchor, to the line end: the whole first row is drawn…
    await press(key("g"));
    await press(key("v"));
    await press(key("$", { shiftKey: true }));
    expect(term.getSelection()).toBe("alpha beta gamma");
    // …and copied on Enter, nothing of it typed into the PTY.
    await press(key("Enter", { code: "Enter", keyCode: 13 }));
    await waitFor(() => expect(copied()).toEqual(["alpha beta gamma"]));
    expect(term.hasSelection()).toBe(false);
    expect(ptyInput("p:keysel")).toBe("");
  });
});
