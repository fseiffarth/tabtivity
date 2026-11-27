/**
 * The wide file list's hand-set column widths (useFileTreeColumns): a grip
 * drag sets the column's width as a CSS custom property on the list root,
 * persists it for every list, and a double-click gives the default back.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import {
  FILE_TREE_COLUMN_WIDTHS_KEY,
  MAX_COLUMN_PX,
  MIN_COLUMN_PX,
  columnWidthStyle,
  parseColumnWidths,
  reloadFileTreeColumnWidthsForTests,
  useFileTreeColumns,
} from "../../components/files/useFileTreeColumns";

function Harness() {
  const { style, onGripPointerDown, resetColumn } = useFileTreeColumns();
  return (
    <div data-testid="root" style={style}>
      <div className="file-cols">
        <span
          data-testid="grip"
          onPointerDown={(e) => onGripPointerDown("git", e)}
          onDoubleClick={() => resetColumn("git")}
        />
      </div>
    </div>
  );
}

function pointer(el: Element, type: string, clientX: number) {
  // jsdom has no PointerEvent; the hook reads only button / clientX.
  const ev = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  act(() => { el.dispatchEvent(ev); });
}

describe("file tree column widths", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadFileTreeColumnWidthsForTests();
  });

  it("parses only known columns and clamps them", () => {
    expect(parseColumnWidths(null)).toEqual({});
    expect(parseColumnWidths("not json")).toEqual({});
    expect(parseColumnWidths(JSON.stringify({ name: 300, git: 1, mod: 99999, size: "x", share: 50 })))
      .toEqual({ name: 300, git: MIN_COLUMN_PX, mod: MAX_COLUMN_PX });
  });

  it("leaves unset columns to the stylesheet's defaults", () => {
    expect(columnWidthStyle({})).toBeUndefined();
    expect(columnWidthStyle({ name: 320, size: 90 })).toEqual({
      "--fc-name": "minmax(120px, 320px)",
      "--fc-size": "90px",
    });
  });

  it("drags a column wider, persists it, and resets it on double-click", () => {
    const { getByTestId } = render(<Harness />);
    const grip = getByTestId("grip");
    const root = getByTestId("root");

    // jsdom computes no grid tracks, so the drag starts from the default width (110).
    pointer(grip, "pointerdown", 100);
    pointer(grip, "pointermove", 160);
    expect(root.style.getPropertyValue("--fc-git")).toBe("170px");
    // Not persisted mid-drag.
    expect(localStorage.getItem(FILE_TREE_COLUMN_WIDTHS_KEY)).toBeNull();
    pointer(grip, "pointerup", 160);
    expect(JSON.parse(localStorage.getItem(FILE_TREE_COLUMN_WIDTHS_KEY) ?? "{}")).toEqual({ git: 170 });

    act(() => { grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(root.style.getPropertyValue("--fc-git")).toBe("");
    expect(localStorage.getItem(FILE_TREE_COLUMN_WIDTHS_KEY)).toBeNull();
  });

  it("follows a width another window stored", () => {
    const { getByTestId } = render(<Harness />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: FILE_TREE_COLUMN_WIDTHS_KEY,
        newValue: JSON.stringify({ mod: 200 }),
      }));
    });
    expect(getByTestId("root").style.getPropertyValue("--fc-mod")).toBe("200px");
  });
});
