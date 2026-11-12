import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { DiffHunkLines, DiffLineRow, MarkedText } from "../../components/embed/DiffView";
import { parseUnifiedDiff } from "../../lib/viewers/diff";

describe("DiffLineRow word marks", () => {
  it("tints add/del rows by class, not by inline colour", () => {
    const { container } = render(
      <>
        <DiffLineRow line={{ type: "add", text: "a", oldNo: null, newNo: 1 }} />
        <DiffLineRow line={{ type: "del", text: "b", oldNo: 1, newNo: null }} />
        <DiffLineRow line={{ type: "context", text: "c", oldNo: 2, newNo: 2 }} />
      </>,
    );
    const rows = container.querySelectorAll(".diff-line");
    expect(rows[0].classList.contains("is-add")).toBe(true);
    expect(rows[1].classList.contains("is-del")).toBe(true);
    expect(rows[2].classList.contains("is-add") || rows[2].classList.contains("is-del")).toBe(false);
    for (const row of rows) expect((row as HTMLElement).style.background).toBe("");
  });

  it("wraps the marked stretch in .diff-word and keeps the marker and text intact", () => {
    const { container } = render(
      <DiffLineRow line={{ type: "add", text: "let x = 10;", oldNo: null, newNo: 4 }} marks={[{ start: 8, end: 10 }]} />,
    );
    expect(container.querySelector(".diff-text")?.textContent).toBe("+let x = 10;");
    const words = container.querySelectorAll(".diff-word");
    expect(words).toHaveLength(1);
    expect(words[0].textContent).toBe("10");
  });

  it("renders marked text as text, never as markup", () => {
    const { container } = render(<MarkedText text="<b>x</b>" marks={[{ start: 0, end: 3 }]} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("<b>x</b>");
    expect(container.querySelector(".diff-word")?.textContent).toBe("<b>");
  });

  it("DiffHunkLines marks a paired del/add and leaves context alone", () => {
    const [file] = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n keep\n-total = price * 2\n+total = cost * 2\n end\n");
    const { container } = render(<DiffHunkLines lines={file.hunks[0].lines} />);
    const words = [...container.querySelectorAll(".diff-word")].map((w) => w.textContent);
    expect(words).toEqual(["price", "cost"]);
    expect(container.querySelectorAll('.diff-line[data-type="context"] .diff-word')).toHaveLength(0);
  });
});
