/**
 * The page-arrangement model shared by the print preview and the PDF viewer's
 * page rail.
 *
 * An arrangement is a plain ordered list of {@link PageRef}s — one entry per sheet,
 * in the order it appears. Every operation is pure and returns a new list, so a
 * history stack is just an array of lists, and rendering is a straight map.
 *
 * Each entry carries its OWN id, source and rotation. That is the whole point, and
 * it is what the print preview's earlier model (`order: number[]` plus rotations
 * keyed by original page number) could not express:
 *
 *   - `src` lets one arrangement draw pages from SEVERAL documents, which is what
 *     merging a second PDF needs.
 *   - `rot` per entry lets a duplicated page be turned independently of its twin;
 *     keyed by original page number, both copies would have turned together.
 *   - the operations take a SET of ids, so a multi-selection moves as one block.
 *
 * The print preview is the degenerate case: every entry has `src === SELF`, and the
 * list starts as the identity mapping over the document's own pages.
 */

/** Which document an entry's page comes from. */
export type SourceId = string;

/** The source id of the document the arrangement belongs to (the file on disk). */
export const SELF: SourceId = "self";

/** A quarter-turn multiple. Anything else is not representable in a PDF's /Rotate. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * An area of a sheet to black out, in big points at scale 1 in the sheet's *rotated*
 * space (top-left origin) — the same coordinates the Ctrl+F hits, the SyncTeX
 * highlight and the link boxes are stored in, so one `bigPointsToCssRect` positions
 * all of them and a mark follows zoom and rotation for free.
 *
 * A mark is a *pending* redaction: it is drawn over the page while the arrangement
 * is being edited and only becomes real at save, where the sheet carrying it is
 * flattened (see `pdf/pdfDoc`'s `buildPdf`). Covering text with a black rectangle
 * is the classic redaction failure — the glyphs stay in the content stream and come
 * straight back out of any copy/extract — so nothing here ever draws a box *into* a
 * PDF.
 */
export interface RedactRect {
  /** Unique within its sheet — the key a click removes one by. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One box of a highlighted run of text, in the same big-point, top-left,
 *  already-rotated space every other overlay in the viewer lives in. A highlight
 *  covers one of these per line, which is why it is a list and not a rectangle. */
export interface PdfQuad {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A remark on a sheet, anchored at a point in big points at scale 1 in the sheet's
 * *rotated* space (top-left origin), i.e. the same coordinates the blackout marks,
 * the Ctrl+F hits and the link boxes use.
 *
 * Unlike a mark, a remark is not a pending destruction but a pending *addition*, and
 * it is written into the file as one of the PDF's own annotations — so a remark made
 * here is a remark every other PDF reader shows. See `lib/viewers/pdfNotes` for why a
 * sheet's remarks are owned all-or-nothing, and `pdf/notes.ts` for the annotations
 * they are read from.
 *
 * There are **two** of them and `quads` is the whole distinction: without it a remark
 * is a sticky note at a point (`/Text`), with it a highlight over the words those
 * boxes cover (`/Highlight`), whose remark is that annotation's own `/Contents`. One
 * shape rather than two, because everything around a remark — the ownership rule, the
 * baseline, the panel, the walk, the undo history, the autosave gate, the save — is
 * the same question for both, and a second parallel model would be a second chance for
 * those answers to disagree.
 */
export interface PdfNote {
  /** Unique within its sheet; written out as the annotation's `/NM`. */
  id: string;
  /** Where the remark sits: the note icon's top-left corner for a sticky note, the
   *  start of the highlighted text for a highlight. What the reading order, the card's
   *  position and the panel's walk are all measured from. */
  x: number;
  y: number;
  /** The boxes the highlight covers, one per line — absent on a sticky note. A
   *  highlight is written as a `/Highlight` annotation over exactly these. */
  quads?: PdfQuad[];
  /** The words under a highlight, as the selection read them. Display only: it is
   *  what the panel shows for a highlight nobody has written a remark on yet, and it
   *  is deliberately NOT written into the file — the words are already on the page,
   *  and a copy of them in the annotation would be a second version of the sentence
   *  that stops being true the moment the document is edited. */
  quote?: string;
  /** The pdf.js id of the annotation this was read from, for a remark that came out
   *  of the file. Used for exactly one thing — stopping the page render from painting
   *  the file's own copy of a highlight underneath ours — and never written. */
  srcId?: string;
  /** What the remark says. Empty is a real state for a **highlight** (marking a
   *  sentence is worth doing on its own); for a sticky note it means "delete me",
   *  since a blank marker is indistinguishable from a bug in the next reader. */
  text: string;
  /** Who wrote it (`/T`). Absent unless somebody typed one: Tabtivity has no name of
   *  the reader's to offer, and taking one from the OS login would put a real
   *  identity into a document that leaves the machine. */
  author?: string;
  /** PDF date strings, as read and as written (`/CreationDate`, `/M`). */
  created?: string;
  modified?: string;
  /** The `/Name` icon a viewer draws (`Comment`, `Note`, `Help`…). Kept as read so a
   *  foreign note re-saved through here still looks like itself. */
  icon?: string;
  /** `/C`, as RGB in 0..1. Kept for the same reason. */
  color?: [number, number, number];
}

/** One sheet in an arrangement: a 1-based page of some source, at some rotation. */
export interface PageRef {
  /** Unique within its list, and stable across moves — selection keys off it. */
  id: string;
  src: SourceId;
  /** 1-based page number *within `src`*. */
  page: number;
  rot: Rotation;
  /** Areas to black out. Absent (not `[]`) on a sheet nobody has redacted, so an
   *  untouched arrangement stays byte-identical to what it always was. Marks ride
   *  ON the entry rather than in a side map so they travel with the sheet through
   *  every op here — a moved page keeps its blackouts, a duplicate gets its own
   *  copy of them, and undo/redo needs no second history. */
  marks?: RedactRect[];
  /** The sheet's remarks (#pdf-notes), for a sheet whose remarks the arrangement has
   *  taken over — absent (not `[]`) while the file's own annotations are merely being
   *  displayed, which is what keeps an untouched page's comments out of a save's way.
   *  `[]` is a real state: every remark on the sheet was deleted. Rides on the entry
   *  for `marks`' reason. */
  notes?: PdfNote[];
}

/** An arrangement: the sheets, in order. The single source of truth. */
export type PageList = PageRef[];

// Ids only have to be unique within one list, so a counter is enough — and unlike a
// random id it keeps tests readable and diffs stable.
let nextId = 0;

/** A fresh entry id. */
export function newPageId(): string {
  nextId += 1;
  return `p${nextId}`;
}

/** The identity arrangement over a document's own pages — the starting point. */
export function initialPages(pageCount: number, src: SourceId = SELF): PageList {
  return Array.from({ length: Math.max(0, pageCount) }, (_, i) => ({
    id: newPageId(),
    src,
    page: i + 1,
    rot: 0 as Rotation,
  }));
}

/**
 * Carry the OLD arrangement's entry ids into a fresh identity arrangement over
 * the same file — what a recompile needs, and nothing else.
 *
 * A reload of the same path replaces the arrangement with a new identity one.
 * The ids are what the viewer keys its page components by, so minting fresh ones
 * unmounts and remounts every page — new canvas elements, no pixels, a blank
 * document until each one has rendered again. That is the flash a LaTeX build
 * used to put on screen. Keeping the id keeps the canvas, which is what lets the
 * page render decide (by fingerprint) that it has nothing to repaint at all.
 *
 * An id is reused only where the old entry at that index was the identity entry
 * for the same sheet — same source, same page number, unturned. Anywhere else
 * (the old list was reordered or turned, the document grew) the entry is new, so
 * a kept canvas can never end up standing for a different page than it painted.
 */
export function keepPageIds(prev: PageList, next: PageList): PageList {
  return next.map((ref, i) => {
    const old = prev[i];
    const reusable =
      old != null &&
      old.src === ref.src &&
      old.page === ref.page &&
      old.rot === ref.rot &&
      old.marks == null &&
      old.notes == null;
    return reusable ? { ...ref, id: old.id } : ref;
  });
}

/** Build entries for `pageCount` pages of `src` — the pages a merge splices in. */
export function pagesOf(src: SourceId, pageCount: number): PageList {
  return initialPages(pageCount, src);
}

/**
 * Move every entry in `ids` so the block lands at `toIndex`.
 *
 * `toIndex` counts the entries that are NOT being moved — it is an index into the
 * list with the selection already taken out ("insert before the `toIndex`-th
 * survivor"; `>= survivors` appends). That is the index a drag naturally produces,
 * because the dragged cards are exactly the ones the pointer is not hit-testing
 * against, and it is the convention the print strip has always used.
 *
 * The moved entries keep their relative order, so dragging a multi-selection moves
 * it as a block rather than collapsing it.
 */
export function movePages(list: PageList, ids: readonly string[], toIndex: number): PageList {
  const moving = new Set(ids);
  const selected = list.filter((r) => moving.has(r.id));
  if (selected.length === 0) return [...list];
  const rest = list.filter((r) => !moving.has(r.id));
  const at = Math.min(Math.max(toIndex, 0), rest.length);
  return [...rest.slice(0, at), ...selected, ...rest.slice(at)];
}

/** Drop every entry in `ids`. Unknown ids are ignored. */
export function deletePages(list: PageList, ids: readonly string[]): PageList {
  const dropping = new Set(ids);
  return list.filter((r) => !dropping.has(r.id));
}

/**
 * Turn every entry in `ids` by `by` degrees (default a quarter turn clockwise).
 * Wraps, so four turns is a full circle back to upright.
 */
export function rotatePages(list: PageList, ids: readonly string[], by = 90): PageList {
  const turning = new Set(ids);
  return list.map((r) =>
    turning.has(r.id)
      ? { ...r, rot: ((((r.rot + by) % 360) + 360) % 360) as Rotation }
      : r,
  );
}

/**
 * Copy every entry in `ids`, placing each copy right after its original. Copies get
 * fresh ids, so they select, move and rotate independently of the pages they came
 * from.
 */
export function duplicatePages(list: PageList, ids: readonly string[]): PageList {
  const copying = new Set(ids);
  return list.flatMap((r) =>
    // The copy gets its OWN marks array: the ops in `lib/viewers/redact` are all
    // pure, so sharing it would be safe today, but a shared array is exactly the
    // kind of aliasing that makes a later in-place edit black out two sheets.
    copying.has(r.id)
      ? [
          r,
          {
            ...r,
            id: newPageId(),
            ...(r.marks ? { marks: [...r.marks] } : {}),
            // A highlight's `quads` is copied too, not shared: the twin's remarks are
            // its own from here on, and a list held in common would make an edit to
            // one sheet's highlight an edit to the other's.
            ...(r.notes
              ? { notes: r.notes.map((n) => ({ ...n, ...(n.quads ? { quads: n.quads.map((q) => ({ ...q })) } : {}) })) }
              : {}),
          },
        ]
      : [r],
  );
}

/**
 * Splice `refs` in before the entry at `atIndex` (`>= list.length` appends). The
 * refs are re-id'd, so inserting the same pages twice — or pages that came from
 * this very list — never collides.
 */
export function insertPages(list: PageList, refs: PageList, atIndex: number): PageList {
  const at = Math.min(Math.max(atIndex, 0), list.length);
  const fresh = refs.map((r) => ({ ...r, id: newPageId() }));
  return [...list.slice(0, at), ...fresh, ...list.slice(at)];
}

/**
 * True when `list` is still the untouched identity arrangement over a `pageCount`-page
 * document: same length, original order, nothing turned, nothing merged in, nothing
 * marked for blacking out, no sheet's remarks taken over. Drives the "Reset pages"
 * affordance and the viewer's dirty marker.
 *
 * `notes` is tested for *presence*, not for content: it is only ever set by a remark
 * being added, edited or deleted (see `lib/viewers/pdfNotes`), so a sheet holding one
 * is a sheet that was edited — and undo, which restores an earlier list, takes the
 * key away again with it.
 */
export function isPristine(list: PageList, pageCount: number): boolean {
  return (
    list.length === pageCount &&
    list.every(
      (r, i) =>
        r.src === SELF && r.page === i + 1 && r.rot === 0 && !r.marks?.length && !r.notes,
    )
  );
}

/**
 * True when the ONLY thing edited about `list` is its remarks: the identity
 * arrangement, nothing turned, nothing merged in, nothing marked for blacking out —
 * but sheets may have taken their remarks over.
 *
 * This is what autosaving a remark is gated on. A save writes the whole arrangement,
 * so an autosave fired by a comment would otherwise also commit a page reorder the
 * reader was still deciding about, or — worse — flatten a sheet somebody had drawn a
 * blackout on, which is the one edit in this viewer that cannot be undone. Writing a
 * remark on its own is safe in a way that writing "everything pending" is not, so the
 * two are told apart here rather than by the caller's memory of what it changed last.
 */
export function isPristineExceptNotes(list: PageList, pageCount: number): boolean {
  return (
    list.length === pageCount &&
    list.every((r, i) => r.src === SELF && r.page === i + 1 && r.rot === 0 && !r.marks?.length)
  );
}
