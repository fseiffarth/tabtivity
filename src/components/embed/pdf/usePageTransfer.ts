/** The PDF viewer's page transfer: merging another PDF in, dragging pages to and from
 *  other viewers (any window), and the spring-loaded rail that makes every open PDF a
 *  drop target while a page drag is in flight. */
import { useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readFileBytes } from "../../../lib/files/fileAccess";
import { insertPages, deletePages, pagesOf, type PageList } from "../../../lib/viewers/pageModel";
import { openSource, newSourceId, buildPdf, type PdfSources } from "./pdfDoc";
import { subscribePageDragActive, type PageTransfer } from "../../../stores/drag/pdfDrag";
import { useProjectsStore } from "../../../stores/projects";
import {
  BOX_SCOPE_PREFIX,
  boxMembersOfScope,
  boxScopeId,
  useBoxesStore,
} from "../../../stores/boxes";
import { basename } from "../../../lib/paths";
import { useT } from "../../../lib/i18n";

/**
 * Merges and drops are arrangement edits on fresh sources; a drag-out parks the built
 * pages in the backend page clipboard. The rail subscription lives on the viewer,
 * not on the strip, because the strip only exists while the rail is open.
 */
export function usePageTransfer({
  scope,
  pages,
  pagesRef,
  sourcesRef,
  setSources,
  selection,
  applyEdit,
  redactDpi,
  stripMeta,
  setEditError,
  railOpenRef,
  railAutoOpenedRef,
  setRailOpen,
  markingRef,
}: {
  scope: string | null;
  pages: PageList;
  pagesRef: React.MutableRefObject<PageList>;
  /** The authoritative source map (the load effect's cleanup frees from it). */
  sourcesRef: React.MutableRefObject<PdfSources>;
  setSources: (sources: PdfSources) => void;
  /** The rail's selection: an insert lands after its last sheet. */
  selection: Set<string>;
  /** Record an undoable arrangement edit. */
  applyEdit: (next: PageList) => void;
  redactDpi: number;
  stripMeta: boolean;
  setEditError: (msg: string | null) => void;
  railOpenRef: React.MutableRefObject<boolean>;
  /** Whether this feature opened the rail, and so may close it again. */
  railAutoOpenedRef: React.MutableRefObject<boolean>;
  setRailOpen: (open: boolean) => void;
  /** Marking up holds the arrangement still: no rail, so no drop target. */
  markingRef: React.MutableRefObject<boolean>;
}) {
  const t = useT();
  // ── Merge: splice another PDF's pages into this arrangement ──────────────
  // (`pdfProjectDir` — the project tree the picker lists — is declared beside the
  // region-capture mode above, which files its screenshots by the same answer.)

  // BOX scope (#41 Phase 5): the merge picker offers EVERY root the scope can
  // read — the box folder plus each member project's tree — with a root
  // selector row, so a merge can pull pages from another member's PDF.
  // Single-project scopes get no `roots` and are unchanged.
  const pdfPickerRoots = useMemo(() => {
    if (!scope || !scope.startsWith(BOX_SCOPE_PREFIX)) return null;
    const { boxes } = useBoxesStore.getState();
    const { projects } = useProjectsStore.getState();
    const box = boxes.find((b) => boxScopeId(b.id) === scope);
    if (!box) return null;
    const roots: { label: string; dir: string }[] = [];
    if (box.folder) roots.push({ label: box.name, dir: box.folder });
    for (const m of boxMembersOfScope(scope, boxes, projects)) {
      roots.push({ label: m.name, dir: m.dir });
    }
    return roots.length > 0 ? roots : null;
  }, [scope]);

  /** Where an insert lands: after the last selected sheet, else at the end. */
  const insertAt = useCallback(() => {
    if (selection.size === 0) return pages.length;
    let last = -1;
    pages.forEach((r, i) => {
      if (selection.has(r.id)) last = i;
    });
    return last < 0 ? pages.length : last + 1;
  }, [pages, selection]);

  /** Open a PDF's bytes as a new source and splice all of its pages in at `at`. */
  const spliceIn = useCallback(
    async (bytes: Uint8Array, at: number) => {
      const src = await openSource(bytes);
      const id = newSourceId();
      // The ref is authoritative (the load effect's cleanup frees from it), so it
      // and the state map are updated together.
      sourcesRef.current = new Map(sourcesRef.current).set(id, src);
      setSources(sourcesRef.current);
      applyEdit(insertPages(pagesRef.current, pagesOf(id, src.doc.numPages), at));
    },
    [applyEdit, pagesRef, setSources, sourcesRef],
  );

  /** Read a PDF from the project and splice all of its pages in. */
  const mergePdf = useCallback(
    async (abs: string) => {
      setEditError(null);
      try {
        // `readFileBytes` already hands back a fresh `Uint8Array` that owns its
        // buffer, which is what `openSource` needs (pdf.js detaches it) — copying
        // it again would only double a whole document in memory.
        await spliceIn(await readFileBytes(abs, scope), insertAt());
      } catch (e) {
        setEditError(
          t("pdfViewer.insertFailed", { name: basename(abs), msg: e instanceof Error ? e.message : String(e) }),
        );
      }
    },
    [scope, spliceIn, insertAt, t, setEditError],
  );

  // ── Dragging pages to another PDF viewer, in this window or another ──────
  // The bytes cannot ride a JS object across a window boundary (separate WebViews,
  // separate heaps), so the dragged pages are built into a small PDF and parked in the
  // backend page clipboard; the drag carries only its token. See `stores/drag/pdfDrag`.

  /** Build the dragged pages into a standalone PDF and park it for the drop. */
  const exportPages = useCallback(
    async (ids: string[]): Promise<PageTransfer | null> => {
      const picked = pagesRef.current.filter((r) => ids.includes(r.id));
      if (picked.length === 0) return null;
      try {
        // A dragged-out page carries its blackouts BURNED IN, not as pending marks:
        // the bytes are what lands in the other viewer (or the other window), and a
        // mark that travelled as an editable overlay would arrive as a page whose
        // text is still there under a black box.
        // Pending metadata deletion travels with the pages for the blackouts'
        // reason: these bytes are what lands in the other viewer, and a page that
        // arrived carrying the XMP packet its reader had just asked to be rid of
        // would put it back into a document they never associated it with.
        const bytes = await buildPdf(picked, sourcesRef.current, {
          emptyMsg: t("pdfViewer.pdfBuildEmpty"),
          sourceClosedMsg: t("pdfViewer.pdfSourceClosed"),
          redactDpi,
          stripMetadata: stripMeta,
        });
        const token = await invoke<string>("pdf_clip_set", { bytes: Array.from(bytes) });
        return { token, count: picked.length };
      } catch (e) {
        setEditError(
          t("pdfViewer.copyPagesFailed", { msg: e instanceof Error ? e.message : String(e) }),
        );
        return null;
      }
    },
    [redactDpi, stripMeta, t, pagesRef, setEditError, sourcesRef],
  );

  /** Take pages dragged out of another viewer and splice them in at `index`. */
  const importPages = useCallback(
    (transfer: PageTransfer, index: number) => {
      // Pages landed here, so the rail is now showing something the reader asked for
      // — it stays open when the drag ends, however it came to be open. Set
      // SYNCHRONOUSLY, before the await below: the close is only deferred by a
      // macrotask, and the fetch takes far longer than that.
      railAutoOpenedRef.current = false;
      void (async () => {
        try {
          const bytes = await invoke<number[]>("pdf_clip_get", { token: transfer.token });
          await spliceIn(new Uint8Array(bytes), index);
        } catch (e) {
          setEditError(
            t("pdfViewer.insertPagesFailed", { msg: e instanceof Error ? e.message : String(e) }),
          );
        }
      })();
    },
    [spliceIn, t, railAutoOpenedRef, setEditError],
  );

  /** The dragged pages were MOVED (Shift) and the drop was acknowledged: drop them. */
  const dropMovedPages = useCallback(
    (ids: string[]) => {
      applyEdit(deletePages(pagesRef.current, ids));
    },
    [applyEdit, pagesRef],
  );

  // ── The spring-loaded rail ───────────────────────────────────────────────
  // Dragging pages needs a rail at BOTH ends, and the rail starts closed — so the
  // feature used to require arming every document by hand before it could be a
  // destination, which is a setup step nobody discovers. Instead: while a page drag
  // is in flight, every open PDF shows its rail, and puts it away again afterwards
  // unless pages actually landed in it.
  //
  // This lives on the VIEWER, not on the strip, and that is the whole point — the
  // strip only exists while the rail is open, so a strip-level subscription could
  // never hear the drag that ought to open it.
  useEffect(
    () =>
      subscribePageDragActive((active) => {
        if (active) {
          if (railOpenRef.current) return; // already the reader's own choice
          // Marking up holds the arrangement still: no rail, so no drop target.
          if (markingRef.current) return;
          railAutoOpenedRef.current = true;
          setRailOpen(true);
          return;
        }
        if (!railAutoOpenedRef.current) return; // the reader opened it — leave it
        // Deferred by a macrotask because a drop in ANOTHER window is delivered to
        // two listeners on one event — this one and the strip's — in registration
        // order, not in the order the work depends on. Closing here could therefore
        // unmount the very strip that is about to claim the pages. `onImport` clears
        // the flag synchronously, so by the time this runs a claimed rail stays open.
        setTimeout(() => {
          if (!railAutoOpenedRef.current) return;
          railAutoOpenedRef.current = false;
          setRailOpen(false);
        }, 0);
      }),
    [markingRef, railAutoOpenedRef, railOpenRef, setRailOpen],
  );

  return { pdfPickerRoots, mergePdf, exportPages, importPages, dropMovedPages };
}
