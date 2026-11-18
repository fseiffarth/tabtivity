// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://laptop.example.ts.net/"}
/**
 * The framed page's clickjacking guard (`mobile-web/src/shell/frameGuard.ts`,
 * `FrameGuard.tsx`): input passes only once IntersectionObserver v2 has
 * reported the page visible for SETTLE_MS; covered drops it at once (queued
 * reports count at event time); a browser without the report fails closed
 * with a card outside the inert body.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockInput, SETTLE_MS, startFrameGuard, VISIBILITY_DELAY_MS, type FrameGuardState } from "../../../mobile-web/src/shell/frameGuard";
import { FrameGuard as FrameGuardCard } from "../../../mobile-web/src/shell/FrameGuardCard";
import { SHELL_CHANNEL } from "../../../mobile-web/src/shell/frameBridge";

type Record_ = { isIntersecting: boolean; isVisible?: boolean };

class FakeObserver {
  static last: FakeObserver | null = null;
  queued: Record_[] = [];
  targets: Element[] = [];
  constructor(public callback: (entries: Record_[]) => void, public init: Record<string, unknown>) {
    FakeObserver.last = this;
  }
  observe(target: Element) { this.targets.push(target); }
  disconnect() { this.targets = []; }
  takeRecords() { const out = this.queued; this.queued = []; return out; }
  deliver(record: Record_) { this.callback([record]); }
}

function withVisibilityReports() {
  class FakeEntry {}
  Object.defineProperty(FakeEntry.prototype, "isVisible", { value: false });
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("IntersectionObserverEntry", FakeEntry);
}

let clock = 0;
const now = () => clock;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  FakeObserver.last = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.inert = false;
});

function advance(ms: number) {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

describe("startFrameGuard", () => {
  it("never clears without visibility reports", () => {
    const seen: FrameGuardState[] = [];
    const guard = startFrameGuard(document.documentElement, (s) => seen.push(s), now);
    advance(10_000);
    expect(guard.state()).toBe("unsupported");
  });

  it("asks for v2 tracking and clears only after a settled visible report", () => {
    withVisibilityReports();
    const seen: FrameGuardState[] = [];
    const guard = startFrameGuard(document.documentElement, (s) => seen.push(s), now);
    const observer = FakeObserver.last!;
    expect(observer.init).toMatchObject({ trackVisibility: true, delay: VISIBILITY_DELAY_MS });
    expect(observer.targets).toEqual([document.documentElement]);
    expect(guard.state()).toBe("covered");
    observer.deliver({ isIntersecting: true, isVisible: true });
    expect(guard.state()).toBe("settling");
    advance(SETTLE_MS - 1);
    expect(guard.state()).toBe("settling");
    advance(1);
    expect(seen[seen.length - 1]).toBe("clear");
    // Covered, faded or moved: off at once, and the settle starts over.
    observer.deliver({ isIntersecting: true, isVisible: false });
    expect(seen[seen.length - 1]).toBe("covered");
    observer.deliver({ isIntersecting: true, isVisible: true });
    expect(guard.state()).toBe("settling");
    // Off screen counts as covered.
    observer.deliver({ isIntersecting: false, isVisible: false });
    expect(guard.state()).toBe("covered");
    guard.stop();
  });

  it("applies a report still queued when input arrives", () => {
    withVisibilityReports();
    const guard = startFrameGuard(document.documentElement, () => undefined, now);
    const observer = FakeObserver.last!;
    observer.deliver({ isIntersecting: true, isVisible: true });
    advance(SETTLE_MS);
    expect(guard.state()).toBe("clear");
    observer.queued.push({ isIntersecting: true, isVisible: false });
    expect(guard.state()).toBe("covered");
  });
});

describe("blockInput", () => {
  it("drops taps and keys unless clear or allowed", () => {
    const button = document.createElement("button");
    const allowedButton = document.createElement("button");
    document.body.append(button, allowedButton);
    const clicked = vi.fn();
    const keyed = vi.fn();
    button.addEventListener("click", clicked);
    allowedButton.addEventListener("click", clicked);
    window.addEventListener("keydown", keyed);
    let state: FrameGuardState = "covered";
    const stop = blockInput({ state: () => state, stop: () => undefined }, (target) => target === allowedButton);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(click);
    expect(clicked).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(keyed).not.toHaveBeenCalled();
    allowedButton.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    state = "settling";
    button.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    state = "clear";
    button.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(keyed).toHaveBeenCalledTimes(1);
    stop();
    button.remove();
    allowedButton.remove();
    window.removeEventListener("keydown", keyed);
  });
});

describe("FrameGuard in a browser without visibility reports", () => {
  const SHELL = "https://home.example.ts.net";
  const parent = { postMessage: vi.fn() };

  beforeEach(() => {
    vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
    Object.defineProperty(window.location, "ancestorOrigins", { configurable: true, value: { length: 1, 0: SHELL, item: () => SHELL, contains: (s: string) => s === SHELL } });
  });
  afterEach(() => {
    parent.postMessage.mockReset();
    Reflect.deleteProperty(window.location, "ancestorOrigins");
  });

  it("fails closed: inert body, a card outside it that opens this desktop or the picker", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const pageClick = vi.fn();
    const { unmount } = render(<><button onClick={pageClick}>Send</button><FrameGuardCard /></>);
    expect(document.body.inert).toBe(true);
    const panel = document.querySelector(".frame-guard-panel");
    expect(panel).not.toBeNull();
    expect(document.body.contains(panel)).toBe(false);
    expect(panel!.textContent).toContain("can't confirm that nothing covers it");
    fireEvent.click(document.body.querySelector("button")!);
    expect(pageClick).not.toHaveBeenCalled();
    const [choose, openOwn] = Array.from(panel!.querySelectorAll("button"));
    fireEvent.click(openOwn);
    expect(open).toHaveBeenCalledWith("https://laptop.example.ts.net/", "_blank", "noopener,noreferrer");
    fireEvent.click(choose);
    expect(parent.postMessage).toHaveBeenCalledWith({ channel: SHELL_CHANNEL, type: "openPicker" }, SHELL);
    unmount();
    expect(document.body.inert).toBe(false);
    expect(document.querySelector(".frame-guard-panel")).toBeNull();
  });

  it("with reports: no card while settling, input once clear, a card if covered too long", () => {
    withVisibilityReports();
    vi.spyOn(performance, "now").mockImplementation(now);
    const pageClick = vi.fn();
    render(<><button onClick={pageClick}>Send</button><FrameGuardCard /></>);
    expect(document.body.inert).toBe(true);
    expect(document.querySelector(".frame-guard-panel")).toBeNull();
    act(() => { FakeObserver.last!.deliver({ isIntersecting: true, isVisible: true }); });
    act(() => { advance(SETTLE_MS); });
    expect(document.body.inert).toBe(false);
    fireEvent.click(document.body.querySelector("button")!);
    expect(pageClick).toHaveBeenCalledTimes(1);
    act(() => { FakeObserver.last!.deliver({ isIntersecting: true, isVisible: false }); });
    expect(document.body.inert).toBe(true);
    act(() => { advance(3_000); });
    expect(document.querySelector(".frame-guard-panel")!.textContent).toContain("Paused");
  });
});
