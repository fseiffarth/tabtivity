/**
 * `subscribeTauri` / `useTauriListener`: a Tauri subscription hands back its
 * unlisten only once a promise settles, so a cleanup that runs first must
 * still remove the listener when it arrives, and a rejected subscription must
 * not surface as an unhandled rejection.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { subscribeTauri, useTauriListener } from "../../hooks/useTauriListener";

/** A subscription whose promise the test settles by hand. */
function deferred() {
  let resolve!: (fn: () => void) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<() => void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("subscribeTauri", () => {
  it("unlistens on dispose once the subscription has settled", async () => {
    const unlisten = vi.fn();
    const off = subscribeTauri(() => Promise.resolve(unlisten));
    await flush();
    expect(unlisten).not.toHaveBeenCalled();
    off();
    off(); // a second dispose is a no-op
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("a dispose before the subscription settles still removes the listener", async () => {
    const d = deferred();
    const unlisten = vi.fn();
    const off = subscribeTauri(() => d.promise);
    off();
    d.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected or throwing subscription", async () => {
    const d = deferred();
    const off = subscribeTauri(() => d.promise);
    d.reject(new Error("no runtime"));
    await flush();
    expect(() => off()).not.toThrow();
    const offSync = subscribeTauri(() => {
      throw new Error("no window");
    });
    expect(() => offSync()).not.toThrow();
  });
});

describe("useTauriListener", () => {
  function Probe({ subscribe, dep }: { subscribe: () => Promise<() => void>; dep: string }) {
    useTauriListener(subscribe, [dep]);
    return null;
  }

  it("removes a listener whose component unmounted before it was registered", async () => {
    const d = deferred();
    const unlisten = vi.fn();
    const view = render(<Probe subscribe={() => d.promise} dep="a" />);
    view.unmount();
    d.resolve(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("resubscribes when a dependency changes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const subscribe = vi
      .fn<() => Promise<() => void>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const view = render(<Probe subscribe={subscribe} dep="a" />);
    await flush();
    view.rerender(<Probe subscribe={subscribe} dep="b" />);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
