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

/** A column's ⋯ sheet, then one of its rows. */
function columnAction(column: string, row: string) {
  fireEvent.click(screen.getByRole("button", { name: `${column}: column actions` }));
  fireEvent.click(within(screen.getByRole("dialog", { name: column })).getByRole("button", { name: row }));
}

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
  it("offers the column actions in a sheet, and no delete on the only column", async () => {
    vi.mocked(api).mockResolvedValue({ board: { ...board, columns: [COLUMNS[0]] } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Doing: column actions" }));
    const sheet = screen.getByRole("dialog", { name: "Doing" });
    expect(within(sheet).getByRole("button", { name: "Rename Doing" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Fold" })).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Move Doing left" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(sheet).getByRole("button", { name: "Move Doing right" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).queryByRole("button", { name: "Delete Doing" })).toBeNull();
  });

  it("folds and moves a column from its sheet", async () => {
    await mount();
    columnAction("Backlog", "Fold");
    expect(screen.getByRole("button", { name: "Backlog" }).getAttribute("aria-expanded")).toBe("false");
    columnAction("Backlog", "Move Backlog left");
    await waitFor(() => expect(posts()).toEqual([{ type: "column_move", column_id: "backlog", delta: -1 }]));
  });

  it("moves a card up, down and to another column from its sheet", async () => {
    const second: TodoCard = { ...CARD, id: "second", title: "Review it", rank: 2 };
    vi.mocked(api).mockResolvedValue({ board: { ...board, tasks: [{ ...CARD, rank: 1 }, second] } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Write it up: card actions" }));
    let sheet = screen.getByRole("dialog", { name: "Write it up" });
    // First card: nothing above it; the current column has no "Move to" row.
    expect((within(sheet).getByRole("button", { name: "Move Write it up up" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).queryByRole("button", { name: "Move to Doing" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Move Write it up down" }));
    await waitFor(() => expect(posts()).toEqual([{ type: "move", task_id: "card", column: "doing", index: 1 }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Write it up" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Review it: card actions" }));
    sheet = screen.getByRole("dialog", { name: "Review it" });
    expect((within(sheet).getByRole("button", { name: "Move Review it down" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Move to Backlog" }));
    await waitFor(() => expect(posts()[posts().length - 1]).toEqual({ type: "move", task_id: "second", column: "backlog" }));
  });

  it("opens the editor from the card sheet", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Write it up: card actions" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Write it up" })).getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("filters by project and tag from the sheet, shows chips, and removes them", async () => {
    const tagged: TodoCard = { ...CARD, id: "tagged", title: "Tagged", tags: ["work"], project_id: "p1" };
    vi.mocked(api).mockResolvedValue({ board: { ...board, tasks: [CARD, tagged], projects: [{ id: "p1", name: "Atlas" }] } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Atlas" }));
    expect(screen.queryByText("Write it up")).toBeNull();
    expect(screen.getByText("Tagged")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "#work" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    // Both filters show as removable chips, and the button counts them.
    expect(screen.getByRole("button", { name: "Filters, 2 on" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Tag: #work" }));
    expect(screen.queryByRole("button", { name: "Remove filter Tag: #work" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Project: Atlas" }));
    expect(screen.getByText("Write it up")).toBeTruthy();
  });

  it("names a new column in a sheet", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a column" }));
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
    columnAction("Doing", "Rename Doing");
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
    columnAction("Doing", "Delete Doing");
    expect(posts()).toEqual([]);
    const sheet = screen.getByRole("dialog", { name: "Delete Doing" });
    expect(sheet.textContent).toContain("1 cards will be refiled");
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(posts()).toEqual([{ type: "column_delete", column_id: "doing" }]));
  });

  it("asks before deleting a card, over its editor", async () => {
    await mount();
    fireEvent.click(screen.getByText("Write it up"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const sheet = screen.getByRole("dialog", { name: "Delete “Write it up”?" });
    expect(posts()).toEqual([]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(posts()).toEqual([{ type: "delete", task_id: "card" }]));
  });
});
