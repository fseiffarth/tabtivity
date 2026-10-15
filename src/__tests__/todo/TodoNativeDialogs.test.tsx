/**
 * The to-do board's questions are the app's own dialogs (`useDialogs`), never
 * `window.confirm` / `window.prompt` — which WebKitGTK draws as a bare
 * origin-titled box.
 *
 * The card dialog's delete is the subtle one: the card sits on
 * `.modal-backdrop-elevated` above the board, so its question has to ride above
 * that layer (`DialogShell` lifts itself), and the card's own Escape handler
 * must not see the question's Escape — Escape cancels the question, not the
 * card being edited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TodoCardDialog } from "../../components/todo/TodoCardDialog";
import { TodoBoard } from "../../components/todo/TodoBoard";
import { useSettingsStore } from "../../stores/settings";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useProjectsStore } from "../../stores/projects";
import type { CalendarTask, TaskColumn } from "../../types";

const COLUMNS: TaskColumn[] = [
  { id: "todo", name: "To do", position: 0, done: false },
  { id: "doing", name: "Doing", position: 1, done: false },
];

const TASK: CalendarTask = { id: "t1", calendar_id: "cal1", title: "Pay rent", priority: 0, percent: 0, column: "todo" };

beforeEach(() => {
  vi.spyOn(window, "confirm").mockImplementation(() => { throw new Error("window.confirm must not be used"); });
  vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("window.prompt must not be used"); });
  useSettingsStore.setState({ settings: { time_format_24h: true, calendar_global_app: false }, loaded: true });
  useProjectsStore.setState({ projects: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("to-do card dialog delete", () => {
  function mount() {
    const deleteTask = vi.fn(async () => {});
    useCalendarStore.setState({
      calendars: [{ id: "cal1", name: "Cal", color: "#888", visible: true, readonly: false }],
      deleteTask,
    });
    const onClose = vi.fn();
    render(<TodoCardDialog task={TASK} columns={COLUMNS} onClose={onClose} onOpenMail={vi.fn()} />);
    return { deleteTask, onClose };
  }

  /** The question, told apart from the card (also a `dialog`) by its own frame. */
  const question = () => document.querySelector(".file-delete-dialog") as HTMLElement | null;

  it("asks above the elevated card and deletes on yes", async () => {
    const user = userEvent.setup();
    const { deleteTask, onClose } = mount();
    const card = screen.getByRole("dialog");
    await user.click(within(card).getByRole("button", { name: "Delete" }));

    const asked = question();
    expect(asked).not.toBeNull();
    expect(deleteTask).not.toHaveBeenCalled();
    // On the card's layer, not under it at the plain modal one.
    expect(asked!.closest(".modal-backdrop")?.classList.contains("modal-backdrop-elevated")).toBe(true);

    await user.click(within(asked!).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith("t1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape cancels the question and leaves the card open", async () => {
    const user = userEvent.setup();
    const { deleteTask, onClose } = mount();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(question()).not.toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(question()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("a press on the question's backdrop dismisses only the question", async () => {
    const { deleteTask, onClose } = mount();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    const backdrop = question()!.closest(".modal-backdrop") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    await waitFor(() => expect(question()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });
});

describe("to-do board columns", () => {
  function mount() {
    const setColumns = vi.fn(async () => {});
    useCalendarStore.setState({ taskColumns: COLUMNS, setColumns });
    render(
      <TodoBoard
        columns={COLUMNS}
        tasks={[]}
        countTasks={[]}
        defaultCalendarId="cal1"
        inheritProjectId={null}
        onEditCard={vi.fn()}
        onOpenMail={vi.fn()}
      />,
    );
    return { setColumns };
  }

  it("asks a new column's name in the app's prompt", async () => {
    const user = userEvent.setup();
    const { setColumns } = mount();
    await user.click(screen.getByRole("button", { name: /Add a column/ }));
    const asked = await screen.findByRole("dialog", { name: "Add a column" });
    await user.type(within(asked).getByRole("textbox", { name: "Column name" }), "  Review  ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(setColumns).toHaveBeenCalledTimes(1));
    const written = (setColumns.mock.calls[0] as unknown as [TaskColumn[]])[0];
    expect(written.map((c) => c.name)).toEqual(["To do", "Doing", "Review"]);
    expect(written[2]).toMatchObject({ id: "", position: 2, done: false });
  });

  it("asks before deleting a column, then writes the rest", async () => {
    const user = userEvent.setup();
    const { setColumns } = mount();
    await user.click(screen.getAllByRole("button", { name: "Delete column" })[1]);
    const asked = await screen.findByRole("dialog", { name: "Delete column" });
    expect(asked.textContent).toContain("Doing");
    expect(setColumns).not.toHaveBeenCalled();
    await user.click(within(asked).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(setColumns).toHaveBeenCalledTimes(1));
    const written = (setColumns.mock.calls[0] as unknown as [TaskColumn[]])[0];
    expect(written.map((c) => c.id)).toEqual(["todo"]);
  });

  it("a dismissed name prompt adds nothing", async () => {
    const user = userEvent.setup();
    const { setColumns } = mount();
    await user.click(screen.getByRole("button", { name: /Add a column/ }));
    const asked = await screen.findByRole("dialog", { name: "Add a column" });
    await user.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setColumns).not.toHaveBeenCalled();
  });
});
