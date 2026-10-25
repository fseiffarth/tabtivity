/**
 * Remarks on a page (#pdf-notes) — the markers, the highlights, the right-click menu
 * that places one, and the little card a remark is written in.
 *
 * The gesture is the one every other PDF reader has: **right-click the page, add a
 * remark**, or **select some words and mark them** (`PdfSelectionBar`, whose creations
 * land here as ordinary remarks). There is no tool to arm and no mode to leave, which
 * is why remarks are unlike the blackout tool next door — a blackout is a destructive
 * edit and wants a mode you can see you are in, a comment is a thing you do in the
 * middle of reading.
 *
 * A remark is drawn as one of two things and the model says which (`quads`): a
 * **sticky note** is a pin at a point, a **highlight** is the boxes it covers. That is
 * the only branch in this file, and everything else — the card, the menu, the
 * dismissal rule, the flash the panel walks by — is written once for both, which is
 * the whole reason the two are one model. What the branch does change is real: a
 * highlight has no drag (it is pinned to words, not placed at a point), it has a
 * colour worth changing, its card opens *under* the sentence rather than beside a pin,
 * and clearing its text does not delete it.
 *
 * Purely presentational: every piece of state (which menu is open, which remark is
 * being written) belongs to the page canvas, so the *page* stays the single owner of
 * "what is going on over this sheet" and two overlapping affordances cannot both
 * think they have the pointer.
 *
 * Three rules are this layer's own.
 *
 * A marker is drawn at a **fixed size**, not scaled with the page. It stands for a
 * remark rather than covering an area of the document, so at 400% it should still be
 * a pin and not a poster — the same reason a PDF's own `NoZoom` flag exists.
 *
 * The card **stages the text and commits once**. Every keystroke going through the
 * arrangement would make each letter its own undo step; instead Save (or **Enter**,
 * with Shift+Enter left as the new line) writes one edit, and Escape discards a draft
 * that was never in the file.
 *
 * A press **anywhere else puts the card away**, exactly as the menu beside it is
 * dismissed — the card is a popover over a document being read, and a reader who has
 * clicked back onto the page has finished with it. What it does with the draft is the
 * decided half: a card whose text differs from the file's is **committed** rather than
 * dropped, because a stray click must not cost a sentence and Escape is still there
 * for "never mind"; a card that was merely opened and read only closes, since a commit
 * writes a fresh `modified` stamp and marks the sheet edited, and looking at a remark
 * is not editing one.
 *
 * An **empty remark is not a remark**: saving one with nothing in it deletes it, and a
 * new one that was never typed into is simply dropped. A blank comment marker is
 * indistinguishable from a bug in whatever viewer opens the file next.
 *
 * A marker also **drags to a new spot**, which is the fourth rule and the one that
 * costs something: a right-click places a remark exactly where the pointer was, and
 * where the pointer was is regularly a line off — so without a move, correcting one
 * means deleting the remark and retyping it. The gesture has to share the marker with
 * the click that opens the card, so it is distance that tells them apart
 * ({@link NOTE_DRAG_SLOP}, measured in CSS pixels so it means the same at 40% and at
 * 400%), and the click is swallowed only when the pointer actually travelled. Pointer
 * events with the capture taken on the marker itself, and `pointercancel` treated as
 * an ordinary end, because on this engine a gesture can finish with either.
 */
import { useEffect, useRef, useState } from "react";
import { ContextMenuPortal } from "../../common/ContextMenuPortal";
import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";
import { formatPdfDate, HIGHLIGHT_ALPHA } from "./pdfDoc";
import { HIGHLIGHT_COLORS, HIGHLIGHT_DEFAULT_COLOR, NOTE_ICON_PT } from "./notes";
import { swatchCss } from "./PdfSelectionBar";
import { scrollIntoPdfBox } from "./scrollBox";
import { isHighlight } from "../../../lib/viewers/pdfNotes";
import type { PdfNote } from "../../../lib/viewers/pageModel";
import { CommentIcon } from "../../common/icons/Icon";
import { useUnsavedWork } from "../../../lib/window/unsavedWork";

/** The right-click menu's position: where on screen it opens, where on the page it
 *  was asked for (big points), and the remark it was asked over, if any. */
export interface NoteMenuState {
  clientX: number;
  clientY: number;
  x: number;
  y: number;
  noteId?: string;
}

/** The card that is open: an existing remark, or a draft at a point on the page. */
export interface NoteEditState {
  noteId?: string;
  x: number;
  y: number;
}

/** Where a remark placed by a click at `(x, y)` sits, so the marker lands *under* the
 *  pointer rather than down and to the right of it. Clamped into the page, since a
 *  right-click near the top-left corner would otherwise anchor it outside. */
export function noteAnchorAt(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, x - NOTE_ICON_PT / 2),
    y: Math.max(0, y - NOTE_ICON_PT / 2),
  };
}

/**
 * A dragged marker's anchor, kept on the sheet. Big points in, big points out.
 *
 * The far edge is clamped by the icon's own box rather than by the anchor, so a
 * remark cannot be parked half off the page — the marker would still be *drawn* (it
 * is a fixed-size pin in the page's coordinate space, not a clipped area), but its
 * `/Rect` would run past the media box and every other reader would place it
 * somewhere of its own choosing. A page whose size is not known yet clamps only at
 * the origin, which is the same thing {@link noteAnchorAt} does.
 */
export function clampNoteAnchor(
  x: number,
  y: number,
  pageWidth?: number,
  pageHeight?: number,
): { x: number; y: number } {
  const maxX = pageWidth == null ? Infinity : Math.max(0, pageWidth - NOTE_ICON_PT);
  const maxY = pageHeight == null ? Infinity : Math.max(0, pageHeight - NOTE_ICON_PT);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

/** How far the pointer must travel, in CSS pixels, before pressing a marker is a
 *  move rather than a click that opens its card. Divided by the zoom at the call
 *  site, so the threshold is a distance on screen and not one in the document. */
export const NOTE_DRAG_SLOP = 3;

/** The card's own width in CSS pixels (`.file-viewer-pdf-note-card` plus its border
 *  and padding) — needed here because where the card *fits* decides which side of the
 *  marker it opens on, and CSS cannot answer that before it has been placed. */
const CARD_W = 278;

/**
 * Which side of its marker the card opens on, in CSS pixels from the page's left
 * edge. Right by default, flipped to the left when there is not room — a remark in
 * the right margin is exactly where one is usually written, and a card that opened
 * off the page there would take the horizontal scrollbar with it. Pure, so the one
 * bit of arithmetic that decides it is testable.
 */
export function noteCardLeft(anchorX: number, scale: number, pageWidth?: number): number {
  const right = anchorX * scale + 26;
  if (pageWidth == null || right + CARD_W <= pageWidth * scale) return right;
  return Math.max(0, anchorX * scale - CARD_W - 4);
}

export function PdfNoteLayer({
  notes,
  scale,
  pageWidth,
  pageHeight,
  menu,
  edit,
  focus,
  ready,
  author,
  autosave,
  onMenu,
  onCloseMenu,
  onEdit,
  onSave,
  onMove,
  onRecolor,
  onDelete,
}: {
  /** The remarks on this sheet, as they should be shown: the arrangement's own set
   *  where it has taken the sheet over, else the file's. */
  notes: readonly PdfNote[];
  scale: number;
  /** The sheet's size in big points, when it is known. The width decides which side
   *  of the marker the card opens on; both keep a dragged marker on the sheet. */
  pageWidth?: number;
  pageHeight?: number;
  menu: NoteMenuState | null;
  edit: NoteEditState | null;
  /** The remark the panel is walking through, if it is on this sheet: flashed and
   *  scrolled to. `nonce` re-triggers the flash for a second visit to the same one. */
  focus?: { noteId: string; nonce: number } | null;
  /** The page's own remarks have been read. Placing one before that would take a
   *  baseline of "no remarks" and quietly drop the ones already in the file. */
  ready: boolean;
  /** The name new remarks are signed with, remembered for the viewer's session. */
  author: string;
  /** Remarks are written into the file as they are made, so the card says so. */
  autosave: boolean;
  onMenu: (menu: NoteMenuState) => void;
  onCloseMenu: () => void;
  onEdit: (edit: NoteEditState | null) => void;
  /** Commit: an existing remark by id, or a new one at the draft's anchor. Empty
   *  text means "delete it" for an existing remark and "never mind" for a draft. */
  onSave: (edit: NoteEditState, text: string, author: string) => void;
  /** A marker was dragged to a new anchor (big points, already clamped). */
  onMove: (noteId: string, x: number, y: number) => void;
  /** A highlight was given a different colour. */
  onRecolor?: (noteId: string, color: [number, number, number]) => void;
  onDelete: (noteId: string) => void;
}) {
  const t = useT();
  const byId = (id?: string) => notes.find((n) => n.id === id);
  const open = edit ? byId(edit.noteId) : undefined;
  /** The open remark's first line, when it is a highlight — what puts its card under
   *  the sentence rather than over it, and the only thing the card needs to know
   *  about the difference between the two kinds of remark. */
  const openQuad =
    open && isHighlight(open) ? open.quads.reduce((a, b) => (b.y < a.y ? b : a)) : null;

  // The card's staged text and signature. Re-seeded whenever a different remark is
  // opened — keyed off the identity of what is open rather than reset on close, so
  // reopening the same one shows the file's text and not the last draft.
  const [text, setText] = useState("");
  const [who, setWho] = useState(author);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const editKey = edit ? `${edit.noteId ?? "new"}:${edit.x}:${edit.y}` : null;
  useEffect(() => {
    if (!editKey) return;
    setText(open?.text ?? "");
    setWho(open?.author ?? author);
    // A remark is opened to be written in, so the caret goes in it. Focus after the
    // card has mounted, or the page's own scroll container takes it back.
    const id = window.setTimeout(() => areaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);

  // A card whose remark is no longer on the sheet has nothing left to write to, so it
  // closes rather than sitting open over the page. That happens for an ordinary
  // reason: autosaving writes the file and the viewer re-reads it, which re-mints
  // every remark id — so the card left open across one is addressed at a remark
  // nothing will match, and a Save from it would land nowhere while still marking the
  // sheet as edited.
  useEffect(() => {
    if (edit?.noteId && !open) onEdit(null);
  }, [edit?.noteId, open, onEdit]);

  const commit = () => {
    if (!edit) return;
    onSave(edit, text, who.trim());
    onEdit(null);
  };

  // Whether the card holds anything the file does not. A draft counts only once it has
  // text (an empty one is dropped on commit anyway, and the signature is prefilled, so
  // testing it would make every untouched draft look edited); an existing remark counts
  // on either half, since re-signing one is an edit.
  const dirty = edit
    ? edit.noteId
      ? text !== (open?.text ?? "") || who.trim() !== (open?.author ?? "")
      : text.trim() !== ""
    : false;
  useUnsavedWork(dirty);

  // Put the card away, keeping whatever was written. Held in a ref so the window
  // listener below is bound once per open card rather than re-bound on every
  // keystroke, and so the marker's own click — which never reaches that listener —
  // can dismiss by the same rule instead of a second copy of it.
  const dismissRef = useRef<() => void>(() => {});
  dismissRef.current = () => {
    if (dirty) commit();
    else onEdit(null);
  };

  // A press anywhere outside the card closes it, the way the menu's own dismissal
  // works: presses inside the card (and on a marker) are stopped before they reach
  // the window, so what arrives here is by definition somewhere else.
  useEffect(() => {
    if (!edit) return;
    const away = () => dismissRef.current();
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [edit]);

  // ── Moving a marker ──────────────────────────────────────────────────────
  // Where the pointer went down (client px) and where the marker was then (big
  // points), so a move is a delta rather than a re-anchor under the pointer — grabbing
  // a pin by its corner must not teleport its middle to the cursor.
  //
  // The preview lives in state so the marker follows the pointer, but the commit goes
  // through `onMove` exactly once, at the end: dragging is one undo step, not one per
  // frame. `moved` is a ref rather than state because the click that fires after
  // pointerup has to read it in the same tick.
  const dragFrom = useRef<{ id: string; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const moved = useRef(false);
  const [dragAt, setDragAt] = useState<{ id: string; x: number; y: number } | null>(null);

  const onNoteDown = (e: React.PointerEvent<HTMLButtonElement>, n: PdfNote) => {
    if (e.button !== 0) return;
    // Not `preventDefault`: the marker is a <button> and must stay focusable, so the
    // press is only claimed once it has travelled far enough to be a drag.
    e.stopPropagation();
    // Optional call: jsdom has no pointer capture, and the gesture works without it
    // wherever it is missing — the same guard `YamlTree`'s grip drag uses.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragFrom.current = { id: n.id, clientX: e.clientX, clientY: e.clientY, x: n.x, y: n.y };
    moved.current = false;
  };

  const dragTo = (e: React.PointerEvent<HTMLButtonElement>) => {
    const from = dragFrom.current;
    if (!from) return null;
    const dx = e.clientX - from.clientX;
    const dy = e.clientY - from.clientY;
    if (!moved.current && Math.hypot(dx, dy) < NOTE_DRAG_SLOP) return null;
    moved.current = true;
    return clampNoteAnchor(from.x + dx / scale, from.y + dy / scale, pageWidth, pageHeight);
  };

  const onNoteMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const at = dragTo(e);
    if (at) setDragAt({ id: dragFrom.current!.id, ...at });
  };

  // `pointercancel` ends the gesture the same way `pointerup` does — the trap the tab
  // and card drags document — and commits what was dragged rather than dropping it:
  // a marker that snapped back to where it started would read as a broken drag, and
  // the move is one Ctrl+Z (or one more drag) away from undone either way.
  const onNoteUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const from = dragFrom.current;
    const at = dragTo(e);
    dragFrom.current = null;
    setDragAt(null);
    if (from && at) onMove(from.id, at.x, at.y);
  };

  // The remark the panel is walking through: scrolled to and flashed. Keyed off the
  // nonce so asking for the same one twice flashes it twice.
  const focusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    // Scoped to the reader's scroller: `scrollIntoView` would also scroll the
    // `overflow: hidden` pane hosts above it, displacing the whole pane.
    if (focusRef.current) scrollIntoPdfBox(focusRef.current, "center");
    // Keyed off the request, not the object: the panel re-creates `focus` on every
    // render of the viewer, and scrolling the page under the reader once per render
    // is not what asking for a remark once means.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.noteId, focus?.nonce]);

  return (
    <>
      {notes.map((n) => {
        const label = n.text.trim() || t("pdfNotes.emptyRemark");
        const at = dragAt?.id === n.id ? dragAt : n;
        const isFocus = focus?.noteId === n.id;

        // ── A highlight ──────────────────────────────────────────────────
        // Drawn as the boxes it covers rather than as a pin, because that is what it
        // is: the mark is on the words, and a marker beside them would say a comment
        // exists without saying what it is about. Every box is a button, so a
        // multi-line highlight is clickable along its whole length — and the ones
        // after the first are hidden from the accessibility tree, since a sentence
        // marked across four lines is one remark and not four.
        if (isHighlight(n)) {
          const shade = swatchCss(n.color ?? HIGHLIGHT_DEFAULT_COLOR, HIGHLIGHT_ALPHA);
          return n.quads.map((q, qi) => (
            <button
              key={isFocus ? `${n.id}#${focus!.nonce}:${qi}` : `${n.id}:${qi}`}
              ref={isFocus && qi === 0 ? focusRef : undefined}
              type="button"
              className={
                `file-viewer-pdf-hl${edit?.noteId === n.id ? " is-open" : ""}` +
                `${isFocus ? " is-focus" : ""}${n.text.trim() ? " has-remark" : ""}`
              }
              style={{
                left: q.x * scale,
                top: q.y * scale,
                width: q.w * scale,
                height: q.h * scale,
                background: shade,
              }}
              title={n.author ? `${n.author}: ${label}` : label}
              aria-label={qi === 0 ? t("pdfNotes.highlightLabel") : undefined}
              aria-hidden={qi === 0 ? undefined : true}
              tabIndex={qi === 0 ? undefined : -1}
              // The press is claimed for the marker's reason: it is what dismisses an
              // open card, and letting it through would also start a fresh text
              // selection under the highlight the reader is trying to open.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const same = edit?.noteId === n.id;
                if (edit) dismissRef.current();
                if (!same) onEdit({ noteId: n.id, x: n.x, y: n.y });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onMenu({ clientX: e.clientX, clientY: e.clientY, x: n.x, y: n.y, noteId: n.id });
              }}
            />
          ));
        }

        return (
          <button
            // Keyed by the request while it is the focused one, so walking back to a
            // remark you have already visited flashes it again — a CSS animation on
            // an element that did not change is an animation that does not re-run,
            // and "nothing happened" is exactly the wrong answer to pressing Next.
            key={isFocus ? `${n.id}#${focus!.nonce}` : n.id}
            ref={isFocus ? focusRef : undefined}
            type="button"
            className={
              `file-viewer-pdf-note${edit?.noteId === n.id ? " is-open" : ""}` +
              `${dragAt?.id === n.id ? " is-dragging" : ""}${isFocus ? " is-focus" : ""}`
            }
            style={{ left: at.x * scale, top: at.y * scale }}
            title={n.author ? `${n.author}: ${label}` : label}
            aria-label={t("pdfNotes.markerLabel")}
            onPointerDown={(e) => onNoteDown(e, n)}
            onPointerMove={onNoteMove}
            onPointerUp={onNoteUp}
            onPointerCancel={onNoteUp}
            onClick={(e) => {
              e.stopPropagation();
              // The click that closes a drag is the drag's, not the card's.
              if (moved.current) {
                moved.current = false;
                return;
              }
              // A marker claims its own press (or every dismissal would seed a drag),
              // so the open card is put away here rather than by the window listener —
              // pressing a *second* marker is as much "somewhere else" as the page is,
              // and pressing this one is the toggle it always was.
              const same = edit?.noteId === n.id;
              if (edit) dismissRef.current();
              if (!same) onEdit({ noteId: n.id, x: n.x, y: n.y });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu({ clientX: e.clientX, clientY: e.clientY, x: n.x, y: n.y, noteId: n.id });
            }}
          >
            <CommentIcon />
          </button>
        );
      })}

      {edit && (
        // Anchored beside the marker rather than at the pointer: the card is the
        // remark's body, and a body that opens away from its own pin leaves the
        // reader guessing which one they are writing in.
        //
        // A HIGHLIGHT's card goes *under* its first line instead, flush with where the
        // sentence starts. Beside would mean over the words — a highlight is an area,
        // not a pin, and the one thing the card must not cover is the text the remark
        // is about.
        <div
          className="file-viewer-pdf-note-card"
          style={
            openQuad
              ? {
                  left: Math.max(
                    0,
                    Math.min(edit.x * scale, ((pageWidth ?? Infinity) * scale) - CARD_W),
                  ),
                  top: (edit.y + openQuad.h) * scale + 6,
                }
              : { left: noteCardLeft(edit.x, scale, pageWidth), top: edit.y * scale }
          }
          role="group"
          aria-label={t("pdfNotes.editorLabel")}
          // The card sits over the page; a press inside it must not reach the
          // page beneath.
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onEdit(null);
            } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
              // Enter writes the remark. A remark is a sentence rather than a
              // document, so the key that ends one should finish the job; the new
              // line moves to Shift+Enter, which is where every chat box has taught
              // people to look for it. ⌘/Ctrl+Enter still works — it was the gesture
              // before this, and muscle memory is cheap to honour.
              e.preventDefault();
              commit();
            }
          }}
        >
          {open && (open.author || open.created || open.modified) && (
            <div className="file-viewer-pdf-note-by">
              {open.author && <span className="file-viewer-pdf-note-author">{open.author}</span>}
              {(open.modified || open.created) && (
                <span>{formatPdfDate(open.modified ?? open.created ?? "")}</span>
              )}
            </div>
          )}
          <textarea
            ref={areaRef}
            className="file-viewer-pdf-note-text"
            value={text}
            rows={4}
            placeholder={t("pdfNotes.placeholder")}
            aria-label={t("pdfNotes.textLabel")}
            onChange={(e) => setText(e.target.value)}
          />
          <input
            className="file-viewer-pdf-note-author-input"
            type="text"
            value={who}
            placeholder={t("pdfNotes.authorPlaceholder")}
            aria-label={t("pdfNotes.authorLabel")}
            onChange={(e) => setWho(e.target.value)}
          />
          <div className="file-viewer-pdf-note-actions">
            <button type="button" className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={commit}>
              {t("common.save")}
            </button>
            <button
              type="button"
              className="file-viewer-zoom-btn file-viewer-zoom-text"
              onClick={() => onEdit(null)}
            >
              {t("common.cancel")}
            </button>
            {open && (
              <button
                type="button"
                className="file-viewer-zoom-btn file-viewer-zoom-text file-viewer-pdf-note-del"
                onClick={() => {
                  onDelete(open.id);
                  onEdit(null);
                }}
              >
                {t(openQuad ? "pdfNotes.deleteHighlight" : "pdfNotes.delete")}
              </button>
            )}
          </div>
          {/* The quoted words, for a highlight. Above the hints and below the fields
              because it is not editable and not a control: it says which sentence this
              card is about, which is exactly what a card sitting under a line of text
              at 40% zoom cannot otherwise make obvious. */}
          {openQuad && open?.quote && (
            <div className="file-viewer-pdf-note-quote">{open.quote}</div>
          )}
          {/* Said in the card, once, because it is the one thing about this feature a
              reader cannot check from the screen: the remark goes into the PDF itself
              rather than into a file beside it — and *when* it gets there, which is
              the half autosave changes. A hint that still said "not until Save" while
              the file was being written on every edit would be the wrong sentence in
              exactly the situation a reader would want to trust it. */}
          {/* Enter committing a *multi-line* field is worth one line of chrome: it is
              the one habit here that a textarea otherwise teaches the opposite of, and
              the way back to a new line has to be discoverable from the card itself. */}
          <div className="file-viewer-pdf-note-hint">{t("pdfNotes.keyHint")}</div>
          <div className="file-viewer-pdf-note-hint">
            {t(autosave ? "pdfNotes.nativeHintAuto" : "pdfNotes.nativeHint")}
          </div>
        </div>
      )}

      {menu && (
        <ContextMenuPortal
          x={menu.clientX}
          y={menu.clientY}
          onClose={onCloseMenu}
          className="context-menu file-viewer-pdf-note-menu"
        >
          {menu.noteId ? (
            (() => {
              const target = byId(menu.noteId);
              const hl = target && isHighlight(target);
              return (
                <>
                  <button
                    onClick={() => {
                      onCloseMenu();
                      if (target) onEdit({ noteId: target.id, x: target.x, y: target.y });
                    }}
                  >
                    {t(hl ? "pdfNotes.editHighlight" : "pdfNotes.edit")}
                  </button>
                  {hl ? (
                    // Recolouring is offered here and not in the card, because it is
                    // a property of the mark rather than of what was said about it —
                    // and because a reader who wants a different colour usually
                    // wants it for a highlight already made, not while writing one.
                    <div className="file-viewer-pdf-note-menu-colors" role="group">
                      {HIGHLIGHT_COLORS.map((c, i) => (
                        <button
                          key={i}
                          type="button"
                          className="file-viewer-pdf-sel-swatch"
                          style={{ background: swatchCss(c) }}
                          title={t("pdfNotes.recolor")}
                          aria-label={t("pdfNotes.recolor")}
                          onClick={() => {
                            onCloseMenu();
                            onRecolor?.(target!.id, [...c] as [number, number, number]);
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    // The move has no menu item, because it is not an action taken
                    // from a menu — it is the marker itself. What the menu can do is
                    // say the gesture exists, which nothing on the page otherwise
                    // does. A highlight has no such gesture: it is pinned to words.
                    <div className="context-menu-note">{t("pdfNotes.dragHint")}</div>
                  )}
                  <hr />
                  <button
                    className="danger"
                    onClick={() => {
                      onCloseMenu();
                      if (menu.noteId) onDelete(menu.noteId);
                    }}
                  >
                    {t(hl ? "pdfNotes.deleteHighlight" : "pdfNotes.delete")}
                  </button>
                </>
              );
            })()
          ) : (
            <button
              className="untested"
              disabled={!ready}
              title={ready ? undefined : t("pdfNotes.readingTitle")}
              onClick={() => {
                onCloseMenu();
                onEdit(noteAnchorAt(menu.x, menu.y));
              }}
            >
              {ready ? t("pdfNotes.addHere") : t("pdfNotes.reading")}
              <UntestedTag id="pdfNoteLayer.1" />
            </button>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
}
