export interface DraftRange {
  start: number;
  end: number;
}

/** Separate words at either edge while keeping punctuation and line breaks attached. */
export function replaceDictated(draft: string, range: DraftRange, words: string): string {
  const before = draft.slice(0, range.start);
  const after = draft.slice(range.end);
  const left = before && !/[\s([{]$/u.test(before) && !/^[\s,.;:!?)]/u.test(words) ? " " : "";
  const right = after && !/^[\s,.;:!?)}\]]/u.test(after) && !/\s$/u.test(words) ? " " : "";
  return before + left + words + right + after;
}

/** The changed portion of a user edit, expressed against the previous draft. */
export function draftChange(old: string, draft: string): Splice {
  let head = 0;
  const most = Math.min(old.length, draft.length);
  while (head < most && old[head] === draft[head]) head++;
  let tail = 0;
  while (tail < most - head && old[old.length - 1 - tail] === draft[draft.length - 1 - tail]) tail++;
  return { at: head, removed: old.length - head - tail, inserted: draft.length - head - tail };
}

/** An overlapping edit makes an unattended replacement position ambiguous. */
export function rebaseRange(range: DraftRange, splice: Splice): DraftRange | null {
  if (splice.at + splice.removed <= range.start) {
    const delta = splice.inserted - splice.removed;
    return { start: range.start + delta, end: range.end + delta };
  }
  return splice.at >= range.end ? range : null;
}

// Dictation writes what the speech engine hears into the composer's draft
// while it is still being said. The words of an unsettled segment are
// provisional: each newer partial replaces the segment's previous one, and the
// segment's final replaces it for good (`ProvisionalDraft`). Pure: the
// composer owns the draft and hands it in, this tracks where the spans sit.
//
// A span is tracked by its offset and its own text. A change the user makes
// to the draft is reconciled by a prefix/suffix diff: before a span it shifts
// the span, after it leaves it, and inside it (or anywhere the span no longer
// reads as it was written) ends the tracking, since those words are now the
// user's own.

/** One splice of a draft: `removed` characters at `at` became `inserted`. */
export interface Splice {
  at: number;
  removed: number;
  inserted: number;
}

interface Span {
  original: string;
  words: string;
  segment: number;
  start: number;
  /** What the span put in the draft, a joining space included. */
  text: string;
}

const end = (span: Span) => span.start + span.text.length;

/** Where a caret at `offset` stands after `splice`: a splice at the caret
 * leaves it after the new text (as typing does), one before it moves it, one
 * across it puts it at the new text's end. */
export function shiftOffset(offset: number, splice: Splice): number {
  const { at, removed, inserted } = splice;
  if (offset < at || (offset === at && removed > 0)) return offset;
  if (offset >= at + removed) return offset + inserted - removed;
  return at + inserted;
}

export class ProvisionalDraft {
  private spans: Span[] = [];
  /** The draft the spans' offsets refer to. */
  private seen = "";
  /** Segments whose span the user edited into their own text. */
  private taken = new Set<number>();

  /** Whether any provisional text stands in the draft. */
  get pending(): boolean {
    return this.spans.length > 0;
  }

  /** Forget everything without touching a draft (a session began or ended). */
  reset(): void {
    this.spans = [];
    this.taken.clear();
    this.seen = "";
  }

  /** Reconcile with `draft` as the user (or anything else) left it. */
  sync(draft: string): void {
    const old = this.seen;
    this.seen = draft;
    if (old === draft || !this.spans.length) return;
    const { at: head, removed, inserted } = draftChange(old, draft);
    const changedTo = head + removed;
    const delta = inserted - removed;
    this.spans = this.spans.filter((span) => {
      if (end(span) <= head) return true;
      if (span.start >= changedTo) {
        span.start += delta;
        return true;
      }
      this.taken.add(span.segment);
      return false;
    });
    this.verify();
  }

  /** A span that no longer reads as written is the user's. */
  private verify(): void {
    this.spans = this.spans.filter((span) => {
      if (this.seen.startsWith(span.text, span.start)) return true;
      this.taken.add(span.segment);
      return false;
    });
  }

  /** `before` became `after` by exactly `splice` (a known edit, not left to
   * the diff, which cannot tell where text equal to its neighbour went in). */
  spliced(before: string, after: string, splice: Splice): void {
    this.sync(before);
    const { at, removed, inserted } = splice;
    this.seen = after;
    this.spans = this.spans.filter((span) => {
      if (end(span) <= at) return true;
      if (span.start >= at + removed) {
        span.start += inserted - removed;
        return true;
      }
      this.taken.add(span.segment);
      return false;
    });
    this.verify();
  }

  /** Reserve the selection even when the engine sends a final without a preview. */
  begin(draft: string, segment: number, range: DraftRange): void {
    this.sync(draft);
    if (this.spans.some(span => span.segment === segment) || this.taken.has(segment)) return;
    // A later segment starts after an earlier preview if their ranges overlap.
    let { start, end: finish } = range;
    for (const span of this.spans) {
      if (start < end(span) && finish > span.start) start = finish = end(span);
    }
    const original = draft.slice(start, finish);
    this.spans.push({ segment, start, original, text: original, words: "" });
    this.spans.sort((a, b) => a.start - b.start || a.segment - b.segment);
  }

  /** `segment`'s newest partial: its provisional text replaces the one it
   * had, or goes in where a final would land (the end of the draft). `null`
   * for a segment the user already took over. */
  show(draft: string, segment: number, text: string): { draft: string; splice: Splice } | null {
    this.sync(draft);
    if (this.taken.has(segment)) return null;
    const old = this.spans.find((span) => span.segment === segment);
    const at = old ? old.start : draft.length;
    const removed = old?.text.length ?? 0;
    const next = replaceDictated(draft, { start: at, end: at + removed }, text);
    const inserted = next.length - draft.length + removed;
    const splice: Splice = { at, removed, inserted };
    const piece: Span = { segment, start: at, original: old?.original ?? "", words: text, text: next.slice(at, at + inserted) };
    this.spans = this.spans.filter((span) => span !== old);
    for (const span of this.spans) {
      if (span.start > at || (span.start === at && span.segment > segment)) span.start += inserted - removed;
    }
    this.spans.push(piece);
    this.spans.sort((a, b) => a.start - b.start);
    this.seen = next;
    return { draft: next, splice };
  }

  /** `segment` settled (its final is here): its provisional text leaves the
   * draft. `at` is where the final goes: the span's place, else before the
   * provisional text of a later segment, else (`null`) the end. `taken`: the
   * user made the span their own, so the final's words must not go in again. */
  settle(draft: string, segment: number): { draft: string; splice: Splice | null; at: number | null; taken: boolean; original: string; words: string } {
    this.sync(draft);
    if (this.taken.delete(segment)) return { draft, splice: null, at: null, taken: true, original: "", words: "" };
    const old = this.spans.find((span) => span.segment === segment);
    if (!old) {
      const later = this.spans.find((span) => span.segment > segment);
      return { draft, splice: null, at: later ? later.start : null, taken: false, original: "", words: "" };
    }
    const next = draft.slice(0, old.start) + old.original + draft.slice(end(old));
    const splice: Splice = { at: old.start, removed: old.text.length, inserted: old.original.length };
    this.spans = this.spans.filter((span) => span !== old);
    for (const span of this.spans) if (span.start > old.start || (span.start === old.start && span.segment > segment)) span.start += old.original.length - old.text.length;
    this.seen = next;
    return { draft: next, splice, at: old.start, taken: false, original: old.original, words: old.words };
  }

  /** A potential command stays out of the draft, retaining its insertion range. */
  hide(draft: string, segment: number): { draft: string; splice: Splice | null } {
    this.sync(draft);
    if (this.taken.has(segment)) return { draft, splice: null };
    const result = this.settle(draft, segment);
    if (result.at !== null) {
      this.begin(result.draft, segment, { start: result.at, end: result.at + result.original.length });
    }
    return result;
  }

  /** Every provisional span out of `draft`, and no tracking after; `splices`
   * are the removals in order, for placing a caret. */
  clear(draft: string): { draft: string; splices: Splice[] } {
    this.sync(draft);
    let next = draft;
    const splices: Splice[] = [];
    // Last to first, so each offset still holds.
    for (const span of [...this.spans].reverse()) {
      next = next.slice(0, span.start) + span.original + next.slice(end(span));
      splices.push({ at: span.start, removed: span.text.length, inserted: span.original.length });
    }
    this.reset();
    this.seen = next;
    return { draft: next, splices };
  }

  /** `draft` without its provisional text: what the user has really written. */
  settled(draft: string): string {
    this.sync(draft);
    let next = draft;
    for (const span of [...this.spans].reverse()) next = next.slice(0, span.start) + span.original + next.slice(end(span));
    return next;
  }
}
