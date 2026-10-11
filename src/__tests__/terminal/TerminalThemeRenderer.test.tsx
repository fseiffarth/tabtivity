/**
 * Regression test for the most common error in the crash log — thrown on EVERY
 * launch, ~4-5s in:
 *
 *   TypeError: undefined is not an object (evaluating 'this._renderer.value.dimensions')
 *     dimensions@.../@xterm_xterm.js
 *     syncScrollArea@.../@xterm_xterm.js
 *
 * Assigning `term.options.theme` makes xterm refresh through its renderer, and
 * that renderer exists ONLY between `open()` and `dispose()`. The theme effect
 * guarded on `termRef.current` alone, which is true for a terminal that has been
 * constructed but not opened — and that is the normal state of a restored tab at
 * launch: `colorScheme` comes from the settings store, which loads a few seconds
 * AFTER the tabs mount, so the scheme arriving flipped the effect over a whole
 * layout's worth of unopened terminals at once.
 *
 * The mock below models the one xterm behaviour that matters: a `theme` write is
 * legal only while a renderer exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const { invoke, themeWrites, liveTerminals } = vi.hoisted(() => ({
  invoke: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
  themeWrites: [] as unknown[],
  liveTerminals: [] as { opened: boolean; disposed: boolean }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    // Stands in for xterm's `_renderer.value`: absent before open, absent again
    // after dispose. A theme write outside that window is what throws.
    renderer: object | null = null;
    state = { opened: false, disposed: false };
    options: Record<string, unknown>;
    constructor() {
      liveTerminals.push(this.state);
      const state = this.state;
      const self = this;
      this.options = new Proxy({} as Record<string, unknown>, {
        set(target, key, value) {
          if (key === "theme") {
            if (!self.renderer) {
              throw new TypeError(
                `undefined is not an object (evaluating 'this._renderer.value.dimensions') ` +
                  `[opened=${state.opened} disposed=${state.disposed}]`,
              );
            }
            themeWrites.push(value);
          }
          target[key as string] = value;
          return true;
        },
      });
    }
    loadAddon() {}
    open() {
      this.renderer = {};
      this.state.opened = true;
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
    dispose() {
      this.renderer = null;
      this.state.disposed = true;
    }
    registerLinkProvider() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) };
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Mutable so a test can reproduce "settings landed after the tabs mounted".
let colorScheme: string | undefined;
vi.mock("../../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: object) => unknown) => sel({ settings: { color_scheme: colorScheme } })),
  // Pass-through: only "system" resolves differently, and these tests pin a
  // concrete scheme.
  resolveTheme: (s: string) => s,
}));

import { TerminalView } from "../../components/terminal/TerminalView";

/** jsdom reports a zero-sized, unparented box, so `hasLayout()` is false and the
 *  terminal never opens — which is exactly the unopened state we want to test.
 *  Flipping this on lets `tryOpen` succeed. */
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

describe("TerminalView — theme writes never reach a rendererless xterm", () => {
  beforeEach(() => {
    invoke.mockClear();
    themeWrites.length = 0;
    liveTerminals.length = 0;
    colorScheme = undefined;
    giveLayout(false);
  });

  it("survives the settings-load theme change while the terminal is still closed", async () => {
    // The launch shape: tabs mount with no layout box yet (hidden / still tiling),
    // so nothing opens. This is the state the crash was thrown in.
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const r = render(<TerminalView id="p:a" cmd="bash" cwd="/p" visible={false} focused={false} />);
      rerender = r.rerender;
    });
    // Not even built: the xterm is constructed on the pane's first show.
    expect(liveTerminals).toHaveLength(0);

    // Settings land: `color_scheme` goes undefined → "dark". Before the fix this
    // threw straight out of the effect on every unopened terminal.
    colorScheme = "dark";
    await act(async () => {
      rerender(<TerminalView id="p:a" cmd="bash" cwd="/p" visible={false} focused={false} />);
    });

    // Not merely "didn't throw": the write must have been SKIPPED, not swallowed.
    expect(themeWrites).toHaveLength(0);
  });

  it("adopts the scheme that landed while it was closed, at open time", async () => {
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const r = render(<TerminalView id="p:b" cmd="bash" cwd="/p" visible={false} focused={false} />);
      rerender = r.rerender;
    });

    // Scheme arrives while closed (skipped), then the pane gains a layout box.
    colorScheme = "light";
    giveLayout(true);
    await act(async () => {
      rerender(<TerminalView id="p:b" cmd="bash" cwd="/p" visible focused={false} />);
    });

    // Skipping the closed write would strand the terminal on its constructed
    // (undefined-scheme) theme, so opening has to re-apply the current one.
    expect(liveTerminals[0]?.opened).toBe(true);
    expect(themeWrites).toHaveLength(1);
  });

  it("still re-themes a terminal that IS open", async () => {
    giveLayout(true);
    colorScheme = "dark";
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const r = render(<TerminalView id="p:c" cmd="bash" cwd="/p" visible focused={false} />);
      rerender = r.rerender;
    });
    const afterOpen = themeWrites.length;

    colorScheme = "light_lavender";
    await act(async () => {
      rerender(<TerminalView id="p:c" cmd="bash" cwd="/p" visible focused={false} />);
    });
    expect(themeWrites.length).toBe(afterOpen + 1);
  });

  it("disposes cleanly when the spawn effect re-runs, and themes the new terminal", async () => {
    giveLayout(true);
    colorScheme = "dark";
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const r = render(<TerminalView id="p:d" cmd="bash" cwd="/p" visible focused={false} />);
      rerender = r.rerender;
    });

    // A spawn dep changes (an agent-mode flip / container toggle / host switch):
    // the old terminal is disposed and a new one built. The stale refs must not
    // survive the swap, or the next theme write lands on the disposed one.
    colorScheme = "light";
    await act(async () => {
      rerender(<TerminalView id="p:d" cmd="zsh" cwd="/p" visible focused={false} />);
    });

    // The old terminal is gone; the replacement is built on its first open.
    expect(liveTerminals).toHaveLength(1);
    expect(liveTerminals[0].disposed).toBe(true);

    // Neither the ResizeObserver (stubbed) nor the `visible` effect (its deps did
    // not change) reopens the replacement — the open watchdog does, which is
    // precisely the case it was added for. Wait it out rather than pretend the
    // terminal is already open.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(liveTerminals).toHaveLength(2);
    expect(liveTerminals[1].disposed).toBe(false);
    expect(liveTerminals[1].opened).toBe(true);
  });
});
