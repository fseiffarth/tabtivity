import { useEffect, useMemo, useState } from "react";
import { CloseIcon } from "../glyphs";
import { deleteInboxFile, deleteOutboxFile, getTranscript, listOutbox, type OutboxFile, type TabRow, type TranscriptEntry } from "../api";
import { SentFilesGroups, sentFiles, type SentFile } from "../components/SentFilesIndex";
import { answerTextsOf, promptLeavesOf, useChangedFiles, useNamedFiles } from "../terminal/chatFiles";
import { markInboxGone, useInboxFiles } from "../terminal/inboxRefs";
import { outboxPosts } from "../terminal/outboxPosts";
import { OUTBOX_POLL, sameOutbox } from "../outbox";
import { TRANSCRIPT_STEP } from "./terminal/terminalShared";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { useBackLayer } from "../backStack";
import { startVisiblePoll } from "../visiblePoll";

const POLL = 5_000;

/** The files of one agent tab's conversation, reached from its card's ⋯
 * sheet without opening the chat: what it produced — sent with
 * `tabtivity-send`, changed, named in its answers — and what it got from the
 * phone. The same groups and tiles as the chat's Files strip, read off the
 * stored session the Reader reads (the newest `TRANSCRIPT_STEP` turns); a tap
 * opens the file (`onOpen`). `project`: where changed and named files open,
 * none when the phone may not browse the project's files. */
export function TabFilesSheet({ tab, project, onClose, onOpen }: {
  tab: TabRow;
  project: string | undefined;
  onClose: () => void;
  onOpen: (row: SentFile) => void;
}) {
  useBackLayer(onClose);
  const t = useT();
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);
  useEffect(() => {
    let version: string | undefined;
    // Gated like the subagents sheet: one left open with the screen off must
    // not keep a desktop round trip going.
    return startVisiblePoll((signal) => getTranscript(tab.id, version, TRANSCRIPT_STEP, signal).then(
      (next) => {
        if (signal.aborted || next.unchanged) return;
        version = next.version;
        setFailed(!next.available);
        setEntries(next.available ? next.entries : []);
      },
      () => {
        if (signal.aborted) return;
        setFailed(true);
        setEntries((current) => current ?? []);
      },
    ), POLL).stop;
  }, [tab.id]);
  useEffect(() => startVisiblePoll((signal) => listOutbox({ tab: tab.id }, signal).then(
    (files) => {
      if (signal.aborted || !Array.isArray(files)) return;
      setOutbox((current) => sameOutbox(current, files) ? current : files);
    },
    () => {},
  ), OUTBOX_POLL).stop, [tab.id]);

  const session = useMemo(() => entries ?? [], [entries]);
  // Of what the tab sent, only the sends this conversation shows — as the chat.
  const posted = useMemo(
    () => [...outboxPosts(session, outbox.filter((file) => file.from_tab)).values()].flat().flatMap((post) => post.files),
    [session, outbox],
  );
  const leaves = useMemo(() => promptLeavesOf(session), [session]);
  const inbox = useInboxFiles(tab.id, leaves);
  const answers = useMemo(() => answerTextsOf(session), [session]);
  const named = useNamedFiles(tab.id, answers, !!project);
  const changed = useChangedFiles(tab.id, !!project);
  const files = useMemo(() => sentFiles(posted, leaves, inbox, changed.files, named), [posted, leaves, inbox, changed.files, named]);
  /** A hold's Delete: a file the agent sent loses its outbox copy, one the
   * phone sent leaves the inbox — the row goes now, not at the next poll. */
  const remove = async ({ file, from }: SentFile) => {
    if (from === "phone") {
      await deleteInboxFile(tab.id, file.name);
      markInboxGone(tab.id, file.name);
      return;
    }
    await deleteOutboxFile({ tab: tab.id }, file.name);
    setOutbox((current) => current.filter((row) => row.name !== file.name));
  };

  const title = t("mobile.tabFilesSheet.title", { label: tab.label });
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet tab-files-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}><CloseIcon size="1em" /></button><h2>{title} {isUntested("mobile.project.tabFiles") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      {files.length > 0
        ? <SentFilesGroups tabId={tab.id} project={project} files={files} more={changed.more} onOpen={onOpen} onRemove={remove} />
        : entries === null
        ? <p className="sheet-note" role="status">{t("mobile.subagentSheet.loading")}</p>
        : <p className={failed ? "sheet-note error" : "sheet-note"} role={failed ? "alert" : "status"}>{t(failed ? "mobile.subagentSheet.failed" : "mobile.tabFilesSheet.none")}</p>}
    </section>
  </div>;
}
