/**
 * **The** typed invoke surface for the embedded mail client — one wrapper per
 * `mail_*` command, and nothing else in the frontend calls `invoke("mail_*")`
 * directly (the convention `lib/remote/hpc/slurm.ts` and `lib/remote/hpc/hpcWorkspace.ts` follow).
 *
 * Two properties of this module are load-bearing rather than stylistic:
 *
 *  1. **No wrapper takes a filesystem path**, because no command does. Files
 *     cross the mail sandbox boundary only through `mailAttachPick` (the backend
 *     raises the OS *open* dialog) and `mailAttachmentSave` (the backend raises
 *     the OS *save* dialog). There is deliberately no "open this attachment with
 *     the system app" verb here, and adding one would be the single ambient
 *     write+exec hole the whole design exists to avoid.
 *  2. **The srcdoc is built here, not in the backend.** `buildMessageSrcdoc`
 *     assembles the document the message body renders in, so the CSP that
 *     protects the iframe lives next to the code that fills it, and
 *     `bodyLooksUnsafe` is the tripwire that refuses to render a body the
 *     backend's sanitizer should already have made inert.
 *
 * Design rationale: `docs/mail_client_plan_a.md` §6 (the frozen contract) and
 * `docs/mail_client_plan_b.md` §2 (the render pipeline).
 */

import { invoke } from "@tauri-apps/api/core";
import { stripFormatControls } from "./textSafety";
import { formatBytes } from "./formatBytes";
import { hashString } from "./theme/categoryColor";
import type { TranslationKey } from "./i18n";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSettingsStore } from "../stores/settings";
import { experimentalEnabled } from "./experimental";
import type { Settings } from "../types";
import type {
  MailAiClassifyReport,
  MailExtractedEvent,
  MailExtractedTask,
  MailAccount,
  MailAiPrefs,
  MailAccountSaved,
  MailAuthMethod,
  MailAuthResults,
  MailBody,
  MailContact,
  MailContactList,
  MailContactsImportReport,
  MailContactsView,
  MailCryptoInfo,
  MailCryptoState,
  MailDraft,
  MailEncryptionState,
  MailFilterReport,
  MailFilterRule,
  MailFlag,
  MailFolder,
  MailHeader,
  MailHeaderPage,
  MailSearchPage,
  MailNewEvent,
  MailPasswordState,
  MailPreviewBlob,
  MailPriority,
  MailPriorityCounts,
  PgpKeyInfo,
  MailProbe,
  MailSendResult,
  MailSort,
  MailSyncEvent,
  MailSyncSummary,
  StagedAttachment,
} from "../types/mail";
import { NAMES } from "./brand";

/**
 * Minutes between automatic checks when `mail_check_interval_min` was never
 * set. **Not zero**, and that is the whole point: the header's red dot counts
 * arrivals a *sync* discovered, so with nothing checking on its own the badge
 * could only ever appear right after a manual *Check mail* — and a manual check
 * is nearly always made from the overlay, which acknowledges the arrival in the
 * same gesture. Turning mail on therefore used to buy a badge that could not
 * physically light up.
 *
 * The mail store's "nothing connects on its own" rule survives intact: this
 * default applies only once `mail_client` is on (an explicit act, off for
 * everyone outside debug mode), and an explicit `0` — *Never — only when I ask*
 * — is still honoured, because a stored 0 is a choice and only an absent value
 * is unset.
 */
export const DEFAULT_MAIL_CHECK_MIN = 5;

// ── Accounts + credentials ───────────────────────────────────────────────────

/** Every configured account. Never touches the network. */
export function mailAccountsList(): Promise<MailAccount[]> {
  return invoke<MailAccount[]>("mail_accounts_list");
}

/**
 * Create or update an account.
 *
 * `remember` is `true | null` and **never `false`** — `false` would mean *clear
 * the saved credential*, which is how a save silently destroys the password it
 * just authenticated with (see `components/projects/useSavedCredential`'s
 * `rememberArg`, which is the helper every call site here uses). Clearing is
 * only ever the explicit {@link mailForgetPassword}.
 *
 * The result reports **what the keychain actually did** — a ticked box with a
 * refused write behind it is exactly the state that resurfaces at the next
 * launch as an unexplained password prompt.
 */
export function mailAccountUpsert(
  account: MailAccount,
  password: string | null,
  remember: true | null,
): Promise<MailAccountSaved> {
  return invoke<MailAccountSaved>("mail_account_upsert", { account, password, remember });
}

export function mailAccountDelete(accountId: string): Promise<void> {
  return invoke("mail_account_delete", { accountId });
}

/**
 * Patch just the per-account **Mail AI (local)** toggles, returning the updated
 * account. Deliberately separate from {@link mailAccountUpsert}: that command
 * carries a password + a keychain intent, and a quick feature toggle (the
 * toolbar tags, the per-account settings dialog) must never be able to disturb a
 * saved secret. The backend stores an all-off preference set as absent.
 */
export function mailAccountSetAi(accountId: string, ai: MailAiPrefs): Promise<MailAccount> {
  return invoke<MailAccount>("mail_account_set_ai", { accountId, ai });
}

/** Probe IMAP + SMTP with the (possibly unsaved) credentials in the dialog. */
export function mailAccountTest(
  account: MailAccount,
  password: string | null,
): Promise<MailProbe> {
  return invoke<MailProbe>("mail_account_test", { account, password });
}

/** Is a password saved for this account, and can the store even be read? */
export function mailPasswordState(accountId: string): Promise<MailPasswordState> {
  return invoke<MailPasswordState>("mail_password_state", { accountId });
}

/** The ONLY path that deletes a saved mail password. */
export function mailForgetPassword(accountId: string): Promise<void> {
  return invoke("mail_forget_password", { accountId });
}

// ── Folders, sync, headers ───────────────────────────────────────────────────

/** Cached folders, or a server refresh when `refresh` is set (network). */
export function mailFolders(accountId: string, refresh: boolean): Promise<MailFolder[]> {
  return invoke<MailFolder[]>("mail_folders", { accountId, refresh });
}

/** Fetch new headers. Emits `mail:sync` progress; cancel with {@link mailSyncCancel}. */
export function mailSync(
  accountId: string,
  folderId: string | null,
): Promise<MailSyncSummary> {
  return invoke<MailSyncSummary>("mail_sync", { accountId, folderId });
}

export function mailSyncCancel(accountId: string): Promise<void> {
  return invoke("mail_sync_cancel", { accountId });
}

/**
 * One page of the local header index. Purely local — no network.
 *
 * `sort`/`desc` are the list's ordering, and they are sent to the backend rather
 * than applied to the result for the reason paging makes unavoidable: this is
 * one page of a folder, so sorting what comes back would order 100 rows out of
 * however many thousand — the largest message, or the only starred one, is
 * usually not on the page you happen to be looking at.
 */
export function mailHeaders(
  folderId: string,
  offset: number,
  limit: number,
  query: string | null,
  sort: MailSort = "date",
  desc = true,
  unreadOnly = false,
  agentOnly = false,
): Promise<MailHeaderPage> {
  return invoke<MailHeaderPage>("mail_headers", {
    folderId,
    offset,
    limit,
    query,
    sort,
    desc,
    unreadOnly,
    agentOnly,
  });
}

/**
 * Search one folder's whole mailbox, not just the downloaded tail.
 *
 * A sync keeps only a folder's newest headers locally, so `mailHeaders` with
 * a query can never match an old mail. This command asks the server first and
 * backfills what it finds, then serves the same page shape — `remote` says
 * whether the server was reached, and the list renders a local-only answer as
 * one rather than letting it read as complete.
 */
export function mailSearch(
  folderId: string,
  offset: number,
  limit: number,
  query: string,
  sort: MailSort = "date",
  desc = true,
  unreadOnly = false,
  agentOnly = false,
): Promise<MailSearchPage> {
  return invoke<MailSearchPage>("mail_search", {
    folderId,
    query,
    offset,
    limit,
    sort,
    desc,
    unreadOnly,
    agentOnly,
  });
}

// ── Marks for agents (`docs/mail_mcp_plan.md` §1, "Marked mails only") ──────
//
// Local, like a priority mark: a row in the store and never an IMAP keyword, so
// "shared with an agent" reaches neither the provider nor another client. Each
// resolves with how many rows changed.

/** Mark, or with `false` unmark, messages for a contained reader agent. */
export function mailAgentMark(messageIds: string[], marked: boolean): Promise<number> {
  return invoke<number>("mail_agent_mark", { messageIds, marked });
}

/** Mark every message of a folder. */
export function mailAgentMarkFolder(folderId: string): Promise<number> {
  return invoke<number>("mail_agent_mark_folder", { folderId });
}

/** Mark every message of an account from one sender address, in any folder. */
export function mailAgentMarkSender(accountId: string, address: string): Promise<number> {
  return invoke<number>("mail_agent_mark_sender", { accountId, address });
}

/** The ids of an account's marked messages that are in the local index. */
export function mailAgentMarks(accountId: string): Promise<string[]> {
  return invoke<string[]>("mail_agent_marks", { accountId });
}

/**
 * The answers the user already wrote to a message: mail in a Sent folder whose
 * `In-Reply-To` names it, oldest first. Local index only — no network.
 */
export function mailReplies(messageId: string): Promise<MailHeader[]> {
  return invoke<MailHeader[]>("mail_replies", { messageId });
}

/**
 * The sanitized body. `allowRemote` is the per-message, per-click opt-in behind
 * the "Load remote content" banner: the backend re-fetches the remote
 * references itself (no cookies, no auth headers, no `Referer`) and inlines them
 * as `data:` URIs, so the tracker never sees the user's IP unless they asked.
 * The frame's CSP never changes — `img-src data:` forever.
 */
export function mailBody(messageId: string, allowRemote: boolean): Promise<MailBody> {
  return invoke<MailBody>("mail_body", { messageId, allowRemote });
}

export function mailFlag(messageId: string, flag: MailFlag, value: boolean): Promise<void> {
  return invoke("mail_flag", { messageId, flag, value });
}

/**
 * Mark a whole folder read, on the server too. Resolves with how many messages
 * changed — a folder that was already read answers 0 and costs no login.
 *
 * A folder-wide command rather than a loop over `mailFlag`, because the loop is
 * one IMAP login per message: the 200-unread case that makes the button worth
 * having is exactly the case that would make it unusable.
 */
export function mailMarkFolderRead(folderId: string): Promise<number> {
  return invoke<number>("mail_mark_folder_read", { folderId });
}

export function mailMove(messageIds: string[], destFolderId: string): Promise<void> {
  return invoke("mail_move", { messageIds, destFolderId });
}

/**
 * Delete messages **off the server** — `\Deleted` + `UID EXPUNGE` — and out of
 * the local index. Resolves with how many rows the index lost.
 *
 * The irreversible half of deleting, and deliberately not the *whole* of it:
 * ordinary deleting moves to the account's Trash (`mailMove`, which the server
 * can undo for the user), and this is the path only where there is nowhere left
 * to move to — the Trash folder itself, or an account whose server offers none.
 * `planMailDelete` is what decides which of the two a given set of rows needs.
 */
export function mailPurge(messageIds: string[]): Promise<number> {
  return invoke<number>("mail_purge", { messageIds });
}

/** One folder's worth of a delete: the rows, and where they are going. */
export interface MailDeleteGroup {
  accountId: string;
  folderId: string;
  messageIds: string[];
  /** The Trash folder to move into, or `null` when the delete is permanent. */
  trashFolderId: string | null;
}

/**
 * Work out how a set of rows has to be deleted — pure, so the confirmation the
 * user reads and the commands that run are computed from one function rather
 * than two that can disagree about which mail is about to be destroyed.
 *
 * Grouped **per folder**, because that is what the server takes: `mail_move` and
 * `mail_purge` both select one mailbox and address one UID set, and a UID means
 * nothing outside its own folder. A cross-account Important list is exactly the
 * case that makes this more than bookkeeping — one delete there can be four
 * groups across two accounts, two of them permanent.
 *
 * A message already *in* its account's Trash has nowhere left to go and is
 * deleted for good; so is one whose account has no Trash folder at all.
 * Everything else moves — including mail in Junk, which is a classification and
 * not a deletion, so emptying the spam folder stays as recoverable as any other
 * delete.
 */
export function planMailDelete(
  headers: { id: string; account_id: string; folder_id: string }[],
  foldersByAccount: Record<string, MailFolder[] | undefined>,
): MailDeleteGroup[] {
  const groups = new Map<string, MailDeleteGroup>();
  for (const h of headers) {
    const folders = foldersByAccount[h.account_id] ?? [];
    const trash = folders.find((f) => f.kind === "trash");
    // An unknown Trash folder, or a row already in it: nowhere left to move to.
    const trashFolderId = trash && trash.id !== h.folder_id ? trash.id : null;
    const group = groups.get(h.folder_id) ?? {
      accountId: h.account_id,
      folderId: h.folder_id,
      messageIds: [],
      trashFolderId,
    };
    group.messageIds.push(h.id);
    groups.set(h.folder_id, group);
  }
  return [...groups.values()];
}

// ── Priority marks (Important / Urgent) ──────────────────────────────────────
//
// The only four wrappers here that reach no network in either direction, and
// that is the feature rather than an omission: Important and Urgent are lists
// spanning EVERY account, and no IMAP folder can hold two accounts' mail — so
// the mark is a local column, not a move. `types/mail.ts`'s `MailPriority`
// carries the full reasoning, including what it costs (a mark is this machine's;
// no other mail client sees it).

/** Set — or with `null`, clear — one message's mark. Resolves `true` when a row
 *  actually changed; `false` means the message is no longer in the local index,
 *  which is a real outcome and not the same as success. */
export function mailPrioritySet(
  messageId: string,
  priority: MailPriority | null,
): Promise<boolean> {
  return invoke<boolean>("mail_priority_set", { messageId, priority });
}

/** One page of everything carrying `priority`, across every account and folder.
 *  Deliberately the same shape as `mailHeaders` — same paging, same optional
 *  query, same backend-side ordering — so a priority list is a folder as far as
 *  the list component is concerned. */
export function mailPriorityPage(
  priority: MailPriority,
  offset: number,
  limit: number,
  query: string | null,
  sort: MailSort = "date",
  desc = true,
  unreadOnly = false,
): Promise<MailHeaderPage> {
  return invoke<MailHeaderPage>("mail_priority_page", {
    priority,
    offset,
    limit,
    query,
    sort,
    desc,
    unreadOnly,
  });
}

/** Empty one list: clear the mark from **every** message carrying `priority`,
 *  resolving with how many rows changed. The bulk form of `mailPrioritySet(…,
 *  null)`, and no more destructive than it is — a mark is not a folder, so no
 *  message moves and nothing is deleted; what goes is the filing. The caller
 *  asks before it calls, because that filing is the user's own work. */
export function mailPriorityClear(priority: MailPriority): Promise<number> {
  return invoke<number>("mail_priority_clear", { priority });
}

/** Both rail badges in one read, so they cannot disagree on screen. */
export function mailPriorityCounts(): Promise<MailPriorityCounts> {
  return invoke<MailPriorityCounts>("mail_priority_counts");
}

// ── Filter rules (keywords → a mark) ─────────────────────────────────────────
//
// The automation on top of those marks, and it reaches no network either: a rule
// writes the same local column `mailPrioritySet` writes. See `MailFilterRule`
// for what a rule may look at and the two limits that come with it.

/** Every rule, in order — and the order is data: the first match wins.
 */
export function mailFiltersList(): Promise<MailFilterRule[]> {
  return invoke<MailFilterRule[]>("mail_filters_list");
}

/**
 * Replace the whole list, and get it back with ids minted for new rules.
 *
 * Wholesale rather than per-rule because a **reorder** is an ordinary edit here
 * and no upsert can express one. The consequence to know: this writes what the
 * dialog is holding, so a rule a *newer* build wrote and this one could not
 * parse is not preserved by a save from here.
 */
export function mailFiltersSet(rules: MailFilterRule[]): Promise<MailFilterRule[]> {
  return invoke<MailFilterRule[]>("mail_filters_set", { rules });
}

/**
 * Run rules over mail that is already in the local index.
 *
 * With `dryRun` it marks nothing and reports what it *would* mark — the same
 * code path, which is the only kind of preview worth showing. `rules` overrides
 * the saved list, so the dialog can test a rule it has not saved (and one that
 * is still switched off, which is when "what would this catch" is actually
 * asked). Messages that already carry a mark are never touched.
 */
export function mailFiltersApply(opts: {
  dryRun: boolean;
  accountId?: string | null;
  rules?: MailFilterRule[] | null;
  limit?: number;
}): Promise<MailFilterReport> {
  return invoke<MailFilterReport>("mail_filters_apply", {
    dryRun: opts.dryRun,
    accountId: opts.accountId ?? null,
    rules: opts.rules ?? null,
    limit: opts.limit ?? null,
  });
}

// ── Address book ─────────────────────────────────────────────────────────────
//
// Local only, like the filters: the sealed `contacts.json` beside the store.
// Import and export raise the OS dialog in the backend — no path crosses here.

/** The whole book: cards, lists and the collect-outgoing switch. */
export function mailContactsGet(): Promise<MailContactsView> {
  return invoke<MailContactsView>("mail_contacts_get");
}

/** Insert or replace one card (empty `id` = new). Rejects an invalid address
 *  with a message naming it. */
export function mailContactUpsert(contact: MailContact): Promise<MailContact> {
  return invoke<MailContact>("mail_contact_upsert", { contact });
}

export function mailContactsDelete(ids: string[]): Promise<number> {
  return invoke<number>("mail_contacts_delete", { ids });
}

export function mailContactListUpsert(list: MailContactList): Promise<MailContactList> {
  return invoke<MailContactList>("mail_contact_list_upsert", { list });
}

export function mailContactListDelete(id: string): Promise<boolean> {
  return invoke<boolean>("mail_contact_list_delete", { id });
}

export function mailContactsSetCollect(enabled: boolean): Promise<void> {
  return invoke<void>("mail_contacts_set_collect", { enabled });
}

/** Pick a `.vcf`, `.ldif` or Thunderbird `abook.sqlite` (backend dialog) and
 *  merge it into the book. */
export function mailContactsImport(): Promise<MailContactsImportReport> {
  return invoke<MailContactsImportReport>("mail_contacts_import");
}

/** Merge every address book of every Thunderbird profile on this machine
 *  (read-only; Collected Addresses land in Collected). */
export function mailContactsImportThunderbird(): Promise<MailContactsImportReport> {
  return invoke<MailContactsImportReport>("mail_contacts_import_thunderbird");
}

/** Add the senders of all locally indexed Inbox mail as Collected cards. */
export function mailContactsHarvestInbox(): Promise<MailContactsImportReport> {
  return invoke<MailContactsImportReport>("mail_contacts_harvest_inbox");
}

/** Save cards as a `.vcf` (backend dialog): these ids, or every card when
 *  empty. `null` when the dialog was cancelled, else how many were written. */
export function mailContactsExport(ids: string[] = []): Promise<number | null> {
  return invoke<number | null>("mail_contacts_export", { ids });
}

// ── Local-model mail assistant (Group Q, #204–#208) ──────────────────────────
//
// One wrapper per `mail_*` AI command, in this file's usual style. **None takes
// a path**, like every other wrapper here. The backend runs each prompt against
// a **loopback** Ollama and refuses a non-loopback host even when
// `ollama_allow_remote_host` is set — the AI path never touches the internet, so
// nothing here adds a network path. An unreachable server comes back as the
// existing `not_running` sentinel every 🧠 surface already branches on.

/** ≤N plain-text bullet points summarizing a message body. **Ephemeral** — the
 *  caller holds it in component state and never persists it (decrypted plaintext
 *  to disk is forbidden; see `docs/context/mail_encryption.md`). */
export function mailSummarize(messageId: string): Promise<string> {
  return invoke<string>("mail_summarize", { messageId });
}

/** A formal reply body drafted from rough notes, optionally with the original as
 *  context (#206). **Never sends** — the composer drops the text into its
 *  `body_text` for explicit review and send. */
export function mailFormalizeReply(
  notes: string,
  opts: { accountId: string; messageId?: string | null; tone?: string | null },
): Promise<string> {
  return invoke<string>("mail_formalize_reply", {
    notes,
    messageId: opts.messageId ?? null,
    accountId: opts.accountId,
    tone: opts.tone ?? null,
  });
}

/** A calendar event read out of a message, or `null` when the model found none /
 *  was too unsure (#207). `null` is "nothing to create", not an error. */
export function mailExtractEvent(messageId: string): Promise<MailExtractedEvent | null> {
  return invoke<MailExtractedEvent | null>("mail_extract_event", { messageId });
}

/** A to-do read out of a message, or `null` when there is nothing to make (#208). */
export function mailExtractTask(messageId: string): Promise<MailExtractedTask | null> {
  return invoke<MailExtractedTask | null>("mail_extract_task", { messageId });
}

/**
 * Run the local-model classifier over stored mail — the manual counterpart to
 * the sync-time pass (#205). With `dryRun` it marks nothing and reports what it
 * *would* mark; the report is source-labelled (`source: "model"`) and never the
 * keyword-filter's shape, so the two can be shown side by side without one
 * passing for the other.
 */
export function mailAiClassifyApply(
  dryRun: boolean,
  opts: { accountId?: string | null; limit?: number | null } = {},
): Promise<MailAiClassifyReport> {
  return invoke<MailAiClassifyReport>("mail_ai_classify_apply", {
    dryRun,
    accountId: opts.accountId ?? null,
    limit: opts.limit ?? null,
  });
}

/**
 * Whether the Ollama host the mail AI would dial is **loopback**.
 *
 * The mail-AI helper is deliberately stricter than `ollama_allow_remote_host`:
 * classifying mail on someone else's box defeats the point, so a remote host
 * disables the feature outright. This mirrors the backend's `host_is_loopback`
 * refusal so the UI gates on the same answer rather than offering a control that
 * the backend will only refuse. Unset (the default `127.0.0.1:11434`), a bare
 * port and a `:port` all read as loopback.
 */
export function mailAiHostIsLoopback(host?: string | null): boolean {
  const raw = (host ?? "").trim();
  if (!raw) return true;
  const h = raw.replace(/^https?:\/\//i, "");
  if (/^:?\d+$/.test(h)) return true; // bare port or ":port" → default host
  let hostname: string;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    hostname = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else {
    hostname = h.split(":")[0];
  }
  hostname = hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost")
  );
}

/** The model the mail role resolves to (`ollama_roles.mail ?? ollama_model`), or
 *  `undefined` when none is assigned. */
export function mailAiModelName(settings: Settings | null | undefined): string | undefined {
  return settings?.ollama_roles?.mail || settings?.ollama_model || undefined;
}

/**
 * Whether Mail AI is switched on at the machine level: `mail_client` on **and**
 * the global master switch `mail_ai_allow` on. This is what the toolbar's
 * quick-toggle tags are gated on — with the master switch off, no per-account
 * feature is offered at all.
 */
export function mailAiAllowed(settings: Settings | null | undefined): boolean {
  return experimentalEnabled(settings, "mail_client") && settings?.mail_ai_allow === true;
}

/** Is the mail-AI path usable at all: {@link mailAiAllowed}, a mail-role model
 *  assigned, and its host loopback. The per-account gate is {@link mailAiFeatureOn}. */
export function mailAiResolvable(settings: Settings | null | undefined): boolean {
  return (
    mailAiAllowed(settings) &&
    !!mailAiModelName(settings) &&
    mailAiHostIsLoopback(settings?.ollama_host)
  );
}

/** The per-account {@link MailAiPrefs} keys that turn one mail-AI feature on. */
export type MailAiFeature = "summarize" | "autoclassify" | "formalize" | "calendar" | "todo";

/** Whether a specific mail-AI feature should be offered for this account: the
 *  **account's** toggle is on AND the path is resolvable ({@link mailAiResolvable}). */
export function mailAiFeatureOn(
  settings: Settings | null | undefined,
  account: MailAccount | null | undefined,
  feature: MailAiFeature,
): boolean {
  return account?.ai?.[feature] === true && mailAiResolvable(settings);
}

/** {@link mailAiFeatureOn} as a store subscription — the call site for a
 *  component. The account is passed in (it lives in the mail store, not
 *  settings), and only the global resolvability is subscribed here. */
export function useMailAiFeature(
  account: MailAccount | null | undefined,
  feature: MailAiFeature,
): boolean {
  const resolvable = useSettingsStore((s) => mailAiResolvable(s.settings));
  return resolvable && account?.ai?.[feature] === true;
}

/**
 * A backend mail-AI error string → an i18n key. The backend speaks in machine
 * sentinels so the wording lives in `i18n` ×5; an unrecognized value returns
 * `null` and the caller shows the raw string (a real error is information).
 */
export function mailAiErrorKey(err: unknown): TranslationKey | null {
  const s = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  if (s === "not_running" || s.includes("not_running")) return "mailAi.errNotRunning";
  // REMOTE_REFUSED — the loopback-only refusal (mail_ai.rs). Checked before the
  // absent-model case so its own sentence never falls through to raw English.
  if (s.includes("remote host")) return "mailAi.errRemote";
  // NO_MODEL is the full sentence "no local mail model is set …" (no `no_model`
  // token in it), and the embedding-only refusal names "embedding".
  if (s.includes("no local mail model") || s.includes("embedding")) return "mailAi.errNoModel";
  return null;
}

// ── Drafts + the file boundary ───────────────────────────────────────────────

export function mailDraftSave(draft: MailDraft): Promise<MailDraft> {
  return invoke<MailDraft>("mail_draft_save", { draft });
}

/** The drafts an agent wrote through the root MCP that the user has not yet
 *  sent, discarded or edited. */
export function mailAgentDrafts(): Promise<MailDraft[]> {
  return invoke<MailDraft[]>("mail_agent_drafts");
}

/** ✓ Approvals' approve: file these agent drafts, as shown, into the "Drafted
 *  by agents" folder. Refuses (and files the rest) when one changed since. */
export function mailAgentDraftsFile(drafts: MailDraft[]): Promise<number> {
  return invoke<number>("mail_agent_drafts_file", { drafts });
}

export function mailDraftDiscard(draftId: string): Promise<void> {
  return invoke<void>("mail_draft_discard", { draftId });
}

/**
 * Send a draft, optionally signed and/or encrypted.
 *
 * The flags default to **off**, and a sealed send that cannot be sealed comes
 * back as an error rather than as a plaintext send: there is no path in the
 * backend where these degrade quietly, because a silent downgrade to cleartext
 * looks exactly like success.
 */
export function mailDraftSend(
  draftId: string,
  /** The attachment set the user was shown. The backend refuses the send when
   *  the store's set differs — the reviewed set is exactly what is sent. */
  stagedIds: string[],
  opts: { sign?: boolean; encrypt?: boolean } = {},
): Promise<MailSendResult> {
  return invoke<MailSendResult>("mail_draft_send", {
    draftId,
    stagedIds,
    sign: opts.sign ?? false,
    encrypt: opts.encrypt ?? false,
  });
}

/**
 * IN (disk → mail): the **backend** raises the OS open dialog, copies whatever
 * the user picked into the mail sandbox dir, and hands back opaque staged ids.
 * The frontend supplies no path and learns none — the copy is the boundary, so a
 * compose window cannot re-read the original file later either.
 */
export function mailAttachPick(draftId: string): Promise<StagedAttachment[]> {
  return invoke<StagedAttachment[]>("mail_attach_pick", { draftId });
}

export function mailAttachRemove(draftId: string, stagedId: string): Promise<void> {
  return invoke("mail_attach_remove", { draftId, stagedId });
}

/**
 * OUT (mail → disk): the **backend** raises the OS save dialog with the
 * sanitized filename pre-filled and writes the bytes to the single path the user
 * chose. Returns that path for a toast, or `null` when the dialog was cancelled
 * (in which case nothing was written). There is no bulk "save all" — one dialog
 * per file is deliberate friction at the exact point the boundary is crossed.
 */
export function mailAttachmentSave(
  messageId: string,
  partId: string,
): Promise<string | null> {
  return invoke<string | null>("mail_attachment_save", { messageId, partId });
}

/** The project folder a saved attachment lands in, mirroring the backend's
 *  `commands::projects::EMAILS_DIR`. `tabtivity-`prefixed so ignoring it in git can
 *  never swallow a folder the project itself owns. */
export const APP_EMAILS_DIR = NAMES.emailsDir;

/**
 * OUT (mail → project): save the attachment into the given project's
 * `tabtivity-emails/` folder, creating it if absent, and resolve the full path written (for a
 * toast). The project is named by its **opaque id**, never a path — the backend
 * resolves that id to the project's own directory and fixes the `tabtivity-emails/`
 * subfolder — so this wrapper honours the same boundary as the rest of the
 * surface. Rejects (never resolves a truthy path for a write that did not
 * happen) when the project has no local directory.
 */
export function mailAttachmentSaveToProject(
  messageId: string,
  partId: string,
  projectId: string,
): Promise<string> {
  return invoke<string>("mail_attachment_save_to_project", {
    messageId,
    partId,
    projectId,
  });
}

/** Bounded bytes for an in-pane preview. Nothing touches the filesystem. */
/**
 * Whether a preview blob is a PDF the pane should draw with pdf.js. Decided by
 * the bytes alone — a `%PDF-` magic, which is `JVBERi` in base64 — never by the
 * declared type: mail clients regularly send a PDF as
 * `application/octet-stream`, and a declared `application/pdf` without the
 * magic is not one, whatever the sender claimed.
 */
export function previewIsPdf(blob: Pick<MailPreviewBlob, "bytes_b64">): boolean {
  return blob.bytes_b64.startsWith("JVBERi");
}

export function mailAttachmentPreview(
  messageId: string,
  partId: string,
): Promise<MailPreviewBlob> {
  return invoke<MailPreviewBlob>("mail_attachment_preview", { messageId, partId });
}

/** Bounded bytes of a file staged on a draft — the sealed outbox copy, which
 *  is what a send attaches — for the composer's review. */
export function mailStagedPreview(draftId: string, stagedId: string): Promise<MailPreviewBlob> {
  return invoke<MailPreviewBlob>("mail_staged_preview", { draftId, stagedId });
}

// ── Events ───────────────────────────────────────────────────────────────────

// ── Encryption at rest (docs/mail_encryption_plan.md) ──────────────────────

export function mailEncryptionState(): Promise<MailEncryptionState> {
  return invoke<MailEncryptionState>("mail_encryption_state");
}

/**
 * Turn encryption on, migrating whatever is already stored.
 *
 * `passphrase` is only read for `mode === "passphrase"`. It is passed as an
 * argument and never stored anywhere on this side — the backend derives a key
 * from it and drops it.
 */
export function mailEncryptionEnable(
  mode: "keychain" | "passphrase",
  passphrase?: string,
): Promise<MailEncryptionState> {
  return invoke<MailEncryptionState>("mail_encryption_enable", { mode, passphrase });
}

export function mailEncryptionUnlock(passphrase: string): Promise<MailEncryptionState> {
  return invoke<MailEncryptionState>("mail_encryption_unlock", { passphrase });
}

/** Record that the user does not want it, so the one-time prompt stops asking. */
export function mailEncryptionDecline(): Promise<void> {
  return invoke<void>("mail_encryption_decline");
}

/**
 * Delete the local mail and start again, encrypted.
 *
 * The honest alternative to migrating: a migration cannot reliably erase the
 * plaintext it replaces (SSDs and copy-on-write filesystems do not overwrite in
 * place), while this never produces a second copy at all.
 */
export function mailEncryptionReset(
  mode: "keychain" | "passphrase",
  passphrase?: string,
): Promise<MailEncryptionState> {
  return invoke<MailEncryptionState>("mail_encryption_reset", { mode, passphrase });
}

// ── OpenPGP (docs/mail_encryption_plan.md §6) ─────────────────────────────

/**
 * Whether the key surface can be used at all. The keyring needs the local store
 * encrypted — a private key in a plaintext file would make the whole feature
 * theatre — so the UI gates on this one bool rather than letting every key
 * action fail with the same sentence.
 */
export function mailPgpAvailable(): Promise<boolean> {
  return invoke<boolean>("mail_pgp_available").catch(() => false);
}

export function mailPgpKeys(): Promise<PgpKeyInfo[]> {
  return invoke<PgpKeyInfo[]>("mail_pgp_keys");
}

export function mailPgpGenerate(
  accountId: string,
  name: string,
  address: string,
): Promise<PgpKeyInfo> {
  return invoke<PgpKeyInfo>("mail_pgp_generate", { accountId, name, address });
}

/** Import from pasted text. No wrapper here takes a path, because no command does. */
export function mailPgpImport(armored: string): Promise<PgpKeyInfo[]> {
  return invoke<PgpKeyInfo[]>("mail_pgp_import", { armored });
}

/** Import from a file the user picks in the OS dialog the **backend** raises. */
export function mailPgpImportPick(): Promise<PgpKeyInfo[]> {
  return invoke<PgpKeyInfo[]>("mail_pgp_import_pick");
}

/** The armored **public** half. There is no command that exports a private key. */
export function mailPgpExport(fingerprint: string): Promise<string> {
  return invoke<string>("mail_pgp_export", { fingerprint });
}

/**
 * Record that the user compared this fingerprint out of band.
 *
 * The only path to `state: "verified"`, and therefore the only way any message
 * ever earns positive chrome. OpenPGP has no authority to ask instead.
 */
export function mailPgpSetVerified(fingerprint: string, verified: boolean): Promise<PgpKeyInfo> {
  return invoke<PgpKeyInfo>("mail_pgp_set_verified", { fingerprint, verified });
}

export function mailPgpBind(
  fingerprint: string,
  accountId: string,
  bind: boolean,
): Promise<void> {
  return invoke<void>("mail_pgp_bind", { fingerprint, accountId, bind });
}

export function mailPgpDelete(fingerprint: string): Promise<void> {
  return invoke<void>("mail_pgp_delete", { fingerprint });
}

/**
 * Which recipients have no key — asked **before** the message is written, not
 * discovered on Send, because finding out then means either a refused send or
 * (far worse) a silent downgrade to plaintext.
 */
export function mailPgpRecipientsReady(
  accountId: string,
  recipients: string[],
): Promise<string[]> {
  return invoke<string[]>("mail_pgp_recipients_ready", { accountId, recipients });
}

/**
 * A fingerprint in the form people actually compare: groups of four.
 *
 * 40 run-together hex characters do not get compared, they get glanced at — and
 * a glanced-at fingerprint is the whole trust model of OpenPGP quietly failing.
 */
export function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * The panel's tone. **Only `verified` is positive** — see `MailCryptoState`.
 *
 * `known` is neutral rather than good on purpose: a good signature from a key
 * nobody checked is a statement about bytes, not about a person, and toning it
 * green would say the opposite.
 */
export function mailCryptoTone(info: MailCryptoInfo): "good" | "warn" | "bad" | "neutral" {
  const byState: Record<MailCryptoState, "good" | "warn" | "bad" | "neutral"> = {
    verified: "good",
    known: "neutral",
    unaligned: "warn",
    invalid: "bad",
    nokey: "neutral",
    unusable: "warn",
    unsupported: "neutral",
    none: "neutral",
  };
  const tone = byState[info.state] ?? "neutral";
  // An encrypted message we could not open is a warning whatever its signature
  // says — the reader is looking at a message they cannot read.
  if (info.encrypted && !info.decrypted) return tone === "bad" ? "bad" : "warn";
  return tone;
}

/**
 * The i18n key for a backend note token.
 *
 * The backend speaks in machine tokens so the wording can live in `i18n` ×5 —
 * the same split the browser's `reasonPhrase` uses. An unrecognized token
 * renders as **nothing** rather than as the raw token: a note is context, and a
 * user shown `signer-key-unverified` learns less than one shown nothing.
 */
export function mailCryptoNoteKey(note: string): TranslationKey | null {
  const known: Record<string, TranslationKey> = {
    "headers-not-signed": "mail.crypto.noteHeaders",
    "signer-key-unverified": "mail.crypto.noteUnverified",
    "signer-not-aligned": "mail.crypto.noteUnaligned",
    "signer-key-missing": "mail.crypto.noteNoKey",
    "signature-invalid": "mail.crypto.noteInvalid",
    "format-not-supported": "mail.crypto.noteUnsupported",
    "inline-signature-not-checked": "mail.crypto.noteInlineUnchecked",
    "decrypt-failed": "mail.crypto.noteDecryptFailed",
    "decrypt-no-key": "mail.crypto.noteDecryptNoKey",
    "decrypt-locked": "mail.crypto.noteDecryptLocked",
  };
  return known[note] ?? null;
}

export function onMailSync(handler: (e: MailSyncEvent) => void): Promise<UnlistenFn> {
  return listen<MailSyncEvent>("mail:sync", (ev) => handler(ev.payload));
}

export function onMailNew(handler: (e: MailNewEvent) => void): Promise<UnlistenFn> {
  return listen<MailNewEvent>("mail:new", (ev) => handler(ev.payload));
}

// ── The render surface (pure; no IPC) ────────────────────────────────────────

/**
 * The frame's Content-Security-Policy, verbatim and constant.
 *
 * It is a single frozen string on purpose: "load remote images" is a *backend*
 * action that inlines `data:` URIs, never a per-message relaxation of this
 * policy, because a relaxed policy is exactly the kind of state that gets left
 * on. `default-src 'none'` is the base — every directive not listed inherits it.
 * `style-src 'unsafe-inline'` is required for our reset and for the surviving
 * `style=` attributes, and is safe **only** because scripts are impossible here.
 * The valueless `sandbox` directive restates the iframe attribute inside the
 * document, so the policy survives even if the attribute is ever edited away.
 */
export const MAIL_FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; " +
  "object-src 'none'; frame-src 'none'; child-src 'none'; connect-src 'none'; " +
  "font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; sandbox";

/** Our own trusted reset inside the frame. The message's own CSS cannot reach
 *  these rules — they are in the document's `<style>`, which the sanitizer strips
 *  from the message itself. `content` on `.mail-link::after` is deliberate: the
 *  CSS property allowlist that bans `content` applies to *message* CSS, not ours. */
const FRAME_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 13px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .mail-body { padding: 12px 14px; max-width: 100%; }
  .mail-body img { max-width: 100%; height: auto; }
  .mail-body table { max-width: 100%; border-collapse: collapse; }
  .mail-body pre, .mail-body code { white-space: pre-wrap; }
  .mail-plain { white-space: pre-wrap; font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; }
  .mail-link { color: #2563eb; text-decoration: underline; cursor: default; }
  .mail-link::after { content: " \\2197"; font-size: 0.85em; opacity: 0.7; }
  blockquote { margin: 0 0 0 10px; padding-left: 10px; border-left: 2px solid #c8c8c8; color: #555; }
`;

/** Escape text for a text node / attribute value. Used for the plain-text body,
 *  which is never HTML and must never be treated as such. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * **The tripwire, not a second sanitizer.**
 *
 * The backend sanitizes with `ammonia` before the HTML ever crosses IPC, and
 * Plan B argues at length against a second, differently-parsing sanitizer on
 * this side (two allowlists drift, and mismatched parse semantics are a known
 * mutation-XSS source). What the frontend *does* owe is a cheap assertion of the
 * invariant it depends on: if any of these survive, the backend regressed, and
 * the honest response is an error card — never a render.
 *
 * **It inspects markup, never text.** Scanning the whole string was the obvious
 * spelling and the wrong one: sanitized output escapes its text nodes, so `<` can
 * only introduce a real tag — but `=` cannot be escaped away, and the attribute
 * pattern `\son[a-z]+\s*=` matches the ordinary English " one = two". A tripwire
 * that refuses to render a message *about* HTML, in a mail client shipped inside
 * a developer tool, would fire mostly on legitimate mail — and a false alarm that
 * common is how a real one gets ignored. So the scan runs over start-tags only,
 * and text content is not evidence of anything.
 */
export function bodyLooksUnsafe(html: string): boolean {
  const lowered = html.toLowerCase();
  // Any `<` that opens a tag at all. The sanitizer must not have emitted these
  // regardless of where they sit, so they are checked against the raw string.
  if (
    lowered.includes("<script") ||
    lowered.includes("<iframe") ||
    lowered.includes("<object") ||
    lowered.includes("<embed") ||
    lowered.includes("<form") ||
    lowered.includes("<base") ||
    lowered.includes("<link")
  ) {
    return true;
  }
  // Everything else is an *attribute* claim, so it is only meaningful inside a
  // start tag. `[^>]*` is deliberately naive: a `>` inside a quoted attribute
  // value ends the match early, which can only ever make this check narrower —
  // and a sanitizer that emits such a value has already failed the checks above.
  for (const tag of lowered.match(/<[a-z][a-z0-9-]*[^>]*>/g) ?? []) {
    if (
      /\son[a-z]+\s*=/.test(tag) || // event handler
      /\shref\s*=/.test(tag) || // links must be data-lid markers, never hrefs
      /\ssrcdoc\s*=/.test(tag) ||
      /\ssrcset\s*=/.test(tag) ||
      /\sformaction\s*=/.test(tag) ||
      tag.includes("javascript:") ||
      tag.includes("vbscript:")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Assemble the `srcdoc` document for a message body.
 *
 * The `<meta>` CSP is the **first content in the document**, before any element
 * that could load — a CSP meta placed after the first resource-loading element
 * is ignored for that element. It is an inline `<meta>` rather than the `csp=`
 * iframe attribute because CSP Embedded Enforcement is a Chromium feature that
 * **WebKitGTK does not implement**: relying on it would produce a policy that
 * silently does not exist on Linux, the worst available failure mode. CSP
 * inheritance into `about:srcdoc` is treated as a bonus, never as the mechanism.
 */
export function buildMessageSrcdoc(body: {
  html?: string;
  text?: string;
}): string {
  const fragment = body.html
    ? `<div class="mail-body" dir="auto">${body.html}</div>`
    : `<div class="mail-body"><pre class="mail-plain">${escapeHtml(body.text ?? "")}</pre></div>`;
  return [
    "<!DOCTYPE html>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${FRAME_STYLE}</style>`,
    fragment,
  ].join("\n");
}

// ── Small display helpers (pure) ─────────────────────────────────────────────

/**
 * How an address is rendered anywhere in the mail UI: **the addr-spec is always
 * shown**. A display name is attacker-chosen text (`From: "support@bank.example"
 * <a@evil.example>`), so it is never allowed to stand in for identity — and it is
 * stripped of the bidi/format controls that would otherwise let it reorder what
 * the user reads.
 */
export function formatAddress(addr: { name?: string; address: string }): string {
  const name = stripFormatControls(addr.name ?? "").trim();
  return name && name !== addr.address ? `${name} <${addr.address}>` : addr.address;
}

/**
 * The sender badge's colour, hashed from the **addr-spec** — never the display
 * name. The name is attacker-chosen, so hashing it would hand a spoofer the
 * real sender's colour along with their name; the address is the part that
 * has to differ, so the colour differs with it. Same recipe as `autoBoxColor`
 * (golden-angle spread, `categoryColor`'s saturation/lightness), so it sits in
 * the app's one family of hashed hues.
 */
export function senderColor(address: string): string {
  const hue = Math.round((hashString(address.trim().toLowerCase()) * 137.508) % 360);
  return `hsl(${hue} 62% 58%)`;
}

/** The badge's letter: the first letter or digit of the display name, else of
 *  the address, else `?`. Code-point aware, so an astral letter is not split. */
export function senderInitial(addr: { name?: string; address: string }): string {
  const pick = (s: string) => stripFormatControls(s).match(/[\p{L}\p{N}]/u)?.[0];
  const ch = pick(addr.name ?? "") ?? pick(addr.address) ?? "?";
  return ch.toLocaleUpperCase();
}

/** Remove bidi overrides, isolates and zero-width characters from display text.
 *  These are what turn a filename with an embedded RLO into something that
 *  reads as a harmless .png.
 *
 *  Re-exported from `lib/textSafety`, not defined here. It moved because this
 *  module imports the Tauri invoke surface, which made one regex unreachable
 *  from the pure layers that need it just as much (`lib/calendar/ics.ts` renders event
 *  titles somebody else wrote). Same function, same behaviour, one definition \u2014
 *  every mail call site below still imports it from here. */
export { stripFormatControls };

/** A byte count for an attachment chip. The ladder is the one canonical
 *  formatter (§9.1); what stays here is the ""-for-invalid guard — a chip with
 *  no size renders nothing rather than "0 B". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  return formatBytes(bytes);
}

/**
 * RFC 3339 → a short local stamp; an unparseable date is shown verbatim rather
 * than as "Invalid Date" (a malformed `Date:` header is itself information).
 *
 * `use24h` is passed in rather than left to the locale, because the locale is
 * only a *guess* at the user's clock and `lib/timeFormat` holds the answer —
 * whether they said so explicitly or it was derived from their UI language.
 * Omitting it keeps the locale's own convention, which is what a caller with no
 * settings in reach (a test) should get.
 */
export function formatMailDate(iso: string, locale?: string, use24h?: boolean): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
        ...(use24h === undefined ? {} : { hour12: !use24h }),
      })
    : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The list's date column: like `formatMailDate`, but an older message keeps its
 * arrival time (`hh:mm`) beside the day, so two mails from the same day are
 * told apart without opening them. The year is dropped inside the current one,
 * which is what buys the time its room in a fixed-width column.
 */
export function formatMailListDate(iso: string, locale?: string, use24h?: boolean): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const today = new Date();
  const time: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(use24h === undefined ? {} : { hour12: !use24h }),
  };
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return d.toLocaleTimeString(locale, time);
  return d.toLocaleString(locale, {
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    ...time,
  });
}

/** Only `http`/`https` may ever be handed to `open_external_url` (which refuses
 *  everything else itself — a second, independent check). A `mailto:` is handled
 *  internally by the composer; every other scheme is text, not a link. */
export function linkIsOpenable(link: { href: string; scheme_warning?: string }): boolean {
  if (link.scheme_warning) return false;
  const lowered = link.href.trim().toLowerCase();
  return lowered.startsWith("http://") || lowered.startsWith("https://");
}

/** True for a `mailto:` link, which opens the internal composer rather than the
 *  OS handler (T17: `mailto:` is never handed to the system). */
export function linkIsMailto(link: { href: string }): boolean {
  return link.href.trim().toLowerCase().startsWith("mailto:");
}

/**
 * Schemes with **no host part**, where the backend's `display_host` falls back
 * to the scheme word itself — so a phone number in a signature renders as the
 * bare string `tel`, naming nothing.
 */
const HOSTLESS_SCHEMES = ["mailto", "tel", "sms"] as const;

/**
 * Schemes that are unopenable but entirely ordinary, so their presence must not
 * make a message look suspicious.
 *
 * `tel:` and `sms:` are signature furniture: nearly every business email has
 * one. They carry a `scheme_warning` because they are not http(s) — which
 * correctly denies them an Open button — but treating that as a *suspicion*
 * flagged the row amber and force-opened the links panel on almost every real
 * message. Same crying-wolf failure as an over-eager sanitizer tripwire: a
 * warning that fires on ordinary mail is one nobody reads on the message that
 * matters. The refusal to open them is unchanged; only the alarm is dropped.
 */
const BENIGN_UNOPENABLE_SCHEMES = ["mailto", "tel", "sms"] as const;

function schemeOf(href: string): string {
  const i = href.indexOf(":");
  return i < 0 ? "" : href.slice(0, i).trim().toLowerCase();
}

/**
 * What a link row should call this link.
 *
 * For an ordinary web link that is the host, which is the only part that decides
 * where a click goes. For a hostless scheme it is the **target itself** — the
 * phone number, the address — because "tel" tells the reader nothing about which
 * number they are about to copy.
 *
 * The value is sender-controlled text, so it is stripped of the bidi controls
 * that would otherwise let a number or address reorder itself, exactly as a
 * subject or a filename is. It is never truncated: the full URL is also shown in
 * the confirm dialog, and shortening a target is the one thing this UI must not
 * do.
 */
export function mailLinkLabel(link: { href: string; display_host?: string }): string {
  const href = link.href.trim();
  const scheme = schemeOf(href);
  if ((HOSTLESS_SCHEMES as readonly string[]).includes(scheme)) {
    // Drop a `mailto:` query (`?subject=…`) — it is not part of the identity.
    const target = href.slice(scheme.length + 1).split("?")[0];
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // A malformed escape is shown as written rather than dropping the row.
    }
    const clean = stripFormatControls(decoded).trim();
    if (clean) return clean;
  }
  return stripFormatControls(link.display_host ?? "") || href;
}

/**
 * Does this row deserve the reader's attention — the amber styling, and the
 * auto-expansion of the collapsed panel?
 *
 * A display-text-vs-host mismatch always does. A scheme warning does only when
 * the scheme is not everyday signature furniture.
 */
export function mailLinkNeedsAttention(link: {
  href: string;
  mismatch: boolean;
  scheme_warning?: string;
}): boolean {
  if (link.mismatch) return true;
  if (!link.scheme_warning) return false;
  return !(BENIGN_UNOPENABLE_SCHEMES as readonly string[]).includes(schemeOf(link.href.trim()));
}

/** Open a vetted link in the user's browser. The URL comes from the parent's own
 *  `MailBody.links` table keyed by `lid` — never from a string the frame handed
 *  back, which is what preserves the anti-phishing property regardless. */
export function openMailLink(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}

// ── Authentication-Results display (pure) ────────────────────────────────────

/** The three methods the UI renders, in the order it renders them. Anything else
 *  the server reported (`iprev`, `arc`, `auth`, …) is carried in the data but not
 *  shown: a row nobody can act on is noise on the one surface that must stay
 *  readable. */
export const MAIL_AUTH_METHODS = ["dmarc", "spf", "dkim"] as const;

/**
 * How one verdict is toned. **`pass` is the only thing that can be "good", and
 * only when it is also aligned** — `dkim=pass header.d=evil.example` on a mail
 * claiming to be a bank is a real pass by the wrong domain, and toning it green
 * is precisely the misreading this feature would otherwise introduce.
 *
 * Anything unrecognized tones neutral. A verdict that cannot be understood must
 * never inherit the appearance of one that passed.
 */
export function mailAuthTone(m: MailAuthMethod): "good" | "bad" | "warn" | "neutral" {
  switch (m.result) {
    case "pass":
      // `aligned === undefined` means the clause named no identity to compare,
      // so a pass cannot be attributed to anyone — that is not good news.
      return m.aligned === true ? "good" : "warn";
    case "fail":
    case "permerror":
      return "bad";
    case "softfail":
    case "policy":
      return "warn";
    default:
      return "neutral";
  }
}

/**
 * The methods worth showing, in a fixed order.
 *
 * Empty for every state but `verified` — the backend already clears them, and
 * this refuses a second time. Two independent layers, because the whole feature
 * is worth less than nothing if an unchecked header can ever paint a tick.
 *
 * **A method can legitimately appear more than once.** Real mail routinely
 * carries two DKIM signatures — one by the sending service, one by the brand —
 * and they can disagree about alignment. Both are kept, because "signed by two
 * domains, only one of which is the sender" is exactly the thing worth seeing.
 * Only byte-identical clauses are collapsed.
 */
export function mailAuthShown(auth: MailAuthResults | undefined): MailAuthMethod[] {
  if (!auth || auth.state !== "verified") return [];
  const order = (m: MailAuthMethod) => {
    const i = (MAIL_AUTH_METHODS as readonly string[]).indexOf(m.method);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const seen = new Set<string>();
  return auth.methods
    .filter((m) => (MAIL_AUTH_METHODS as readonly string[]).includes(m.method))
    .filter((m) => {
      const key = `${m.method}|${m.result}|${m.identifier ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => order(a) - order(b));
}

/** The summary keys, spelled out so the caller keeps `useT`'s key checking —
 *  a widened `string` here would silently disable it for this whole panel. */
export type MailAuthSummaryKey =
  | "mail.authUnconfigured"
  | "mail.authForeign"
  | "mail.authForeignAnonymous"
  | "mail.authNothingChecked"
  | "mail.authFailed"
  | "mail.authPartial"
  | "mail.authPassed"
  | "mail.authInconclusive";

/**
 * The one-line summary beside the sender, as a translation key plus its values.
 *
 * Returns `null` when there is nothing honest to say — no header at all. The UI
 * then shows nothing rather than an absence dressed up as a verdict: a message
 * with no `Authentication-Results` is not a message that failed anything.
 */
export function mailAuthSummary(
  auth: MailAuthResults | undefined,
): { key: MailAuthSummaryKey; values?: Record<string, string | number> } | null {
  if (!auth) return null;
  if (auth.state === "unconfigured") return { key: "mail.authUnconfigured" };
  if (auth.state === "foreign") {
    return auth.authserv_id
      ? { key: "mail.authForeign", values: { server: auth.authserv_id } }
      : { key: "mail.authForeignAnonymous" };
  }
  const shown = mailAuthShown(auth);
  if (shown.length === 0) return { key: "mail.authNothingChecked" };

  // **DMARC is authoritative when it has an answer, and the individual chips
  // are explanation rather than independent verdicts.**
  //
  // `dmarc=pass` *is* the question "did an aligned SPF or DKIM pass for the
  // domain in `From`?" — so an unaligned SPF beside it is not a partial result,
  // it is the normal shape of mail sent through a service: the envelope sender
  // is the ESP's bounce domain, SPF passes for the ESP, and DKIM alignment is
  // what carries DMARC. Summarizing that as "passed only in part" marks nearly
  // every legitimate commercial sender as suspect, and an indicator that cries
  // wolf on ordinary mail is one nobody reads on the message that matters —
  // the same reasoning that keeps `bodyLooksUnsafe` from firing on prose.
  //
  // Found in live QA: a booking confirmation with `dmarc=pass`, an unaligned
  // `spf=pass`, and two DKIM signatures (one aligned, one not) read as "Passed
  // only in part", which is true of the clauses and wrong about the message.
  const dmarc = shown.find((m) => m.method === "dmarc");
  if (dmarc && mailAuthTone(dmarc) === "bad") return { key: "mail.authFailed" };
  if (dmarc?.result === "pass" && dmarc.aligned === true) return { key: "mail.authPassed" };

  // No usable DMARC answer — fall back to reading the individual signals, where
  // an unaligned pass really is all the evidence there is.
  if (shown.some((m) => mailAuthTone(m) === "bad")) return { key: "mail.authFailed" };
  if (shown.some((m) => mailAuthTone(m) === "warn")) return { key: "mail.authPartial" };
  if (shown.every((m) => mailAuthTone(m) === "good")) return { key: "mail.authPassed" };
  return { key: "mail.authInconclusive" };
}

/** The panel's overall tone, derived from the summary rather than from the worst
 *  chip — so a DMARC-confirmed message reads green with amber detail, instead of
 *  the detail overriding the conclusion. */
export function mailAuthPanelTone(
  auth: MailAuthResults | undefined,
): "good" | "bad" | "warn" | "neutral" {
  const summary = mailAuthSummary(auth);
  switch (summary?.key) {
    case "mail.authPassed":
      return "good";
    case "mail.authPartial":
      return "warn";
    case "mail.authFailed":
    case "mail.authForeign":
    case "mail.authForeignAnonymous":
      return "bad";
    default:
      return "neutral";
  }
}

/** True when the conclusion rests on DMARC while a detail chip is amber — the
 *  case that needs a sentence, or the green summary beside an orange chip reads
 *  as a contradiction. */
export function mailAuthDmarcCarried(auth: MailAuthResults | undefined): boolean {
  const shown = mailAuthShown(auth);
  const dmarc = shown.find((m) => m.method === "dmarc");
  if (!(dmarc?.result === "pass" && dmarc.aligned === true)) return false;
  return shown.some((m) => m.method !== "dmarc" && mailAuthTone(m) !== "good");
}
