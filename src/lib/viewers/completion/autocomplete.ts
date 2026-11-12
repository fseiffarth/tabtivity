/** Keep IPC and prompt evaluation independent of document size. Cut at a line
 * boundary where possible, but never discard the line touching the caret. */
export function completionWindow(text: string, caret: number) {
  let start = Math.max(0, caret - 4096);
  let end = Math.min(text.length, caret + 1024);
  if (start > 0) {
    const newline = text.indexOf("\n", start);
    if (newline >= 0 && newline < caret) start = newline + 1;
    // Do not split a UTF-16 surrogate pair on an unusually long line.
    else if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  }
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline >= caret) end = newline + 1;
    else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  }
  return { prefix: text.slice(start, caret), suffix: text.slice(caret, end) };
}

export type CompletionGhost = {
  text: string;
  at: number;
  candidate?: import("./completionProvider").CompletionCandidate;
};

export type CompletionModel = { name: string; running: boolean; capabilities?: string[] };

/** Share concurrent lookups and expire even an empty result quickly. Errors are
 * never cached. The endpoint/policy key keeps settings changes isolated. */
export function modelLookupCache() {
  let cached: { key: string; until: number; value: Promise<CompletionModel[]> } | undefined;
  return (key: string, lookup: () => Promise<CompletionModel[]>) => {
    if (cached?.key === key && Date.now() < cached.until) return cached.value;
    const value = lookup().catch((error) => {
      if (cached?.value === value) cached = undefined;
      throw error;
    });
    cached = { key, until: Date.now() + 5000, value };
    return value;
  };
}

export const completionModels = modelLookupCache();

/** Per-editor, memory-only LRU. Keys contain bounded prefix/suffix, model, mode,
 * endpoint and reference contents; revisiting a caret cannot cross contexts. */
export class CompletionCache {
  private entries = new Map<string, { text: string; until: number }>();
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.until <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.text;
  }
  set(key: string, text: string) {
    this.entries.delete(key);
    this.entries.set(key, { text, until: Date.now() + 60_000 });
    if (this.entries.size > 24) this.entries.delete(this.entries.keys().next().value!);
  }
}

export function completionLineLength(text: string): number {
  // A leading newline belongs to the line being accepted, not an empty step.
  const start = text.startsWith("\r\n") ? 2 : text.startsWith("\n") ? 1 : 0;
  const end = text.indexOf("\n", start);
  return end < 0 ? text.length : end + 1;
}

/** Only a pure insertion at the ghost's caret may consume it. Replacements,
 * deletion, paste elsewhere and edits to the suffix invalidate it. */
export function typeThrough(before: string, after: string, ghost: CompletionGhost | null): CompletionGhost | null {
  if (!ghost) return null;
  const count = after.length - before.length;
  if (count <= 0 || after.slice(0, ghost.at) !== before.slice(0, ghost.at) ||
      after.slice(ghost.at + count) !== before.slice(ghost.at)) return null;
  const typed = after.slice(ghost.at, ghost.at + count);
  if (!ghost.text.startsWith(typed)) return null;
  const text = ghost.text.slice(count);
  return text ? { ...ghost, text, at: ghost.at + count } : null;
}

/** Whether only whitespace and closers (brackets, quotes, `$`) follow the
 * caret on its line — where an automatic suggestion can land. */
export function caretAtLineEnd(text: string, caret: number): boolean {
  const end = text.indexOf("\n", caret);
  return /^[\s)\]}>"'`$]*$/.test(text.slice(caret, end < 0 ? undefined : end));
}

/** Languages where the text around the caret is natural language. They prefer
 * the `autocomplete_prose` role (an instruct model on the chat path) over the
 * code role (typically a fill-in-the-middle coder model). */
export function isProseLang(lang: string): boolean {
  return lang === "plain" || lang === "markdown" || lang === "tex";
}

/** Preferred model names for completing `lang`, best first. Prose falls back
 * to the code role, so settings written before the split behave as they did. */
export function completionModelOrder(lang: string, code?: string, prose?: string): string[] {
  return (isProseLang(lang) ? [prose, code] : [code]).filter((name): name is string => !!name);
}

/** The first preferred model that is actually resident, else any resident one. */
export function pickCompletionModel<T extends { name: string }>(loaded: T[], order: string[]): T | undefined {
  for (const name of order) {
    const hit = loaded.find((m) => m.name === name);
    if (hit) return hit;
  }
  return loaded[0];
}
