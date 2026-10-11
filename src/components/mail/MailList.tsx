import { memo, useEffect, useRef, useState } from "react";
import {
  formatAddress,
  formatMailListDate,
  formatSize,
  senderColor,
  senderInitial,
  stripFormatControls,
} from "../../lib/mail";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { useI18nStore, useT } from "../../lib/i18n";
import { modifierLabel } from "../../lib/shortcuts/shortcuts";
import { useUse24h } from "../../lib/timeFormat";
import { UntestedTag } from "../common/UntestedTag";
import type { MailHeader, MailPriority, MailSort } from "../../types/mail";
import { PaperclipIcon } from "../common/icons/Icon";

/** One frozen instance, so a list without marks does not re-render on a new
 *  empty set each time. */
const EMPTY_MARKS: ReadonlySet<string> = new Set();

/**
 * The header list — the middle pane.
 *
 * Two rules from the threat model are enforced *here*, in the rendering, not in
 * a review comment:
 *
 *  - **The addr-spec is always shown** (T7). A display name is attacker-chosen
 *    text — `From: "support@bank.example" <a@evil.example>` renders in most
 *    clients as the bank — so the row prints the name *and* the address, never
 *    the name alone, and strips the bidi/format controls that would otherwise let
 *    a name reorder what is on screen.
 *  - **Every mail-derived string is a plain text node.** No
 *    `dangerouslySetInnerHTML` anywhere under this feature; the only place a
 *    message's own markup renders is the sandboxed iframe in `MailMessageView`.
 *
 * A message whose headers were malformed (duplicate `From:`, and the like) is
 * marked, because the backend refused to silently pick one of the values and the
 * UI must not undo that by showing the first.
 *
 * **Right-click files a message into Important or Urgent, or deletes it.** The
 * menu is the only way in, deliberately: marking is not a per-row button because
 * there are two marks plus an unmark, and three glyphs on every row would cost
 * more attention than the feature is worth on the rows nobody is filing. The menu
 * is portaled to `<body>` and positioned at the cursor — the pattern
 * `ProjectFilesView`'s type-tag menu uses — because this list scrolls and clips,
 * and an in-flow menu on the last visible row would open inside the overflow.
 *
 * **Right-clicking does not open the message.** It used to, so that the menu and
 * the message pane could not disagree about which mail was about to be filed —
 * but opening a message marks it read, downloads its body and (for the row the
 * user was only reaching for a menu on) undoes the one thing the unread pile is
 * for. The menu names what it will act on instead, and the right-clicked row is
 * *ticked* rather than opened, which is the same guarantee without the side
 * effects.
 *
 * **Several rows can be picked at once** — Ctrl-click to add one, Shift-click for
 * a range — and every menu action then applies to the whole set. The ticks are
 * the store's (`checkedIds`), not this component's, because the actions and the
 * confirmation that precedes a permanent delete live outside the list; what is
 * kept here is the *order* the rows are in, since only the rendered list knows
 * what a range covers.
 */
/** How a click adds to the tick marks — see `MailListProps.onCheck`. */
export type MailCheckMode = "only" | "toggle" | "range";

export interface MailListProps {
  headers: MailHeader[];
  selectedId: string | null;
  /** The rows ticked for a bulk action (`stores/mail`'s `checkedIds`). */
  checkedIds: string[];
  loading: boolean;
  /** A plain click or Enter: open the message in its own mail-window tab. */
  onOpen: (id: string) => void;
  /**
   * A row was picked for the bulk selection. `only` replaces the set (a plain
   * click, and a right-click on a row outside it), `toggle` adds or removes one
   * (Ctrl-click), `range` stretches from the anchor (Shift-click).
   *
   * `order` is the ids of the rows as rendered, which is what makes a range
   * meaningful: the store holds no order of its own — the backend does the
   * sorting — so the only honest answer to "everything between these two" comes
   * from the list that drew them.
   */
  onCheck: (header: MailHeader, mode: MailCheckMode, order: string[]) => void;
  onClearChecks: () => void;
  /**
   * Delete these messages. The list neither confirms nor decides where they go:
   * a delete is a move to Trash for some rows and permanent for others
   * (`planMailDelete`), and the sentence the user has to read before the
   * irreversible half belongs with the code that knows which is which.
   */
  onDelete: (headers: MailHeader[]) => void;
  /**
   * How a delete of these rows would split: how many move to a Trash folder and
   * how many leave the server for good. Only the caller can answer it — it needs
   * every account's folder list — and the menu needs the answer to *word* the
   * action, since "Move to Trash" and "Delete permanently" are not the same
   * promise and one right-click can cover both.
   */
  deletePlan: (headers: MailHeader[]) => { trashed: number; purged: number };
  onToggleFlag: (header: MailHeader) => void;
  /** Read ⇄ unread for one message. Opening a message already marks it read, so
   *  in practice this is the *un*-read direction: the way to put something back
   *  on the pile after looking at it, which nothing else here can do. */
  onToggleSeen: (header: MailHeader) => void;
  /** File a message under a mark, or with `null` take it off both lists. */
  onSetPriority: (header: MailHeader, priority: MailPriority | null) => void;
  /** The order the rows are already in, and which way round. Passed in rather
   *  than held here because the *store* applies it — see `onSort`. */
  sort: MailSort;
  sortDesc: boolean;
  /**
   * A header was clicked. The list decides the direction (same column ⇒ flip,
   * a new column ⇒ its own natural default) and the caller only forwards the
   * pair to the store.
   *
   * The list does not sort itself, and that is not a layering nicety: it is
   * handed **one page** of a folder, so ordering `headers` would order the
   * hundred rows on screen — the biggest message in a mailbox, or its one
   * starred mail, is rarely among the newest hundred. So the header row is a
   * *control*, and the sort happens in SQLite over the whole folder.
   */
  onSort: (sort: MailSort, desc: boolean) => void;
  /** Resolve a message's account to a label. Set only while the list is a
   *  cross-account priority list, where "which mailbox is this from" is a
   *  question the rail can no longer answer — in a folder it is already known
   *  and printing it on every row would be noise. */
  accountLabel?: (header: MailHeader) => string | undefined;
  /** Paging, rendered only when the folder has more than one page. */
  offset: number;
  pageSize: number;
  total: number;
  /**
   * Set only when a search over an **encrypted** store stopped early. `total`
   * then means "matches among the ones I looked at", which is a weaker claim
   * than usual and has to be visible — a truncated answer that looks complete
   * is the one thing a search must never produce.
   */
  scanned?: number;
  /**
   * Whether the search behind this page reached the server (`stores/mail`'s
   * `searchRemote`). While a query is active the list says which scope the
   * answer covers. `searchPartial` names server matches that could not all be
   * loaded; `searchRemote` distinguishes a server search from a local fallback.
   * Absent reads as local-only.
   */
  searchRemote?: boolean;
  /** Some server matches could not be loaded, including matches past the cap. */
  searchPartial?: boolean;
  onPage: (offset: number) => void;
  /**
   * Marks for agents (`docs/mail_mcp_plan.md` §1, "Marked mails only"). A mark
   * shares one message with a contained reader agent; it is local and never an
   * IMAP flag. `agentShareable` answers whether a row's account is open to a
   * reader at all — without it the group is not offered, since a mark on a
   * closed account would do nothing and look like it did. `onAgentOnly` is
   * passed only while the selected account is open, and brings the chip.
   */
  agentMarks?: ReadonlySet<string>;
  agentShareable?: (header: MailHeader) => boolean;
  onAgentMark?: (headers: MailHeader[], marked: boolean) => void;
  onAgentMarkSender?: (header: MailHeader) => void;
  onAgentMarkFolder?: () => void;
  agentOnly?: boolean;
  onAgentOnly?: (agentOnly: boolean) => void;
  /**
   * Everything that *narrows* the list, in one bar on the list itself: the
   * search and the unread filter. They used to sit at the far end of the pane's
   * toolbar, between the account verbs and the keyring — a row away from the
   * rows they hide. Both are the store's, applied by the backend over the whole
   * folder, so they survive a folder switch and the pager counts what is shown.
   */
  query: string;
  unreadOnly: boolean;
  onQuery: (query: string) => void;
  onUnreadOnly: (unreadOnly: boolean) => void;
  onClearFilters: () => void;
}

/** Where the context menu is, and which messages it is about. */
interface RowMenu {
  x: number;
  y: number;
  /** The row it was opened on — what the menu is *labelled* by. */
  header: MailHeader;
  /**
   * Every row it acts on: the whole ticked set when the right-clicked row was
   * part of it, otherwise just that row. Frozen at open time on purpose — the
   * menu must act on the set the label described, not on whatever the ticks
   * became while it was open.
   */
  targets: MailHeader[];
}

function MailListImpl({
  headers,
  selectedId,
  checkedIds,
  loading,
  onOpen,
  onCheck,
  onClearChecks,
  onDelete,
  deletePlan,
  onToggleFlag,
  onToggleSeen,
  onSetPriority,
  sort,
  sortDesc,
  onSort,
  accountLabel,
  offset,
  pageSize,
  total,
  scanned,
  searchRemote = false,
  searchPartial = false,
  onPage,
  query,
  unreadOnly,
  onQuery,
  onUnreadOnly,
  onClearFilters,
  agentMarks = EMPTY_MARKS,
  agentShareable = () => false,
  onAgentMark,
  onAgentMarkSender,
  onAgentMarkFolder,
  agentOnly = false,
  onAgentOnly,
}: MailListProps) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  // `offset > 0` as well: under the unread filter the set shrinks as it is
  // read, so a later page can be reached whose re-read total fits on one page —
  // and a pager that vanished there would leave no way back to "Newer".
  const filtered = unreadOnly || agentOnly || query.trim() !== "";
  const hasPaging = total > pageSize || offset > 0;
  // A pager step lands on the top of the new page. The buttons sit under the
  // rows, so without this "Older" opens the next hundred scrolled to their end.
  // Keyed on the offset alone: a re-read in place must not move the list.
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
  }, [offset]);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const checked = new Set(checkedIds);
  const order = headers.map((h) => h.id);
  /** How many of the ticked rows are on this page — the only ones an action can
   *  reach, and `loadPage` clears the set precisely so the two agree. */
  const checkedHere = headers.filter((h) => checked.has(h.id));

  /** The rows an action invoked on `header` is about: the ticked set when it is
   *  one of them, otherwise that row alone. */
  const targetsFor = (header: MailHeader) =>
    checked.has(header.id) && checkedHere.length > 1 ? checkedHere : [header];

  const file = (priority: MailPriority | null) => {
    if (!menu) return;
    for (const header of menu.targets) onSetPriority(header, priority);
    setMenu(null);
  };

  /**
   * One header control, positioned above the thing it orders.
   *
   * Clicking the column already sorted **flips** it; clicking another switches
   * to it descending — which is the useful end of every one of these columns
   * (starred first, attachments first, biggest first, newest first), so the
   * first click on a column is never the click that shows you the 400 mails
   * without a star.
   *
   * A plain function returning elements, deliberately **not** a component
   * declared inside this one: a nested component is a new type on every render,
   * so React would unmount and remount these buttons each time — and the render
   * that follows a header click is exactly the one that would then drop focus
   * from the button just pressed.
   */
  const sortHeader = ({
    field,
    label,
    title,
    className,
  }: {
    field: MailSort;
    label: React.ReactNode;
    title: string;
    className?: string;
  }) => {
    const active = sort === field;
    return (
      <button
        type="button"
        className={`mail-sort-header${active ? " active" : ""}${className ? ` ${className}` : ""}`}
        // The tooltip says what a click will *do*, not what the column is: on
        // the active column that is "reverse this", everywhere else "sort by
        // this" — which is the one thing a glyph-only header cannot say.
        title={active ? (sortDesc ? t("mail.sortDescending") : t("mail.sortAscending")) : title}
        aria-label={title}
        aria-pressed={active}
        onClick={() => onSort(field, active ? !sortDesc : true)}
      >
        <span className="mail-sort-header-label">{label}</span>
        {/* The arrow marks the sorted column and nothing else — an arrow on
            every header would make all four look equally sorted. */}
        {active && <span className="mail-sort-arrow">{sortDesc ? "▼" : "▲"}</span>}
      </button>
    );
  };

  return (
    <div className="mail-list mail-list-full">
      <div className="mail-list-filter" role="search">
        <input
          className="mail-input mail-search"
          type="search"
          placeholder={t("mail.searchPlaceholder")}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <button
          type="button"
          className={`settings-btn sm${unreadOnly ? " primary" : ""}`}
          aria-pressed={unreadOnly}
          title={t("mail.unreadOnlyTitle")}
          onClick={() => onUnreadOnly(!unreadOnly)}
        >
          {t("mail.unreadOnly")}
        </button>
        {onAgentOnly && (
          <button
            type="button"
            className={`settings-btn sm untested${agentOnly ? " primary" : ""}`}
            aria-pressed={agentOnly}
            title={t("mail.agentOnlyTitle")}
            onClick={() => onAgentOnly(!agentOnly)}
          >
            {t("mail.agentOnly")}
            <UntestedTag id="mailList.11" />
          </button>
        )}
        {/* Only while something is narrowing the list: the way back to the whole
            folder in one click, whichever of the filters is hiding mail. */}
        {filtered && (
          <button
            type="button"
            className="settings-btn sm"
            title={t("mail.clearFilters")}
            aria-label={t("mail.clearFilters")}
            onClick={onClearFilters}
          >
            ✕
          </button>
        )}
      </div>
      {/* The sort lives on the list, each control sitting above the column it
          orders — the star over the stars, the clip over the clips — so the
          order is read off the rows rather than off a dropdown elsewhere. The
          sender column is deliberately NOT a control: `from` is stored as JSON,
          so ordering by it would sort by `{"name":…` rather than by anyone's
          name, and a header that sorted wrongly is worse than one that does
          not sort. */}
      <div className="mail-list-sort" role="group" aria-label={t("mail.sortBy")}>
        {sortHeader({ field: "flagged", label: "★", title: t("mail.sortFlagged") })}
        {/* The read/unread column has no header control: there is no unread
            sort, and a dead label above a live column reads as one that failed
            rather than one that was never offered. The cell is still *there*,
            because the header only aligns with the rows if it has a cell per
            column. */}
        <span className="mail-sort-spacer" aria-hidden="true" />
        {sortHeader({ field: "attachments", label: <PaperclipIcon />, title: t("mail.sortAttachments") })}
        {/* Above the sender badges: nothing to sort, the cell keeps the grid. */}
        <span className="mail-sort-spacer" aria-hidden="true" />
        <span className="mail-sort-from">
          {t("mail.sortFrom")}
          {/* For the per-row ✕ at the far end: a pill in a 14px column on every
              row would bury the list, so it is said once, up here. */}
          <UntestedTag id="mailList.1" />
        </span>
        {sortHeader({
          field: "size",
          label: t("mail.sortSize"),
          title: t("mail.sortSize"),
          className: "numeric",
        })}
        {sortHeader({
          field: "date",
          label: t("mail.sortDate"),
          title: t("mail.sortDate"),
          className: "numeric",
        })}
        {/* The delete column has nothing to sort; the cell keeps the grid. */}
        <span className="mail-sort-spacer" aria-hidden="true" />
      </div>
      {loading && headers.length === 0 && <div className="mail-empty">{t("mail.loading")}</div>}
      {!loading && headers.length === 0 && (
        // An empty *filter* is not an empty folder, and must not read as one.
        <div className="mail-empty">{t(filtered ? "mail.noMatches" : "mail.noMessages")}</div>
      )}
      {/* Only once more than one row is ticked: a single tick is what an
          ordinary click already leaves behind, and a strip appearing on every
          click would push the list down on each one. It says the count rather
          than naming anything, because that is the number the menu's actions
          are about. */}
      {checkedHere.length > 1 && (
        <div className="mail-list-selection">
          <span>
            {t("mail.selectedCount", { count: checkedHere.length })}
            {/* The gesture's one visible surface, so the pill goes here rather
                than on every row. */}
            <UntestedTag id="mailList.2" />
          </span>
          <button type="button" className="mail-selection-clear" onClick={onClearChecks}>
            {t("mail.clearSelection")}
          </button>
        </div>
      )}
      <div className="mail-list-rows" ref={rowsRef}>
        {headers.map((h) => (
          <div
            key={h.id}
            className={`mail-row mail-msg-row${h.id === selectedId ? " selected" : ""}${
              checked.has(h.id) ? " checked" : ""
            }${h.seen ? "" : " unread"}`}
            role="button"
            tabIndex={0}
            title={t("mail.selectHint", { modifier: modifierLabel() })}
            onClick={(e) => {
              // A modified click picks rows and deliberately opens nothing:
              // building a selection of ten messages must not fetch ten bodies
              // and mark ten of them read on the way. `preventDefault` because
              // Shift-click is also the browser's own text-range gesture.
              if (e.shiftKey) {
                e.preventDefault();
                onCheck(h, "range", order);
                return;
              }
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                onCheck(h, "toggle", order);
                return;
              }
              // A plain click is both: open this message in its tab, and make it
              // the whole selection — so the ticks never survive as an invisible
              // set that the next right-click would act on.
              onCheck(h, "only", order);
              onOpen(h.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCheck(h, "only", order);
                onOpen(h.id);
                return;
              }
              if (e.key === "Delete") {
                e.preventDefault();
                onDelete(targetsFor(h));
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Tick the row rather than open it (see the module header), and
              // only when it is not already part of the selection — otherwise a
              // right-click inside a set of ten would throw nine of them away
              // and act on the one under the cursor.
              if (!checked.has(h.id)) onCheck(h, "only", order);
              setMenu({ x: e.clientX, y: e.clientY, header: h, targets: targetsFor(h) });
            }}
          >
            <div className="mail-row-top">
              <button
                type="button"
                className={`mail-flag-btn${h.flagged ? " on" : ""}`}
                title={h.flagged ? t("mail.unflag") : t("mail.flag")}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFlag(h);
                }}
              >
                {h.flagged ? "★" : "☆"}
              </button>
              {/* Beside the star because it is the same kind of control — a
                  per-message state toggled in place — and `stopPropagation` for
                  the same reason: the row itself opens the message, and opening
                  it marks it read, which would undo the click that was just
                  made. A filled dot is unread, a hollow one read; the glyph
                  matches the row's own unread emphasis rather than adding a
                  second vocabulary. */}
              <button
                type="button"
                className={`mail-seen-btn${h.seen ? "" : " on"}`}
                title={h.seen ? t("mail.markUnread") : t("mail.markRead")}
                aria-label={h.seen ? t("mail.markUnread") : t("mail.markRead")}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSeen(h);
                }}
              >
                {h.seen ? "○" : "●"}
              </button>
              {/* The clip is a **column**, not a glyph in front of the subject:
                  it sits under its own header, in the same place on every row,
                  which is what lets the eye run down it — and an empty cell is
                  still rendered, because a marker that shifts the subject left
                  when it is absent is a column in name only. */}
              <span className="mail-row-clip" title={h.has_attachments ? t("mail.hasAttachments") : undefined}>
                {h.has_attachments ? <PaperclipIcon /> : null}
              </span>
              {/* Who it is from, recognised by colour before it is read: a
                  run of mail from one sender is one colour down the list. The
                  colour comes from the address, not the name (`senderColor`),
                  so a spoofed name still wears a stranger's colour. */}
              <span
                className="mail-row-badge"
                aria-hidden="true"
                style={{ "--sender-color": senderColor(h.from.address) } as React.CSSProperties}
              >
                {senderInitial(h.from)}
              </span>
              {/* Name and addr-spec as two spans — the name carries the row,
                  the address sits quieter beside it — but both are always
                  printed (T7). Same rule as `formatAddress`: a name equal to
                  the address, or none, prints the address once. A name with an
                  `@` in it is posing as an address, so the real one is not
                  quietened beside it. */}
              {(() => {
                const name = stripFormatControls(h.from.name ?? "").trim();
                const address = stripFormatControls(h.from.address);
                const named = name !== "" && name !== h.from.address;
                return (
                  <span className="mail-row-from" title={formatAddress(h.from)}>
                    <span className="mail-row-from-name">{named ? name : address}</span>
                    {named && (
                      <span className={`mail-row-from-addr${name.includes("@") ? " loud" : ""}`}>
                        {`<${address}>`}
                      </span>
                    )}
                  </span>
                );
              })()}
              {/* Always printed, not only while sorted by size: a column that
                  appears with its sort would move every other column sideways
                  on the click that selected it. */}
              <span className="mail-row-size">{formatSize(h.size)}</span>
              <span className="mail-row-date">{formatMailListDate(h.date, lang, use24h)}</span>
              {/* This row only, never the ticked set: a glyph on a row that
                  quietly acted on nine others would be a trap. It goes through
                  the same `onDelete` as the menu, so the permanent half still
                  gets its confirmation; the tooltip says which half this is. */}
              {(() => {
                const label =
                  deletePlan([h]).purged > 0 ? t("mail.deleteForever") : t("mail.moveToTrash");
                return (
                  <button
                    type="button"
                    className="mail-delete-btn"
                    title={label}
                    aria-label={label}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete([h]);
                    }}
                  >
                    ×
                  </button>
                );
              })()}
            </div>
            <div className="mail-row-subject">
              {/* The mark is shown on the row wherever the row is — in its own
                  folder as much as in the Important list — because that is the
                  only place the user can see that filing it *worked*. In the
                  list itself it is not redundant either: it is what distinguishes
                  the two lists' rows if both are ever shown together. It stays
                  with the subject rather than becoming a column of its own: it
                  is present on a handful of rows by design, so a column for it
                  would be empty space on every other one. */}
              {h.priority && (
                <span
                  className={`mail-row-priority ${h.priority}`}
                  title={t(
                    h.priority === "urgent" ? "mail.markedUrgent" : "mail.markedImportant",
                  )}
                >
                  {h.priority === "urgent" ? "!!" : "!"}
                </span>
              )}
              {/* Shared with a reader agent: shown for the priority mark's
                  reason — the row is the one place the user sees that the
                  share holds, and that it is gone once withdrawn. */}
              {agentMarks.has(h.id) && agentShareable(h) && (
                <span className="mail-row-agent" title={t("mail.sharedWithAgents")}>
                  ⚿
                </span>
              )}
              {stripFormatControls(h.subject) || t("mail.noSubject")}
            </div>
            {h.preview && (
              <div className="mail-row-preview">{stripFormatControls(h.preview)}</div>
            )}
            {/* Which mailbox this arrived in — only in a cross-account list,
                where the rail no longer answers it. An unresolvable account (one
                deleted since the mark was made) prints nothing rather than an
                id: an opaque uuid on a row says less than an empty space. */}
            {accountLabel?.(h) && (
              <div className="mail-row-account">{accountLabel(h)}</div>
            )}
            {!!h.malformed_headers?.length && (
              <div className="mail-row-warning">{t("mail.malformedHeaders")}</div>
            )}
          </div>
        ))}
      </div>
      {scanned !== undefined && (
        <div className="mail-note mail-list-scan-note">
          {t("mail.searchScanned", { count: scanned })}
        </div>
      )}
      {/* While a query is narrowing the list: which scope the answer covers.
          A folder search asks the whole mailbox on the server first — but only
          when it can reach one, so a local-only answer has to say so rather
          than read as the whole folder. */}
      {query.trim() !== "" && !loading && (
        <div className="mail-note mail-list-scan-note untested">
          {t(!searchRemote ? "mail.searchLocal" : searchPartial ? "mail.searchPartial" : "mail.searchRemote")}
          <UntestedTag id="mailList.12" />
        </div>
      )}
      {hasPaging && (
        <div className="mail-list-paging">
          <button
            type="button"
            className="settings-btn"
            disabled={offset <= 0}
            onClick={() => onPage(Math.max(0, offset - pageSize))}
          >
            {t("mail.pagePrev")}
          </button>
          <span className="mail-paging-range">
            {t("mail.pageRange", {
              from: total === 0 ? 0 : offset + 1,
              to: Math.min(offset + pageSize, total),
              total,
            })}
          </span>
          <button
            type="button"
            className="settings-btn"
            disabled={offset + pageSize >= total}
            onClick={() => onPage(offset + pageSize)}
          >
            {t("mail.pageNext")}
          </button>
        </div>
      )}

      {menu && (
          <ContextMenuPortal x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              <div className="context-menu-group">
                {/* The subject, so the menu names what it is about. Truncated by
                    CSS, stripped of format controls like every other place a
                    subject is printed — a menu label is as attacker-reachable as
                    a row is. */}
                <div className="context-menu-group-label context-menu-quote">
                  {menu.targets.length > 1
                    ? t("mail.selectedCount", { count: menu.targets.length })
                    : stripFormatControls(menu.header.subject) || t("mail.noSubject")}
                </div>
                {/* Both marks are always offered, including the one the message
                    already carries — as a *disabled* row rather than a hidden
                    one, so the menu's shape does not shift under the cursor and
                    the current state is legible from the menu itself. */}
                {/* `every`/`some` over the targets rather than the row under the
                    cursor: with ten rows ticked, "already Important" is only
                    true — and the row only useless — when it holds for all of
                    them. */}
                <button
                  className="untested"
                  disabled={menu.targets.every((h) => h.priority === "important")}
                  onClick={() => file("important")}
                >
                  {t("mail.moveToImportant")}
                  <UntestedTag id="mailList.3" />
                </button>
                <button
                  className="untested"
                  disabled={menu.targets.every((h) => h.priority === "urgent")}
                  onClick={() => file("urgent")}
                >
                  {t("mail.moveToUrgent")}
                  <UntestedTag id="mailList.4" />
                </button>
                {menu.targets.some((h) => h.priority) && (
                  <button className="untested" onClick={() => file(null)}>
                    {t("mail.removeFromPriority")}
                    <UntestedTag id="mailList.5" />
                  </button>
                )}
                {/* Says what filing does NOT do, at the one moment the user is
                    deciding to do it. "Move to" is the verb every mail client
                    uses and the one that was asked for, but nothing here leaves
                    the folder it is in — and a user who believed otherwise would
                    go looking for the message on the server and not find it
                    moved. */}
                <div className="context-menu-note">{t("mail.priorityIsLocal")}</div>
              </div>
              {/* Sharing with a contained reader agent — only for rows whose
                  account is open to one (see `agentShareable`). "Share" and
                  "Stop sharing" follow the priority rows' shape: the state the
                  targets already have is a disabled row, not a hidden one. The
                  bulk forms are one step wider each, so the reach of a click is
                  always named on the row that makes it. */}
              {onAgentMark && menu.targets.every(agentShareable) && (
                <div className="context-menu-group">
                  <button
                    className="untested"
                    disabled={menu.targets.every((h) => agentMarks.has(h.id))}
                    onClick={() => {
                      onAgentMark(menu.targets, true);
                      setMenu(null);
                    }}
                  >
                    {t("mail.shareWithAgents")}
                    <UntestedTag id="mailList.7" />
                  </button>
                  {menu.targets.some((h) => agentMarks.has(h.id)) && (
                    <button
                      className="untested"
                      onClick={() => {
                        onAgentMark(menu.targets, false);
                        setMenu(null);
                      }}
                    >
                      {t("mail.stopSharingWithAgents")}
                      <UntestedTag id="mailList.8" />
                    </button>
                  )}
                  {menu.targets.length === 1 && onAgentMarkSender && (
                    <button
                      className="untested"
                      onClick={() => {
                        onAgentMarkSender(menu.header);
                        setMenu(null);
                      }}
                    >
                      {t("mail.shareAllFromSender", {
                        address: stripFormatControls(menu.header.from.address),
                      })}
                      <UntestedTag id="mailList.9" />
                    </button>
                  )}
                  {onAgentMarkFolder && (
                    <button
                      className="untested"
                      onClick={() => {
                        onAgentMarkFolder();
                        setMenu(null);
                      }}
                    >
                      {t("mail.shareWholeFolder")}
                      <UntestedTag id="mailList.10" />
                    </button>
                  )}
                  <div className="context-menu-note">{t("mail.shareWithAgentsNote")}</div>
                </div>
              )}
              {/* Its own group, below the divider: everything above files a
                  message and leaves it where it is, while this one moves it off
                  the folder — or off the server. */}
              {(() => {
                const plan = deletePlan(menu.targets);
                const mixed = plan.trashed > 0 && plan.purged > 0;
                return (
                  // The red fence is the app's treatment for a destructive
                  // action and is used here for exactly the case that is one:
                  // a delete that cannot be taken back. A move to Trash is
                  // recoverable on the server, so it stays an ordinary group —
                  // the colour means something only while it is not on every
                  // delete.
                  <div
                    className={
                      plan.purged > 0 ? "context-menu-danger-zone" : "context-menu-group"
                    }
                  >
                    <button
                      className="untested"
                      onClick={() => {
                        onDelete(menu.targets);
                        setMenu(null);
                      }}
                    >
                      {mixed
                        ? t("mail.deleteMixed", { count: menu.targets.length })
                        : plan.purged > 0
                          ? t("mail.deleteForever")
                          : t("mail.moveToTrash")}
                      <UntestedTag id="mailList.6" />
                    </button>
                    {/* Where the mail goes, said before the click rather than
                        afterwards: "delete" means two different things here and
                        only one of them can be taken back. */}
                    <div className="context-menu-note">
                      {mixed
                        ? t("mail.deleteMixedNote", { count: plan.purged })
                        : plan.purged > 0
                          ? t("mail.deleteIsForever")
                          : t("mail.deleteGoesToTrash")}
                    </div>
                  </div>
                );
              })()}
          </ContextMenuPortal>
        )}
    </div>
  );
}

export const MailList = memo(MailListImpl);
