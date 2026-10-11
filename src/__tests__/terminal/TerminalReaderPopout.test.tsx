/**
 * A popped-out agent tab has Chat and Diffs like a docked one. The popout's
 * tabs store holds no tabs, so the pane reads the one `TabPane` handed it
 * (`PaneTabContext`), and its attach-only view registers the composer's input
 * in the popout's own heap. Attach-only mirrors inside the main window (root
 * console, overlay column) still get neither.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
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
  useSettingsStore: vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })),
  resolveTheme: (s: string) => s,
}));
vi.mock("../../components/terminal/TerminalReaderView", () => ({
  TerminalReaderView: () => <div data-testid="reader" />,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { PaneTabContext } from "../../components/tabs/paneTabContext";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { installDetachedWindowContext } from "../../stores/detachedContext";
import { scheduledAgentInput } from "../../lib/agents/scheduledAgentInput";

const TAB: TabEntry = {
  key: "t1", label: "Claude", cmd: "claude", kind: "agent", sessionId: "s1", scheduleTargetId: "sched-t1",
} as TabEntry;

async function renderPane(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PaneTabContext.Provider value={{ scope: "p", tab: TAB }}>
        <TerminalView
          id="p:t1" cmd="claude" cwd="/p" visible focused kind="agent"
          scheduleTargetId="sched-t1" attachOnly
        />
      </PaneTabContext.Provider>,
    );
  });
  return view;
}

describe("TerminalView — Chat and Diffs in a popout", () => {
  let uninstall: (() => void) | null = null;
  beforeEach(() => {
    uninstall?.();
    uninstall = null;
    // A popout's tabs store holds no tabs: the pane only has what it was handed.
    useTabsStore.setState({ tabsByScope: {} } as never);
    useAgentReaderStore.setState({ byAgent: { claude: true } });
  });
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    cleanup();
  });

  it("offers the Reader and its composer's input in a popout's pane", async () => {
    uninstall = installDetachedWindowContext({
      scope: "p", groupId: "g", label: "detached-p-g",
      targetGroupId: () => "g", pushEdit: () => {}, closeTab: () => {},
    });
    const view = await renderPane();
    expect(view.queryByTestId("reader")).not.toBeNull();
    expect(scheduledAgentInput("sched-t1")?.ptyId).toBe("p:t1");
  });

  it("keeps a main-window mirror of a tab without them", async () => {
    const view = await renderPane();
    expect(view.queryByTestId("reader")).toBeNull();
    expect(scheduledAgentInput("sched-t1")).toBeUndefined();
  });
});
