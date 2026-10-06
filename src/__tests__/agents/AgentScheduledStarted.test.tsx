/**
 * A phone prompt is typed into an agent tab even while the agent works
 * (`queueableWhileBusy`), once the pane has `started`. That must mean the CLI
 * has drawn and gone quiet once — not the bare terminal-ready event: a
 * brand-new tab (the phone markup's new-tab Submit) is ready before its CLI
 * runs, and what is typed into a CLI still starting is lost. Once settled it
 * stays started, so a busy agent still takes phone prompts mid-turn.
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
import { _clearScheduledAgentInputsForTest, scheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import { _clearPhoneHoldsForTest, holdPhonePrompt, onPhoneHoldDue } from "../../lib/agents/phoneHolds";

describe("an agent tab's scheduled input · started", () => {
  beforeEach(() => {
    invoke.mockClear();
    bus.ready.clear();
    bus.output.clear();
    _clearScheduledAgentInputsForTest();
    _clearPhoneHoldsForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the CLI to draw and settle once, then holds through later output", async () => {
    const id = "p1:t1";
    const wakes = vi.fn();
    onPhoneHoldDue(wakes);
    holdPhonePrompt("held-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    wakes.mockClear();
    await act(async () => {
      render(<TerminalView id={id} cmd="claude" cwd="/p" kind="agent" scheduleTargetId="target-1" visible focused />);
    });
    const input = () => scheduledAgentInput("target-1")!;
    expect(input().started?.()).toBe(false);

    await act(async () => { bus.ready.get(id)?.(); });
    expect(input().started?.()).toBe(false);

    await act(async () => { bus.output.get(id)?.("Claude Code starting"); });
    expect(input().started?.()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await act(async () => { bus.output.get(id)?.("\x1b[2J welcome"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(input().started?.()).toBe(false);
    expect(wakes).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(input().started?.()).toBe(true);
    // The phone prompt that waited on the pane is swept for at once.
    expect(wakes).toHaveBeenCalledTimes(1);

    // A working agent redraws without pause: it stays started.
    await act(async () => { bus.output.get(id)?.("✻ Working…"); });
    expect(input().started?.()).toBe(true);
    expect(input().ready()).toBe(false);
  });
});
