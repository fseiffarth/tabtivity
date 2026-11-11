/**
 * Steering's DOM helpers (`mobile-web/src/steering/steeringDom`): which rows
 * the cursor may stand on, the walk, focusing, the top surface, the sheet's
 * controls and the scroll writes. jsdom has no layout, so none of these may
 * need one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWN_KEYS_SELECTOR,
  controls,
  focusRow,
  ownKeysUp,
  press,
  cursorRow,
  rowAct,
  rowById,
  rows,
  screenAct,
  scrollStep,
  scrollTarget,
  toLatest,
  topModal,
  walk,
} from "../../../mobile-web/src/steering/steeringDom";
import { stubLayout } from "../helpers/mobileSteering";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

let layout: ReturnType<typeof stubLayout>;

beforeEach(() => {
  layout = stubLayout();
});

afterEach(() => {
  layout.restore();
  document.body.replaceChildren();
});

describe("rows", () => {
  it("lists the steering rows in document order and skips what cannot be reached", () => {
    mount(`
      <button data-steer-row="a">A</button>
      <button data-steer-row="b" disabled>B</button>
      <div hidden><button data-steer-row="c">C</button></div>
      <div inert><button data-steer-row="d">D</button></div>
      <div aria-hidden="true"><button data-steer-row="e">E</button></div>
      <button data-steer-row="f">F</button>
      <button>not a row</button>`);
    expect(rows().map((row) => row.dataset.steerRow)).toEqual(["a", "f"]);
  });

  it("asks checkVisibility where the browser has it", () => {
    mount(`<button data-steer-row="a">A</button><button data-steer-row="b">B</button>`);
    const proto = Element.prototype as unknown as { checkVisibility?: unknown };
    proto.checkVisibility = function (this: Element) {
      return (this as HTMLElement).dataset.steerRow !== "b";
    };
    try {
      expect(rows().map((row) => row.dataset.steerRow)).toEqual(["a"]);
    } finally {
      delete proto.checkVisibility;
    }
  });

  it("finds a row by its id", () => {
    mount(`<button data-steer-row="a&quot;]">A</button><button data-steer-row="b">B</button>`);
    expect(rowById("b")?.textContent).toBe("B");
    expect(rowById('a"]')?.textContent).toBe("A");
    expect(rowById("zzz")).toBeNull();
  });
});

describe("walk", () => {
  function list() {
    mount(`<button data-steer-row="a">A</button><button data-steer-row="b">B</button><button data-steer-row="c">C</button>`);
    return rows();
  }

  it("steps and wraps at both ends", () => {
    const [a, b, c] = list();
    expect(walk([a, b, c], 1, a)).toBe(b);
    expect(walk([a, b, c], 1, c)).toBe(a);
    expect(walk([a, b, c], -1, a)).toBe(c);
    expect(walk([a, b, c], -1, c)).toBe(b);
  });

  it("starts from the first row going down and the last going up when nothing is focused", () => {
    const [a, , c] = list();
    expect(walk(rows(), 1, null)?.dataset.steerRow).toBe("a");
    expect(walk(rows(), -1, null)?.dataset.steerRow).toBe("c");
    expect(walk([a, c], 1, document.body)).toBe(a);
  });

  it("walks from the card's row when focus is on a button inside the card", () => {
    mount(`<div class="tab-card" id="card1"><button data-steer-row="t1">open</button><button class="more">more</button></div>
      <div class="tab-card"><button data-steer-row="t2">open</button></div>`);
    const list2 = rows();
    const more = document.querySelector<HTMLElement>(".more")!;
    expect(walk(list2, 1, more)).toBe(list2[1]);
    expect(walk(list2, -1, more)).toBe(list2[1]);
    expect(walk(list2, 1, list2[1])).toBe(list2[0]);
  });

  it("returns null for an empty list", () => {
    expect(walk([], 1, null)).toBeNull();
  });
});

describe("cursorRow", () => {
  it("is the focused row, the row of a card whose other button has focus, or null", () => {
    const host = mount(`<div class="tab-card"><button data-steer-row="t1" id="o1">open</button><button id="m1">more</button></div>
      <div class="tab-card"><button data-steer-row="t2" id="o2">open</button></div><button id="fab">+</button>`);
    const list = rows(host);
    expect(cursorRow(list, document.getElementById("o2"))?.id).toBe("o2");
    expect(cursorRow(list, document.getElementById("m1"))?.id).toBe("o1");
    expect(cursorRow(list, document.getElementById("fab"))).toBeNull();
    expect(cursorRow(list, null)).toBeNull();
    expect(cursorRow(list, document.body)).toBeNull();
  });
});

describe("focusRow", () => {
  it("focuses without scrolling, then scrolls the nearest way", () => {
    mount(`<button data-steer-row="a">A</button>`);
    const [a] = rows();
    const focus = vi.spyOn(a, "focus");
    focusRow(a);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(a);
    expect(layout.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("copes with a browser that lacks scrollIntoView", () => {
    layout.restore();
    mount(`<button data-steer-row="a">A</button>`);
    expect(() => focusRow(rows()[0])).not.toThrow();
    layout = stubLayout();
  });
});

describe("topModal and ownKeysUp", () => {
  it("is null with no sheet and the last connected one otherwise", () => {
    expect(topModal()).toBeNull();
    mount(`<section id="one" aria-modal="true"></section><section id="two" aria-modal="true"></section>`);
    expect(topModal()?.id).toBe("two");
  });

  it("skips a sheet that is inert", () => {
    mount(`<section id="one" aria-modal="true"></section><div inert><section id="two" aria-modal="true"></section></div>`);
    expect(topModal()?.id).toBe("one");
  });

  it("ignores aria-modal=false (a paned surface)", () => {
    mount(`<section class="files-library" aria-modal="false"></section>`);
    expect(topModal()).toBeNull();
  });

  it("an own-keys surface on top pauses steering", () => {
    mount(`<section class="files-library" aria-modal="true"></section>`);
    expect(ownKeysUp()).toBe(true);
    document.body.replaceChildren();
    mount(`<div class="outbox-viewer markup-view" aria-modal="false"></div>`);
    expect(ownKeysUp()).toBe(true);
  });

  it("a sheet over the library is walked instead: the library is inert and the sheet is on top", () => {
    mount(`<section class="files-library" aria-modal="true" inert></section><section class="option-sheet" aria-modal="true"></section>`);
    expect(ownKeysUp()).toBe(false);
  });

  it("a different modal over a still-live surface means a region", () => {
    mount(`<section class="outbox-viewer" aria-modal="false"></section><section class="option-sheet" aria-modal="true"></section>`);
    expect(ownKeysUp()).toBe(false);
  });

  it("no surface, no pause", () => {
    mount(`<main></main>`);
    expect(ownKeysUp()).toBe(false);
  });

  it("a hidden surface does not pause", () => {
    mount(`<div hidden><section class="files-library"></section></div>`);
    expect(ownKeysUp()).toBe(false);
  });

  it("a library docked beside the chat owns the keys only while the focus is in it", () => {
    mount(`<main><textarea id="composer"></textarea></main><section class="files-library" aria-modal="false" data-docked=""><button id="item">src</button></section>`);
    expect(ownKeysUp()).toBe(false);
    (document.getElementById("composer") as HTMLElement).focus();
    expect(ownKeysUp()).toBe(false);
    (document.getElementById("item") as HTMLElement).focus();
    expect(ownKeysUp()).toBe(true);
  });

  it("names the two surface classes", () => {
    expect(OWN_KEYS_SELECTOR).toBe(".files-library, .outbox-viewer");
  });
});

describe("controls and press", () => {
  it("lists a sheet's focusable controls in order, without the disabled and hidden ones", () => {
    const host = mount(`<section aria-modal="true">
      <button id="a">A</button><button id="b" disabled>B</button><div hidden><button id="c">C</button></div>
      <input id="d" type="text"><a id="e" href="#x">E</a></section>`);
    expect(controls(host.firstElementChild as HTMLElement).map((el) => el.id)).toEqual(["a", "d", "e"]);
  });

  it("clicks a button and puts the caret in a text field", () => {
    mount(`<button id="b">B</button><input id="i" type="text"><input id="k" type="checkbox">`);
    const button = document.getElementById("b")!;
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    expect(press(button)).toBe("clicked");
    expect(onClick).toHaveBeenCalledTimes(1);
    const input = document.getElementById("i")!;
    expect(press(input)).toBe("focused");
    expect(document.activeElement).toBe(input);
    const box = document.getElementById("k") as HTMLInputElement;
    expect(press(box)).toBe("clicked");
    expect(box.checked).toBe(true);
  });
});

describe("row and screen acts", () => {
  it("clicks the marked button of the card holding the row", () => {
    mount(`<div class="tab-card"><button data-steer-row="t1">open</button><button data-steer-act="menu" id="m1">more</button><button data-steer-act="close" id="x1">x</button></div>
      <div class="tab-card"><button data-steer-row="t2">open</button><button data-steer-act="close" id="x2">x</button></div>`);
    const x1 = vi.fn();
    const x2 = vi.fn();
    document.getElementById("x1")!.addEventListener("click", x1);
    document.getElementById("x2")!.addEventListener("click", x2);
    expect(rowAct("t2", "close")).toBe(true);
    expect(x1).not.toHaveBeenCalled();
    expect(x2).toHaveBeenCalledTimes(1);
    expect(rowAct("t2", "menu")).toBe(false);
  });

  it("does nothing when the card is gone or the marker is missing", () => {
    mount(`<div class="tab-card"><button data-steer-row="t1">open</button></div><div class="home-project-card"><button data-steer-row="p1">p</button></div>`);
    expect(rowAct("nope", "close")).toBe(false);
    expect(rowAct("t1", "close")).toBe(false);
    expect(rowAct("p1", "new")).toBe(false);
  });

  it("a Home project row acts through its project card", () => {
    mount(`<div class="home-project-card"><button class="card" data-steer-row="p1">p</button><button data-steer-act="menu" id="p">more</button></div>`);
    const onClick = vi.fn();
    document.getElementById("p")!.addEventListener("click", onClick);
    expect(rowAct("p1", "menu")).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("acts through the row that stands in a card when a tab stands twice (split: Needs you, then its project's card)", () => {
    // The Needs-you row comes first in document order and has no card.
    mount(`<ul><li><button data-steer-row="t1">needs you</button></li></ul>
      <div class="tab-card"><button data-steer-row="t1">open</button><button data-steer-act="close" id="x1">x</button></div>`);
    const onClick = vi.fn();
    document.getElementById("x1")!.addEventListener("click", onClick);
    expect(rowAct("t1", "close")).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Behind a sheet (the confirm that asked) it is the same row.
    expect(rowAct("t1", "close", true)).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("reaches a card behind a sheet (inert) only when asked to, and never a disabled button", () => {
    mount(`<main inert><div class="tab-card"><button data-steer-row="t1">open</button><button data-steer-act="close" id="x1">x</button></div>
      <div class="tab-card"><button data-steer-row="t2">open</button><button data-steer-act="close" id="x2" disabled>x</button></div></main>`);
    const x1 = vi.fn();
    document.getElementById("x1")!.addEventListener("click", x1);
    expect(rowAct("t1", "close")).toBe(false);
    expect(x1).not.toHaveBeenCalled();
    expect(rowAct("t1", "close", true)).toBe(true);
    expect(x1).toHaveBeenCalledTimes(1);
    expect(rowAct("t2", "close", true)).toBe(false);
  });

  it("clicks the screen's own marked button", () => {
    mount(`<button data-steer-act="new" id="n" disabled>x</button><button data-steer-act="new" id="n2">y</button>`);
    const onClick = vi.fn();
    document.getElementById("n2")!.addEventListener("click", onClick);
    expect(screenAct("new")).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screenAct("close")).toBe(false);
  });
});

describe("scrolling", () => {
  it("scrolls the chat by a step with no layout, and a page with Shift", () => {
    mount(`<div data-steer-scroll id="chat"></div>`);
    const chat = document.getElementById("chat")!;
    expect(chat.clientHeight).toBe(0);
    expect(scrollStep(1)).toBe(true);
    expect(chat.scrollTop).toBe(48);
    expect(scrollStep(1, true)).toBe(true);
    expect(chat.scrollTop).toBe(48 + 96);
    expect(scrollStep(-1)).toBe(true);
    expect(chat.scrollTop).toBe(96);
  });

  it("uses a third of the height, and nine tenths for a page, when there is a height", () => {
    mount(`<div data-steer-scroll id="chat"></div>`);
    const chat = document.getElementById("chat")!;
    Object.defineProperty(chat, "clientHeight", { value: 600, configurable: true });
    scrollStep(1);
    expect(chat.scrollTop).toBe(200);
    scrollStep(1, true);
    expect(chat.scrollTop).toBe(200 + 540);
  });

  it("falls back to the visible terminal's viewport and prefers the chat", () => {
    mount(`<div class="xterm-viewport" id="term"></div>`);
    expect(scrollTarget()?.id).toBe("term");
    mount(`<div data-steer-scroll id="chat"></div>`);
    expect(scrollTarget()?.id).toBe("chat");
  });

  it("skips a hidden scroller and reports no target", () => {
    mount(`<div hidden><div data-steer-scroll></div></div>`);
    expect(scrollTarget()).toBeNull();
    expect(scrollStep(1)).toBe(false);
    expect(toLatest()).toBe(false);
  });

  it("jumps to the end", () => {
    mount(`<div data-steer-scroll id="chat"></div>`);
    const chat = document.getElementById("chat")!;
    Object.defineProperty(chat, "scrollHeight", { value: 5000, configurable: true });
    expect(toLatest()).toBe(true);
    expect(chat.scrollTop).toBe(5000);
  });
});
