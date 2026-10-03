/**
 * What the user types into a fresh agent tab before its auto-typed launch line
 * (Claude's `/rename <project>`, which names the Remote Control session) is in
 * must not run into that line.
 *
 * The rename is typed a second or more after launch, once the TUI has booted;
 * keystrokes made meanwhile landed in the same input box, and the tab
 * submitted `/rename Phello`. They are now held until the rename is submitted
 * and replayed after it — or dropped when the launch types nothing after all,
 * since flushed into Claude's trust dialog an Enter would answer `No, exit`.
 *
 * A host Claude new enough for `--name` (2.1.76+) is named on the launch argv
 * instead (`pty_spawn` answers `named`), and then nothing is typed or held.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

// The mocked xterm's keyboard callback, so the test can "type".
const { keys } = vi.hoisted(() => ({ keys: { onData: null as ((d: string) => void) | null } }));

const { bus } = vi.hoisted(() => ({
  bus: {
    ready: new Map<string, () => void>(),
    output: new Map<string, (data: string) => void>(),
  },
}));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalOutput: (id: string, h: (data: string) => void) => {
    bus.output.set(id, h);
    return () => bus.output.delete(id);
  },
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
    modes = {};
    loadAddon() {}
    open() {}
    write() {}
    onData(h: (d: string) => void) { keys.onData = h; }
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange() {}
    buffer = { active: { length: 0, getLine: () => null } };
    attachCustomKeyEventHandler() {}
    getSelection() { return ""; }
    focus() {}
    dispose() {}
    options = {};
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ settings: { color_scheme: "dark" } }),
  ),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { claudeLaunchName, clearClaimedInitialInputsForTest } from "../../lib/terminal/terminalControl";

/** Everything written to the PTY, in order, as text. */
function written(): string {
  const dec = new TextDecoder();
  return invoke.mock.calls
    .filter((c) => c[0] === "pty_write")
    .map((c) => dec.decode((c[1] as { data: Uint8Array }).data))
    .join("");
}

async function openClaudeTab(id: string, trusted: boolean, named = false) {
  invoke.mockImplementation((cmd: unknown) =>
    Promise.resolve(
      cmd === "claude_folder_trusted" ? trusted : cmd === "pty_spawn" ? { named } : undefined,
    ),
  );
  await act(async () => {
    render(
      <TerminalView id={id} cmd="claude" cwd="/p" kind="agent" initialInput="/rename P" visible focused />,
    );
  });
}

async function type(text: string) {
  await act(async () => {
    for (const ch of text) keys.onData?.(ch);
  });
}

describe("keystrokes typed before an agent tab's launch line", () => {
  beforeEach(() => {
    invoke.mockClear();
    bus.ready.clear();
    bus.output.clear();
    keys.onData = null;
    clearClaimedInitialInputsForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    invoke.mockImplementation(() => Promise.resolve(undefined));
  });

  it("are replayed after the rename is submitted, not appended to it", async () => {
    const id = "p1:t1";
    await openClaudeTab(id, true);
    await type("hel");
    await act(async () => {
      bus.ready.get(id)?.();
      bus.output.get(id)?.("\x1b[?25l");
    });
    await type("lo");
    expect(written()).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(written()).toBe("/rename P\rhello");

    // Once the rename is in, keys go straight through again.
    await type("!");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(written()).toBe("/rename P\rhello!");
  });

  it("are dropped when the launch leaves the tab alone for the trust dialog", async () => {
    const id = "p2:t1";
    await openClaudeTab(id, false);
    await type("x\r");
    await act(async () => {
      bus.ready.get(id)?.();
      bus.output.get(id)?.("\x1b[?25l");
      await vi.advanceTimersByTimeAsync(8000);
    });
    // Nothing — above all no Enter to answer `No, exit` with.
    expect(written()).toBe("");
    await type("1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(written()).toBe("1");
  });

  it("never holds the keyboard for good when the spawn never reports ready", async () => {
    const id = "p3:t1";
    await openClaudeTab(id, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });
    await type("y");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(written()).toBe("y");
  });

  it("types nothing when the backend named the session at launch, and lets keys through at once", async () => {
    const id = "p5:t1";
    await openClaudeTab(id, true, true);
    const spawnCall = invoke.mock.calls.find((c) => c[0] === "pty_spawn");
    expect((spawnCall?.[1] as { sessionName?: string }).sessionName).toBe("P");
    await type("hi");
    await act(async () => {
      bus.ready.get(id)?.();
      bus.output.get(id)?.("\x1b[?25l");
      await vi.advanceTimersByTimeAsync(8000);
    });
    // No `/rename` line and no Enter — only what the user typed.
    expect(written()).toBe("hi");
  });

  it("still types the rename when the backend could not name it (old CLI, container, remote)", async () => {
    const id = "p6:t1";
    await openClaudeTab(id, true, false);
    await act(async () => {
      bus.ready.get(id)?.();
      bus.output.get(id)?.("\x1b[?25l");
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(written()).toBe("/rename P\r");
  });

  // TODO #2347: a browser page that opens a tab another page already runs
  // gets its own tmux client onto the running program; the launch types
  // nothing into it — no `/rename`, no run command — and keys pass at once.
  it("types nothing into a tab another page already runs (`attached`)", async () => {
    const id = "p7:t1";
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? true : cmd === "pty_spawn" ? { attached: true } : undefined),
    );
    await act(async () => {
      render(<TerminalView id={id} cmd="claude" cwd="/p" kind="agent" initialInput="/rename P" visible focused />);
    });
    await type("hi");
    await act(async () => {
      bus.ready.get(id)?.();
      bus.output.get(id)?.("\x1b[?25l");
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(written()).toBe("hi");
  });

  it("does not re-run a joined shell tab's command", async () => {
    const id = "p8:t1";
    invoke.mockImplementation((cmd: unknown) => Promise.resolve(cmd === "pty_spawn" ? { attached: true } : undefined));
    await act(async () => {
      render(<TerminalView id={id} cmd="bash" cwd="/p" kind="shell" initialInput="make" visible focused />);
    });
    await act(async () => {
      bus.ready.get(id)?.();
      bus.output.get(id)?.("$ ");
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(written()).toBe("");
  });

  it("leaves a shell tab's typing alone", async () => {
    const id = "p4:t1";
    await act(async () => {
      render(<TerminalView id={id} cmd="bash" cwd="/p" kind="shell" initialInput="make" visible focused />);
    });
    await type("z");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(written()).toBe("z");
  });
});

describe("claudeLaunchName", () => {
  it("reads the name off a Claude tab's /rename line", () => {
    expect(claudeLaunchName("claude", "/rename p1 (feature)")).toBe("p1 (feature)");
    expect(claudeLaunchName("/usr/local/bin/claude", "/rename  Proj ")).toBe("Proj");
  });

  it("is null for other agents, other input, or an empty name", () => {
    expect(claudeLaunchName("codex", "/rename P")).toBeNull();
    expect(claudeLaunchName("claude", "Read notes.md and do the task")).toBeNull();
    expect(claudeLaunchName("claude", "/rename ")).toBeNull();
    expect(claudeLaunchName("claude", undefined)).toBeNull();
  });
});
