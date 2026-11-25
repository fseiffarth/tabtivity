/** Most text before the caret a request carries. */
const WINDOW_PREFIX = 4096;
/** The window's start moves in steps this long, so the prefix floats between
 * about 3 K and 4 K characters and nearby carets share a start. */
const WINDOW_STEP = 1024;
/** Most text after the caret a request carries. */
const WINDOW_SUFFIX = 2048;

/** Keep IPC and prompt evaluation independent of document size. The start
 * advances in whole steps and then snaps to the next line boundary, so typing
 * keeps the same window start (and a model's prompt cache) for about a
 * thousand characters instead of sliding one line at a time. A single line
 * longer than the window is cut inside it: at most 4096 characters, never
 * through a surrogate pair. The line touching the caret is never discarded. */
export function completionWindow(text: string, caret: number) {
  let start = caret <= WINDOW_PREFIX ? 0
    : Math.ceil((caret - WINDOW_PREFIX) / WINDOW_STEP) * WINDOW_STEP;
  let end = Math.min(text.length, caret + WINDOW_SUFFIX);
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

export type CompletionModel = {
  name: string; running: boolean; capabilities?: string[];
  /** The context window it is loaded with; absent on an older backend. */
  context_length?: number | null;
};

/** An empty capability list means Ollama could not report capabilities. */
export function supportsCompletion(model: { capabilities?: string[] }): boolean {
  return !model.capabilities?.length || model.capabilities.includes("completion");
}

/** Share concurrent lookups and expire even an empty result quickly. Errors are
 * never cached. The endpoint/policy key keeps settings changes isolated. */
export function modelLookupCache() {
  let cached: { key: string; until: number; value: Promise<CompletionModel[]> } | undefined;
  const lookupOnce = (key: string, lookup: () => Promise<CompletionModel[]>) => {
    if (cached?.key === key && Date.now() < cached.until) return cached.value;
    const value = lookup().catch((error) => {
      if (cached?.value === value) cached = undefined;
      throw error;
    });
    cached = { key, until: Date.now() + 5000, value };
    return value;
  };
  /** Forget the last answer, e.g. after loading a model from the editor. */
  return Object.assign(lookupOnce, { clear: () => { cached = undefined; } });
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

/** What the last change to an editor's text was. An automatic request follows
 * typing only: after a deletion, an accepted suggestion, or a change that did
 * not come from the keyboard (undo, redo, reload: "external") the editor waits
 * for the next keystroke or Ctrl+Space. */
export type EditKind = "insert" | "delete" | "accept" | "external";

/** An edit that put new text in is typing, even over a selection; one that only
 * took text out is a deletion. Pares off the common prefix and suffix. */
export function editKind(before: string, after: string): "insert" | "delete" {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return endAfter > start ? "insert" : "delete";
}

/** Whether only whitespace and closers (brackets, quotes, `$`) follow the
 * caret on its line — where an automatic suggestion can land. */
export function caretAtLineEnd(text: string, caret: number): boolean {
  const end = text.indexOf("\n", caret);
  return /^[\s)\]}>"'`$]*$/.test(text.slice(caret, end < 0 ? undefined : end));
}

/** How the ghost may paint inline — over the syntax-coloured layers instead of
 * an opaque copy of the document — and how many characters of the caret's
 * line tail it carries (shifted right, on an opaque cover that hides the
 * originals). Null keeps the opaque projection: no highlight layer (the
 * transparent ghost would leave nothing drawing the text), soft wrap (a ghost
 * could reflow the caret line while the layers beneath do not), a ghost with a
 * line break (it shifts every line below), or a tail with more than closers
 * and whitespace. A CRLF line's `\r` stays outside the tail. */
export function inlineGhostTail(draft: string, at: number, ghost: string,
  layers: { highlighted: boolean; wrapped: boolean }): number | null {
  if (!layers.highlighted || layers.wrapped || /[\r\n]/.test(ghost)) return null;
  const newline = draft.indexOf("\n", at);
  const tail = draft.slice(at, newline < 0 ? undefined : newline).replace(/\r$/, "");
  return /^[ \t)\]}>"'`$]*$/.test(tail) ? tail.length : null;
}

/** Languages where the text around the caret is natural language. They prefer
 * the `autocomplete_prose` role over the code role; whichever model serves,
 * one with `insert` completes through fill-in-the-middle, prose included. */
export function isProseLang(lang: string): boolean {
  return lang === "plain" || lang === "markdown" || lang === "tex";
}

/** Preferred model names for completing `lang`, best first. Prose falls back
 * to the code role, so settings written before the split behave as they did. */
export function completionModelOrder(lang: string, code?: string, prose?: string): string[] {
  return (isProseLang(lang) ? [prose, code] : [code]).filter((name): name is string => !!name);
}

/** For an automatic request: the role model to name when the `autocomplete`
 * roles (not the default model folded into them) name models for `lang` and
 * none of them is resident. An automatic request then asks nothing rather
 * than silently using another resident model. Undefined when it may go on. */
export function missingRoleModel(loaded: { name: string }[], lang: string, role?: string, proseRole?: string): string | undefined {
  const roles = completionModelOrder(lang, role, proseRole);
  return roles.length && !roles.some((name) => loaded.some((m) => m.name === name)) ? roles[0] : undefined;
}

/** The fill-in-the-middle model the Models hub offers for the autocomplete
 * role: small (986 MB) and its template takes Ollama's `suffix`. */
export const RECOMMENDED_AUTOCOMPLETE_MODEL = "qwen2.5-coder:1.5b";

/** What the Models hub says about the autocomplete role. `noInsert`: the role
 * holds a model Ollama positively reported without `insert` (an empty
 * capability list is unknown, never "no"). `noFim`: no role is set and no
 * installed model reports `insert`. Otherwise nothing to say. */
export function autocompleteModelAdvice(
  models: { name: string; capabilities?: string[] }[], role?: string,
): { kind: "noInsert"; model: string } | { kind: "noFim" } | null {
  if (role) {
    const caps = models.find((m) => m.name === role)?.capabilities;
    return caps?.length && !caps.includes("insert") ? { kind: "noInsert", model: role } : null;
  }
  if (!models.length || models.some((m) => m.capabilities?.includes("insert"))) return null;
  return { kind: "noFim" };
}

/** The first preferred model that is actually resident, else any resident one. */
export function pickCompletionModel<T extends { name: string }>(loaded: T[], order: string[]): T | undefined {
  for (const name of order) {
    const hit = loaded.find((m) => m.name === name);
    if (hit) return hit;
  }
  return loaded[0];
}
