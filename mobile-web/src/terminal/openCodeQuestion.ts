import type { ReadableSpan } from "./readableScreen";
import type { QuestionTab, SelectOption, SelectPrompt } from "./selectPrompt";

/** OpenCode 1.18.34's QuestionPrompt (source checked, plus the phone screenshot
 * of 2026-10-16). The footer identifies a live question; numbers alone never
 * do. OpenCode uses colours rather than an arrow for the selected answer.
 * Number shortcuts select rows 1–9 directly, independently of that highlight.
 * 2.1.3 (captured 2026-10-24) asks through a form titled `Questions`, drawn in
 * a barred box whose empty rows `readableScreen` drops: `afterRule`, set on the
 * row under one, stands for the blank row that ends the heading. */
interface QuestionLine { text: string; edge?: number; afterRule?: boolean; spans?: readonly ReadableSpan[] }
const FOOTER = /^\s*(?:⇆\s+tab\s+)?(?:↑↓\s+select\s+)?enter\s+(submit|confirm|toggle)\s+esc\s+dismiss\s*$/u;
const OPTION = /^(\s*)(\d{1,2})\.\s+(\S.*)$/u;
/** A wide pane draws the session's sidebar right of the question (2.1.3,
 * captured at 200×50: the question's box ends at column 156, the sidebar's
 * words start at 160). Its last row, the folder and branch
 * (`/…/proj:master`), sits under the footer with nothing to its left, so it
 * is the screen's last row. A row whose words start this far in is never the
 * question's. */
const SIDEBAR_COLUMN = 40;
/** The blanks between the question's box and the sidebar's words. */
const SIDEBAR_GUTTER = 2;

function spanAt(line: QuestionLine, column: number): ReadableSpan | undefined {
  let offset = 0;
  for (const span of line.spans ?? []) {
    offset += span.text.length;
    if (column < offset) return span;
  }
  return undefined;
}

function backgroundAt(line: QuestionLine, column: number): string | undefined {
  return spanAt(line, column)?.background;
}

function previous(lines: readonly QuestionLine[], from: number): number {
  let row = from - 1;
  while (row >= 0 && !lines[row].text.trim()) row -= 1;
  return row;
}

function navigation(line: QuestionLine, baseline: string | undefined): SelectPrompt["navigation"] {
  const labels = line.text.trim().split(/\s{2,}/u);
  // The last step is Confirm in 1.18.34, Submit in 2.1.3.
  if (labels.length < 2 || !/^(?:Confirm|Submit)$/u.test(labels[labels.length - 1])) return undefined;
  let offset = 0;
  const columns = labels.map((label) => {
    const column = line.text.indexOf(label, offset);
    offset = column + label.length;
    return column;
  });
  let active = columns.flatMap((column, index) => {
    const background = backgroundAt(line, column);
    return background !== undefined && background !== baseline ? [index] : [];
  });
  // 2.1.3 draws no background: the step it is on is bold.
  if (active.length === 0) {
    active = columns.flatMap((column, index) => (/(?:^|\s)b(?:\s|$)/u.test(spanAt(line, column)?.className ?? "") ? [index] : []));
  }
  const tabs: QuestionTab[] = labels.slice(0, -1).map((label) => ({ label, answered: false }));
  return { tabs, focus: active.length === 1 ? active[0] : null, submit: true, keys: "tabs" };
}

/** `lines` without the sidebar: its last row dropped and every row cut at its
 * column, counted on screen (`edge` is what `readableScreen` took off the
 * front). The spans stay whole: only columns left of the cut are read from
 * them. */
function withoutSidebar(lines: readonly QuestionLine[]): readonly QuestionLine[] {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].text.trim()) last -= 1;
  const indent = last >= 0 ? lines[last].text.search(/\S/u) : -1;
  if (indent < SIDEBAR_COLUMN || FOOTER.test(lines[last].text)) return lines;
  const column = (lines[last].edge ?? 0) + indent - SIDEBAR_GUTTER;
  return lines.slice(0, last).map((line) => {
    const cut = Math.max(0, column - (line.edge ?? 0));
    return line.text.length > cut ? { ...line, text: line.text.slice(0, cut).trimEnd() } : line;
  });
}

export function readOpenCodeQuestion(screen: readonly QuestionLine[]): SelectPrompt | null {
  const lines = withoutSidebar(screen);
  let footer = lines.length - 1;
  while (footer >= 0 && !lines[footer].text.trim()) footer -= 1;
  const hints = footer >= 0 ? FOOTER.exec(lines[footer].text) : null;
  if (!hints) return null;
  const first = Math.max(0, footer - 80);
  let rows: { row: number; match: RegExpExecArray }[] = [];
  for (let row = first; row < footer; row += 1) {
    const match = OPTION.exec(lines[row].text);
    if (match) {
      if (match[2] === "1") rows = [];
      rows.push({ row, match });
    }
  }

  if (!/↑↓\s+select/u.test(hints[0])) {
    // The last step draws one summary per question under the tab row, with
    // Enter to send: headed Review in 1.18.34, bare in 2.1.3.
    for (let tabRow = footer - 1; tabRow >= first; tabRow -= 1) {
      let row = tabRow + 1;
      while (row < footer && !lines[row].text.trim()) row += 1;
      if (row >= footer) continue;
      const nav = navigation(lines[tabRow], backgroundAt(lines[row], lines[row].text.search(/\S/u)));
      if (!nav) continue;
      if (nav.focus !== nav.tabs.length || hints[1] !== "submit") return null;
      return {
        source: "opencode", navigation: nav, review: true,
        options: [{ index: 0, number: 1, label: "Submit", keys: ["\r"] }],
        current: 0, title: "Review", start: footer, question: row, context: row,
      };
    }
    return null;
  }
  if (rows.length === 0 || rows.some(({ match }, index) => Number(match[2]) !== index + 1)) return null;
  const start = rows[0].row;
  const headingEnd = previous(lines, start);
  if (headingEnd < first) return null;
  let question = headingEnd;
  while (question > first && !lines[question].afterRule && lines[question - 1].text.trim()) question -= 1;
  const title = lines.slice(question, headingEnd + 1).map((line) => line.text.trim()).join(" ");
  const baseline = backgroundAt(lines[question], lines[question].text.search(/\S/u));
  const tabRow = previous(lines, question);
  const nav = tabRow >= first ? navigation(lines[tabRow], baseline) : undefined;
  if (/⇆\s+tab/u.test(hints[0]) && !nav) return null;
  let active = rows.flatMap(({ row, match }, index) => {
    const background = backgroundAt(lines[row], match[1].length);
    return background !== undefined && background !== baseline ? [index] : [];
  });
  // 2.1.3 draws no background: the row it is on has its number in its
  // label's colour, the accent; every other row's number is muted.
  if (active.length === 0) {
    active = rows.flatMap(({ row, match }, index) => {
      const number = spanAt(lines[row], match[1].length)?.color;
      return number !== undefined && number === spanAt(lines[row], match[0].length - match[3].length)?.color ? [index] : [];
    });
  }
  // Larger lists need a known highlight for rows without number shortcuts.
  if (rows.length > 9 && active.length !== 1) return null;
  const options: SelectOption[] = rows.map(({ row, match }, index) => {
    const label = match[3];
    const inputLabel = label.replace(/\s+✓$/u, "");
    const end = rows[index + 1]?.row ?? footer;
    const description = lines.slice(row + 1, end).map((line) => line.text.trim()).filter(Boolean).join(" ");
    return {
      index, number: index + 1, label,
      ...(description ? { description } : {}),
      ...(index < 9 ? { keys: [String(index + 1)] } : {}),
      ...(/^(?:\[[^\]]\]\s+)?Type your own answer$/u.test(inputLabel) ? { input: "opencode" as const } : {}),
    };
  });
  return {
    source: "opencode", navigation: nav, options,
    current: active.length === 1 ? active[0] : 0,
    title, start, question, context: question,
  };
}
