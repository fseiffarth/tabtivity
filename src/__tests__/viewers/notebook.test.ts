import { describe, it, expect } from "vitest";
import {
  parseNotebook,
  outputToBlocks,
  type NbCell,
} from "../../lib/viewers/notebook";

// A small nbformat v4 fixture: a markdown cell, then a code cell with a stream
// output, an image/png output, an error traceback, and a text/html output that
// MUST be skipped.
const fixture = {
  cells: [
    {
      cell_type: "markdown",
      source: ["# Title\n", "\n", "Some *text*.\n"],
    },
    {
      cell_type: "code",
      source: ["import numpy as np\n", "print('hi')\n"],
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hi\n", "there\n"] },
        {
          output_type: "display_data",
          data: { "image/png": "iVBORw0KGgoAAAANS", "text/plain": ["<Figure>"] },
        },
        {
          output_type: "execute_result",
          data: { "text/html": "<b>danger</b>", "text/plain": "42" },
        },
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "boom",
          traceback: ["\x1b[0;31mValueError\x1b[0m: boom"],
        },
      ],
    },
    { cell_type: "raw", source: "raw body" },
  ],
  metadata: {
    kernelspec: { name: "python3", language: "python" },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

describe("parseNotebook", () => {
  it("reads language, cell types, and joined source", () => {
    const nb = parseNotebook(fixture);
    expect(nb.language).toBe("python");
    // markdown, code, raw(->markdown)
    expect(nb.cells.map((c) => c.type)).toEqual(["markdown", "code", "markdown"]);
    expect(nb.cells[0].source).toBe("# Title\n\nSome *text*.\n");
    expect(nb.cells[1].source).toBe("import numpy as np\nprint('hi')\n");
    expect(nb.cells[2].source).toBe("raw body");
  });

  it("accepts a JSON string as well as an object", () => {
    const nb = parseNotebook(JSON.stringify(fixture));
    expect(nb.language).toBe("python");
    expect(nb.cells).toHaveLength(3);
  });

  it("falls back to python and empty cells on bad input", () => {
    expect(parseNotebook("{not json")).toEqual({ language: "python", cells: [] });
    expect(parseNotebook({} as object)).toEqual({ language: "python", cells: [] });
  });

  it("uses language_info.name when kernelspec lacks language", () => {
    const nb = parseNotebook({
      cells: [],
      metadata: { language_info: { name: "julia" } },
    });
    expect(nb.language).toBe("julia");
  });

  it("classifies code-cell outputs and SKIPS text/html", () => {
    const nb = parseNotebook(fixture);
    const code = nb.cells[1] as NbCell;
    expect(code.outputs).toBeDefined();
    const outs = code.outputs!;
    // stream(text) + image(png) + execute_result(text/plain, html skipped) + error(text)
    expect(outs).toHaveLength(4);
    expect(outs[0]).toEqual({ kind: "text", text: "hi\nthere\n" });
    expect(outs[1]).toEqual({ kind: "image", pngBase64: "iVBORw0KGgoAAAANS" });
    // The execute_result has both text/html and text/plain — html is dropped,
    // plain is kept; no block carries any HTML.
    expect(outs[2]).toEqual({ kind: "text", text: "42" });
    expect(outs[3]).toEqual({ kind: "text", text: "ValueError: boom" });
    expect(outs.some((o) => typeof o.text === "string" && o.text.includes("<b>"))).toBe(false);
  });
});

describe("outputToBlocks", () => {
  it("skips an output that only has text/html", () => {
    expect(
      outputToBlocks({ output_type: "display_data", data: { "text/html": "<b>x</b>" } }),
    ).toEqual([]);
  });

  it("joins split base64 png line arrays", () => {
    expect(
      outputToBlocks({ output_type: "display_data", data: { "image/png": ["AAA", "BBB"] } }),
    ).toEqual([{ kind: "image", pngBase64: "AAABBB" }]);
  });

  it("returns no blocks for unknown output types or junk", () => {
    expect(outputToBlocks({ output_type: "weird" })).toEqual([]);
    expect(outputToBlocks(null)).toEqual([]);
    expect(outputToBlocks("nope")).toEqual([]);
  });
});

describe("outputToBlocks — ANSI", () => {
  it("strips colour codes from stream text and tracebacks", () => {
    expect(outputToBlocks({ output_type: "stream", text: "\x1b[0;31mred\x1b[0m text" })).toEqual([{ kind: "text", text: "red text" }]);
    expect(outputToBlocks({ output_type: "error", traceback: ["\x1b[0;31mBoom\x1b[0m"] })).toEqual([{ kind: "text", text: "Boom" }]);
  });
});
