import { useMemo } from "react";
import { ViewerHeader } from "./fileViewer/ViewerHeader";
import { useReadonlyFile } from "./fileViewer/editableFile";
import { useViewerState } from "./fileViewer/viewerState";
import { openMarkdownTarget } from "./fileViewer/openLinked";
import { escapeHtml } from "../../lib/textSafety";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick } from "../../lib/viewers/markdownLinks";
import { highlight } from "../../lib/viewers/highlight";
import { parseNotebook, type NbOutput, type ParsedNotebook } from "../../lib/viewers/notebook";
import { useT } from "../../lib/i18n";

/**
 * Read-only in-app viewer for Jupyter `.ipynb` notebooks (TODO Group K #40, new
 * viewers). Loads the raw notebook JSON via `useReadonlyFile`, parses it with the
 * pure `parseNotebook` (nbformat v4 subset), and renders the cells top-to-bottom:
 *   - markdown cells via `renderMarkdown` (the sanitizer for this repo — no
 *     DOMPurify), and
 *   - code cells as Python-highlighted blocks followed by their classified
 *     outputs (stream/result text, error tracebacks, and PNG images).
 *
 * SECURITY: every HTML string we set with dangerouslySetInnerHTML comes from
 * `renderMarkdown`, `highlight`, or `escapeHtml`, all of which escape-first.
 * A notebook's `text/html` outputs are never rendered (the parser drops them),
 * and image outputs are limited to base64 PNG data URLs.
 */
export function NotebookView({
  path,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const t = useT();
  // tabKey accepted for call-site parity with the other viewers; the notebook
  // viewer has no persisted reader position to restore yet.
  useViewerState(tabKey);

  const { content, error, loaded } = useReadonlyFile(path);

  // Parse once per content load; guard a malformed notebook so a parse failure
  // shows an error state rather than crashing the pane. `parseNotebook` is itself
  // tolerant (returns an empty notebook on bad JSON), so we additionally flag the
  // "parsed but no cells AND non-empty source" case as a likely bad file.
  const parsed = useMemo<{ nb: ParsedNotebook | null; parseError: string | null }>(() => {
    if (content == null) return { nb: null, parseError: null };
    try {
      const nb = parseNotebook(content);
      if (nb.cells.length === 0 && content.trim().length > 0) {
        return { nb, parseError: t("notebookView.noReadableCells") };
      }
      return { nb, parseError: null };
    } catch (e) {
      return { nb: null, parseError: String(e) };
    }
  }, [content, t]);

  return (
    <div className="file-viewer notebook-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally} />
      {/* Links in markdown cells: anchors scroll, local files open in a tab,
          nothing navigates the app window away (threat recheck gap 38). */}
      <div
        className="notebook-viewer-body"
        onClick={(e) =>
          onMarkdownLinkClick(e, { basePath: path, open: openMarkdownTarget(tabKey, path) })
        }
      >
        {error != null ? (
          <div className="file-viewer-error">{t("notebookView.failedToLoad", { error })}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : parsed.parseError ? (
          <div className="file-viewer-error">{parsed.parseError}</div>
        ) : parsed.nb ? (
          parsed.nb.cells.map((cell, idx) =>
            cell.type === "markdown" ? (
              <div
                key={idx}
                className="notebook-cell notebook-cell-md"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source) }}
              />
            ) : (
              <CodeCell key={idx} source={cell.source} outputs={cell.outputs ?? []} />
            ),
          )
        ) : null}
      </div>
    </div>
  );
}

/** A single code cell: the Python-highlighted source followed by its outputs. */
function CodeCell({ source, outputs }: { source: string; outputs: NbOutput[] }) {
  const t = useT();
  // highlight() returns safe HTML, or null when it declines (too large); fall
  // back to escaped plain text in that case. Both branches are escape-first.
  const codeHtml = useMemo(() => highlight(source, "python"), [source]);
  return (
    <div className="notebook-cell notebook-cell-code">
      <pre className="notebook-code">
        {codeHtml != null ? (
          <code dangerouslySetInnerHTML={{ __html: codeHtml }} />
        ) : (
          <code dangerouslySetInnerHTML={{ __html: escapeHtml(source) }} />
        )}
      </pre>
      {outputs.map((out, i) =>
        out.kind === "image" ? (
          <img
            key={i}
            className="notebook-output notebook-output-image"
            src={`data:image/png;base64,${out.pngBase64 ?? ""}`}
            alt={t("notebookView.cellOutputAlt")}
          />
        ) : (
          <pre
            key={i}
            className="notebook-output notebook-output-text"
            dangerouslySetInnerHTML={{ __html: escapeHtml(out.text ?? "") }}
          />
        ),
      )}
    </div>
  );
}
