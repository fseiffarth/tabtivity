import { describe, it, expect } from "vitest";
import {
  parseDelimited,
  parseTable,
  sortRows,
  sortRefs,
  sortRefsByIndex,
  bodyRefs,
  filterRefs,
  delimiterForPath,
  sniffDelimiter,
  resolveDelimiter,
  encodeCell,
  replaceCell,
  insertRowAfter,
  deleteRow,
  columnWidths,
  cellTone,
  cellToneColor,
  cellDisplayText,
} from "../../lib/viewers/table";

describe("parseDelimited — basics", () => {
  it("parses a simple comma-separated grid", () => {
    expect(parseDelimited("a,b,c\n1,2,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("parses tab-separated values", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns no rows for empty input", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });

  it("preserves empty fields", () => {
    expect(parseDelimited("a,,c", ",")).toEqual([["a", "", "c"]]);
  });
});

describe("parseDelimited — RFC 4180 quoting", () => {
  it("keeps a delimiter embedded inside a quoted field", () => {
    expect(parseDelimited('"a,b",c', ",")).toEqual([["a,b", "c"]]);
  });

  it("keeps a newline embedded inside a quoted field", () => {
    expect(parseDelimited('"line1\nline2",x', ",")).toEqual([["line1\nline2", "x"]]);
  });

  it("keeps a CRLF embedded inside a quoted field", () => {
    expect(parseDelimited('"line1\r\nline2",x', ",")).toEqual([["line1\r\nline2", "x"]]);
  });

  it("treats \"\" as a single literal quote", () => {
    expect(parseDelimited('"she said ""hi""",end', ",")).toEqual([
      ['she said "hi"', "end"],
    ]);
  });

  it("handles a fully-quoted row with quoted empty field", () => {
    expect(parseDelimited('"a","","c"', ",")).toEqual([["a", "", "c"]]);
  });
});

describe("parseDelimited — line endings, BOM, trailing newline", () => {
  it("handles CRLF line endings", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles bare LF line endings", () => {
    expect(parseDelimited("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseDelimited("﻿a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("ignores a single trailing newline (no trailing empty row)", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a blank row created by a double trailing newline", () => {
    expect(parseDelimited("a,b\n1,2\n\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      [""],
    ]);
  });
});

describe("parseDelimited — ragged rows", () => {
  it("preserves rows of differing widths", () => {
    expect(parseDelimited("a,b,c\n1,2\n9,8,7,6", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2"],
      ["9", "8", "7", "6"],
    ]);
  });
});

describe("delimiterForPath", () => {
  it("picks tab for .tsv and comma otherwise", () => {
    expect(delimiterForPath("/x/data.tsv")).toBe("\t");
    expect(delimiterForPath("/x/data.TSV")).toBe("\t");
    expect(delimiterForPath("/x/data.csv")).toBe(",");
    expect(delimiterForPath("/x/data.txt")).toBe(",");
  });
});

describe("sortRows", () => {
  const rows = [
    ["10", "banana"],
    ["2", "apple"],
    ["1", "cherry"],
  ];

  it("sorts numerically when every cell is a finite number (asc)", () => {
    expect(sortRows(rows, 0, "asc").map((r) => r[0])).toEqual(["1", "2", "10"]);
  });

  it("sorts numerically descending", () => {
    expect(sortRows(rows, 0, "desc").map((r) => r[0])).toEqual(["10", "2", "1"]);
  });

  it("falls back to localeCompare for non-numeric columns (asc)", () => {
    expect(sortRows(rows, 1, "asc").map((r) => r[1])).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("sorts lexically descending", () => {
    expect(sortRows(rows, 1, "desc").map((r) => r[1])).toEqual([
      "cherry",
      "banana",
      "apple",
    ]);
  });

  it("treats a column with a blank cell as non-numeric (lexical)", () => {
    const mixed = [["3"], ["1"], [""]];
    // "" is non-numeric, so the whole column sorts lexically: "" < "1" < "3".
    expect(sortRows(mixed, 0, "asc").map((r) => r[0])).toEqual(["", "1", "3"]);
  });

  it("does not mutate the input array or its rows", () => {
    const input = [["3"], ["1"], ["2"]];
    const snapshot = JSON.stringify(input);
    const out = sortRows(input, 0, "asc");
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
  });

  it("treats missing cells in ragged rows as empty strings", () => {
    const ragged = [["b", "2"], ["a"], ["c", "1"]];
    // Column 1 has a missing cell (non-numeric due to ""), sorts lexically.
    expect(sortRows(ragged, 1, "asc").map((r) => r[1] ?? "")).toEqual(["", "1", "2"]);
  });

  it("is stable for equal keys", () => {
    const dup = [
      ["1", "first"],
      ["1", "second"],
      ["1", "third"],
    ];
    expect(sortRows(dup, 0, "asc").map((r) => r[1])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("sniffDelimiter", () => {
  it("finds the semicolon in a European-style CSV", () => {
    expect(sniffDelimiter("name;age;city\nada;36;london\nalan;41;wilmslow")).toBe(";");
  });

  it("finds the pipe in a pipe-delimited dump", () => {
    expect(sniffDelimiter("a|b|c\n1|2|3\n4|5|6")).toBe("|");
  });

  it("finds the tab in a TSV", () => {
    expect(sniffDelimiter("a\tb\n1\t2\n3\t4")).toBe("\t");
  });

  it("still finds the comma in an ordinary CSV", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("is not fooled by a comma inside a quoted semicolon-delimited field", () => {
    const text = 'name;note\nada;"london, england"\nalan;"wilmslow, cheshire"';
    expect(sniffDelimiter(text)).toBe(";");
  });

  it("prefers the delimiter that yields consistent row widths", () => {
    // Commas appear, but only inside the prose of one column; the ; is the grid.
    const text = "id;title\n1;a, b, c\n2;d, e\n3;f";
    expect(sniffDelimiter(text)).toBe(";");
  });

  it("falls back when nothing splits the file (a single column)", () => {
    expect(sniffDelimiter("alpha\nbeta\ngamma", ",")).toBe(",");
    expect(sniffDelimiter("alpha\nbeta\ngamma", "\t")).toBe("\t");
  });

  it("falls back on an empty file", () => {
    expect(sniffDelimiter("", ";")).toBe(";");
  });
});

describe("resolveDelimiter", () => {
  it("prefers the sniffed separator over the extension's guess", () => {
    // A .csv that is really semicolon-delimited — the case that rendered as one column.
    expect(resolveDelimiter("/x/data.csv", "a;b\n1;2")).toBe(";");
  });

  it("falls back to the extension when the content is inconclusive", () => {
    expect(resolveDelimiter("/x/data.tsv", "onlyonecolumn\nvalue")).toBe("\t");
    expect(resolveDelimiter("/x/data.csv", "onlyonecolumn\nvalue")).toBe(",");
  });
});

describe("parseTable — spans", () => {
  it("spans address each field's raw source text", () => {
    const text = "a,b\n1,2";
    const t = parseTable(text, ",");
    const raw = (r: number, c: number) =>
      text.slice(t.cells[r][c].start, t.cells[r][c].end);
    expect(raw(0, 0)).toBe("a");
    expect(raw(0, 1)).toBe("b");
    expect(raw(1, 0)).toBe("1");
    expect(raw(1, 1)).toBe("2");
  });

  it("a quoted field's span includes its quotes", () => {
    const text = 'x,"a,b"';
    const t = parseTable(text, ",");
    expect(text.slice(t.cells[0][1].start, t.cells[0][1].end)).toBe('"a,b"');
    expect(t.rows[0][1]).toBe("a,b");
  });

  it("keeps offsets absolute across a BOM, so a span splices back correctly", () => {
    const text = "﻿a,b";
    const t = parseTable(text, ",");
    expect(text.slice(t.cells[0][0].start, t.cells[0][0].end)).toBe("a");
    expect(t.rows[0]).toEqual(["a", "b"]);
  });

  it("row spans exclude the terminator but `next` steps over it", () => {
    const text = "a,b\r\n1,2\n";
    const t = parseTable(text, ",");
    expect(text.slice(t.rowSpans[0].start, t.rowSpans[0].end)).toBe("a,b");
    expect(t.rowSpans[0].next).toBe(5); // past the CRLF
    expect(text.slice(t.rowSpans[1].start, t.rowSpans[1].end)).toBe("1,2");
  });

  it("marks an unterminated final row by `next === end`", () => {
    const t = parseTable("a,b\n1,2", ",");
    expect(t.rowSpans[0].next).toBeGreaterThan(t.rowSpans[0].end); // terminated
    expect(t.rowSpans[1].next).toBe(t.rowSpans[1].end); // ends with the file
  });

  it("reports the file's dominant newline", () => {
    expect(parseTable("a\r\nb", ",").newline).toBe("\r\n");
    expect(parseTable("a\nb", ",").newline).toBe("\n");
  });
});

describe("encodeCell", () => {
  it("leaves an unambiguous value bare", () => {
    expect(encodeCell("plain", ",")).toBe("plain");
  });

  it("quotes a value containing the delimiter", () => {
    expect(encodeCell("a,b", ",")).toBe('"a,b"');
    expect(encodeCell("a,b", ";")).toBe("a,b"); // not the delimiter here
    expect(encodeCell("a;b", ";")).toBe('"a;b"');
  });

  it("doubles embedded quotes", () => {
    expect(encodeCell('say "hi"', ",")).toBe('"say ""hi"""');
  });

  it("quotes newlines and edge whitespace, which a reader could otherwise trim", () => {
    expect(encodeCell("a\nb", ",")).toBe('"a\nb"');
    expect(encodeCell(" pad ", ",")).toBe('" pad "');
  });
});

describe("replaceCell", () => {
  const edit = (text: string, r: number, c: number, v: string, d = ",") =>
    replaceCell(text, parseTable(text, d), r, c, v, d);

  it("rewrites only the target field's bytes", () => {
    expect(edit("a,b\n1,2", 1, 0, "9")).toBe("a,b\n9,2");
  });

  it("leaves every other cell's quoting style untouched", () => {
    // "b" is quoted although it needn't be; editing `a` must not re-serialise it.
    expect(edit('a,"b"\n1,2', 0, 0, "z")).toBe('z,"b"\n1,2');
  });

  it("quotes the new value only when it needs it", () => {
    expect(edit("a,b\n1,2", 1, 1, "x,y")).toBe('a,b\n1,"x,y"');
  });

  it("preserves CRLF line endings around the edit", () => {
    expect(edit("a,b\r\n1,2\r\n", 1, 1, "9")).toBe("a,b\r\n1,9\r\n");
  });

  it("edits through a non-comma delimiter", () => {
    expect(edit("a;b\n1;2", 1, 1, "9", ";")).toBe("a;b\n1;9");
  });

  it("pads a ragged row out to the column being typed into", () => {
    // Row 1 has one field; the viewer shows it padded to 3 columns, so writing
    // into the third must land in the third — not append to the first.
    expect(edit("a,b,c\nx", 1, 2, "z")).toBe("a,b,c\nx,,z");
  });

  it("is a no-op for a row that does not exist", () => {
    expect(edit("a,b", 9, 0, "z")).toBe("a,b");
  });
});

describe("insertRowAfter / deleteRow", () => {
  it("inserts a blank row after a terminated row", () => {
    const text = "a,b\n1,2\n";
    expect(insertRowAfter(text, parseTable(text, ","), 0, 2, ",")).toBe("a,b\n,\n1,2\n");
  });

  it("appends after an unterminated final row without adding a trailing blank", () => {
    const text = "a,b\n1,2";
    const out = insertRowAfter(text, parseTable(text, ","), 1, 2, ",");
    expect(out).toBe("a,b\n1,2\n,");
    // The appended row is real, and no phantom row follows it.
    expect(parseDelimited(out, ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["", ""],
    ]);
  });

  it("uses the file's own newline", () => {
    const text = "a,b\r\n1,2\r\n";
    expect(insertRowAfter(text, parseTable(text, ","), 1, 2, ",")).toBe(
      "a,b\r\n1,2\r\n,\r\n",
    );
  });

  it("deletes a row with its terminator", () => {
    const text = "a,b\n1,2\n3,4\n";
    expect(deleteRow(text, parseTable(text, ","), 1)).toBe("a,b\n3,4\n");
  });

  it("deleting an unterminated final row takes the preceding newline instead", () => {
    const text = "a,b\n1,2";
    const out = deleteRow(text, parseTable(text, ","), 1);
    expect(out).toBe("a,b");
    expect(parseDelimited(out, ",")).toEqual([["a", "b"]]);
  });
});

describe("filterRefs", () => {
  const refs = bodyRefs([
    ["name", "city"],
    ["ada", "London"],
    ["alan", "Wilmslow"],
  ]);

  it("keeps each row's source index, so an edit still lands on the right row", () => {
    expect(refs.map((r) => r.index)).toEqual([1, 2]);
    expect(filterRefs(refs, "alan")[0].index).toBe(2);
  });

  it("matches any cell, case-insensitively", () => {
    expect(filterRefs(refs, "london").map((r) => r.cells[0])).toEqual(["ada"]);
  });

  it("a blank query matches everything", () => {
    expect(filterRefs(refs, "   ")).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterRefs(refs, "zzz")).toEqual([]);
  });

  it("searches only the given columns, so a hidden one cannot match", () => {
    // Column 1 (city) is hidden: "london" must no longer pull ada's row in, or the
    // row would appear with nothing visible on it explaining the match.
    expect(filterRefs(refs, "london", [0])).toEqual([]);
    expect(filterRefs(refs, "ada", [0]).map((r) => r.index)).toEqual([1]);
  });

  it("still matches on a visible column when others are hidden", () => {
    expect(filterRefs(refs, "wilmslow", [1]).map((r) => r.index)).toEqual([2]);
  });
});

describe("sortRefs", () => {
  it("carries the source index through the sort", () => {
    const refs = bodyRefs([
      ["n"],
      ["10"],
      ["2"],
    ]);
    expect(sortRefs(refs, 0, "asc").map((r) => r.index)).toEqual([2, 1]);
  });
});

describe("sortRefsByIndex", () => {
  it("asc restores the file's row order after a column sort reordered it", () => {
    const refs = bodyRefs([["n"], ["10"], ["2"], ["7"]]);
    const byValue = sortRefs(refs, 0, "asc"); // 2, 7, 10 → indices [2, 3, 1]
    expect(byValue.map((r) => r.index)).toEqual([2, 3, 1]);
    expect(sortRefsByIndex(byValue, "asc").map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("desc reverses the file's row order", () => {
    const refs = bodyRefs([["n"], ["a"], ["b"], ["c"]]);
    expect(sortRefsByIndex(refs, "desc").map((r) => r.index)).toEqual([3, 2, 1]);
  });

  it("does not mutate its input", () => {
    const refs = bodyRefs([["n"], ["a"], ["b"]]);
    sortRefsByIndex(refs, "desc");
    expect(refs.map((r) => r.index)).toEqual([1, 2]);
  });
});

describe("columnWidths", () => {
  it("sizes each column to its widest cell, header included", () => {
    expect(columnWidths([["id", "description"], ["1", "short"]], 2)).toEqual([4, 11]);
  });

  it("clamps a very wide column so one essay cell can't run the table off screen", () => {
    expect(columnWidths([["x"], ["y".repeat(500)]], 1)).toEqual([48]);
  });
});

describe("cellTone", () => {
  it("classifies a cell by its text", () => {
    expect(cellTone(" 42 ")).toBe("num");
    expect(cellTone("-1.5e3")).toBe("num");
    expect(cellTone("TRUE")).toBe("bool");
    expect(cellTone("n/a")).toBe("null");
    expect(cellTone("NULL")).toBe("null");
    expect(cellTone("2024-05-01")).toBe("date");
    expect(cellTone("2024-05-01T12:30:00Z")).toBe("date");
    expect(cellTone("https://example.org/x")).toBe("url");
  });

  it("leaves blanks and prose plain", () => {
    expect(cellTone("")).toBeNull();
    expect(cellTone("   ")).toBeNull();
    expect(cellTone("Ada Lovelace")).toBeNull();
    expect(cellTone("Infinity")).toBeNull();
    expect(cellToneColor("Ada")).toBeUndefined();
  });

  it("falls back to the cell's own colour where a theme has no document hues", () => {
    expect(cellToneColor("7")).toBe("var(--doc-yellow, currentColor)");
  });
});

describe("cellDisplayText", () => {
  it("keeps a quoted field's line breaks on one screen line", () => {
    expect(cellDisplayText("a\nb\r\nc\rd")).toBe("a↵b↵c↵d");
    expect(cellDisplayText("  padded  ")).toBe("  padded  ");
  });
});
