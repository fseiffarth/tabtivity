import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listScrollKey, rememberListScroll, takeListScroll, useRestoreListScroll } from "../../../mobile-web/src/listScroll";

function List({ id, ready }: { id: string | null; ready: boolean }) {
  useRestoreListScroll(listScrollKey(id), ready);
  return null;
}

describe("phone list scroll", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0, writable: true });
  });
  afterEach(() => { takeListScroll("home"); takeListScroll("project:a"); });

  it("keys Home and each project apart", () => {
    expect(listScrollKey(null)).toBe("home");
    expect(listScrollKey("a")).toBe("project:a");
  });

  it("puts the list back at the offset a tab was opened from", () => {
    (window as { scrollY: number }).scrollY = 412;
    rememberListScroll(listScrollKey("a"));
    (window as { scrollY: number }).scrollY = 0;
    render(<List id="a" ready />);
    expect(scrollTo).toHaveBeenCalledWith(0, 412);
  });

  it("waits for the rows before it restores", () => {
    (window as { scrollY: number }).scrollY = 300;
    rememberListScroll("home");
    const view = render(<List id={null} ready={false} />);
    expect(scrollTo).not.toHaveBeenCalled();
    view.rerender(<List id={null} ready />);
    expect(scrollTo).toHaveBeenCalledWith(0, 300);
  });

  it("restores once, and not another list's offset", () => {
    (window as { scrollY: number }).scrollY = 250;
    rememberListScroll("home");
    render(<List id="a" ready />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(takeListScroll("home")).toBe(250);
    expect(takeListScroll("home")).toBeNull();
  });
});
