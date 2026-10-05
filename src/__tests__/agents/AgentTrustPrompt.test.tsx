/**
 * A new Claude tab in a folder Claude has never been trusted in must NOT be
 * auto-typed at.
 *
 * Every Claude tab carries an `initialInput` of `/rename <project>`, submitted
 * with a bare Enter a beat after the TUI starts drawing. In an untrusted folder
 * the first thing Claude draws is its trust dialog, whose highlighted row is
 * `No, exit` — so that Enter answered it and the tab died on launch with
 * nothing but `[process exited]`. Every box folder is new, which is where this
 * surfaced, but a freshly created project hit it just as hard.
 *
 * The gate asks the backend whether the question is coming and, when it is,
 * leaves the tab entirely alone: the user answers, and the rename is skipped.
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

// What the mocked xterm's active buffer shows — one line per entry.
const { screen } = vi.hoisted(() => ({ screen: { lines: [] as string[] } }));

// The PTY event bus, captured so the test can fire `terminal-ready` and a first
// output chunk the way the backend would.
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
    loadAddon() {}
    open() {}
    write() {}
    onData() {}
    onResize() {}
    onBell() {}
    onTitleChange() {}
    onSelectionChange() {}
    buffer = {
      active: {
        get length() { return screen.lines.length; },
        getLine: (i: number) =>
          i < screen.lines.length
            ? { translateToString: () => screen.lines[i] }
            : null,
      },
    };
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
import { clearClaimedInitialInputsForTest } from "../../lib/terminal/terminalControl";
import { BRAND, NAMES } from "../../lib/brand";

/** Fire `terminal-ready` plus a first output chunk, then let the boot cushion
 *  and the type/Enter timers run out. */
async function launch(id: string) {
  await act(async () => {
    bus.ready.get(id)?.();
    bus.output.get(id)?.("\x1b[?25l");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
}

function writes(): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === "pty_write");
}

describe("auto-typed initial input vs. Claude's trust dialog", () => {
  beforeEach(() => {
    invoke.mockClear();
    bus.ready.clear();
    bus.output.clear();
    clearClaimedInitialInputsForTest();
    screen.lines = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    invoke.mockImplementation(() => Promise.resolve(undefined));
  });

  it("types nothing into a Claude tab whose folder is not trusted yet", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? false : undefined),
    );
    const id = "box:b1:t1";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd={`/home/u/${BRAND.slug}/boxes/new-box`}
          kind="agent"
          initialInput="/rename New Box"
          visible
          focused
        />,
      );
    });
    await launch(id);

    const probe = invoke.mock.calls.find((c) => c[0] === "claude_folder_trusted");
    expect(probe?.[1]).toEqual({
      cwd: `/home/u/${BRAND.slug}/boxes/new-box`,
      projectId: null,
      sandbox: false,
      localOnly: false,
    });
    // Neither the rename text nor — the fatal half — the Enter that would have
    // confirmed `No, exit`.
    expect(writes()).toHaveLength(0);
  });

  it("still types the rename once the folder is trusted", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? true : undefined),
    );
    const id = "p1:t1";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd={`/home/u/${BRAND.slug}/projects/p`}
          kind="agent"
          initialInput="/rename P"
          visible
          focused
        />,
      );
    });
    await launch(id);

    // The text, then the Enter as its own write.
    expect(writes().length).toBeGreaterThanOrEqual(2);
  });

  it("passes the tab's scope, so the backend knows which trust store the spawn reads", async () => {
    // Trust Tabtivity recorded inside the fence lives only in the fence's staged
    // `.claude.json`; an unfenced tab reads the host file. Turning a project's
    // fence off made the probe answer "trusted" from the record while the
    // unfenced Claude asked anyway — and the rename's Enter said `No, exit`.
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? false : undefined),
    );
    const id = "p9:t1";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd={`/home/u/${BRAND.slug}/projects/audio`}
          kind="agent"
          projectId="p9"
          initialInput="/rename Audio"
          visible
          focused
        />,
      );
    });
    await launch(id);

    const probe = invoke.mock.calls.find((c) => c[0] === "claude_folder_trusted");
    expect(probe?.[1]).toEqual({
      cwd: `/home/u/${BRAND.slug}/projects/audio`,
      projectId: "p9",
      sandbox: false,
      localOnly: false,
    });
    expect(writes()).toHaveLength(0);
  });

  it("types nothing while the trust dialog is on screen, even if the probe says trusted", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd === "claude_folder_trusted" ? true : undefined),
    );
    screen.lines = [
      " Accessing workspace:",
      " Quick safety check: Is this a project you created or one you trust?",
      " ❯ 1. Yes, I trust this folder",
      "   2. No, exit",
    ];
    const id = "p9:t2";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd={`/home/u/${BRAND.slug}/projects/audio`}
          kind="agent"
          initialInput="/rename Audio"
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["codex", [`> You are in /home/u/${BRAND.slug}/projects/new`, "  Do you trust the contents of this directory? Working with untrusted", "  contents comes with higher risk of prompt injection.", "› 1. Yes, continue", "  2. No, quit"]],
    ["gemini", [" Do you trust the files in this folder?", " ● 1. Trust folder (new)", "   2. Trust parent folder (projects)", "   3. Don't trust"]],
  ])("types nothing into a %s tab showing its trust question", async (cmd, lines) => {
    screen.lines = lines;
    const id = `p9:${cmd}`;
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd={cmd}
          cwd={`/home/u/${BRAND.slug}/projects/new`}
          kind="agent"
          initialInput={`Read ${NAMES.projectDir}/scaffold-fill.md and complete the task.`}
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(writes()).toHaveLength(0);
    // The backend probe reads Claude's config only; other CLIs are judged by
    // their screen alone.
    expect(invoke.mock.calls.some((c) => c[0] === "claude_folder_trusted")).toBe(false);
  });

  it("still types into a non-Claude agent that asks nothing", async () => {
    screen.lines = [" >_ OpenAI Codex", " To get started, describe a task"];
    const id = "p9:codex-ok";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="codex"
          cwd={`/home/u/${BRAND.slug}/projects/p`}
          kind="agent"
          initialInput="/hooks"
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(writes().length).toBeGreaterThanOrEqual(2);
  });

  it("does not probe for a non-Claude tab, and still types its input", async () => {
    // A shell tab's initialInput is a command the user asked to run; Claude's
    // trust dialog has nothing to do with it.
    const id = "p1:sh";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="bash"
          cwd={`/home/u/${BRAND.slug}/projects/p`}
          kind="shell"
          initialInput="pytest -q"
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(invoke.mock.calls.some((c) => c[0] === "claude_folder_trusted")).toBe(false);
    expect(writes().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the old behavior when the backend has no such probe", async () => {
    invoke.mockImplementation((cmd: unknown) =>
      cmd === "claude_folder_trusted"
        ? Promise.reject(new Error("unknown command"))
        : Promise.resolve(undefined),
    );
    const id = "p1:old";
    await act(async () => {
      render(
        <TerminalView
          id={id}
          cmd="claude"
          cwd={`/home/u/${BRAND.slug}/projects/p`}
          kind="agent"
          initialInput="/rename P"
          visible
          focused
        />,
      );
    });
    await launch(id);

    expect(writes().length).toBeGreaterThanOrEqual(2);
  });
});
