import { useState } from "react";
import { CloseIcon } from "../glyphs";
import { useT } from "../../../src/lib/i18n";
import { type OutboxFile, type OutboxScope } from "../api";
import { OutboxGrid } from "./OutboxGrid";
import { isUntested } from "../../../src/lib/untested";
import { formatBytes } from "../../../src/lib/formatBytes";
import { useBackLayer } from "../backStack";

/** The sidecar's listing cap (`outbox::MAX_LISTED`): a full list means the
 * folder may hold more than the sum shown. */
const LISTED_CAP = 40;

/**
 * The files the agent sent (`tabtivity-send`, the project's
 * `.tabtivity/outbox/`), as a sheet of its own — on a tab's Focus screen what
 * that tab sent (`tabOnly`), on the project screen every tab's: a grid of thumbnails for the
 * pictures and a card for every other file, newest first.
 *
 * The files stay out of the chat — a picture pushed between the turns buries
 * the answer that mentions it, and a chat that rewrites itself as files arrive
 * is not a chat. The gallery is reached from the button beside the tab name,
 * which is there whenever the outbox holds anything, on the Focus screen and
 * in the project screen's header alike.
 */
export function OutboxGallery({ scope, files, tabOnly = false, onOpen, onDetails, onDelete, onDeleteAll, onClose }: {
  scope: OutboxScope;
  /** The files are one tab's sends, not the project's whole outbox: the count
   * and Delete all's question say so (Delete all removes just those). */
  tabOnly?: boolean;
  /** Newest first, as the sidecar listed them. */
  files: readonly OutboxFile[];
  /** Opens one file: full screen here, or the browser's own PDF view. */
  onOpen: (file: OutboxFile) => void;
  /** The sheet for one file — where saving and sharing live. */
  onDetails: (file: OutboxFile) => void;
  /** Removes one file for good, behind the tile's own confirm. */
  onDelete?: (file: OutboxFile) => Promise<void>;
  /** Removes every listed file (`tabOnly`) or the project's whole outbox, to
   * free the space — behind its own confirm; the caller empties the list and
   * closes the sheet. */
  onDeleteAll?: () => Promise<void>;
  onClose: () => void;
}) {
  useBackLayer(onClose);
  const t = useT();
  const [askingAll, setAskingAll] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  /** What the listed files hold — the outbox may keep more past the 40 the
   * sidecar lists, which Delete all clears too. */
  const listedBytes = files.reduce((sum, file) => sum + file.size, 0);
  // One tab's sends are listed whole: past the cap, the rest are other tabs'.
  const sizeShown = `${formatBytes(listedBytes)}${!tabOnly && files.length >= LISTED_CAP ? "+" : ""}`;
  const askAll = tabOnly ? "mobile.outbox.deleteTabAsk" : "mobile.outbox.deleteAllAsk";
  const clearAll = async () => {
    setClearing(true);
    setClearFailed(false);
    try {
      await onDeleteAll?.();
    } catch {
      setClearFailed(true);
    } finally {
      setClearing(false);
      setAskingAll(false);
    }
  };
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet outbox-gallery" role="dialog" aria-modal="true" aria-label={t("mobile.outbox.region")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.outbox.close")}><CloseIcon size="1em" /></button>
        <h2>{t("mobile.outbox.from")} {isUntested("mobile.outbox.gallery") && <small>{t("mobile.outbox.untested")}</small>} {isUntested("mobile.outbox.share") && <small>{t("mobile.outbox.shareUntested")}</small>} {tabOnly && isUntested("mobile.outbox.tabOnly") && <small>{t("mobile.outbox.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {files.length === 0
        ? <p className="sheet-note">{t("mobile.outbox.galleryEmpty")}</p>
        : <>
          <p className="sheet-note">{t(tabOnly ? (files.length === 1 ? "mobile.outbox.tabCountOne" : "mobile.outbox.tabCount") : (files.length === 1 ? "mobile.outbox.countOne" : "mobile.outbox.count"), { count: files.length })}</p>
          {onDeleteAll && <div className="outbox-clear">
            {askingAll
              ? <span className="outbox-confirm" role="group" aria-label={t(askAll)}>
                <span>{t(askAll)}</span>
                <button className="outbox-delete-yes" disabled={clearing} onClick={() => void clearAll()}>{t("mobile.outbox.deleteAllYes")}</button>
                <button disabled={clearing} onClick={() => setAskingAll(false)}>{t("mobile.outbox.deleteNo")}</button>
              </span>
              : <button className="outbox-clear-all" onClick={() => { setClearFailed(false); setAskingAll(true); }}>{t("mobile.outbox.deleteAll", { size: sizeShown })}</button>}
            {isUntested("mobile.outbox.deleteAll") && <span className="untested">{t("mobile.outbox.untested")}</span>}
            {clearFailed && <span className="outbox-entry-error" role="alert">{t("mobile.outbox.deleteAllError")}</span>}
          </div>}
          <OutboxGrid scope={scope} files={files} onOpen={onOpen} onDetails={onDetails} onDelete={onDelete} />
        </>}
    </section>
  </div>;
}
