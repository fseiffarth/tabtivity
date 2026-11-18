/** The Reader Files view's steering model: pure rows, key-based cursor, key decisions. */
import { describe, expect, it } from "vitest";
import {
  decide,
  effectiveCursor,
  jumpSection,
  rowsOf,
  startKey,
  stepCursor,
} from "../../lib/terminal/readerFilesSteer";

const file = (path: string) => ({ entry: { path } });
const link = (url: string) => ({ url });
const rows = rowsOf([file("/p/a.md"), file("/p/b.pdf")], [link("https://x.test/1"), link("https://x.test/2")]);
const filesOnly = rowsOf([file("/p/a.md"), file("/p/b.pdf")], []);
const linksOnly = rowsOf([], [link("https://x.test/1"), link("https://x.test/2")]);
const plain = { shift: false, repeat: false };

describe("rows and the cursor's start", () => {
  it("lists files, then links", () => {
    expect(rows.map((r) => `${r.kind}:${r.key}`)).toEqual([
      "file:/p/a.md",
      "file:/p/b.pdf",
      "link:https://x.test/1",
      "link:https://x.test/2",
    ]);
  });

  it("starts on the shown file, else the first row, else nothing", () => {
    expect(startKey(rows, "/p/b.pdf")).toBe("/p/b.pdf");
    expect(startKey(rows, "/p/gone.md")).toBe("/p/a.md");
    expect(startKey(rows, null)).toBe("/p/a.md");
    expect(startKey(linksOnly, "/p/b.pdf")).toBe("https://x.test/1");
    expect(startKey([], null)).toBeNull();
  });

  it("keeps a cursor while its row exists, else snaps to the start", () => {
    expect(effectiveCursor(rows, "https://x.test/2", "/p/a.md")).toBe("https://x.test/2");
    expect(effectiveCursor(rows, "https://gone.test", "/p/b.pdf")).toBe("/p/b.pdf");
    expect(effectiveCursor(rows, null, null)).toBe("/p/a.md");
  });

  it("is a key, not an index: rows arriving above it leave it where it was", () => {
    const grown = rowsOf([file("/p/new.md"), file("/p/a.md"), file("/p/b.pdf")], [link("https://x.test/1")]);
    expect(effectiveCursor(grown, "/p/b.pdf", null)).toBe("/p/b.pdf");
    expect(stepCursor(grown, "/p/b.pdf", 1)).toBe("https://x.test/1");
  });
});

describe("stepCursor", () => {
  it("walks files then links and clamps at the end", () => {
    expect(stepCursor(rows, "/p/a.md", 1)).toBe("/p/b.pdf");
    expect(stepCursor(rows, "/p/b.pdf", 1)).toBe("https://x.test/1");
    expect(stepCursor(rows, "https://x.test/2", 1)).toBe("https://x.test/2");
    expect(stepCursor(rows, "https://x.test/1", -1)).toBe("/p/b.pdf");
  });

  it("is `out` for up on the first row, and on an empty list", () => {
    expect(stepCursor(rows, "/p/a.md", -1)).toBe("out");
    expect(stepCursor([], null, -1)).toBe("out");
    expect(stepCursor([], null, 1)).toBe("out");
  });
});

describe("jumpSection", () => {
  it("jumps between the first rows of Files and Links", () => {
    expect(jumpSection(rows, "/p/b.pdf", 1)).toBe("https://x.test/1");
    expect(jumpSection(rows, "https://x.test/2", -1)).toBe("/p/a.md");
  });

  it("stays at the ends, and with one section nothing moves", () => {
    expect(jumpSection(rows, "/p/b.pdf", -1)).toBe("/p/b.pdf");
    expect(jumpSection(rows, "https://x.test/2", 1)).toBe("https://x.test/2");
    expect(jumpSection(filesOnly, "/p/a.md", 1)).toBe("/p/a.md");
    expect(jumpSection(linksOnly, "https://x.test/2", -1)).toBe("https://x.test/2");
  });
});

describe("decide", () => {
  it("moves the cursor with up / down and opens nothing", () => {
    expect(decide(rows, "/p/a.md", "down", plain)).toEqual({ cursor: "/p/b.pdf" });
    expect(decide(rows, "/p/b.pdf", "up", plain)).toEqual({ cursor: "/p/a.md" });
    expect(decide(rows, "https://x.test/2", "down", plain)).toEqual({});
  });

  it("leaves on up from the first row, but not on key repeat", () => {
    expect(decide(rows, "/p/a.md", "up", plain)).toEqual({ effect: "out" });
    expect(decide(rows, "/p/a.md", "up", { shift: false, repeat: true })).toEqual({});
  });

  it("on an empty list, down stays and up leaves (down never steps out of the view)", () => {
    expect(decide([], null, "down", plain)).toEqual({});
    expect(decide([], null, "up", plain)).toEqual({ effect: "out" });
    expect(decide([], null, "up", { shift: false, repeat: true })).toEqual({});
  });

  it("jumps sections with Shift and never leaves", () => {
    expect(decide(rows, "/p/a.md", "down", { shift: true, repeat: false })).toEqual({ cursor: "https://x.test/1" });
    expect(decide(rows, "/p/a.md", "up", { shift: true, repeat: false })).toEqual({});
  });

  it("scrolls half a screen, Shift a whole one", () => {
    expect(decide(rows, "/p/a.md", "right", plain)).toEqual({ effect: "scroll", pages: 0.5 });
    expect(decide(rows, "/p/a.md", "left", plain)).toEqual({ effect: "scroll", pages: -0.5 });
    expect(decide(rows, "/p/a.md", "right", { shift: true, repeat: false })).toEqual({ effect: "scroll", pages: 1 });
    expect(decide([], null, "left", { shift: true, repeat: false })).toEqual({ effect: "scroll", pages: -1 });
  });

  it("opens a file as a tab (Shift: a new subwindow) and a link through onOpenLink", () => {
    expect(decide(rows, "/p/b.pdf", "viewOpen", plain)).toEqual({ effect: "openTab", row: rows[1] });
    expect(decide(rows, "/p/b.pdf", "viewOpen", { shift: true, repeat: false })).toEqual({ effect: "openTabNew", row: rows[1] });
    expect(decide(rows, "https://x.test/1", "viewOpen", plain)).toEqual({ effect: "openLink", row: rows[2] });
    expect(decide(rows, "https://x.test/1", "viewOpen", { shift: true, repeat: false })).toEqual({ effect: "openLink", row: rows[2] });
  });

  it("shows a file with viewOpenAlt, and does nothing on a link", () => {
    expect(decide(rows, "/p/a.md", "viewOpenAlt", plain)).toEqual({ effect: "show", row: rows[0] });
    expect(decide(rows, "https://x.test/1", "viewOpenAlt", plain)).toEqual({});
  });

  it("ignores key repeat on the open and show keys, and an unknown cursor", () => {
    const held = { shift: false, repeat: true };
    expect(decide(rows, "/p/a.md", "viewOpen", held)).toEqual({});
    expect(decide(rows, "/p/a.md", "viewOpenAlt", held)).toEqual({});
    expect(decide(rows, "/p/missing", "viewOpen", plain)).toEqual({});
    expect(decide([], null, "viewOpenAlt", plain)).toEqual({});
  });
});
