import { describe, expect, it, vi } from "vitest";
import { installWideOutputHint } from "../../../mobile-web/src/terminal/wideOutput";
import { BRAND } from "../../lib/brand";

/** jsdom lays nothing out, so the geometry the hint reads is stubbed. */
function makeScroller(geometry: { clientWidth: number; scrollWidth: number; scrollLeft: number }) {
  const scroller = document.createElement("div");
  scroller.appendChild(document.createElement("div"));
  Object.defineProperty(scroller, "clientWidth", { get: () => geometry.clientWidth });
  Object.defineProperty(scroller, "scrollWidth", { get: () => geometry.scrollWidth });
  Object.defineProperty(scroller, "scrollLeft", { get: () => geometry.scrollLeft });
  return scroller;
}

describe(`${BRAND.display} Mobile wide terminal output`, () => {
  it("marks the edge that still hides output as the view pans", () => {
    const geometry = { clientWidth: 390, scrollWidth: 1180, scrollLeft: 0 };
    const scroller = makeScroller(geometry);
    const marker = document.createElement("div");
    const hint = installWideOutputHint(scroller, marker);

    // At column one only the right of the line is out of sight.
    expect(marker.classList.contains("wide-right")).toBe(true);
    expect(marker.classList.contains("wide-left")).toBe(false);

    geometry.scrollLeft = 400;
    hint.sync();
    expect(marker.classList.contains("wide-left")).toBe(true);
    expect(marker.classList.contains("wide-right")).toBe(true);

    // Panned to the far right: nothing further to reveal.
    geometry.scrollLeft = geometry.scrollWidth - geometry.clientWidth;
    hint.sync();
    expect(marker.classList.contains("wide-right")).toBe(false);
    expect(marker.classList.contains("wide-left")).toBe(true);

    hint.dispose();
    expect(marker.className).toBe("");
  });

  it("shows no edge when the session already fits the phone", () => {
    const geometry = { clientWidth: 390, scrollWidth: 390, scrollLeft: 0 };
    const marker = document.createElement("div");
    const hint = installWideOutputHint(makeScroller(geometry), marker);
    expect(marker.className).toBe("");
    hint.dispose();
  });

  it("coalesces a pan's scroll events into one read per frame", async () => {
    const geometry = { clientWidth: 390, scrollWidth: 1180, scrollLeft: 0 };
    const scroller = makeScroller(geometry);
    const marker = document.createElement("div");
    const hint = installWideOutputHint(scroller, marker);
    const frame = vi.spyOn(window, "requestAnimationFrame");

    geometry.scrollLeft = 300;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scroll"));
    expect(frame).toHaveBeenCalledTimes(1);

    // This wait rides the same spied function, so count from here on.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(marker.classList.contains("wide-left")).toBe(true);

    // The listener goes with the tab; a later scroll must not touch the marker.
    hint.dispose();
    const settled = frame.mock.calls.length;
    geometry.scrollLeft = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(frame).toHaveBeenCalledTimes(settled);
    expect(marker.classList.contains("wide-left")).toBe(false);
    frame.mockRestore();
  });
});
