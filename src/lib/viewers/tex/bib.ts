/**
 * The BibTeX/BibLaTeX (`.bib`) model + its edit ops, all pure.
 *
 * Two ideas carry it, both borrowed deliberately:
 *
 *  1. **The cards are a view on the text.** Every op here is a surgical splice
 *     addressed by source offsets — never a re-serialization of the parsed
 *     records. That is the only way a `.bib` file's own conventions survive an
 *     edit: the `%`/`@comment` notes, the field order somebody sorted by hand,
 *     the brace-protected `{DNA}` capitalization, the `"…"`-quoted values of an
 *     older file, the indentation, the trailing-comma style. It is the same
 *     bargain `yaml.ts` strikes for comments and `table.ts` for quoting, and it
 *     is what lets Cards and Source be two views on one draft (so a card edit is
 *     an ordinary dirty/undoable/saveable change).
 *
 *  2. **The parse is tolerant, and says what it could not handle.** A `.bib` is
 *     usually machine-written by a reference manager, but it is edited by hand,
 *     and half the files in the wild hold something the grammar does not
 *     strictly allow. So the parser never throws and never refuses a file: it
 *     brace-matches each `@type{…}` record, records the spans, and marks a field
 *     it cannot safely *rewrite* (a `#` concatenation, a bare `@string` macro
 *     reference) as `editable: false` — shown, not offered. `stray` reports the
 *     bytes that belong to no record, so the card view can admit that the file
 *     holds something it is not showing rather than silently dropping it.
 *
 * Deliberately NOT a full BibTeX implementation: no `@string` expansion, no
 * name/month normalization, no crossref resolution. Those are the bibliography
 * *processor's* job, and guessing at them here would make the cards disagree
 * with what LaTeX actually renders.
 */

/** The delimiter a field's value literal is written with. */
export type BibDelim = "brace" | "quote" | "bare";

/** One `name = {value}` assignment inside a record. */
export interface BibField {
  /** Field name as written (`Title`), for display and for the rename splice. */
  name: string;
  /** Lowercased name — what a lookup keys on (BibTeX is case-insensitive here). */
  key: string;
  /** The literal's INNER text, verbatim: `{The {ACM} way}` → `The {ACM} way`.
   *  Verbatim rather than cleaned, because this is what an edit round-trips —
   *  the brace-protected capitalization is content, not noise. Use
   *  {@link bibPlainValue} for the compact display/search form. */
  value: string;
  /** The whole literal as written, delimiters included. */
  raw: string;
  /** The whole value EXPRESSION as written — the literal plus anything
   *  concatenated onto it (`jan # "~1"`). Equal to `raw` for an ordinary field,
   *  and what a locked (non-editable) field displays, so a value the cards
   *  refuse to rewrite is still shown in full. */
  rawExpr: string;
  /** How the literal is delimited — an edit keeps it unless it must promote. */
  delim: BibDelim;
  /** Span of the literal (`raw`) in the file. */
  valueStart: number;
  valueEnd: number;
  /** Span of the field name in the file (for a rename). */
  nameStart: number;
  nameEnd: number;
  /** Span of the whole assignment, from the name to just past its separating
   *  comma when it has one — what a delete removes. */
  start: number;
  end: number;
  /**
   * False when the value cannot be rewritten without risking the file's meaning:
   * a `#` concatenation (`month = jan # "~1"`) or a bare macro reference
   * (`month = jan`), both of which mean something only to the bibliography
   * processor. Such a field renders read-only rather than as an input that would
   * quietly turn a macro into a string.
   */
  editable: boolean;
}

/** What kind of `@…` record this is. Only `entry` has a citation key. */
export type BibRecordKind = "entry" | "string" | "preamble" | "comment";

/** One `@type{…}` record. */
export interface BibRecord {
  /**
   * Id for React keys and per-tab fold state: the citation key when there is one
   * (`entry:smith2020`), else the record's ordinal. Keyed by the citation key
   * rather than by position so a fold survives entries being added above it; an
   * id that no longer resolves after an edit is simply inert, like the YAML
   * tree's. It is **unique by construction** — a second record claiming the same
   * key (which {@link duplicateBibKeys} reports as the error it is) gets its
   * ordinal appended, because two cards sharing a React key is a rendering bug on
   * top of a bibliography one.
   */
  id: string;
  kind: BibRecordKind;
  /** Entry type, lowercased (`article`, `inproceedings`). */
  type: string;
  /** Entry type as written, for the rename splice's span. */
  typeRaw: string;
  /** Citation key (`smith2020`); `""` for `@string`/`@preamble`/`@comment`. */
  key: string;
  fields: BibField[];
  /** Span of the whole record, from `@` through its closing brace. */
  start: number;
  end: number;
  /** Span of the type token (just past `@`). */
  typeStart: number;
  typeEnd: number;
  /** Span of the citation key; both `0` when there is none. */
  keyStart: number;
  keyEnd: number;
  /** 1-based line the record starts on — for a jump into Source. */
  line: number;
  /** The record's raw text. Non-`entry` kinds are rendered from this. */
  raw: string;
}

export interface BibDoc {
  records: BibRecord[];
  /** Non-blank text belonging to no record, as a line count — comments (`%`),
   *  notes, or a truncated record. Reported so the card view can say the file
   *  holds something it does not show; never edited from the cards. */
  strayLines: number;
}

/** Lowercase extension of `path` including the dot, or `""`. */
function extOf(path: string): string {
  const name = (path.split(/[/\\]/).filter(Boolean).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** Every path the bibliography card view renders. `.bibtex` is accepted as the
 *  spelled-out variant some exporters emit. */
export function isBibPath(path: string): boolean {
  const ext = extOf(path);
  return ext === ".bib" || ext === ".bibtex";
}

/** Record kinds that are not bibliography entries (no citation key, no fields
 *  the cards edit). */
const NON_ENTRY: Record<string, BibRecordKind> = {
  string: "string",
  preamble: "preamble",
  comment: "comment",
};

/** 1-based line number of `offset` in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Index of the brace matching the one at `open`, or `text.length` when the
 * record is unterminated (a truncated file still parses — the record simply runs
 * to the end). A backslash-escaped brace (`\{`, LaTeX's literal brace) does not
 * count; quotes deliberately do NOT protect a brace, because BibTeX's own brace
 * matching runs through quoted values too.
 */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Read a value literal starting at `i` (already past `=` and whitespace).
 *  Returns the literal's span, its inner text and its delimiter. */
function readLiteral(
  text: string,
  i: number,
  bodyEnd: number,
): { start: number; end: number; inner: string; delim: BibDelim } {
  const start = i;
  const c = text[i];
  if (c === "{") {
    const close = matchBrace(text, i);
    const end = Math.min(close + 1, bodyEnd + 1);
    return { start, end, inner: text.slice(start + 1, end - 1), delim: "brace" };
  }
  if (c === '"') {
    // Brace-aware, so a `"{"` inside the value does not end it early.
    let depth = 0;
    for (let j = i + 1; j < bodyEnd; j++) {
      const ch = text[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"' && depth === 0) {
        return { start, end: j + 1, inner: text.slice(start + 1, j), delim: "quote" };
      }
    }
    return { start, end: bodyEnd, inner: text.slice(start + 1, bodyEnd), delim: "quote" };
  }
  // Bare: a number or a macro name, ending at the field's comma, a `#`
  // concatenation, or the body's end.
  let j = i;
  for (; j < bodyEnd; j++) {
    const ch = text[j];
    if (ch === "," || ch === "#") break;
  }
  const raw = text.slice(start, j).trimEnd();
  return { start, end: start + raw.length, inner: raw, delim: "bare" };
}

/** Parse the fields of a record body (the text between its outer braces). */
function parseFields(text: string, bodyStart: number, bodyEnd: number): BibField[] {
  const out: BibField[] = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    // Skip separators/whitespace to the next field name.
    while (i < bodyEnd && /[\s,]/.test(text[i])) i++;
    if (i >= bodyEnd) break;
    const nameStart = i;
    while (i < bodyEnd && /[^\s=,]/.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    const nameEnd = i;
    if (!name) break;
    while (i < bodyEnd && /\s/.test(text[i])) i++;
    if (text[i] !== "=") {
      // Not an assignment (a stray token). Resume after the next comma so one
      // malformed line can't swallow the rest of the record.
      const comma = text.indexOf(",", i);
      i = comma === -1 || comma >= bodyEnd ? bodyEnd : comma + 1;
      continue;
    }
    i++; // past '='
    while (i < bodyEnd && /\s/.test(text[i])) i++;
    const lit = readLiteral(text, i, bodyEnd);
    i = lit.end;
    // A `#` after the literal means the value is a CONCATENATION: it holds more
    // than this one literal (`month = jan # "~1"`), so rewriting the literal
    // alone would change what the entry means. Shown, not offered.
    let j = i;
    while (j < bodyEnd && /\s/.test(text[j])) j++;
    const concatenated = text[j] === "#";
    // The value expression runs to the separating comma (or the body's end); the
    // field's own span takes that comma too, so a delete removes it.
    let k = i;
    while (k < bodyEnd && text[k] !== ",") k++;
    const exprEnd = k;
    const end = k < bodyEnd ? k + 1 : i;
    i = k < bodyEnd ? k + 1 : bodyEnd;
    out.push({
      name,
      key: name.toLowerCase(),
      value: lit.inner,
      raw: text.slice(lit.start, lit.end),
      rawExpr: text.slice(lit.start, exprEnd).trimEnd(),
      delim: lit.delim,
      valueStart: lit.start,
      valueEnd: lit.end,
      nameStart,
      nameEnd,
      start: nameStart,
      end,
      // A bare literal is a macro name unless it is a plain number, and a macro
      // is the processor's to resolve — turning `jan` into `{jan}` would change
      // the rendered bibliography.
      editable: !concatenated && (lit.delim !== "bare" || isNumeric(lit.inner)),
    });
  }
  return out;
}

/** A bare literal is safe to rewrite only when it is a plain number — anything
 *  else is a macro name the processor resolves. */
function isNumeric(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

/**
 * Parse a `.bib` file into its records. Tolerant by construction: it scans for
 * `@type{`, brace-matches the record, and resumes past it (so an `@` inside a
 * field value is never mistaken for a new record). Text between records is
 * counted as `strayLines`, never dropped silently.
 */
export function parseBib(text: string): BibDoc {
  const records: BibRecord[] = [];
  const ids = new Set<string>();
  let strayChars = "";
  let cursor = 0;
  const re = /@[ \t]*([A-Za-z]+)[ \t\r\n]*[{(]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const openIdx = m.index + m[0].length - 1;
    // `@type(...)` is legal BibTeX; normalize it by only brace-matching the
    // `{` form and treating a `(` record as opaque (rare enough that editing it
    // is better refused than guessed at).
    const paren = text[openIdx] === "(";
    const close = paren ? text.indexOf(")", openIdx) : matchBrace(text, openIdx);
    const end = close === -1 ? text.length : close;
    strayChars += text.slice(cursor, m.index);
    const typeRaw = m[1];
    const type = typeRaw.toLowerCase();
    const kind = NON_ENTRY[type] ?? "entry";
    const bodyStart = openIdx + 1;
    const raw = text.slice(m.index, Math.min(end + 1, text.length));
    let key = "";
    let keyStart = 0;
    let keyEnd = 0;
    let fields: BibField[] = [];
    if (kind === "entry" && !paren) {
      // `@type{ key , field = …`: the key runs to the first comma (or, for a
      // key-only entry, to the record's end).
      let i = bodyStart;
      while (i < end && /\s/.test(text[i])) i++;
      keyStart = i;
      while (i < end && !/[\s,}]/.test(text[i])) i++;
      keyEnd = i;
      key = text.slice(keyStart, keyEnd);
      const comma = text.indexOf(",", keyEnd);
      if (comma !== -1 && comma < end) fields = parseFields(text, comma + 1, end);
    } else if (kind === "string" && !paren) {
      fields = parseFields(text, bodyStart, end);
    }
    const base = kind === "entry" && key ? `entry:${key}` : `${kind}:${records.length}`;
    const id = ids.has(base) ? `${base}@${records.length}` : base;
    ids.add(id);
    records.push({
      id,
      kind,
      type,
      typeRaw,
      key,
      fields,
      start: m.index,
      end: Math.min(end + 1, text.length),
      typeStart: m.index + m[0].indexOf(typeRaw),
      typeEnd: m.index + m[0].indexOf(typeRaw) + typeRaw.length,
      keyStart,
      keyEnd,
      line: lineAt(text, m.index),
      raw,
    });
    cursor = Math.min(end + 1, text.length);
    re.lastIndex = cursor; // resume past the record, so an `@` in a value is inert
  }
  strayChars += text.slice(cursor);
  const strayLines = strayChars
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
  return { records, strayLines };
}

/** The compact, human-readable form of a value: brace protection removed and
 *  whitespace collapsed. For display columns, tooltips and the filter box —
 *  never for an edit, which round-trips {@link BibField.value} verbatim. */
export function bibPlainValue(value: string): string {
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** Citation keys that appear more than once, lowercased. A duplicate key is
 *  silently wrong — the bibliography processor keeps one entry and drops the
 *  other — so the cards mark it rather than leaving it to be found in a build
 *  log. */
export function duplicateBibKeys(doc: BibDoc): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of doc.records) {
    if (r.kind !== "entry" || !r.key) continue;
    const k = r.key.toLowerCase();
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return dupes;
}

/** Records matching `query` (case-insensitive) in their key, type or any field
 *  value — a `.bib` is routinely thousands of entries long, so the card list is
 *  only usable with a filter over the whole record, not just its title. */
export function filterBibRecords(records: BibRecord[], query: string): BibRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) => {
    if (r.key.toLowerCase().includes(q) || r.type.includes(q)) return true;
    return r.fields.some(
      (f) => f.key.includes(q) || bibPlainValue(f.value).toLowerCase().includes(q),
    );
  });
}

// ── Reading the list: venue and order ───────────────────────────────────────
// A working bibliography is read as a *list* — "what did this group publish at
// NeurIPS", "what is the oldest thing I cite" — and the file's own order answers
// neither. All of this is display-only by construction: the ops below splice the
// text, these only choose which records the view shows and in what order, so the
// file's hand-sorted order is never rewritten by looking at it differently.

/** Plain value of the first of `keys` the record actually carries, `""` for
 *  none — the compact form ({@link bibPlainValue}), i.e. for reading, never for
 *  an edit. */
export function bibFieldValue(rec: BibRecord, ...keys: string[]): string {
  for (const k of keys) {
    const f = rec.fields.find((x) => x.key === k);
    const v = f ? bibPlainValue(f.value) : "";
    if (v) return v;
  }
  return "";
}

/**
 * The first author's family name, for sorting — `""` when the record names
 * nobody. Deliberately a *reading* of the name, not BibTeX's own name grammar:
 * the comma form (`Smith, Jane`) is taken at its word, and otherwise the last
 * whitespace-separated token is the family name (`Jane Smith` → `Smith`). That
 * loses the von-particle rule BibTeX sorts by (`Ludwig van Beethoven` files
 * under `Beethoven` here, not `van Beethoven`) — an ordering that is off by one
 * shelf for a handful of names, which is worth far less than a name parser that
 * has to agree with the bibliography processor to be right at all. `editor`
 * stands in where there is no `author`, exactly as the byline does.
 */
export function bibFirstAuthor(rec: BibRecord): string {
  const list = bibFieldValue(rec, "author", "editor");
  if (!list) return "";
  const first = list.split(/\s+and\s+/i)[0].trim();
  const comma = first.indexOf(",");
  if (comma !== -1) return first.slice(0, comma).trim();
  const parts = first.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : first;
}

/** The record's year as a number, or `null` when it names none. The first
 *  four-digit run of `year`/`date`, so a BibLaTeX `date = {2020-05-01}` and a
 *  hand-written `year = {2020, in press}` both read as 2020. */
export function bibYear(rec: BibRecord): number | null {
  const m = /\d{4}/.exec(bibFieldValue(rec, "year", "date"));
  return m ? Number(m[0]) : null;
}

/** The file's `@string` table, macro name (lowercased) → its text. The one place
 *  this module resolves a macro at all, and it is deliberately for *reading*
 *  only: an edit still never rewrites `journal = jml` into a string (see
 *  {@link BibField.editable}), because what the bibliography renders is the
 *  processor's business. Grouping by venue is the opposite case — `jml` is not a
 *  journal's name, it is a reference to one, and a picker offering it would file
 *  half a library under a word that appears nowhere in the printed bibliography. */
export function bibMacros(doc: BibDoc): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of doc.records) {
    if (r.kind !== "string") continue;
    for (const f of r.fields) out.set(f.key, bibPlainValue(f.value));
  }
  return out;
}

/** Where a record was published: the conference for a talk (`booktitle`, or
 *  BibLaTeX's `eventtitle`), the journal for a paper. `""` for a book, a thesis
 *  or anything else that has no venue — which is why picking a venue narrows the
 *  list to entries that *have* that one, rather than pretending the rest belong
 *  somewhere. A macro-valued venue resolves through `macros` when one is given
 *  ({@link bibMacros}), and otherwise reads as the macro name, which at least
 *  still groups the entries that share it. */
export function bibVenue(rec: BibRecord, macros?: Map<string, string>): string {
  for (const k of ["booktitle", "journal", "journaltitle", "eventtitle"]) {
    const f = rec.fields.find((x) => x.key === k);
    if (!f) continue;
    const plain = bibPlainValue(f.value);
    if (!plain) continue;
    // A bare literal the cards refuse to rewrite is a macro reference, never a
    // title — every other value is its own text.
    if (f.delim === "bare" && !f.editable) return macros?.get(plain.toLowerCase()) || plain;
    return plain;
  }
  return "";
}

/** Every venue in the file, once each, alphabetically — what the venue picker
 *  offers. Deduped case-insensitively, keeping the file's own spelling; nothing
 *  is normalized beyond that, because "Proc. NeurIPS" and "NeurIPS" are the same
 *  conference only to a reader, and folding them would hide from the picker that
 *  the file spells one venue two ways. */
export function bibVenues(records: BibRecord[], macros?: Map<string, string>): string[] {
  const seen = new Map<string, string>();
  for (const r of records) {
    const v = bibVenue(r, macros);
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Records published at `venue` (case-insensitive, exact). An empty `venue` is
 *  "all venues" and returns the list untouched. */
export function filterBibVenue(
  records: BibRecord[],
  venue: string,
  macros?: Map<string, string>,
): BibRecord[] {
  const v = venue.trim().toLowerCase();
  if (!v) return records;
  return records.filter((r) => bibVenue(r, macros).toLowerCase() === v);
}

/** How the card list is ordered. `file` is the file's own order — the default,
 *  because a hand-sorted `.bib` is sorted the way its owner wanted. */
export type BibSortKey = "file" | "author" | "year";

/**
 * The records in reading order. Three rules, and the first is the one that makes
 * the control usable on a real library:
 *
 *  - **A record the sort cannot key is last**, in both directions — an entry with
 *    no author does not become the top of the list because the order was
 *    reversed, and `@string`/`@preamble` records (which have neither key) stay
 *    out of the way instead of heading the list.
 *  - **The file's own order breaks every tie**, so two 2020 papers keep the
 *    order their author put them in rather than an arbitrary one.
 *  - **Nothing is mutated**: the input array is never sorted in place, because it
 *    is the parse's own `records` and the edit ops address the file by the
 *    offsets in it.
 */
export function sortBibRecords(
  records: BibRecord[],
  key: BibSortKey,
  desc = false,
): BibRecord[] {
  if (key === "file") return desc ? records.slice().reverse() : records;
  // Decorated once rather than keyed inside the comparator: an n·log n sort of a
  // few thousand records would otherwise re-read (and re-clean) every name.
  const keyed = records.map((rec, index) => ({
    rec,
    index,
    author: key === "author" ? bibFirstAuthor(rec).toLowerCase() : "",
    year: key === "year" ? bibYear(rec) : null,
  }));
  const missing = (k: (typeof keyed)[number]) => (key === "year" ? k.year === null : !k.author);
  keyed.sort((a, b) => {
    const ma = missing(a);
    const mb = missing(b);
    if (ma || mb) return ma && mb ? a.index - b.index : ma ? 1 : -1;
    const cmp = key === "year" ? a.year! - b.year! : a.author.localeCompare(b.author);
    if (cmp !== 0) return desc ? -cmp : cmp;
    return a.index - b.index;
  });
  return keyed.map((k) => k.rec);
}

// ── Edit ops ────────────────────────────────────────────────────────────────
// Each one returns the whole file text with exactly one span replaced. They take
// the record/field they were rendered from, so a caller never computes offsets —
// and because every op re-parses from the returned text on the next render, a
// stale span can never be spliced twice.

/** Replace `[start, end)` of `text`. */
function splice(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

/** The literal to write for `value`, keeping `delim` when it still can hold the
 *  value and promoting to braces when it cannot. */
export function bibLiteral(value: string, delim: BibDelim): string {
  if (delim === "bare" && isNumeric(value)) return value.trim();
  if (delim === "quote" && !value.includes('"') && braceBalanced(value)) {
    return `"${value}"`;
  }
  // Braces are the safe general form. An unbalanced brace in the value would
  // break the record, so it is escaped to its LaTeX form rather than written raw.
  return `{${braceBalanced(value) ? value : value.replace(/[{}]/g, (c) => (c === "{" ? "\\{" : "\\}"))}}`;
}

/** Whether `{`/`}` in `value` nest properly — an unbalanced brace would end the
 *  record early, so a value carrying one is escaped instead of written through. */
function braceBalanced(value: string): boolean {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

/** Set a field's value, keeping the file's delimiter style where it can hold the
 *  new text (see {@link bibLiteral}). */
export function setBibFieldValue(text: string, field: BibField, value: string): string {
  return splice(text, field.valueStart, field.valueEnd, bibLiteral(value, field.delim));
}

/** Rename a field. A name with whitespace, `=`, `,` or braces in it would not
 *  parse back, so it is sanitized down to what BibTeX accepts; an empty result
 *  leaves the text untouched (nothing to rename it to). */
export function setBibFieldName(text: string, field: BibField, name: string): string {
  const clean = sanitizeToken(name);
  if (!clean || clean === field.name) return text;
  return splice(text, field.nameStart, field.nameEnd, clean);
}

/** Set a record's citation key. Sanitized the same way, and refused when empty —
 *  an entry with no key cannot be cited at all. */
export function setBibKey(text: string, rec: BibRecord, key: string): string {
  const clean = sanitizeToken(key);
  if (!clean || !rec.keyEnd || clean === rec.key) return text;
  return splice(text, rec.keyStart, rec.keyEnd, clean);
}

/** Set a record's entry type (`article` → `inproceedings`). */
export function setBibType(text: string, rec: BibRecord, type: string): string {
  const clean = sanitizeToken(type).replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!clean || clean === rec.type) return text;
  return splice(text, rec.typeStart, rec.typeEnd, clean);
}

/** Strip what a BibTeX name/key may not contain. Deliberately conservative:
 *  everything a `.bib` grammar treats as a delimiter goes. */
function sanitizeToken(value: string): string {
  return value.replace(/[\s{}(),="#%\\]/g, "").trim();
}

/** Delete a field, taking its separating comma and the blank it leaves behind. */
export function deleteBibField(text: string, field: BibField): string {
  let start = field.start;
  let end = field.end;
  // Absorb the indentation in front of the field and, when the field has its
  // line to itself, the line ending behind it — its *own* ending, so a CRLF file
  // loses a whole `\r\n` rather than the previous line's `\n` (which left a
  // bare `\r` behind).
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  if ((start === 0 || text[start - 1] === "\n") && endsLine(text, end)) {
    if (text[end] === "\r") end++;
    if (text[end] === "\n") end++;
  }
  return splice(text, start, end, "");
}

/** The line ending `text` uses: CRLF when any line ends that way, else LF. */
function lineEndingOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** True when only whitespace separates `at` from the end of its line. */
function endsLine(text: string, at: number): boolean {
  for (let i = at; i < text.length; i++) {
    if (text[i] === "\n") return true;
    if (!/\s/.test(text[i])) return false;
  }
  return true;
}

/**
 * Add an empty field to a record, written in the style the record already uses:
 * the indentation of its last field (or two spaces), and braces for the value.
 * Inserted just before the record's closing brace so the field order the file
 * already has is untouched.
 */
export function addBibField(text: string, rec: BibRecord, name: string): string {
  const clean = sanitizeToken(name);
  if (!clean) return text;
  const last = rec.fields[rec.fields.length - 1];
  const indent = last ? indentOfLine(text, last.start) : "  ";
  const closing = rec.end - 1; // the record's `}`
  // A comma has to separate the new field from whatever precedes it: the last
  // field when it has no trailing comma, or the citation key in a record that
  // has no fields at all (`@misc{key}`).
  const needsComma = last
    ? text[last.end - 1] !== ","
    : !text.slice(rec.keyEnd, closing).includes(",");
  const head = text.slice(0, closing).replace(/\s*$/, "");
  const nl = lineEndingOf(text);
  const insert = `${needsComma ? "," : ""}${nl}${indent}${clean} = {},${nl}`;
  return head + insert + text.slice(closing);
}

/** The leading whitespace of the line `offset` sits on. */
function indentOfLine(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(start, offset));
  return m ? m[0] : "";
}

/**
 * Delete a whole record, plus the blank line it leaves behind. Entries in a
 * `.bib` are separated by blank lines, so taking only the record's own bytes
 * would leave a growing gap wherever one was removed — hence the record's
 * trailing newline goes with it, and one following run of blank lines (never
 * more, so a deliberate section break between two groups of entries survives).
 */
export function deleteBibRecord(text: string, rec: BibRecord): string {
  let start = rec.start;
  let end = rec.end;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
  // Trailing whitespace on the record's own last line, then that line's newline.
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  if (text[end] === "\r") end++;
  if (text[end] === "\n") {
    end++;
    // …then the run of blank lines behind it.
    for (;;) {
      const nl = text.indexOf("\n", end);
      if (nl === -1) break;
      if (text.slice(end, nl).trim() !== "") break;
      end = nl + 1;
    }
  }
  return splice(text, start, end, "");
}

/** Standard BibTeX/BibLaTeX field names, offered as completions on the
 *  add-a-field box. A suggestion list, never a restriction: a `.bib` may carry
 *  any field name, and a reference manager's own (`abstract`, `keywords`,
 *  `file`) are as real as the canonical ones. */
export const BIB_FIELD_NAMES = [
  "author", "title", "journal", "booktitle", "year", "month", "volume",
  "number", "pages", "publisher", "editor", "series", "edition", "address",
  "institution", "organization", "school", "chapter", "howpublished", "note",
  "doi", "url", "urldate", "isbn", "issn", "eprint", "eprinttype", "archiveprefix",
  "primaryclass", "abstract", "keywords", "language", "file", "annote",
] as const;

/** Entry types offered on a card's type control — the common BibTeX set plus the
 *  BibLaTeX additions people actually use. Free text either way (a type Tabtivity
 *  doesn't list is still valid). */
export const BIB_ENTRY_TYPES = [
  "article", "book", "booklet", "inbook", "incollection", "inproceedings",
  "conference", "manual", "mastersthesis", "phdthesis", "misc", "proceedings",
  "techreport", "unpublished", "online", "software", "dataset", "thesis",
  "report", "patent",
] as const;

/**
 * A fresh `@misc` entry appended to the file, with a key that no record in
 * `doc` already uses. Keys are minted by scanning for a free suffix rather than
 * counting records — deleting the last entry and adding another would otherwise
 * hand the new one the dead entry's key, and two identically-keyed entries is
 * exactly the failure {@link duplicateBibKeys} exists to report.
 */
export function addBibEntry(
  text: string,
  doc: BibDoc,
  type = "misc",
): { text: string; key: string } {
  const taken = new Set(doc.records.map((r) => r.key.toLowerCase()).filter(Boolean));
  let key = "entry";
  for (let n = 1; taken.has(key.toLowerCase()); n++) key = `entry${n}`;
  const nl = lineEndingOf(text);
  const sep = text.length === 0 || text.endsWith(nl + nl) ? "" : text.endsWith(nl) ? nl : nl + nl;
  const entry = `@${type}{${key},${nl}  title = {},${nl}  author = {},${nl}  year = {},${nl}}${nl}`;
  return { text: text + sep + entry, key };
}

/** A record's one-line label for the card header and the tab hover: the title
 *  when it has one, else its key. */
export function bibRecordLabel(rec: BibRecord): string {
  const title = rec.fields.find((f) => f.key === "title");
  return title ? bibPlainValue(title.value) : rec.key;
}

/** The compact "author · year" line a card shows under its title, from whichever
 *  of the two the record actually has. Empty when it has neither. */
export function bibByline(rec: BibRecord): string {
  const get = (k: string) => {
    const f = rec.fields.find((x) => x.key === k);
    return f ? bibPlainValue(f.value) : "";
  };
  const author = get("author") || get("editor");
  const year = get("year") || get("date");
  return [author, year].filter(Boolean).join(" · ");
}
