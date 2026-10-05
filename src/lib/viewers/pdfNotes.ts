/**
 * Remarks on a PDF — the sticky notes every other PDF reader calls comments — as an
 * arrangement edit. The pure half; the annotations they are read from and written
 * back to are `pdf/notes.ts`'s and `pdf/pdfDoc.ts`'s.
 *
 * Two things decide the shape of this module.
 *
 * **A remark is a real PDF annotation, not a sidecar.** It is read out of the file's
 * own `/Text` annotations and written back into them, so a remark made here opens in
 * Acrobat, Okular and a browser's viewer, and one made *there* opens here. Nothing is
 * stored beside the document, which is the whole point: a comment that only Tabtivity
 * can see is a comment that may as well not have been written.
 *
 * **A sheet's remarks are owned all-or-nothing.** `PageRef.notes` is absent on a sheet
 * nobody has remarked on — the file's own annotations are simply displayed — and the
 * moment one is added, edited or deleted the *whole* set for that sheet is adopted
 * into the arrangement (`baseline` is the file's own, passed into every op here). A
 * save then rewrites that sheet's `/Text` annotations from this list and leaves every
 * other page's untouched.
 *
 * The alternative — tracking per-annotation edits against the file's objects — buys
 * exact preservation of a foreign note's exotic parts (a rich-text body, a reply
 * thread, a custom popup box) at the price of matching annotations across a rewrite,
 * which is the kind of bookkeeping that silently duplicates or drops a comment. The
 * all-or-nothing rule is worse in one narrow case and cannot be wrong in the common
 * one, and it only ever touches a page the reader actually edited a remark on.
 *
 * Notes ride ON the entry, exactly as the blackout marks do, so they travel with a
 * page that is moved, a duplicate gets its own copy, and the viewer's existing
 * undo/redo and dirty flag cover remarks without knowing anything about them.
 */
import type { PageList, PdfNote, PdfQuad } from "./pageModel";

export type { PdfNote, PdfQuad } from "./pageModel";

/** How far apart two remarks' anchors may sit vertically and still count as being on
 *  the same line, in big points — roughly a marker's own height. Used both to order
 *  the walk and to decide which box of a highlight is its first. */
const NOTE_LINE_TOLERANCE = 24;

/**
 * This remark is a **highlight** over words rather than a sticky note at a point.
 *
 * The single test, everywhere: `quads` is the difference, so there is one place that
 * says what a highlight is and no surface can decide it differently. A highlight with
 * an empty `quads` array would be a highlight covering nothing, which is why the array
 * has to be non-empty rather than merely present — a selection that produced no boxes
 * must not become an annotation with no appearance.
 */
export function isHighlight(note: PdfNote): note is PdfNote & { quads: PdfQuad[] } {
  return !!note.quads && note.quads.length > 0;
}

/**
 * Where a highlight's remark hangs off: the top-left of its first line.
 *
 * *First* by reading order (topmost, then leftmost) rather than by the order the boxes
 * arrived in, because that is where the sentence begins — which is where a reader
 * expects its card, and which is the position the panel's walk sorts by. A selection
 * dragged bottom-to-top hands its rects back in either direction, so taking `quads[0]`
 * would put a quarter of all highlights' cards at the wrong end of the sentence.
 *
 * "Same line" is decided by the boxes **overlapping vertically**, not by a fixed
 * tolerance in points: a quad is a line of text, so its own height is the measurement,
 * and the walk's {@link NOTE_LINE_TOLERANCE} — sized for a 22pt marker icon — would
 * read consecutive lines of ordinary body text as one and hand back the leftmost of
 * the two, which is the *second* line's start.
 */
export function quadsAnchor(quads: readonly PdfQuad[]): { x: number; y: number } {
  let best: PdfQuad | null = null;
  for (const q of quads) {
    if (!best) {
      best = q;
      continue;
    }
    const overlap = Math.min(q.y + q.h, best.y + best.h) - Math.max(q.y, best.y);
    const sameLine = overlap > 0.5 * Math.min(q.h, best.h);
    if (sameLine ? q.x < best.x : q.y < best.y) best = q;
  }
  return best ? { x: best.x, y: best.y } : { x: 0, y: 0 };
}

/** The box every quad of a highlight fits inside — its `/Rect`, and where a menu
 *  opened over it is measured from. Empty in, empty out. */
export function quadsBounds(quads: readonly PdfQuad[]): PdfQuad {
  if (quads.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...quads.map((q) => q.x));
  const y = Math.min(...quads.map((q) => q.y));
  const right = Math.max(...quads.map((q) => q.x + q.w));
  const bottom = Math.max(...quads.map((q) => q.y + q.h));
  return { x, y, w: right - x, h: bottom - y };
}

// Note ids only have to be unique within one sheet, so a counter is enough — and
// unlike a random id it keeps tests readable. They are written into the saved file as
// `/NM`, which asks only for uniqueness within the page.
let nextNoteId = 0;

/** A fresh note id. */
export function newNoteId(): string {
  nextNoteId += 1;
  return `n${nextNoteId}`;
}

/**
 * A PDF date string (`D:20240115103000+01'00'`) for a moment — the format `/M` and
 * `/CreationDate` are written in, and the one {@link formatPdfDate} reads back.
 *
 * Written in the machine's own zone, offset and all, because that is what the format
 * is for: a reader elsewhere converts it, and a `Z` would claim a certainty about
 * where the remark was written that we do not have.
 */
export function toPdfDate(at: Date): string {
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offMin = -at.getTimezoneOffset();
  const sign = offMin < 0 ? "-" : "+";
  return (
    `D:${p(at.getFullYear(), 4)}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(offMin) / 60))}'${p(Math.abs(offMin) % 60)}'`
  );
}

/** The remarks the arrangement owns for a sheet, or nothing when it owns none. */
export function notesOf(ref: { notes?: PdfNote[] }): readonly PdfNote[] | undefined {
  return ref.notes;
}

/** How many remarks the whole arrangement is holding. Counts only sheets it owns —
 *  an untouched page's own annotations are the file's, not ours to tally. */
export function noteCount(list: PageList): number {
  return list.reduce((n, r) => n + (r.notes?.length ?? 0), 0);
}

/** How many sheets a save would rewrite the remarks of. */
export function notedSheetCount(list: PageList): number {
  return list.reduce((n, r) => n + (r.notes ? 1 : 0), 0);
}

/**
 * One remark, placed: which sheet it is on and which entry owns that sheet. What the
 * remarks panel walks, and the only shape in which a remark is addressable from
 * outside the page that draws it.
 */
export interface PlacedNote {
  /** The arrangement entry the remark sits on — what an edit is addressed by. */
  entryId: string;
  /** 1-based position in the arrangement, i.e. the sheet number on screen. */
  sheet: number;
  note: PdfNote;
}

/**
 * Every remark in the whole arrangement, in the order a reader would meet them:
 * sheet by sheet, and within a sheet down the page and then across it.
 *
 * `fileNotes` is the file's own remarks per sheet, indexed as `list` is — what the
 * page canvases read out of the annotations. A sheet the arrangement has taken over
 * uses its own set instead, which is the same precedence the page draws with, so the
 * panel and the page can never disagree about what is on a sheet; a sheet with
 * neither (nothing read yet) contributes nothing rather than an empty guess.
 *
 * Reading order rather than file order, because that is what "go through the remarks"
 * means to somebody reading: an annotation array is in whatever order the producer
 * wrote it, so two comments a paragraph apart can arrive in either sequence. `y`
 * first, then `x`, at a coarse line tolerance so two remarks pinned beside each other
 * on one line are not swapped by a point of vertical drift.
 */
export function placedNotes(
  list: PageList,
  fileNotes: readonly (readonly PdfNote[] | undefined)[] = [],
): PlacedNote[] {
  const out: PlacedNote[] = [];
  list.forEach((ref, i) => {
    const notes = ref.notes ?? fileNotes[i];
    if (!notes || notes.length === 0) return;
    const inOrder = [...notes].sort((a, b) =>
      Math.abs(a.y - b.y) > NOTE_LINE_TOLERANCE ? a.y - b.y : a.x - b.x,
    );
    for (const note of inOrder) out.push({ entryId: ref.id, sheet: i + 1, note });
  });
  return out;
}

/** Where `noteId` sits in a walk of the remarks, or -1. The panel's "which one am I
 *  on" and its next/previous step both read it, so the two cannot drift apart. */
export function noteIndexOf(placed: readonly PlacedNote[], noteId: string | null): number {
  if (!noteId) return -1;
  return placed.findIndex((p) => p.note.id === noteId);
}

/**
 * The remark `step` places on from `noteId` — the next one, the previous one, and
 * from nowhere in particular the first (or, stepping back, the last).
 *
 * Wraps, because a document's remarks are a ring you walk rather than a list with an
 * end to fall off: reaching the last one and pressing Next again is how a reader
 * checks they have been through all of them.
 */
export function stepNote(
  placed: readonly PlacedNote[],
  noteId: string | null,
  step: 1 | -1,
): PlacedNote | null {
  if (placed.length === 0) return null;
  const at = noteIndexOf(placed, noteId);
  if (at < 0) return step === 1 ? placed[0] : placed[placed.length - 1];
  return placed[(at + step + placed.length) % placed.length];
}

/**
 * Rewrite one sheet's remarks, adopting the file's own (`baseline`) first if the
 * arrangement was not already holding them. The one place `notes` is ever set, so
 * "touching a remark takes ownership of the page's set" is true by construction.
 */
function withNotes(
  list: PageList,
  entryId: string,
  baseline: readonly PdfNote[],
  fn: (notes: readonly PdfNote[]) => PdfNote[],
): PageList {
  return list.map((r) => (r.id === entryId ? { ...r, notes: fn(r.notes ?? baseline) } : r));
}

/**
 * Add a remark to a sheet.
 *
 * An empty **sticky note** is not a remark — the caller drops those before they reach
 * here, and this refuses the rest, because a blank marker in the saved file is
 * indistinguishable from a bug in whatever viewer opens it next. An empty
 * **highlight** is the ordinary case and is kept: marking a sentence is a complete act
 * on its own, and the remark is the optional half of it.
 */
export function addNote(
  list: PageList,
  entryId: string,
  baseline: readonly PdfNote[],
  note: PdfNote,
): PageList {
  if (!note.text.trim() && !isHighlight(note)) return list;
  return withNotes(list, entryId, baseline, (notes) => [...notes, note]);
}

/** Change what a remark says (and when it last changed). Unknown ids are ignored. */
export function updateNote(
  list: PageList,
  entryId: string,
  baseline: readonly PdfNote[],
  noteId: string,
  patch: Partial<Omit<PdfNote, "id">>,
): PageList {
  return withNotes(list, entryId, baseline, (notes) =>
    notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n)),
  );
}

/** Drop one remark. The sheet keeps its (now shorter, possibly empty) owned set —
 *  that is what tells the save to write the page's remarks out again without it. */
export function removeNote(
  list: PageList,
  entryId: string,
  baseline: readonly PdfNote[],
  noteId: string,
): PageList {
  return withNotes(list, entryId, baseline, (notes) => notes.filter((n) => n.id !== noteId));
}
