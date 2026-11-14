import { dirname, isPathWithin, normalizePath, relativePathWithin, resolvePath } from "../../paths";

export type CompletionReference = { name: string; content: string };
// Mirror commands::ollama's byte budgets before crossing IPC too. The
// backend's 24 KB cap stays as a guard.
const PER_FILE = 6000;
const TOTAL = 24000;
/** What an automatic request carries: manual attachments plus the edited
 * file's imports, 4 KB in all. */
export const AUTO_REFERENCE_BYTES = 4000;
/** Files that exist and have text, whatever their candidates cost. */
const MAX_FILES = 16;
/** Candidate paths tried, missing ones included (`./x` names four). */
const MAX_READS = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bounded(text: string, bytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

/** The byte budget for one request's references. Automatic requests carry
 * 4 KB; an explicit one up to a quarter of the model's loaded context (about
 * three bytes a token), at most 24 KB, or the automatic budget when the model
 * list reports no context length. */
export function referenceBudget(explicit: boolean, contextLength?: number | null): number {
  if (!explicit || !contextLength || contextLength <= 0) return AUTO_REFERENCE_BYTES;
  return Math.min(TOTAL, Math.floor(contextLength * 0.25 * 3));
}

/** Cut a reference list, in order, to `budget` UTF-8 bytes of content. */
export function trimReferences(references: CompletionReference[], budget: number): CompletionReference[] {
  const result: CompletionReference[] = [];
  let remaining = budget;
  for (const reference of references) {
    if (remaining <= 0) break;
    const content = bounded(reference.content, remaining);
    if (!content) break;
    remaining -= encoder.encode(content).length;
    result.push({ name: reference.name, content });
  }
  return result;
}

/** A version id for a reference set, from its names and contents (53-bit
 * cyrb53). The completion cache keys on it instead of the text, so a rebuild
 * that reads the same bytes still hits the cache. */
export function referenceSetId(references: CompletionReference[]): string {
  if (!references.length) return "";
  const text = JSON.stringify(references.map((r) => [r.name, r.content]));
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** One editor's frozen reference reads. Automatic requests reuse them while
 * the edited file and its import list stay the same; an explicit request, or a
 * changed file or import list, reads afresh. Missing files are remembered too,
 * so a frozen set costs no IPC at all. Manual attachments are held by the
 * editor and the TeX key list is derived from the draft, so neither is read. */
export class ReferenceReads {
  private key: string | null = null;
  private files = new Map<string, string | null>();

  /** A reader for one gathering. `fresh` drops what an earlier one read. */
  reader(key: string, fresh: boolean, read: (path: string) => Promise<string>) {
    if (fresh || key !== this.key) {
      this.key = key;
      this.files = new Map();
    }
    const files = this.files;
    return async (path: string): Promise<string | null> => {
      if (files.has(path)) return files.get(path)!;
      let content: string | null;
      try { content = await read(path); } catch { content = null; }
      // A newer gathering replaced the map: don't fill it with this one's read.
      if (this.files === files) files.set(path, content);
      return content;
    };
  }
}

/** Static local references only: never resolve packages, URLs or evaluate code. */
export function completionImports(text: string, path: string, root: string): string[] {
  const paths: string[] = [];
  const add = (target: string, base = dirname(path)) => {
    const resolved = resolvePath(base, target);
    if (isPathWithin(resolved, root) && normalizePath(resolved) !== normalizePath(path)) paths.push(resolved);
  };
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g)) {
    const target = match[1];
    if (/\.[a-z\d]+$/i.test(target)) add(target);
    else for (const ext of [".ts", ".tsx", ".js", "/index.ts"]) add(target + ext);
  }
  for (const match of (/\.pyw?$/i.test(path) ? text : "").matchAll(/^\s*(?:from|import)\s+([.\w]+)/gm)) {
    const module = match[1];
    const dots = module.match(/^\.+/)?.[0].length ?? 0;
    const target = "../".repeat(Math.max(0, dots - 1)) + module.slice(dots).replace(/\./g, "/");
    add(target + ".py", dots ? dirname(path) : root);
    add(target + "/__init__.py", dots ? dirname(path) : root);
  }
  for (const match of text.matchAll(/\\(input|include|subfile|bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const bib = match[1] === "bibliography" || match[1] === "addbibresource";
    for (const name of match[2].split(",")) {
      const target = name.trim();
      if (!target || /[\\#$:]/.test(target) || target.startsWith("/")) continue;
      add(/\.[a-z\d]+$/i.test(target) ? target : target + (bib ? ".bib" : ".tex"));
    }
  }
  return [...new Set(paths)].slice(0, MAX_READS);
}

/** The references for one request, in a fixed order: manual attachments, the
 * TeX key list, imports in source order, then (explicit requests only) the
 * open tabs sorted by path. Gathered up to the scope's ceiling (4 KB
 * automatic, 24 KB explicit); the provider trims to the model's budget. */
export async function completionContext(opts: {
  path: string; root: string; draft: string; openPaths: string[];
  manual: CompletionReference[]; keys?: string;
  read: (path: string) => Promise<string>; signal: AbortSignal;
  /** Ctrl+Space and the other requests the user asked for: open tabs too, a
   * larger budget, and fresh reads. */
  explicit?: boolean;
  /** The editor's frozen reads; without one every gathering reads afresh. */
  reads?: ReferenceReads;
}): Promise<CompletionReference[]> {
  const explicit = opts.explicit === true;
  const result: CompletionReference[] = [];
  let remaining = explicit ? TOTAL : AUTO_REFERENCE_BYTES;
  const add = (name: string, text: string) => {
    if (remaining <= 0 || !text.trim()) return false;
    const content = bounded(text, Math.min(PER_FILE, remaining));
    if (!content) return false;
    remaining -= encoder.encode(content).length;
    result.push({ name: bounded(name, 256), content });
    return true;
  };
  for (const file of opts.manual) add(file.name, file.content);
  if (opts.keys) add("LaTeX label / bibliography keys", opts.keys);
  if (!opts.root || !isPathWithin(opts.path, opts.root)) return result;
  const seen = new Set([normalizePath(opts.path), ...opts.manual.map((f) => normalizePath(resolvePath(opts.root, f.name)))]);
  const imports = completionImports(opts.draft, opts.path, opts.root);
  const tabs = explicit ? [...opts.openPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : [];
  const key = JSON.stringify([normalizePath(opts.path), opts.root, imports]);
  const read = opts.reads
    ? opts.reads.reader(key, explicit, opts.read)
    : (path: string) => opts.read(path).catch(() => null);
  let files = 0;
  let reads = 0;
  for (const path of [...imports, ...tabs]) {
    if (remaining <= 0 || opts.signal.aborted || files >= MAX_FILES || reads >= MAX_READS) break;
    const normalized = normalizePath(path);
    if (seen.has(normalized) || !isPathWithin(path, opts.root)) continue;
    seen.add(normalized);
    reads++;
    // Missing, binary or out-of-scope references are optional.
    const content = await read(path);
    if (opts.signal.aborted) break;
    if (content == null) continue;
    // Bib entries may be much larger than the budget; keys are more useful.
    const body = /\.bib$/i.test(path)
      ? [...content.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]).join("\n")
      : content;
    if (add(relativePathWithin(opts.root, path) ?? path, body)) files++;
  }
  return result;
}
