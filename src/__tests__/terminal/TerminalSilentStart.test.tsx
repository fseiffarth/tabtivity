/**
 * A tab whose launch never completes used to stay blank with nothing to say why
 * (a "+ OpenCode" tab, 2026-09-15: plain white, no cursor, no opencode process
 * ever started). After SILENT_START_MS a tab that owns its launch and has shown
 * nothing now says whether the launch never came back or the program is merely
 * silent — and says nothing when a spawn error or an exit already explained it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { SILENT_START_MS, silentStartNotice, terminalProgramLabel } from "../../lib/terminal/terminalControl";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, writes } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  writes: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    modes = { mouseTrackingMode: "none", bracketedPasteMode: false };
    loadAddon() {}
    open() {}
    write(data: string) {
      writes.push(data);
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
    dispose() {}
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { HPC_GUARD } from "../../lib/remote/hpc/hpcGuard";
import { useHpcGuardStore } from "../../stores/remote/hpc/hpcGuardPrompt";
import { PaneSleepHoldContext } from "../../lib/sleepWhenHidden";

function giveLayout() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
}

/** `pty_spawn` answered by `spawn`; everything else resolves at once. */
function backend(spawn: () => Promise<unknown>) {
  invoke.mockImplementation((cmd: unknown) => (cmd === "pty_spawn" ? spawn() : Promise.resolve(undefined)));
}

const written = () => writes.join("");

describe("silentStartNotice", () => {
  it("names a launch that never came back", () => {
    expect(silentStartNotice({ spawn: "pending", sawOutput: false, exited: false })).toBe("pending");
  });

  it("names a program that started and drew nothing", () => {
    expect(silentStartNotice({ spawn: "spawned", sawOutput: false, exited: false })).toBe("noOutput");
  });

  it("stays quiet once there is output, an exit, or a spawn error", () => {
    expect(silentStartNotice({ spawn: "spawned", sawOutput: true, exited: false })).toBeNull();
    expect(silentStartNotice({ spawn: "spawned", sawOutput: false, exited: true })).toBeNull();
    expect(silentStartNotice({ spawn: "failed", sawOutput: false, exited: false })).toBeNull();
  });

  it("labels the program by its basename", () => {
    expect(terminalProgramLabel("opencode")).toBe("opencode");
    expect(terminalProgramLabel("/home/u/.opencode/bin/opencode")).toBe("opencode");
    expect(terminalProgramLabel("C:\\Tools\\codex.exe")).toBe("codex");
    expect(terminalProgramLabel("")).toBe("");
  });
});

describe("TerminalView — silent start notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writes.length = 0;
    invoke.mockReset();
    giveLayout();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function mountAndWait(props: Partial<React.ComponentProps<typeof TerminalView>> = {}) {
    await act(async () => {
      render(<TerminalView id="p:oc" cmd="opencode" cwd="/p" visible focused={false} {...props} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_START_MS + 50);
    });
  }

  it("says the launch never came back when pty_spawn hangs", async () => {
    backend(() => new Promise(() => {}));
    await mountAndWait();
    expect(written()).toContain("Still starting opencode");
  });

  it("says the program is silent when it spawned but drew nothing", async () => {
    backend(() => Promise.resolve(undefined));
    await mountAndWait();
    expect(written()).toContain("opencode was started but has shown nothing for 10 seconds");
  });

  it("adds nothing to a spawn error", async () => {
    backend(() => Promise.reject(new Error("boom")));
    await mountAndWait();
    expect(written()).toContain("[spawn error:");
    expect(written()).not.toContain("Still starting");
    expect(written()).not.toContain("has shown nothing");
  });

  it("speaks for a tab the HPC connect-then-spawn retry started, and lifts its launch hold", async () => {
    // The retry set `ownsPty` but left `spawnState` at "failed", so a tab
    // that came up silent after the user said "connect" got no notice.
    let refused = false;
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd !== "pty_spawn") return Promise.resolve(undefined);
      if (refused) return Promise.resolve(undefined);
      refused = true;
      return Promise.reject(new Error(`${HPC_GUARD} connect alice@login.example.org:22`));
    });
    const drop = useHpcGuardStore.getState().registerHost();
    const holds: boolean[] = [];
    await act(async () => {
      render(
        <PaneSleepHoldContext.Provider value={(_t, on) => holds.push(on)}>
          <TerminalView id="p:oc" cmd="opencode" cwd="/p" visible focused={false} />
        </PaneSleepHoldContext.Provider>,
      );
    });
    await vi.waitFor(() => expect(useHpcGuardStore.getState().pending).not.toBeNull());
    await act(async () => {
      useHpcGuardStore.getState().proceed();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SILENT_START_MS + 50);
    });
    drop();
    expect(invoke.mock.calls.filter(([c]) => c === "remote_connect")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([c]) => c === "pty_spawn")).toHaveLength(2);
    expect(written()).toContain("opencode was started but has shown nothing for 10 seconds");
    expect(holds).toEqual([true, false]);
  });

  it("never speaks for an attach-only view, which spawns nothing", async () => {
    backend(() => new Promise(() => {}));
    await mountAndWait({ attachOnly: true });
    expect(written()).not.toContain("Still starting");
    expect(written()).not.toContain("has shown nothing");
  });

  it("names the shell when the tab runs the default shell", async () => {
    backend(() => new Promise(() => {}));
    await mountAndWait({ cmd: "" });
    expect(written()).toContain("Still starting the shell");
  });
});
