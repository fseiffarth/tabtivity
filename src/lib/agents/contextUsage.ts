import type { StatusLineLike } from "../../../mobile-web/src/terminal/statusLine";

/** One row of the CLI's legend: what a share of the window holds. `free` is
 * the room left, `reserved` what the CLI keeps back (Claude's autocompact
 * buffer, Copilot's buffer); every other row is in use. */
export interface ContextCategory {
  label: string;
  tokens: string;
  percent: number;
  kind: "used" | "free" | "reserved";
}
export interface ContextItem { name: string; tokens?: string }
export interface ContextGroup { title?: string; items: ContextItem[] }
/** A listing under the legend (`MCP tools · /mcp`): its items, grouped where
 * the CLI groups them (`Loaded`, `User`, `Built-in`). */
export interface ContextSection { title: string; hint?: string; groups: ContextGroup[] }
export interface ContextUsage {
  model?: string;
  used?: string;
  total?: string;
  percent?: number;
  categories: ContextCategory[];
  /** `Label: value` lines outside the legend (`Auto-compact window: 1m tokens`). */
  notes: { label: string; value: string }[];
  sections: ContextSection[];
  raw: string;
}

/** The cells of the CLIs' grids, and the legend's swatches: Claude's ⛀ ⛁ ⛶ ⛝,
 * Copilot's ○ ◌ ● ◉ · ◎. */
const GRID = /^(?:[⛀-⛿○◌●◉◎·]\s*)+/u;
const TOTAL = /(?:^|\s)(~?[\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)\s+tokens\s+\((<?[\d.]+)%\)\s*$/u;
const CATEGORY = /^(.+?)(?::\s+|\s{2,})(~?[\d.]+[kKmM]?)(?:\s+tokens)?\s+\((<?[\d.]+)%\)$/u;
const ITEM = /^[├└│]\s*(.+?)(?::\s+(~?[\d.]+[kKmM]?)\s+tokens)?$/u;
const NOTE = /^([A-Za-z][A-Za-z0-9 ()/_-]{0,48}):\s+(.+)$/u;
const PROMPT = /^[›>❯](?:\s|$)/u;

/** A legend percentage; Copilot's `<1` is kept below one, never zero. */
function percentOf(text: string): number {
  const value = Number(text.replace(/^</u, ""));
  return text.startsWith("<") ? Math.min(value, 1) / 2 : value;
}

function kindOf(label: string): ContextCategory["kind"] {
  if (/^free\b/iu.test(label)) return "free";
  return /\bbuffer\b/iu.test(label) ? "reserved" : "used";
}

/**
 * The newest `/context` card on the screen (Claude Code's, Copilot's): its
 * total, legend and listings. Only the rows under a `Context Usage` heading
 * count, down to the input box, so prose that mentions tokens is not read.
 */
export function readContextUsage(lines: readonly StatusLineLike[]): ContextUsage | null {
  let heading = -1;
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    if (/^(?:[⎿●]\s*)?Context Usage\s*$/u.test(lines[row].text.trim())) { heading = row; break; }
  }
  if (heading < 0) return null;
  const usage: ContextUsage = { categories: [], notes: [], sections: [], raw: "" };
  const raw: string[] = [];
  const modelWords: string[] = [];
  let section: ContextSection | undefined;
  for (const line of lines.slice(heading + 1, heading + 400)) {
    const text = line.text.trim();
    if (PROMPT.test(text) || ("afterRule" in line && line.afterRule && usage.categories.length > 0)) break;
    raw.push(text);
    const words = text.replace(GRID, "").trim();
    if (!words) continue;
    const total = TOTAL.exec(words);
    if (total && usage.used === undefined) {
      usage.used = total[1];
      usage.total = total[2];
      usage.percent = percentOf(total[3]);
      // Copilot puts the model on the same line: `GitHub Copilot • GPT-5 · 19k/272k tokens (7%)`.
      const before = words.slice(0, total.index).replace(/\s*[·•]\s*$/u, "").trim();
      if (before) modelWords.push(before.split(/\s+•\s+/u).pop() ?? before);
      continue;
    }
    const item = section && ITEM.exec(words);
    if (section && item) {
      if (section.groups.length === 0) section.groups.push({ items: [] });
      section.groups[section.groups.length - 1].items.push(item[2] ? { name: item[1].trim(), tokens: item[2] } : { name: item[1].trim() });
      continue;
    }
    const category = !section && CATEGORY.exec(words);
    if (category) {
      usage.categories.push({ label: category[1].trim(), tokens: category[2], percent: percentOf(category[3]), kind: kindOf(category[1]) });
      continue;
    }
    const listing = /^(.+?)\s+·\s+(.+)$/u.exec(words);
    if (listing) {
      section = { title: listing[1].trim(), hint: listing[2].trim(), groups: [] };
      usage.sections.push(section);
      continue;
    }
    const note = NOTE.exec(words);
    if (note) {
      usage.notes.push({ label: note[1].trim(), value: note[2].trim() });
      continue;
    }
    if (section) section.groups.push({ title: words, items: [] });
    else if (usage.used === undefined) modelWords.push(words);
  }
  if (usage.used === undefined || usage.categories.length === 0) return null;
  // Claude prints the model's name, then its id; the name is enough.
  usage.model = modelWords[0];
  usage.raw = [lines[heading].text.trim(), ...raw].join("\n").trim();
  for (const entry of usage.sections) entry.groups = entry.groups.filter((group) => group.items.length > 0);
  return usage;
}
