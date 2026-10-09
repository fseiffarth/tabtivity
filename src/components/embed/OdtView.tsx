import { useCallback, useEffect, useRef, useState } from "react";
import { ViewerHeader, useViewerState } from "./FileViewerPane";
import { useFileScope, usePaneVisible, readFileBytes, fileMtime } from "./fileAccess";
import { extractOdt, renderOdtDocument } from "../../lib/viewers/odt";
import { unzipOdt } from "../../lib/viewers/odtArchive";
import { useT } from "../../lib/i18n";

// Re-read the file this long after an external change is detected (mirrors the
// other viewers' diff-aware reload cadence).
const RELOAD_POLL_MS = 1500;

/**
 * Read-only in-app viewer for OpenDocument Text (`.odt`) files (#51, lightweight
 * approach). An `.odt` is a ZIP, so it's loaded as raw bytes via `read_file_bytes`
 * (not `read_file_text`), unzipped in-process (`unzipOdt`: bounded, only the parts
 * the renderer reads), and rendered to safe
 * HTML by the pure `renderOdtDocument`. Like the table/notebook viewers it polls
 * `file_mtime` and silently re-renders when the document changes on disk.
 *
 * SECURITY: the injected HTML comes solely from `renderOdtDocument`, which builds
 * it tag-by-tag from a whitelist and escapes all text/attributes (no DOMPurify) —
 * see the module header. The faithful path remains "Open externally".
 */
export function OdtView({
  path,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const t = useT();
  // tabKey accepted for call-site parity; no persisted reader position yet.
  useViewerState(tabKey);
  const scope = useFileScope();
  const paneVisible = usePaneVisible();

  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastMtime = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const bytes = await readFileBytes(path, scope);
      // Only the parts the renderer reads, within a size budget (#869).
      const entries = unzipOdt(new Uint8Array(bytes));
      const { contentXml, images } = extractOdt(entries);
      setHtml(renderOdtDocument(contentXml, { images }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [path, scope]);

  // Initial load + mtime baseline.
  useEffect(() => {
    setHtml(null);
    setError(null);
    lastMtime.current = null;
    void load();
    fileMtime(path, scope)
      .then((m) => { lastMtime.current = m; })
      .catch(() => {});
  }, [path, scope, load]);

  // Diff-aware reload: poll mtime; re-render on an external advance. Visible
  // panes only (hidden ones stay mounted forever); the immediate check on
  // re-show catches a change made while the pane was hidden.
  useEffect(() => {
    if (html == null || !paneVisible) return;
    let cancelled = false;
    const check = () => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          void load();
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, html, paneVisible, load]);

  const loaded = html != null;
  return (
    <div className="file-viewer odt-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally} />
      <div className="odt-viewer-body">
        {error != null ? (
          <div className="file-viewer-error">{t("odtView.failedToRender", { error })}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : html.trim().length === 0 ? (
          <div className="file-viewer-loading">{t("odtView.empty")}</div>
        ) : (
          <div className="odt-document" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
