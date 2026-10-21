import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipHost } from "../../components/common/TooltipHost";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

function hover(node: Element) {
  fireEvent.pointerOver(node, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(600));
}

describe("the shared themed title hints", () => {
  it("replaces native hints on nested, portaled controls and restores the title on leave", () => {
    render(<><TooltipHost />{createPortal(<button title="Open settings"><span>Settings</span></button>, document.body)}</>);
    const button = screen.getByRole("button");
    fireEvent.pointerOver(screen.getByText("Settings"));
    expect(button.getAttribute("title")).toBe("");
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("tooltip").textContent).toContain("Open settings");
    expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("Open settings");
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps Escape dismissal in effect until leave, without reviving the native hint", () => {
    render(<><TooltipHost /><button title="Close tab">Close</button></>);
    const button = screen.getByRole("button");
    hover(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("");
    hover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("supports keyboard focus and preserves existing descriptions", () => {
    render(<><TooltipHost /><span id="help">Help</span><button title="Details" aria-describedby="help">Info</button></>);
    const button = screen.getByRole("button");
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focusIn(button);
    act(() => vi.advanceTimersByTime(600));
    expect(button.getAttribute("aria-describedby")).toBe(`help ${screen.getByRole("tooltip").id}`);
    fireEvent.focusOut(button);
    expect(button.getAttribute("title")).toBe("Details");
    expect(button.getAttribute("aria-describedby")).toBe("help");
  });

  it("preserves the accessible name of a control named only by its title", () => {
    render(<><TooltipHost /><button title="Pin tab"><svg /></button></>);
    const button = screen.getByRole("button", { name: "Pin tab" });
    hover(button);
    expect(screen.getByRole("button", { name: "Pin tab" })).toBe(button);
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(150));
    expect(button.hasAttribute("aria-label")).toBe(false);
    expect(screen.getByRole("button", { name: "Pin tab" })).toBe(button);
  });

  it("updates a live title and does not resurrect a title cleared by React", async () => {
    const view = render(<><TooltipHost /><button title="Connect">Network</button></>);
    const button = screen.getByRole("button");
    hover(button);
    view.rerender(<><TooltipHost /><button title="Disconnect">Network</button></>);
    await act(async () => {});
    expect(screen.getByRole("tooltip").textContent).toContain("Disconnect");
    expect(button.getAttribute("title")).toBe("");
    view.rerender(<><TooltipHost /><button title="">Network</button></>);
    await act(async () => {});
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("");
  });

  it("preserves title-derived field names even when the fields already have values", () => {
    render(<><TooltipHost /><input title="Search files" defaultValue="notes" /><select title="Theme"><option>Dark</option></select></>);
    const input = screen.getByRole("textbox", { name: "Search files" });
    hover(input);
    expect(screen.getByRole("textbox", { name: "Search files" })).toBe(input);
    const select = screen.getByRole("combobox", { name: "Theme" });
    hover(select);
    expect(screen.getByRole("combobox", { name: "Theme" })).toBe(select);
  });

  it("removes a hint when its trigger disappears", async () => {
    const view = render(<><TooltipHost /><button title="Close">Tab</button></>);
    hover(screen.getByRole("button"));
    view.rerender(<TooltipHost />);
    await act(async () => {});
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("honours an empty child title and ignores touch", () => {
    render(<><TooltipHost /><div title="Parent"><span title="">No hint</span><button title="Touch hint">Touch</button></div></>);
    hover(screen.getByText("No hint"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // jsdom does not supply PointerEvent fields; use an explicit event.
    const touch = new Event("pointerover", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    fireEvent(screen.getByRole("button"), touch);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("allows moving into a long hint without closing it", () => {
    render(<><TooltipHost /><button title="Long hint">Info</button></>);
    const button = screen.getByRole("button");
    hover(button);
    const tooltip = screen.getByRole("tooltip");
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    fireEvent.pointerOver(document.body);
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    fireEvent.pointerOver(tooltip);
    fireEvent.pointerDown(tooltip);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("tooltip")).toBe(tooltip);
  });

  it("flips above a bottom-edge trigger and keeps the hint inside the right edge", () => {
    const rects = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.getAttribute("role") === "tooltip"
        ? DOMRect.fromRect({ width: 200, height: 70 })
        : DOMRect.fromRect({ x: window.innerWidth - 30, y: window.innerHeight - 30, width: 24, height: 24 });
    });
    try {
      render(<><TooltipHost /><button title="Edge hint">Info</button></>);
      hover(screen.getByRole("button"));
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.style.left).toBe(`${window.innerWidth - 208}px`);
      expect(tooltip.style.top).toBe(`${window.innerHeight - 108}px`);
    } finally {
      rects.mockRestore();
    }
  });
});
