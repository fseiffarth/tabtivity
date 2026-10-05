/**
 * Wire types for the embedded mail client — the FROZEN CONTRACT between the
 * Rust backend (`src-tauri/src/commands/mail.rs`) and the React frontend
 * (`src/lib/mail.ts`, `src/stores/mail.ts`, `src/components/mail/`).
 *
 * Two rules make this file load-bearing rather than decorative:
 *
 * 1. **No command in this contract takes a filesystem path.** That is the whole
 *    statement of the sandbox boundary: files cross it only through
 *    `mail_attach_pick` / `mail_attachment_save`, both of which raise the native
 *    OS dialog *inside Rust*. An attacker who controls a message's bytes, its
 *    HTML, and any script that somehow escaped the render iframe still has no
 *    IPC verb that names a path — there is nothing to traverse.
 * 2. Field names are snake_case because they are serde-serialized Rust structs
 *    verbatim. Do not camelCase them on this side.
 *
 * Design rationale lives in `docs/mail_client_plan_a.md` (integration, store,
 * credentials) and `docs/mail_client_plan_b.md` (threat model, sanitizer,
 * transport, attachment rules).
 */

/** One parsed address. `name` is display text and is NEVER trusted as identity. */
export interface MailAddress {
  name?: string;
  address: string;
}

/** How a connection is secured. `none` exists only to be rejected loudly. */
export type MailSecurity = "tls" | "starttls" | "none";

export interface MailServer {
  host: string;
  port: number;
  user: string;
  security: MailSecurity;
}

/** `oauth2` is stubbed in v1 — the variant exists so the store shape is stable. */
export type MailAuthKind = "password" | "oauth2";

export interface MailAccount {
  id: string;
  /**
   * The dialog's **Name**, and the *sending* identity: this is the display
   * name written into `From:`, so it is the one of the two names that leaves
   * the machine. Empty means send the bare address.
   */
  label: string;
  address: string;
  /**
   * The dialog's **Display name** — local only. It names the account on the
   * accounts badge and nowhere on the wire; the folders rail deliberately
   * keeps naming the account by `label`.
   */
  display_name?: string;
  imap: MailServer;
  smtp: MailServer;
  auth: MailAuthKind;
  /** Opt-in, DEFAULT FALSE. False means the password lives in memory for the session only. */
  save_password: boolean;
  signature?: string;
  check_interval_min?: number;
  /** **VPN-only, default false.** While set, the backend opens no socket to
   *  this account unless an OpenVPN tunnel Tabtivity knows about is up, and the
   *  header's interval check skips it quietly instead of failing — then checks
   *  it the moment a tunnel comes up (`lib/remote/vpn/vpnGate.ts`). */
  require_vpn?: boolean;
  /**
   * The `authserv-id` this account's receiving server writes into
   * `Authentication-Results`. While unset, **no SPF/DKIM/DMARC verdict is shown
   * at all** — an unchecked header is sender-controlled text.
   */
  authserv_id?: string;
  /** Per-account **Mail AI (local)** toggles (Group Q). Absent for an account
   *  that never opened the feature. Gated globally by `Settings.mail_ai_allow`
   *  and a resolvable loopback mail-role model — see `lib/mail`'s
   *  `mailAiResolvable`/`mailAiFeatureOn`. */
  ai?: MailAiPrefs;
}

/**
 * The per-account Mail AI (local) feature toggles — all opt-in, all **default
 * off/absent**. Per account rather than in `Settings`, because whether a mailbox
 * wants summaries, auto-filing and extraction is a per-mailbox decision. The one
 * thing that stays global is the master switch `Settings.mail_ai_allow`.
 */
export interface MailAiPrefs {
  /** Offer the on-demand "Summarize (local)" control in the message view. */
  summarize?: boolean;
  /** Let a sync ask the local model to file new inbox mail into Important /
   *  Urgent, after the keyword-filter pass. Read in the **backend** sync. */
  autoclassify?: boolean;
  /** Offer the composer's "Draft from notes" control. */
  formalize?: boolean;
  /** Offer "Add to calendar" extraction on a message. */
  calendar?: boolean;
  /** Offer "Add to-do" extraction on a message. */
  todo?: boolean;
  /** Skip the review step for extracted events / to-do cards. **Default off** —
   *  mail must never quietly write to the user's own data. */
  auto_create?: boolean;
  /** A **contained reader** agent may read this account's mail through the root
   *  MCP tools. Unset = off. The opposite consent to every switch above: what
   *  such an agent reads is sent to its cloud provider. */
  agent_access?: boolean;
  /** How much `agent_access` opens: the messages the user marked for agents
   *  (the store's `agent_marks`) or the whole account. Unset = `"marked"`, so
   *  a switch turned on before this field existed reads as the narrower
   *  consent (`docs/mail_mcp_plan.md` §1). */
  agent_scope?: MailAgentScope;
}

export type MailAgentScope = "marked" | "all";

/**
 * What the keychain actually did. Never collapse this to a bare account —
 * a write that silently failed is how a user loses a password they think is saved.
 */
export interface MailAccountSaved {
  account: MailAccount;
  saved: boolean;
  save_error?: string;
}

export interface MailProbe {
  imap_ok: boolean;
  smtp_ok: boolean;
  error?: string;
}

/** Mirrors the existing remote-credentials keyring state so the UI can reuse its banner. */
export type MailKeyringState = "available" | "locked" | "unavailable" | "unknown";

/**
 * The local store's encryption, as one read (`docs/mail_encryption_plan.md`).
 *
 * More than a bool because four situations are distinguishable and collapsing
 * any two produces a lie — in particular `enabled && !active && ephemeral`,
 * which looks exactly like a working mailbox right up until the next launch
 * throws away everything it downloaded.
 */
export interface MailEncryptionState {
  /** A key file exists: this mailbox is configured to be encrypted. */
  enabled: boolean;
  /** The store actually open right now seals its values. */
  active: boolean;
  mode?: "keychain" | "passphrase";
  /** The open store is memory-only: nothing is being written down. */
  ephemeral: boolean;
  /** Why, in the user's words. Present only with `ephemeral`. */
  reason?: string;
  needs_passphrase: boolean;
  /** `undefined` means the user has never been asked — the only state in which to ask. */
  preference?: boolean;
  /** Whether turning encryption on means migrating existing mail. */
  has_existing_mail: boolean;
  keyring: MailKeyringState;
}

// ── End-to-end encryption and signatures ──────────────────────────────────

export type MailCryptoFormat = "openpgp" | "smime";

/**
 * What the panel may say about a signature — deliberately `MailAuthResults`'
 * vocabulary, because the misreading is the same one.
 *
 * `verified` is the ONLY state that earns positive chrome, and it needs three
 * clauses at once: a good signature, from a key the user checked out of band,
 * whose identity is the address the message claims to be from. Drop the middle
 * clause and a padlock goes to whoever last emailed you a key; drop the last and
 * it goes to anyone with *a* verified key signing as anyone they like.
 */
export type MailCryptoState =
  | "none"
  | "verified"
  | "unaligned"
  | "known"
  | "invalid"
  | "nokey"
  | "unusable"
  | "unsupported";

export interface MailCryptoInfo {
  format: MailCryptoFormat;
  encrypted: boolean;
  /** …and it was decrypted for this render. `encrypted && !decrypted` is locked. */
  decrypted: boolean;
  signed: boolean;
  state: MailCryptoState;
  /** The signing identity — an address, else a fingerprint. Shown *beside* the
   *  verdict, never instead of it: a verdict without the identity it applies to
   *  is the classic misreading. */
  identifier?: string;
  aligned?: boolean;
  supported: boolean;
  /** Machine tokens the frontend turns into sentences (so the wording lives in
   *  `i18n` ×5). Always includes `headers-not-signed` for a signed message. */
  notes: string[];
}

/** One key in the local keyring. Carries no key material, by construction. */
export interface PgpKeyInfo {
  /** Uppercase hex, no spaces. Displayed grouped — see `formatFingerprint`. */
  fingerprint: string;
  identities: string[];
  addresses: string[];
  /** We hold the private half: one of the user's own keys. */
  secret: boolean;
  /** The user compared this fingerprint out of band. */
  verified: boolean;
  accounts: string[];
  algorithm: string;
}

export interface MailPasswordState {
  has_saved: boolean;
  keyring: MailKeyringState;
}

export type MailFolderKind =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "junk"
  | "archive"
  | "other";

export interface MailFolder {
  id: string;
  account_id: string;
  /** Server-side path, e.g. "INBOX/Projects". Display uses `name`. */
  path: string;
  name: string;
  kind: MailFolderKind;
  unread: number;
  total: number;
}

export interface MailHeader {
  id: string;
  account_id: string;
  folder_id: string;
  uid: number;
  /**
   * The sender's RFC 5322 `Message-ID`. Distinct from `id`, which is Tabtivity's
   * own `{folder_id}-{uid}` store key and means nothing to any other mail
   * system — a reply that puts the store key in `In-Reply-To` fabricates a
   * reference that threads nowhere. Absent when the message carried none.
   */
  rfc_message_id?: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** RFC 3339. */
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  has_attachments: boolean;
  size: number;
  /** Short plain-text snippet, already stripped of markup by the backend. */
  preview: string;
  /**
   * Non-empty when the message's headers are malformed in a way the user must see
   * (e.g. DUPLICATE_FROM). The UI shows a warning strip; it never silently picks one.
   */
  malformed_headers?: string[];
  /**
   * SPF/DKIM/DMARC as the **receiving server** reported them in
   * `Authentication-Results`, with the trust state the backend decided.
   * Absent when the message carried no such header — an absence, not a failure.
   */
  auth?: MailAuthResults;
  /** The user's local **priority mark** — see {@link MailPriority}. Absent means
   *  unmarked, and an unrecognized value from a newer backend arrives absent too
   *  (the Rust side degrades it rather than guessing). */
  priority?: MailPriority;
  /**
   * **Who** set {@link priority}, sealed alongside it (Group Q #205). A model
   * classifier must not be able to pass for a keyword rule the user wrote, so the
   * provenance is carried explicitly: `user` (a right-click), `filter` (a keyword
   * rule) or `model` (the local classifier). Absent when unmarked, or from a
   * backend that predates the column. See {@link priority_reason}.
   */
  priority_source?: MailPrioritySource;
  /** The one-line reason the {@link priority_source} recorded — a rule name for a
   *  filter, the local model's own sentence for `model`. Surfaced read-only so a
   *  mark the user did not make can be *explained* ("marked Urgent by the local
   *  model: '…'") rather than merely appear. */
  priority_reason?: string;
}

/** Who set a message's {@link MailHeader.priority} — see `priority_source`. */
export type MailPrioritySource = "user" | "filter" | "model";

/**
 * A message's local priority mark: **Important** or **Urgent**.
 *
 * **A mark, not a move, and not an IMAP flag.** The message stays in the folder
 * and the account it arrived in; nothing is uploaded, copied or deleted, and
 * `mail_priority_set` is one of only three commands in this contract that opens
 * no socket at all.
 *
 * That is forced by the feature rather than chosen for convenience: the
 * Important and Urgent lists span *every account*, and no IMAP folder can hold
 * mail from two accounts — so the moment the list is cross-account, a local
 * column is the only thing that can implement it. A real server-side move would
 * mean one folder per account, a round trip per mark, new UIDs (invalidating
 * every cached body, attachment and store key for the message), and a failure
 * mode where some accounts took the move and others refused it.
 *
 * It is deliberately not the star (`flagged`): that one already means something
 * to the user and round-trips to the server, and overloading it would make
 * "starred" and "important" one bit wearing two names.
 *
 * The honest cost, stated here because the UI has to say it too: a mark is
 * **this machine's**. No other mail client sees it, and a mailbox re-synced onto
 * another Tabtivity install starts unmarked.
 */
export type MailPriority = "important" | "urgent";

/**
 * Which part of a message a filter rule's words are searched in.
 *
 * `preview` is the body **snippet** the sync stores, not the body: a sync
 * fetches headers, and the full text of a message is on this machine only once
 * it has been opened. Searching bodies at check time would mean downloading
 * every message of every folder on every check — so a word buried on page three
 * does not fire a rule, and the dialog says so rather than letting "body" imply
 * a search that does not happen.
 */
export type MailFilterField = "subject" | "sender" | "recipients" | "preview";

/**
 * One keyword rule: *when these words appear in these parts of a newly arrived
 * message, mark it Important or Urgent.*
 *
 * **A rule sets the same local column the right-click menu sets** — see
 * {@link MailPriority}. Nothing is uploaded, no IMAP flag is written, and no
 * message leaves the folder it arrived in, which is why there is no rule
 * anybody can write here that another mail client could see, or that could go
 * wrong on a server.
 *
 * Two limits worth stating wherever this is rendered:
 * - Rules run on messages that **arrive** during a check, and on demand over
 *   mail already in the index (`mailFiltersApply`). They are not a background
 *   pass, and they never re-examine a message that already carries a mark — the
 *   user's own filing outranks a rule, always.
 * - Sent, Drafts, Trash and Junk are out of scope on both paths.
 */
export interface MailFilterRule {
  /** Empty on a rule the dialog has just created; the backend mints it. */
  id: string;
  name: string;
  /** Matched case-insensitively; substrings unless `whole_word`. An **empty
   *  list matches nothing** — never everything. */
  terms: string[];
  /** Where to look. Empty matches nothing, for the same reason. */
  fields: MailFilterField[];
  mark: MailPriority;
  /** Require every term rather than any one of them. */
  match_all: boolean;
  /** Match on word boundaries, so `art` stops matching *start*. */
  whole_word: boolean;
  /** Restrict to one account; absent means every account, like the lists. */
  account_id?: string;
  /** Off keeps the rule but stops applying it. */
  enabled: boolean;
}

/** Why one message matched — the rule, the word, and where it was found. Carried
 *  so a mark the user did not make can be *explained* rather than just appear. */
export interface MailFilterHit {
  rule_id: string;
  rule_name: string;
  mark: MailPriority;
  term: string;
  field: MailFilterField;
}

export interface MailFilterSample {
  message_id: string;
  subject: string;
  from: MailAddress;
  date: string;
  hit: MailFilterHit;
}

/** What running the rules over stored mail would do (`dry_run`) or did.
 *
 *  One shape for both, because the only honest preview is the one the apply
 *  itself produces — two code paths answering "what will this catch" and "what
 *  did it catch" is how a filter dialog promises 3 and marks 40. */
export interface MailFilterReport {
  scanned: number;
  matched: number;
  /** Always 0 for a dry run. */
  marked: number;
  dry_run: boolean;
  /** Set when the scan bound was hit, so a count can be qualified with *of the
   *  most recent N* instead of implying the whole mailbox. */
  capped?: number;
  samples: MailFilterSample[];
}

/** How much marked mail there is, across every account — the rail's two badges.
 *  Read as one value so the two numbers cannot disagree on screen. */
export interface MailPriorityCounts {
  important: number;
  urgent: number;
  /** Of those, how many are unread. The badge shows the *total* — a list you
   *  file mail into is not an inbox and does not empty as you read it — and the
   *  unread half is only what the rail tones with. */
  important_unread: number;
  urgent_unread: number;
}

/** RFC 8601 §2.7 result tokens. `unknown` is anything a later revision adds — an
 *  unrecognized result degrades to "we don't know", never to a pass. */
export type MailAuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy"
  | "unknown";

/**
 * One `method=result` clause.
 *
 * `identifier` is why this is not one green tick: `dkim=pass header.d=evil.example`
 * on a mail claiming to be from a bank is a genuine pass **by the wrong domain**.
 * `aligned` is that comparison against the visible `From`, already made in Rust.
 */
export interface MailAuthMethod {
  /** `spf`, `dkim`, `dmarc`, … lowercased, version suffix dropped. */
  method: string;
  result: MailAuthVerdict;
  /** The domain the method actually authenticated. */
  identifier?: string;
  /** Whether `identifier` shares a registrable domain with the visible `From`. */
  aligned?: boolean;
}

/**
 * Whether the topmost `Authentication-Results` header may be believed.
 *
 * - `verified` — the account names a trusted `authserv-id` and the topmost
 *   header carries it. **The only state in which `methods` is ever non-empty.**
 * - `foreign` — a trusted id is configured and the topmost header does not carry
 *   it, so these results were written by someone else — quite possibly the sender.
 * - `unconfigured` — no trusted id set for the account; nothing can be believed yet.
 */
export type MailAuthState = "verified" | "foreign" | "unconfigured";

export interface MailAuthResults {
  state: MailAuthState;
  /** The topmost header's `authserv-id`, as written. Absent when malformed. */
  authserv_id?: string;
  /** Clauses of the topmost header only — empty unless `state` is `verified`. */
  methods: MailAuthMethod[];
  /** How many such headers the message carried; only the topmost is ever read. */
  header_count: number;
}

/**
 * What the header list is ordered by.
 *
 * A closed set, not a column name: the backend turns it into an `ORDER BY`,
 * which SQLite cannot take as a bound parameter, so the safety of that one
 * interpolated clause rests on this union having no other members.
 *
 * The sort is applied by the **store**, over the whole folder, because the list
 * is paged — ordering the hundred rows on screen would sort a page, and the
 * biggest message in a mailbox is rarely among the newest.
 */
export type MailSort = "date" | "flagged" | "attachments" | "size";

export interface MailHeaderPage {
  items: MailHeader[];
  total: number;
  /**
   * How many messages a search actually looked at, present **only** when it
   * stopped early.
   *
   * A search over an encrypted store cannot use SQL `LIKE` — there is nothing
   * to match but ciphertext — so the backend opens rows one at a time and stops
   * at a bound. When that happens `total` means "matches among the ones I
   * looked at", which is a weaker claim than usual, and the list says so rather
   * than presenting a truncated answer as a complete one.
   */
  scanned?: number;
}

/**
 * One page of a server-backed folder search (`mailSearch`): the header page
 * plus whether the server was reached and whether matches were capped.
 *
 * `remote` is false when the answer came from downloaded mail only — offline,
 * no saved password, or the server refused — and the list says so, because a
 * truncated answer that looks complete is the one thing a search must never
 * produce.
 */
export interface MailSearchPage extends MailHeaderPage {
  remote: boolean;
  /** The server found more matches than this bounded search could backfill. */
  partial: boolean;
}

export interface MailAttachmentMeta {
  part_id: string;
  /** Already run through the backend's `sanitize_attachment_name`. */
  filename: string;
  mime: string;
  size: number;
  inline: boolean;
  /** Set when the declared MIME type disagrees with the sniffed bytes or the extension. */
  type_mismatch?: string;
}

/**
 * One link found in the sanitized body. The sanitizer strips every `href` and
 * replaces it with `data-lid`, so the rendered document cannot navigate anywhere;
 * opening a link is a frontend decision made against this table.
 */
export interface MailLink {
  lid: number;
  /** The real target, punycode-decoded for display. */
  href: string;
  /** Host as shown to the user, after IDNA normalization. */
  display_host: string;
  /** True when the anchor's visible text claims a different host than `href`. */
  mismatch: boolean;
  /** Set for anything that is not http/https/mailto — such links must not offer "Open". */
  scheme_warning?: string;
}

export interface MailBody {
  id: string;
  /** Sanitized in Rust before it ever reaches the webview. Rendered in a script-less iframe. */
  html?: string;
  text?: string;
  /** How many remote references were blocked. Drives the "Load images" banner. */
  remote_refs: number;
  links: MailLink[];
  attachments: MailAttachmentMeta[];
  /** Set when the body hit a size/element cap and was truncated. */
  truncated?: boolean;
  /** End-to-end signature/encryption, when the message carried any. Absent for
   *  ordinary mail — a reassuring "not encrypted" row on every message would be
   *  noise that trains people to ignore the row. */
  crypto?: MailCryptoInfo;
}

/** A file the user explicitly picked, already copied inside the mail sandbox dir. */
export interface StagedAttachment {
  staged_id: string;
  filename: string;
  mime: string;
  size: number;
  /** `"agent"` for a file a root agent attached by project and path; absent
   *  for the user's own pick (and for every row from before the field). */
  origin?: string;
  /** An agent file's `<project name>/<relative path>` — the chip's text, so a
   *  `paper.pdf` from one project is not taken for another's. */
  source?: string;
}

export interface MailDraft {
  id: string;
  account_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string;
  references?: string[];
  staged: StagedAttachment[];
  /** Who wrote it, when that was not the user: `"agent"` (a root tab) or
   *  `"reader"` (a contained reader, which reads mail from outside). A save
   *  from the composer clears it. */
  origin?: string;
  /** Addresses a root agent suggested. Never in `to` and never read by a send:
   *  the composer offers each as a pill the user adds with a click. */
  suggested_to?: string[];
  /** An agent draft the user approved in ✓ Approvals, so it sits in the
   *  "Drafted by agents" folder. An agent's update unsets it again. */
  filed?: boolean;
}

export interface MailSendResult {
  sent_id?: string;
  error?: string;
}

export type MailFlag = "seen" | "flagged" | "answered" | "deleted";

export interface MailSyncSummary {
  account_id: string;
  folders: number;
  new_messages: number;
  /** Of those, how many a filter rule filed into Important/Urgent. Reported so a
   *  mark nobody made is visible as it happens — mail that quietly moves itself
   *  is what makes people distrust a filter. */
  filtered?: number;
  error?: string;
}

export type MailSyncPhase = "start" | "folder" | "headers" | "done" | "error";

/** Payload of the `mail:sync` event. */
export interface MailSyncEvent {
  account_id: string;
  folder_id?: string;
  phase: MailSyncPhase;
  new_messages?: number;
  error?: string;
}

/** Payload of the `mail:new` event (inbox only). */
export interface MailNewEvent {
  account_id: string;
  folder_id: string;
  count: number;
}

/** Bounded bytes for in-pane preview. Never written to disk by the previewer. */
export interface MailPreviewBlob {
  mime: string;
  bytes_b64: string;
  truncated: boolean;
}

// ── Local-model mail assistant (Group Q, #204–#208) ─────────────────────────
//
// The wire shapes the on-device model returns. Every one is produced by a
// **loopback-only** Ollama (`services/mail_ai.rs`) and parsed defensively in
// Rust: a low-confidence or unparseable extraction comes back as `null`, never
// as a malformed struct — the frontend reads `null` as "nothing to create".

/**
 * A calendar event the model read out of a message (#207).
 *
 * `start`/`end` are **local wall-clock ISO** with no zone (`2026-08-04T15:00`),
 * matching `lib/calendar/calendarTime`'s stamps, so they prefill `EventDialog` directly.
 * `confidence` is the model's own 0..1 estimate; the backend has already applied
 * its floor (a value below it yields `null` rather than a low-confidence event),
 * and the field is carried only so the review UI can note it.
 */
export interface MailExtractedEvent {
  title: string;
  start: string;
  end?: string | null;
  all_day: boolean;
  location?: string | null;
  confidence: number;
}

/** A to-do the model read out of a message (#208). `due` is an ISO date;
 *  `priority` matches the board's priority vocabulary. Reused through
 *  `taskFromMail` so an AI card is the same kind of card as a hand-made one. */
export interface MailExtractedTask {
  title: string;
  due?: string | null;
  priority?: string | null;
}

/**
 * What the manual "what would the local model catch" pass found (#205).
 *
 * **Deliberately a different shape from {@link MailFilterReport}** — the schema
 * doc forbids a model classifier from masquerading as a keyword rule, so its
 * report is source-labelled (`source: "model"`) and never reuses the filter
 * report's fields. `dry_run` is always true from the preview button; the same
 * command applies for real when it is false.
 */
export interface MailAiClassifyReport {
  source: "model";
  scanned: number;
  matched: Array<{ message_id: string; priority: string; reason: string }>;
  dry_run: boolean;
}

// ── Address book ─────────────────────────────────────────────────────────────

/** Thunderbird's two built-in books: `personal` is curated by the user,
 *  `collected` is filled from sent mail. */
export type MailContactBook = "personal" | "collected";

export interface MailContactPhone {
  /** `mobile` | `work` | `home` | `fax` | `pager` | "" — free text on import. */
  kind: string;
  number: string;
}

/**
 * One address-book card. `emails` are bare addr-specs the backend validated
 * with the composer's own recipient check; the first is the primary one.
 * `popularity` / `last_used` are the backend's (bumped on each send), never
 * the editor's.
 */
export interface MailContact {
  id: string;
  book: MailContactBook;
  display_name: string;
  first_name: string;
  last_name: string;
  nickname: string;
  emails: string[];
  phones: MailContactPhone[];
  organization: string;
  job_title: string;
  address: string;
  website: string;
  /** `YYYY-MM-DD`, or `--MM-DD` without a year. */
  birthday: string;
  notes: string;
  popularity: number;
  last_used: number;
  created: number;
  updated: number;
}

/** A mailing list: a name that expands to its member addresses. */
export interface MailContactList {
  id: string;
  name: string;
  nickname: string;
  description: string;
  members: string[];
}

export interface MailContactsView {
  contacts: MailContact[];
  lists: MailContactList[];
  /** Add outgoing addresses no card holds to the Collected book. */
  collect_outgoing: boolean;
}

export interface MailContactsImportReport {
  cancelled: boolean;
  added: number;
  merged: number;
  skipped: number;
  /** Mailing lists added or extended (Thunderbird imports only). */
  lists: number;
}
