/** The PDF viewer's remarks (#pdf-notes): the file's own remarks read once per sheet,
 *  the remarks panel's walk, the three edits, and the autosave that writes them. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  isPristineExceptNotes,
  type PageList,
  type PageRef,
  type PdfNote,
} from "../../../lib/viewers/pageModel";
import {
  addNote,
  updateNote,
  removeNote,
  noteCount,
  notedSheetCount,
  placedNotes,
  stepNote,
  isHighlight,
  type PlacedNote,
} from "../../../lib/viewers/pdfNotes";
import type { PdfSources } from "./pdfDoc";
import { loadPageNotes } from "./notes";
import type { ViewerPos } from "../fileViewer/viewerState";

/** How long after the last remark edit the file is written, when autosaving remarks
 *  is on (#pdf-notes). Long enough that writing a sentence, correcting it and moving
 *  its marker is one write rather than three; short enough that a reader who closes
 *  the tab straight after typing does not lose the remark. */
const NOTE_AUTOSAVE_MS = 1200;

/**
 * Remarks are arrangement edits (`applyEdit`), each carrying the file's own set on its
 * sheet as the baseline it adopts. The autosave calls the viewer's save through
 * `noteSaveRef`; `writing` guards both saves against writing the file twice at once.
 */
export function usePdfNotes({
  doc,
  pages,
  pagesRef,
  sourcesRef,
  applyEdit,
  viewPos,
  stripMeta,
  staleOnDisk,
}: {
  doc: PDFDocumentProxy | null;
  pages: PageList;
  pagesRef: React.MutableRefObject<PageList>;
  sourcesRef: React.MutableRefObject<PdfSources>;
  /** Record an undoable arrangement edit. */
  applyEdit: (next: PageList) => void;
  viewPos: ViewerPos;
  /** A pending metadata deletion: holds the autosave back. */
  stripMeta: boolean;
  /** The file changed on disk under unsaved edits: holds the autosave back. */
  staleOnDisk: boolean;
}) {
  // ── Remarks (#pdf-notes) ─────────────────────────────────────────────────
  // Writing, changing and deleting a remark are ordinary arrangement edits, for the
  // blackouts' reason: undo/redo, the dirty flag, the save and a page dragged into
  // another document all cover remarks without knowing anything about them. What each
  // one carries in addition is the `baseline` — the file's own remarks on that sheet,
  // as read by the page — because the first edit on a page ADOPTS them; without it a
  // new remark would be the only one the save wrote out.
  /** The name new remarks are signed with. Remembered for the session only, and only
   *  because it was typed: nothing here invents an author, and the OS login is
   *  deliberately not consulted — a document leaves the machine, a real name with it. */
  const [noteAuthor, setNoteAuthor] = useState("");
  // ── The file's own remarks, read once per sheet ──────────────────────────
  // Hoisted out of the page canvas because two things now need the same list and must
  // agree about it: the page, which draws the markers, and the remarks panel, which
  // lists every remark in the document — including on sheets nobody has scrolled to.
  // Ids are minted at the read (a PDF's annotation reference is document-scoped and
  // is rewritten on every save), so two reads of one page produce two sets of ids for
  // the same comments and "go to this remark" would address one the page has never
  // heard of. One read, one owner.
  //
  // Keyed by what the remarks actually depend on — which page, of which document, at
  // which turn — rather than by position in the arrangement, so reordering the sheets
  // moves nothing here and two copies of one page share the file's set until each is
  // edited.
  const noteKey = useCallback((r: PageRef) => `${r.src}:${r.page}:${r.rot}`, []);
  const [fileNotes, setFileNotes] = useState<Map<string, PdfNote[]>>(() => new Map());
  /** Per sheet, the file's own highlight annotations the viewer has taken over the
   *  drawing of — see where it is written for why it is not derived from the map
   *  above. Read by the page canvas as its repaint key. */
  const [hiddenHl, setHiddenHl] = useState<Map<string, string>>(() => new Map());
  // Bumped on every document load: a read still in flight when the file is replaced
  // belongs to the old bytes and must not land on the new ones.
  const noteGen = useRef(0);
  const noteAsked = useRef<Set<string>>(new Set());
  // Dropped DURING RENDER rather than in an effect, which is the one thing about this
  // that is not obvious. Effects flush child-first, so a page canvas asking for its
  // remarks on the commit that loaded a new document would be asking under the *old*
  // generation — its answer discarded by the guard below, its key already marked as
  // asked, and nothing left to ask again. Resetting here means every request in that
  // commit is already the new document's. (React's own "adjust state when a prop
  // changes" shape: the re-render happens before children are committed.)
  const [notesDoc, setNotesDoc] = useState<PDFDocumentProxy | null>(null);
  if (notesDoc !== doc) {
    setNotesDoc(doc);
    setFileNotes(new Map());
    setHiddenHl(new Map());
    noteGen.current += 1;
    noteAsked.current = new Set();
  }
  /** Read the remarks of every named sheet that has not been read yet. Idempotent and
   *  safe to call from a render effect — a sheet is asked for once. */
  const ensureNotes = useCallback((refs: readonly PageRef[]) => {
    const want = refs.map((r) => `${r.src}:${r.page}:${r.rot}`).filter((k, i, all) => {
      if (noteAsked.current.has(k)) return false;
      return all.indexOf(k) === i;
    });
    if (want.length === 0) return;
    for (const k of want) noteAsked.current.add(k);
    const gen = noteGen.current;
    void (async () => {
      const pairs = await Promise.all(
        want.map(async (k) => {
          const cut = k.lastIndexOf(":");
          const mid = k.lastIndexOf(":", cut - 1);
          const src = k.slice(0, mid);
          const d = sourcesRef.current.get(src)?.doc;
          const notes = d
            ? await loadPageNotes(d, Number(k.slice(mid + 1, cut)), Number(k.slice(cut + 1)))
            : [];
          // The viewer draws the highlights it has just read, so the page render must
          // stop drawing the file's own copies of them — see `ANNOT_MODE`. Written
          // here, at the read, because that is the moment the two would start
          // disagreeing, and because a suppression made anywhere else would have to
          // re-derive which annotation each remark came from.
          if (d) {
            for (const n of notes) {
              if (n.srcId) d.annotationStorage.setValue(n.srcId, { noView: true });
            }
          }
          return [k, notes] as const;
        }),
      );
      if (gen !== noteGen.current) return;
      setFileNotes((prev) => {
        const next = new Map(prev);
        for (const [k, v] of pairs) next.set(k, v);
        return next;
      });
      // The repaint key that goes with the suppression above. Held on its own rather
      // than derived from `fileNotes`, and that is not tidiness: an autosave replaces
      // a sheet's cached remarks with the ones it just WROTE, which carry no `srcId`
      // because they were never read from an annotation — so a derived key would empty
      // itself, the page would repaint without the suppression, and the file's
      // original highlights (still in the document object, which a silent save
      // deliberately does not reload) would come back underneath the ones on screen.
      // It is only ever added to, and only the whole map is dropped, when the document
      // is replaced.
      setHiddenHl((prev) => {
        const next = new Map(prev);
        for (const [k, v] of pairs) {
          const ids = v.filter((n) => n.srcId && isHighlight(n)).map((n) => n.srcId!);
          if (ids.length > 0 || !next.has(k)) next.set(k, ids.join(","));
        }
        return next;
      });
    })();
  }, [sourcesRef]);


  // ── The remarks panel (#pdf-notes) ───────────────────────────────────────
  /** The panel is open. While it is, every sheet's remarks are read — that is what
   *  makes it a list of the document rather than of the pages that happen to have
   *  been scrolled past. */
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    if (notesOpen) ensureNotes(pages);
  }, [notesOpen, pages, ensureNotes]);
  /** Every remark in the arrangement, in reading order — the walk's own order. */
  const placed = useMemo(
    () => placedNotes(pages, pages.map((r) => fileNotes.get(noteKey(r)))),
    [pages, fileNotes, noteKey],
  );
  /** The remark the walk is parked on, and the request the page consumes to scroll to
   *  it. Kept as one piece of state so the highlighted row and the flashed marker are
   *  the same remark by construction. */
  const [noteFocus, setNoteFocus] = useState<
    { entryId: string; noteId: string; sheet: number; x: number; y: number; nonce: number; edit: boolean } | null
  >(null);
  const goToNote = useCallback((p: PlacedNote, edit = false) => {
    setNoteFocus((cur) => ({
      entryId: p.entryId,
      noteId: p.note.id,
      sheet: p.sheet,
      x: p.note.x,
      y: p.note.y,
      nonce: (cur?.nonce ?? 0) + 1,
      edit,
    }));
  }, []);
  const stepToNote = useCallback(
    (step: 1 | -1) => {
      const next = stepNote(placed, noteFocus?.noteId ?? null, step);
      if (next) goToNote(next);
    },
    [placed, noteFocus?.noteId, goToNote],
  );

  // ── Autosaving a remark (#pdf-notes) ─────────────────────────────────────
  // A remark is a thing you write while reading, and a reader who writes one has said
  // everything they mean to say about it — so the file is written for them, shortly
  // after they stop, rather than waiting for a Save they have no reason to expect.
  //
  // The safety is entirely in what it REFUSES to carry along. A save writes the whole
  // arrangement, so an autosave that fired with a page move pending would commit the
  // move, and one that fired with a blackout pending would flatten the sheet — the
  // single irreversible edit in this viewer, and one that is deliberately confirmed.
  // Hence the gate: remarks may be the ONLY thing pending (`isPristineExceptNotes`),
  // the file must not have changed underneath, and a pending metadata deletion counts
  // as something else. When it is holding, the panel says so rather than leaving a
  // switch that is on and doing nothing.
  const [autosaveNotes, setAutosaveNotes] = useState(
    () => viewPos.initial?.pdfAutosaveNotes !== false,
  );
  const autosaveRef = useRef(autosaveNotes);
  autosaveRef.current = autosaveNotes;
  const setAutosaveNotesPersisted = useCallback(
    (on: boolean) => {
      setAutosaveNotes(on);
      viewPos.persist({ pdfAutosaveNotes: on });
    },
    [viewPos],
  );
  /** Can an autosave run right now? Read by the panel, and re-derived at the timer
   *  from the refs below — this is the display copy, that one is the decision. */
  const notesAutosavable =
    doc != null && !stripMeta && !staleOnDisk && isPristineExceptNotes(pages, doc.numPages);
  const docRef = useRef(doc);
  docRef.current = doc;
  /** A write is in flight. A ref rather than the `saving` flag, because that one is
   *  now only the *button's* spinner — a silent save deliberately does not raise it —
   *  and the "don't write the same file twice at once" guard has to cover both. */
  const writing = useRef(false);
  /** A silent (remark) save is in flight. Shown in the remarks panel and nowhere
   *  else. */
  const [autosaving, setAutosaving] = useState(false);
  const staleRef = useRef(staleOnDisk);
  staleRef.current = staleOnDisk;
  const stripMetaRef = useRef(stripMeta);
  stripMetaRef.current = stripMeta;
  /** Set after `handleSave` is defined; calling it is what a scheduled autosave does. */
  const noteSaveRef = useRef<(() => void) | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (autosaveTimer.current != null) window.clearTimeout(autosaveTimer.current);
    },
    [],
  );
  /** Write the pending remarks shortly after the last one is made. Debounced rather
   *  than immediate because a remark is typically one of several — moving three
   *  markers should be one write of the file, not three. */
  const scheduleNoteAutosave = useCallback(() => {
    if (!autosaveRef.current) return;
    if (autosaveTimer.current != null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      if (!autosaveRef.current) return;
      const d = docRef.current;
      const list = pagesRef.current;
      if (!d || notedSheetCount(list) === 0) return;
      if (stripMetaRef.current || staleRef.current) return;
      if (!isPristineExceptNotes(list, d.numPages)) return;
      // A save already running has its own bytes in flight; wait it out rather than
      // queueing a second write of the same file.
      if (writing.current) {
        scheduleNoteAutosave();
        return;
      }
      noteSaveRef.current?.();
    }, NOTE_AUTOSAVE_MS);
  }, [pagesRef]);

  // The three edits themselves. Ordinary arrangement edits (see above), each followed
  // by the autosave nudge — which is where writing-on-its-own is armed for *every*
  // way a remark can change, rather than at the card, which is only one of them.
  const addPdfNote = useCallback(
    (entryId: string, note: PdfNote, baseline: readonly PdfNote[]) => {
      if (note.author) setNoteAuthor(note.author);
      applyEdit(addNote(pagesRef.current, entryId, baseline, note));
      scheduleNoteAutosave();
    },
    [applyEdit, scheduleNoteAutosave, pagesRef],
  );
  const updatePdfNote = useCallback(
    (
      entryId: string,
      noteId: string,
      patch: Partial<Omit<PdfNote, "id">>,
      baseline: readonly PdfNote[],
    ) => {
      if (patch.author) setNoteAuthor(patch.author);
      applyEdit(updateNote(pagesRef.current, entryId, baseline, noteId, patch));
      scheduleNoteAutosave();
    },
    [applyEdit, scheduleNoteAutosave, pagesRef],
  );
  const deletePdfNote = useCallback(
    (entryId: string, noteId: string, baseline: readonly PdfNote[]) => {
      applyEdit(removeNote(pagesRef.current, entryId, baseline, noteId));
      scheduleNoteAutosave();
    },
    [applyEdit, scheduleNoteAutosave, pagesRef],
  );
  /** How many remarks a save would write out. Only sheets the arrangement has taken
   *  over are counted — an untouched page's remarks are the file's own and are copied
   *  across rather than rewritten. */
  const notesTotal = noteCount(pages);
  /** How many sheets a save would rewrite the remarks of. Not the same question as
   *  the count above, and it is the one that decides whether anything is pending at
   *  all: deleting the last remark on a page leaves nothing to count and still has to
   *  be written. */
  const notedSheets = notedSheetCount(pages);

  return {
    noteAuthor,
    noteKey,
    fileNotes,
    setFileNotes,
    hiddenHl,
    ensureNotes,
    notesOpen,
    setNotesOpen,
    placed,
    noteFocus,
    setNoteFocus,
    goToNote,
    stepToNote,
    autosaveNotes,
    setAutosaveNotesPersisted,
    notesAutosavable,
    writing,
    autosaving,
    setAutosaving,
    noteSaveRef,
    addPdfNote,
    updatePdfNote,
    deletePdfNote,
    notesTotal,
    notedSheets,
  };
}
