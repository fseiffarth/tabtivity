/**
 * Renderer hibernation: an OPEN terminal pane that stays hidden for
 * RENDERER_RELEASE_MS gives its renderer addon back (the canvas renderer's four
 * full-pane canvases keep their backing stores under `display: none`; WebGL
 * holds a context), and re-loads it the moment it is shown again. Every tab of
 * every open project stays mounted, so this is what a background project's
 * terminals cost. Nothing else about the terminal may change: the xterm itself
 * (buffer, scrollback) is never disposed and the PTY is never touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, addons, terminals } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
  addons: [] as { kind: string; disposed: boolean }[],
  terminals: [] as { opened: boolean; disposed: boolean }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    state = { opened: false, disposed: false };
    options: Record<string, unknown> = {};
    constructor() {
      terminals.push(this.state);
    }
    loadAddon() {}
    open() {
      this.state.opened = true;
    }
    write() {}
    onData() {}
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange() {}
    buffer = { active: { length: 0, getLine: () => null } };
    attachCustomKeyEventHandler() {}
    getSelection() {
      return "";
    }
    focus() {}
    dispose() {
      this.state.disposed = true;
    }
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    state = { kind: "canvas", disposed: false };
    constructor() {
      addons.push(this.state);
    }
    dispose() {
      this.state.disposed = true;
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    state = { kind: "webgl", disposed: false };
    constructor() {
      addons.push(this.state);
    }
    onContextLoss() {}
    dispose() {
      this.state.disposed = true;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

let terminalWebgl: boolean | undefined;
vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ settings: { color_scheme: "dark", terminal_webgl: terminalWebgl } }),
  ),
  resolveTheme: (s: string) => s,
}));

import { TerminalView, RENDERER_RELEASE_MS } from "../../components/terminal/TerminalView";

function giveLayout(on: boolean) {
  for (const [prop, value] of [
    ["clientWidth", on ? 800 : 0],
    ["clientHeight", on ? 600 : 0],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
  }
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return on ? document.body : null;
    },
  });
}

const live = (kind: string) => addons.filter((a) => a.kind === kind && !a.disposed);

async function mountOpen(id: string) {
  let rerender: (ui: React.ReactElement) => void = () => {};
  await act(async () => {
    const r = render(<TerminalView id={id} cmd="bash" cwd="/p" visible focused={false} />);
    rerender = r.rerender;
  });
  expect(terminals[0]?.opened).toBe(true);
  expect(live("canvas")).toHaveLength(1);
  const show = async (visible: boolean) => {
    await act(async () => {
      rerender(<TerminalView id={id} cmd="bash" cwd="/p" visible={visible} focused={false} />);
    });
  };
  return show;
}

describe("TerminalView — renderer hibernation of long-hidden panes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
    addons.length = 0;
    terminals.length = 0;
    terminalWebgl = undefined;
    giveLayout(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the canvas renderer after the hidden delay and re-loads it on show", async () => {
    const show = await mountOpen("p:a");
    await show(false);

    await act(async () => {
      vi.advanceTimersByTime(RENDERER_RELEASE_MS - 1);
    });
    expect(live("canvas")).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(live("canvas")).toHaveLength(0);
    // The terminal itself — buffer, scrollback — is never disposed, and the
    // PTY is never killed by a hibernation.
    expect(terminals[0].disposed).toBe(false);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "pty_kill")).toBe(false);

    await show(true);
    expect(live("canvas")).toHaveLength(1);
    expect(addons).toHaveLength(2);
    expect(terminals).toHaveLength(1);
  });

  it("keeps the renderer of a pane shown again before the delay runs out", async () => {
    const show = await mountOpen("p:b");
    await show(false);
    await act(async () => {
      vi.advanceTimersByTime(RENDERER_RELEASE_MS / 2);
    });
    await show(true);
    await act(async () => {
      vi.advanceTimersByTime(RENDERER_RELEASE_MS * 2);
    });
    expect(addons).toHaveLength(1);
    expect(live("canvas")).toHaveLength(1);
  });

  it("does not re-load a released renderer when the WebGL flag moves while hidden", async () => {
    const show = await mountOpen("p:c");
    await show(false);
    await act(async () => {
      vi.advanceTimersByTime(RENDERER_RELEASE_MS);
    });
    expect(addons.filter((a) => !a.disposed)).toHaveLength(0);

    terminalWebgl = true;
    await show(false);
    expect(addons.filter((a) => !a.disposed)).toHaveLength(0);

    // Shown again: the CURRENT choice is what comes back.
    await show(true);
    expect(live("webgl")).toHaveLength(1);
    expect(live("canvas")).toHaveLength(0);
  });
});
