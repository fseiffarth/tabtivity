import { useCallback, useEffect, useState } from "react";
import { ViewerHeader } from "./FileViewerPane";
import { useViewerState } from "./fileViewer/viewerState";
import { useFileScope, readFileBytes } from "../../lib/files/fileAccess";
import { useDiskReloadPoll } from "../../lib/useDiskReloadPoll";
import { extractOdt, renderOdtDocument } from "../../lib/viewers/odt";
import { unzipOdt } from "../../lib/viewers/odtArchive";
import { useT } from "../../lib/i18n";

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

  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Initial load.
  useEffect(() => {
    setHtml(null);
    setError(null);
    void load();
  }, [path, scope, load]);

  // Diff-aware reload: re-render on an external write, once the first render landed.
  useDiskReloadPoll(path, scope, () => void load(), { enabled: html != null });

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
