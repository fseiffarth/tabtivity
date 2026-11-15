import { spliceSpaced } from "../terminal/terminalDrop";

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
    let head = 0;
    const most = Math.min(old.length, draft.length);
    while (head < most && old[head] === draft[head]) head++;
    let tail = 0;
    while (tail < most - head && old[old.length - 1 - tail] === draft[draft.length - 1 - tail]) tail++;
    const changedTo = old.length - tail;
    const delta = draft.length - old.length;
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

  /** `segment`'s newest partial: its provisional text replaces the one it
   * had, or goes in where a final would land (the end of the draft). `null`
   * for a segment the user already took over. */
  show(draft: string, segment: number, text: string): { draft: string; splice: Splice } | null {
    this.sync(draft);
    if (this.taken.has(segment)) return null;
    const old = this.spans.find((span) => span.segment === segment);
    const rest = old ? draft.slice(0, old.start) + draft.slice(end(old)) : draft;
    const at = old ? old.start : draft.length;
    const next = spliceSpaced(rest, at, text);
    const inserted = next.length - rest.length;
    const splice: Splice = { at, removed: old ? old.text.length : 0, inserted };
    const piece: Span = { segment, start: at, text: next.slice(at, at + inserted) };
    this.spans = this.spans.filter((span) => span !== old);
    for (const span of this.spans) if (span.start >= at) span.start += inserted - splice.removed;
    this.spans.push(piece);
    this.spans.sort((a, b) => a.start - b.start);
    this.seen = next;
    return { draft: next, splice };
  }

  /** `segment` settled (its final is here): its provisional text leaves the
   * draft. `at` is where the final goes: the span's place, else before the
   * provisional text of a later segment, else (`null`) the end. `taken`: the
   * user made the span their own, so the final's words must not go in again. */
  settle(draft: string, segment: number): { draft: string; splice: Splice | null; at: number | null; taken: boolean } {
    this.sync(draft);
    if (this.taken.delete(segment)) return { draft, splice: null, at: null, taken: true };
    const old = this.spans.find((span) => span.segment === segment);
    if (!old) {
      const later = this.spans.find((span) => span.segment > segment);
      return { draft, splice: null, at: later ? later.start : null, taken: false };
    }
    const next = draft.slice(0, old.start) + draft.slice(end(old));
    const splice: Splice = { at: old.start, removed: old.text.length, inserted: 0 };
    this.spans = this.spans.filter((span) => span !== old);
    for (const span of this.spans) if (span.start >= old.start) span.start -= old.text.length;
    this.seen = next;
    return { draft: next, splice, at: old.start, taken: false };
  }

  /** Every provisional span out of `draft`, and no tracking after; `splices`
   * are the removals in order, for placing a caret. */
  clear(draft: string): { draft: string; splices: Splice[] } {
    this.sync(draft);
    let next = draft;
    const splices: Splice[] = [];
    // Last to first, so each offset still holds.
    for (const span of [...this.spans].reverse()) {
      next = next.slice(0, span.start) + next.slice(end(span));
      splices.push({ at: span.start, removed: span.text.length, inserted: 0 });
    }
    this.reset();
    this.seen = next;
    return { draft: next, splices };
  }

  /** `draft` without its provisional text: what the user has really written. */
  settled(draft: string): string {
    this.sync(draft);
    let next = draft;
    for (const span of [...this.spans].reverse()) next = next.slice(0, span.start) + next.slice(end(span));
    return next;
  }
}
