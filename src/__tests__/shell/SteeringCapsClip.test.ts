import { afterEach, describe, expect, it, vi } from "vitest";
import { measureCaps } from "../../lib/shortcuts/steeringCaps";

/** A settings dialog's scrolling list holding the steered row: the list
 *  shows y 300–700, the row sits at `rowTop`. */
function mount(rowTop: number) {
  const list = document.createElement("div");
  list.style.overflowY = "auto";
  const row = document.createElement("button");
  row.className = "steer-cursor";
  list.appendChild(row);
  document.body.appendChild(list);
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === list) return box(700, 300, 600, 400);
    if (this === row) return box(720, rowTop, 400, 28);
    return box(0, 0, 0, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the region cursor's Enter cap", () => {
  it("rides a row that is shown in its list", () => {
    mount(400);
    expect(measureCaps(["cursor"]).cursor).toMatchObject({ x: 1122, y: 389 });
  });

  it("is dropped when the row is scrolled out of its list, not drawn above it", () => {
    mount(150);
    expect(measureCaps(["cursor"]).cursor).toBeUndefined();
  });

  it("rides the shown part of a row half out of its list", () => {
    mount(290);
    expect(measureCaps(["cursor"]).cursor?.y).toBe(289);
  });
});
