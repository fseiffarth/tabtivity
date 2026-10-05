import { useState } from "react";

import { useT } from "../../../src/lib/i18n";
import { outboxFileUrl, sentName, type OutboxFile, type OutboxScope } from "../api";
import { shareAs, useOutboxShare } from "../outboxShare";
import { ageLabel, sizeLabel } from "../terminal/fileLabels";

/**
 * The files themselves: a thumbnail for every picture, a card for everything
 * else, newest first — the arrangement the gallery sheet (`OutboxGallery`)
 * shows them in, opened from the Focus screen or the project screen, each
 * reading the same project outbox through its own scope.
 *
 * A kind the browser neither shows nor reads is saved, not opened: the tile is
 * a download link, and no viewer is offered for bytes it would only garble.
 *
 * Every tile carries Save, whatever its kind: what the desktop sent is usually
 * sent to be kept, and a thumbnail carries no ⋯ to reach the file sheet with.
 * Share stands beside it wherever the phone's share sheet takes the file —
 * passing a plot on to Signal or WhatsApp should not mean opening it first.
 *
 * Delete is on the tile as well, behind a confirm that replaces the row rather
 * than a dialog over it — a thumb reaching the ✕ of a picture it wanted to keep
 * is exactly the tap that must cost a second one, and nothing here can be
 * undone: the file is unlinked from the project's `.tabtivity/outbox/`.
 */
export function OutboxGrid({ scope, files, onOpen, onDetails, onDelete }: {
  scope: OutboxScope;
  /** Newest first, as the sidecar listed them. */
  files: readonly OutboxFile[];
  /** Opens one file: full screen here, or the browser's own PDF view. */
  onOpen: (file: OutboxFile) => void;
  /** The sheet for one file — where saving and sharing live. */
  onDetails: (file: OutboxFile) => void;
  /** Removes one file for good. Left out where deleting is not offered; the
   * caller drops the row and holds the poll's answer to it. */
  onDelete?: (file: OutboxFile) => Promise<void>;
}) {
  const t = useT();
  /** The one tile whose 🗑 was pressed — the confirm is per tile, and asking
   * about a second file drops the first question rather than stacking. */
  const [asking, setAsking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const sharing = useOutboxShare(scope);
  const remove = async (file: OutboxFile) => {
    setDeleting(file.name);
    setFailed(null);
    try {
      await onDelete?.(file);
      setAsking(null);
    } catch {
      // The row stays, with the question closed: a file that is still there
      // must not read as gone, and the next poll will confirm either way.
      setFailed(file.name);
      setAsking(null);
    } finally {
      setDeleting(null);
    }
  };
  const now = Math.floor(Date.now() / 1000);
  return <div className="outbox-gallery-grid">
    {files.map((file) => {
      const isImage = file.kind.startsWith("image/");
      const download = !isImage && !file.kind.startsWith("text/") && file.kind !== "application/pdf";
      const label = t("mobile.outbox.open", { name: sentName(file) });
      const meta = `${ageLabel(Math.max(0, now - file.modified))} · ${sizeLabel(file.size)}`;
      const content = <>
        {isImage
          ? <img src={outboxFileUrl(scope, file.name)} alt="" loading="lazy" decoding="async" />
          : <span aria-hidden="true">{file.kind === "application/pdf" ? "PDF" : file.kind.startsWith("text/") ? "≡" : "↓"}</span>}
        <strong>{sentName(file)}</strong>
        <span>{meta}</span>
      </>;
      return <div key={file.name} className="outbox-entry">
        {download
          ? <a className="outbox-file" href={outboxFileUrl(scope, file.name, true)} download={sentName(file)} aria-label={label}>{content}</a>
          : <button className={isImage ? "outbox-thumb" : "outbox-file"} onClick={() => onOpen(file)} aria-label={label} title={sentName(file)}>{content}</button>}
        <div className="outbox-entry-actions">
          {/* Saving is on the tile itself, for every kind — a picture included.
              It used to live one screen in, in the sheet the ⋯ opens, and a
              thumbnail has no ⋯: the only way to keep a picture the agent sent
              was to open it full screen first and find Save there. The link is
              the same `?download=1` byte stream the sheet's Save uses. */}
          <a className="outbox-save" href={outboxFileUrl(scope, file.name, true)} download={sentName(file)} aria-label={t("mobile.outbox.saveFile", { name: sentName(file) })}><span aria-hidden="true">⤓</span>{t("mobile.outbox.save")}</a>
          {shareAs(file) && <button
            className="outbox-save"
            disabled={sharing.busy === file.name}
            onClick={() => void sharing.share(file)}
            aria-label={t(sharing.ready === file.name ? "mobile.outbox.shareReadyFile" : "mobile.outbox.shareFile", { name: sentName(file) })}
          ><span aria-hidden="true">↗</span>{t(sharing.ready === file.name ? "mobile.outbox.shareReady" : "mobile.outbox.share")}</button>}
          {!isImage && <button className="outbox-details" onClick={() => onDetails(file)} aria-label={t("mobile.outbox.actions", { name: sentName(file) })}>⋯</button>}
          {onDelete && (asking === file.name
            ? <span className="outbox-confirm" role="group" aria-label={t("mobile.outbox.deleteAsk", { name: sentName(file) })}>
              <button className="outbox-delete-yes" disabled={deleting === file.name} onClick={() => void remove(file)}>{t("mobile.outbox.deleteYes")}</button>
              <button onClick={() => setAsking(null)}>{t("mobile.outbox.deleteNo")}</button>
            </span>
            : <button className="outbox-delete" onClick={() => { setFailed(null); setAsking(file.name); }} aria-label={t("mobile.outbox.delete", { name: sentName(file) })} title={t("mobile.outbox.deleteYes")}><span aria-hidden="true">🗑</span></button>)}
        </div>
        {failed === file.name && <span className="outbox-entry-error" role="alert">{t("mobile.outbox.deleteError")}</span>}
        {sharing.failed === file.name && <span className="outbox-entry-error" role="alert">{t("mobile.outbox.shareError")}</span>}
      </div>;
    })}
  </div>;
}
