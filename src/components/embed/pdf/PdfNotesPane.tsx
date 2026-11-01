/**
 * The remarks panel (#pdf-notes) — every comment in the document in one list, and the
 * way to walk them.
 *
 * The markers on the page answer "is there a comment here?"; they cannot answer "what
 * did anyone say about this paper?", because the answer is spread over forty sheets
 * and each marker holds its text behind a click. That is what this pane is for: it is
 * the *reading* surface, so a row carries the whole remark rather than a preview, and
 * the page is where the remark sits rather than where it is read.
 *
 * Three decisions.
 *
 * **Next/Previous walk a ring**, and the row that is current is the one the walk is
 * parked on — reaching the last remark and pressing Next again brings you back to the
 * first, which is how a reader checks they have been through all of them. The order
 * is the document's own reading order (`placedNotes`), never the annotation array's.
 *
 * **A row goes to the remark; it does not open it.** Clicking scrolls the page to the
 * marker and flashes it, because the text is already here — opening the card as well
 * would put a focused textarea over the page for somebody who only wanted to see
 * where the comment was. ✎ is the separate, deliberate act of editing one.
 *
 * **Autosave is stated, not assumed.** The switch lives here rather than in the
 * toolbar because this is where remarks are worked on, and the line under it says
 * exactly what the guarantee is worth: remarks are written on their own, but a page
 * move or a blackout is never carried along by one. That asymmetry is the whole
 * safety of the feature (see `pageModel`'s `isPristineExceptNotes`) and it is not
 * something a reader could otherwise find out.
 */
import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";
import { formatPdfDate } from "./pdfDoc";
import { HIGHLIGHT_DEFAULT_COLOR } from "./notes";
import { swatchCss } from "./PdfSelectionBar";
import { isHighlight, type PlacedNote } from "../../../lib/viewers/pdfNotes";
import { CloseIcon, PencilIcon } from "../../common/icons/Icon";

export function PdfNotesPane({
  placed,
  currentId,
  autosave,
  autosavable,
  saving,
  onSetAutosave,
  onGo,
  onStep,
  onEditNote,
  onDeleteNote,
  onClose,
}: {
  /** Every remark in the arrangement, in reading order. */
  placed: readonly PlacedNote[];
  /** The remark the walk is parked on, if any. */
  currentId: string | null;
  autosave: boolean;
  /** Autosave *can* run right now: nothing but remarks is pending. False means the
   *  switch is on and holding, which has to be said — a promise that is quietly not
   *  being kept is worse than one that was never made. */
  autosavable: boolean;
  saving: boolean;
  onSetAutosave: (on: boolean) => void;
  onGo: (p: PlacedNote) => void;
  onStep: (step: 1 | -1) => void;
  onEditNote: (p: PlacedNote) => void;
  onDeleteNote: (p: PlacedNote) => void;
  onClose: () => void;
}) {
  const t = useT();
  const at = placed.findIndex((p) => p.note.id === currentId);

  return (
    <div className="file-viewer-pdf-outline file-viewer-pdf-notes-pane">
      <div className="file-viewer-pdf-outline-head">
        <span>{t("pdfNotes.paneHeader")}</span>
        <span className="file-viewer-pdf-notes-count">{placed.length}</span>
        <UntestedTag id="pdfNotesPane.1" />
        <button
          className="file-viewer-zoom-btn file-viewer-pdf-notes-close"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="file-viewer-pdf-notes-walk" role="group" aria-label={t("pdfNotes.walkLabel")}>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => onStep(-1)}
          disabled={placed.length === 0}
          title={t("pdfNotes.prevTitle")}
          aria-label={t("pdfNotes.prevTitle")}
        >
          ↑
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => onStep(1)}
          disabled={placed.length === 0}
          title={t("pdfNotes.nextTitle")}
          aria-label={t("pdfNotes.nextTitle")}
        >
          ↓
        </button>
        <span className="file-viewer-pdf-notes-pos" aria-live="polite">
          {placed.length === 0 ? "" : at >= 0 ? `${at + 1}/${placed.length}` : `–/${placed.length}`}
        </span>
      </div>
      <div className="file-viewer-pdf-outline-body">
        {placed.length === 0 ? (
          <div className="file-viewer-pdf-outline-empty">{t("pdfNotes.paneEmpty")}</div>
        ) : (
          placed.map((p) => {
            const stamp = p.note.modified ?? p.note.created;
            const hl = isHighlight(p.note);
            return (
              <div
                key={`${p.entryId}:${p.note.id}`}
                className={`file-viewer-pdf-notes-row${p.note.id === currentId ? " current" : ""}`}
              >
                <button
                  className="file-viewer-pdf-notes-body"
                  onClick={() => onGo(p)}
                  title={t("pdfNotes.goToTitle", { page: p.sheet })}
                >
                  <span className="file-viewer-pdf-notes-meta">
                    <span className="file-viewer-pdf-notes-sheet">{p.sheet}</span>
                    {/* A swatch, not a word: what tells two highlights apart in this
                        list is the colour the reader marked them in, and it is the
                        only thing about a highlight that is not already in the row. */}
                    {hl && (
                      <span
                        className="file-viewer-pdf-notes-swatch"
                        style={{ background: swatchCss(p.note.color ?? HIGHLIGHT_DEFAULT_COLOR) }}
                        title={t("pdfNotes.highlightLabel")}
                        aria-label={t("pdfNotes.highlightLabel")}
                      />
                    )}
                    {p.note.author && (
                      <span className="file-viewer-pdf-notes-author">{p.note.author}</span>
                    )}
                    {stamp && (
                      <span className="file-viewer-pdf-notes-date">{formatPdfDate(stamp)}</span>
                    )}
                  </span>
                  {/* What a highlight covers, above whatever was said about it. It is
                      the reason the row exists at all for a highlight nobody has
                      remarked on — and even where there is a remark, "…the estimator
                      is unbiased" is what makes "but only for i.i.d. samples" mean
                      anything two weeks later. Quoted from the selection that made it,
                      so it is absent for a highlight read out of a file somebody else
                      wrote, where the row falls back to the remark alone. */}
                  {hl && p.note.quote && (
                    <span className="file-viewer-pdf-notes-quote">{p.note.quote}</span>
                  )}
                  {/* The whole remark, wrapped — this pane is where remarks are read,
                      so a truncated one would send the reader back to the marker it
                      was supposed to save them opening. An empty one is named rather
                      than rendered as a blank row nobody can tell from a broken one —
                      except on a highlight, where having nothing to say is ordinary
                      and the quote above is already the row's content. */}
                  {(!hl || p.note.text.trim() || !p.note.quote) && (
                    <span className="file-viewer-pdf-notes-text">
                      {p.note.text.trim() || t("pdfNotes.emptyRemark")}
                    </span>
                  )}
                </button>
                <div className="file-viewer-pdf-notes-actions">
                  <button
                    className="file-viewer-zoom-btn"
                    onClick={() => onEditNote(p)}
                    title={t(hl ? "pdfNotes.editHighlight" : "pdfNotes.edit")}
                    aria-label={t(hl ? "pdfNotes.editHighlight" : "pdfNotes.edit")}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className="file-viewer-zoom-btn file-viewer-pdf-note-del"
                    onClick={() => onDeleteNote(p)}
                    title={t(hl ? "pdfNotes.deleteHighlight" : "pdfNotes.delete")}
                    aria-label={t(hl ? "pdfNotes.deleteHighlight" : "pdfNotes.delete")}
                  >
                    <CloseIcon />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="file-viewer-pdf-notes-foot">
        <label className="file-viewer-pdf-redact-opt">
          <input
            type="checkbox"
            checked={autosave}
            onChange={(e) => onSetAutosave(e.target.checked)}
          />
          {t("pdfNotes.autosave")}
          {saving && <span className="file-viewer-pdf-notes-saving">{t("pdfNotes.saving")}</span>}
        </label>
        <div className="file-viewer-pdf-note-hint">
          {t(autosave ? "pdfNotes.autosaveHint" : "pdfNotes.autosaveOffHint")}
        </div>
        {autosave && !autosavable && (
          <div className="file-viewer-pdf-redact-warn">{t("pdfNotes.autosaveHeld")}</div>
        )}
      </div>
    </div>
  );
}
