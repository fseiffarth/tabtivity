/**
 * Performance plan §5.2 and §3.2 (`TerminalView`): the xterm is built on the
 * pane's first show, not at mount — every tab of every active project mounts
 * at launch and most are hidden — while the PTY spawn is not deferred (the
 * phone may tmux-start a listed tab first). Output before the first show is
 * kept and written once the terminal exists. And a refit tells the PTY its
 * new size once per burst, on a trailing debounce, never losing the last one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, terminals, size, bus } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  terminals: [] as { opened: boolean; disposed: boolean; writes: string[] }[],
  /** What the (mocked) fit addon measures the pane as. */
  size: { cols: 80, rows: 24 },
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

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    state = { opened: false, disposed: false, writes: [] as string[] };
    options: Record<string, unknown> = {};
    modes = {};
    constructor() {
      terminals.push(this.state);
    }
    loadAddon(addon: { attach?: (t: unknown) => void }) {
      addon.attach?.(this);
    }
    open() {
      this.state.opened = true;
    }
    write(data: string, done?: () => void) {
      this.state.writes.push(data);
      done?.();
    }
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
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: { cols: number; rows: number } | null = null;
    attach(term: { cols: number; rows: number }) {
      this.term = term;
    }
    fit() {
      if (this.term) {
        this.term.cols = size.cols;
        this.term.rows = size.rows;
      }
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";

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

const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

describe("TerminalView — the xterm is built on first show", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
    terminals.length = 0;
    bus.output.clear();
    size.cols = 80;
    size.rows = 24;
    giveLayout(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the PTY of a hidden pane without building a terminal, and writes what arrived meanwhile on show", async () => {
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const r = render(<TerminalView id="p:lazy" cmd="bash" cwd="/p" visible={false} focused={false} />);
      rerender = r.rerender;
    });
    expect(terminals).toHaveLength(0);
    // Not deferred with the terminal: the PTY starts at mount, hidden or not.
    expect(calls("pty_spawn")).toHaveLength(1);

    bus.output.get("p:lazy")?.("booted\r\n");
    expect(terminals).toHaveLength(0);

    await act(async () => {
      rerender(<TerminalView id="p:lazy" cmd="bash" cwd="/p" visible focused={false} />);
    });
    expect(terminals).toHaveLength(1);
    expect(terminals[0].opened).toBe(true);
    expect(terminals[0].writes.join("")).toContain("booted");
  });

  it("builds nothing for a pane that is unmounted before it was ever shown, and still kills its PTY", async () => {
    let unmount = () => {};
    await act(async () => {
      unmount = render(<TerminalView id="p:never" cmd="bash" cwd="/p" visible={false} focused={false} />).unmount;
    });
    await act(async () => {
      unmount();
    });
    expect(terminals).toHaveLength(0);
    expect(calls("pty_kill")).toHaveLength(1);
  });

  it("tells the PTY one size per refit burst — the last — and flushes a pending one on unmount", async () => {
    let unmount = () => {};
    await act(async () => {
      unmount = render(<TerminalView id="p:fit" cmd="bash" cwd="/p" visible focused={false} />).unmount;
    });
    expect(terminals[0]?.opened).toBe(true);
    // The first size goes at once, with the open; the open-time refits (next
    // frame, 300 ms) are drained here so the burst below stands on its own.
    expect(calls("pty_resize")).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(500); });
    invoke.mockClear();

    size.cols = 100;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    size.cols = 120;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    size.cols = 132;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(calls("pty_resize")).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(80); });
    expect(calls("pty_resize")).toHaveLength(1);
    expect(calls("pty_resize")[0][1]).toMatchObject({ id: "p:fit", cols: 132, rows: 24 });

    invoke.mockClear();
    size.rows = 40;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await act(async () => { unmount(); });
    expect(calls("pty_resize")).toHaveLength(1);
    expect(calls("pty_resize")[0][1]).toMatchObject({ cols: 132, rows: 40 });
  });
});
