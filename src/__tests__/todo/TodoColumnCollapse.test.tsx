/**
 * A board column folds to a strip and back, the fold survives in localStorage,
 * and the "Hide done" switch sits in the done column's head only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

import { TodoColumn } from "../../components/todo/TodoColumn";
import { useTodoStore } from "../../stores/todo";
import type { TaskColumn } from "../../types";
import { storageKey } from "../../lib/brand";

const TODO: TaskColumn = { id: "todo", name: "To do", position: 0, done: false };
const DONE: TaskColumn = { id: "done", name: "Done", position: 1, done: true };

function mount(column: TaskColumn) {
  return render(
    <TodoColumn
      column={column}
      columns={[TODO, DONE]}
      title={column.name}
      cards={[]}
      cardCount={3}
      placeholderIndex={null}
      placeholderHeight={0}
      dropTarget={false}
      draggingId={null}
      onCardPointerDown={vi.fn()}
      onEditCard={vi.fn()}
      onOpenMail={vi.fn()}
      onAddCard={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onMove={vi.fn()}
      canMoveLeft
      canMoveRight
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  useTodoStore.setState({ collapsedColumns: {}, hideDone: false });
});
afterEach(cleanup);

describe("TodoColumn collapse", () => {
  it("folds to a strip with the name and count, and unfolds again", () => {
    const r = mount(TODO);
    fireEvent.click(r.getByLabelText("Collapse column"));

    expect(useTodoStore.getState().collapsedColumns).toEqual({ todo: true });
    expect(JSON.parse(localStorage.getItem(storageKey("todo.collapsedColumns"))!)).toEqual(["todo"]);
    const strip = r.getByLabelText("Expand column");
    expect(strip.textContent).toContain("To do");
    expect(strip.textContent).toContain("3");
    // Still a drop target.
    expect(r.container.querySelector('[data-column-id="todo"]')).not.toBeNull();
    expect(r.queryByText(/Add card/)).toBeNull();

    fireEvent.click(strip);
    expect(useTodoStore.getState().collapsedColumns).toEqual({});
    expect(JSON.parse(localStorage.getItem(storageKey("todo.collapsedColumns"))!)).toEqual([]);
    expect(r.getByLabelText("Collapse column")).toBeTruthy();
  });
});

describe("Hide done toggle", () => {
  it("sits in the done column and drives the store", () => {
    const r = mount(DONE);
    const box = r.getByLabelText("Hide done") as HTMLInputElement;
    fireEvent.click(box);
    expect(useTodoStore.getState().hideDone).toBe(true);
  });

  it("is absent from other columns", () => {
    const r = mount(TODO);
    expect(r.queryByLabelText("Hide done")).toBeNull();
  });
});
