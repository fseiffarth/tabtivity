import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

// jsdom lacks ResizeObserver, which TerminalView observes for refit.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

const { invoke, pasted } = vi.hoisted(() => ({
  pasted: [] as string[],
  // `unknown` rather than `undefined`: `pty_scrollback` answers with a string
  // (Group B #235), so the default must not narrow the mock's return type.
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// xterm pulls in canvas/DOM internals jsdom doesn't provide; stub the surface
// TerminalView touches.
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
    paste(text: string) { pasted.push(text); }
    dispose() {}
    options = {};
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) =>
    sel({ settings: { color_scheme: "dark" } }),
  ),
  // Pass-through: only "system" resolves differently, and these tests pin a
  // concrete scheme.
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { useProjectsStore } from "../../stores/projects";

/** A drop event as WebKitGTK delivers an OS file drag: the path only inside a
 *  `file://` URL among the text payloads. */
function fileDrop(type: string, uri: string): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: {
      types: ["text/uri-list"],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? uri : ""),
    },
  });
  return e;
}

async function dropOnto(cmd: string, answer: unknown): Promise<{ drop: Event; over: Event }> {
  invoke.mockImplementation((name: unknown) =>
    name !== "pty_drop_files" ? Promise.resolve(undefined)
      // A bare string is the command's refusal.
      : typeof answer === "string" ? Promise.reject(answer) : Promise.resolve(answer),
  );
  let host: HTMLElement | null = null;
  await act(async () => {
    host = render(<TerminalView id="p:drop" cmd={cmd} cwd="/p" visible focused />).container;
  });
  const pane = host!.firstElementChild!;
  const over = fileDrop("dragover", "file:///home/u/a%20shot.png");
  const drop = fileDrop("drop", "file:///home/u/a%20shot.png");
  await act(async () => {
    pane.dispatchEvent(over);
    pane.dispatchEvent(drop);
  });
  return { drop, over };
}

describe("TerminalView — files dropped from the file manager", () => {
  beforeEach(() => {
    invoke.mockReset();
    pasted.length = 0;
    useProjectsStore.setState({ switchToast: null });
  });

  it("an agent tab gets the inbox copy as an @ reference", async () => {
    const { drop, over } = await dropOnto("claude", { items: [".app/inbox/x.png"], error: null });
    expect(over.defaultPrevented).toBe(true);
    expect(drop.defaultPrevented).toBe(true);
    const call = invoke.mock.calls.find((c) => c[0] === "pty_drop_files");
    expect(call?.[1]).toEqual({ id: "p:drop", paths: ["/home/u/a shot.png"], agent: true });
    expect(pasted).toEqual(["@.app/inbox/x.png "]);
  });

  it("a shell tab gets the quoted path", async () => {
    await dropOnto("bash", { items: ["/home/u/a shot.png"], error: null });
    const call = invoke.mock.calls.find((c) => c[0] === "pty_drop_files");
    expect((call?.[1] as { agent: boolean }).agent).toBe(false);
    expect(pasted).toEqual(["'/home/u/a shot.png' "]);
  });

  it("a remote tab types nothing and says why", async () => {
    await dropOnto("claude", "remote_tab");
    expect(pasted).toEqual([]);
    expect(useProjectsStore.getState().switchToast).toBeTruthy();
  });
});
