import { useEffect } from "react";
import { CheckboxIcon, SquareIcon } from "../common/icons/Icon";

import { useT } from "../../lib/i18n";
import { TAB_MARKS, tabMarkGlyph } from "../../lib/tabMarks";
import { boardColumns, fallbackColumnId, taskFromTab } from "../../lib/todoBoard";
import { BOX_SCOPE_PREFIX } from "../../lib/terminal/ptyId";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useSettingsStore } from "../../stores/settings";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { UntestedTag } from "../common/UntestedTag";

/** The project a scope stands for, or null for the root console and a box. */
function scopeProjectId(scope: string): string | null {
  return scope === ROOT_SCOPE || scope.startsWith(BOX_SCOPE_PREFIX) ? null : scope;
}

/** Open the board on a card (main window only — the board is not in popouts). */
export function openTodoCard(taskId: string) {
  useTodoStore.getState().openCard(taskId);
}

/**
 * Make a card from a tab, link the tab to it, and (in the main window) open it
 * so its details can be filled in right away. Filed the way every conversion
 * files one: the first calendar, the board's intake column.
 */
async function createCardFor(tab: TabEntry, scope: string, openAfter: boolean) {
  const calendar = useCalendarStore.getState();
  if (!calendar.loaded) await calendar.load();
  const current = useCalendarStore.getState();
  const task = await current.createTask(
    taskFromTab(tab, scopeProjectId(scope), {
      calendarId: current.calendars[0]?.id ?? "default",
      columnId: fallbackColumnId(boardColumns(current.taskColumns)),
      now: new Date(),
    }),
  );
  useTabsStore.getState().setTabTodo(tab.key, task.id);
  if (openAfter) openTodoCard(task.id);
}

/**
 * The tab right-click menu's Important / Urgent rows and its to-do card rows.
 *
 * Shared by the main window's `TabBar` and the popout's strip
 * (`DetachedCenterPanel`), for `TabColorPicker`'s reason: one component, so the
 * two menus cannot drift. The store setters forward from a popout by
 * themselves. `inPopout` only hides "Open to-do card" — the board overlay
 * lives in the main window.
 *
 * The card rows show only while the to-do board is switched on. A link whose
 * card is gone (deleted on the board) reads as no link: the menu offers a new
 * card rather than opening nothing.
 */
export function TabMarkMenuItems({
  tab,
  scope,
  inPopout = false,
  onDone,
}: {
  tab: TabEntry;
  scope: string;
  inPopout?: boolean;
  /** Close the menu. */
  onDone: () => void;
}) {
  const t = useT();
  const boardOn = useSettingsStore((s) => s.settings?.todo_board ?? false);
  const calendarLoaded = useCalendarStore((s) => s.loaded);
  const cardExists = useCalendarStore((s) => !!tab.todoId && s.tasks.some((task) => task.id === tab.todoId));
  useEffect(() => {
    if (boardOn && tab.todoId && !calendarLoaded) void useCalendarStore.getState().load();
  }, [boardOn, tab.todoId, calendarLoaded]);
  // Until the calendar has loaded, trust the link rather than flash "Create".
  const linked = !!tab.todoId && (cardExists || !calendarLoaded);

  return (
    <>
      <div className="tab-new-menu-group-label">
        {t("tabMark.menu")} <UntestedTag id="tabMark.menu" />
      </div>
      {TAB_MARKS.map((mark) => {
        const on = tab.mark === mark;
        return (
          <button
            key={mark}
            type="button"
            className={`tab-new-menu-item tab-mark-menu-item ${mark}${on ? " is-current" : ""}`}
            aria-pressed={on}
            onClick={() => {
              // The current mark again clears it — the row a mis-click is undone with.
              useTabsStore.getState().setTabMark(tab.key, on ? undefined : mark);
              onDone();
            }}
          >
            <span className="tab-mark-menu-glyph" aria-hidden="true">
              {tabMarkGlyph(mark)}
            </span>
            {t(mark === "urgent" ? "tabMark.urgent" : "tabMark.important")}
            {on && <span className="tab-mark-menu-check" aria-hidden="true">✓</span>}
          </button>
        );
      })}
      {boardOn &&
        (linked ? (
          <>
            {!inPopout && (
              <button
                type="button"
                className="tab-new-menu-item"
                onClick={() => {
                  openTodoCard(tab.todoId!);
                  onDone();
                }}
              >
                <span className="tab-new-menu-dot tab-new-menu-dot--accent"><CheckboxIcon /></span>
                {t("tabTodo.open")}
              </button>
            )}
            <button
              type="button"
              className="tab-new-menu-item"
              onClick={() => {
                useTabsStore.getState().setTabTodo(tab.key, undefined);
                onDone();
              }}
            >
              <span className="tab-new-menu-dot tab-new-menu-dot--accent"><SquareIcon /></span>
              {t("tabTodo.unlink")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="tab-new-menu-item"
            onClick={() => {
              onDone();
              void createCardFor(tab, scope, !inPopout).catch((e) =>
                console.error("[tab] create to-do card failed", e),
              );
            }}
          >
            <span className="tab-new-menu-dot tab-new-menu-dot--accent"><CheckboxIcon /></span>
            {t("tabTodo.create")}
            <UntestedTag id="tabTodo.create" />
          </button>
        ))}
    </>
  );
}
