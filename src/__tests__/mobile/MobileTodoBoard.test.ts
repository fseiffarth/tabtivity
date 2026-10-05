import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, normalizeTodoBoard } from "../../../mobile-web/src/api";
import { Todo } from "../../../mobile-web/src/screens/Todo";
import { storageKey } from "../../lib/brand";

vi.mock("../../../mobile-web/src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mobile-web/src/api")>();
  return { ...actual, api: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  localStorage.clear();
});

function boardWithOneDoneCard() {
  return {
    board: {
      columns: [
        { id: "today", name: "Today", position: 0, done: false },
        { id: "done", name: "Done", position: 1, done: true },
      ],
      tasks: [
        {
          id: "complete", title: "Finished", notes: "", column: "done", done: true,
          priority: 0, percent: 100, calendar_id: "calendar", tags: [], subtasks: [],
        },
      ],
      calendars: [{ id: "calendar", name: "Personal" }],
      projects: [],
    },
  };
}

function boardWithArchive() {
  return {
    board: {
      columns: [
        { id: "today", name: "Today", position: 0, done: false, archived: false },
        { id: "shelf", name: "Archived", position: 1, done: false, archived: true },
      ],
      tasks: [
        {
          id: "live", title: "In progress", notes: "", column: "today", done: false,
          priority: 0, percent: 10, calendar_id: "calendar", tags: [], subtasks: [],
        },
        {
          // Abandoned rather than finished: `done` is false, so only the archive
          // switch can hide it.
          id: "shelved", title: "Set aside", notes: "", column: "shelf", done: false,
          priority: 0, percent: 30, calendar_id: "calendar", tags: [], subtasks: [],
        },
      ],
      calendars: [{ id: "calendar", name: "Personal" }],
      projects: [],
    },
  };
}

describe("mobile todo board payloads", () => {
  it("normalizes empty collections omitted by an older desktop bridge", () => {
    const board = normalizeTodoBoard({
      columns: [],
      tasks: [{
        id: "task", title: "Untitled", column: "today", done: false,
        priority: 0, percent: 0, calendar_id: "calendar",
      }] as never,
    } as never);

    expect(board.calendars).toEqual([]);
    expect(board.projects).toEqual([]);
    expect(board.tasks[0]).toMatchObject({ notes: "", tags: [], subtasks: [] });
  });

  it("reads a column from a desktop with no archive flag as not archived", () => {
    const board = normalizeTodoBoard({
      columns: [{ id: "today", name: "Today", position: 0, done: false }],
      tasks: [], calendars: [], projects: [],
    } as never);

    expect(board.columns[0].archived).toBe(false);
  });
});

describe("mobile todo board counts", () => {
  it("keeps the Done count when its cards are hidden", async () => {
    vi.mocked(api).mockResolvedValue({
      board: {
        columns: [
          { id: "today", name: "Today", position: 0, done: false },
          { id: "done", name: "Done", position: 1, done: true },
        ],
        tasks: [
          {
            id: "complete", title: "Finished", notes: "", column: "done", done: true,
            priority: 0, percent: 100, calendar_id: "calendar", tags: [], subtasks: [],
          },
        ],
        calendars: [{ id: "calendar", name: "Personal" }],
        projects: [],
      },
    });

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Hide done"));

    expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy();
    expect(screen.queryByText("Finished")).toBeNull();
  });
});

describe("mobile todo hide-done persistence", () => {
  it("re-opens the board with the reader's own hide-done choice", async () => {
    vi.mocked(api).mockResolvedValue(boardWithOneDoneCard());

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Finished")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Hide done"));
    cleanup();

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy());
    expect((screen.getByLabelText("Hide done") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("opens with archived cards hidden and keeps the column's count", async () => {
    vi.mocked(api).mockResolvedValue(boardWithArchive());

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("In progress")).toBeTruthy());

    expect((screen.getByLabelText("Hide archived") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Set aside")).toBeNull();
    expect(screen.getByRole("heading", { name: "Archived 1" })).toBeTruthy();
  });

  it("shows the archive once the reader asks for it, and remembers that", async () => {
    vi.mocked(api).mockResolvedValue(boardWithArchive());

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("In progress")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Hide archived"));
    expect(screen.getByText("Set aside")).toBeTruthy();
    cleanup();

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Set aside")).toBeTruthy());
    expect((screen.getByLabelText("Hide archived") as HTMLInputElement).checked).toBe(false);
  });

  it("hides an archived card the done switch cannot reach", async () => {
    vi.mocked(api).mockResolvedValue(boardWithArchive());
    localStorage.setItem(storageKey("mobile.todoHideArchived"), "0");

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Set aside")).toBeTruthy());

    // The card is unfinished, so "hide done" leaves it standing …
    fireEvent.click(screen.getByLabelText("Hide done"));
    expect(screen.getByText("Set aside")).toBeTruthy();
    // … and only the archive switch takes it off the board.
    fireEvent.click(screen.getByLabelText("Hide archived"));
    expect(screen.queryByText("Set aside")).toBeNull();
    expect(screen.getByText("In progress")).toBeTruthy();
  });

  it("stops hiding done cards once the reader unticks it", async () => {
    vi.mocked(api).mockResolvedValue(boardWithOneDoneCard());
    localStorage.setItem(storageKey("mobile.todoHideDone"), "1");

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Hide done"));
    cleanup();

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Finished")).toBeTruthy());
    expect((screen.getByLabelText("Hide done") as HTMLInputElement).checked).toBe(false);
  });
});

describe("mobile todo column folding", () => {
  it("folds a column away, says what it is holding, and remembers it", async () => {
    vi.mocked(api).mockResolvedValue(boardWithOneDoneCard());

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Finished")).toBeTruthy());
    const fold = screen.getByRole("button", { name: "Done" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fold);
    expect(screen.queryByText("Finished")).toBeNull();
    // The head still counts the card, and the fold says the count is behind it.
    expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy();
    expect(screen.getByText("1 card folded away")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" }).getAttribute("aria-expanded")).toBe("false");
    // The other column is untouched: folding is per column, not a board mode.
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-expanded")).toBe("true");
    cleanup();

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy());
    expect(screen.queryByText("Finished")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("keeps a folded column quiet when its cards are filtered out", async () => {
    vi.mocked(api).mockResolvedValue(boardWithOneDoneCard());
    localStorage.setItem(storageKey("mobile.todoCollapsedColumns"), JSON.stringify(["done"]));
    localStorage.setItem(storageKey("mobile.todoHideDone"), "1");

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy());
    expect(screen.queryByText("1 card folded away")).toBeNull();
  });

  it("drops a fold set on a column the board no longer has", async () => {
    vi.mocked(api).mockResolvedValue(boardWithOneDoneCard());
    localStorage.setItem(storageKey("mobile.todoCollapsedColumns"), JSON.stringify(["done", "gone"]));

    render(createElement(Todo));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Done 1" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Today" }));

    expect(JSON.parse(localStorage.getItem(storageKey("mobile.todoCollapsedColumns")) ?? "[]")).toEqual(["done", "today"]);
  });
});
