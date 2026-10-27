// The phone terminal's outbox: the poll that lists the files the agent sent,
// and the viewers that open them and the reader's own inbox files.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { OutboxPost } from "../../components/OutboxPost";
import { type SentFile } from "../../components/SentFilesIndex";
import {
  useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction,
  type MutableRefObject, type RefObject,
} from "react";
import {
  clearOutbox, deleteOutboxFile, listOutbox, type OutboxFile, type ViewerScope, type TabRow,
} from "../../api";
import { OUTBOX_POLL, sameOutbox } from "../../outbox";
import { type OutboxPost as ChatPost } from "../../terminal/outboxPosts";
import { useInboxFiles } from "../../terminal/inboxRefs";
import { startVisiblePoll } from "../../visiblePoll";
import { type ChatInbox } from "./terminalShared";

/** Reads the tab's outbox now and on every poll while the page is visible. */
export function useOutboxPoll({
  tab, bare, setOutbox, setGallery, setOutboxOpen, setInboxOpen,
}: {
  tab: TabRow;
  bare: boolean;
  setOutbox: Dispatch<SetStateAction<OutboxFile[]>>;
  setGallery: Dispatch<SetStateAction<boolean>>;
  setOutboxOpen: Dispatch<SetStateAction<OutboxFile | null>>;
  setInboxOpen: Dispatch<SetStateAction<OutboxFile | null>>;
}) {
  /** Reads the outbox now and every `OUTBOX_POLL` while the page is visible;
   * coming back to the page reads it at once. A listing that could not be
   * fetched keeps what was shown — the next poll retries. */
  useEffect(() => {
    setOutbox([]);
    setGallery(false);
    setOutboxOpen(null);
    setInboxOpen(null);
    if (bare) return;
    return startVisiblePoll((signal) => listOutbox({ tab: tab.id }, signal).then(
      (images) => {
        if (signal.aborted || !Array.isArray(images)) return;
        setOutbox((current) => sameOutbox(current, images) ? current : images);
      },
      () => {},
    ), OUTBOX_POLL).stop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, bare]);
}

/** The outbox and inbox viewers: Escape, the tucked-away markup view, and the
 * chat's file handlers. */
export function useOutboxViewers({
  tab, readableHost, atBottomRef, setOutbox, outboxScope, gallery, setGallery, outboxOpen,
  setOutboxOpen, inboxOpen, setInboxOpen, askedFile, markupAway, setMarkupAway, filesOpen,
  inboxFiles,
}: {
  tab: TabRow;
  readableHost: RefObject<HTMLElement>;
  atBottomRef: MutableRefObject<boolean>;
  setOutbox: Dispatch<SetStateAction<OutboxFile[]>>;
  outboxScope: { tab: string; };
  gallery: boolean;
  setGallery: Dispatch<SetStateAction<boolean>>;
  outboxOpen: OutboxFile | null;
  setOutboxOpen: Dispatch<SetStateAction<OutboxFile | null>>;
  inboxOpen: OutboxFile | null;
  setInboxOpen: Dispatch<SetStateAction<OutboxFile | null>>;
  askedFile: { file: OutboxFile; place?: string; folder?: string; scope?: ViewerScope; marking?: boolean; } | null;
  markupAway: string | null;
  setMarkupAway: Dispatch<SetStateAction<string | null>>;
  filesOpen: boolean;
  inboxFiles: ReturnType<typeof useInboxFiles>;
}) {
  useEffect(() => {
    const viewerUp = outboxOpen !== null && markupAway === null;
    if (!viewerUp && !gallery && !inboxOpen) return;
    // The viewer opens from the gallery, so Escape closes the top one first;
    // a tucked-away markup view is not on top.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (viewerUp) setOutboxOpen(null);
      else if (inboxOpen) setInboxOpen(null);
      else setGallery(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outboxOpen, gallery, inboxOpen, markupAway]);
  // Another file opened, or the viewer closed: nothing stays tucked away —
  // past the mount, where a `markupBack` view starts out tucked away.
  const awayMounted = useRef(false);
  useEffect(() => {
    if (!awayMounted.current) {
      awayMounted.current = true;
      return;
    }
    setMarkupAway(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outboxOpen, askedFile, filesOpen]);
  /** A picture, a text or a PDF opens full-screen here; in an agent tab the
   * viewer also carries **Mark up**. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openOutbox = useCallback((file: OutboxFile) => setOutboxOpen(file), []);
  /** A lone picture takes its own shape once loaded; a chat following its
   * bottom follows the taller bubble (the resize observer watches the view's
   * box, not what grows inside it). */
  const settlePost = useCallback(() => {
    const stream = readableHost.current;
    if (atBottomRef.current && stream && typeof stream.scrollTo === "function") stream.scrollTo({ top: stream.scrollHeight });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const renderPost = useCallback((post: ChatPost) => <OutboxPost scope={outboxScope} post={post} onOpen={openOutbox} onSettle={settlePost} />, [outboxScope, openOutbox, settlePost]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chatInbox = useMemo<ChatInbox>(() => ({ tabId: tab.id, files: inboxFiles, onOpen: setInboxOpen, onSettle: settlePost }), [tab.id, inboxFiles, settlePost]);
  const inboxScope = useMemo(() => ({ inbox: tab.id }), [tab.id]);
  /** A row of the chat's file list, opened in the viewer of its side. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openSentFile = useCallback(({ file, from }: SentFile) => (from === "agent" ? setOutboxOpen : setInboxOpen)(file), []);
  /** Removes one of the files the agent sent, from the tile's own confirm — the
   * same removal the project screen's shelf does, through this tab's scope. The
   * row goes now rather than at the next poll, and the sheet closes with the
   * last file rather than standing empty over the session. */
  const removeOutbox = useCallback(async (file: OutboxFile) => {
    await deleteOutboxFile({ tab: tab.id }, file.name);
    setOutbox((current) => {
      const left = current.filter((row) => row.name !== file.name);
      if (left.length === 0) setGallery(false);
      return left;
    });
    setOutboxOpen((open) => open?.name === file.name ? null : open);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  /** The gallery's Delete all, through this tab's scope: the project's whole
   * outbox goes (every tab's sends, as the gallery lists them all), to free
   * the space, and the sheet closes over the empty list. */
  const removeAllOutbox = useCallback(async () => {
    await clearOutbox({ tab: tab.id });
    setOutbox([]);
    setGallery(false);
    setOutboxOpen(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
  return { openOutbox, renderPost, chatInbox, inboxScope, openSentFile, removeOutbox, removeAllOutbox };
}
