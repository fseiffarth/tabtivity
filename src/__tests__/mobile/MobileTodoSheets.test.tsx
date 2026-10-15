/**
 * The phone board's questions are the phone's own sheets (`ConfirmSheet` /
 * `NameSheet`), never `window.confirm` / `window.prompt` — which a phone draws
 * as the browser's own box, headed with the site's address.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../mobile-web/src/api";
import { Todo } from "../../../mobile-web/src/screens/Todo";
import type { TodoCard, TodoColumn } from "../../../mobile-web/src/api";

vi.mock("../../../mobile-web/src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mobile-web/src/api")>();
  return { ...actual, api: vi.fn() };
});

const COLUMNS: TodoColumn[] = [
  { id: "doing", name: "Doing", position: 0, done: false, archived: false, intake: false, overdue: false, due_today: false },
  { id: "backlog", name: "Backlog", position: 1, done: false, archived: false, intake: true, overdue: false, due_today: false },
];

const CARD: TodoCard = {
  id: "card", title: "Write it up", notes: "", column: "doing", done: false,
  priority: 0, percent: 0, calendar_id: "calendar", tags: [], subtasks: [],
};

const board = { columns: COLUMNS, tasks: [CARD], calendars: [{ id: "calendar", name: "Personal" }], projects: [] };

/** The bodies POSTed so far. */
const posts = () => vi.mocked(api).mock.calls
  .filter(([, init]) => init?.method === "POST")
  .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

beforeEach(() => {
  vi.mocked(api).mockResolvedValue({ board });
  vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("window.prompt must not be used"); });
  vi.spyOn(window, "confirm").mockImplementation(() => { throw new Error("window.confirm must not be used"); });
});

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount() {
  render(createElement(Todo));
  await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
}

describe("mobile board sheets", () => {
  it("names a new column in a sheet", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "+ Column" }));
    const sheet = screen.getByRole("dialog", { name: "Add a column" });
    const add = within(sheet).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    // Nothing to add until there is a name.
    expect(add.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("Column name"), { target: { value: "  Review " } });
    fireEvent.click(add);
    await waitFor(() => expect(posts()).toEqual([{ type: "column_create", name: "Review" }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a column" })).toBeNull());
  });

  it("renames a column from a pre-filled sheet, and an unchanged name sends nothing", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Rename Doing" }));
    const sheet = screen.getByRole("dialog", { name: "Rename Doing" });
    const field = within(sheet).getByLabelText("Column name") as HTMLInputElement;
    expect(field.value).toBe("Doing");
    const rename = within(sheet).getByRole("button", { name: "Rename" }) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "In progress" } });
    // Enter in the field is the same as the button.
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(posts()).toEqual([{ type: "column_rename", column_id: "doing", name: "In progress" }]));
  });

  it("asks before deleting a column", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete Doing" }));
    expect(posts()).toEqual([]);
    const sheet = screen.getByRole("dialog", { name: "Delete Doing" });
    expect(sheet.textContent).toContain("1 cards will be refiled");
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(posts()).toEqual([{ type: "column_delete", column_id: "doing" }]));
  });

  it("asks before deleting a card, over its editor", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "✎ Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const sheet = screen.getByRole("dialog", { name: "Delete “Write it up”?" });
    expect(posts()).toEqual([]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(posts()).toEqual([{ type: "delete", task_id: "card" }]));
  });
});
