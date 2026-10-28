// The reading model behind read-aloud, shared by the phone and (later) the
// desktop's TTS (docs/phone_voice_plan.md, "Read-aloud: efficient and
// navigable"). An answer becomes an outline — sections at headings, then
// paragraphs and list items, then chunks short enough for one utterance — and
// a cursor walks it: answer → section → chunk, with the spoken navigation
// moves (next section, next answer, back, back twice, repeat, where, summary,
// read all, read the code).
//
// What is never read unless asked: a code block ("code block, 12 lines"), a
// table ("a table, 6 rows"), a long list's tail ("and 5 more"), a path (only
// its file name), a URL ("a link"). Tool calls and their output never reach
// this module: the caller hands in the agent's own answers only.
//
// Pure: no browser, no i18n, no clock. Every spoken label comes in through
// `ReadingLabels` (build it with `readingLabels` over a translator in the
// speech language), so this file stays free of the dictionaries.

import { SENTENCE, speechChunks, spokenText } from "./voice";

/** Chrome on Android cuts an utterance off after about fifteen seconds, and an
 * utterance it cut never ends: a chunk stays well under that. */
export const MAX_SPEECH_CHUNK = 220;

// ---------------------------------------------------------------------------
// Labels

/** The i18n keys the labels read, in the speech language. `…One` is the
 * singular. */
export const READING_LABEL_KEYS = [
  "voice.reading.code",
  "voice.reading.codeOne",
  "voice.reading.table",
  "voice.reading.tableOne",
  "voice.reading.more",
  "voice.reading.link",
  "voice.reading.answered",
  "voice.reading.answeredOne",
  "voice.reading.answeredLong",
  "voice.reading.answeredLongOne",
  "voice.reading.where",
] as const;

export type ReadingLabelKey = (typeof READING_LABEL_KEYS)[number];

/** A translator over the label keys: `(key, params) => translate(lang, key,
 * params)` passes as is once the keys are in the dictionaries. */
export type ReadingTranslate = (key: ReadingLabelKey, params?: Record<string, string | number>) => string;

/** Where the cursor stands, 1-based, as "where" says it. */
export interface ReadingPosition {
  /** The answer's id, as the caller gave it. */
  id: string;
  answer: number;
  answers: number;
  section: number;
  sections: number;
  chunk: number;
  chunks: number;
}

/** Every line the reading model says of its own. */
export interface ReadingLabels {
  /** A skipped code block: "code block, 12 lines". */
  code(lines: number): string;
  /** A skipped table: "a table, 6 rows" (rows without the header). */
  table(rows: number): string;
  /** A long list's skipped tail: "and 5 more" (always 2 or more). */
  more(count: number): string;
  /** A URL said in prose: "a link". */
  link(): string;
  /** Brief mode's opening: "Claude answered, about 40 lines". */
  answered(agent: string, lines: number): string;
  /** A long answer under `announceLong` (driving), said instead of it:
   * "Claude answered, about 40 lines. Say “summary”, or listen later." */
  answeredLong(agent: string, lines: number): string;
  /** "answer 2 of 3, section 2 of 4". */
  where(position: ReadingPosition): string;
}

export function readingLabels(t: ReadingTranslate): ReadingLabels {
  return {
    code: (n) => (n === 1 ? t("voice.reading.codeOne") : t("voice.reading.code", { n })),
    table: (n) => (n === 1 ? t("voice.reading.tableOne") : t("voice.reading.table", { n })),
    more: (n) => t("voice.reading.more", { n }),
    link: () => t("voice.reading.link"),
    answered: (agent, n) =>
      n === 1 ? t("voice.reading.answeredOne", { agent }) : t("voice.reading.answered", { agent, n }),
    answeredLong: (agent, n) =>
      n === 1 ? t("voice.reading.answeredLongOne", { agent }) : t("voice.reading.answeredLong", { agent, n }),
    where: (p) =>
      t("voice.reading.where", { answer: p.answer, answers: p.answers, section: p.section, sections: p.sections }),
  };
}

// ---------------------------------------------------------------------------
// Options

/** How long an answer may be to be read whole in brief mode, and how long one
 * brief item may run. */
export interface ReadingLimits {
  /** An answer of at most this many sentences is short... */
  maxSentences: number;
  /** ...as is one of at most this many characters (about fifteen seconds). A
   * brief item is cut to this length too. */
  maxChars: number;
  /** A long answer in brief mode is only announced (`answeredLong`), not
   * outlined; "summary" then outlines it. Driving mode. */
  announceLong: boolean;
}

export const KITCHEN_LIMITS: ReadingLimits = { maxSentences: 2, maxChars: MAX_SPEECH_CHUNK, announceLong: false };

/** The Modes table's driving column: brief, ≤ ~2 sentences or ~15 s, longer
 * answers announced. Pass with `mode: "brief"`. */
export const DRIVING_LIMITS: ReadingLimits = { maxSentences: 2, maxChars: MAX_SPEECH_CHUNK, announceLong: true };

/** What an answer is read as by default: the whole of it (minus what is never
 * read), or its outline. Kitchen: "full", brief as a setting; driving: "brief". */
export type ReadingMode = "full" | "brief";

/** What an answer is rendered as. `"all"` ("read all") also reads a long
 * list's tail and a table's rows; `"outline"` is headings plus first
 * sentences; `"summary"` is the answer's own closing summary section, or the
 * outline when it has none. */
export type ReadingView = "full" | "all" | "brief" | "outline" | "summary";

export interface ReadingOptions {
  labels: ReadingLabels;
  /** Default `"full"`. */
  mode?: ReadingMode;
  /** Default `KITCHEN_LIMITS`. */
  limits?: ReadingLimits;
  /** Longest chunk, default `MAX_SPEECH_CHUNK`. */
  maxChunk?: number;
  /** Items read of a long list, default 3. */
  listHead?: number;
  /** A list with more items than this is long, default 5 (raised to
   * `listHead + 1`, so "and N more" always skips two or more). */
  longList?: number;
}

interface Settings {
  labels: ReadingLabels;
  mode: ReadingMode;
  limits: ReadingLimits;
  maxChunk: number;
  listHead: number;
  longList: number;
}

function settle(options: ReadingOptions): Settings {
  const listHead = Math.max(1, options.listHead ?? 3);
  return {
    labels: options.labels,
    mode: options.mode ?? "full",
    limits: options.limits ?? KITCHEN_LIMITS,
    maxChunk: Math.max(20, options.maxChunk ?? MAX_SPEECH_CHUNK),
    listHead,
    longList: Math.max(listHead + 1, options.longList ?? 5),
  };
}

// ---------------------------------------------------------------------------
// The outline

export type ReadingChunkKind =
  /** Brief mode's "Claude answered…" line, or the driving announcement. */
  | "intro"
  | "heading"
  | "text"
  | "item"
  /** A code block's placeholder; `code` says which block. */
  | "code"
  /** A table's placeholder, or one of its rows under "read all". */
  | "table"
  /** A long list's "and 5 more". */
  | "more"
  /** A line of code itself, read on "read the code". */
  | "source";

export interface ReadingChunk {
  /** What is said: at most `maxChunk` characters. */
  text: string;
  kind: ReadingChunkKind;
  /** On a `"code"` placeholder: the block's index in `ReadingOutline.codes`. */
  code?: number;
}

export interface ReadingSection {
  /** The heading as said; `null` for the text before the first heading. */
  heading: string | null;
  /** Never empty. */
  chunks: ReadingChunk[];
}

export interface ReadingOutline {
  /** Sections with nothing to say are left out. */
  sections: ReadingSection[];
  /** For each rendered section, the index of the answer's own section it came
   * from (a rendering may drop or pick sections). */
  source: number[];
  /** The answer's code blocks, raw, in order. */
  codes: string[];
  /** Non-blank lines of the answer's text, as "about N lines" counts. */
  lines: number;
  /** Whether the answer has a summary section of its own. */
  hasSummary: boolean;
}

type Segment = { text: string } | { code: number };

type Block =
  | { kind: "paragraph"; segs: Segment[] }
  | { kind: "list"; items: Segment[][] }
  | { kind: "code"; code: number }
  | { kind: "table"; rows: string[]; dataRows: number };

interface SourceSection {
  heading: string | null;
  blocks: Block[];
}

interface Parsed {
  sections: SourceSection[];
  codes: string[];
  codeLines: number[];
  lines: number;
  /** The summary: a section, or a closing lead paragraph ("**In short:** …")
   * as `block`. */
  summary: { section: number; block?: number } | null;
}

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
/** A line that is only bold text, as agents write a heading: "**Summary**". */
const BOLD_HEADING = /^[ \t]{0,3}(\*\*|__)([^*_\n]{1,80}?)\1[ \t]*:?[ \t]*$/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isFenceClose(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed.split("").every((ch) => ch === fence[0]);
}

function headingOf(line: string): string | null {
  const hash = HEADING.exec(line);
  if (hash) return hash[2];
  const bold = BOLD_HEADING.exec(line);
  if (bold) return bold[2].replace(/[ \t]*:$/, "");
  return null;
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-");
}

/** Whether `line` starts a block of its own, ending the paragraph above. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE_OPEN.test(line) || headingOf(line) !== null || RULE.test(line) || ITEM.test(line) || isTableStart(lines, i);
}

/** Lines that may hold fenced code (a list item's) as prose and code pieces. */
function segmentsOf(lines: string[], codes: string[], codeLines: number[]): Segment[] {
  const segs: Segment[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.some((line) => !isBlank(line))) segs.push({ text: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    flush();
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !isFenceClose(lines[i], open[1])) body.push(lines[i++]);
    segs.push({ code: addCode(body, codes, codeLines) });
  }
  flush();
  return segs;
}

function addCode(body: string[], codes: string[], codeLines: number[]): number {
  const kept = [...body];
  while (kept.length > 0 && isBlank(kept[kept.length - 1])) kept.pop();
  const indent = kept.reduce(
    (least, line) => (isBlank(line) ? least : Math.min(least, /^[ \t]*/.exec(line)?.[0].length ?? 0)),
    Number.POSITIVE_INFINITY,
  );
  codes.push(kept.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n"));
  codeLines.push(kept.length);
  return codes.length - 1;
}

/** Words that title an agent's own summary, in the five app languages. */
const SUMMARY_TITLES = [
  "summary", "in summary", "in short", "tldr", "tl dr", "short version", "bottom line",
  "zusammenfassung", "kurz gesagt", "kurzfassung", "fazit", "kurz",
  "resumen", "en resumen", "en pocas palabras", "en breve",
  "résumé", "en bref", "en résumé", "synthèse",
  "riepilogo", "in breve", "in sintesi", "sintesi", "riassunto",
];

function titleWords(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isSummaryTitle(text: string): boolean {
  const words = titleWords(text);
  return SUMMARY_TITLES.some((title) => words === title || words.startsWith(`${title} `));
}

/** A paragraph that opens with its own summary title: "**In short:** …",
 * "TL;DR: …". */
function isSummaryLead(segs: Segment[]): boolean {
  const first = segs[0];
  if (!first || !("text" in first)) return false;
  const lead = /^[ \t>]*(?:\*\*|__)?([^:*_\n]{2,30}?)(?:\*\*|__)?[ \t]*[:,—–-](?:\*\*|__)?/u.exec(first.text);
  return !!lead && isSummaryTitle(lead[1]);
}

function parse(markdown: string): Parsed {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const codes: string[] = [];
  const codeLines: number[] = [];
  const sections: SourceSection[] = [{ heading: null, blocks: [] }];
  const blocks = () => sections[sections.length - 1].blocks;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || RULE.test(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i], fence[1])) body.push(lines[i++]);
      i += 1;
      blocks().push({ kind: "code", code: addCode(body, codes, codeLines) });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      sections.push({ heading, blocks: [] });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const rows: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        if (!TABLE_RULE.test(lines[i])) rows.push(lines[i]);
        i += 1;
      }
      blocks().push({ kind: "table", rows, dataRows: Math.max(0, rows.length - 1) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const base = item[1].replace(/\t/g, "    ").length;
      const items: string[][] = [];
      let open: string[] = [item[2]];
      let fenceOpen: string | null = null;
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (fenceOpen !== null) {
          open.push(next);
          if (isFenceClose(next, fenceOpen)) fenceOpen = null;
          i += 1;
          continue;
        }
        const indent = (/^[ \t]*/.exec(next)?.[0] ?? "").replace(/\t/g, "    ").length;
        const nested = ITEM.exec(next);
        if (isBlank(next)) {
          // A blank line ends the list unless an item or an indented
          // continuation follows it.
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j])) j += 1;
          const after = j < lines.length ? lines[j] : null;
          const afterIndent = after === null ? 0 : (/^[ \t]*/.exec(after)?.[0] ?? "").replace(/\t/g, "    ").length;
          if (after === null || !(ITEM.exec(after) && afterIndent <= base + 1) && afterIndent <= base + 1) break;
          i = j;
          continue;
        }
        if (nested && indent <= base + 1) {
          items.push(open);
          open = [nested[2]];
          i += 1;
          continue;
        }
        if (indent > base + 1) {
          const innerFence = FENCE_OPEN.exec(next);
          if (innerFence) fenceOpen = innerFence[1];
          // A nested item ends the line above it as a sentence (its own
          // marker gets one from `spokenText`; the item's first line has none).
          const last = open.length - 1;
          if (nested && !FENCE_OPEN.test(open[last]) && !/[.!?:;,]\s*$/.test(open[last])) open[last] = `${open[last]}.`;
          open.push(next);
          i += 1;
          continue;
        }
        // A lazy continuation of the item's last line.
        if (startsBlock(lines, i)) break;
        open.push(next);
        i += 1;
      }
      items.push(open);
      blocks().push({ kind: "list", items: items.map((lines) => segmentsOf(lines, codes, codeLines)) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]);
    blocks().push({ kind: "paragraph", segs: [{ text: para.join("\n") }] });
  }
  return {
    sections,
    codes,
    codeLines,
    lines: lines.filter((line) => !isBlank(line)).length,
    summary: findSummary(sections),
  };
}

function findSummary(sections: SourceSection[]): Parsed["summary"] {
  for (let s = sections.length - 1; s >= 0; s -= 1) {
    const section = sections[s];
    if (section.heading !== null && isSummaryTitle(section.heading) && section.blocks.length > 0) return { section: s };
    for (let b = section.blocks.length - 1; b >= 0; b -= 1) {
      const block = section.blocks[b];
      if (block.kind === "paragraph" && isSummaryLead(block.segs)) return { section: s, block: b };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// What is said

const URL = /<(?:https?|ftp):\/\/[^\s>]+>|(?:https?:\/\/|www\.)[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/gi;
const MD_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const PATH_TOKEN = /(^|[\s([{"'`<])([^\s()[\]{}"'`<>,;|]+)/g;

/** A token's file name when the token is a path, else the token. */
function pathLeaf(token: string): string {
  // Bold or italic around it, a sentence's end after it.
  const [, lead, body, trail] = /^([*_]*)([\s\S]*?)([*_]*[.:!?]*[*_]*)$/.exec(token) ?? ["", "", token, ""];
  const core = body.replace(/:\d+(?::\d+)?$/, "");
  const parts = core.split(/[\\/]/);
  const leaf = [...parts].reverse().find((part) => part !== "");
  if (!leaf || parts.length < 2) return token;
  const rooted = /^(?:~|\.{1,2})?\//.test(core) || /^[A-Za-z]:\\/.test(core);
  const hasExt = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(leaf);
  const dir = /[\\/]$/.test(core);
  const deep = parts.length >= 3 && /\p{L}/u.test(core);
  const inner = parts.slice(0, -1).every((part, index) => part !== "" || (index === 0 && rooted));
  if (!(rooted || ((hasExt || dir || deep) && inner))) return token;
  return `${lead}${leaf}${trail}`;
}

/** Prose as it should be said: links by their label, URLs as "a link", paths
 * by their file name, then `spokenText`'s cleanup. */
function sayProse(raw: string, labels: ReadingLabels): string {
  const link = labels.link();
  const text = raw
    .replace(MD_LINK, "$1")
    .replace(URL, link)
    .replace(PATH_TOKEN, (_all, lead: string, token: string) => `${lead}${pathLeaf(token)}`);
  // No fence is left in prose (they are segments), so the code label is
  // never used.
  return spokenText(text, "");
}

interface Ctx extends Settings {
  parsed: Parsed;
}

function segChunks(segs: Segment[], kind: "text" | "item" | "table", ctx: Ctx): ReadingChunk[] {
  const chunks: ReadingChunk[] = [];
  for (const seg of segs) {
    if ("code" in seg) chunks.push(codeChunk(seg.code, ctx));
    else for (const text of speechChunks(sayProse(seg.text, ctx.labels), ctx.maxChunk)) chunks.push({ text, kind });
  }
  return chunks;
}

function codeChunk(code: number, ctx: Ctx): ReadingChunk {
  return { text: ctx.labels.code(ctx.parsed.codeLines[code]), kind: "code", code };
}

function blockChunks(block: Block, all: boolean, ctx: Ctx): ReadingChunk[] {
  switch (block.kind) {
    case "paragraph":
      return segChunks(block.segs, "text", ctx);
    case "code":
      return [codeChunk(block.code, ctx)];
    case "table": {
      const label: ReadingChunk = { text: ctx.labels.table(block.dataRows), kind: "table" };
      if (!all) return [label];
      return [label, ...block.rows.flatMap((row) => segChunks([{ text: row }], "table", ctx))];
    }
    case "list": {
      const long = !all && block.items.length > ctx.longList;
      const read = long ? block.items.slice(0, ctx.listHead) : block.items;
      const chunks = read.flatMap((item) => segChunks(item, "item", ctx));
      if (long) chunks.push({ text: ctx.labels.more(block.items.length - ctx.listHead), kind: "more" });
      return chunks;
    }
  }
}

function headingChunk(section: SourceSection, ctx: Ctx): ReadingChunk[] {
  if (section.heading === null) return [];
  const text = sayProse(section.heading, ctx.labels);
  return text ? [{ text, kind: "heading" }] : [];
}

function sectionChunks(section: SourceSection, all: boolean, ctx: Ctx): ReadingChunk[] {
  return [...headingChunk(section, ctx), ...section.blocks.flatMap((block) => blockChunks(block, all, ctx))];
}

const FIRST_SENTENCE = /^[\s\S]*?[.!?…](?=\s|$)/u;

/** A section in an outline: its heading and the first sentence after it,
 * cut to the limits. */
function outlineChunks(section: SourceSection, ctx: Ctx): ReadingChunk[] {
  const head = headingChunk(section, ctx);
  let first: ReadingChunk | undefined;
  for (const block of section.blocks) {
    first = blockChunks(block, false, ctx)[0];
    if (first) break;
  }
  if (!first) return head;
  if (first.kind === "text" || first.kind === "item") {
    const sentence = FIRST_SENTENCE.exec(first.text)?.[0].trim() ?? first.text;
    first = { ...first, text: speechChunks(sentence, ctx.limits.maxChars)[0] ?? sentence };
  }
  return [...head, first];
}

function aboutLines(lines: number): number {
  return lines <= 10 ? lines : Math.round(lines / 10) * 10;
}

function countSentences(text: string): number {
  return text.match(SENTENCE)?.filter((sentence) => /[\p{L}\p{N}]/u.test(sentence)).length ?? 0;
}

function build(sections: { section: number; chunks: ReadingChunk[] }[], ctx: Ctx): ReadingOutline {
  const { parsed } = ctx;
  const kept = sections.filter((entry) => entry.chunks.length > 0);
  return {
    sections: kept.map((entry) => ({
      heading: headingChunk(parsed.sections[entry.section], ctx)[0]?.text ?? null,
      chunks: entry.chunks,
    })),
    source: kept.map((entry) => entry.section),
    codes: parsed.codes,
    lines: parsed.lines,
    hasSummary: parsed.summary !== null,
  };
}

function renderParsed(parsed: Parsed, view: ReadingView, agent: string, settings: Settings): ReadingOutline {
  const ctx: Ctx = { ...settings, parsed };
  const each = (fn: (section: SourceSection) => ReadingChunk[]) =>
    parsed.sections.map((section, index) => ({ section: index, chunks: fn(section) }));
  const full = (all: boolean) => build(each((section) => sectionChunks(section, all, ctx)), ctx);
  const outline = (intro: boolean) => {
    const entries = each((section) => outlineChunks(section, ctx));
    if (intro) {
      const at = entries.find((entry) => entry.chunks.length > 0) ?? entries[0];
      at.chunks.unshift({ text: ctx.labels.answered(agent, aboutLines(parsed.lines)), kind: "intro" });
    }
    return build(entries, ctx);
  };
  switch (view) {
    case "full":
    case "all":
      return full(view === "all");
    case "outline":
      return outline(false);
    case "summary": {
      const summary = parsed.summary;
      if (!summary) return outline(false);
      const section = parsed.sections[summary.section];
      const chunks = summary.block === undefined
        ? sectionChunks(section, false, ctx)
        : blockChunks(section.blocks[summary.block], false, ctx);
      return build([{ section: summary.section, chunks }], ctx);
    }
    case "brief": {
      const whole = full(false);
      const said = whole.sections.flatMap((section) => section.chunks.map((chunk) => chunk.text)).join(" ");
      const { maxChars, maxSentences, announceLong } = ctx.limits;
      if (said.length <= maxChars || countSentences(said) <= maxSentences) return whole;
      if (!announceLong) return outline(true);
      const at = whole.source[0] ?? 0;
      return build([{
        section: at,
        chunks: [{ text: ctx.labels.answeredLong(agent, aboutLines(parsed.lines)), kind: "intro" }],
      }], ctx);
    }
  }
}

/**
 * One answer as it is read in `view`: its sections and their chunks. The
 * cursor below renders through this; it is exported for tests and for a
 * caller that wants the outline without a cursor (the desktop, later).
 */
export function outlineAnswer(markdown: string, view: ReadingView, options: ReadingOptions, agent = ""): ReadingOutline {
  return renderParsed(parse(markdown), view, agent, settle(options));
}

/** A code block as it is read on "read the code": its lines, packed into
 * chunks, a line too long for one cut at a word. */
export function codeChunks(code: string, maxChunk: number = MAX_SPEECH_CHUNK): ReadingChunk[] {
  const chunks: ReadingChunk[] = [];
  let open = "";
  const close = () => {
    if (open) chunks.push({ text: open, kind: "source" });
    open = "";
  };
  for (const raw of code.split("\n")) {
    const line = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
    if (!line) continue;
    if (open && open.length + 1 + line.length <= maxChunk) {
      open = `${open}\n${line}`;
      continue;
    }
    close();
    if (line.length <= maxChunk) open = line;
    else for (const piece of speechChunks(line, maxChunk)) chunks.push({ text: piece, kind: "source" });
  }
  close();
  return chunks;
}

// ---------------------------------------------------------------------------
// The cursor

/** One answer to read: the agent's own message only, never a tool call or
 * its output. */
export interface ReadingAnswer {
  /** Stable across re-reads of the transcript (the turn key). */
  id: string;
  /** The answer's markdown. */
  text: string;
  /** Who answered, as said: "Claude". */
  agent: string;
}

export interface ReadingCursor {
  /** The answers in order (the session's answer turns). Replaces the list;
   * the position follows its answer by id. An answer whose text grew (still
   * streaming) keeps the position; one that is gone drops it. */
  setAnswers(answers: readonly ReadingAnswer[]): void;
  /** Changes the defaults (brief ⇄ full, driving limits). The answers'
   * own "summary" / "read all" choices stay. */
  setOptions(options: ReadingOptions): void;
  /**
   * Starts reading answer `id` from its first chunk, in the default mode,
   * and returns that chunk (`null` when there is no such answer or it says
   * nothing). `follow`: when the answer ends, `advance` goes on into the next
   * one (auto read-aloud); without it, reading stops at its end (Read aloud
   * on one message). A later explicit move keeps the flag.
   */
  start(id: string, opts?: { follow?: boolean }): ReadingChunk | null;
  /** The chunk to say now (being said, or just said); `null` before a start
   * or after the end. */
  current(): ReadingChunk | null;
  /** The current chunk was said: the next one, or `null` at the end. With
   * `follow`, a later call after new answers arrived goes on into them. */
  advance(): ReadingChunk | null;
  /** Whether the current chunk is its section's last: a listen gap follows
   * it. False while reading code. */
  atSectionEnd(): boolean;
  /** Whether reading has ended (nothing current). */
  ended(): boolean;
  /** "next": the next section, else the next answer; `null` at the end. */
  next(): ReadingChunk | null;
  /** "next answer": the next answer's start; `null` (stop) when there is
   * none. */
  nextAnswer(): ReadingChunk | null;
  /** "back": the previous chunk. Said again before the cursor moved on, the
   * start of the section before the one it was in (and one more section back
   * on each further "back"). */
  back(): ReadingChunk | null;
  /** "repeat": the current chunk again (also the last one after the end). */
  repeat(): ReadingChunk | null;
  /** "summary": this answer's own summary section, else its outline. */
  summary(): ReadingChunk | null;
  /** "read all": this answer in full, lists' tails and tables' rows too,
   * from the section the cursor is in. */
  readAll(): ReadingChunk | null;
  /** "read the code": the code block at the cursor, else the last one before
   * it, else the next one, in this answer; `null` when it has none. Reading
   * goes on after the block's placeholder once the code is said. */
  readCode(): ReadingChunk | null;
  /** Where the cursor stands; `null` before a start. */
  position(): ReadingPosition | null;
  /** "where", said: "answer 2 of 3, section 2 of 4"; `null` before a start. */
  where(): string | null;
}

interface Pos {
  id: string;
  section: number;
  chunk: number;
}

interface Rendered {
  text: string;
  view: ReadingView;
  outline: ReadingOutline;
}

export function createReadingCursor(options: ReadingOptions, answers: readonly ReadingAnswer[] = []): ReadingCursor {
  let settings = settle(options);
  let list: ReadingAnswer[] = [...answers];
  const parsedCache = new Map<string, { text: string; parsed: Parsed }>();
  const renderCache = new Map<string, Rendered>();
  /** "summary" / "read all", per answer id. */
  const views = new Map<string, ReadingView>();
  let pos: Pos | null = null;
  let done = false;
  let follow = false;
  /** Set by a "back", cleared by any other move: the section a further
   * "back" steps back from. */
  let backFrom: { id: string; section: number } | null = null;
  /** Reading a code block: its chunks, and where in them. */
  let detour: { chunks: ReadingChunk[]; at: number } | null = null;

  const indexOf = (id: string) => list.findIndex((answer) => answer.id === id);

  const viewOf = (id: string): ReadingView => views.get(id) ?? settings.mode;

  function parsedOf(answer: ReadingAnswer): Parsed {
    const cached = parsedCache.get(answer.id);
    if (cached && cached.text === answer.text) return cached.parsed;
    const parsed = parse(answer.text);
    parsedCache.set(answer.id, { text: answer.text, parsed });
    return parsed;
  }

  function outlineOf(id: string): ReadingOutline | null {
    const answer = list[indexOf(id)];
    if (!answer) return null;
    const view = viewOf(id);
    const cached = renderCache.get(id);
    if (cached && cached.text === answer.text && cached.view === view) return cached.outline;
    const outline = renderParsed(parsedOf(answer), view, answer.agent, settings);
    renderCache.set(id, { text: answer.text, view, outline });
    return outline;
  }

  function chunkAt(at: Pos | null): ReadingChunk | null {
    if (!at) return null;
    return outlineOf(at.id)?.sections[at.section]?.chunks[at.chunk] ?? null;
  }

  /** Keeps `pos` inside its answer's outline (it may have shrunk or been
   * re-rendered); drops it when the answer is gone or says nothing. */
  function clamp() {
    if (!pos) return;
    const outline = outlineOf(pos.id);
    if (!outline || outline.sections.length === 0) {
      pos = null;
      done = true;
      return;
    }
    const section = Math.min(pos.section, outline.sections.length - 1);
    const chunk = section === pos.section ? Math.min(pos.chunk, outline.sections[section].chunks.length - 1) : 0;
    pos = { id: pos.id, section, chunk };
  }

  /** The start of the first answer at or after `from` with anything to say. */
  function answerStart(from: number): Pos | null {
    for (let index = Math.max(0, from); index < list.length; index += 1) {
      const outline = outlineOf(list[index].id);
      if (outline && outline.sections.length > 0) return { id: list[index].id, section: 0, chunk: 0 };
    }
    return null;
  }

  /** The last chunk of the last answer before `before` with anything to say. */
  function answerEnd(before: number): Pos | null {
    for (let index = Math.min(before, list.length) - 1; index >= 0; index -= 1) {
      const outline = outlineOf(list[index].id);
      if (outline && outline.sections.length > 0) {
        const section = outline.sections.length - 1;
        return { id: list[index].id, section, chunk: outline.sections[section].chunks.length - 1 };
      }
    }
    return null;
  }

  /** Lands on `at` (or ends when it is `null`) and returns what to say. */
  function land(at: Pos | null): ReadingChunk | null {
    detour = null;
    if (!at) {
      done = true;
      return null;
    }
    pos = at;
    done = false;
    return chunkAt(pos);
  }

  function nextSectionFrom(at: Pos): Pos | null {
    const outline = outlineOf(at.id);
    if (outline && at.section + 1 < outline.sections.length) return { id: at.id, section: at.section + 1, chunk: 0 };
    return answerStart(indexOf(at.id) + 1);
  }

  function prevSectionFrom(at: { id: string; section: number }): Pos {
    if (at.section > 0) return { id: at.id, section: at.section - 1, chunk: 0 };
    const end = answerEnd(indexOf(at.id));
    return end ? { id: end.id, section: end.section, chunk: 0 } : { id: at.id, section: 0, chunk: 0 };
  }

  function prevChunkFrom(at: Pos): Pos {
    if (at.chunk > 0) return { ...at, chunk: at.chunk - 1 };
    const outline = outlineOf(at.id);
    if (outline && at.section > 0) {
      const section = at.section - 1;
      return { id: at.id, section, chunk: outline.sections[section].chunks.length - 1 };
    }
    return answerEnd(indexOf(at.id)) ?? at;
  }

  /** Re-renders the current answer as `view`, keeping the section the cursor
   * is in when the new rendering has it. */
  function reView(view: ReadingView, keepSection: boolean): ReadingChunk | null {
    if (!pos) return null;
    const before = outlineOf(pos.id);
    const from = before?.source[pos.section] ?? 0;
    views.set(pos.id, view);
    const after = outlineOf(pos.id);
    if (!after || after.sections.length === 0) return land(null);
    let section = 0;
    if (keepSection) {
      const found = after.source.findIndex((source) => source >= from);
      section = found < 0 ? after.sections.length - 1 : found;
    }
    return land({ id: pos.id, section, chunk: 0 });
  }

  function position(): ReadingPosition | null {
    if (!pos) return null;
    const outline = outlineOf(pos.id);
    if (!outline) return null;
    return {
      id: pos.id,
      answer: indexOf(pos.id) + 1,
      answers: list.length,
      section: pos.section + 1,
      sections: outline.sections.length,
      chunk: pos.chunk + 1,
      chunks: outline.sections[pos.section]?.chunks.length ?? 0,
    };
  }

  return {
    setAnswers(next) {
      list = [...next];
      const ids = new Set(list.map((answer) => answer.id));
      for (const id of [...parsedCache.keys()]) if (!ids.has(id)) parsedCache.delete(id);
      for (const id of [...renderCache.keys()]) if (!ids.has(id)) renderCache.delete(id);
      for (const id of [...views.keys()]) if (!ids.has(id)) views.delete(id);
      if (backFrom && !ids.has(backFrom.id)) backFrom = null;
      clamp();
    },

    setOptions(next) {
      const before = pos ? outlineOf(pos.id) : null;
      const from = pos && before ? before.source[pos.section] : 0;
      settings = settle(next);
      renderCache.clear();
      if (!pos) return;
      const after = outlineOf(pos.id);
      if (!after || after.sections.length === 0) {
        land(null);
        return;
      }
      const found = after.source.findIndex((source) => source >= from);
      const section = found < 0 ? after.sections.length - 1 : found;
      if (section !== pos.section || after.sections[section].chunks.length <= pos.chunk) pos = { id: pos.id, section, chunk: 0 };
    },

    start(id, opts) {
      backFrom = null;
      follow = opts?.follow ?? false;
      views.delete(id);
      const outline = outlineOf(id);
      return land(outline && outline.sections.length > 0 ? { id, section: 0, chunk: 0 } : null);
    },

    current() {
      if (done) return null;
      if (detour) return detour.chunks[detour.at] ?? null;
      return chunkAt(pos);
    },

    advance() {
      backFrom = null;
      if (!pos) return null;
      if (detour) {
        detour.at += 1;
        if (detour.at < detour.chunks.length) return detour.chunks[detour.at];
        detour = null;
      }
      const outline = outlineOf(pos.id);
      if (!outline) return land(null);
      // After the end too: an answer that grew, or (following) a new one,
      // goes on from the last chunk said.
      const section = outline.sections[pos.section];
      if (section && pos.chunk + 1 < section.chunks.length) return land({ ...pos, chunk: pos.chunk + 1 });
      if (pos.section + 1 < outline.sections.length) return land({ id: pos.id, section: pos.section + 1, chunk: 0 });
      const next = follow ? answerStart(indexOf(pos.id) + 1) : null;
      if (next) return land(next);
      done = true;
      return null;
    },

    atSectionEnd() {
      if (!pos || done || detour) return false;
      const section = outlineOf(pos.id)?.sections[pos.section];
      return !!section && pos.chunk === section.chunks.length - 1;
    },

    ended() {
      return done || !pos;
    },

    next() {
      backFrom = null;
      if (!pos) return null;
      const next = nextSectionFrom(pos);
      if (next) return land(next);
      detour = null;
      done = true;
      return null;
    },

    nextAnswer() {
      backFrom = null;
      if (!pos) return null;
      const next = answerStart(indexOf(pos.id) + 1);
      if (next) return land(next);
      detour = null;
      done = true;
      return null;
    },

    back() {
      if (!pos) return null;
      if (detour) {
        if (detour.at > 0) {
          detour.at -= 1;
          return detour.chunks[detour.at];
        }
        detour = null;
        done = false;
        return chunkAt(pos);
      }
      if (backFrom) {
        const target = prevSectionFrom(backFrom);
        backFrom = { id: target.id, section: target.section };
        return land(target);
      }
      backFrom = { id: pos.id, section: pos.section };
      return land(prevChunkFrom(pos));
    },

    repeat() {
      if (!pos) return null;
      if (detour) return detour.chunks[detour.at] ?? null;
      done = false;
      return chunkAt(pos);
    },

    summary() {
      backFrom = null;
      return reView("summary", false);
    },

    readAll() {
      backFrom = null;
      return reView("all", true);
    },

    readCode() {
      backFrom = null;
      if (!pos) return null;
      const outline = outlineOf(pos.id);
      if (!outline) return null;
      const flat = outline.sections.flatMap((section, s) => section.chunks.map((chunk, c) => ({ chunk, s, c })));
      const here = flat.findIndex((entry) => entry.s === pos?.section && entry.c === pos?.chunk);
      const at = (entry: { chunk: ReadingChunk }) => entry.chunk.code !== undefined;
      let found = here >= 0 && at(flat[here]) ? flat[here] : undefined;
      for (let i = here - 1; !found && i >= 0; i -= 1) if (at(flat[i])) found = flat[i];
      for (let i = here + 1; !found && i < flat.length; i += 1) if (at(flat[i])) found = flat[i];
      if (!found || found.chunk.code === undefined) return null;
      const chunks = codeChunks(outline.codes[found.chunk.code], settings.maxChunk);
      if (chunks.length === 0) return null;
      pos = { id: pos.id, section: found.s, chunk: found.c };
      done = false;
      detour = { chunks, at: 0 };
      return chunks[0];
    },

    position,

    where() {
      const at = position();
      return at ? settings.labels.where(at) : null;
    },
  };
}
