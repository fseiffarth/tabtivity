/** The PDF viewer's form filling (#pdf-forms): the document's field index, what was
 *  typed, which sheets must repaint for it, Tab between fields, and the dirty flag
 *  the save and the autosave read. The model is `formFields.ts`. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ViewerPos } from "../fileViewer/viewerState";
import {
  fieldEntries,
  fieldIndexOf,
  fieldWrites,
  sameFormValue,
  stepIndex,
  type FieldIndex,
  type FieldObjects,
  type FormValue,
  type PdfFormField,
} from "./formFields";

/** A request to open one field's editor, consumed by the sheet holding it. */
export interface FieldFocus {
  id: string;
  /** 1-based file page the field is on. */
  page: number;
  nonce: number;
}

/** One entry of the document's Tab order. */
interface OrderEntry {
  id: string;
  page: number;
  top: number;
  left: number;
}

/**
 * Values live in two places on purpose. The document's annotation storage is what
 * the page render paints from and what the save writes; the React map here is what
 * tells the viewer that something is pending and which sheets to repaint. Every
 * write goes through {@link commit}, which keeps the two the same.
 */
export function usePdfForm({
  doc,
  viewPos,
  onEdit,
  jumpToFilePage,
}: {
  doc: PDFDocumentProxy | null;
  viewPos: ViewerPos;
  /** A value changed: hold the source bytes and arm the autosave. */
  onEdit: () => void;
  /** Scroll the sheet showing this file page into view (Tab to a far field). */
  jumpToFilePage: (page: number) => void;
}) {
  const [index, setIndex] = useState<FieldIndex | null>(null);
  const [order, setOrder] = useState<OrderEntry[]>([]);
  const [values, setValues] = useState<ReadonlyMap<string, FormValue>>(() => new Map());
  const valuesRef = useRef(values);
  valuesRef.current = values;
  /** Bumped by every edit; `savedRev` is the one a save last wrote. */
  const [rev, setRev] = useState(0);
  const revRef = useRef(0);
  revRef.current = rev;
  const [savedRev, setSavedRev] = useState(0);
  /** Per file page, a counter the sheet's canvas repaints on. */
  const [pageRevs, setPageRevs] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [focus, setFocus] = useState<FieldFocus | null>(null);

  // A new document is a fresh start, reset DURING RENDER for `usePdfNotes`'s reason:
  // a sheet asking on the commit that loaded the document must already see the new
  // state. The values typed into the old one are in the file now (a save reloads)
  // or were discarded with it (Reload).
  const [formDoc, setFormDoc] = useState<PDFDocumentProxy | null>(null);
  if (formDoc !== doc) {
    setFormDoc(doc);
    setIndex(null);
    setOrder([]);
    setValues(new Map());
    setRev(0);
    setSavedRev(0);
    setPageRevs(new Map());
    setFocus(null);
  }

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      let objects: FieldObjects = null;
      try {
        objects = (await doc.getFieldObjects()) as FieldObjects;
      } catch {
        objects = null;
      }
      if (cancelled) return;
      const idx = fieldIndexOf(objects);
      setIndex(idx);
      // The Tab order, document-wide: by page, then top to bottom, then left to
      // right in the page's own space. Read-only and hidden widgets are skipped,
      // as the sheets skip them.
      const entries: OrderEntry[] = [];
      if (objects && idx) {
        const fillable = new Set([...idx.values()].flatMap((l) => l.map((r) => r.id)));
        for (const [, list] of fieldEntries(objects)) {
          for (const o of list as { id?: string; page?: number; rect?: number[]; editable?: boolean; hidden?: boolean; type?: string }[]) {
            if (!o?.id || typeof o.page !== "number" || !Array.isArray(o.rect)) continue;
            if (o.editable === false || o.hidden) continue;
            if (!fillable.has(o.id)) continue;
            entries.push({
              id: o.id,
              page: o.page + 1,
              top: Math.max(o.rect[1], o.rect[3]),
              left: Math.min(o.rect[0], o.rect[2]),
            });
          }
        }
      }
      entries.sort((a, b) =>
        a.page !== b.page ? a.page - b.page : Math.abs(a.top - b.top) > 4 ? b.top - a.top : a.left - b.left,
      );
      setOrder(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  /** The page each widget is on, for the repaint after a write to a sibling. */
  const pageOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of order) m.set(e.id, e.page);
    return m;
  }, [order]);

  const valueOf = useCallback(
    (field: PdfFormField): FormValue => values.get(field.id) ?? field.initial,
    [values],
  );

  /** Set a field's value — and its twins', document-wide — and repaint their sheets. */
  const commit = useCallback(
    (field: PdfFormField, value: FormValue) => {
      if (!doc) return;
      const current = valuesRef.current.get(field.id) ?? field.initial;
      if (sameFormValue(current, value)) return;
      const writes = fieldWrites(field, value, index ?? new Map());
      const next = new Map(valuesRef.current);
      const touched = new Set<number>([field.rect.page]);
      for (const [id, v] of writes) {
        doc.annotationStorage.setValue(id, { value: Array.isArray(v) ? [...v] : v });
        next.set(id, v);
        const p = pageOf.get(id);
        if (p != null) touched.add(p);
      }
      valuesRef.current = next;
      setValues(next);
      setRev((r) => r + 1);
      setPageRevs((prev) => {
        const m = new Map(prev);
        for (const p of touched) m.set(p, (m.get(p) ?? 0) + 1);
        return m;
      });
      onEdit();
    },
    [doc, index, pageOf, onEdit],
  );

  /** Tab / Shift+Tab from a field: open the next one, on whichever page it is. */
  const step = useCallback(
    (fromId: string, dir: 1 | -1) => {
      if (order.length === 0) return;
      const to = order[stepIndex(order.findIndex((e) => e.id === fromId), dir, order.length)];
      if (!to) return;
      setFocus((cur) => ({ id: to.id, page: to.page, nonce: (cur?.nonce ?? 0) + 1 }));
      jumpToFilePage(to.page);
    },
    [order, jumpToFilePage],
  );

  // ── Tinting the fields ───────────────────────────────────────────────────
  const [highlight, setHighlight] = useState(() => viewPos.initial?.pdfHighlightFields !== false);
  const setHighlightPersisted = useCallback(
    (on: boolean) => {
      setHighlight(on);
      viewPos.persist({ pdfHighlightFields: on });
    },
    [viewPos],
  );

  const formDirty = rev !== savedRev;
  const formDirtyRef = useRef(formDirty);
  formDirtyRef.current = formDirty;

  /** A save wrote the values as they stood at `writtenRev`. */
  const markSaved = useCallback((writtenRev: number) => setSavedRev(writtenRev), []);

  return {
    hasForm: index != null,
    values,
    valuesRef,
    valueOf,
    commit,
    pageRevs,
    focus,
    step,
    highlight,
    setHighlight: setHighlightPersisted,
    formDirty,
    formDirtyRef,
    revRef,
    markSaved,
  };
}
