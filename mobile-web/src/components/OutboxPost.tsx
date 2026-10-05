import { useState } from "react";

import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { outboxFileUrl, sentName, type OutboxFile, type OutboxScope } from "../api";
import type { OutboxPost as Post } from "../terminal/outboxPosts";
import { sizeLabel } from "../terminal/fileLabels";

/** Picture tiles an album shows before the last one reads "+N". */
const ALBUM_TILES = 4;
/** How far a lone picture may stray from square before it is cropped: a
 * panorama no flatter than 2:1, a phone screenshot no taller than 2:3. */
const WIDEST = 2;
const TALLEST = 2 / 3;

/** The time a post was sent, as a messenger stamps a picture: `14:05`. */
function sentAt(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * One send of the agent's files as a message in the Focus chat
 * (`outboxPosts`), drawn the way WhatsApp draws a picture: the picture is the
 * bubble — a thin rim of the agent's bubble colour, no name, the time over its
 * bottom corner. A lone picture keeps its own shape (within `WIDEST` and
 * `TALLEST`); more from one send are one album — two side by side, three as
 * one wide over two, four in a grid whose last tile counts the rest. A file
 * that is not a picture is a slim card in the same bubble.
 *
 * A tap opens the file the way the gallery does (full screen, the browser's
 * PDF view, or a download for bytes the phone cannot show); saving, sharing
 * and deleting stay in the gallery and the viewer.
 *
 * A lone picture's box is 4:3 until the picture says otherwise; `onSettle`
 * runs then, so a chat following its bottom follows the taller bubble too.
 */
export function OutboxPost({ scope, post, onOpen, onSettle }: {
  scope: OutboxScope;
  post: Post;
  onOpen: (file: OutboxFile) => void;
  onSettle?: () => void;
}) {
  const t = useT();
  const [ratio, setRatio] = useState(4 / 3);
  const pictures = post.files.filter((file) => file.kind.startsWith("image/"));
  const others = post.files.filter((file) => !file.kind.startsWith("image/"));
  const tiles = pictures.slice(0, ALBUM_TILES);
  const more = pictures.length - tiles.length;
  const time = sentAt(post.files[post.files.length - 1].modified);
  const untested = isUntested("mobile.outbox.chat");
  const settle = (image: HTMLImageElement) => {
    if (tiles.length !== 1 || !image.naturalWidth || !image.naturalHeight) return;
    setRatio(Math.min(WIDEST, Math.max(TALLEST, image.naturalWidth / image.naturalHeight)));
    requestAnimationFrame(() => onSettle?.());
  };
  return <div className={others.length === 0 ? "readable-turn agent outbox-post pictures-only" : "readable-turn agent outbox-post"} role="group" aria-label={t("mobile.outbox.post", { count: post.files.length })}>
    {tiles.length > 0 && <div className={`outbox-post-album tiles-${tiles.length}`} style={tiles.length === 1 ? { aspectRatio: String(ratio) } : undefined}>
      {tiles.map((file, i) => <button key={file.name} className="outbox-post-picture" onClick={() => onOpen(file)} aria-label={t("mobile.outbox.open", { name: sentName(file) })} title={sentName(file)}>
        <img src={outboxFileUrl(scope, file.name)} alt="" loading="lazy" decoding="async" onLoad={(event) => settle(event.currentTarget)} />
        {more > 0 && i === tiles.length - 1 && <span className="outbox-post-more" aria-hidden="true">+{more}</span>}
      </button>)}
    </div>}
    {others.map((file) => {
      const card = <>
        <span aria-hidden="true">{file.kind === "application/pdf" ? "PDF" : file.kind.startsWith("text/") ? "≡" : "↓"}</span>
        <strong>{sentName(file)}</strong>
        <small>{sizeLabel(file.size)}</small>
      </>;
      const label = t("mobile.outbox.open", { name: sentName(file) });
      return !file.kind.startsWith("text/") && file.kind !== "application/pdf"
        ? <a key={file.name} className="outbox-post-file" href={outboxFileUrl(scope, file.name, true)} download={sentName(file)} aria-label={label}>{card}</a>
        : <button key={file.name} className="outbox-post-file" onClick={() => onOpen(file)} aria-label={label} title={sentName(file)}>{card}</button>;
    })}
    <small className="outbox-post-meta">{untested && <em>{t("mobile.outbox.untested")} · </em>}{time}</small>
  </div>;
}
