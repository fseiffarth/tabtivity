import type { ReadableSpan } from "./readableScreen";
import type { QuestionTab, SelectOption, SelectPrompt } from "./selectPrompt";

/** OpenCode 1.18.34's QuestionPrompt (source checked, plus the phone screenshot
 * of 2026-10-16). The footer identifies a live question; numbers alone never
 * do. OpenCode uses colours rather than an arrow for the selected answer.
 * Number shortcuts select rows 1–9 directly, independently of that highlight. */
interface QuestionLine { text: string; spans?: readonly ReadableSpan[] }
const FOOTER = /^\s*(?:⇆\s+tab\s+)?(?:↑↓\s+select\s+)?enter\s+(submit|confirm|toggle)\s+esc\s+dismiss\s*$/u;
const OPTION = /^(\s*)(\d{1,2})\.\s+(\S.*)$/u;

function backgroundAt(line: QuestionLine, column: number): string | undefined {
  let offset = 0;
  for (const span of line.spans ?? []) {
    offset += span.text.length;
    if (column < offset) return span.background;
  }
  return undefined;
}

function previous(lines: readonly QuestionLine[], from: number): number {
  let row = from - 1;
  while (row >= 0 && !lines[row].text.trim()) row -= 1;
  return row;
}

function navigation(line: QuestionLine, baseline: string | undefined): SelectPrompt["navigation"] {
  const labels = line.text.trim().split(/\s{2,}/u);
  if (labels.length < 2 || labels[labels.length - 1] !== "Confirm") return undefined;
  let offset = 0;
  const active: number[] = [];
  labels.forEach((label, index) => {
    const column = line.text.indexOf(label, offset);
    offset = column + label.length;
    const background = backgroundAt(line, column);
    if (background !== undefined && background !== baseline) active.push(index);
  });
  const tabs: QuestionTab[] = labels.slice(0, -1).map((label) => ({ label, answered: false }));
  return { tabs, focus: active.length === 1 ? active[0] : null, submit: true, keys: "tabs" };
}

export function readOpenCodeQuestion(lines: readonly QuestionLine[]): SelectPrompt | null {
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
    // Confirm draws Review and one summary per question, with Enter to send.
    for (let row = footer - 1; row >= first; row -= 1) {
      if (lines[row].text.trim() !== "Review") continue;
      const baseline = backgroundAt(lines[row], lines[row].text.search(/\S/u));
      const tabRow = previous(lines, row);
      const nav = tabRow >= 0 ? navigation(lines[tabRow], baseline) : undefined;
      if (!nav || nav.focus !== nav.tabs.length || hints[1] !== "submit") return null;
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
  while (question > first && lines[question - 1].text.trim()) question -= 1;
  const title = lines.slice(question, headingEnd + 1).map((line) => line.text.trim()).join(" ");
  const baseline = backgroundAt(lines[question], lines[question].text.search(/\S/u));
  const tabRow = previous(lines, question);
  const nav = tabRow >= first ? navigation(lines[tabRow], baseline) : undefined;
  if (/⇆\s+tab/u.test(hints[0]) && !nav) return null;
  const active = rows.flatMap(({ row, match }, index) => {
    const background = backgroundAt(lines[row], match[1].length);
    return background !== undefined && background !== baseline ? [index] : [];
  });
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
