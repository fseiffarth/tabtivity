import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { SELF, type PageList, type PageRef } from "../../../lib/viewers/pageModel";

/**
 * While marking, a read-only rail of the pages: a click goes there, a dot says
 * the page carries marks. The arranging rail stays off — marks and an
 * arrangement edit never mix. Only the document's own pages are listed.
 * `thumb` draws a page's picture (the viewer's `PdfThumb`).
 */
export function PdfMarkupPageRail({ pages, marked, visiblePage, onJump, thumb }: {
  pages: PageList;
  /** Whether the document's page `page` (1-based) carries marks. */
  marked: (page: number) => boolean;
  /** The 1-based place of the page on screen. */
  visiblePage: number;
  onJump: (page: number) => void;
  thumb: (ref: PageRef) => ReactNode;
}) {
  const t = useT();
  return (
    <nav className="file-viewer-pdf-markup-pages" aria-label={t("pdfMarkup.pages")}>
      {pages.map((ref, i) => {
        if (ref.src !== SELF) return null;
        const dot = marked(ref.page);
        const label = dot ? t("pdfMarkup.pageMarked", { n: ref.page }) : t("pdfViewer.pageOf", { n: ref.page });
        return (
          <button
            key={ref.id}
            type="button"
            className={`file-viewer-pdf-markup-page${visiblePage === i + 1 ? " active" : ""}`}
            aria-current={visiblePage === i + 1 ? "page" : undefined}
            aria-label={label}
            title={label}
            onClick={() => onJump(ref.page)}
          >
            <span className="file-viewer-pdf-markup-page-card">
              {thumb(ref)}
              {dot && <span className="file-viewer-pdf-markup-page-dot" aria-hidden="true" />}
            </span>
            <span className="file-viewer-pdf-markup-page-n">{i + 1}</span>
          </button>
        );
      })}
    </nav>
  );
}
