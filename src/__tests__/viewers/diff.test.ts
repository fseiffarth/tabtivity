import { describe, it, expect } from "vitest";
import { diffFilePath, parseUnifiedDiff, unquotePath, wholeFileHunk } from "../../lib/viewers/diff";

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

describe("parseUnifiedDiff · git extended headers", () => {
  it("reads a rename with a similarity index and edits", () => {
    const diff = [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 88%",
      "rename from old name.txt",
      "rename to new name.txt",
      "index 111..222 100644",
      "--- a/old name.txt",
      "+++ b/new name.txt",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({
      status: "renamed",
      oldPath: "old name.txt",
      newPath: "new name.txt",
      similarity: 88,
      binary: false,
    });
    expect(file.hunks).toHaveLength(1);
    expect(diffFilePath(file)).toBe("new name.txt");
  });

  it("reads a pure rename that has no hunks or ---/+++ lines", () => {
    const diff = [
      "diff --git a/src/a.ts b/lib/a.ts",
      "similarity index 100%",
      "rename from src/a.ts",
      "rename to lib/a.ts",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ status: "renamed", oldPath: "src/a.ts", newPath: "lib/a.ts", similarity: 100 });
    expect(files[0].hunks).toEqual([]);
  });

  it("reads a copy", () => {
    const diff = ["diff --git a/x b/y", "similarity index 90%", "copy from x", "copy to y", ""].join("\n");
    expect(parseUnifiedDiff(diff)[0]).toMatchObject({ status: "copied", oldPath: "x", newPath: "y" });
  });

  it("flags a new file and a deleted file, even without ---/+++ lines", () => {
    const diff = [
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100755",
      "index e69de29..0000000",
      "",
    ].join("\n");
    const [added, deleted] = parseUnifiedDiff(diff);
    expect(added).toMatchObject({ status: "added", oldPath: "/dev/null", newPath: "empty.txt", newMode: "100644" });
    expect(deleted).toMatchObject({ status: "deleted", oldPath: "gone.txt", newPath: "/dev/null", oldMode: "100755" });
    expect(diffFilePath(deleted)).toBe("gone.txt");
  });

  it("derives added/deleted from /dev/null in a plain diff", () => {
    const [added] = parseUnifiedDiff(["--- /dev/null", "+++ b/n", "@@ -0,0 +1 @@", "+x"].join("\n"));
    const [deleted] = parseUnifiedDiff(["--- a/n", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n"));
    expect(added.status).toBe("added");
    expect(deleted.status).toBe("deleted");
  });

  it("reads a mode change", () => {
    const diff = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({
      status: "modified",
      oldMode: "100644",
      newMode: "100755",
      oldPath: "run.sh",
      newPath: "run.sh",
    });
    expect(file.hunks).toEqual([]);
  });

  it("marks `Binary files … differ` as binary with no hunks", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 111..222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ binary: true, oldPath: "logo.png", newPath: "logo.png", status: "modified" });
    expect(files[0].hunks).toEqual([]);
    expect(files[1].binary).toBe(false);
    expect(files[1].hunks).toHaveLength(1);
  });

  it("marks a new binary file as added", () => {
    const diff = [
      "diff --git a/x.bin b/x.bin",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/x.bin differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]).toMatchObject({ binary: true, status: "added", newPath: "x.bin" });
  });

  it("marks a GIT binary patch as binary and skips its payload", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "index 111..222 100644",
      "GIT binary patch",
      "literal 12",
      "Tcmd+-- not a path header",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.binary)).toEqual([true, false]);
    expect(files[0].hunks).toEqual([]);
    expect(files[1].hunks[0].lines.filter((l) => l.type === "add")).toHaveLength(1);
  });

  it("starts a new file for a bare `Binary files` line after a plain diff", () => {
    const diff = [
      "--- a/t.txt",
      "+++ b/t.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "Binary files a/pic.png and b/pic.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[1]).toMatchObject({ binary: true, newPath: "pic.png" });
  });

  it("gives wholeFileHunk nothing for a binary file", () => {
    const [file] = parseUnifiedDiff("diff --git a/p b/p\nBinary files a/p and b/p differ\n");
    expect(wholeFileHunk(file, "text")).toBeNull();
  });
});

describe("parseUnifiedDiff · paths", () => {
  it("handles unquoted paths with spaces in a git header and ---/+++ lines", () => {
    const diff = [
      "diff --git a/my docs/read me.md b/my docs/read me.md",
      "--- a/my docs/read me.md\t",
      "+++ b/my docs/read me.md\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file.oldPath).toBe("my docs/read me.md");
    expect(file.newPath).toBe("my docs/read me.md");
  });

  it("takes the paths of an edit-less change from a header whose names contain spaces", () => {
    const [file] = parseUnifiedDiff("diff --git a/a b/c.txt b/a b/c.txt\nold mode 100644\nnew mode 100755\n");
    expect(file.newPath).toBe("a b/c.txt");
    expect(file.oldPath).toBe("a b/c.txt");
  });

  it("unquotes C-style quoted paths (spaces, octal UTF-8, escapes)", () => {
    expect(unquotePath('"a/caf\\303\\251 x.txt"')).toBe("a/café x.txt");
    expect(unquotePath('"tab\\there \\"q\\" back\\\\slash"')).toBe('tab\there "q" back\\slash');
    expect(unquotePath("plain")).toBe("plain");
    expect(unquotePath('"\\360\\237\\230\\200"')).toBe("\u{1F600}");
  });

  it("reads quoted paths in headers and path lines", () => {
    const diff = [
      'diff --git "a/sp ace/caf\\303\\251.txt" "b/sp ace/caf\\303\\251.txt"',
      '--- "a/sp ace/caf\\303\\251.txt"',
      '+++ "b/sp ace/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file.oldPath).toBe("sp ace/café.txt");
    expect(file.newPath).toBe("sp ace/café.txt");
  });

  it("reads a quoted rename", () => {
    const diff = [
      'diff --git "a/o ld.txt" "b/n ew.txt"',
      "similarity index 100%",
      'rename from "o ld.txt"',
      'rename to "n ew.txt"',
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]).toMatchObject({ oldPath: "o ld.txt", newPath: "n ew.txt", status: "renamed" });
  });
});

describe("parseUnifiedDiff · body details", () => {
  it("strips CRLF from every line and records it", () => {
    const diff = ["--- a/w", "+++ b/w", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\r\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file.crlf).toBe(true);
    expect(file.oldPath).toBe("w");
    const texts = file.hunks[0].lines.filter((l) => l.type !== "hunk").map((l) => l.text);
    expect(texts).toEqual(["keep", "old", "new"]);
  });

  it("leaves crlf false for LF input", () => {
    expect(parseUnifiedDiff("--- a/w\n+++ b/w\n@@ -1 +1 @@\n-a\n+b\n")[0].crlf).toBe(false);
  });

  it("does not turn the newline after the last line into a context line", () => {
    const lines = parseUnifiedDiff("--- a/w\n+++ b/w\n@@ -1 +1 @@\n-a\n+b\n")[0].hunks[0].lines;
    expect(lines.map((l) => l.type)).toEqual(["hunk", "del", "add"]);
  });

  it("keeps `\\ No newline` markers unnumbered and in place", () => {
    const diff = [
      "--- a/n",
      "+++ b/n",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(diff)[0].hunks[0].lines;
    expect(lines.map((l) => l.type)).toEqual(["hunk", "context", "del", "nonewline", "add", "nonewline"]);
    expect(lines[2]).toMatchObject({ oldNo: 2, newNo: null });
    expect(lines[4]).toMatchObject({ oldNo: null, newNo: 2 });
  });

  it("reads a deleted `-- x` line as a line, not a file header", () => {
    const diff = ["--- a/s.sql", "+++ b/s.sql", "@@ -1,3 +1,3 @@", " keep", "--- comment", "+++ added", " end", ""].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const lines = files[0].hunks[0].lines;
    expect(lines.map((l) => l.type)).toEqual(["hunk", "context", "del", "add", "context"]);
    expect(lines[2].text).toBe("-- comment");
    expect(lines[3].text).toBe("++ added");
    expect(files[0].oldPath).toBe("s.sql");
  });

  it("starts a new file at a ---/+++/@@ triple even when the hunk's counts overshoot", () => {
    const diff = [
      "--- a/one",
      "+++ b/one",
      "@@ -1,9 +1,9 @@",
      "-a",
      "+b",
      "--- a/two",
      "+++ b/two",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff).map((f) => f.newPath)).toEqual(["one", "two"]);
  });

  it("splits a headerless multi-file diff at the second ---", () => {
    const diff = ["--- a/one", "+++ b/one", "@@ -1 +1 @@", "-a", "+b", "--- a/two", "+++ b/two", "@@ -1 +1 @@", "-c", "+d"].join("\n");
    expect(parseUnifiedDiff(diff).map((f) => f.newPath)).toEqual(["one", "two"]);
  });
});

describe("parseUnifiedDiff · combined diffs", () => {
  it("numbers a merge's `diff --cc` hunk and drops the extra marker column", () => {
    const diff = [
      "diff --cc merged.txt",
      "index 111,222..333",
      "--- a/merged.txt",
      "+++ b/merged.txt",
      "@@@ -1,4 -1,4 +1,5 @@@",
      "  same",
      "- only first",
      " -only second",
      "++both added",
      " +from second",
      "  tail",
      "",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file.combined).toBe(true);
    expect(file.newPath).toBe("merged.txt");
    const rows = file.hunks[0].lines.slice(1);
    expect(rows.map((l) => `${l.type}:${l.oldNo ?? "-"}:${l.newNo ?? "-"}:${l.text}`)).toEqual([
      "context:1:1:same",
      "del:2:-:only first",
      "del:-:-:only second",
      "add:-:2:both added",
      "add:3:3:from second",
      "context:4:4:tail",
    ]);
  });

  it("does not mistake `@@@` for a plain hunk", () => {
    const [file] = parseUnifiedDiff(["diff --cc f", "@@@ -5,1 -5,1 +5,1 @@@", "  x", ""].join("\n"));
    expect(file.hunks[0].lines[1]).toMatchObject({ type: "context", text: "x", oldNo: 5, newNo: 5 });
  });
});
