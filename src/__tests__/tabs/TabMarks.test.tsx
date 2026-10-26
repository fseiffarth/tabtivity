/**
 * Tab marks (Important / Urgent) and the tab ⇄ to-do card link.
 *
 * What would fail silently: the mark or the link not surviving a relaunch
 * (`toSavedTabEntry` is the one enumerated projection), a planted value from
 * the layout file coming back, a duplicate inheriting either, and the pill
 * summing a scope other than its own.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const invokeMock = vi.fn((cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "calendar_load") {
    return Promise.resolve({ version: 3, calendars: [{ id: "cal1" }], events: [], tasks: [] });
  }
  if (cmd === "create_task") {
    const { task } = _args as { task: Record<string, unknown> };
    return Promise.resolve({ ...task, id: "card-1" });
  }
  return Promise.resolve([]);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import {
  allGroups,
  duplicateSpec,
  toSavedTabEntry,
  useTabsStore,
  type SavedTabEntry,
  type TabEntry,
} from "../../stores/tabs";
import { applyMarkToTabs, applyTodoToTabs } from "../../stores/detached";
import { isTabMark, markedTabs } from "../../lib/tabMarks";
import { linkedTabOf, taskFromTab } from "../../lib/todoBoard";
import { TabBar } from "../../components/tabs/TabBar";
import { PillTabMarks } from "../../components/projects/PillTabMarks";
import { useDragStore } from "../../stores/drag/drag";
import { useSettingsStore } from "../../stores/settings";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useTodoStore } from "../../stores/todo";

function shell(key: string, over: Partial<TabEntry> = {}): TabEntry {
  return { key, label: key, cmd: "", cwd: "/p", kind: "shell", scope: "p1", ...over };
}

function saved(over: Partial<SavedTabEntry> = {}): SavedTabEntry {
  return { key: "shell-1", label: "Shell", cmd: "", cwd: "/p/p1", kind: "shell", ...over };
}

beforeEach(() => {
  cleanup();
  invokeMock.mockClear();
  useDragStore.setState({ drag: null });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useSettingsStore.setState({ settings: null } as never);
  useCalendarStore.setState({ loaded: false, calendars: [], tasks: [], taskColumns: [] });
  useTodoStore.setState({ overlayOpen: false, focusTaskId: null });
});

describe("markedTabs", () => {
  it("lists urgent first, then bar order, and ignores anything that is not a mark", () => {
    const list = markedTabs([
      { key: "a", label: "A", mark: "important" },
      { key: "b", label: "B" },
      { key: "c", label: "C", mark: "urgent" },
      { key: "d", label: "D", mark: "important" },
      { key: "e", label: "E", mark: "loud" as never },
    ]);
    expect(list.map((m) => m.key)).toEqual(["c", "a", "d"]);
    expect(isTabMark("urgent")).toBe(true);
    expect(isTabMark("Urgent")).toBe(false);
  });
});

describe("setTabMark / setTabTodo", () => {
  it("marks, clears and refuses an unknown mark", () => {
    useTabsStore.setState({
      tabsByScope: { p1: [shell("shell-1"), shell("shell-2")] },
      tabs: [shell("shell-1"), shell("shell-2")],
      layoutByScope: { p1: { type: "group", id: "g1", tabKeys: ["shell-1", "shell-2"], activeKey: "shell-1" } },
    });
    const mark = () => useTabsStore.getState().tabsByScope.p1?.[0].mark;
    useTabsStore.getState().setTabMark("shell-1", "urgent");
    expect(mark()).toBe("urgent");
    expect(useTabsStore.getState().tabsByScope.p1?.[1].mark).toBeUndefined();
    useTabsStore.getState().setTabMark("shell-1", "loud" as never);
    expect(mark()).toBeUndefined();
  });

  it("writes the scope that owns the tab when it is not the active one", () => {
    useTabsStore.setState({
      scope: "other",
      tabsByScope: { other: [], p1: [shell("shell-1")] },
      layoutByScope: { p1: { type: "group", id: "g1", tabKeys: ["shell-1"], activeKey: "shell-1" } },
    });
    useTabsStore.getState().setTabMark("shell-1", "important");
    useTabsStore.getState().setTabTodo("shell-1", "card-9");
    expect(useTabsStore.getState().tabsByScope.p1?.[0]).toMatchObject({ mark: "important", todoId: "card-9" });
  });
});

describe("persistence", () => {
  it("projects mark and link onto the saved tab", () => {
    const out = toSavedTabEntry(shell("shell-1", { mark: "urgent", todoId: "card-1" }));
    expect(out.mark).toBe("urgent");
    expect(out.todoId).toBe("card-1");
  });

  it("restores a real mark and a well-formed id, and drops planted values", () => {
    useTabsStore.getState().loadFromLayout(
      [
        saved({ key: "a", mark: "urgent", todoId: "0b5e-card" }),
        saved({ key: "b", mark: "red; x" as never, todoId: "../../etc" }),
      ],
      "/p/p1",
      "p1",
    );
    const tabs = useTabsStore.getState().tabsByScope.p1 ?? [];
    expect(tabs.map((t) => [t.mark, t.todoId])).toEqual([
      ["urgent", "0b5e-card"],
      [undefined, undefined],
    ]);
  });

  it("a duplicate is neither marked nor linked", () => {
    const spec = duplicateSpec(shell("shell-1", { mark: "urgent", todoId: "card-1", color: "teal" }));
    expect(spec.mark).toBeUndefined();
    expect(spec.todoId).toBeUndefined();
    expect(spec.color).toBe("teal");
  });
});

describe("a popout's optimistic apply", () => {
  it("sets, clears and validates", () => {
    const tabs = [shell("shell-1"), shell("shell-2")];
    expect(applyMarkToTabs(tabs, "shell-1", "important")[0].mark).toBe("important");
    expect(applyMarkToTabs(tabs, "shell-1", "x" as never)[0]).toBe(tabs[0]);
    expect(applyTodoToTabs(tabs, "shell-2", "card-1")[1].todoId).toBe("card-1");
    expect(applyTodoToTabs(tabs, "shell-2", "a b")[1].todoId).toBeUndefined();
  });
});

describe("cards from tabs", () => {
  it("titles the card after the tab and files it under the project", () => {
    const task = taskFromTab({ label: "Fix login", mark: "urgent" }, "p1", {
      calendarId: "cal1",
      columnId: "backlog",
      now: new Date(2026, 8, 28, 9, 30),
    });
    expect(task).toMatchObject({ title: "Fix login", priority: 1, project_id: "p1", column: "backlog", calendar_id: "cal1" });
    expect(taskFromTab({ label: "x" }, null, { calendarId: "c", columnId: "b" }).project_id).toBeUndefined();
  });

  it("finds the linked tab across scopes", () => {
    const by = { p1: [shell("a")], p2: [shell("b", { todoId: "card-1" })] };
    expect(linkedTabOf(by, "card-1")).toEqual({ scope: "p2", key: "b", label: "b" });
    expect(linkedTabOf(by, "card-2")).toBeNull();
  });
});

describe("the tab's right-click menu", () => {
  function mountBar() {
    useTabsStore.getState().addTab({ label: "shell", cmd: "bash", cwd: "/p", kind: "shell" });
    const group = allGroups(useTabsStore.getState().layout)[0];
    const key = group.tabKeys[0];
    const view = render(<TabBar groupId={group.id} projectCwd="/p" showGroupClose={false} />);
    const tab = () => view.container.querySelector(".tab")!;
    const stored = () => useTabsStore.getState().tabs.find((t) => t.key === key);
    return { tab, stored };
  }

  function menuRow(text: string) {
    return [...document.querySelectorAll(".tab-new-menu .tab-new-menu-item")].find((el) =>
      el.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;
  }

  it("marks the tab Urgent, shows it on the tab, and the same row clears it", () => {
    const { tab, stored } = mountBar();
    fireEvent.contextMenu(tab());
    fireEvent.click(menuRow("Urgent")!);
    expect(stored()?.mark).toBe("urgent");
    expect(tab().querySelector(".tab-mark-glyph.urgent")?.textContent).toBe("!!");

    fireEvent.contextMenu(tab());
    expect(menuRow("Urgent")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(menuRow("Urgent")!);
    expect(stored()?.mark).toBeUndefined();
    expect(tab().querySelector(".tab-mark-glyph")).toBeNull();
  });

  it("offers no card rows while the to-do board is off", () => {
    useSettingsStore.setState({ settings: { todo_board: false } } as never);
    const { tab } = mountBar();
    fireEvent.contextMenu(tab());
    expect(menuRow("to-do card")).toBeUndefined();
  });

  it("creates a card from the tab, links it, and opens it on the board", async () => {
    useSettingsStore.setState({ settings: { todo_board: true } } as never);
    const { tab, stored } = mountBar();
    fireEvent.contextMenu(tab());
    await act(async () => {
      fireEvent.click(menuRow("Create to-do card")!);
    });
    await waitFor(() => expect(stored()?.todoId).toBe("card-1"));
    const created = invokeMock.mock.calls.find(([cmd]) => cmd === "create_task")?.[1] as {
      task: Record<string, unknown>;
    };
    expect(created.task).toMatchObject({ title: "shell", calendar_id: "cal1", project_id: "p1" });
    expect(useTodoStore.getState()).toMatchObject({ overlayOpen: true, focusTaskId: "card-1" });
    // The tab now carries the link glyph, and the menu offers Open / Unlink.
    expect(tab().querySelector(".tab-todo-link")).toBeTruthy();
    fireEvent.contextMenu(tab());
    expect(menuRow("Open to-do card")).toBeTruthy();
    fireEvent.click(menuRow("Unlink to-do card")!);
    expect(stored()?.todoId).toBeUndefined();
  });
});

describe("the project pill's summary", () => {
  it("shows the most pressing mark and the count, for its own scope only", () => {
    useTabsStore.setState({
      tabsByScope: {
        p1: [shell("a", { mark: "important" }), shell("b", { mark: "urgent" }), shell("c")],
        p2: [shell("d", { mark: "urgent", scope: "p2" })],
      },
    });
    const { container } = render(<PillTabMarks scope="p1" />);
    const badge = container.querySelector(".pill-tab-marks")!;
    expect(badge.classList.contains("urgent")).toBe(true);
    expect(badge.textContent).toBe("!!2");
    expect(badge.getAttribute("title")).toContain("!! b, ! a");
  });

  it("renders nothing for a scope without marks", () => {
    useTabsStore.setState({ tabsByScope: { p1: [shell("a")] } });
    const { container } = render(<PillTabMarks scope="p1" />);
    expect(container.firstChild).toBeNull();
  });
});
