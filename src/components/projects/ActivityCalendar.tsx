import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useT, useI18nStore, type TranslationKey } from "../../lib/i18n";
import { formatWorkedTime } from "../../lib/formatWorkedTime";
import { useSettingsStore } from "../../stores/settings";

interface Props {
  data: Record<string, number>; // "YYYY-MM-DD" -> seconds (full history, all years)
}

function formatTime(secs: number, t: (key: TranslationKey) => string): string {
  if (secs <= 0) return t("activityCal.noActivity");
  if (secs < 60) return `${Math.round(secs)}s`;
  return formatWorkedTime(t, secs);
}

function getLevel(secs: number): 0 | 1 | 2 | 3 | 4 {
  if (secs <= 0) return 0;
  if (secs < 1800) return 1;
  if (secs < 7200) return 2;
  if (secs < 14400) return 3;
  return 4;
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Cell {
  date: string;
  secs: number;
  future: boolean;
}

const CELL = 11;
const GAP = 2;
const STEP = CELL + GAP;
const LABEL_H = 16;
const DAY_LABEL_W = 28;
// Every other row carries a name, the way a contribution graph does. Which
// rows those are follows `Settings.calendar_week_start`: Monday is row 0 of a
// Monday-first grid, row 1 of a Sunday-first one.
function dayLabelKeys(weekStart: 0 | 1): (TranslationKey | null)[] {
  const named: Record<number, TranslationKey> = {
    1: "activityCal.dayMon",
    3: "activityCal.dayWed",
    5: "activityCal.dayFri",
  };
  return Array.from({ length: 7 }, (_, row) => named[(row + weekStart) % 7] ?? null);
}

function buildWeeks(
  year: number,
  data: Record<string, number>,
  weekStart: 0 | 1,
): Cell[][] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentYear = today.getFullYear();

  // Start: the week's first day on or before Jan 1 of the year
  const start = new Date(year, 0, 1);
  start.setDate(start.getDate() - ((start.getDay() - weekStart + 7) % 7));

  // End: Dec 31 of the selected year, or today if it's the current year
  const end = year === currentYear ? today : new Date(year, 11, 31);

  const weeks: Cell[][] = [];
  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getDay() === weekStart) weeks.push([]);
    const ds = toDateStr(cur);
    const future = cur > today;
    weeks[weeks.length - 1].push({ date: ds, secs: future ? 0 : (data[ds] ?? 0), future });
    cur.setDate(cur.getDate() + 1);
  }
  // Pad last partial week
  if (weeks.length > 0) {
    const last = weeks[weeks.length - 1];
    while (last.length < 7) {
      last.push({ date: "", secs: 0, future: true });
    }
  }
  return weeks;
}

export function ActivityCalendar({ data }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const weekStart = useSettingsStore((s) => (s.settings?.calendar_week_start ?? 1) as 0 | 1);
  const currentYear = new Date().getFullYear();

  const availableYears = useMemo(() => {
    const years = new Set<number>([currentYear]);
    for (const date of Object.keys(data)) {
      const y = parseInt(date.slice(0, 4), 10);
      if (!isNaN(y) && y > 2000) years.add(y);
    }
    return Array.from(years).sort();
  }, [data, currentYear]);

  const [selectedYear, setSelectedYear] = useState(currentYear);

  const todayStr = toDateStr(new Date());
  const weeks = useMemo(
    () => buildWeeks(selectedYear, data, weekStart),
    [selectedYear, data, weekStart],
  );
  const dayLabels = useMemo(() => dayLabelKeys(weekStart), [weekStart]);

  const [tooltip, setTooltip] = useState<{
    date: string;
    secs: number;
    x: number;
    y: number;
  } | null>(null);

  // Month labels: first column per month
  const monthLabels = useMemo(() => {
    const labels: { label: string; col: number }[] = [];
    weeks.forEach((week, ci) => {
      const first = week.find((c) => !c.future && c.date);
      if (!first) return;
      const d = new Date(first.date);
      const label = d.toLocaleString(lang, { month: "short" });
      if (!labels.length || labels[labels.length - 1].label !== label) {
        labels.push({ label, col: ci });
      }
    });
    return labels;
  }, [weeks, lang]);

  return (
    <div className="activity-calendar">
      {/* Year selector */}
      {availableYears.length > 1 && (
        <div className="activity-years">
          {availableYears.map((y) => (
            <button
              key={y}
              className={`activity-year-btn${y === selectedYear ? " selected" : ""}`}
              onClick={() => setSelectedYear(y)}
            >
              {y}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex" }}>
        {/* Day-of-week labels */}
        <div style={{ width: DAY_LABEL_W, paddingTop: LABEL_H, flexShrink: 0 }}>
          {dayLabels.map((key, i) => (
            <div
              key={i}
              style={{
                height: STEP,
                fontSize: 9,
                color: "var(--text-muted)",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                paddingRight: 4,
                userSelect: "none",
              }}
            >
              {key ? t(key) : ""}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div style={{ position: "relative" }}>
          {/* Month labels */}
          <div style={{ height: LABEL_H, position: "relative" }}>
            {monthLabels.map(({ label, col }) => (
              <span
                key={`${label}-${col}`}
                style={{
                  position: "absolute",
                  left: col * STEP,
                  bottom: 2,
                  fontSize: 10,
                  color: "var(--text-muted)",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            ))}
          </div>

          <svg
            width={weeks.length * STEP}
            height={7 * STEP}
            style={{ display: "block", overflow: "visible" }}
          >
            {weeks.map((week, ci) =>
              week.map((cell, ri) => {
                const level = cell.future ? 0 : getLevel(cell.secs);
                return (
                  <rect
                    key={`${ci}-${ri}`}
                    x={ci * STEP}
                    y={ri * STEP}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    className={[
                      "activity-cell",
                      `activity-cell-${level}`,
                      cell.date === todayStr ? "activity-today" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ cursor: cell.future || !cell.date ? "default" : "pointer" }}
                    onMouseEnter={(e) => {
                      if (cell.future || !cell.date) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      setTooltip({ date: cell.date, secs: cell.secs, x: r.left + r.width / 2, y: r.top });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })
            )}
          </svg>
        </div>
      </div>

      {/* Legend */}
      <div className="activity-legend">
        <span>{t("activityCal.less")}</span>
        {([0, 1, 2, 3, 4] as const).map((l) => (
          <svg key={l} width={CELL} height={CELL} style={{ flexShrink: 0 }}>
            <rect width={CELL} height={CELL} rx={2} className={`activity-cell activity-cell-${l}`} />
          </svg>
        ))}
        <span>{t("activityCal.more")}</span>
      </div>

      {tooltip &&
        createPortal(
          <div
            className="activity-tooltip"
            style={{ left: tooltip.x, top: tooltip.y - 6 }}
          >
            <strong>{tooltip.date}</strong>: {formatTime(tooltip.secs, t)}
          </div>,
          document.body,
        )}
    </div>
  );
}
