/**
 * Performance plan §5.3, terminal kinds (`TerminalView` +
 * `lib/terminal/sleepingPtys`): a terminal pane put to sleep is unmounted but
 * its PTY keeps running — no `pty_kill`, its view leaves with `sleeping` — and
 * the pane mounted on wake takes the PTY over through the attach path (view
 * registered, then the wake's catch-up read) instead of spawning, as long as
 * its spawn identity is unchanged. A changed identity respawns; closing the
 * tab while asleep kills the PTY. A sleeping agent stays reachable for
 * scheduled prompts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode, type ReactElement } from "react";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, terminals, bus } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  terminals: [] as { opened: boolean; disposed: boolean; writes: string[] }[],
  bus: { ready: new Map<string, () => void>() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalOutput: () => () => {},
  onTerminalReplay: () => () => {},
  onTerminalReady: (id: string, h: () => void) => {
    bus.ready.set(id, h);
    return () => bus.ready.delete(id);
  },
  onTerminalExit: () => () => {},
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    state = { opened: false, disposed: false, writes: [] as string[] };
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: true };
    constructor() {
      terminals.push(this.state);
    }
    loadAddon() {}
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
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import {
  _clearAsleepPtysForTest,
  asleepPty,
  killAsleepPty,
  markPtyAsleep,
} from "../../lib/terminal/sleepingPtys";
import { scheduledAgentInput, _clearScheduledAgentInputsForTest } from "../../lib/agents/scheduledAgentInput";

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
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

const ID = "p:agent-1";
function agentPane(extra: Partial<Parameters<typeof TerminalView>[0]> = {}): ReactElement {
  return (
    <TerminalView
      id={ID}
      cmd="claude"
      cwd="/p"
      kind="agent"
      scheduleTargetId="target-1"
      initialInput="hello"
      visible={false}
      focused={false}
      {...extra}
    />
  );
}

/** Mount a pane, let it spawn and report ready, then put it to sleep the way
 *  the pane layer does: mark the PTY asleep, then unmount the view. */
async function mountAndSleep(ui: ReactElement = agentPane()) {
  let unmount = () => {};
  await act(async () => {
    unmount = render(ui).unmount;
  });
  expect(calls("pty_spawn")).toHaveLength(1);
  await act(async () => {
    bus.ready.get(ID)?.();
  });
  invoke.mockClear();
  markPtyAsleep(ID);
  await act(async () => {
    unmount();
  });
}

describe("TerminalView — sleeping terminal panes (§5.3)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve(undefined));
    terminals.length = 0;
    bus.ready.clear();
    _clearAsleepPtysForTest();
    _clearScheduledAgentInputsForTest();
    giveLayout(true);
  });
  afterEach(() => {
    _clearAsleepPtysForTest();
    _clearScheduledAgentInputsForTest();
  });

  it("sleeping unmounts the view without killing the PTY and tells the router it sleeps", async () => {
    await mountAndSleep();
    expect(names()).not.toContain("pty_kill");
    expect(calls("pty_remove_view")).toHaveLength(1);
    expect(calls("pty_remove_view")[0][1]).toMatchObject({ id: ID, sleeping: true });
    expect(asleepPty(ID)?.spawnKey).toBeTruthy();
    expect(asleepPty(ID)?.ready).toBe(true);
  });

  it("an ordinary unmount (no sleep) still kills the PTY", async () => {
    let unmount = () => {};
    await act(async () => {
      unmount = render(agentPane()).unmount;
    });
    await act(async () => {
      unmount();
    });
    expect(names()).toContain("pty_kill");
    expect(calls("pty_remove_view")[0][1]).toMatchObject({ sleeping: false });
  });

  it("waking with the same spawn props attaches: view first, then the wake read — never a spawn", async () => {
    await mountAndSleep();
    invoke.mockClear();
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd === "pty_scrollback" ? { data: "$ earlier output\r\n", startOffset: 0, endOffset: 18 } : undefined,
      ),
    );
    await act(async () => {
      render(agentPane({ visible: true, focused: true }));
    });
    expect(names()).not.toContain("pty_spawn");
    expect(names()).not.toContain("pty_kill");
    const scrollback = calls("pty_scrollback");
    expect(scrollback).toHaveLength(1);
    expect(scrollback[0][1]).toEqual({ id: ID, wake: true });
    expect(names().indexOf("pty_set_visible")).toBeLessThan(names().indexOf("pty_scrollback"));
    expect(asleepPty(ID)).toBeUndefined();
    // The catch-up reached the new terminal; the initial line was not retyped.
    expect(terminals[terminals.length - 1]?.writes.join("")).toContain("earlier output");
    expect(names()).not.toContain("pty_write");
  });

  it("a program that ended while asleep says so on wake", async () => {
    await mountAndSleep();
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd === "pty_scrollback" ? { data: "done\r\n", startOffset: 0, endOffset: 6, exited: true } : undefined,
      ),
    );
    await act(async () => {
      render(agentPane({ visible: true, focused: true }));
    });
    expect(terminals[terminals.length - 1]?.writes.join("")).toContain("[process exited]");
  });

  it("waking with changed spawn props (a relaunch while asleep) kills the parked PTY and spawns", async () => {
    await mountAndSleep();
    invoke.mockClear();
    await act(async () => {
      render(agentPane({ relaunchSeq: 1 }));
    });
    expect(names()).toContain("pty_kill");
    expect(names().indexOf("pty_kill")).toBeLessThan(names().indexOf("pty_spawn"));
    expect(names()).not.toContain("pty_scrollback");
    expect(asleepPty(ID)).toBeUndefined();
  });

  it("Strict Mode's replay of a waking mount neither kills nor spawns", async () => {
    await mountAndSleep();
    invoke.mockClear();
    await act(async () => {
      render(<StrictMode>{agentPane()}</StrictMode>);
    });
    expect(names()).not.toContain("pty_kill");
    expect(names()).not.toContain("pty_spawn");
    expect(calls("pty_scrollback")).toHaveLength(1);
  });

  it("closing the tab while asleep kills the PTY (no view exists to do it)", async () => {
    await mountAndSleep();
    expect(killAsleepPty(ID)).toBe(true);
    expect(calls("pty_kill")).toEqual([["pty_kill", { id: ID }]]);
    expect(asleepPty(ID)).toBeUndefined();
    expect(killAsleepPty(ID)).toBe(false);
  });

  it("a sleeping agent stays a scheduled-prompt target until it wakes or closes", async () => {
    await mountAndSleep();
    const parked = scheduledAgentInput("target-1");
    expect(parked?.ptyId).toBe(ID);
    expect(parked?.bracketedPaste()).toBe(false); // the pane never built a terminal
    await act(async () => {
      render(agentPane());
    });
    // The woken view registers its own input in place of the stand-in.
    expect(scheduledAgentInput("target-1")).toBeDefined();
    expect(scheduledAgentInput("target-1")).not.toBe(parked);
  });

  it("closing a sleeping agent drops its scheduled-prompt stand-in", async () => {
    await mountAndSleep();
    expect(scheduledAgentInput("target-1")).toBeDefined();
    killAsleepPty(ID);
    expect(scheduledAgentInput("target-1")).toBeUndefined();
  });
});
