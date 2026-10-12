import { useModalFocus } from "../../hooks/useModalFocus";
import { createPortal } from "react-dom";
import { formatDownloadSize, stripControls } from "../../lib/browser";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import type { DownloadRequest } from "../../types/browser";
import { WarningIcon } from "../common/icons/Icon";

/**
 * The download consent dialog.
 *
 * **No download happens without this, and this names no path.** The bytes are
 * already quarantined in a directory the *backend* chose; pressing Save makes
 * the backend raise the native OS save dialog with the sanitized filename
 * pre-filled, and the single path in the whole system is the one the user picks
 * there. Cancel deletes the quarantined file and writes nothing. The frontend
 * never constructs, receives or names a destination — that is the capability
 * boundary this feature is built around, and
 * `src/__tests__/browser/BrowserTripwire.test.ts` asserts it mechanically.
 *
 * There is deliberately **no** "open when done": that is arbitrary write plus
 * exec, the one hole the design exists to avoid. And there is no "save all" —
 * one dialog per file is deliberate friction at the exact point the boundary is
 * crossed.
 *
 * Portaled to `<body>`, so `.browser-download-dialog` sets an explicit `color`:
 * `body` carries none, and an inherited color renders black.
 */
export function BrowserDownloadDialog({
  request,
  onDecide,
}: {
  request: DownloadRequest;
  onDecide: (accept: boolean) => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(() => onDecide(false));
  const size = formatDownloadSize(request.size_bytes);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => onDecide(false)}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="settings-dialog browser-download-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>
            {t("browser.downloadTitle")} <UntestedTag id="browser.downloadTitle" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={() => onDecide(false)}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <div className="browser-download-detail">
            <div className="browser-download-label">{t("browser.downloadFile")}</div>
            {/* The name is attacker-chosen twice over (the URL path and the
                Content-Disposition header). The backend sanitized it; this
                strips the bidi controls that reorder what the eye reads and
                renders the result as a plain text node. */}
            <div className="browser-download-name">{stripControls(request.file_name)}</div>
            <div className="browser-download-label">{t("browser.downloadSize")}</div>
            <div className="browser-download-value">
              {size ?? t("browser.downloadUnknownSize")}
            </div>
            {request.mime_type && (
              <>
                <div className="browser-download-label">{t("browser.downloadType")}</div>
                <div className="browser-download-value">{request.mime_type}</div>
              </>
            )}
          </div>

          {request.sniff_mismatch && (
            /* Persistent, not a dismissible toast: a name that lies about the
               bytes is the single strongest signal a download is hostile. */
            <div className="browser-warning-strip"><WarningIcon /> {t("browser.downloadMismatch")}</div>
          )}

          <p className="browser-download-note">{t("browser.downloadNote")}</p>

          <div className="browser-dialog-actions">
            <button
              type="button"
              className="browser-btn"
              autoFocus
              onClick={() => onDecide(false)}
            >
              {t("browser.downloadCancel")}
            </button>
            <button
              type="button"
              className="browser-btn browser-btn-primary"
              onClick={() => onDecide(true)}
            >
              {t("browser.downloadSave")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
