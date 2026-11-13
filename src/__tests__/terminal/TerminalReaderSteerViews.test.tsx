/**
 * A pane with a Reader view strip registers itself with keyboard steering
 * (`lib/agents/readerSteering`): the view it shows, the views the strip offers
 * (its enabled tabs) and a `show` that switches the way the strip's tabs do.
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
  useSettingsStore: Object.assign(vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: "dark" } })), { getState: () => ({ settings: { color_scheme: "dark" } }) }),
  resolveTheme: (s: string) => s,
}));

interface ReaderProps {
  shown?: boolean;
  changesOpen?: boolean;
  filesOpen?: boolean;
  onChangesKnown?: (known: boolean) => void;
  onFilesKnown?: (known: boolean) => void;
}
const readerProps: { current: ReaderProps } = { current: {} };
vi.mock("../../components/terminal/TerminalReaderView", () => ({
  TerminalReaderView: (props: ReaderProps) => {
    readerProps.current = props;
    return <div data-testid="reader" hidden={props.shown === false} />;
  },
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { useTabsStore } from "../../stores/tabs";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { readerViewFacts, readerViewFor } from "../../lib/agents/readerSteering";

const ID = "p:t1";

async function mount(visible = true) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<TerminalView id={ID} cmd="claude" cwd="/p" visible={visible} focused kind="agent" />);
  });
  return view;
}

describe("TerminalView — steering's view registry", () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabsByScope: { p: [{ key: "t1", label: "Claude", cmd: "claude", kind: "agent" }] },
    } as never);
    useAgentReaderStore.setState({ byAgent: { claude: true } });
    readerProps.current = {};
  });

  it("offers Chat and Terminal until Diffs and Files have something to show", async () => {
    const view = await mount();
    const target = readerViewFor(ID)!;
    expect(target).not.toBeNull();
    expect(target.view()).toBe("chat");
    expect(target.offered()).toEqual(["chat", "terminal"]);
    expect(readerViewFacts(ID)).toEqual({ view: "chat", offered: ["chat", "terminal"] });

    await act(async () => {
      readerProps.current.onChangesKnown?.(true);
      readerProps.current.onFilesKnown?.(true);
    });
    expect(readerViewFor(ID)!.offered()).toEqual(["chat", "changes", "files", "terminal"]);
    expect(readerViewFacts(ID)?.offered).toEqual(["chat", "changes", "files", "terminal"]);
    view.unmount();
  });

  it("show() switches the view the way the strip's tabs do", async () => {
    const view = await mount();
    await act(async () => {
      readerProps.current.onChangesKnown?.(true);
      readerProps.current.onFilesKnown?.(true);
    });
    await act(async () => readerViewFor(ID)!.show("changes"));
    expect(readerProps.current.changesOpen).toBe(true);
    expect(readerViewFor(ID)!.view()).toBe("changes");
    expect(readerViewFacts(ID)?.view).toBe("changes");

    await act(async () => readerViewFor(ID)!.show("files"));
    expect(readerProps.current.filesOpen).toBe(true);
    expect(readerProps.current.changesOpen).toBe(false);
    expect(readerViewFor(ID)!.view()).toBe("files");

    await act(async () => readerViewFor(ID)!.show("terminal"));
    expect(readerProps.current.shown).toBe(false);
    expect(readerViewFor(ID)!.view()).toBe("terminal");
    expect(useAgentReaderStore.getState().byAgent.claude).toBe(false);

    await act(async () => readerViewFor(ID)!.show("chat"));
    expect(readerProps.current.shown).toBe(true);
    expect(readerProps.current.filesOpen).toBe(false);
    expect(readerViewFor(ID)!.view()).toBe("chat");
    view.unmount();
  });

  it("keeps an open view selectable and offered although it went grey", async () => {
    const view = await mount();
    await act(async () => readerProps.current.onChangesKnown?.(true));
    await act(async () => readerViewFor(ID)!.show("changes"));
    await act(async () => readerProps.current.onChangesKnown?.(false));
    expect(readerViewFor(ID)!.offered()).toContain("changes");
    view.unmount();
  });

  it("registers only while the pane is visible, and unregisters on unmount", async () => {
    const hidden = await mount(false);
    expect(readerViewFor(ID)).toBeNull();
    expect(readerViewFacts(ID)).toBeNull();
    hidden.unmount();

    const view = await mount(true);
    expect(readerViewFor(ID)).not.toBeNull();
    view.unmount();
    expect(readerViewFor(ID)).toBeNull();
    expect(readerViewFacts(ID)).toBeNull();
  });

  it("registers nothing for a pane whose CLI has no Reader", async () => {
    useTabsStore.setState({
      tabsByScope: { p: [{ key: "t1", label: "Shell", cmd: "bash", kind: "shell" }] },
    } as never);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<TerminalView id={ID} cmd="bash" cwd="/p" visible focused kind="shell" />);
    });
    expect(readerViewFor(ID)).toBeNull();
    view.unmount();
  });
});
