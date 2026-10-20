import { invoke } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { OutboxFile } from "../../../mobile-web/src/api";
import { InboxAlbum, type InboxSource } from "../../../mobile-web/src/components/InboxPreview";
import { inboxLeaves, useInboxFiles, withoutInboxReferences } from "../../../mobile-web/src/terminal/inboxRefs";
import { NAMES } from "../../lib/brand";
import { resolvePath } from "../../lib/paths";
import { internalViewerFor, type FileEntry, type InternalViewer } from "../../lib/viewers/fileUtils";
import { UntestedTag } from "../common/UntestedTag";
import { readFileBytes } from "../embed/fileAccess";

/**
 * The Chat's mirror of the phone's inbox previews (`InboxAlbum`): a prompt
 * that carries files the phone sent into the project inbox
 * (`@.tabtivity/inbox/<leaf>`) shows them inside its bubble as pictures and
 * file cards instead of as those references. The references are read by the
 * phone's own parser (`inboxRefs`); what the inbox holds is asked of the
 * backend once per leaf (`project_inbox_describe`, the answer the phone's
 * route gives), and a picture's bytes are read from the project's folder like
 * any viewer's. A tap opens the file in its viewer tab.
 *
 * Only a local project has an inbox here: a remote project's, the root
 * console's and a popout's prompts keep the plain references.
 */

/** What the Chat's prompt bubbles draw their albums from. */
export interface ReaderInbox {
  source: InboxSource;
  files: ReadonlyMap<string, OutboxFile | null>;
  open: (file: OutboxFile) => void;
  settle: () => void;
}

export const ReaderInboxContext = createContext<ReaderInbox | null>(null);

/** The inbox file as the viewers know it: the project's own path to it. */
function inboxEntry(projectDir: string, file: OutboxFile): FileEntry {
  return {
    name: file.name,
    path: resolvePath(projectDir, `${NAMES.inboxDir}/${file.name}`),
    is_dir: false,
    size: file.size,
    extension: /\.[^./\\]+$/u.exec(file.name)?.[0].toLowerCase() ?? null,
    mime: file.kind,
  };
}

/**
 * The previews of every prompt in `texts`, or `null` when this Chat has none
 * to draw (no local project folder, or hidden). `openEntry` opens a file's
 * viewer tab; `settle` keeps a Chat that follows its end at the end once a
 * picture has its size.
 */
export function useReaderInbox({ projectId, projectDir, disabled, texts, enabled, openEntry, settle }: {
  projectId: string | null;
  projectDir: string;
  disabled?: ReadonlySet<InternalViewer>;
  texts: readonly string[];
  enabled: boolean;
  openEntry: (entry: FileEntry) => void;
  settle: () => void;
}): ReaderInbox | null {
  const active = enabled && !!projectId && !!projectDir;
  const leaves = useMemo(
    () => (active ? [...new Set(texts.flatMap((text) => inboxLeaves(text)))] : []),
    [active, texts],
  );
  const describe = useCallback(
    (names: string[]) => invoke<OutboxFile[]>("project_inbox_describe", { projectId, names }),
    [projectId],
  );
  const described = useInboxFiles(`project:${projectId ?? ""}`, leaves, describe);

  // Picture bytes → object URLs, one read per leaf; a leaf that cannot be read
  // is shown as gone. Revoked with the Chat (and the epoch drops reads that
  // were still on their way).
  const urls = useRef(new Map<string, string>());
  const asked = useRef(new Set<string>());
  const epoch = useRef(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [landed, bump] = useState(0);
  useEffect(() => {
    const own = urls.current;
    const seen = asked.current;
    return () => {
      epoch.current += 1;
      for (const url of own.values()) URL.revokeObjectURL(url);
      own.clear();
      seen.clear();
    };
  }, [projectId, projectDir]);
  useEffect(() => {
    if (!active) return;
    const mine = epoch.current;
    for (const [leaf, file] of described) {
      if (!file || !file.kind.startsWith("image/") || asked.current.has(leaf)) continue;
      asked.current.add(leaf);
      void readFileBytes(inboxEntry(projectDir, file).path, projectId)
        .then((bytes) => {
          if (epoch.current !== mine) return;
          urls.current.set(leaf, URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: file.kind })));
          bump((n) => n + 1);
        })
        .catch(() => {
          if (epoch.current === mine) setFailed((current) => new Set(current).add(leaf));
        });
    }
  }, [active, described, projectDir, projectId]);

  const files = useMemo(() => {
    if (failed.size === 0) return described;
    const shown = new Map(described);
    for (const leaf of failed) if (shown.has(leaf)) shown.set(leaf, null);
    return shown;
  }, [described, failed]);
  // A new source each time a picture lands: the bubbles read `picture` again.
  const source = useMemo<InboxSource>(() => ({
    picture: (file) => (landed >= 0 ? urls.current.get(file.name) ?? null : null),
    openable: (file) => internalViewerFor(inboxEntry(projectDir, file), disabled) !== null,
  }), [projectDir, disabled, landed]);
  const open = useCallback((file: OutboxFile) => {
    const entry = inboxEntry(projectDir, file);
    if (internalViewerFor(entry, disabled) !== null) openEntry(entry);
  }, [projectDir, disabled, openEntry]);
  return useMemo(() => (active ? { source, files, open, settle } : null), [active, source, files, open, settle]);
}

/** Whether `text` names inbox files this Chat draws as pictures. */
export function useDrawsInbox(text: string): boolean {
  const inbox = useContext(ReaderInboxContext);
  return useMemo(() => !!inbox && inboxLeaves(text).length > 0, [inbox, text]);
}

/**
 * A prompt's words with its inbox files drawn above them as an album. Without
 * previews (or without references) it is just `children(text)`.
 */
export function ReaderPromptBody({ text, children }: { text: string; children: (words: string) => ReactNode }) {
  const inbox = useContext(ReaderInboxContext);
  const leaves = useMemo(() => (inbox ? inboxLeaves(text) : []), [inbox, text]);
  if (!inbox || leaves.length === 0) return <>{children(text)}</>;
  const words = withoutInboxReferences(text);
  return (
    <>
      <InboxAlbum
        source={inbox.source}
        leaves={leaves}
        files={inbox.files}
        onOpen={inbox.open}
        onSettle={inbox.settle}
        tag={<UntestedTag id="terminal.reader.inboxPreviews" />}
      />
      {words && children(words)}
    </>
  );
}
