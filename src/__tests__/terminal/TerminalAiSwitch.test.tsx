/**
 * The AI switch in a real agent pane (`lib/aiSwitch.ts`,
 * `docs/ai_switch_plan.md`): a spawn the backend refuses with `ai_off` is not
 * a failed tab — it says so, waits, and spawns itself once the switch goes
 * back on; while AI is off the pane wears the "AI is off" pill. The settings
 * store is the real one, as the side panel's ⏻ writes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { Settings } from "../../types";

class ResizeObserverStub {
  constructor(private readonly cb: () => void) {}
  private stopped = false;
  observe() {
    queueMicrotask(() => {
      if (!this.stopped) this.cb();
    });
  }
  unobserve() {}
  disconnect() {
    this.stopped = true;
  }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, written, refusals } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  written: [] as string[],
  refusals: { left: 0 },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "xterm";
      parent.appendChild(el);
    }
    dispose() {}
    write(data: string | Uint8Array, cb?: () => void) {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      cb?.();
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
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { useSettingsStore } from "../../stores/settings";

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

const spawns = () => invoke.mock.calls.filter(([cmd]) => cmd === "pty_spawn").length;
const setAiOff = (off: boolean) =>
  act(async () => {
    useSettingsStore.setState({ settings: { color_scheme: "soft_dark", ai_off: off } as Settings });
  });

describe("TerminalView under the AI switch", () => {
  beforeEach(() => {
    written.length = 0;
    invoke.mockReset();
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === "pty_spawn" && refusals.left > 0) {
        refusals.left -= 1;
        return Promise.reject("ai_off");
      }
      return Promise.resolve(cmd === "pty_spawn" ? {} : undefined);
    });
    giveLayout(true);
  });
  afterEach(() => giveLayout(false));

  it("an agent tab refused while AI is off waits, then starts when AI is on", async () => {
    refusals.left = 1;
    useSettingsStore.setState({ settings: { color_scheme: "soft_dark", ai_off: true } as Settings });
    const { container } = render(
      <TerminalView id="p:agent" cmd="claude" cwd="/p" kind="agent" visible focused />,
    );
    await act(async () => {});
    await act(async () => {});

    expect(spawns()).toBe(1);
    expect(written.join("")).toContain("AI is off");
    expect(written.join("")).not.toContain("spawn error");
    expect(container.ownerDocument.querySelector(".terminal-ai-off-banner")).not.toBeNull();

    await setAiOff(false);
    await act(async () => {});

    expect(spawns()).toBe(2);
    expect(invoke).toHaveBeenLastCalledWith("pty_spawn", expect.objectContaining({
      opts: expect.objectContaining({ id: "p:agent", agent: true }),
    }));
    expect(container.ownerDocument.querySelector(".terminal-ai-off-banner")).toBeNull();
    expect(written.join("")).not.toContain("spawn error");
  });

  it("a retry the backend still refuses waits again instead of failing the tab", async () => {
    refusals.left = 2;
    useSettingsStore.setState({ settings: { color_scheme: "soft_dark", ai_off: true } as Settings });
    render(<TerminalView id="p:lag" cmd="claude" cwd="/p" kind="agent" visible focused />);
    await act(async () => {});
    await act(async () => {});
    expect(spawns()).toBe(1);

    // The store already says on, the file the backend reads does not yet.
    await setAiOff(false);
    await act(async () => {});
    expect(spawns()).toBe(2);
    expect(written.join("")).not.toContain("spawn error");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(spawns()).toBe(3);
    expect(written.join("")).not.toContain("spawn error");
  });

  it("a tab closed while waiting never spawns", async () => {
    refusals.left = 1;
    useSettingsStore.setState({ settings: { color_scheme: "soft_dark", ai_off: true } as Settings });
    const { unmount } = render(<TerminalView id="p:gone" cmd="claude" cwd="/p" kind="agent" visible focused />);
    await act(async () => {});
    await act(async () => {});
    expect(spawns()).toBe(1);

    unmount();
    await setAiOff(false);
    await act(async () => {});
    expect(spawns()).toBe(1);
  });

  it("a shell tab shows no pill while AI is off", async () => {
    useSettingsStore.setState({ settings: { color_scheme: "soft_dark", ai_off: true } as Settings });
    const { container } = render(<TerminalView id="p:sh" cmd="bash" cwd="/p" kind="shell" visible focused />);
    await act(async () => {});
    expect(container.ownerDocument.querySelector(".terminal-ai-off-banner")).toBeNull();
    expect(spawns()).toBe(1);
  });
});
