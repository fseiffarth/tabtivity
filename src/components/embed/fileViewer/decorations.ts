import { escapeHtml } from "../../../lib/textSafety";
import { type GrammarIssue } from "../../../types";

/**
 * Build a transparent decoration layer (#49) where the `ranges` are wrapped in
 * `<span class="file-link">` so they read as clickable (dotted underline). The
 * surrounding text is escaped and emitted plain (transparent), so only the link
 * spans paint. SECURITY: every run of source text is HTML-escaped before output.
 */
export function decorateLinkRanges(
  source: string,
  ranges: { start: number; end: number; hit?: boolean }[],
): string {
  if (ranges.length === 0) return escapeHtml(source);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= r.end) continue; // skip overlaps / empties
    out += escapeHtml(source.slice(pos, r.start));
    // `data-off` carries the token's source offset so a Ctrl/⌘+click can follow
    // the link by the span it lands on rather than by `selectionStart` — a
    // modified click does not reposition a textarea's caret, so the caret is
    // stale exactly when the follow needs it.
    // A `hit` range is clickable but not a link to look at (the rest of an
    // `\input{…}` around its underlined path): same hit box, no underline.
    const cls = r.hit ? "file-link-hit" : "file-link";
    out += `<span class="${cls}" data-off="${r.start}">${escapeHtml(source.slice(r.start, r.end))}</span>`;
    pos = r.end;
  }
  out += escapeHtml(source.slice(pos));
  return out;
}

/**
 * Build the hover-preview hit layer (#tex-hover-preview): the previewable TeX
 * fragments are wrapped in `<span class="file-viewer-tex-snippet">` carrying
 * their index, the rest emitted plain. The spans paint nothing until one is
 * hovered — this layer exists to be *hit-tested*, since the textarea owns pointer
 * events and a scroll-synced overlay's span boxes are the only thing in the
 * editor that knows where a character actually landed on screen (the same
 * technique the link, grammar and unclosed-bracket layers use). SECURITY: every
 * run of source text is HTML-escaped before output.
 */
export function decorateSnippetRanges(
  source: string,
  ranges: { start: number; end: number }[],
): string {
  if (ranges.length === 0) return escapeHtml(source);
  let out = "";
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtml(source.slice(pos, r.start));
    out += `<span class="file-viewer-tex-snippet" data-si="${i}">${escapeHtml(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  });
  out += escapeHtml(source.slice(pos));
  return out;
}

/**
 * Find every (non-overlapping) occurrence of `query` in `text` as a
 * `{start, end}` offset range (#67 editor search). A plain substring search;
 * `caseSensitive` toggles a case-fold. An empty query yields no matches.
 * Exported for unit testing.
 */
export function findMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length; // non-overlapping
  }
  return out;
}

/**
 * Build the transparent search-highlight overlay (#67): the `matches` ranges are
 * wrapped in `<span class="file-viewer-search-match">` (the `current` one also
 * carries `current`), the rest emitted plain so only the match spans paint a
 * background. SECURITY: every run of source text is HTML-escaped before output —
 * mirrors `decorateLinkRanges`.
 */
export function decorateSearchRanges(
  source: string,
  matches: { start: number; end: number }[],
  current: number,
): string {
  if (matches.length === 0) return escapeHtml(source);
  let out = "";
  let pos = 0;
  matches.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtml(source.slice(pos, r.start));
    const cls = i === current ? "file-viewer-search-match current" : "file-viewer-search-match";
    out += `<span class="${cls}">${escapeHtml(source.slice(r.start, r.end))}</span>`;
    pos = r.end;
  });
  out += escapeHtml(source.slice(pos));
  return out;
}

/**
 * Build the occurrence-highlight overlay (#tex-command-occurrences): the ranges
 * are wrapped in `<span class="file-viewer-occurrence-match">`, the rest emitted
 * plain, so only the other uses of the double-clicked control sequence paint.
 * A quieter fill than the search layer's on purpose — this mark is a passing
 * answer to a gesture, not a search the reader is stepping through. SECURITY:
 * every run of source text is HTML-escaped before output — mirrors
 * {@link decorateSearchRanges}.
 */
export function decorateOccurrenceRanges(
  source: string,
  ranges: { start: number; end: number }[],
): string {
  if (ranges.length === 0) return escapeHtml(source);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos || r.start >= r.end) continue; // skip overlaps / empties
    out += escapeHtml(source.slice(pos, r.start));
    out += `<span class="file-viewer-occurrence-match">${escapeHtml(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  }
  out += escapeHtml(source.slice(pos));
  return out;
}

/** The three bracket pairs matched by {@link findMatchingBracket}: `(`/`)`,
 *  `[`/`]`, `{`/`}` — the pairs shared by every language the editor highlights
 *  (LaTeX group braces and optional-arg brackets included). Keyed both ways so
 *  a lookup never needs to know which side it's holding. */
const BRACKET_OPEN_FOR: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
export const BRACKET_CLOSE_FOR: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** One side of a matched delimiter pair: a `[start, end)` source range —
 *  length 1 for a plain `(`/`)`/etc., longer for a multi-character LaTeX token
 *  like `\[`, `$$`, or a whole `\begin{itemize}`. */
export interface BracketSide {
  start: number;
  end: number;
}

/** A matched delimiter pair (`open` earlier in the source than `close`), for
 *  the "highlight the matching bracket" overlay. Ranges rather than single
 *  offsets so the same type/overlay serves both the plain single-char
 *  ()[]{} matcher below and `lib/viewers/tex/tex.ts`'s LaTeX-aware math/environment
 *  matcher (`$`/`$$`/`\(`/`\)`/`\[`/`\]`/`\begin{…}`/`\end{…}`), which the two
 *  share structurally without either module importing the other's type. */
export interface BracketMatch {
  open: BracketSide;
  close: BracketSide;
}

/** Scan from `start` in direction `dir` (`1` forward, `-1` backward) for the
 *  offset where a running depth — incremented on `incChar`, decremented on
 *  `decChar` — returns to 0; that is the partner bracket. `null` if the depth
 *  never returns to 0 (unbalanced/unmatched). Shared by the two directions
 *  {@link findMatchingBracket} scans, which just swap which char increments vs.
 *  decrements. Pure — a plain nesting count, no comment/string awareness (the
 *  same level of sophistication as this file's other overlay decorators). */
function scanForBracketMatch(
  text: string,
  start: number,
  incChar: string,
  decChar: string,
  dir: 1 | -1,
): number | null {
  let depth = 1;
  for (let i = start; dir === 1 ? i < text.length : i >= 0; i += dir) {
    const ch = text[i];
    if (ch === incChar) depth++;
    else if (ch === decChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** If `text[pos]` is a bracket (either side of a pair), its match — scanning
 *  forward for an opener or backward for a closer, from just past `pos`. `null`
 *  when `pos` isn't a bracket, or the bracket found has no partner (unbalanced
 *  source). Shared by both adjacent offsets {@link findMatchingBracket} checks. */
function matchBracketAt(text: string, pos: number): BracketMatch | null {
  const ch = text[pos];
  if (ch === undefined) return null;
  if (BRACKET_CLOSE_FOR[ch]) {
    const close = scanForBracketMatch(text, pos + 1, ch, BRACKET_CLOSE_FOR[ch], 1);
    return close != null
      ? { open: { start: pos, end: pos + 1 }, close: { start: close, end: close + 1 } }
      : null;
  }
  if (BRACKET_OPEN_FOR[ch]) {
    const open = scanForBracketMatch(text, pos - 1, ch, BRACKET_OPEN_FOR[ch], -1);
    return open != null
      ? { open: { start: open, end: open + 1 }, close: { start: pos, end: pos + 1 } }
      : null;
  }
  return null;
}

/**
 * The bracket pair straddling `caret`, for the "highlight the matching
 * bracket" affordance. A caret sits "on" a bracket from either side of it, so
 * this checks BOTH adjacent characters — `text[caret]` (the caret sits just
 * before it) first, then `text[caret - 1]` (the caret sits just after it) —
 * covering all four ways a blinking caret can touch a bracket: just before or
 * just after either its open or its close. (An earlier cut only checked "just
 * before an opener" and "just after a closer", which missed the two positions
 * a caret is actually in most often — right after typing `(`, or right before
 * deleting `)` — so the caret could sit directly against a bracket and nothing
 * would light up.) Returns `null` when neither side is a bracket, or the
 * bracket found has no partner (unbalanced source). Pure / unit-tested.
 */
export function findMatchingBracket(text: string, caret: number): BracketMatch | null {
  return matchBracketAt(text, caret) ?? matchBracketAt(text, caret - 1);
}

/**
 * Build the transparent bracket-match overlay: the two paired delimiter
 * ranges found by {@link findMatchingBracket} (or `lib/viewers/tex/tex.ts`'s
 * math/environment matcher) are each wrapped in
 * `<span class="file-viewer-bracket-match">`, the rest emitted plain — mirrors
 * `decorateSearchRanges`. SECURITY: every run of source text is HTML-escaped.
 */
export function decorateBracketMatch(source: string, match: BracketMatch): string {
  const [a, b] =
    match.open.start < match.close.start ? [match.open, match.close] : [match.close, match.open];
  return (
    escapeHtml(source.slice(0, a.start)) +
    `<span class="file-viewer-bracket-match">${escapeHtml(source.slice(a.start, a.end))}</span>` +
    escapeHtml(source.slice(a.end, b.start)) +
    `<span class="file-viewer-bracket-match">${escapeHtml(source.slice(b.start, b.end))}</span>` +
    escapeHtml(source.slice(b.end))
  );
}

/**
 * Build the persistent TeX delimiter-diagnostic overlay. Every delimiter left
 * without a partner gets a danger-coloured wavy underline; source stays
 * transparent so the syntax layer keeps the glyph itself readable.
 * A range's `hint` rides along in `data-hint`, which is what the hover tooltip
 * reads — a `\begin{itemize}` with no end and an `\end{itemize}` with no begin
 * are different mistakes and say so, rather than sharing one generic message.
 * Ranges are sorted and overlap-pruned defensively (the TeX scanner normally
 * emits disjoint ranges). SECURITY: all source runs and hints are HTML-escaped.
 */
export function decorateUnclosedBrackets(
  source: string,
  ranges: (BracketSide & { hint?: string })[],
): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const range of sorted) {
    const start = Math.max(0, Math.min(range.start, source.length));
    const end = Math.max(start, Math.min(range.end, source.length));
    if (end <= start || start < pos) continue;
    out += escapeHtml(source.slice(pos, start));
    const hint = range.hint ? ` data-hint="${escapeHtml(range.hint)}"` : "";
    out +=
      `<span class="file-viewer-unclosed-bracket"${hint}>` +
      escapeHtml(source.slice(start, end)) +
      "</span>";
    pos = end;
  }
  out += escapeHtml(source.slice(pos));
  return out;
}

/**
 * The `{start, end}` (in `next` coordinates) of the run of text that differs
 * between `prev` and `next`, found by trimming the common prefix and suffix.
 * Used to tint the most-recent edit. Returns `null` when nothing was inserted
 * or replaced — i.e. equal strings, or a pure deletion (whose changed range is
 * zero-width in `next`, so there is nothing to paint).
 */
export function diffRange(prev: string, next: string): { start: number; end: number } | null {
  const span = editSpan(prev, next);
  return span && span.endNext > span.start ? { start: span.start, end: span.endNext } : null;
}

/**
 * The full span of an edit between `prev` and `next`: `start` is the common
 * prefix length, `endPrev`/`endNext` are where the differing run ends in each
 * string (so `prev.slice(start, endPrev)` was replaced by `next.slice(start,
 * endNext)`). Unlike `diffRange` this is reported for deletions too (where
 * `endNext === start`), since the change-tint trail must still re-map older
 * ranges through a deletion. Returns `null` only for equal strings. Pure —
 * exported for tests.
 */
export function editSpan(
  prev: string,
  next: string,
): { start: number; endPrev: number; endNext: number } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, endNext };
}

/** How many recent edit runs the change-tint trail keeps (and how many colour
 *  tiers `themes.css` defines, `.tier-0` … `.tier-(N-1)`). */
export const CHANGE_TIERS = 18;
/** Idle delay before the trail retires its oldest run, in ms — once typing stops
 *  the trail fades a tier at a time over CHANGE_TIERS × this. */
export const CHANGE_DECAY_MS = 1800;

/* The deletion ghosts that used to live here — just-deleted text injected back
   into a transparent overlay in red strike-through, then faded away — are gone
   (2026-09-01). The animation was the expensive half: `fv-delete-fade` animated
   `font-size` down to 0, which is a full relayout of a whole-document <pre> on
   every frame of every deletion, and the overlay itself was re-escaped and
   rebuilt on each keystroke while any ghost lived. The green change trail below
   is the surviving half; it tints ranges that exist, so it never reflows. */

/** One run of recently typed text in the change-tint trail. `tier` is its age:
 *  0 is the newest edit, higher tiers are progressively older (and fainter). */
export interface ChangeRange {
  start: number;
  end: number;
  tier: number;
}

/**
 * Re-map an existing change range through a new edit so it keeps pointing at the
 * same characters: untouched if it sits entirely before the edit, shifted by the
 * length delta if entirely after, and dropped (returns `null`) if it overlaps the
 * edited region (its text was overwritten). Pure — exported for tests.
 */
export function remapChangeRange(
  range: { start: number; end: number },
  span: { start: number; endPrev: number; endNext: number },
): { start: number; end: number } | null {
  const delta = span.endNext - span.endPrev;
  if (range.end <= span.start) return range;
  if (range.start >= span.endPrev) {
    return { start: range.start + delta, end: range.end + delta };
  }
  return null;
}

/**
 * Build the transparent change-tint overlay: each recent edit range is wrapped in
 * `<span class="file-viewer-change-mark tier-N">` so it paints its age-graded
 * tint (tier 0 newest), the rest emitted plain. Ranges must be non-overlapping;
 * they are sorted left-to-right here. SECURITY: every run is HTML-escaped —
 * mirrors `decorateSearchRanges`.
 */
export function decorateChangeRanges(
  source: string,
  ranges: ChangeRange[],
): string {
  const clamped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, source.length)),
      end: Math.max(0, Math.min(r.end, source.length)),
      tier: r.tier,
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (clamped.length === 0) return escapeHtml(source);
  let out = "";
  let pos = 0;
  for (const r of clamped) {
    if (r.start < pos) continue; // defensive: skip any residual overlap
    out += escapeHtml(source.slice(pos, r.start));
    out += `<span class="file-viewer-change-mark tier-${r.tier}">${escapeHtml(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  }
  out += escapeHtml(source.slice(pos));
  return out;
}

/** A grammar issue resolved to a concrete `{start, end}` character range in the
 *  current draft, carrying its originating issue for the tooltip / apply-fix. */
export interface GrammarRange {
  start: number;
  end: number;
  issue: GrammarIssue;
}

/**
 * Resolve each model-reported grammar issue to a character range in `text`. The
 * model reports the offending substring `bad` plus its 1-based `line`; we search
 * that line first (so duplicates of a word map to the right occurrence), then
 * fall back to the whole document, so a small edit since the check doesn't drop
 * every mark. Issues resolve in order with a per-line cursor, so several errors
 * on one line each map to their own occurrence. Unlocatable issues are skipped;
 * the result is sorted by start with overlaps pruned so the decorator's
 * left-to-right walk stays clean. Pure — exported for tests.
 */
export function resolveGrammarRanges(text: string, issues: GrammarIssue[]): GrammarRange[] {
  if (issues.length === 0) return [];
  // 0-based offset where each 1-based line begins (lineStarts[n-1] = line n).
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  // Per-line search cursor so repeated errors on a line advance past each other.
  const lineCursor = new Map<number, number>();
  const out: GrammarRange[] = [];
  for (const issue of issues) {
    const bad = issue.bad;
    if (!bad) continue;
    let start = -1;
    const li = issue.line - 1;
    if (li >= 0 && li < lineStarts.length) {
      const lineStart = lineStarts[li];
      const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] : text.length;
      const from = Math.max(lineStart, lineCursor.get(li) ?? lineStart);
      const idx = text.indexOf(bad, from);
      if (idx >= 0 && idx < lineEnd) {
        start = idx;
        lineCursor.set(li, idx + bad.length);
      }
    }
    if (start < 0) {
      // The reported line drifted since the check — locate it anywhere.
      const idx = text.indexOf(bad);
      if (idx >= 0) start = idx;
    }
    if (start < 0) continue;
    out.push({ start, end: start + bad.length, issue });
  }
  out.sort((a, b) => a.start - b.start);
  const pruned: GrammarRange[] = [];
  let lastEnd = -1;
  for (const r of out) {
    if (r.start < lastEnd) continue; // drop overlaps
    pruned.push(r);
    lastEnd = r.end;
  }
  return pruned;
}

/**
 * Build the transparent grammar overlay: each range is wrapped in a
 * `<span class="file-viewer-grammar-mark cat-<category>" data-gi="<i>">` so it
 * paints a coloured wavy underline (colour by category) while the surrounding
 * text stays plain/transparent. The `data-gi` index ties a span back to its
 * `ranges` entry for hover hit-testing. SECURITY: every run of source text is
 * HTML-escaped before output — mirrors `decorateSearchRanges`.
 */
export function decorateGrammarRanges(source: string, ranges: GrammarRange[]): string {
  if (ranges.length === 0) return escapeHtml(source);
  let out = "";
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtml(source.slice(pos, r.start));
    const cat =
      r.issue.category === "spelling" || r.issue.category === "style"
        ? r.issue.category
        : "grammar";
    out += `<span class="file-viewer-grammar-mark cat-${cat}" data-gi="${i}">${escapeHtml(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  });
  out += escapeHtml(source.slice(pos));
  return out;
}

/**
 * Replace each `{start, end}` range in `text` with `replacement`, returning the
 * new string (#67 find-and-replace). Ranges are applied left-to-right; any that
 * overlap an already-consumed range (or are empty) are skipped, mirroring the
 * non-overlapping match set `findMatches` produces. Pure — exported for testing.
 */
export function applyReplacements(
  text: string,
  ranges: { start: number; end: number }[],
  replacement: string,
): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= r.end) continue;
    out += text.slice(pos, r.start) + replacement;
    pos = r.end;
  }
  out += text.slice(pos);
  return out;
}
