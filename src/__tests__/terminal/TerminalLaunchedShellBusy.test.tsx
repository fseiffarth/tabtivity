/**
 * A shell tab Tabtivity opened to run something — a program of its own (`git
 * clone`, an install's `bash`) or a line it types (a script's Run) — wears the
 * running ▶ while it prints, like a plain shell does once a command is typed
 * into it. Only typing stamped a tab as commanded, so a program tab (nothing
 * to type) never got the mark, nor did a run tab remounted after its line was
 * typed. A plain shell still needs the user's command first: a restored one
 * replaying its screen is not "running".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
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
import { notePtyOutput, useActivityStore, _clearPtyActivityForTest } from "../../stores/activity";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

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

/** Mount `tab` as the scope `p`'s only tab, let it spawn, then have it print
 *  for longer than the onset debounce, and say what the store made of it. */
async function printsFor(tab: TabEntry) {
  useTabsStore.setState({
    tabsByScope: { p: [tab] },
    scope: "p",
    layoutByScope: { p: { type: "group", id: "g", tabKeys: [tab.key], activeKey: tab.key } },
    detachedGroupsByScope: {},
  });
  const id = `p:${tab.key}`;
  await act(async () => {
    render(
      <TerminalView
        id={id}
        cmd={tab.cmd}
        args={tab.args}
        initialInput={tab.initialInput}
        cwd={tab.cwd}
        kind={tab.kind}
        visible
        focused={false}
      />,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  notePtyOutput(id, "Receiving objects…\n");
  for (let elapsed = 0; elapsed < 1600; elapsed += 400) {
    vi.advanceTimersByTime(400);
    notePtyOutput(id, "Receiving objects…\n");
  }
  useActivityStore.getState().recompute();
  const { busyByTab, busyKindByTab } = useActivityStore.getState();
  return { busy: !!busyByTab[id], kind: busyKindByTab[id] };
}

describe("TerminalView — a shell tab Tabtivity launched is running from its spawn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve(undefined));
    _clearPtyActivityForTest();
    giveLayout();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("marks a program tab (git clone) running while it prints, as a shell command", async () => {
    const tab: TabEntry = {
      key: "clone",
      label: "clone",
      cmd: "git",
      args: ["clone", "--progress", "https://example.invalid/r.git", "."],
      cwd: "/p",
      kind: "shell",
    };
    expect(await printsFor(tab)).toEqual({ busy: true, kind: "shell" });
  });

  it("marks a run tab whose line was typed by an earlier mount", async () => {
    // The line is claimed once per PTY: this mount types nothing.
    const { claimInitialInput } = await import("../../lib/terminal/terminalControl");
    claimInitialInput("p:run", "bash 'build.sh'");
    const tab: TabEntry = {
      key: "run",
      label: "build.sh",
      cmd: "bash",
      cwd: "/p",
      kind: "shell",
      initialInput: "bash 'build.sh'",
    };
    expect(await printsFor(tab)).toEqual({ busy: true, kind: "shell" });
  });

  it("leaves a plain shell nobody typed into unmarked", async () => {
    const tab: TabEntry = { key: "sh", label: "Shell", cmd: "", cwd: "/p", kind: "shell" };
    expect((await printsFor(tab)).busy).toBe(false);
  });
});
