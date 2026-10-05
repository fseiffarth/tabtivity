import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SWIPE_AXIS_RATIO,
  SWIPE_EDGE_GUARD,
  SWIPE_MAX_DURATION_MS,
  SWIPE_MIN_DISTANCE,
  classifySwipe,
  installFocusSwipe,
} from "../../../mobile-web/src/terminal/focusSwipe";
import { BRAND } from "../../lib/brand";

const at = (x: number, y = 300, t = 0) => ({ x, y, t });

describe(`${BRAND.display} Mobile Focus swipe classification`, () => {
  it("exposes the documented thresholds", () => {
    expect([SWIPE_MIN_DISTANCE, SWIPE_AXIS_RATIO, SWIPE_MAX_DURATION_MS, SWIPE_EDGE_GUARD]).toEqual([56, 2, 700, 16]);
  });

  it("reads direction from the horizontal travel, at the distance threshold", () => {
    expect(classifySwipe(at(100), at(156, 300, 200))).toBe("right");
    expect(classifySwipe(at(200), at(144, 300, 200))).toBe("left");
    expect(classifySwipe(at(100), at(155, 300, 200))).toBeNull();
    expect(classifySwipe(at(200), at(145, 300, 200))).toBeNull();
  });

  it("refuses a diagonal drag that is mostly a scroll", () => {
    expect(classifySwipe(at(100, 300), at(180, 340, 200))).toBe("right");
    expect(classifySwipe(at(100, 300), at(180, 341, 200))).toBeNull();
    expect(classifySwipe(at(100, 300), at(110, 500, 200))).toBeNull();
  });

  it("refuses a slow drag and a clock that ran backwards", () => {
    expect(classifySwipe(at(100, 300, 0), at(200, 300, 700))).toBe("right");
    expect(classifySwipe(at(100, 300, 0), at(200, 300, 701))).toBeNull();
    expect(classifySwipe(at(100, 300, 500), at(200, 300, 400))).toBeNull();
  });
});

type TouchPoint = { identifier: number; clientX: number; clientY: number };

function touchEvent(type: string, touches: TouchPoint[], changed: TouchPoint[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changed });
  return event;
}

function pointer(target: Element, type: string, x: number, y = 300, init: PointerEventInit = {}) {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "touch",
    ...init,
  }));
}

function stubScroll(element: HTMLElement, box: { scrollLeft: number; clientWidth: number; scrollWidth: number }) {
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
  element.style.overflowX = "auto";
}

describe(`${BRAND.display} Mobile Focus swipe listeners`, () => {
  let host: HTMLDivElement;
  let row: HTMLDivElement;
  let now = 10_000;
  let onSwipeRight: ReturnType<typeof vi.fn<() => void>>;
  let onSwipeLeft: ReturnType<typeof vi.fn<() => void>>;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    host = document.createElement("div");
    row = document.createElement("div");
    row.textContent = "● Done.";
    host.appendChild(row);
    document.body.appendChild(host);
    onSwipeRight = vi.fn<() => void>();
    onSwipeLeft = vi.fn<() => void>();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    host.remove();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  const install = () => {
    cleanup = installFocusSwipe(host, { onSwipeRight, onSwipeLeft });
  };
  const swipe = (target: Element, fromX: number, toX: number, init: PointerEventInit = {}) => {
    pointer(target, "pointerdown", fromX, 300, init);
    now += 150;
    pointer(target, "pointerup", toX, 305, init);
  };

  describe("with Pointer Events", () => {
    it("fires right and left for a touch flick", () => {
      install();
      swipe(row, 100, 260);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
      swipe(row, 260, 100);
      expect(onSwipeLeft).toHaveBeenCalledTimes(1);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it("listens passively and never prevents the gesture", () => {
      const add = vi.spyOn(host, "addEventListener");
      install();
      expect(add).toHaveBeenCalled();
      for (const call of add.mock.calls) {
        expect(call[2]).toMatchObject({ passive: true });
      }
      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, clientY: 300, pointerId: 1, pointerType: "touch" });
      row.dispatchEvent(down);
      now += 100;
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: 260, clientY: 300, pointerId: 1, pointerType: "touch" });
      row.dispatchEvent(up);
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it("ignores mouse drags", () => {
      install();
      swipe(row, 100, 260, { pointerType: "mouse" });
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("reads a pen (the iPad's Pencil) like a finger", () => {
      install();
      swipe(row, 100, 260, { pointerType: "pen" });
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it("ignores a drag that is too short, too slow or mostly vertical", () => {
      install();
      swipe(row, 100, 150);
      pointer(row, "pointerdown", 100);
      now += 900;
      pointer(row, "pointerup", 260);
      pointer(row, "pointerdown", 100, 100);
      now += 100;
      pointer(row, "pointerup", 180, 300);
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("leaves a gesture starting at either screen edge to the system", () => {
      install();
      swipe(row, SWIPE_EDGE_GUARD - 1, 200);
      swipe(row, window.innerWidth - SWIPE_EDGE_GUARD + 1, window.innerWidth - 200);
      expect(onSwipeRight).not.toHaveBeenCalled();
      expect(onSwipeLeft).not.toHaveBeenCalled();
      swipe(row, SWIPE_EDGE_GUARD, 200);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it("ignores a gesture starting in a text field or an editable region", () => {
      const input = document.createElement("input");
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "true");
      const inner = document.createElement("span");
      editable.appendChild(inner);
      host.append(input, editable);
      install();
      swipe(input, 100, 260);
      swipe(inner, 100, 260);
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("lets a horizontally scrolled block keep panning in the direction it can move", () => {
      const code = document.createElement("pre");
      const line = document.createElement("code");
      code.appendChild(line);
      host.appendChild(code);
      // Scrolled into the middle: both directions can still pan.
      stubScroll(code, { scrollLeft: 40, clientWidth: 200, scrollWidth: 600 });
      install();
      swipe(line, 100, 260);
      swipe(line, 260, 100);
      expect(onSwipeRight).not.toHaveBeenCalled();
      expect(onSwipeLeft).not.toHaveBeenCalled();

      // At its left edge a right swipe has nothing to pan, so it is a swipe.
      stubScroll(code, { scrollLeft: 0, clientWidth: 200, scrollWidth: 600 });
      swipe(line, 100, 260);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
      swipe(line, 260, 100);
      expect(onSwipeLeft).not.toHaveBeenCalled();

      // At its right edge the left swipe is free.
      stubScroll(code, { scrollLeft: 400, clientWidth: 200, scrollWidth: 600 });
      swipe(line, 260, 100);
      expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    });

    it("does not count a box the user cannot scroll", () => {
      const clipped = document.createElement("div");
      host.appendChild(clipped);
      stubScroll(clipped, { scrollLeft: 0, clientWidth: 200, scrollWidth: 600 });
      clipped.style.overflowX = "hidden";
      install();
      swipe(clipped, 260, 100);
      expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    });

    it("drops the gesture when a second finger lands", () => {
      install();
      pointer(row, "pointerdown", 100, 300, { pointerId: 1 });
      pointer(row, "pointerdown", 300, 300, { pointerId: 2 });
      now += 100;
      pointer(row, "pointerup", 260, 300, { pointerId: 1 });
      pointer(row, "pointerup", 460, 300, { pointerId: 2 });
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("finishes from the touch stream when the browser cancels the pointer for a pan", () => {
      install();
      pointer(row, "pointerdown", 100);
      pointer(row, "pointercancel", 0, 0);
      now += 150;
      row.dispatchEvent(touchEvent("touchend", [], [{ identifier: 0, clientX: 260, clientY: 300 }]));
      expect(onSwipeRight).toHaveBeenCalledTimes(1);

      pointer(row, "pointerdown", 100);
      pointer(row, "pointercancel", 0, 0);
      row.dispatchEvent(touchEvent("touchcancel", [], []));
      now += 150;
      row.dispatchEvent(touchEvent("touchend", [], [{ identifier: 0, clientX: 260, clientY: 300 }]));
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
    });

    it("does not read a drag that made a text selection as a swipe", () => {
      install();
      pointer(row, "pointerdown", 100);
      const range = document.createRange();
      range.selectNodeContents(row);
      window.getSelection()?.addRange(range);
      now += 150;
      pointer(row, "pointerup", 260);
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("removes every listener on cleanup", () => {
      const add = vi.spyOn(host, "addEventListener");
      const remove = vi.spyOn(host, "removeEventListener");
      install();
      cleanup?.();
      cleanup = undefined;
      expect(remove.mock.calls.map((call) => call[0]).sort()).toEqual(add.mock.calls.map((call) => call[0]).sort());
      swipe(row, 100, 260);
      expect(onSwipeRight).not.toHaveBeenCalled();
    });
  });

  describe("with Touch Events only", () => {
    let descriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      descriptor = Object.getOwnPropertyDescriptor(window, "PointerEvent");
      delete (window as { PointerEvent?: unknown }).PointerEvent;
    });

    afterEach(() => {
      if (descriptor) Object.defineProperty(window, "PointerEvent", descriptor);
    });

    const touch = (x: number, identifier = 0): TouchPoint => ({ identifier, clientX: x, clientY: 300 });
    const flick = (target: Element, fromX: number, toX: number) => {
      target.dispatchEvent(touchEvent("touchstart", [touch(fromX)], [touch(fromX)]));
      now += 150;
      target.dispatchEvent(touchEvent("touchend", [], [touch(toX)]));
    };

    it("falls back to touch events and fires both directions", () => {
      expect("PointerEvent" in window).toBe(false);
      install();
      flick(row, 100, 260);
      flick(row, 260, 100);
      expect(onSwipeRight).toHaveBeenCalledTimes(1);
      expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    });

    it("cancels on a second finger and on touchcancel", () => {
      install();
      row.dispatchEvent(touchEvent("touchstart", [touch(100)], [touch(100)]));
      row.dispatchEvent(touchEvent("touchstart", [touch(100), touch(300, 1)], [touch(300, 1)]));
      now += 150;
      row.dispatchEvent(touchEvent("touchend", [touch(460, 1)], [touch(260)]));
      row.dispatchEvent(touchEvent("touchstart", [touch(100)], [touch(100)]));
      row.dispatchEvent(touchEvent("touchcancel", [], [touch(100)]));
      now += 150;
      row.dispatchEvent(touchEvent("touchend", [], [touch(260)]));
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("applies the edge and text-field guards", () => {
      const textarea = document.createElement("textarea");
      host.appendChild(textarea);
      install();
      flick(row, 4, 200);
      flick(textarea, 100, 260);
      expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("removes its listeners on cleanup", () => {
      install();
      cleanup?.();
      cleanup = undefined;
      flick(row, 100, 260);
      expect(onSwipeRight).not.toHaveBeenCalled();
    });
  });
});
