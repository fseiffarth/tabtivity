/**
 * `CommittedMarks` (`mobile-web/src/markup/rasterize.ts`): a gesture that
 * repaints a page on every pointer move copies the marks it has not changed
 * and draws the rest over them — the same drawing, in the same order, as a
 * whole repaint (overlapping and see-through marks depend on it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMark, EMPTY_LAYER, eraseAt, moveMarks, type InkMark, type Layer, type Mark,
} from "../../../mobile-web/src/markup/layer";
import { CommittedMarks, paintLayer } from "../../../mobile-web/src/markup/rasterize";

const SIZE: [number, number] = [600, 800];
const K = 1.5;
const pen = (x: number, color: InkMark["color"] = "red"): InkMark => ({ kind: "ink", color, width: 3, points: [[x, 100, 0.5], [x + 60, 130, 0.5], [x + 120, 100, 0.5]] });
const marker: InkMark = { kind: "ink", color: "yellow", width: 14, style: "marker", points: [[60, 110, 0.5], [200, 120, 0.5]] };
const MARKS: Mark[] = [
  pen(50),
  marker,
  { kind: "box", color: "yellow", rect: [80, 90, 150, 40] },
  { kind: "text", color: "blue", at: [90, 200], size: 14, text: "hello" },
  pen(70, "black"),
];
const SENT: Mark[] = [{ kind: "box", color: "green", rect: [10, 10, 100, 30] }];

function layerOf(marks: readonly Mark[], sent: readonly Mark[] = []): Layer {
  let layer = EMPTY_LAYER;
  for (const mark of marks) layer = addMark(layer, 1, SIZE, mark);
  if (sent.length) layer = { ...layer, sent: { pages: { 1: { size: SIZE, marks: [...sent] } }, rounds: 1 } };
  return layer;
}

/** Every context's calls and property writes, by canvas. */
const logs = new Map<HTMLCanvasElement, string[]>();
const order: HTMLCanvasElement[] = [];

function recording(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const log: string[] = [];
  logs.set(canvas, log);
  order.push(canvas);
  return new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]) => {
      log.push(name === "drawImage" ? "drawImage" : `${name}(${args.join(",")})`);
    },
    set: (_target, name: string, value: unknown) => {
      log.push(`${name}=${String(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** A canvas with its recorded context (made once). */
function canvasOf(w = 400, h = 500): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

beforeEach(() => {
  logs.clear();
  order.length = 0;
  const contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, recording(this));
    return contexts.get(this) as never;
  } as never);
});
afterEach(() => vi.restoreAllMocks());

/** What the draw calls were, in order: the state saves, restores and
 *  transform wrappers dropped (a split page wraps twice), and the copy's own
 *  drawing put where the `drawImage` of it lands. */
function flatten(canvas: HTMLCanvasElement, copy?: HTMLCanvasElement): string[] {
  const noise = /^(save|restore|scale|clearRect)\b/;
  return logs.get(canvas)!.flatMap((line) => {
    if (line === "drawImage") return copy ? logs.get(copy)!.filter((l) => !noise.test(l)) : [];
    return noise.test(line) ? [] : [line];
  });
}

/** The plain repaint's calls on a fresh canvas. */
function direct(page: Layer["pages"][number] | undefined, sent: Layer["pages"][number] | undefined): string[] {
  const canvas = canvasOf();
  paintLayer(canvas.getContext("2d") as never, page, sent, K);
  return logs.get(canvas)!.filter((line) => !/^(save|restore|scale|clearRect)\b/.test(line));
}

describe("CommittedMarks", () => {
  it("draws a moved selection over the unchanged marks exactly as a whole repaint does", () => {
    const base = layerOf(MARKS, SENT);
    const moved = moveMarks(base, 1, [2], 30, 20);
    expect(moved.pages[1].marks[1]).toBe(MARKS[1]);
    expect(moved.pages[1].marks[2]).not.toBe(base.pages[1].marks[2]);
    const reference = direct(moved.pages[1], moved.sent!.pages[1]);
    order.length = 0;

    const held = new CommittedMarks();
    const canvas = canvasOf();
    held.paint(canvas.getContext("2d") as never, canvas, moved.pages[1], base.pages[1], base.sent!.pages[1], K);
    // The first two marks and the sent box are in the copy; the rest go on top.
    expect(order).toHaveLength(2);
    expect(flatten(canvas, order[1])).toEqual(reference);
    // A second move over the same marks repaints from the same copy.
    const again = moveMarks(base, 1, [2], 50, 40);
    const second = canvasOf();
    held.paint(second.getContext("2d") as never, second, again.pages[1], base.pages[1], base.sent!.pages[1], K);
    expect(order).toHaveLength(3);
    expect(flatten(second, order[1])).toEqual(direct(again.pages[1], again.sent!.pages[1]));
    held.drop();
  });

  it("rebuilds the copy when the unchanged prefix shrinks, and gives it back on drop", () => {
    const base = layerOf(MARKS);
    // The eraser takes the note first, then a mark further down.
    const first = eraseAt(base, 1, 90, 205, 4, { whole: true });
    const held = new CommittedMarks();
    const canvas = canvasOf();
    const ctx = canvas.getContext("2d") as never;
    held.paint(ctx, canvas, first.pages[1], base.pages[1], undefined, K);
    const copyOne = order[1];
    expect(copyOne.width).toBe(400);
    const next = eraseAt(first, 1, 100, 100, 4, { whole: true });
    expect(next.pages[1].marks.length).toBeLessThan(first.pages[1].marks.length);
    const second = canvasOf();
    held.paint(second.getContext("2d") as never, second, next.pages[1], base.pages[1], undefined, K);
    // order: canvas, copy one, second, copy two.
    expect(order).toHaveLength(4);
    expect(copyOne.width).toBe(0);
    expect(flatten(second, order[3])).toEqual(direct(next.pages[1], undefined));
    held.drop();
    expect(order[3].width).toBe(0);
  });

  it("makes no copy when nothing is unchanged and nothing is sent", () => {
    const base = layerOf(MARKS);
    const edited = eraseAt(base, 1, 50, 100, 4, { whole: true });
    expect(edited.pages[1].marks[0]).not.toBe(MARKS[0]);
    const held = new CommittedMarks();
    const canvas = canvasOf();
    held.paint(canvas.getContext("2d") as never, canvas, edited.pages[1], base.pages[1], undefined, K);
    expect(order).toEqual([canvas]);
    expect(flatten(canvas)).toEqual(direct(edited.pages[1], undefined));
  });
});
