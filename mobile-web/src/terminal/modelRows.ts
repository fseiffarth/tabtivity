import type { SelectStep } from "./selectPrompt";

/** One row a CLI's own model picker drew, as remembered for its installed
 * build (`services::model_rows`): what a model sheet lists while the session
 * is still drawing its picker. */
export interface ModelRow {
  label: string;
  description?: string;
  number?: number;
}

/** A picker's rows and the heading it drew above them. */
export interface ModelRows {
  title?: string;
  rows: ModelRow[];
}

/** The marks a picker draws on the session's current model (`Opus ✔`): the
 * remembered rows are compared without them, since the current model moves. */
function plainLabel(label: string): string {
  return label.replace(/\s*[✔✓]\s*$/u, "").trim();
}

/** What to remember off a live model step, current-model marks dropped. */
export function modelRowsOf(step: SelectStep): ModelRows {
  return {
    ...(step.title ? { title: step.title } : {}),
    rows: step.options.map((option) => ({
      label: plainLabel(option.label),
      ...(option.description ? { description: option.description } : {}),
      number: option.number,
    })),
  };
}

/** Whether `a` and `b` would be remembered alike. */
export function sameModelRows(a: SelectStep, b: SelectStep): boolean {
  const [x, y] = [modelRowsOf(a), modelRowsOf(b)];
  return x.title === y.title && x.rows.length === y.rows.length && x.rows.every((row, at) => row.label === y.rows[at].label
    && row.description === y.rows[at].description && row.number === y.rows[at].number);
}

/** The remembered rows as a step a sheet lists, numbered as the picker
 * printed them; null for anything else the bridge or the store answered. */
export function modelRowsStep(remembered: ModelRows | null | undefined): SelectStep | null {
  const rows = remembered && Array.isArray(remembered.rows) ? remembered.rows.filter((row) => typeof row?.label === "string") : [];
  if (rows.length === 0) return null;
  return {
    ...(typeof remembered?.title === "string" ? { title: remembered.title } : {}),
    options: rows.map((row, index) => ({
      index,
      number: row.number ?? index + 1,
      label: row.label,
      ...(row.description ? { description: row.description } : {}),
    })),
  };
}

/** The row of the live `step` a tap on remembered `row` answers: the one with
 * the same label. None when the live picker does not draw it — a row it
 * dropped, or one outside a windowed picker's slice — and the tap is then
 * left to the user to make again in the live list. */
export function liveModelPick(step: SelectStep, row: Pick<ModelRow, "label">): number | null {
  const wanted = plainLabel(row.label);
  return step.options.find((option) => plainLabel(option.label) === wanted)?.index ?? null;
}
