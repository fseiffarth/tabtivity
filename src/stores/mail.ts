import { create } from "zustand";
import {
  mailAccountDelete,
  mailAgentDrafts,
  mailAccountsList,
  mailFlag,
  mailFolders,
  mailHeaders,
  mailMarkFolderRead,
  mailMove,
  mailPriorityClear,
  mailPriorityCounts,
  mailPriorityPage,
  mailPrioritySet,
  mailAgentMark,
  mailAgentMarkFolder,
  mailAgentMarkSender,
  mailAgentMarks,
  mailContactsGet,
  mailPurge,
  mailSearch,
  mailSync,
  mailSyncCancel,
  planMailDelete,
} from "../lib/mail";
import { translate, useI18nStore } from "../lib/i18n";
import type {
  MailAccount,
  MailBody,
  MailContact,
  MailContactList,
  MailDraft,
  MailFlag,
  MailFolder,
  MailHeader,
  MailPriority,
  MailPriorityCounts,
  MailSort,
  MailSyncPhase,
} from "../types/mail";

/** The mail window's fixed first tab: folders, list and preview. */
export const MAIL_INBOX_TAB = "inbox";

export type MailComposeMode = "new" | "reply" | "replyAll" | "forward";

/** A message opened in its own tab. The header is a snapshot: the tab fetches
 *  its own body, so it survives the Inbox list moving on to another folder. */
export interface MailMessageTab {
  id: string;
  kind: "message";
  header: MailHeader;
}

/** An unfinished mail in its own tab — everything the composer is opened with. */
export interface MailComposeTab {
  id: string;
  kind: "compose";
  mode: MailComposeMode;
  accountId: string;
  source?: { header: MailHeader; body: MailBody | null };
  toAddress?: string;
  draft?: MailDraft;
  /** The subject as last typed, for the tab's label. */
  subject?: string;
  /** Edited since it opened: closing it asks before the text is thrown away. */
  dirty: boolean;
}

/** The Address Book — one tab at most, so its id is fixed. `request` is how
 *  a message's "Add to address book" reaches an already-open book: a new
 *  `seq` makes it select (or start) the card for that address. */
export const MAIL_CONTACTS_TAB = "contacts";
export interface MailContactsTab {
  id: typeof MAIL_CONTACTS_TAB;
  kind: "contacts";
  request?: { seq: number; address: string; name?: string };
}

export type MailTab = MailMessageTab | MailComposeTab | MailContactsTab;

let contactsSeq = 0;

let composeSeq = 0;

/**
 * The mail client's store: accounts, folders, the header index page, the
 * selected message and its body — one global set, backed by
 * `~/.local/share/tabtivity/mail/`.
 *
 * Modeled on `stores/calendar/calendar.ts`, and deliberately **global** — one mailbox, no
 * matter which project is active. That is also what retired the mail *tab*: a tab
 * belongs to a scope, so a mail tab could only ever show the same mailbox this
 * store already holds while behaving as though it belonged to a project you then
 * switched away from. The single surface is the header overlay
 * (`MailOverlayHost`), and this store is what makes it stateful across it.
 *
 * Three rules distinguish it from the calendar store, all of them consequences
 * of mail being the app's first *network* store:
 *
 *  1. **Nothing here connects on its own.** `loadAccounts` and `openFolder` read
 *     the local index only; opening the overlay renders from it and shows a
 *     "Check mail" button. `checkMail` and a typed folder search can reach a server.
 *     It is called from a click — with exactly one exception, and that one is an
 *     opt-in: the header's mail button (`MailIndicator`) runs it on a timer once
 *     `mail_client` is on — off for everyone outside debug mode, which is what
 *     keeps this rule true by default. Nothing else, and nothing at launch,
 *     ever starts it. The header's unread badge is *not* an exception: it is
 *     derived from the local folder counts (`refreshUnread`), so it can be right
 *     at launch without anything dialling out.
 *  2. **Every action tolerates a rejected invoke.** The backend can be mid-build,
 *     the account can be misconfigured, the server can be unreachable for the
 *     whole TCP timeout — so a failure lands in `error` (and clears `busy`),
 *     never as an unhandled rejection that leaves a pane spinning forever.
 *  3. **Remote content is blocked, with nothing here that can unblock it.** The
 *     backend has no image proxy yet, so there is deliberately no "load remote
 *     content" action to call — one would clear the banner, report success and
 *     fetch nothing. `MailBody.remote_refs` drives a purely informational strip
 *     until that proxy exists (`docs/mail_client_plan_b.md` §2.6).
 */

/** Live progress of a sync, driven by the `mail:sync` event listener. */
export interface MailSyncState {
  phase: MailSyncPhase;
  folderId?: string;
  newMessages?: number;
  /** Of those, how many a filter rule filed into Important/Urgent. Shown beside
   *  the arrival count rather than instead of it: a mark nobody made has to be
   *  visible at the moment it happens, or the rules stop being trustworthy. */
  filtered?: number;
  error?: string;
}

/** How many headers one page of the list holds. */
export const MAIL_PAGE_SIZE = 100;

interface MailStore {
  accounts: MailAccount[];
  accountsLoaded: boolean;
  /** Folders per account id. Absent = never loaded (not "no folders"). */
  foldersByAccount: Record<string, MailFolder[]>;

  selectedAccountId: string | null;
  selectedFolderId: string | null;
  selectedMessageId: string | null;
  /**
   * The rows ticked for a bulk action — Ctrl-click and Shift-click in the list.
   *
   * Distinct from `selectedMessageId`, which is the *open* message, because the
   * two answer different questions: one message is being read, any number can be
   * filed or deleted at once. Every action still works with the set empty, in
   * which case it is about the row it was invoked on — a menu that does nothing
   * until something is ticked would make right-click useless for one message.
   *
   * It belongs to the **page**: `loadPage` clears it, because a folder change, a
   * re-sort, a search keystroke or a pager step all leave ids that name mail the
   * user can no longer see, and a bulk delete aimed at rows off screen is the
   * one mistake this feature can make.
   */
  checkedIds: string[];
  /** The row a Shift-click measures its range from. */
  anchorId: string | null;
  /**
   * The priority list currently on screen, or `null` when an ordinary folder is.
   *
   * These are the two states of ONE list: `selectedPriority` and
   * `selectedFolderId` are mutually exclusive, and every read path checks this
   * one first (`loadPage`). Modeling the Important list as a pseudo-*folder* id
   * was the obvious alternative and it is wrong — a folder id is passed to
   * `mail_headers`, `mail_mark_folder_read` and `mail_move`, all of which resolve
   * it against the store and would fail (or worse, half-succeed) on a name no
   * folder has. A separate field makes the two impossible to confuse.
   */
  selectedPriority: MailPriority | null;
  /** Both rail badges, read together. Zeroes until the first refresh — this is a
   *  local read, so it costs no socket and runs whenever the overlay opens. */
  priorityCounts: MailPriorityCounts;

  headers: MailHeader[];
  headerTotal: number;
  /** Set only when a search over an encrypted store stopped at its scan bound;
   *  see `MailHeaderPage.scanned`. Cleared on every page that covered its whole
   *  scope, so a stale note can never outlive the search that produced it. */
  headerScanned?: number;
  /**
   * Whether a folder search reached the server. Its page still comes from the
   * local index after backfill; every other page clears
   * it, so the "downloaded mail only" note can never linger past the search
   * that earned it.
   */
  searchRemote: boolean;
  /** Online search found matches that the backend could not all backfill. */
  searchPartial: boolean;
  headerOffset: number;
  query: string;
  /** What the list is ordered by, and in which direction. Kept here rather than
   *  in the list component because the backend does the ordering — see
   *  `setSort` for why that is not an implementation detail. */
  sort: MailSort;
  sortDesc: boolean;
  /** Only unread messages. A filter over the folder, applied by the backend
   *  for `sort`'s reason: on a paged list, filtering the page would hide the
   *  unread mail that sits on page three. */
  unreadOnly: boolean;
  /** Only the messages marked for agents — the page a contained reader in
   *  "marked" scope is served, so what the chip shows is exactly what such a
   *  reader can reach. Backend-applied, for `unreadOnly`'s reason. */
  agentOnly: boolean;
  /** The selected account's messages marked for agents (ids in the local
   *  index). Re-read after every mark and whenever the account changes. */
  agentMarks: string[];

  loadingHeaders: boolean;
  /** Per-account sync progress, keyed by account id. */
  sync: Record<string, MailSyncState>;
  /** The last thing that went wrong, shown as a dismissible strip. */
  error: string | null;

  /** The header button's mail overlay is on screen — the only mail surface
   *  there is, since the mail tab was retired (`RETIRED_TAB_CMDS`). */
  overlayOpen: boolean;
  /** Inbox messages that arrived since the overlay was last opened. Kept as the
   *  *emphasis* signal only — the header dot's number is `inboxUnread`, which
   *  survives a relaunch and falls as mail is read. This one is what still
   *  distinguishes "something turned up while you were working" from a backlog,
   *  and it is why an arrival refreshes the counts rather than being counted. */
  newCount: number;

  setError: (message: string | null) => void;
  /** Adopt a `mail:sync` event. Called by the pane's listener. */
  applySyncEvent: (accountId: string, state: MailSyncState) => void;

  /** Adopt a `mail:new` event. Installed once per window by `MailIndicator`, so
   *  it sees whatever caused the sync — a click in the overlay, a click in a
   *  mail tab, or the opt-in interval check. It re-reads the account's folder
   *  counts (local) rather than incrementing a number of its own: the badge is
   *  derived from those counts, and a sync path that forgot to reload them
   *  would otherwise leave the dot a message behind. */
  noteArrival: (accountId: string, count: number) => void;
  openOverlay: () => void;
  /** Open the overlay on its Inbox tab — for every "show me this in mail"
   *  path (a message or folder was just selected for the Inbox to show). The
   *  plain ✉ toggle uses `openOverlay`, which keeps whichever tab was last up. */
  openInbox: () => void;
  closeOverlay: () => void;

  /** The account editor on screen: `{ account: null }` adds one. In the store
   *  because two surfaces open it — the title bar's accounts dropdown (✎ per
   *  row, Add account last) and the pane's empty state — and `MailPane` hosts
   *  the one dialog, so its after-save steps stay in one place. */
  accountDialog: { account: MailAccount | null } | null;
  openAccountDialog: (account: MailAccount | null) => void;
  closeAccountDialog: () => void;

  /** Drafts an agent wrote through the root MCP (`origin` set) that the user
   *  has not yet sent, discarded or edited, split by approval: `agentDrafts`
   *  is the "Drafted by agents" folder (approved, `filed`), `pendingAgentDrafts`
   *  what still waits in ✓ Approvals. Refreshed on `root-mcp-changed` kind
   *  `draft`. */
  agentDrafts: MailDraft[];
  pendingAgentDrafts: MailDraft[];
  loadAgentDrafts: () => Promise<void>;
  /** Open the overlay on an agent draft's account with the composer on it, in
   *  its own tab — never an "approve": the composer's Send stays the only way
   *  out. A draft already open in a tab is focused rather than opened twice. */
  openAgentDraft: (draft: MailDraft | null) => Promise<void>;

  /** The mail window's tabs beyond the fixed Inbox tab: opened messages and
   *  unfinished mails (new, reply, forward, an agent's draft). Session state
   *  only — a composer's text lives in its mounted component, which the overlay
   *  keeps alive while it is closed, so nothing here is persisted. */
  mailTabs: MailTab[];
  /** `MAIL_INBOX_TAB` or the id of one of `mailTabs`. */
  activeMailTab: string;
  setActiveMailTab: (id: string) => void;
  /** Open a message in its own tab (or focus the tab it already has). */
  openMessageTab: (header: MailHeader) => void;
  /** Open a composer tab and focus it. Returns the tab id. */
  openComposeTab: (spec: Omit<MailComposeTab, "id" | "kind" | "dirty">) => string;
  /** A composer tab was edited: closing it now asks first. */
  markComposeDirty: (id: string, subject?: string) => void;
  /** A composer tab's draft was saved: nothing on screen is unsaved any more. */
  markComposeClean: (id: string, subject?: string) => void;
  closeMailTab: (id: string) => void;
  /** Drop every composer tab — the `mail_client` flag went off, and the
   *  composers holding their text are unmounting with the overlay. */
  dropComposeTabs: () => void;

  /** The address book (`contacts.json`), read whole: the Address Book tab and
   *  every recipient field's autocomplete share this copy. */
  contacts: MailContact[];
  contactLists: MailContactList[];
  /** Outgoing addresses no card holds go to the Collected book. */
  collectOutgoing: boolean;
  contactsLoaded: boolean;
  /** Why the book could not be read (a damaged or locked file). */
  contactsError: string | null;
  loadContacts: () => Promise<void>;
  /** Open (or focus) the Address Book tab; with `prefill`, on the card holding
   *  that address, or a new card for it. */
  openContactsTab: (prefill?: { address: string; name?: string }) => void;

  /**
   * Open the overlay **on** a given account — the header dropdown's account rows.
   *
   * It lives here rather than in the button because it is two state changes that
   * have to happen in one gesture: a caller that opened the overlay and then
   * selected would render one frame of whatever was last on screen, and a caller
   * that selected first would move the list under an overlay that is not open yet
   * (and, if the user never opens it, silently retarget the *next* one).
   */
  openAccountView: (accountId: string) => Promise<void>;
  /** The same for the Important/Urgent lists — every account's marked mail. */
  openPriorityView: (priority: MailPriority) => Promise<void>;

  /** Read every account's folder counts from the local index — no socket. What
   *  the header's unread badge needs before any mail surface has been opened,
   *  and the one thing `loadAccounts` alone does not give it. */
  refreshUnread: () => Promise<void>;

  /** Read the account list (local). Safe to call repeatedly. */
  loadAccounts: (opts?: { force?: boolean; preferred?: string }) => Promise<void>;
  /** Re-read after the account dialog wrote. */
  reloadAccounts: (preferred?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  selectAccount: (accountId: string) => Promise<void>;
  /** Load an account's folders. `refresh` hits the server — click paths only. */
  loadFolders: (accountId: string, refresh?: boolean) => Promise<void>;
  openFolder: (folderId: string) => Promise<void>;
  /** Show the Important or Urgent list — every account's marked mail in one
   *  place. Local read, like `openFolder`; clears the folder selection, since
   *  the two are the same list in two states. */
  openPriority: (priority: MailPriority) => Promise<void>;
  /** Mark — or with `null`, unmark — one message. The right-click action.
   *  Reaches no server (`MailPriority`), so this is safe from any path. */
  setPriority: (messageId: string, priority: MailPriority | null) => Promise<void>;
  /** Empty a whole list — unmark **every** message carrying `priority`. The
   *  bulk form of `setPriority(…, null)`, local like it, and asked about by the
   *  caller before it gets here: a mark is not a folder, so nothing moves and
   *  nothing is deleted, but the filing itself is the user's own work. */
  clearPriority: (priority: MailPriority) => Promise<void>;
  /** Re-read both badge counts (local). */
  refreshPriorityCounts: () => Promise<void>;
  /** Search immediately, for explicit store actions and tests. */
  setQuery: (query: string) => Promise<void>;
  /** Keep the typed value responsive, but debounce its server request. */
  queueQuery: (query: string) => void;
  /**
   * Re-order the list. Re-reads page 1 rather than re-sorting what is on
   * screen: the order is the *store's*, over the whole folder, so "largest
   * first" reaches the 40 MB mail from two years ago instead of the largest of
   * the hundred newest — which is what a component-side sort would have given.
   *
   * Sending the offset along would be worse than useless: row 200 of a
   * date-sorted folder has nothing to do with row 200 of a size-sorted one, so
   * a re-sort that kept the page number would land somewhere arbitrary.
   */
  setSort: (sort: MailSort, desc: boolean) => Promise<void>;
  setUnreadOnly: (unreadOnly: boolean) => Promise<void>;
  setAgentOnly: (agentOnly: boolean) => Promise<void>;
  /** Re-read `agentMarks` for the selected account. */
  loadAgentMarks: () => Promise<void>;
  /** Mark or unmark messages for a contained reader agent. Local only. */
  setAgentMark: (headers: MailHeader[], marked: boolean) => Promise<void>;
  /** Mark every message of `header`'s account from its sender address. */
  markAgentSender: (header: MailHeader) => Promise<void>;
  /** Mark every message of the selected folder. */
  markAgentFolder: () => Promise<void>;
  /** Drop every narrowing at once — the search and the unread filter — in one
   *  read rather than one per control. */
  clearFilters: () => Promise<void>;
  loadPage: (offset: number) => Promise<void>;
  /**
   * The pager's step, as opposed to `loadPage`'s re-read in place.
   *
   * Under `unreadOnly` the offset counts rows of a set that **shrinks as it is
   * read**: every message opened on this page has left the filter by the time
   * "Older" is pressed, so the rows behind it have all moved up by that many.
   * Stepping a whole page would skip exactly that many unread mails — silently,
   * which for the one view whose job is "what have I not read" is the worst
   * way to be wrong. So a forward step gives back the rows that left.
   */
  stepPage: (offset: number) => Promise<void>;

  /**
   * Open a message of the loaded page in its own mail-window tab — the Inbox
   * has no preview pane, so this is what a click on a row does. Also the row
   * the list marks as last opened. A message not in the page opens nothing.
   */
  openMessage: (messageId: string) => void;
  /** Tick exactly this row and nothing else, and anchor a later range on it. */
  checkOnly: (messageId: string) => void;
  /** Ctrl-click: add or remove one row, leaving the rest of the set alone. */
  toggleChecked: (messageId: string) => void;
  /** Shift-click: tick every row between the anchor and this one, in the order
   *  the list is showing — which is why it takes that order rather than reading
   *  `headers`: the rows on screen are the rows a range may cover. */
  checkRange: (messageId: string, order: string[]) => void;
  clearChecked: () => void;
  /**
   * Delete messages — into each account's Trash where there is one, off the
   * server where there is not (`planMailDelete`).
   *
   * The caller confirms the permanent half **first**: this reaches a server the
   * moment it is called and there is no undo for the purge branch. Grouped per
   * folder because that is what the commands take, and a group that fails lands
   * in `error` without stopping the others — one account being unreachable is no
   * reason to leave the other's mail undeleted.
   */
  deleteMessages: (messageIds: string[]) => Promise<void>;
  /** Re-fetch the open body with remote references resolved (explicit click). */
  setFlag: (messageId: string, flag: MailFlag, value: boolean) => Promise<void>;
  /** Mark every unread message in a folder read, locally and on the server.
   *  Reaches a socket — a click path only, like `checkMail`. */
  markFolderRead: (folderId: string) => Promise<void>;

  /** THE network action. Never called from a launch, restore or render path. */
  checkMail: (accountId: string, folderId?: string | null) => Promise<void>;
  cancelCheck: (accountId: string) => Promise<void>;
  /** Forget an account's last sync outcome — after its settings are saved, so a
   *  rejected login stops pausing the background check (`backgroundCheckBlocked`). */
  clearSyncState: (accountId: string) => void;
}

/** A rejected invoke's message, as a string the UI can show. */
function reason(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The folder a freshly-selected account should open on: its inbox, else the
 *  first folder it has, else nothing. */
function defaultFolder(folders: MailFolder[]): MailFolder | undefined {
  return folders.find((f) => f.kind === "inbox") ?? folders[0];
}

/**
 * Which header page is the current one.
 *
 * `setQuery` fires on **every keystroke** and `openFolder` on every rail click,
 * so several `mail_headers`/`mail_priority_page` reads are routinely in flight
 * at once — and over an encrypted store a search scans until its bound, which
 * makes the *earlier*, shorter query the slow one often enough to matter. Every
 * other await in this store already guards against its own staleness
 * (a message tab's body read checks it is still mounted); this is `loadPage`'s
 * equivalent, and it has to be a counter rather than a re-read of the selection
 * because two reads for the *same* folder — as a query changes — differ only in
 * which request they are.
 *
 * A superseded answer is dropped whole, `loadingHeaders` included: the newer
 * request is still running and owns the spinner.
 */
let pageToken = 0;
const SEARCH_DEBOUNCE_MS = 300;
let queuedSearchTimer: ReturnType<typeof setTimeout> | null = null;
let queuedSearch = false;

function clearQueuedSearchTimer() {
  if (queuedSearchTimer !== null) clearTimeout(queuedSearchTimer);
  queuedSearchTimer = null;
}

function resumeQueuedSearch(get: () => MailStore) {
  if (queuedSearch && get().overlayOpen && get().activeMailTab === MAIL_INBOX_TAB) {
    void get().loadPage(0);
  }
}

export const useMailStore = create<MailStore>((set, get) => ({
  accounts: [],
  accountsLoaded: false,
  foldersByAccount: {},

  selectedAccountId: null,
  selectedFolderId: null,
  selectedMessageId: null,
  checkedIds: [],
  anchorId: null,
  selectedPriority: null,
  priorityCounts: { important: 0, urgent: 0, important_unread: 0, urgent_unread: 0 },

  headers: [],
  headerTotal: 0,
  headerOffset: 0,
  query: "",
  searchRemote: false,
  searchPartial: false,
  sort: "date",
  sortDesc: true,
  unreadOnly: false,
  agentOnly: false,
  agentMarks: [],

  loadingHeaders: false,
  sync: {},
  error: null,

  overlayOpen: false,
  newCount: 0,

  setError: (message) => set({ error: message }),

  noteArrival: (accountId, count) => {
    set((s) => ({
      // Opening the overlay is what acknowledges an arrival, so mail that lands
      // while it is already on screen is read, not announced — a badge on a
      // button the user is looking through would have to be dismissed by hand.
      newCount: s.overlayOpen ? 0 : s.newCount + Math.max(0, count),
    }));
    // The count the badge actually shows lives in the folder rows the sync just
    // wrote. `checkMail` reloads them too, but an arrival can also come from a
    // sync this window did not start, and that path has to move the dot as well.
    void get().loadFolders(accountId, false);
  },

  openOverlay: () => {
    set({ overlayOpen: true, newCount: 0 });
    resumeQueuedSearch(get);
    // Opening mail does not mark anything read, so the badge deliberately stays
    // — but the pane is about to show folder rows, and both should agree.
    void get().refreshUnread();
    // The rail's Important/Urgent badges, likewise local and likewise needed
    // before anything is clicked.
    void get().refreshPriorityCounts();
  },
  openInbox: () => {
    set({ activeMailTab: MAIL_INBOX_TAB });
    get().openOverlay();
  },
  closeOverlay: () => {
    clearQueuedSearchTimer();
    set({ overlayOpen: false });
  },

  accountDialog: null,
  openAccountDialog: (account) => set({ accountDialog: { account } }),
  closeAccountDialog: () => set({ accountDialog: null }),

  agentDrafts: [],
  pendingAgentDrafts: [],
  loadAgentDrafts: async () => {
    // A locked or never-opened store lists nothing; that is not an error here.
    const listed = await mailAgentDrafts().catch(() => [] as MailDraft[]);
    const drafts = Array.isArray(listed) ? listed : [];
    set({
      agentDrafts: drafts.filter((d) => d.filed),
      pendingAgentDrafts: drafts.filter((d) => !d.filed),
    });
  },
  openAgentDraft: async (draft) => {
    if (!draft) return;
    get().openOverlay();
    const open = get().mailTabs.find((tab) => tab.kind === "compose" && tab.draft?.id === draft.id);
    if (open) return get().setActiveMailTab(open.id);
    if (get().selectedAccountId !== draft.account_id) await get().selectAccount(draft.account_id);
    // Asked again after the await: a second click on the same draft while the
    // account loaded has opened its tab by now.
    const opened = get().mailTabs.find((tab) => tab.kind === "compose" && tab.draft?.id === draft.id);
    if (opened) return set({ activeMailTab: opened.id });
    get().openComposeTab({ mode: "new", accountId: draft.account_id, draft });
  },

  mailTabs: [],
  activeMailTab: MAIL_INBOX_TAB,
  setActiveMailTab: (id) => {
    set((s) => ({
      activeMailTab: id === MAIL_INBOX_TAB || s.mailTabs.some((tab) => tab.id === id) ? id : MAIL_INBOX_TAB,
    }));
    if (get().activeMailTab !== MAIL_INBOX_TAB) clearQueuedSearchTimer();
    else resumeQueuedSearch(get);
  },
  openMessageTab: (header) => {
    clearQueuedSearchTimer();
    const open = get().mailTabs.find((tab) => tab.kind === "message" && tab.header.id === header.id);
    if (open) return set({ activeMailTab: open.id });
    const id = `msg:${header.id}`;
    set((s) => ({ mailTabs: [...s.mailTabs, { id, kind: "message", header }], activeMailTab: id }));
  },
  openComposeTab: (spec) => {
    clearQueuedSearchTimer();
    const id = `compose:${++composeSeq}`;
    set((s) => ({
      mailTabs: [...s.mailTabs, { ...spec, id, kind: "compose", dirty: false }],
      activeMailTab: id,
    }));
    return id;
  },
  markComposeDirty: (id, subject) =>
    set((s) => {
      const tab = s.mailTabs.find((t) => t.id === id);
      if (!tab || tab.kind !== "compose") return s;
      if (tab.dirty && (subject === undefined || subject === tab.subject)) return s;
      return {
        mailTabs: s.mailTabs.map((t) =>
          t.id === id && t.kind === "compose"
            ? { ...t, dirty: true, ...(subject !== undefined ? { subject } : {}) }
            : t,
        ),
      };
    }),
  markComposeClean: (id, subject) =>
    set((s) => ({
      mailTabs: s.mailTabs.map((t) =>
        t.id === id && t.kind === "compose"
          ? { ...t, dirty: false, ...(subject !== undefined ? { subject } : {}) }
          : t,
      ),
    })),
  dropComposeTabs: () => {
    set((s) => {
      if (!s.mailTabs.some((tab) => tab.kind === "compose")) return s;
      const mailTabs = s.mailTabs.filter((tab) => tab.kind !== "compose");
      const activeMailTab = mailTabs.some((tab) => tab.id === s.activeMailTab)
        ? s.activeMailTab
        : MAIL_INBOX_TAB;
      return { mailTabs, activeMailTab };
    });
    resumeQueuedSearch(get);
  },
  contacts: [],
  contactLists: [],
  collectOutgoing: true,
  contactsLoaded: false,
  contactsError: null,
  loadContacts: async () => {
    try {
      const view = await mailContactsGet();
      set({
        contacts: Array.isArray(view?.contacts) ? view.contacts : [],
        contactLists: Array.isArray(view?.lists) ? view.lists : [],
        collectOutgoing: view?.collect_outgoing !== false,
        contactsLoaded: true,
        contactsError: null,
      });
    } catch (err) {
      set({ contactsLoaded: true, contactsError: typeof err === "string" ? err : String(err) });
    }
  },
  openContactsTab: (prefill) => {
    clearQueuedSearchTimer();
    const request = prefill ? { seq: ++contactsSeq, ...prefill } : undefined;
    set((s) => {
      const open = s.mailTabs.some((tab) => tab.kind === "contacts");
      const tab: MailContactsTab = { id: MAIL_CONTACTS_TAB, kind: "contacts", ...(request ? { request } : {}) };
      return {
        mailTabs: open
          ? s.mailTabs.map((t) => (t.kind === "contacts" ? { ...t, ...(request ? { request } : {}) } : t))
          : [...s.mailTabs, tab],
        activeMailTab: MAIL_CONTACTS_TAB,
      };
    });
  },
  closeMailTab: (id) => {
    set((s) => {
      const index = s.mailTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return s;
      const mailTabs = s.mailTabs.filter((tab) => tab.id !== id);
      // Closing the tab on screen lands on its left neighbour, the Inbox last —
      // what closing a tab does in every other strip.
      const activeMailTab =
        s.activeMailTab === id ? (mailTabs[index - 1]?.id ?? MAIL_INBOX_TAB) : s.activeMailTab;
      return { mailTabs, activeMailTab };
    });
    resumeQueuedSearch(get);
  },

  openAccountView: async (accountId) => {
    get().openInbox();
    // Re-selecting the account that is already showing one of its folders is a
    // no-op on purpose: `selectAccount` re-opens the inbox, so a second click on
    // the row you are already reading would throw away the folder you navigated
    // to. Coming back from a priority list is not that case — there is no folder
    // on screen, which is exactly when the account has to be re-entered.
    const { selectedAccountId, selectedFolderId, selectedPriority } = get();
    if (selectedAccountId === accountId && selectedFolderId && !selectedPriority) return;
    await get().selectAccount(accountId);
  },

  openPriorityView: async (priority) => {
    get().openInbox();
    await get().openPriority(priority);
  },

  refreshUnread: async () => {
    await get().loadAccounts();
    const { accounts } = get();
    await Promise.all(accounts.map((a) => get().loadFolders(a.id, false)));
  },

  applySyncEvent: (accountId, state) =>
    set((s) => ({
      sync: { ...s.sync, [accountId]: state },
      // A sync error is the user's business even though the command may still
      // resolve — the event is what carries the reason.
      error: state.phase === "error" ? (state.error ?? s.error) : s.error,
    })),

  loadAccounts: async (opts) => {
    if (get().accountsLoaded && !opts?.force) return;
    await get().reloadAccounts(opts?.preferred);
  },

  reloadAccounts: async (preferred) => {
    const accounts = await mailAccountsList().catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    if (!accounts) {
      // Still "loaded": the pane must render its empty state and its retry, not
      // sit on a spinner forever because the backend refused once.
      set({ accountsLoaded: true });
      return;
    }
    const current = get().selectedAccountId;
    const keep =
      (preferred && accounts.some((a) => a.id === preferred) && preferred) ||
      (current && accounts.some((a) => a.id === current) && current) ||
      accounts[0]?.id ||
      null;
    set({ accounts, accountsLoaded: true });
    if (keep && keep !== current) {
      await get().selectAccount(keep);
    } else if (!keep) {
      set({ selectedAccountId: null, selectedFolderId: null, headers: [] });
    } else {
      // Same account still selected, so nothing above refetched anything — but
      // an account edit can change what the *already-loaded* headers mean.
      // `authserv_id` is the case: the backend attaches the SPF/DKIM/DMARC trust
      // state per read (`serve_auth_state`), so headers fetched before the edit
      // carry the old verdicts until something asks for them again. Without
      // this, setting or clearing the trusted server name appears to do nothing
      // until you switch folders — at precisely the moment the user is trying
      // to see whether their change took effect.
      await get().loadPage(get().headerOffset);
    }
  },

  removeAccount: async (accountId) => {
    await mailAccountDelete(accountId).catch((err) => set({ error: reason(err) }));
    set((s) => {
      const folders = { ...s.foldersByAccount };
      delete folders[accountId];
      return { foldersByAccount: folders };
    });
    await get().reloadAccounts();
  },

  selectAccount: async (accountId) => {
    set({
      selectedAccountId: accountId,
      selectedFolderId: null,
      // Picking an account leaves the cross-account list. It has to: the list
      // that follows is one account's, and leaving this set would make `loadPage`
      // keep serving every account's marked mail under an account heading.
      selectedPriority: null,
      selectedMessageId: null,
      headers: [],
      headerTotal: 0,
      headerOffset: 0,
      agentMarks: [],
      agentOnly: false,
        });
    // Local read only — `refresh: false`. Opening an account must never dial out.
    await get().loadFolders(accountId, false);
    void get().loadAgentMarks();
    const folder = defaultFolder(get().foldersByAccount[accountId] ?? []);
    if (folder) await get().openFolder(folder.id);
  },

  loadFolders: async (accountId, refresh = false) => {
    const folders = await mailFolders(accountId, refresh).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    if (!folders) return;
    set((s) => ({ foldersByAccount: { ...s.foldersByAccount, [accountId]: folders } }));
  },

  openFolder: async (folderId) => {
    set({
      selectedFolderId: folderId,
      // Exclusive with the priority list — see `selectedPriority`.
      selectedPriority: null,
      selectedMessageId: null,
          headerOffset: 0,
    });
    await get().loadPage(0);
  },

  openPriority: async (priority) => {
    // The folder selection is dropped, not remembered: a list spanning every
    // account has no folder, and a stale one would leave the rail highlighting a
    // folder whose mail is not what is on screen. The *account* selection stays,
    // because the rail still needs an account expanded to show folders under —
    // and because leaving the list puts you back where you were.
    set({
      selectedPriority: priority,
      selectedFolderId: null,
      selectedMessageId: null,
      headerOffset: 0,
      agentOnly: false,
    });
    await get().loadPage(0);
  },

  setPriority: async (messageId, priority) => {
    // Patch on screen first, for `setFlag`'s reason — except that here the local
    // write IS the whole operation, so the optimism is only about the IPC hop.
    set((s) => ({
      headers: s.headers.map((h) =>
        h.id === messageId ? { ...h, ...(priority ? { priority } : { priority: undefined }) } : h,
      ),
    }));
    const ok = await mailPrioritySet(messageId, priority).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    // A `false` means the message is no longer in the index — the row on screen
    // is stale, and the optimistic patch above just told the user otherwise.
    if (ok === false) {
      // Outside React, so the imperative translator — the pattern
      // `stores/calendar/alarms` and `stores/projects` already use for a store-built
      // sentence.
      set({ error: translate(useI18nStore.getState().lang, "mail.messageGone") });
    }
    await get().refreshPriorityCounts();
    // Unmarking from *inside* a priority list removes the row from that list, so
    // the page has to be re-read; nothing else here changes what a folder shows.
    if (get().selectedPriority) await get().loadPage(get().headerOffset);
  },

  clearPriority: async (priority) => {
    // No optimistic patch, unlike `setPriority`: this one empties the list the
    // user is most likely looking at, so a page blanked before the write landed
    // would be indistinguishable from a write that failed and took the mail with
    // it. The command is a single local statement — there is nothing slow to
    // paper over.
    const cleared = await mailPriorityClear(priority).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    if (cleared === null) return;
    await get().refreshPriorityCounts();
    // Only the list that was emptied is on screen-relevant; a folder shows the
    // same mail either way, and the other priority list was not touched.
    if (get().selectedPriority === priority) await get().loadPage(0);
  },

  refreshPriorityCounts: async () => {
    const counts = await mailPriorityCounts().catch(() => null);
    // Deliberately silent on failure: this is a badge, and a red error strip
    // because two numbers could not be counted would be worse than no numbers.
    if (counts) set({ priorityCounts: counts });
  },

  setQuery: async (query) => {
    set({ query, headerOffset: 0 });
    await get().loadPage(0);
  },

  queueQuery: (query) => {
    clearQueuedSearchTimer();
    // An older request may still be in flight. Its result must not repaint
    // under the new text while the debounce timer is waiting.
    pageToken += 1;
    queuedSearch = true;
    set({
      query,
      headerOffset: 0,
      headers: [],
      headerTotal: 0,
      headerScanned: undefined,
      searchRemote: false,
      searchPartial: false,
      checkedIds: [],
      anchorId: null,
      loadingHeaders: true,
    });
    const { overlayOpen, activeMailTab, selectedPriority, selectedFolderId } = get();
    if (!overlayOpen || activeMailTab !== MAIL_INBOX_TAB) return;
    // Clearing the box and local priority searches need no server delay.
    if (!query.trim() || selectedPriority || !selectedFolderId) {
      void get().loadPage(0);
      return;
    }
    queuedSearchTimer = setTimeout(() => {
      queuedSearchTimer = null;
      if (queuedSearch && get().overlayOpen && get().activeMailTab === MAIL_INBOX_TAB) {
        void get().loadPage(0);
      }
    }, SEARCH_DEBOUNCE_MS);
  },

  setSort: async (sort, desc) => {
    set({ sort, sortDesc: desc, headerOffset: 0 });
    await get().loadPage(0);
  },

  setUnreadOnly: async (unreadOnly) => {
    set({ unreadOnly, headerOffset: 0 });
    await get().loadPage(0);
  },

  setAgentOnly: async (agentOnly) => {
    set({ agentOnly, headerOffset: 0 });
    await get().loadPage(0);
  },

  loadAgentMarks: async () => {
    const accountId = get().selectedAccountId;
    if (!accountId) {
      set({ agentMarks: [] });
      return;
    }
    const marks = await mailAgentMarks(accountId).catch(() => null);
    // Still the same account? A slow answer for the previous one must not
    // decorate this one's rows.
    if (marks && get().selectedAccountId === accountId) set({ agentMarks: marks });
  },

  setAgentMark: async (headers, marked) => {
    const ids = headers.map((h) => h.id);
    // Patch on screen first, for `setPriority`'s reason: the write is local and
    // the optimism is only about the IPC hop.
    set((s) => ({
      agentMarks: marked
        ? [...new Set([...s.agentMarks, ...ids])]
        : s.agentMarks.filter((id) => !ids.includes(id)),
    }));
    await mailAgentMark(ids, marked).catch((err) => set({ error: reason(err) }));
    // Re-read rather than trust the patch: an unmark removes every copy of the
    // same message, which the patch cannot know about.
    await get().loadAgentMarks();
    if (get().agentOnly) await get().loadPage(get().headerOffset);
  },

  markAgentSender: async (header) => {
    await mailAgentMarkSender(header.account_id, header.from.address).catch((err) =>
      set({ error: reason(err) }),
    );
    await get().loadAgentMarks();
    if (get().agentOnly) await get().loadPage(get().headerOffset);
  },

  markAgentFolder: async () => {
    const folderId = get().selectedFolderId;
    if (!folderId) return;
    await mailAgentMarkFolder(folderId).catch((err) => set({ error: reason(err) }));
    await get().loadAgentMarks();
    if (get().agentOnly) await get().loadPage(get().headerOffset);
  },

  clearFilters: async () => {
    set({ query: "", unreadOnly: false, agentOnly: false, headerOffset: 0 });
    await get().loadPage(0);
  },

  loadPage: async (offset) => {
    clearQueuedSearchTimer();
    queuedSearch = false;
    const { selectedFolderId, selectedPriority, query, sort, sortDesc, unreadOnly, agentOnly } = get();
    if (!selectedFolderId && !selectedPriority) {
      pageToken += 1;
      set({ headers: [], headerTotal: 0, headerScanned: undefined, searchRemote: false, searchPartial: false, loadingHeaders: false });
      return;
    }
    const token = ++pageToken;
    set({ loadingHeaders: true });
    // The ONE fork between a folder and a priority list, and it is deliberately
    // here rather than in the pane: the two commands take the same paging, query
    // and sort, so everything downstream — the list, the pager, the search box,
    // the list's sort headers — stays one code path that does not know which it
    // is showing.
    //
    // A folder search goes through `mailSearch` rather than `mailHeaders`: the
    // sync keeps only the newest headers locally, so a local query can never
    // match an old mail — the server is asked first and the page says whether
    // it was reached (`searchRemote`). Priority lists stay local: they span
    // every account and folder, and a per-folder server search has no single
    // mailbox to ask.
    const needle = query.trim() || null;
    const page = await (selectedPriority
      ? mailPriorityPage(
          selectedPriority,
          offset,
          MAIL_PAGE_SIZE,
          needle,
          sort,
          sortDesc,
          unreadOnly,
        ).then((p) => ({ ...p, remote: false, partial: false }))
      : needle
        ? mailSearch(
            selectedFolderId as string,
            offset,
            MAIL_PAGE_SIZE,
            needle,
            sort,
            sortDesc,
            unreadOnly,
            agentOnly,
          )
        : mailHeaders(
            selectedFolderId as string,
            offset,
            MAIL_PAGE_SIZE,
            needle,
            sort,
            sortDesc,
            unreadOnly,
            agentOnly,
          ).then((p) => ({ ...p, remote: false, partial: false }))
    ).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    // Superseded while this was in flight — the answer describes a folder, a
    // list or a search string that is no longer on screen. Painting it would
    // put the previous keystroke's results under the current one.
    if (token !== pageToken) return;
    set({
      loadingHeaders: false,
      // The tick marks go with the page they were made on — see `checkedIds`.
      // Cleared even when the read failed: whatever is on screen afterwards is
      // no longer the list the user was ticking.
      checkedIds: [],
      anchorId: null,
      ...(page
        ? {
            headers: page.items,
            headerTotal: page.total,
            headerScanned: page.scanned,
            searchRemote: page.remote,
            searchPartial: page.partial,
            headerOffset: offset,
          }
        : {}),
    });
  },

  stepPage: async (offset) => {
    const { unreadOnly, headerOffset, headers } = get();
    const left =
      unreadOnly && offset > headerOffset ? headers.filter((h) => h.seen).length : 0;
    await get().loadPage(Math.max(0, offset - left));
  },

  openMessage: (messageId) => {
    set({ selectedMessageId: messageId });
    // The tab reads its own body and marks the message seen once it has it
    // (`MailOverlay`'s `MailMessageTabBody`).
    const header = get().headers.find((h) => h.id === messageId);
    if (header) get().openMessageTab(header);
  },

  checkOnly: (messageId) => set({ checkedIds: [messageId], anchorId: messageId }),

  toggleChecked: (messageId) =>
    set((s) => ({
      checkedIds: s.checkedIds.includes(messageId)
        ? s.checkedIds.filter((id) => id !== messageId)
        : [...s.checkedIds, messageId],
      // The anchor follows the last row touched either way, so a Ctrl-click
      // followed by a Shift-click reads as one gesture.
      anchorId: messageId,
    })),

  checkRange: (messageId, order) => {
    const { anchorId } = get();
    const from = anchorId ? order.indexOf(anchorId) : -1;
    const to = order.indexOf(messageId);
    // No anchor, or an anchor that scrolled out of the page: the range has no
    // other end, so this is an ordinary click rather than nothing at all.
    if (from < 0 || to < 0) {
      get().checkOnly(messageId);
      return;
    }
    const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    // The anchor is deliberately *not* moved: a run of Shift-clicks stretches
    // and shrinks one range from where it started, as every list does.
    set({ checkedIds: span });
  },

  clearChecked: () => set({ checkedIds: [], anchorId: null }),

  deleteMessages: async (messageIds) => {
    if (messageIds.length === 0) return;
    const wanted = new Set(messageIds);
    const targets = get().headers.filter((h) => wanted.has(h.id));
    if (targets.length === 0) return;
    // A cross-account list can hold rows from an account whose folders were
    // never read — a local read, so this costs no socket, but without it the
    // plan would find no Trash folder and call the delete permanent.
    const accountIds = [...new Set(targets.map((h) => h.account_id))];
    for (const accountId of accountIds) {
      if (!get().foldersByAccount[accountId]) await get().loadFolders(accountId, false);
    }
    for (const group of planMailDelete(targets, get().foldersByAccount)) {
      await (group.trashFolderId
        ? mailMove(group.messageIds, group.trashFolderId)
        : mailPurge(group.messageIds)
      ).catch((err) => set({ error: reason(err) }));
    }
    // A deleted message's own tab goes with it: a body left on screen for mail
    // that no longer exists is the worst of both.
    if (get().selectedMessageId && wanted.has(get().selectedMessageId as string)) {
      set({ selectedMessageId: null });
    }
    for (const tab of get().mailTabs) {
      if (tab.kind === "message" && wanted.has(tab.header.id)) get().closeMailTab(tab.id);
    }
    // Rail badges, then the marked-mail badges (a deleted message leaves its
    // priority list too), then the page — which also clears the tick marks.
    for (const accountId of accountIds) await get().loadFolders(accountId, false);
    await get().refreshPriorityCounts();
    await get().loadPage(get().headerOffset);
    // Deleting the whole of the last page leaves the pager past the end, which
    // reads as an empty folder. Step back one page instead.
    if (get().headers.length === 0 && get().headerOffset > 0) {
      await get().loadPage(Math.max(0, get().headerOffset - MAIL_PAGE_SIZE));
    }
  },

  setFlag: async (messageId, flag, value) => {
    // Patch locally first: a flag is a UI affordance and the server round-trip is
    // slow enough that waiting for it reads as a broken click.
    set((s) => ({
      headers: s.headers.map((h) =>
        h.id === messageId
          ? {
              ...h,
              ...(flag === "seen" ? { seen: value } : {}),
              ...(flag === "flagged" ? { flagged: value } : {}),
              ...(flag === "answered" ? { answered: value } : {}),
            }
          : h,
      ),
    }));
    const accountId = get().headers.find((h) => h.id === messageId)?.account_id;
    await mailFlag(messageId, flag, value).catch((err) => set({ error: reason(err) }));
    // Reading a message is the ordinary way the unread badge goes *down*, and
    // the backend has already recounted the folder — so re-read it (local). Only
    // `seen` moves a count; a flag or an answered marker leaves it alone.
    if (flag === "seen" && accountId) await get().loadFolders(accountId, false);
  },

  markFolderRead: async (folderId) => {
    const accountId = Object.entries(get().foldersByAccount).find(([, fs]) =>
      fs?.some((f) => f.id === folderId),
    )?.[0];
    // Patch the open page first, for `setFlag`'s reason: the backend writes its
    // own index before it touches the server, so waiting for a round trip would
    // leave every row on screen looking untouched for the length of it.
    set((s) => ({
      headers: s.headers.map((h) => (h.folder_id === folderId ? { ...h, seen: true } : h)),
    }));
    const changed = await mailMarkFolderRead(folderId).catch((err) => {
      set({ error: reason(err) });
      return null;
    });
    // The counts are re-read even when the command failed. The backend marks
    // locally *before* it reaches the server and reports the refusal, so a
    // rejected invoke does not mean nothing changed — re-reading is what keeps
    // the rail and the header badge agreeing with the index either way.
    if (accountId) await get().loadFolders(accountId, false);
    if (changed !== null && get().selectedFolderId === folderId) {
      await get().loadPage(get().headerOffset);
    }
  },

  checkMail: async (accountId, folderId) => {
    set((s) => ({
      error: null,
      sync: { ...s.sync, [accountId]: { phase: "start" } },
    }));
    const summary = await mailSync(accountId, folderId ?? null).catch((err) => {
      set((s) => ({
        error: reason(err),
        sync: { ...s.sync, [accountId]: { phase: "error", error: reason(err) } },
      }));
      return null;
    });
    if (!summary) return;
    set((s) => ({
      sync: {
        ...s.sync,
        [accountId]: summary.error
          ? { phase: "error", error: summary.error }
          : {
              phase: "done",
              newMessages: summary.new_messages,
              filtered: summary.filtered,
            },
      },
      ...(summary.error ? { error: summary.error } : {}),
    }));
    // The folder list's unread counts moved, and so did the open page.
    await get().loadFolders(accountId, false);
    if (get().selectedAccountId === accountId) {
      await get().loadPage(get().headerOffset);
      // A sync can adopt a moved copy of a marked message; the pills must know.
      void get().loadAgentMarks();
    }
    // A filter rule just moved mail into Important/Urgent. The rail badges are
    // the only place that shows it, so they have to be re-read here — otherwise
    // the one visible consequence of an automatic mark waits for the next thing
    // that happens to refresh them.
    if (summary.filtered) await get().refreshPriorityCounts();
  },

  cancelCheck: async (accountId) => {
    await mailSyncCancel(accountId).catch((err) => set({ error: reason(err) }));
    set((s) => ({ sync: { ...s.sync, [accountId]: { phase: "done" } } }));
  },

  clearSyncState: (accountId) => {
    set((s) => {
      if (!(accountId in s.sync)) return s;
      const sync = { ...s.sync };
      delete sync[accountId];
      return { sync };
    });
  },
}));

/**
 * Whether a sync error is the server refusing the credentials. Matched on the
 * backend's `MailError::AuthFailed` text (`services/mail_engine.rs`), which
 * `MailAutoCheck.test.ts` pins — the error crosses IPC as a display string.
 */
export function isAuthRejection(error: string | undefined): boolean {
  return !!error && error.toLowerCase().includes("rejected the username or password");
}

/**
 * Whether an unattended check (the interval tick, the VPN catch-up) must skip
 * this account: a check is already running, or the last one was a rejected
 * login. The backend never retries a login within one action, but a poll every
 * few minutes against a stale password is a retry loop all the same — and mail
 * servers answer repeated failed logins from one IP with a temporary block. The
 * pause lasts until the user checks by hand (one attempt, their call) or saves
 * the account (`clearSyncState`).
 */
export function backgroundCheckBlocked(state: MailSyncState | undefined): boolean {
  if (!state) return false;
  if (state.phase === "start" || state.phase === "folder" || state.phase === "headers") return true;
  return state.phase === "error" && isAuthRejection(state.error);
}

/** Total unread across an account's folders, for the rail's badge. */
export function unreadTotal(folders: MailFolder[] | undefined): number {
  return (folders ?? []).reduce((sum, f) => sum + (f.unread || 0), 0);
}

/**
 * The number in the header button's red dot: unread mail in the **inboxes**,
 * summed across every account.
 *
 * Inbox-only on purpose. The rail's per-account badge counts every folder,
 * because there you are looking at the folder list and can see where the mail
 * is; a single number in the header cannot say that, and folders that are not
 * the inbox are where a filter has already dealt with something — a mailing
 * list nobody reads would otherwise hold the dot lit forever, which is the one
 * failure mode that teaches a user to ignore a badge.
 *
 * Derived rather than accumulated, so it is right the moment the app starts
 * (mail that arrived while Tabtivity was closed is in the index and therefore in
 * this number), it survives a relaunch, and it falls as messages are read
 * instead of needing to be dismissed.
 */
export function inboxUnread(byAccount: Record<string, MailFolder[]>): number {
  let sum = 0;
  for (const folders of Object.values(byAccount)) sum += accountInboxUnread(folders);
  return sum;
}

/** One account's share of `inboxUnread` — the header menu's account rows, so
 *  the rows add up to the button's dot rather than to a different number. */
export function accountInboxUnread(folders: MailFolder[] | undefined): number {
  let sum = 0;
  for (const f of folders ?? []) {
    if (f.kind === "inbox") sum += f.unread || 0;
  }
  return sum;
}
