/**
 * A new agent tab opens in the view its CLI last used: with the Reader (Chat)
 * picked for Claude, a freshly spawned Claude pane shows it at once. The pane
 * element used to be read off a ref while rendering — null on the first render
 * — so a pane nothing re-rendered afterwards (a Claude tab, whose session id is
 * fixed at spawn) stayed on its terminal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

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
import { useTabsStore } from "../../stores/tabs";
import { useAgentReaderStore } from "../../stores/agents/agentReader";

describe("TerminalView — a new agent tab follows its CLI's view", () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabsByScope: { p: [{ key: "t1", label: "Claude", cmd: "claude", kind: "agent" }] },
    } as never);
  });

  it("opens on the Reader when the CLI's choice is the Reader", async () => {
    useAgentReaderStore.setState({ byAgent: { claude: true } });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<TerminalView id="p:t1" cmd="claude" cwd="/p" visible focused kind="agent" />);
    });
    expect(view.queryByTestId("reader")).not.toBeNull();
  });

  it("opens on its terminal when the CLI's choice is the terminal", async () => {
    useAgentReaderStore.setState({ byAgent: { claude: false } });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<TerminalView id="p:t1" cmd="claude" cwd="/p" visible focused kind="agent" />);
    });
    expect(view.queryByTestId("reader")).toBeNull();
  });
});
