import type { StatusLineLike } from "../../../mobile-web/src/terminal/statusLine";

export interface CodexStatusField { label: string; value: string }
export interface CodexStatusCard { heading: string; fields: CodexStatusField[]; raw: string }

/** Only the card following Codex's own /status echo counts. Its startup
 * banner and prose mentioning a model or a percentage are not status data. */
export function readCodexStatus(lines: readonly StatusLineLike[]): CodexStatusCard | null {
  let command = -1;
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    if (/^(?:[›>❯]\s*)?\/status\s*$/u.test(lines[row].text.trim())) { command = row; break; }
  }
  if (command < 0) return null;
  const headingRow = lines.findIndex((line, row) => row > command && row <= command + 5 && /^(?:>_\s*)?OpenAI Codex\b/u.test(line.text.trim()));
  if (headingRow < 0) return null;
  const fields: CodexStatusField[] = [];
  const raw = [lines[headingRow].text.trim()];
  for (const line of lines.slice(headingRow + 1, headingRow + 100)) {
    const text = line.text.trim();
    if (/^[›>❯](?:\s|$)/u.test(text) || ("afterRule" in line && line.afterRule && fields.length > 0)) break;
    raw.push(text);
    const field = /^([A-Za-z0-9][A-Za-z0-9 ()/_-]{0,48}):\s*(.*)$/u.exec(text);
    if (field) fields.push({ label: field[1].trim(), value: field[2].trim() });
    else if (text && fields.length > 0) fields[fields.length - 1].value += ` ${text}`;
  }
  if (!fields.some((field) => field.label === "Model") || !fields.some((field) => field.label === "Directory")) return null;
  return { heading: raw[0], fields, raw: raw.join("\n").trim() };
}

/** Codex prints remaining percentages, unlike the rollout's percent used.
 * Keep unknown or malformed figures absent, including out-of-range ones. */
export function codexRemaining(value: string | undefined): number | undefined {
  const match = value && /(?:^|\s)(\d{1,3}(?:\.\d+)?)%\s+left\b/u.exec(value);
  if (!match) return undefined;
  const percent = Number(match[1]);
  return percent <= 100 ? percent : undefined;
}

export function codexReset(value: string): string | undefined {
  return /\(resets\s+(.+)\)\s*$/u.exec(value)?.[1];
}
