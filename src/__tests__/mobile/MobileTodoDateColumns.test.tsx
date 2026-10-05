import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../../mobile-web/src/api";
import { Todo } from "../../../mobile-web/src/screens/Todo";
import { COLUMN_FOLLOWS_DATE, localDate, moveAccepted } from "../../../mobile-web/src/todoDates";
import type { TodoCard, TodoColumn } from "../../../mobile-web/src/api";
import { storageKey } from "../../lib/brand";
import { translate } from "../../lib/i18n";

vi.mock("../../../mobile-web/src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mobile-web/src/api")>();
  return { ...actual, api: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  localStorage.clear();
});

const COLUMNS: TodoColumn[] = [
  { id: "overdue", name: "Overdue", position: 0, done: false, archived: false, intake: false, overdue: true, due_today: false },
  { id: "today", name: "Today", position: 1, done: false, archived: false, intake: false, overdue: false, due_today: true },
  { id: "doing", name: "Doing", position: 2, done: false, archived: false, intake: false, overdue: false, due_today: false },
  { id: "backlog", name: "Backlog", position: 3, done: false, archived: false, intake: true, overdue: false, due_today: false },
  { id: "done", name: "Done", position: 4, done: true, archived: false, intake: false, overdue: false, due_today: false },
  { id: "shelf", name: "Archived", position: 5, done: false, archived: true, intake: false, overdue: false, due_today: false },
];

function card(over: Partial<TodoCard> = {}): TodoCard {
  return {
    id: "card", title: "Card", notes: "", column: "backlog", done: false,
    priority: 0, percent: 0, calendar_id: "calendar", tags: [], subtasks: [], ...over,
  };
}

const TODAY = localDate();
const YESTERDAY = localDate(new Date(Date.now() - 86_400_000));
const TOMORROW = localDate(new Date(Date.now() + 86_400_000));

describe("mobile board date-governed columns", () => {
  it("keeps a late card in Overdue and refuses the other two", () => {
    const late = card({ due: YESTERDAY, column: "overdue" });
    expect(moveAccepted(late, "overdue", COLUMNS, TODAY)).toBe(true);
    expect(moveAccepted(late, "today", COLUMNS, TODAY)).toBe(false);
    expect(moveAccepted(late, "backlog", COLUMNS, TODAY)).toBe(false);
    // A column no deadline governs is still a decision the reader gets to make.
    expect(moveAccepted(late, "doing", COLUMNS, TODAY)).toBe(true);
    expect(moveAccepted(late, "shelf", COLUMNS, TODAY)).toBe(true);
  });

  it("keeps a card due today in Today", () => {
    const due = card({ due: TODAY, column: "today" });
    expect(moveAccepted(due, "today", COLUMNS, TODAY)).toBe(true);
    expect(moveAccepted(due, "overdue", COLUMNS, TODAY)).toBe(false);
    expect(moveAccepted(due, "backlog", COLUMNS, TODAY)).toBe(false);
  });

  it("lets a future card sit in Today but never in Overdue", () => {
    const later = card({ due: TOMORROW });
    expect(moveAccepted(later, "today", COLUMNS, TODAY)).toBe(true);
    expect(moveAccepted(later, "backlog", COLUMNS, TODAY)).toBe(true);
    expect(moveAccepted(later, "overdue", COLUMNS, TODAY)).toBe(false);
  });

  it("treats Done as completion, not as a place", () => {
    expect(moveAccepted(card(), "done", COLUMNS, TODAY)).toBe(false);
    const finished = card({ done: true, percent: 100, column: "done" });
    expect(moveAccepted(finished, "done", COLUMNS, TODAY)).toBe(true);
    expect(moveAccepted(finished, "backlog", COLUMNS, TODAY)).toBe(false);
    // …except an archive, which is where a finished card goes to be left alone.
    expect(moveAccepted(finished, "shelf", COLUMNS, TODAY)).toBe(true);
  });

  it("greys out the moves the desktop would refuse", async () => {
    vi.mocked(api).mockResolvedValue({
      board: { columns: COLUMNS, tasks: [card({ due: YESTERDAY, column: "overdue", title: "Late" })], calendars: [{ id: "calendar", name: "Personal" }], projects: [] },
    });

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Late")).toBeTruthy());
    const options = [...(screen.getByLabelText("Move Late") as HTMLSelectElement).options];
    expect(options.filter((option) => !option.disabled).map((option) => option.value))
      .toEqual(["overdue", "doing", "shelf"]);
  });
});

describe("mobile board checkbox", () => {
  it("ticks a card as completion rather than as a move into Done", async () => {
    const board = { columns: COLUMNS, tasks: [card({ title: "Write it up", column: "doing" })], calendars: [{ id: "calendar", name: "Personal" }], projects: [] };
    vi.mocked(api).mockResolvedValue({ board });

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Mark Write it up done"));

    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(1));
    const [path, init] = vi.mocked(api).mock.calls[1];
    expect(path).toBe("/api/v1/todo");
    expect(JSON.parse(String(init?.body))).toEqual({ type: "toggle", task_id: "card" });
  });

  it("unticks a done card the same way", async () => {
    const board = { columns: COLUMNS, tasks: [card({ title: "Shipped", column: "done", done: true, percent: 100 })], calendars: [{ id: "calendar", name: "Personal" }], projects: [] };
    vi.mocked(api).mockResolvedValue({ board });
    localStorage.setItem(storageKey("mobile.todoHideDone"), "0");

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Shipped")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Mark Shipped not done"));

    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(1));
    expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body))).toEqual({ type: "toggle", task_id: "card" });
  });
});

describe("mobile board refusals", () => {
  it("says what the deadline rule is instead of showing its wire code", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ board: { columns: COLUMNS, tasks: [card({ due: TOMORROW, column: "backlog", title: "Later" })], calendars: [{ id: "calendar", name: "Personal" }], projects: [] } })
      .mockRejectedValueOnce(new ApiError(400, "column_follows_date"));

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Later")).toBeTruthy());
    // The select refuses it, so drive the refusal the way an older desktop or a
    // deadline that moved under the reader would produce it.
    fireEvent.change(screen.getByLabelText("Move Later"), { target: { value: "doing" } });

    await waitFor(() => expect(screen.getByText(translate("en", COLUMN_FOLLOWS_DATE))).toBeTruthy());
  });
});
