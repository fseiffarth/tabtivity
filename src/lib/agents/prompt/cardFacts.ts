import type { PromptChartCard } from "./chart";
import { promptEndedAt } from "./timeline";

type FactKey =
  | "promptChart.durationMin"
  | "promptChart.durationHourMin"
  | "promptChart.filesOne"
  | "promptChart.filesMany"
  | "promptChart.sessionPrompts";
type FactT = (key: FactKey, params?: Record<string, number>) => string;

/** A turn's length for a fact line: "6 min", "1 h 12 min". Under a minute
 *  still reads "1 min" — a turn is never "0 min". */
export function formatPromptDuration(ms: number, t: FactT): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60
    ? t("promptChart.durationMin", { count: minutes })
    : t("promptChart.durationHourMin", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** How long a sent card's turn took: first prompt to last finish for a
 *  session. Null when its last row was never blamed (typed in the terminal and
 *  adopted), which is why such a card shows no duration. */
export function sentDurationMs(cards: PromptChartCard[]): number | null {
  const first = cards[0]?.at;
  const end = cards.length ? promptEndedAt(cards[cards.length - 1]) : null;
  return first && end ? Math.max(0, end.getTime() - first.getTime()) : null;
}

/** The files a sent card's turn changed, across the session's prompts. */
export function sentFileCount(cards: PromptChartCard[]): number {
  return new Set(cards.flatMap((card) => card.history?.files ?? [])).size;
}

/** A sent card's one line of fact: "6 min · 4 files · 2 prompts". Each part
 *  is left out when it is unknown or zero, so a bare card has an empty line. */
export function sentFactLine(cards: PromptChartCard[], t: FactT): string {
  const duration = sentDurationMs(cards);
  const files = sentFileCount(cards);
  return [
    duration === null ? "" : formatPromptDuration(duration, t),
    files > 0 ? t(files === 1 ? "promptChart.filesOne" : "promptChart.filesMany", { count: files }) : "",
    cards.length > 1 ? t("promptChart.sessionPrompts", { count: cards.length }) : "",
  ].filter(Boolean).join(" · ");
}
