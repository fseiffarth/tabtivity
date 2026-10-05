/**
 * The desktop markup layer (`PdfMarkupLayer`): a pointer on the page becomes a
 * mark in the page's own units — its points after `/Rotate`, what the phone
 * draws in and the backend bakes from — whatever the viewer's zoom.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfMarkupLayer, pagePoint } from "../../components/embed/pdf/PdfMarkupLayer";
import type { MarkupEdit } from "../../components/embed/pdf/usePdfMarkup";
import { EMPTY_LAYER, addMark, type Layer } from "../../../mobile-web/src/markup/layer";

const SIZE: [number, number] = [600, 800];

function stubEdit(over: Partial<MarkupEdit> = {}, base: Layer = EMPTY_LAYER): MarkupEdit {
  return {
    layer: base,
    base,
    showSent: true,
    tool: "box",
    color: "yellow",
    busy: false,
    note: null,
    add: vi.fn(() => true),
    scratch: vi.fn(),
    commit: vi.fn(),
    openNote: vi.fn(),
    editNote: vi.fn(),
    saveNote: vi.fn(),
    cancelNote: vi.fn(),
    ...over,
  };
}

/** The layer as laid out at `scale`, 10 px from the left, 20 from the top. */
function mount(scale: number, edit: MarkupEdit) {
  const { container } = render(<PdfMarkupLayer n={1} size={SIZE} scale={scale} edit={edit} />);
  const layer = container.querySelector(".file-viewer-pdf-markup-layer") as HTMLDivElement;
  layer.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: SIZE[0] * scale, height: SIZE[1] * scale, right: 0, bottom: 0, x: 10, y: 20, toJSON() {} }) as DOMRect;
  /** A client point over page point (x, y). */
  const at = (x: number, y: number) => ({ clientX: 10 + x * scale, clientY: 20 + y * scale });
  return { layer, at };
}

// jsdom has no 2D canvas; the drawing itself is the phone's `rasterize.ts`.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("pagePoint", () => {
  it("maps the same page point at any zoom and keeps it on the page", () => {
    const box1 = { left: 10, top: 20, width: 600, height: 800 };
    const box2 = { left: 10, top: 20, width: 1200, height: 1600 };
    expect(pagePoint(box1, SIZE, 1, 310, 420)).toEqual([300, 400]);
    expect(pagePoint(box2, SIZE, 2, 610, 820)).toEqual([300, 400]);
    expect(pagePoint(box1, SIZE, 1, -50, 5_000)).toEqual([0, 800]);
    // No layout yet (a zero box): the viewer's scale stands in.
    expect(pagePoint({ left: 0, top: 0, width: 0, height: 0 }, SIZE, 2, 200, 100)).toEqual([100, 50]);
  });
});

describe("PdfMarkupLayer", () => {
  it.each([1, 2.5])("draws a highlighter box in page units at %sx", (scale) => {
    const edit = stubEdit();
    const { layer, at } = mount(scale, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, ...at(100, 100) });
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: "mouse", ...at(160, 130) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", ...at(200, 150) });
    expect(edit.add).toHaveBeenCalledWith(1, SIZE, { kind: "box", color: "yellow", rect: [100, 100, 100, 50] });
  });

  it.each([1, 2])("draws a pen stroke in page units at %sx", (scale) => {
    const edit = stubEdit({ tool: "ink", color: "red" });
    const { layer, at } = mount(scale, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, ...at(50, 60) });
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: "mouse", ...at(120, 60) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", ...at(120, 60) });
    const [n, size, mark] = (edit.add as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(n).toBe(1);
    expect(size).toEqual(SIZE);
    expect(mark.kind).toBe("ink");
    expect(mark.points[0]).toEqual([50, 60, 0.5]);
    expect(mark.points[mark.points.length - 1]).toEqual([120, 60, 0.5]);
  });

  it("ignores a right or middle button", () => {
    const edit = stubEdit();
    const { layer, at } = mount(1, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 2, ...at(100, 100) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", ...at(200, 200) });
    expect(edit.add).not.toHaveBeenCalled();
  });

  it("opens a note where the note tool clicks, sized to the page", () => {
    const edit = stubEdit({ tool: "text", color: "blue" });
    const { layer, at } = mount(2, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, ...at(40, 70) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", ...at(40, 70) });
    expect(edit.openNote).toHaveBeenCalledWith({
      n: 1, pageSize: SIZE, at: [40, 70], index: null, text: "", color: "blue", size: 15,
    });
  });

  it("erases the whole mark under the eraser in one undo step", () => {
    const base = addMark(EMPTY_LAYER, 1, SIZE, { kind: "box", color: "yellow", rect: [100, 100, 50, 50] });
    const edit = stubEdit({ tool: "eraser" }, base);
    const { layer, at } = mount(1, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, ...at(120, 120) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", ...at(120, 120) });
    expect(edit.commit).toHaveBeenCalledWith({ ...base, pages: {} });
  });

  it("erases with a pen's eraser end whatever tool is armed", () => {
    const base = addMark(EMPTY_LAYER, 1, SIZE, { kind: "box", color: "yellow", rect: [100, 100, 50, 50] });
    const edit = stubEdit({ tool: "ink" }, base);
    const { layer, at } = mount(1, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "pen", button: 5, buttons: 32, ...at(120, 120) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen", ...at(120, 120) });
    expect(edit.commit).toHaveBeenCalledWith({ ...base, pages: {} });
    expect(edit.add).not.toHaveBeenCalled();
  });

  it("draws nothing while a Submit uploads", () => {
    const edit = stubEdit({ busy: true });
    const { layer, at } = mount(1, edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, ...at(100, 100) });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", ...at(200, 150) });
    expect(edit.add).not.toHaveBeenCalled();
  });
});
