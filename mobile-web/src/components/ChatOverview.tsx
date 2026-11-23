import { useState, type ReactNode } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import type { OutboxFile, OutboxScope, TranscriptEntry } from "../api";
import type { ChatLink } from "../terminal/chatLinks";
import { ChevronLeftIcon } from "../glyphs";
import { ChatLinkRows } from "./ChatLinksIndex";
import { OutboxGrid } from "./OutboxGrid";
import { SentFilesGroups, type SentFile } from "./SentFilesIndex";
import { SubagentIndexGroups } from "./SubagentIndexGroups";

/** What the pane beside a landscape iPad's chat shows: the session's lists,
 * the project's files library (drawn by `ProjectFiles` under this pane's
 * head), or a file opened from the chat (its viewer, likewise). */
export type OverviewMode = "overview" | "library" | "file";

/** How many of each list the overview shows before its Show all. */
const FINISHED_SHOWN = 3;
const FILES_SHOWN = 4;
const SENT_SHOWN = 3;
const LINKS_SHOWN = 4;

/**
 * The session overview: the pane on the right of a landscape iPad's chat
 * (`Terminal` mounts it as a sibling of the chat's body, so a turn of the
 * iPad only adds or drops it). It holds what the transcript's index chips and
 * the header's queue and sent-files pills hold on a phone, all at once: the
 * subagents (running first, then the newest finished ones), the prompt queue,
 * the conversation's files, the files the agent sent as tiles, and the links.
 * A section is drawn only when it has something; with none, one muted line.
 * Rows and tiles are the chat index's and the gallery's own, so a tap opens
 * what it opens there and a hold on a file asks what to do with it.
 *
 * In `library` and `file` mode the pane is only its head, a way back to the
 * overview; the library and the viewer stand under it (the stylesheet places
 * them in the pane's column), mounted where they always are.
 */
export function ChatOverview({ mode, onBack, tabId, project, agents, earlierAgents, agentsEarlier, busy, onOpenAgent, onEarlier, queued, queueOpen, onQueue, files, filesMore, onOpenFile, onRemoveFile, sent, sentScope, onOpenSent, onSentDetails, onGallery, links, onOpenLink, onLibrary }: {
  mode: OverviewMode;
  onBack: () => void;
  tabId: string;
  project?: string;
  /** The session's subagents, oldest first, and how many earlier turns hold. */
  agents: readonly TranscriptEntry[];
  earlierAgents: number;
  /** Earlier turns may hold more subagents than are read: Find them. */
  agentsEarlier: boolean;
  busy: boolean;
  onOpenAgent: (entry: TranscriptEntry) => void;
  onEarlier: () => void;
  /** Prompts queued behind the turn; the row opens the queue's sheet. */
  queued: number;
  queueOpen: boolean;
  onQueue: () => void;
  /** The conversation's files, newest first (`sentFiles`). */
  files: readonly SentFile[];
  filesMore: boolean;
  onOpenFile: (row: SentFile) => void;
  onRemoveFile: (row: SentFile) => Promise<void>;
  /** What the agent sent from this tab, newest first; Show all is the gallery. */
  sent: readonly OutboxFile[];
  sentScope: OutboxScope;
  onOpenSent: (file: OutboxFile) => void;
  onSentDetails: (file: OutboxFile) => void;
  onGallery: () => void;
  links: readonly ChatLink[];
  onOpenLink: (url: string) => void;
  /** Switches the pane to the project's files library; left out while the
   * desktop's "Project files on the phone" switch is off for the project. */
  onLibrary?: () => void;
}) {
  const t = useT();
  const [allFiles, setAllFiles] = useState(false);
  const [allLinks, setAllLinks] = useState(false);
  const untested = isUntested("mobile.chatOverview") && <span className="untested">{t("mobile.newTab.untested")}</span>;

  if (mode !== "overview") {
    return <aside className="chat-overview" aria-label={t("mobile.chatOverview.region")}>
      <div className="chat-overview-head">
        <button type="button" className="chat-overview-back" onClick={onBack} aria-label={t("mobile.chatOverview.backLabel")}>
          <ChevronLeftIcon size="1em" /><span>{t("mobile.chatOverview.title")}</span>
        </button>
        {untested}
      </div>
    </aside>;
  }

  const agentsShown = agents.length > 0 || agentsEarlier;
  const libraryButton = onLibrary && <button type="button" className="chat-overview-action" onClick={onLibrary}>{t("mobile.chatOverview.projectFiles")}</button>;
  const section = (key: string, title: string, body: ReactNode, action?: ReactNode) => <section key={key} className="chat-overview-section" aria-label={title}>
    <div className="chat-overview-section-head"><h3>{title}</h3>{action}</div>
    {body}
  </section>;
  const sections = [
    agentsShown && section("agents", t("mobile.subagent.index", { count: agents.length + earlierAgents }), <div className="subagent-index-list">
      <SubagentIndexGroups agents={agents} busy={busy} onOpen={onOpenAgent} finishedCap={FINISHED_SHOWN} />
      {agentsEarlier && <button type="button" className="subagent-index-earlier" onClick={onEarlier}>{t("mobile.subagent.earlier")}</button>}
    </div>),
    queued > 0 && section("queue", t("mobile.queue.title"), <ul className="chat-link-index-list">
      <li><button type="button" onClick={onQueue} aria-haspopup="dialog" aria-expanded={queueOpen} aria-label={t("mobile.queue.count", { count: queued })}>
        <span>{t("mobile.chatOverview.queued", { count: queued })}</span>
      </button></li>
    </ul>),
    files.length > 0 && section("files", t("mobile.sentIndex.toggle", { count: files.length }), <>
      <SentFilesGroups tabId={tabId} project={project} files={allFiles ? files : files.slice(0, FILES_SHOWN)} more={(allFiles || files.length <= FILES_SHOWN) && filesMore} onOpen={onOpenFile} onRemove={onRemoveFile} />
      {!allFiles && files.length > FILES_SHOWN && <button type="button" className="chat-overview-more" onClick={() => setAllFiles(true)}>{t("mobile.chatOverview.showAll", { count: files.length })}</button>}
    </>, libraryButton),
    sent.length > 0 && section("sent", t("mobile.outbox.galleryOpen", { count: sent.length }), <>
      <OutboxGrid scope={sentScope} files={sent.slice(0, SENT_SHOWN)} onOpen={onOpenSent} onDetails={onSentDetails} />
      <button type="button" className="chat-overview-more" aria-haspopup="dialog" onClick={onGallery}>{t("mobile.chatOverview.showAll", { count: sent.length })}</button>
    </>),
    links.length > 0 && section("links", t("mobile.chatLinks.toggle", { count: links.length }), <>
      <ChatLinkRows links={allLinks ? links : links.slice(0, LINKS_SHOWN)} onOpen={onOpenLink} />
      {!allLinks && links.length > LINKS_SHOWN && <button type="button" className="chat-overview-more" onClick={() => setAllLinks(true)}>{t("mobile.chatOverview.showAll", { count: links.length })}</button>}
    </>),
  ].filter(Boolean);

  return <aside className="chat-overview" aria-label={t("mobile.chatOverview.region")}>
    <div className="chat-overview-head">
      <h2 className="chat-overview-title">{t("mobile.chatOverview.title")}</h2>
      {untested}
    </div>
    <div className="chat-overview-body">
      {sections}
      {sections.length === 0 && <p className="chat-overview-empty">{t("mobile.chatOverview.empty")}</p>}
      {/* Without a Files section the library still has its way in. */}
      {files.length === 0 && libraryButton}
    </div>
  </aside>;
}
