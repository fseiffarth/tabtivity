/**
 * Regression test for "one Claude tab, two scrollable halves — one light, one
 * dark" (a single tab painting a live terminal and a frozen one stacked in the
 * same pane, each with its own scrollbar).
 *
 * The pane's container is a flex COLUMN that React renders with no children, so
 * every element in it belongs to xterm. xterm's `open()` unconditionally creates
 * a fresh element and appends it; the matching removal lives in the LAST
 * disposable its constructor registers, and `Disposable.dispose()` walks that
 * list with no try/catch of its own. One throwing entry ahead of it — a renderer
 * whose context is already gone, an addon disposed twice; exactly the failures
 * this file's teardown comments document — aborts the walk and strands the
 * element. The spawn effect re-runs on any of its deps (a cwd/host/sandbox
 * change, a scheduleTargetId arriving on a restored tab), and the next `open()`
 * then appended a SECOND element beside the corpse: two flex children, half a
 * pane each, the dead one still painting whatever theme it last held.
 *
 * The mock below models the two xterm behaviours that matter: `open()` appends
 * an element, and `dispose()` removes it *only if it gets that far*.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

/** A real ResizeObserver delivers one entry as soon as it observes a laid-out
 *  box — that first callback is what drives `tryOpen` for every lifecycle after
 *  the initial mount (the `visible` effect only re-runs on visible/id). Model it,
 *  or a re-created terminal never opens here and the test proves nothing. */
class ResizeObserverStub {
  constructor(private readonly cb: () => void) {}
  observe() {
    queueMicrotask(() => {
      if (!this.stopped) this.cb();
    });
  }
  private stopped = false;
  unobserve() {}
  disconnect() {
    this.stopped = true;
  }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, terminals, disposeThrows } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
  terminals: [] as { opened: boolean; disposed: boolean; el: HTMLElement | null }[],
  // Flipped per test: does the teardown reach its element-removal disposable?
  disposeThrows: { value: false },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    state = { opened: false, disposed: false, el: null as HTMLElement | null };
    options: Record<string, unknown> = {};
    constructor() {
      terminals.push(this.state);
    }
    loadAddon() {}
    open(parent: HTMLElement) {
      // xterm never asks whether the parent already holds one.
      const el = document.createElement("div");
      el.className = "xterm";
      parent.appendChild(el);
      this.state.el = el;
      this.state.opened = true;
    }
    dispose() {
      this.state.disposed = true;
      // The disposable walk dies here, before the one that lifts the element out.
      if (disposeThrows.value) throw new TypeError("renderer already gone");
      this.state.el?.remove();
    }
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
    sel({ settings: { color_scheme: "soft_dark" } }),
  ),
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";
import { resetAgentVersionNotice, useAgentVersionNoticeStore } from "../../stores/agents/agentVersionNotice";

/** jsdom reports a zero-sized, unparented box, so `hasLayout()` is false and the
 *  terminal never opens. Flip it on so `tryOpen` can succeed. */
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

/** The pane container TerminalView renders — the only element xterm opens into. */
function paneContainer(root: HTMLElement): HTMLElement {
  const el = root.firstElementChild as HTMLElement | null;
  if (!el) throw new Error("TerminalView rendered no container");
  return el;
}

describe("TerminalView — a re-opened pane never stacks two xterms", () => {
  beforeEach(() => {
    invoke.mockClear();
    terminals.length = 0;
    disposeThrows.value = false;
    giveLayout(true);
  });
  afterEach(() => giveLayout(false));

  it("keeps one xterm element when a dep change re-runs the spawn effect", async () => {
    const { container, rerender } = render(
      <TerminalView id="p:t" cmd="bash" cwd="/p/one" visible focused />,
    );
    await act(async () => {});
    expect(terminals).toHaveLength(1);
    expect(paneContainer(container).querySelectorAll(".xterm")).toHaveLength(1);

    // `cwd` is a spawn dep: this tears the terminal down and builds a new one.
    await act(async () => {
      rerender(<TerminalView id="p:t" cmd="bash" cwd="/p/two" visible focused />);
    });

    expect(terminals).toHaveLength(2);
    expect(terminals[0].disposed).toBe(true);
    expect(terminals[1].opened).toBe(true);
    expect(paneContainer(container).querySelectorAll(".xterm")).toHaveLength(1);
  });

  it("still keeps one when the old terminal's dispose throws before removing it", async () => {
    // The failure that produced the split pane. A disposed-twice addon or a lost
    // renderer context aborts xterm's disposable walk short of the element.
    disposeThrows.value = true;
    const { container, rerender } = render(
      <TerminalView id="p:t" cmd="bash" cwd="/p/one" visible focused />,
    );
    await act(async () => {});
    expect(paneContainer(container).querySelectorAll(".xterm")).toHaveLength(1);

    await act(async () => {
      rerender(<TerminalView id="p:t" cmd="bash" cwd="/p/two" visible focused />);
    });

    // The corpse is swept: exactly one element, and it is the LIVE terminal's.
    const els = paneContainer(container).querySelectorAll(".xterm");
    expect(els).toHaveLength(1);
    expect(terminals).toHaveLength(2);
    expect(els[0]).toBe(terminals[1].el);
  });

  it("a throwing dispose still retires the lifecycle refs, so the pane re-opens", async () => {
    // The throw used to escape the cleanup and skip the ref retirement below it,
    // leaving `openedRef` true against a dead terminal — after which `tryOpen`
    // refused to open the replacement and the pane went black instead.
    disposeThrows.value = true;
    const { rerender } = render(
      <TerminalView id="p:t" cmd="bash" cwd="/p/one" visible focused />,
    );
    await act(async () => {});
    await act(async () => {
      rerender(<TerminalView id="p:t" cmd="bash" cwd="/p/two" visible focused />);
    });

    expect(terminals[1].opened).toBe(true);
  });
});

describe("TerminalView — the sweep leaves the pane's portaled cards to React", () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation((cmd: unknown) => Promise.resolve(
      cmd === "agent_versions"
        ? [{
          agent: "claude", label: "Claude Code", version: "9.9.9", state: "moved",
          stale: [{ version: "1.0.0", surface: "test", direction: "newer" }], dismissed: false,
        }]
        : undefined,
    ));
    terminals.length = 0;
    disposeThrows.value = false;
    giveLayout(true);
    // A host CLI newer than the verified release: every zoomable agent pane
    // portals the version card into its xterm container.
    useAgentVersionNoticeStore.setState({
      hidden: {},
      newer: { claude: { agent: "claude", label: "Claude Code", installed: "9.9.9", verified: "1.0.0" } },
    });
  });
  afterEach(() => {
    giveLayout(false);
    resetAgentVersionNotice();
  });

  it("closing the tab after a re-spawn does not throw out of React's unmount", async () => {
    // Before: the teardown's `replaceChildren()` removed the card node too, so
    // React's own removal on the tab close threw NotFoundError and took the
    // main window's whole tree down (a black window; popouts, which render no
    // version card, kept working).
    const props = { id: "p:t", cmd: "claude", visible: true, focused: true, zoomable: true };
    const { container, rerender, unmount } = render(<TerminalView {...props} cwd="/p/one" />);
    await act(async () => {});
    await act(async () => {
      rerender(<TerminalView {...props} cwd="/p/one" />);
    });
    expect(paneContainer(container).querySelector(".terminal-version-drift")).not.toBeNull();

    await act(async () => {
      rerender(<TerminalView {...props} cwd="/p/two" />);
    });
    expect(paneContainer(container).querySelector(".terminal-version-drift")).not.toBeNull();
    expect(paneContainer(container).querySelectorAll(".xterm")).toHaveLength(1);

    expect(() => unmount()).not.toThrow();
  });
});
