import { useState } from "react";

import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { inboxFileUrl, sentName, type OutboxFile } from "../api";
import { sizeLabel } from "../terminal/fileLabels";

/** Picture tiles an album shows before the last one reads "+N" (as `OutboxPost`). */
const ALBUM_TILES = 4;
/** How far a lone picture may stray from square (as `OutboxPost`). */
const WIDEST = 2;
const TALLEST = 2 / 3;

/** A leaf's name without the `YYYYMMDD-HHMMSS-` stamps the inbox put in
 * front — for a file the desktop no longer describes. */
export function leafName(leaf: string): string {
  let rest = leaf;
  while (/^\d{8}-\d{6}-./u.test(rest)) rest = rest.slice(16);
  return rest;
}

/** The badge a file that is not a picture wears, by what its bytes are. */
export function fileBadge(kind: string): string {
  return kind === "application/pdf" ? "PDF" : kind.startsWith("text/") ? "≡" : "↓";
}

/** Whether the viewer can show `file` (else it is a download). */
const viewable = (file: OutboxFile) => file.kind.startsWith("image/") || file.kind.startsWith("text/") || file.kind === "application/pdf";

/**
 * The files a prompt carried into the project inbox, drawn inside the
 * prompt's own bubble the way a messenger draws a picture with its caption —
 * the mirror of `OutboxPost` on the reader's side. Pictures make one album;
 * any other file is a slim card; a leaf the desktop has not described yet
 * holds a picture's place, and one the inbox no longer holds says so.
 *
 * A tap opens the file in the viewer (`onOpen`), or downloads bytes the
 * phone cannot show.
 */
export function InboxAlbum({ tabId, leaves, files, onOpen, onSettle }: {
  tabId: string;
  leaves: readonly string[];
  /** What the desktop said per leaf; absent = not answered yet. */
  files: ReadonlyMap<string, OutboxFile | null>;
  onOpen: (file: OutboxFile) => void;
  onSettle?: () => void;
}) {
  const t = useT();
  const [ratio, setRatio] = useState(4 / 3);
  const pictures: Array<{ leaf: string; file: OutboxFile | undefined }> = [];
  const others: Array<{ leaf: string; file: OutboxFile | null }> = [];
  for (const leaf of leaves) {
    const file = files.get(leaf);
    if (file === undefined || file?.kind.startsWith("image/")) pictures.push({ leaf, file });
    else others.push({ leaf, file });
  }
  const tiles = pictures.slice(0, ALBUM_TILES);
  const more = pictures.length - tiles.length;
  const settle = (image: HTMLImageElement) => {
    if (tiles.length !== 1 || !image.naturalWidth || !image.naturalHeight) return;
    setRatio(Math.min(WIDEST, Math.max(TALLEST, image.naturalWidth / image.naturalHeight)));
    requestAnimationFrame(() => onSettle?.());
  };
  return <div className="inbox-album" role="group" aria-label={t("mobile.inbox.album", { count: leaves.length })}>
    {tiles.length > 0 && <div className={`outbox-post-album tiles-${tiles.length}`} style={tiles.length === 1 ? { aspectRatio: String(ratio) } : undefined}>
      {tiles.map(({ leaf, file }, i) => file
        ? <button key={leaf} type="button" className="outbox-post-picture" onClick={() => onOpen(file)} aria-label={t("mobile.outbox.open", { name: sentName(file) })} title={sentName(file)}>
            <img src={inboxFileUrl(tabId, file.name)} alt="" loading="lazy" decoding="async" onLoad={(event) => settle(event.currentTarget)} />
            {more > 0 && i === tiles.length - 1 && <span className="outbox-post-more" aria-hidden="true">+{more}</span>}
          </button>
        : <span key={leaf} className="outbox-post-picture pending" aria-label={leafName(leaf)} />)}
    </div>}
    {others.map(({ leaf, file }) => {
      if (!file) {
        return <span key={leaf} className="outbox-post-file gone">
          <span aria-hidden="true">✕</span>
          <strong>{leafName(leaf)}</strong>
          <small>{t("mobile.inbox.gone")}</small>
        </span>;
      }
      const card = <>
        <span aria-hidden="true">{fileBadge(file.kind)}</span>
        <strong>{sentName(file)}</strong>
        <small>{sizeLabel(file.size)}</small>
      </>;
      const label = t("mobile.outbox.open", { name: sentName(file) });
      return viewable(file)
        ? <button key={leaf} type="button" className="outbox-post-file" onClick={() => onOpen(file)} aria-label={label} title={sentName(file)}>{card}</button>
        : <a key={leaf} className="outbox-post-file" href={inboxFileUrl(tabId, file.name, true)} download={sentName(file)} aria-label={label}>{card}</a>;
    })}
    {isUntested("mobile.chat.inboxPreviews") && <small className="inbox-album-untested">{t("mobile.outbox.untested")}</small>}
  </div>;
}

/**
 * One file beside the composer, as a thumbnail: the picture itself (the
 * phone's own copy while it travels, then the inbox's), else its badge and
 * name. A file still on its way is dimmed; a landed one carries ✕.
 */
export function ComposerThumb({ name, picture, kind, sending, onRemove, removeLabel }: {
  name: string;
  /** Where the picture loads from, when it is one. */
  picture?: string;
  /** The bytes' type, once the desktop described them. */
  kind?: string;
  sending: boolean;
  onRemove?: () => void;
  removeLabel: string;
}) {
  const [broken, setBroken] = useState(false);
  return <div className={`composer-thumb${sending ? " sending" : ""}`} title={name} aria-busy={sending || undefined}>
    {picture && !broken
      ? <img src={picture} alt={name} decoding="async" onError={() => setBroken(true)} />
      : <span className="composer-thumb-file"><b aria-hidden="true">{kind ? fileBadge(kind) : "↓"}</b><small>{name}</small></span>}
    {sending && <span className="composer-thumb-progress" aria-hidden="true" />}
    {onRemove && <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onRemove} aria-label={removeLabel} title={removeLabel}>✕</button>}
  </div>;
}
