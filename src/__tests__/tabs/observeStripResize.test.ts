import { afterEach, describe, expect, it, vi } from "vitest";
import { observeStripResize } from "../../lib/observeStripResize";

// A ResizeObserver stand-in that records what it watches and lets the test
// fire a resize on any one element.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  watched = new Set<Element>();
  constructor(private cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
  fire(el: Element) {
    if (this.watched.has(el)) this.cb();
  }
}

describe("observeStripResize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
  });

  it("re-checks when a child grows, not only when the strip resizes", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const strip = document.createElement("div");
    const first = document.createElement("div");
    strip.appendChild(first);
    const onChange = vi.fn();
    const stop = observeStripResize(strip, onChange);
    const ro = FakeResizeObserver.instances[0];

    ro.fire(first);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A tab added later is watched too.
    const added = document.createElement("div");
    strip.appendChild(added);
    await Promise.resolve();
    expect(ro.watched.has(added)).toBe(true);
    onChange.mockClear();
    ro.fire(added);
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(ro.watched.size).toBe(0);
  });

  it("is a no-op without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const stop = observeStripResize(document.createElement("div"), vi.fn());
    expect(() => stop()).not.toThrow();
  });
});
