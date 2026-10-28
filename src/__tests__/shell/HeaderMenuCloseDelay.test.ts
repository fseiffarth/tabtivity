/**
 * A header hover menu keeps its grace for a pointer that left heading down from
 * the top bar (on its way into the list), and closes at once when the pointer
 * runs along the bar to the next icon or leaves from the open list below it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";

/** Two pointer samples: the step from the first to the second is the direction. */
function moveBy(dx: number, dy: number) {
  useHeaderHoverMenuStore.getState().open("t");
  fireEvent.pointerMove(window, { clientX: 100, clientY: 20 });
  fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 20 + dy });
}

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

  it("closes at once when the pointer runs sideways along the bar", () => {
    mountBar(40);
    moveBy(-8, 1);
    expect(headerMenuCloseDelay({ clientY: 21 })).toBe(0);
    moveBy(6, -2);
    expect(headerMenuCloseDelay({ clientY: 18 })).toBe(0);
    // Heading down, even off to one side, is the way into the list.
    moveBy(-6, 5);
    expect(headerMenuCloseDelay({ clientY: 25 })).toBeGreaterThan(0);
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
