import { createContext, useCallback, useContext, useMemo } from "react";

import type { OutboxFile } from "../../../mobile-web/src/api";
import { InboxAlbum, type InboxSource } from "../../../mobile-web/src/components/InboxPreview";
import { findPathCandidates } from "../../lib/terminal/pathLinks";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../../lib/viewers/fileUtils";
import { UntestedTag } from "../common/UntestedTag";
import { usePictureUrls, type PictureRef } from "./ReaderInbox";

/**
 * The pictures and PDFs an agent's answer names, drawn under its words the
 * way a prompt bubble draws the files the phone sent (`ReaderInbox`, the
 * phone's `InboxAlbum`): "show me the plot" answered with `figs/plot.png`
 * puts the picture in the Chat, and a click opens it in its viewer tab like
 * the path link itself. Only paths the Chat's path links found
 * (`lib/terminal/pathLinks`: files inside the tab's folder or its project an
 * in-app viewer shows), at most `MAX_FILES` per answer; a picture past
 * `MAX_PICTURE`, or one whose bytes cannot be read, is a file card.
 *
 * Nothing is copied anywhere: the desktop shows the project file itself
 * (`tabtivity-send` is the phone's way).
 */

/** Files one answer previews; the album's fourth tile reads "+N" past that. */
const MAX_FILES = 4;
/** The largest picture read for a tile (the outbox's ceiling). */
const MAX_PICTURE = 24 * 1024 * 1024;
/** What a picture that is not drawn shows as: a plain card. */
const CARD_KIND = "application/octet-stream";

/** What the Chat's answer bubbles draw their albums from. */
export interface ReaderAnswerFiles {
  source: InboxSource;
  /** The answer's files, by path, in the order it names them. */
  leaves: (text: string) => string[];
  files: ReadonlyMap<string, OutboxFile>;
  open: (file: OutboxFile) => void;
  settle: () => void;
}

export const ReaderAnswerFilesContext = createContext<ReaderAnswerFiles | null>(null);

/** The type a previewed file is drawn as, or null when it is not one. */
function previewKind(entry: FileEntry, disabled?: ReadonlySet<InternalViewer>): string | null {
  const viewer = internalViewerFor(entry, disabled);
  if (viewer === "pdf") return "application/pdf";
  if (viewer !== "image" && viewer !== "gif") return null;
  if (entry.size > MAX_PICTURE) return CARD_KIND;
  return entry.mime?.startsWith("image/") ? entry.mime : `image/${(entry.extension ?? "").replace(/^\./u, "").toLowerCase() || "png"}`;
}

/** The previewable files `text` names, in order, at most `MAX_FILES`. */
function answerEntries(text: string, links: ReadonlyMap<string, FileEntry | null>, disabled?: ReadonlySet<InternalViewer>): FileEntry[] {
  const out: FileEntry[] = [];
  for (const candidate of findPathCandidates(text)) {
    const entry = links.get(candidate.path);
    if (!entry || entry.is_dir || out.some((seen) => seen.path === entry.path) || !previewKind(entry, disabled)) continue;
    out.push(entry);
    if (out.length === MAX_FILES) break;
  }
  return out;
}

/**
 * The previews of every answer in `texts`, from the Chat's path links, or
 * `null` while the Chat is hidden. `openEntry` opens a file's viewer tab;
 * `settle` keeps a Chat that follows its end at the end once a picture has
 * its size.
 */
export function useReaderAnswerFiles({ projectId, disabled, texts, links, enabled, openEntry, settle }: {
  projectId: string | null;
  disabled?: ReadonlySet<InternalViewer>;
  texts: readonly string[];
  links: ReadonlyMap<string, FileEntry | null>;
  enabled: boolean;
  openEntry: (entry: FileEntry) => void;
  settle: () => void;
}): ReaderAnswerFiles | null {
  const entries = useMemo(() => {
    const out = new Map<string, FileEntry>();
    if (!enabled) return out;
    for (const text of texts) for (const entry of answerEntries(text, links, disabled)) out.set(entry.path, entry);
    return out;
  }, [enabled, texts, links, disabled]);
  const wanted = useMemo(() => {
    const out = new Map<string, PictureRef>();
    for (const [path, entry] of entries) {
      const kind = previewKind(entry, disabled);
      if (kind?.startsWith("image/")) out.set(path, { path, kind });
    }
    return out;
  }, [entries, disabled]);
  const { url, failed, landed } = usePictureUrls(wanted, projectId, projectId ?? "");
  const files = useMemo(() => {
    const out = new Map<string, OutboxFile>();
    for (const [path, entry] of entries) {
      const kind = failed.has(path) ? CARD_KIND : previewKind(entry, disabled) ?? CARD_KIND;
      out.set(path, { name: path, original: entry.name, kind, size: entry.size, modified: entry.modified_secs ?? 0 });
    }
    return out;
  }, [entries, failed, disabled]);
  // A new source each time a picture lands: the bubbles read `picture` again.
  const source = useMemo<InboxSource>(() => ({
    picture: (file) => (landed >= 0 ? url(file.name) : null),
    openable: (file) => entries.has(file.name),
  }), [entries, landed, url]);
  const leaves = useCallback(
    (text: string) => answerEntries(text, links, disabled).map((entry) => entry.path).filter((path) => files.has(path)),
    [links, disabled, files],
  );
  const open = useCallback((file: OutboxFile) => {
    const entry = entries.get(file.name);
    if (entry) openEntry(entry);
  }, [entries, openEntry]);
  return useMemo(
    () => (enabled ? { source, leaves, files, open, settle } : null),
    [enabled, source, leaves, files, open, settle],
  );
}

/** An answer's pictures and PDFs, under its words; nothing when it names none. */
export function ReaderAnswerAlbum({ text }: { text: string }) {
  const shown = useContext(ReaderAnswerFilesContext);
  const leaves = useMemo(() => shown?.leaves(text) ?? [], [shown, text]);
  if (!shown || leaves.length === 0) return null;
  return (
    <InboxAlbum
      source={shown.source}
      leaves={leaves}
      files={shown.files}
      onOpen={shown.open}
      onSettle={shown.settle}
      tag={<UntestedTag id="terminal.reader.answerFiles" />}
    />
  );
}
