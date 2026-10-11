/**
 * Tab cost plan step 2 (`TerminalView` + `lib/terminal/scrollback`): a shell's
 * xterm is built with the `shell_scrollback_rows` cap (2,000 by default), an
 * agent's with a fixed 5,000; a settings change reaches an open terminal's
 * `options.scrollback` live — no `pty_kill`, no `pty_spawn` — and the tab cost
 * readout reports the real cap.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ReactElement } from "react";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, terminals, settings } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  terminals: [] as { options: Record<string, unknown>; built: Record<string, unknown> }[],
  settings: { current: { color_scheme: "dark" } as Record<string, unknown> },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalOutput: () => () => {},
  onTerminalReplay: () => () => {},
  onTerminalReady: () => () => {},
  onTerminalExit: () => () => {},
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    modes = { bracketedPasteMode: true };
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      terminals.push({ options: this.options, built: { ...opts } });
    }
    loadAddon() {}
    open() {}
    write(_data: string, done?: () => void) {
      done?.();
    }
    onData() {}
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange() {}
    buffer = { active: { length: 0, getLine: () => null }, normal: { length: 24 } };
    attachCustomKeyEventHandler() {}
    getSelection() {
      return "";
    }
    focus() {}
    dispose() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    parser = {
      registerOscHandler: () => ({ dispose() {} }),
      registerCsiHandler: () => ({ dispose() {} }),
    };
  },
}));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../stores/settings", () => {
  const useSettingsStore = Object.assign(
    vi.fn((sel: (s: object) => unknown) => sel({ settings: settings.current })),
    { getState: () => ({ settings: settings.current }) },
  );
  return { useSettingsStore, resolveTheme: (s: string) => s };
});

import { TerminalView } from "../../components/terminal/TerminalView";
import { terminalCost } from "../../lib/tabCost";
import { AGENT_SCROLLBACK_ROWS, SHELL_SCROLLBACK_DEFAULT } from "../../lib/terminal/scrollback";

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

const names = () => invoke.mock.calls.map(([c]) => c as string);

type Props = Parameters<typeof TerminalView>[0];
function pane(p: Partial<Props> & Pick<Props, "id" | "cmd">): ReactElement {
  return <TerminalView cwd="/p" visible focused={false} {...p} />;
}

async function mount(ui: ReactElement) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(ui);
  });
  return view;
}

describe("TerminalView — scrollback cap (tab cost plan step 2)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve(undefined));
    terminals.length = 0;
    settings.current = { color_scheme: "dark" };
    giveLayout(true);
  });

  it("builds a shell with the 2,000-line default and an agent with 5,000", async () => {
    await mount(pane({ id: "p:shell-1", cmd: "bash", kind: "shell" }));
    await mount(pane({ id: "p:agent-1", cmd: "claude", kind: "agent" }));
    expect(SHELL_SCROLLBACK_DEFAULT).toBe(2000);
    expect(AGENT_SCROLLBACK_ROWS).toBe(5000);
    expect(terminals.map((t) => t.built.scrollback)).toEqual([2000, 5000]);
  });

  it("reads the kind the spawn effect reads: a local model in the env is an agent, a bare command a shell", async () => {
    await mount(pane({ id: "p:local-1", cmd: "vibe", env: { VIBE_ACTIVE_MODEL: "m" } }));
    settings.current = { color_scheme: "dark", shell_scrollback_rows: 1000 };
    await mount(pane({ id: "p:conn-1", cmd: "ssh" }));
    expect(terminals.map((t) => t.built.scrollback)).toEqual([5000, 1000]);
  });

  it("applies a settings change to an open shell live, with no respawn, and the readout shows it", async () => {
    const view = await mount(pane({ id: "p:shell-1", cmd: "bash", kind: "shell" }));
    expect(names()).toContain("pty_spawn");
    expect(terminalCost("p:shell-1").cap).toBe(2000);
    invoke.mockClear();

    settings.current = { color_scheme: "dark", shell_scrollback_rows: 1000 };
    await act(async () => {
      view.rerender(pane({ id: "p:shell-1", cmd: "bash", kind: "shell" }));
    });
    expect(terminals).toHaveLength(1);
    expect(terminals[0].options.scrollback).toBe(1000);
    expect(terminalCost("p:shell-1").cap).toBe(1000);
    expect(names()).not.toContain("pty_kill");
    expect(names()).not.toContain("pty_spawn");
  });

  it("leaves an agent's cap alone when the shell setting moves", async () => {
    const view = await mount(pane({ id: "p:agent-1", cmd: "claude", kind: "agent" }));
    invoke.mockClear();
    settings.current = { color_scheme: "dark", shell_scrollback_rows: 10_000 };
    await act(async () => {
      view.rerender(pane({ id: "p:agent-1", cmd: "claude", kind: "agent" }));
    });
    expect(terminals[0].options.scrollback).toBe(5000);
    expect(names()).not.toContain("pty_kill");
    expect(names()).not.toContain("pty_spawn");
  });

  it("a terminal not built yet picks up the setting when it is first shown", async () => {
    giveLayout(false);
    const view = await mount(pane({ id: "p:shell-2", cmd: "bash", kind: "shell", visible: false }));
    expect(terminals).toHaveLength(0);
    settings.current = { color_scheme: "dark", shell_scrollback_rows: 5000 };
    giveLayout(true);
    await act(async () => {
      view.rerender(pane({ id: "p:shell-2", cmd: "bash", kind: "shell", visible: true }));
    });
    expect(terminals.map((t) => t.built.scrollback)).toEqual([5000]);
  });
});
