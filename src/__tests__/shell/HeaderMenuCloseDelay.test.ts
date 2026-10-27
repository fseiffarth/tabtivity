/**
 * A header hover menu keeps its grace for a pointer that left while still in
 * the top bar (on its way down into the list), and closes at once when the
 * pointer leaves from the open list below it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { headerMenuCloseDelay } from "../../stores/headerHoverMenu";

function mountBar(bottom: number) {
  const bar = document.createElement("header");
  bar.className = "app-header";
  bar.getBoundingClientRect = () => ({ top: 0, bottom, left: 0, right: 800, width: 800, height: bottom, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(bar);
}

describe("headerMenuCloseDelay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("gives a pointer leaving inside the bar, or just under it, the grace", () => {
    mountBar(40);
    expect(headerMenuCloseDelay({ clientY: 30 })).toBeGreaterThan(0);
    expect(headerMenuCloseDelay({ clientY: 50 })).toBeGreaterThan(0);
  });

  it("closes at once when the pointer leaves from the list below the bar", () => {
    mountBar(40);
    expect(headerMenuCloseDelay({ clientY: 120 })).toBe(0);
  });

  it("keeps the grace without an event or a bar", () => {
    expect(headerMenuCloseDelay({ clientY: 120 })).toBeGreaterThan(0);
    mountBar(40);
    expect(headerMenuCloseDelay()).toBeGreaterThan(0);
  });
});
