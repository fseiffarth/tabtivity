import { useT } from "../../lib/i18n";
import { isTabMark, tabMarkGlyph } from "../../lib/tabMarks";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import { openTodoCard } from "./TabMarkMenuItems";
import { CheckboxIcon } from "../common/icons/Icon";

/**
 * A tab's Important / Urgent glyph and its to-do card link, on the tab itself.
 * Shared by the main window's `TabBar` and the popout strip. The ☑ opens the
 * card on the board — in the main window only, where the board lives; a popout
 * shows it as a plain mark.
 */
export function TabMarkBadge({ tab, inPopout = false }: { tab: TabEntry; inPopout?: boolean }) {
  const t = useT();
  const boardOn = useSettingsStore((s) => s.settings?.todo_board ?? false);
  const mark = isTabMark(tab.mark) ? tab.mark : null;
  const todoId = boardOn ? tab.todoId : undefined;
  if (!mark && !todoId) return null;
  return (
    <>
      {mark && (
        <span
          className={`tab-mark-glyph ${mark}`}
          title={t(mark === "urgent" ? "tabMark.urgent" : "tabMark.important")}
        >
          {tabMarkGlyph(mark)}
        </span>
      )}
      {todoId &&
        (inPopout ? (
          <span className="tab-todo-link" title={t("tabTodo.linked")}>
            <CheckboxIcon />
          </span>
        ) : (
          <button
            type="button"
            className="tab-todo-link"
            title={t("tabTodo.open")}
            aria-label={t("tabTodo.open")}
            // Keep the click out of the tab's drag + activation.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              openTodoCard(todoId);
            }}
          >
            <CheckboxIcon />
          </button>
        ))}
    </>
  );
}
