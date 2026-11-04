import { useMemo } from "react";

import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { viewerFileUrl, type OutboxFile } from "../api";
import { answerLeaves } from "../terminal/chatFiles";
import { InboxAlbum, viewableFile, type InboxSource } from "./InboxPreview";

/** What the chat draws the files its answers name from (`useNamedFiles`). */
export interface AnswerFiles {
  /** The project the files open in (`{ files }` of `ViewerScope`). */
  project: string;
  /** What the answers name, by the words that name it. */
  named: ReadonlyMap<string, OutboxFile>;
  /** The part of `named` a path in an answer's words opens. */
  links: ReadonlyMap<string, OutboxFile>;
  /** Files the agent sent into this chat: their own posts already show them. */
  sent: ReadonlySet<string>;
  open: (file: OutboxFile) => void;
  settle?: () => void;
}

/**
 * The pictures and PDFs an answer names, as the message after it: what the
 * desktop Chat's `ReaderAnswerAlbum` draws under an answer's words. Here it is
 * a bubble of its own, the way `tabtivity-send`'s posts are, since the lookup
 * lands after the answer is on screen and a shown bubble never changes.
 *
 * Nothing is copied: this is the project file itself, opened through the 📁
 * library's door like the Diffs view's rows.
 */
export function AnswerAlbum({ text, files }: { text: string; files: AnswerFiles }) {
  const t = useT();
  const { project, named, sent, open, settle } = files;
  const leaves = useMemo(() => answerLeaves(text, named, sent), [text, named, sent]);
  const source = useMemo<InboxSource>(() => ({
    scope: { files: project },
    picture: (file) => viewerFileUrl({ files: project }, file),
    openable: viewableFile,
    download: (file) => viewerFileUrl({ files: project }, file, true),
  }), [project]);
  if (leaves.length === 0) return null;
  const tag = isUntested("mobile.chat.answerFiles") ? <small className="outbox-post-meta"><em>{t("mobile.outbox.untested")}</em></small> : null;
  return <div className="readable-turn agent outbox-post">
    <InboxAlbum source={source} leaves={leaves} files={named} onOpen={open} onSettle={settle} tag={tag} />
  </div>;
}
