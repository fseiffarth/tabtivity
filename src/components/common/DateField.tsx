import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  addDays,
  addMonths,
  addYears,
  datePart,
  monthGrid,
  monthName,
  parseStamp,
  startOfWeek,
  todayStr,
  weekdayLabel,
} from "../../lib/calendar/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { ContextMenuPortal } from "./ContextMenuPortal";
import { CalendarIcon } from "./icons/Icon";

/**
 * **The** day-entry field — `common/TimeField`'s other half, and the one control
 * a *date* is picked in, drawn by Tabtivity rather than by the engine.
 *
 * It exists for the reason `TimeField` does, twice over. `<input type="date">`
 * takes its segment order (`MM/DD/YYYY` vs `DD.MM.YYYY`) from the **process**
 * locale, so a German-language Tabtivity still asked for the month first; and under
 * WebKitGTK its calendar popover is its own grabbing widget that never dismisses
 * on its own — the click that picks a day does not even reach the document, so
 * every caller grew the same blur-on-change/blur-on-outside-pointerdown pair of
 * workarounds (`todo/TodoCardDialog.tsx` documents them at length) and each copy
 * drifted. Drawing the calendar makes both problems disappear: it is ordinary
 * DOM inside `common/ContextMenuPortal`, which already owns dismissal, viewport
 * clamping and layering for every popover in the app.
 *
 * The shape is a **button that reads as a date** plus a month grid, not a row of
 * segments: unlike an hour, a date is far more often *chosen* ("next Tuesday")
 * than typed, and 2ch segments were already the complaint that took the board's
 * due time back off `TimeField`. Nothing here needs a parse to fail — the grid
 * can only produce a real day — and the value on the wire stays exactly what the
 * native input handed its callers: `"YYYY-MM-DD"`, or `""` for none.
 *
 * Keyboard, once the calendar is open: ←/→ a day, ↑/↓ a week, PageUp/PageDown a
 * month (with Shift, a year), Home/End the ends of the week, `t` today, Enter or
 * Space picks, Escape closes. The grid is a roving focus, so a screen reader and
 * the eye agree on where the cursor is.
 */
interface Props {
  /** The stored day, `"YYYY-MM-DD"`, or `""` for none. */
  value: string;
  /** Called with a new `"YYYY-MM-DD"`, or `""` when the field is cleared. */
  onChange: (date: string) => void;
  /** Earliest selectable day, `"YYYY-MM-DD"` — earlier days render disabled. */
  min?: string;
  /** Latest selectable day, `"YYYY-MM-DD"`. */
  max?: string;
  /** Offer a Clear button in the calendar's footer (a date the caller may drop). */
  clearable?: boolean;
  /** The caller's box class — this renders as one field, so it wears it. */
  className?: string;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

/** The trigger's label: `"Wed, 3 Sep 2026"` in the app's language. */
export function formatFieldDate(date: string, lang: string): string {
  const civil = parseStamp(date);
  if (!civil) return "";
  return new Date(civil.year, civil.month - 1, civil.day, 12).toLocaleDateString(lang, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function inRange(date: string, min?: string, max?: string): boolean {
  // ISO dates sort lexicographically, which is the whole reason the wire format
  // is this one — no parsing to compare two days.
  if (min && date < min) return false;
  if (max && date > max) return false;
  return true;
}

export function DateField({
  value,
  onChange,
  min,
  max,
  clearable,
  className,
  disabled,
  title,
  "aria-label": ariaLabel,
}: Props) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const weekStart = (useSettingsStore((state) => state.settings?.calendar_week_start) ?? 1) as 0 | 1;
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const today = todayStr();
  // The day the keyboard sits on, which is also the month the grid shows. Seeded
  // from the value when the calendar opens, so re-opening never resumes a walk
  // the user abandoned.
  const [cursor, setCursor] = useState(today);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const civil = parseStamp(cursor) ?? parseStamp(today)!;

  const weeks = useMemo(
    () => monthGrid(civil.year, civil.month, weekStart),
    [civil.year, civil.month, weekStart],
  );
  const weekdays = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => weekdayLabel(lang, i, "short"));
    return [...days.slice(weekStart), ...days.slice(0, weekStart)];
  }, [lang, weekStart]);

  const open = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    setCursor(datePart(value) || today);
    setAnchor(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 0, y: 0 });
  };

  const close = (restoreFocus = true) => {
    setAnchor(null);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const pick = (date: string) => {
    if (!inRange(date, min, max)) return;
    onChange(date);
    close();
  };

  // Roving focus: whichever day the cursor is on is the one focusable button, so
  // the grid keeps focus inside itself while the arrows walk months apart.
  useLayoutEffect(() => {
    if (!anchor) return;
    const cell = gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`);
    cell?.focus();
  }, [anchor, cursor]);

  // Escape is handled on the popover itself rather than on the document: the
  // dialogs this lives in stop their own Escape, and a document listener here
  // would close the dialog behind the calendar as well.
  useEffect(() => {
    if (!anchor) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [anchor]);

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = (next: string) => {
      event.preventDefault();
      setCursor(next);
    };
    switch (event.key) {
      case "ArrowLeft": return step(addDays(cursor, -1));
      case "ArrowRight": return step(addDays(cursor, 1));
      case "ArrowUp": return step(addDays(cursor, -7));
      case "ArrowDown": return step(addDays(cursor, 7));
      case "Home": return step(startOfWeek(cursor, weekStart));
      case "End": return step(addDays(startOfWeek(cursor, weekStart), 6));
      case "PageUp": return step(event.shiftKey ? addYears(cursor, -1) : addMonths(cursor, -1));
      case "PageDown": return step(event.shiftKey ? addYears(cursor, 1) : addMonths(cursor, 1));
      case "t": case "T": return step(today);
      default:
    }
  };

  const label = value ? formatFieldDate(value, lang) : t("dateField.pick");
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`date-field${className ? ` ${className}` : ""}${value ? "" : " is-empty"}`}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={() => (anchor ? close() : open())}
        onKeyDown={(event) => {
          // ↓ opens straight into the grid, the way a combobox does.
          if (event.key === "ArrowDown" && !anchor) {
            event.preventDefault();
            open();
          }
        }}
      >
        <CalendarIcon className="date-field-icon" />
        <span className="date-field-label">{label}</span>
      </button>
      {anchor ? (
        <ContextMenuPortal
          x={anchor.x}
          y={anchor.y}
          className="date-pop"
          onClose={() => close(false)}
        >
          <div className="date-pop-head">
            <button type="button" className="date-pop-nav" aria-label={t("dateField.prevYear")}
              onClick={() => setCursor(addYears(cursor, -1))}>«</button>
            <button type="button" className="date-pop-nav" aria-label={t("dateField.prevMonth")}
              onClick={() => setCursor(addMonths(cursor, -1))}>‹</button>
            <span className="date-pop-title">{monthName(lang, civil.month)} {civil.year}</span>
            <button type="button" className="date-pop-nav" aria-label={t("dateField.nextMonth")}
              onClick={() => setCursor(addMonths(cursor, 1))}>›</button>
            <button type="button" className="date-pop-nav" aria-label={t("dateField.nextYear")}
              onClick={() => setCursor(addYears(cursor, 1))}>»</button>
          </div>
          <div className="date-pop-weekdays">
            {weekdays.map((name) => <span key={name} className="date-pop-weekday">{name}</span>)}
          </div>
          <div
            ref={gridRef}
            className="date-pop-grid"
            role="grid"
            aria-label={ariaLabel ?? t("dateField.pick")}
            onKeyDown={onGridKeyDown}
          >
            {weeks.flat().map((date) => {
              const outside = parseStamp(date)!.month !== civil.month;
              const allowed = inRange(date, min, max);
              return (
                <button
                  key={date}
                  type="button"
                  data-date={date}
                  role="gridcell"
                  tabIndex={date === cursor ? 0 : -1}
                  aria-selected={date === datePart(value)}
                  aria-disabled={!allowed || undefined}
                  className={`date-pop-day${outside ? " is-outside" : ""}${date === today ? " is-today" : ""}${date === datePart(value) ? " is-selected" : ""}${allowed ? "" : " is-blocked"}`}
                  onClick={() => pick(date)}
                >
                  {parseStamp(date)!.day}
                </button>
              );
            })}
          </div>
          <div className="date-pop-foot">
            <button type="button" className="settings-btn sm" onClick={() => pick(today)}>
              {t("dateField.today")}
            </button>
            <button type="button" className="settings-btn sm" onClick={() => pick(addDays(today, 1))}>
              {t("dateField.tomorrow")}
            </button>
            {clearable ? (
              <button
                type="button"
                className="settings-btn sm"
                onClick={() => { onChange(""); close(); }}
              >
                {t("dateField.clear")}
              </button>
            ) : null}
          </div>
        </ContextMenuPortal>
      ) : null}
    </>
  );
}
