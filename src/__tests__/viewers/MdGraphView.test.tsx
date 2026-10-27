import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileText = vi.hoisted(() => vi.fn());
vi.mock("../../lib/files/fileAccess", () => ({
  readFileText,
  useFileScope: () => null,
}));

import { MdGraphView } from "../../components/embed/MdGraphView";

const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const captureDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "setPointerCapture");

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
  Element.prototype.setPointerCapture = vi.fn();
  readFileText.mockImplementation(async (path: string) =>
    path === "/p/ROOT.md"
      ? "[Guide](guide.md)"
      : path === "/p/guide.md"
        ? "# Guide\n\nA useful introduction."
        : null,
  );
});

afterEach(() => {
  if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDescriptor);
  if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDescriptor);
  if (captureDescriptor) Object.defineProperty(Element.prototype, "setPointerCapture", captureDescriptor);
  else Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  vi.restoreAllMocks();
});

describe("MdGraphView navigation", () => {
  it("fits the graph, zooms at the wheel, previews markdown, and keeps node clicks distinct from panning", async () => {
    const onOpen = vi.fn();
    const { container } = render(<MdGraphView path="/p/ROOT.md" onOpen={onOpen} />);
    const label = await screen.findByText("guide.md");
    const node = label.closest("g")!;
    const viewport = container.querySelector<HTMLElement>(".md-graph-viewport")!;
    const svg = viewport.querySelector("svg")!;
    const initialTransform = svg.style.transform;

    // The label can land before the effect that attaches the wheel listener has
    // run (a loaded CI runner showed it), so wheel until one is taken.
    await waitFor(() => {
      const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 250, clientY: 100 });
      fireEvent(viewport, wheel);
      expect(wheel.defaultPrevented).toBe(true);
    });
    await waitFor(() => expect(svg.style.transform).not.toBe(initialTransform));

    fireEvent.mouseEnter(node, { clientX: 250, clientY: 100 });
    expect(container.querySelector(".md-graph-tooltip")?.textContent).toContain("A useful introduction.");

    fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 100, clientY: 80 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    fireEvent.click(node);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(node);
    expect(onOpen).toHaveBeenCalledWith("/p/guide.md");
  });
});
