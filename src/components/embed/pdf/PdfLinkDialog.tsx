import { useModalFocus } from "../../../hooks/useModalFocus";
/**
 * The confirm before a link in a PDF leaves the app (#pdf-links).
 *
 * It is `MailMessageView`'s link confirm, applied to the other place the app
 * renders somebody else's document, and it wears that dialog's chrome on purpose
 * rather than inventing a second look for the same question. The reasoning is the
 * same too: a PDF's visible text and its actual URL are independent — `\href` is
 * *defined* as the pair — so the address is shown in full, monospace, wrapping,
 * and **never** truncated with an ellipsis, because a shortened URL is itself the
 * attack (`https://bank.example.evil.tld/…` reads as `https://bank.example…`).
 * The host is called out separately above it, since the host is the only part
 * that decides where the click goes.
 *
 * The dialog is unconditional. A PDF is untrusted content the moment it was not
 * written by the person reading it, and "always open links from PDFs" is a switch
 * whose only function would be to remove this dialog on the one click that needed
 * it — so there isn't one.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../../lib/i18n";
import { UntestedTag } from "../../common/UntestedTag";

/** The host, or null when the string does not parse as a URL with one. Shown
 *  separately from the full address, never in place of it. */
export function linkHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host || null;
  } catch {
    return null;
  }
}

export function PdfLinkConfirmDialog({
  url,
  onOpen,
  onClose,
}: {
  url: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onClose);
  const [copied, setCopied] = useState(false);
  const host = linkHost(url);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="settings-dialog pdf-link-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("pdfLinks.confirmTitle")}</h2>
          <UntestedTag id="pdfLinkDialog.1" />
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <div className="mail-link-detail">
            <div className="mail-link-detail-label">{t("pdfLinks.goesTo")}</div>
            <div className="mail-link-detail-host">{host ?? "—"}</div>
            <div className="mail-link-detail-label">{t("pdfLinks.fullUrl")}</div>
            <div className="mail-link-detail-url">{url}</div>
          </div>
          <div className="mail-note">{t("pdfLinks.fromDocument")}</div>
          <div className="mail-dialog-actions">
            <button type="button" className="settings-btn" autoFocus onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                navigator.clipboard?.writeText(url).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? t("pdfLinks.copied") : t("pdfLinks.copy")}
            </button>
            <button
              type="button"
              className="settings-btn primary"
              onClick={() => {
                onOpen();
                onClose();
              }}
            >
              {t("pdfLinks.open")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
