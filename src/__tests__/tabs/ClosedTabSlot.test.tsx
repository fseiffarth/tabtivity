/**
 * Closing a tab with its ×: the tab that takes over ends with its own × where
 * the closed tab's was (`lib/tabs/closedTabSlot`), on the real `ScrollingTabStrip`
 * over a small fake layout that clamps scrolling the way a browser does, and the
 * main `TabBar`'s press on a × leaves the tab's own click path alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { ScrollingTabStrip } from "../../components/tabs/ScrollingTabStrip";
import { TabBar } from "../../components/tabs/TabBar";
import { closedTabSlotHeld, noteTabClose } from "../../lib/tabs/closedTabSlot";
import { allGroups, useTabsStore } from "../../stores/tabs";

const STRIP_LEFT = 50;
const CLOSE_INSET = 20; // The ×'s centre, in from the tab's right edge.
const VIEW = 300;

interface T {
  key: string;
  w: number;
  /** Narrowest the tab goes: its badges and × with no label left. */
  min?: number;
  chip?: boolean;
}

const widthOf = (tab: HTMLElement) => parseFloat(tab.style.width) || Number(tab.dataset.w);
const tabsOf = (strip: Element) => Array.from(strip.children) as HTMLElement[];
const slackOf = (strip: HTMLElement) =>
  parseFloat(strip.style.getPropertyValue("--tab-slot-slack")) || 0;
const contentOf = (strip: HTMLElement) =>
  tabsOf(strip).reduce((sum, tab) => sum + widthOf(tab), 0) + slackOf(strip);

function leftOf(tab: HTMLElement): number {
  const strip = tab.parentElement!;
  let x = STRIP_LEFT - strip.scrollLeft;
  for (const other of tabsOf(strip)) {
    if (other === tab) break;
    x += widthOf(other);
  }
  return x;
}

function rect(left: number, width: number): DOMRect {
  return { left, width, right: left + width, top: 0, bottom: 30, height: 30, x: left, y: 0, toJSON: () => ({}) };
}

function fakeLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    if (el.classList.contains("tab")) return rect(leftOf(el), widthOf(el));
    if (el.classList.contains("tab-close")) {
      const tab = el.parentElement!;
      return rect(leftOf(tab) + widthOf(tab) - CLOSE_INSET - 8, 16);
    }
    return rect(STRIP_LEFT, VIEW);
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("tab-strip")
      ? contentOf(this)
      : Math.max(widthOf(this), Number(this.dataset.min) || 0);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("tab-strip") ? Math.min(VIEW, contentOf(this)) : widthOf(this);
  });
}

function clampScroll(strip: HTMLElement, start = 0) {
  let raw = start;
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true,
    get: () => Math.min(raw, Math.max(0, contentOf(strip) - VIEW)),
    set: (v: number) => { raw = v; },
  });
}

function Bar({ tabs, active, onClose }: { tabs: T[]; active: string; onClose?: () => void }) {
  return (
    <ScrollingTabStrip revision={tabs.map((tab) => tab.key).join(",")} activeKey={active}>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          className={`tab${tab.key === active ? " active" : ""}`}
          data-w={tab.w}
          data-min={tab.min}
          data-key={tab.key}
        >
          <span className="tab-label">{tab.key}</span>
          {!tab.chip && (
            <button
              className="tab-close"
              onClick={(e) => {
                noteTabClose(e.currentTarget);
                onClose?.();
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </ScrollingTabStrip>
  );
}

const closeX = (container: Element, key: string) => {
  const r = container.querySelector(`[data-key="${key}"] .tab-close`)!.getBoundingClientRect();
  return r.left + r.width / 2;
};
const stripOf = (container: Element) => container.querySelector<HTMLElement>(".tab-strip")!;
const clickClose = (container: Element, key: string) =>
  fireEvent.click(container.querySelector(`[data-key="${key}"] .tab-close`)!);

/** Close `key` of `tabs`, then show the strip `activeAfter` is current in. */
function closeIn(tabs: T[], key: string, activeAfter: string, scrolled?: number) {
  const view = render(<Bar tabs={tabs} active={key} />);
  const strip = stripOf(view.container);
  if (scrolled !== undefined) clampScroll(strip, scrolled);
  const before = closeX(view.container, key);
  clickClose(view.container, key);
  view.rerender(<Bar tabs={tabs.filter((tab) => tab.key !== key)} active={activeAfter} />);
  return { ...view, strip, before };
}

describe("a closed tab's slot", () => {
  let hovering: boolean;

  beforeEach(() => {
    hovering = true;
    fakeLayout();
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":hover" ? hovering : matches.call(this, selector);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stretches a narrower heir to the closed tab's ×", () => {
    const { container, before } = closeIn(
      [{ key: "a", w: 100 }, { key: "b", w: 200 }, { key: "c", w: 60 }],
      "b",
      "c",
    );
    expect(closeX(container, "c")).toBe(before);
  });

  it("cuts a wider heir down to the closed tab's ×", () => {
    const { container, before } = closeIn(
      [{ key: "a", w: 100 }, { key: "b", w: 60 }, { key: "c", w: 200 }],
      "b",
      "c",
    );
    expect(closeX(container, "c")).toBe(before);
    expect(container.querySelector<HTMLElement>('[data-key="c"]')!.dataset.slotHeld).toBe("");
  });

  it("stretches the left neighbour when the last tab closes", () => {
    const { container, before } = closeIn(
      [{ key: "a", w: 100 }, { key: "b", w: 80 }],
      "b",
      "a",
    );
    expect(closeX(container, "a")).toBe(before);
  });

  it("keeps a strip scrolled to its end where it was", () => {
    const tabs = [
      { key: "a", w: 150 },
      { key: "b", w: 150 },
      { key: "c", w: 100 },
      { key: "d", w: 120 },
      { key: "e", w: 80 },
    ];
    const { container, strip, before } = closeIn(tabs, "c", "d", 300);
    expect(strip.scrollLeft).toBe(300);
    expect(closeX(container, "d")).toBe(before);
  });

  it("never squeezes a tab past its badges and ×", () => {
    const { container } = closeIn(
      [{ key: "a", w: 100 }, { key: "b", w: 60 }, { key: "c", w: 200, min: 150 }],
      "b",
      "c",
    );
    expect(container.querySelector<HTMLElement>('[data-key="c"]')!.style.width).toBe("150px");
  });

  it("leaves a tab-group chip alone", () => {
    const { container, strip } = closeIn(
      [{ key: "a", w: 100 }, { key: "b", w: 60 }, { key: "c", w: 200, chip: true }],
      "b",
      "a",
    );
    expect(closedTabSlotHeld(strip)).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-key="c"]')!.style.width).toBe("");
  });

  it("gives everything back when the pointer leaves the strip", () => {
    const tabs = [
      { key: "a", w: 150 },
      { key: "b", w: 150 },
      { key: "c", w: 100 },
      { key: "d", w: 120 },
    ];
    const { container, strip } = closeIn(tabs, "c", "d", 220);
    expect(closedTabSlotHeld(strip)).toBe(true);
    fireEvent.pointerLeave(strip);
    const heir = container.querySelector<HTMLElement>('[data-key="d"]')!;
    expect(closedTabSlotHeld(strip)).toBe(false);
    expect(heir.style.width).toBe("");
    expect(heir.dataset.slotHeld).toBeUndefined();
    expect(slackOf(strip)).toBe(0);
  });

  it("ends the hold when another tab turns current, and may scroll again", () => {
    const tabs = [{ key: "a", w: 100 }, { key: "b", w: 200 }, { key: "c", w: 60 }];
    const { strip, rerender } = closeIn(tabs, "b", "c");
    const reveal = vi.fn();
    Element.prototype.scrollIntoView = reveal;
    rerender(<Bar tabs={tabs.filter((tab) => tab.key !== "b")} active="a" />);
    expect(closedTabSlotHeld(strip)).toBe(false);
    expect(reveal).toHaveBeenCalled();
  });

  it("does not scroll the heir away in the commit that closed the tab", () => {
    const reveal = vi.fn();
    Element.prototype.scrollIntoView = reveal;
    const tabs = [{ key: "a", w: 100 }, { key: "b", w: 200 }, { key: "c", w: 60 }];
    const view = render(<Bar tabs={tabs} active="b" />);
    reveal.mockClear();
    clickClose(view.container, "b");
    view.rerender(<Bar tabs={tabs.filter((tab) => tab.key !== "b")} active="c" />);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("holds nothing when the pointer is not on the strip (keyboard, a dialog)", () => {
    hovering = false;
    const { container, strip } = closeIn(
      [{ key: "a", w: 100 }, { key: "b", w: 200 }, { key: "c", w: 60 }],
      "b",
      "c",
    );
    expect(closedTabSlotHeld(strip)).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-key="c"]')!.style.width).toBe("");
  });

  it("drops a note whose close came too late", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const tabs = [{ key: "a", w: 100 }, { key: "b", w: 200 }, { key: "c", w: 60 }];
    const view = render(<Bar tabs={tabs} active="b" />);
    clickClose(view.container, "b");
    now.mockReturnValue(5000);
    view.rerender(<Bar tabs={tabs.filter((tab) => tab.key !== "b")} active="c" />);
    expect(closedTabSlotHeld(stripOf(view.container))).toBe(false);
  });
});

describe("TabBar: a press on a tab's ×", () => {
  function seed() {
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
    for (const label of ["one", "two", "three"]) {
      useTabsStore.getState().addTab({ label, cmd: "bash", cwd: "/p", kind: "shell" });
    }
    return allGroups(useTabsStore.getState().layout)[0];
  }

  const pressClose = (tab: Element) => {
    const close = tab.querySelector(".tab-close")!;
    fireEvent.pointerDown(close, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { button: 0, pointerId: 1 });
    fireEvent(window, new MouseEvent("mouseup", { button: 0 }));
    return close;
  };

  afterEach(cleanup);

  it("does not start a rename on the active tab", () => {
    const group = seed();
    const { container } = render(<TabBar groupId={group.id} projectCwd="/p" showGroupClose={false} />);
    pressClose(container.querySelector(".tab.active")!);
    expect(container.querySelector("input.tab-label-edit")).toBeNull();
  });

  it("leaves the current tab current when a background tab closes", () => {
    const group = seed();
    const active = group.activeKey;
    const { container } = render(<TabBar groupId={group.id} projectCwd="/p" showGroupClose={false} />);
    const background = container.querySelector(".tab:not(.active)")!;
    fireEvent.click(pressClose(background));
    expect(allGroups(useTabsStore.getState().layout)[0].activeKey).toBe(active);
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });
});
