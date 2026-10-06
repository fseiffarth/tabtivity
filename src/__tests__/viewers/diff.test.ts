import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, wholeFileHunk } from "../../lib/viewers/diff";

describe("parseUnifiedDiff", () => {
  it("parses a two-file git diff with adds/dels/context", () => {
    const diff = [
      "diff --git a/foo.txt b/foo.txt",
      "index 111..222 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-old two",
      "+new two",
      " line three",
      "diff --git a/bar.txt b/bar.txt",
      "index 333..444 100644",
      "--- a/bar.txt",
      "+++ b/bar.txt",
      "@@ -10,2 +10,3 @@",
      " keep",
      "+added",
      " tail",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);

    expect(files[0].oldPath).toBe("foo.txt");
    expect(files[0].newPath).toBe("foo.txt");
    expect(files[0].hunks).toHaveLength(1);
    expect(files[1].oldPath).toBe("bar.txt");
    expect(files[1].newPath).toBe("bar.txt");
    expect(files[1].hunks).toHaveLength(1);

    const body0 = files[0].hunks[0].lines.filter((l) => l.type !== "hunk");
    expect(body0.map((l) => l.type)).toEqual(["context", "del", "add", "context"]);
  });

  it("tracks old/new line numbering across a hunk", () => {
    const diff = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,3 +1,3 @@",
      " ctx1",
      "-removed",
      "+inserted",
      " ctx2",
      "",
    ].join("\n");

    const file = parseUnifiedDiff(diff)[0];
    const lines = file.hunks[0].lines;

    // hunk header line
    expect(lines[0].type).toBe("hunk");
    expect(lines[0].oldNo).toBeNull();
    expect(lines[0].newNo).toBeNull();

    // " ctx1" → old 1, new 1
    expect(lines[1]).toMatchObject({ type: "context", oldNo: 1, newNo: 1 });
    // "-removed" → old 2, new null
    expect(lines[2]).toMatchObject({ type: "del", oldNo: 2, newNo: null });
    // "+inserted" → old null, new 2
    expect(lines[3]).toMatchObject({ type: "add", oldNo: null, newNo: 2 });
    // " ctx2" → old 3, new 3
    expect(lines[4]).toMatchObject({ type: "context", oldNo: 3, newNo: 3 });

    // text has the leading marker stripped
    expect(lines[2].text).toBe("removed");
    expect(lines[3].text).toBe("inserted");
    expect(lines[1].text).toBe("ctx1");
  });

  it("recognises the \\ No newline at end of file marker", () => {
    const diff = [
      "--- a/y",
      "+++ b/y",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const lines = parseUnifiedDiff(diff)[0].hunks[0].lines;
    const noNewline = lines.filter((l) => l.type === "nonewline");
    expect(noNewline).toHaveLength(2);
    expect(noNewline[0].text).toContain("No newline");
    expect(noNewline[0].oldNo).toBeNull();
    expect(noNewline[0].newNo).toBeNull();
  });

  it("parses a headerless diff (no diff --git) into one file", () => {
    const diff = [
      "--- a/only.txt",
      "+++ b/only.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-was",
      "+is",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe("only.txt");
    expect(files[0].newPath).toBe("only.txt");
    expect(files[0].hunks).toHaveLength(1);
  });

  it("parses /dev/null paths for added files", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n");

    const file = parseUnifiedDiff(diff)[0];
    expect(file.oldPath).toBe("/dev/null");
    expect(file.newPath).toBe("new.txt");
    const adds = file.hunks[0].lines.filter((l) => l.type === "add");
    expect(adds.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it("handles multiple hunks in one file", () => {
    const diff = [
      "--- a/multi",
      "+++ b/multi",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,2 @@",
      " x",
      "-y",
      "+Y",
      "",
    ].join("\n");

    const file = parseUnifiedDiff(diff)[0];
    expect(file.hunks).toHaveLength(2);
    // second hunk re-seeds the line counters at 10
    const second = file.hunks[1].lines;
    expect(second[1]).toMatchObject({ type: "context", oldNo: 10, newNo: 10 });
    expect(second[2]).toMatchObject({ type: "del", oldNo: 11 });
    expect(second[3]).toMatchObject({ type: "add", newNo: 11 });
  });
});

describe("wholeFileHunk", () => {
  const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -2,3 +2,3 @@", " b", "-c", "+C", " d"].join("\n");
  const text = "a\nb\nC\nd\ne\n";
  const cells = (text: string, file = parseUnifiedDiff(diff)[0]) =>
    wholeFileHunk(file, text)?.lines.map((l) => `${l.type}:${l.oldNo ?? "-"}:${l.newNo ?? "-"}:${l.text}`);

  it("spreads the hunks over every line of the file", () => {
    expect(cells(text)).toEqual([
      "context:1:1:a",
      "context:2:2:b",
      "del:3:-:c",
      "add:-:3:C",
      "context:4:4:d",
      "context:5:5:e",
    ]);
  });

  it("shows an unchanged file whole, as context", () => {
    expect(wholeFileHunk(undefined, "x\r\ny")?.lines.map((l) => l.text)).toEqual(["x", "y"]);
  });

  it("gives up when the hunks no longer fit the file", () => {
    expect(cells("a\nb\nX\nd\ne\n")).toBeUndefined();
    expect(cells("a\nb\n")).toBeUndefined();
  });

  it("gives up on a deleted file", () => {
    const deleted = parseUnifiedDiff(["--- a/f.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-a"].join("\n"))[0];
    expect(wholeFileHunk(deleted, "")).toBeNull();
  });
});
