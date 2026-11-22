import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon, InboxIcon, MailIcon, OutboxIcon, PaperclipIcon, TrashIcon, WarningIcon } from "../../../src/components/common/icons/Icon";
import { ArchiveIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, InfoIcon, PencilIcon, StarIcon, UndoIcon } from "../glyphs";
import { describeFailure } from "../connection";
import {
  MAIL_MESSAGE_TIMEOUT,
  MAIL_REPLY_TIMEOUT,
  api,
  reloadIfApplied,
  wasApplied,
  type MailMarkAction,
  type MobileMailAccount,
  type MobileMailFolder,
  type MobileMailHeader,
  type MobileMailView,
  type MobileMailWrites,
} from "../api";
import { readChoice, writeChoice } from "../prefs";
import { goBack as stepBack, useBackLayer } from "../backStack";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { chatDayKey, chatDayLabel, chatMoment } from "../terminal/chatTimes";
import { isUntested } from "../../../src/lib/untested";
import { formatBytes } from "../../../src/lib/formatBytes";
import { dateLocale, useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";
import { HintQueue, type HintKey } from "../components/HintMessage";
import { OptionSheet, type SheetOption } from "../components/OptionSheet";
import { ScreenHead } from "../components/ScreenHead";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

const PAGE_SIZE = 25;
const FORMAT_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function safeText(value: string) {
  return value.replace(FORMAT_CONTROLS, "");
}

function sender(message: MobileMailHeader, t: Translate) {
  const name = safeText(message.sender.name ?? "").trim();
  return name || safeText(message.sender.address) || t("mobile.mail.unknownSender");
}

function dateLabel(value: string, lang: Language) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleString(lang);
}

/** A list row's time: today's as a clock, an older one as a short date. The
 * full stamp stays in the element's `title`. */
function listTime(value: string, lang: Language, today: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safeText(value);
  return chatDayKey(date) === today
    ? date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(lang, { day: "numeric", month: "short" });
}

function groupMessagesByDate(messages: MobileMailHeader[], now: Date, t: Translate) {
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const dayLabels = { today: t("mobile.mail.today"), yesterday: t("mobile.mail.yesterday") };
  const groups = new Map<string, { label: string; messages: MobileMailHeader[] }>();
  for (const item of messages) {
    const day = chatMoment(item.date);
    const byMonth = day !== null && day < weekAgo;
    const key = day ? (byMonth ? `${day.getFullYear()}-${day.getMonth() + 1}` : chatDayKey(day)) : "";
    const group = groups.get(key);
    if (group) group.messages.push(item);
    else {
      const label = day
        ? (byMonth ? day.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" }) : chatDayLabel(day, now, dayLabels))
        : t("mobile.mail.unknownDate");
      groups.set(key, { label, messages: [item] });
    }
  }
  return Array.from(groups);
}

/** One or two capitals for the sender tile. */
function initials(label: string) {
  const words = label.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase() || "?";
}

/** Longest reply the sidecar accepts (`protocol::MAX_MAIL_REPLY_BYTES`). */
const MAX_REPLY_BYTES = 16 * 1024;

function replyBytes(text: string) {
  return new TextEncoder().encode(text).length;
}

/** A refusal in the reader's words — never the code (`connection.ts`). */
const writeError = describeFailure;

/** Where a folder sits in the pickers: the inbox first, the bins last, and
 * folders of one kind in the order the desktop sent them (the sort is stable). */
const KIND_ORDER = ["inbox", "drafts", "sent", "archive", "other", "junk", "trash"];
const KIND_GLYPH: Record<string, ReactNode> = { inbox: <InboxIcon />, drafts: <PencilIcon />, sent: <OutboxIcon />, archive: <ArchiveIcon />, junk: <WarningIcon />, trash: <TrashIcon /> };

function kindRank(kind: string) {
  const at = KIND_ORDER.indexOf(kind);
  return at < 0 ? KIND_ORDER.indexOf("other") : at;
}

function sortedFolders(folders: MobileMailFolder[]) {
  return [...folders].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

/** The folder an account opens on when it is picked from inside a folder. */
function homeFolder(account: MobileMailAccount): MobileMailFolder | undefined {
  return account.folders.find((item) => item.kind === "inbox") ?? sortedFolders(account.folders)[0];
}

/** An account's entry in the picker carries its inbox's unread count — the one
 * number that says whether switching to it is worth the tap. Junk and trash
 * unread counts would only be noise there. */
function accountOption(account: MobileMailAccount, t: Translate) {
  const unread = account.folders.filter((item) => item.kind === "inbox").reduce((sum, item) => sum + item.unread, 0);
  return `${safeText(account.label) || safeText(account.address)}${unread > 0 ? ` · ${t("mobile.mail.unreadCount", { count: unread })}` : ""}`;
}

const isAccountId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The mail screen's tips, each its own card, one at a time (`HintQueue`). */
const MAIL_TIPS: readonly HintKey[] = ["mailBack", "mailPickers", "mailWrite"];

export function Mail() {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const [accounts, setAccounts] = useState<MobileMailAccount[] | null>(null);
  const [folder, setFolder] = useState<Extract<MobileMailView, { view: "folder" }> | null>(null);
  const [message, setMessage] = useState<Extract<MobileMailView, { view: "message" }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [writes, setWrites] = useState<MobileMailWrites>({});
  const [reply, setReply] = useState("");
  const [confirmReply, setConfirmReply] = useState(false);
  const [sent, setSent] = useState(false);
  const [sheet, setSheet] = useState<"info" | "switch" | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  // The account the tab shows, remembered on this phone. A stored id the
  // desktop no longer lists falls back to its first account.
  const [accountId, setAccountId] = useState(() => readChoice("mailAccount", isAccountId, ""));
  const account = accounts?.find((item) => item.id === accountId) ?? accounts?.[0] ?? null;
  // An open folder belongs to the account that lists it, whatever is picked.
  const folderAccount = (folder && accounts?.find((item) => item.folders.some((entry) => entry.id === folder.folder.id))) || account;

  const loadOverview = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>("/api/v1/mail");
      if (mail.view !== "overview") throw new Error("unexpected_mail_view");
      setAccounts(mail.accounts); setFolder(null); setMessage(null);
      setWrites({ actions: mail.actions === true, reply: mail.reply === true });
    } catch (reason) {
      setError(writeError(reason));
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const loadFolder = async (target: MobileMailFolder, offset = 0) => {
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(target.id)}?offset=${offset}`);
      if (mail.view !== "folder") throw new Error("unexpected_mail_view");
      takeFolder(mail); setMessage(null);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  const loadMessage = async (target: MobileMailHeader) => {
    if (!folder) return;
    setBusy(true); setError("");
    try {
      const { mail } = await api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(target.id)}?offset=${folder.offset}`, undefined, MAIL_MESSAGE_TIMEOUT);
      if (mail.view !== "message") throw new Error("unexpected_mail_view");
      setMessage(mail); setReply(""); setConfirmReply(false); setSent(false);
      // The desktop marked it read on the way (when the phone's mail actions
      // are on): the list and the counts follow its answer, not a re-read.
      if (mail.message.seen && !target.seen) {
        const unread = Math.max(0, folder.folder.unread - 1);
        takeFolder({
          ...folder,
          folder: { ...folder.folder, unread },
          messages: folder.messages.map((item) => item.id === target.id ? { ...item, seen: true } : item),
        });
      }
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  /** A folder page carries the folder's own fresh counts; they replace the
   * overview's copy, so the pickers and the way back show what was just read. */
  const takeFolder = useCallback((page: Extract<MobileMailView, { view: "folder" }>) => {
    setFolder(page);
    setAccounts((current) => current?.map((item) => ({
      ...item,
      folders: item.folders.map((entry) => entry.id === page.folder.id ? page.folder : entry),
    })) ?? current);
  }, []);

  // Opening a folder makes the desktop fetch it from the server; a page that
  // came back before that fetch finished says `syncing`, so ask again quietly
  // until it is done. Another folder, a refresh or the way back cancels it.
  useEffect(() => {
    if (!folder?.syncing) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}?offset=${folder.offset}`)
        .then(({ mail }) => { if (!cancelled && mail.view === "folder") takeFolder(mail); })
        .catch(() => { if (!cancelled) setFolder((current) => current && { ...current, syncing: false }); });
    }, 1_500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [folder, takeFolder]);

  /** Picking an account from inside a folder opens that account's inbox; from
   * the overview it only changes whose folders are listed. */
  const chooseAccount = (id: string) => {
    setAccountId(id); writeChoice("mailAccount", id);
    if (!folder) return;
    const next = accounts?.find((item) => item.id === id);
    const target = next && homeFolder(next);
    if (target) void loadFolder(target);
    else setFolder(null);
  };

  /** The sheet behind the line under the title: from inside a folder it lists
   * that account's folders, then the other accounts; from the overview, the
   * accounts. */
  const switchOptions: SheetOption[] = [];
  if (folder && folderAccount) {
    for (const item of sortedFolders(folderAccount.folders)) {
      switchOptions.push({
        key: `folder:${item.id}`, label: safeText(item.name), group: t("mobile.mail.folder"),
        current: item.id === folder.folder.id, icon: KIND_GLYPH[item.kind] ?? <FolderIcon />,
        trailing: item.unread > 0 ? item.unread : undefined,
      });
    }
  }
  for (const item of accounts ?? []) {
    if (folder && item.id === folderAccount?.id) continue;
    switchOptions.push({
      key: `account:${item.id}`, label: accountOption(item, t), group: folder ? t("mobile.mail.accountLabel") : undefined,
      current: !folder && item.id === account?.id,
    });
  }
  const pickSwitch = (key: string) => {
    setSheet(null);
    const at = key.indexOf(":");
    const id = key.slice(at + 1);
    if (key.slice(0, at) === "account") { chooseAccount(id); return; }
    const target = folderAccount?.folders.find((item) => item.id === id);
    if (target && target.id !== folder?.folder.id) void loadFolder(target);
  };
  const subjectAccount = folder ? folderAccount : account;
  const switchable = folder ? folderAccount !== null : (accounts?.length ?? 0) > 1;
  const subtitle = message || !subjectAccount ? undefined : switchable
    ? <button className="mail-account-switch" onClick={() => setSheet("switch")} aria-haspopup="dialog" aria-label={`${t("mail.switchAccount")}: ${accountOption(subjectAccount, t)}`}>
      {accountOption(subjectAccount, t)}<ChevronDownIcon size="1em" />
      {isUntested("mobile.mail.accountPicker") && <span className="untested">{t("mobile.newTab.untested")}</span>}
    </button>
    : accountOption(subjectAccount, t);
  // The banner's sentences, kept: they now sit behind the head's ⓘ.
  const notice = writes.actions || writes.reply
    ? [
      t("mobile.mail.noticeWrites"),
      writes.actions ? t("mobile.mail.noticeActions") : "",
      writes.reply ? t("mobile.mail.noticeReply") : "",
      t("mobile.mail.noticeLimits"),
    ].filter(Boolean).join(" ")
    : t("mobile.mail.noticeReadOnly");

  /** Both writes answer with the refreshed folder page, so the list and the
   * open message's own header are updated from the desktop's answer rather
   * than from what the phone hoped happened. */
  const absorbPage = (page: MobileMailView) => {
    if (page.view !== "folder") throw new Error("unexpected_mail_view");
    takeFolder(page);
    setMessage((current) => {
      if (!current) return current;
      const updated = page.messages.find((item) => item.id === current.message.id);
      return updated ? { ...current, message: updated } : current;
    });
  };

  /** The folder page a write answers with, read by its own route — for a
   * write the desktop made whose answer did not come back (`reloadIfApplied`). */
  const reloadPage = (page: { folder: MobileMailFolder; offset: number }) => () =>
    api<{ mail: MobileMailView }>(`/api/v1/mail/folders/${encodeURIComponent(page.folder.id)}?offset=${page.offset}`);

  const mark = async (action: MailMarkAction) => {
    if (!folder || !message) return;
    setBusy(true); setError("");
    try {
      const { mail } = await reloadIfApplied(api<{ mail: MobileMailView }>(
        `/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(message.message.id)}/mark`,
        { method: "POST", body: JSON.stringify({ action, offset: folder.offset }) },
        MAIL_MESSAGE_TIMEOUT,
      ), reloadPage(folder));
      absorbPage(mail);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  const refreshOpenMessage = async () => {
    if (!folder) return;
    setBusy(true); setError("");
    try {
      const { mail } = await reloadPage(folder)();
      absorbPage(mail);
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  const sendReply = async () => {
    if (!folder || !message) return;
    setBusy(true); setError(""); setConfirmReply(false);
    try {
      const { mail } = await reloadIfApplied(api<{ mail: MobileMailView }>(
        `/api/v1/mail/folders/${encodeURIComponent(folder.folder.id)}/messages/${encodeURIComponent(message.message.id)}/reply`,
        { method: "POST", body: JSON.stringify({ body: reply, offset: folder.offset }) },
        MAIL_REPLY_TIMEOUT,
      ), reloadPage(folder));
      absorbPage(mail);
      setReply(""); setSent(true);
    } catch (reason) {
      setError(writeError(reason));
      // Sent, only the folder page did not come back: the draft must not stay
      // in the box under a Send button.
      if (wasApplied(reason)) { setReply(""); setSent(true); }
    } finally { setBusy(false); }
  };

  // Mail is a tab now, so the chevron only ever walks its own stack: message →
  // folder → account list. At the root there is nothing above it to go back to.
  const goBack = message ? () => setMessage(null) : folder ? () => setFolder(null) : null;
  useBackLayer(goBack);
  // A right swipe walks the same stack, through Back's own path. Not from a
  // field (the reply box) — `installFocusSwipe` leaves those alone.
  const screen = useRef<HTMLElement | null>(null);
  const inStack = goBack !== null;
  useEffect(() => {
    const host = screen.current;
    if (!inStack || !host) return;
    return installFocusSwipe(host, { onSwipeRight: stepBack, onSwipeLeft: () => {} }, { ignore: ".sheet-backdrop, [role='dialog']" });
  }, [inStack]);
  // On an open message, Refresh re-reads its folder page, not the message:
  // opening it again would mark read what the user just marked unread, and
  // drop a reply being typed.
  const refresh = () => {
    if (message && folder) void refreshOpenMessage();
    else if (folder) void loadFolder(folder.folder, folder.offset);
    else void loadOverview();
  };

  const iconButton = (label: string, onClick: () => void, icon: ReactNode, extra: { className?: string; pressed?: boolean; disabled?: boolean } = {}) =>
    <button className={`home-head-button${extra.className ? ` ${extra.className}` : ""}`} aria-label={label} title={label} aria-pressed={extra.pressed} disabled={extra.disabled} onClick={onClick}>{icon}</button>;

  const folderRow = (item: MobileMailFolder) => <button className={`tool-row mail-mobile-folder${item.unread > 0 ? " has-unread" : ""}`} key={item.id} onClick={() => void loadFolder(item)} disabled={busy}
    aria-label={`${safeText(item.name)}, ${t("mobile.mail.folderCounts", { unread: item.unread, total: item.total })}`}>
    <i aria-hidden="true">{KIND_GLYPH[item.kind] ?? <FolderIcon />}</i>
    <span>{safeText(item.name)}</span>
    {item.unread > 0 && <b className="tool-badge">{item.unread}</b>}
    <small>{item.total}</small>
    <ChevronRightIcon className="mail-mobile-chevron" size="16px" />
  </button>;
  // Folders with nothing in them fold away; the inbox never does.
  const ordered = account ? sortedFolders(account.folders) : [];
  const emptyFolders = ordered.filter((item) => item.total === 0 && item.kind !== "inbox");
  const shownFolders = ordered.filter((item) => !emptyFolders.includes(item));

  const now = new Date();
  const messageGroups = folder && !message ? groupMessagesByDate(folder.messages, now, t) : [];
  const today = chatDayKey(now);

  const actions = <>
    {message && writes.actions && <>
      {iconButton(t(message.message.seen ? "mobile.mail.markUnread" : "mobile.mail.markRead"),
        () => void mark(message.message.seen ? "unseen" : "seen"), message.message.seen ? <MailIcon size="22px" /> : <CheckIcon size="22px" />, { disabled: busy })}
      {iconButton(t("mobile.mail.star"), () => void mark(message.message.flagged ? "unflag" : "flag"), <StarIcon size="22px" />,
        { className: "mail-mobile-star", pressed: message.message.flagged === true, disabled: busy })}
    </>}
    {iconButton(t("mobile.mail.info"), () => setSheet("info"), <InfoIcon size="22px" />)}
  </>;

  return <main ref={screen} className="screen mail-mobile-screen">
    <ScreenHead
      title={message ? safeText(message.message.subject) || t("mobile.mail.noSubject") : folder ? safeText(folder.folder.name) : t("mobile.mail.title")}
      subtitle={subtitle}
      back={goBack ? { label: message && folder ? safeText(folder.folder.name) : t("mobile.mail.title"), onClick: goBack } : undefined}
      actions={actions} compact={!!message}
      onRefresh={refresh} refreshing={busy} untested={isUntested("mobile.design.mail") || (folder !== null && !message && isUntested("mobile.mail.dateGroups"))} />
    <HintQueue hints={MAIL_TIPS} />
    {error && <p className="error">{error}</p>}
    {busy && !accounts && <p className="mail-mobile-empty">{t("common.loading")}</p>}

    {message ? <article className="mail-mobile-message">
      <div className="mail-mobile-message-meta">
        <i className="mail-mobile-avatar" aria-hidden="true">{initials(sender(message.message, t))}</i>
        <div>
          <strong>{sender(message.message, t)}</strong>
          <span>{safeText(message.message.sender.address)}</span>
          <time>{dateLabel(message.message.date, lang)}</time>
        </div>
      </div>
      {message.truncated && <p className="mail-mobile-warning">{t("mobile.mail.truncated")}</p>}
      <pre>{safeText(message.body) || t("mobile.mail.noBody")}</pre>
      {message.attachments.length > 0 && <section className="mail-mobile-attachments">
        <h2 className="tool-section-head">{t("mail.attachments")}</h2>
        <div className="tool-group">
          {message.attachments.map((attachment, index) => <div className="tool-row" key={`${attachment.filename}-${index}`}>
            <span>{safeText(attachment.filename)}</span><small>{safeText(attachment.mime)} · {formatBytes(attachment.size)}</small>
          </div>)}
        </div>
        <p className="mail-mobile-note">{t("mobile.mail.attachmentsDesktop")}</p>
      </section>}
      {writes.reply && <section className="mail-mobile-reply">
        <h2>{t("mail.composeReply")}</h2>
        <small>{t("mobile.mail.replyTo", { address: safeText(message.message.sender.address) })}</small>
        {sent && <p className="mail-mobile-sent">{t("mobile.mail.replySent")}</p>}
        <div className="mail-mobile-reply-field">
          <textarea
            aria-label={t("mobile.mail.replyText")}
            value={reply}
            disabled={busy}
            placeholder={t("mobile.mail.replyPlaceholder")}
            onChange={(event) => { setReply(event.target.value); setConfirmReply(false); setSent(false); }}
          />
          {!confirmReply && <button
            className="primary mail-mobile-send"
            aria-label={t("mobile.mail.sendReply")}
            title={t("mobile.mail.sendReply")}
            disabled={busy || !reply.trim() || replyBytes(reply) > MAX_REPLY_BYTES}
            onClick={() => setConfirmReply(true)}
          ><ArrowUpIcon size="20px" /></button>}
        </div>
        {confirmReply && <div className="mail-mobile-reply-confirm">
          <span>{t("mobile.mail.replyConfirm", { address: safeText(message.message.sender.address) })}</span>
          <div>
            <button className="primary" disabled={busy} onClick={() => void sendReply()}>{t("mobile.question.typeSend")}</button>
            <button disabled={busy} onClick={() => setConfirmReply(false)}>{t("common.cancel")}</button>
          </div>
        </div>}
        {replyBytes(reply) > MAX_REPLY_BYTES && <p className="mail-mobile-warning">{t("mobile.mail.replyTooLong")}</p>}
      </section>}
    </article> : folder ? <>
      {messageGroups.map(([key, { label, messages }]) => <section key={key}>
        <h2 className="tool-section-head">{label}</h2>
        <div className="tool-group">
          {messages.map((item) => <button className={`tool-row mail-mobile-row${item.seen ? "" : " unread"}${item.flagged ? " flagged" : ""}${item.answered ? " answered" : ""}`} key={item.id} onClick={() => void loadMessage(item)} disabled={busy}>
            <i className="mail-mobile-dot" aria-hidden="true" />
            <span className="mail-mobile-row-body">
              <span className="mail-mobile-row-top">
                <strong>{sender(item, t)}</strong>
                {item.answered && <UndoIcon className="mail-mobile-mark" size="14px" />}
                {item.flagged && <StarIcon className="mail-mobile-mark mail-mobile-flag" size="14px" />}
                {item.has_attachments && <PaperclipIcon className="mail-mobile-mark" size="14px" />}
                <time title={dateLabel(item.date, lang)}>{listTime(item.date, lang, today)}</time>
              </span>
              <b>{safeText(item.subject) || t("mobile.mail.noSubject")}</b>
              <span className="mail-mobile-preview">{safeText(item.preview)}</span>
            </span>
          </button>)}
        </div>
      </section>)}
      {folder.syncing
        ? <p className="mail-mobile-empty" role="status">{t("mobile.mail.syncing")}</p>
        : !busy && folder.messages.length === 0 && <p className="mail-mobile-empty">{t("mobile.mail.noMessages")}</p>}
      <div className="mail-mobile-pager">
        {iconButton(t("mobile.mail.previous"), () => void loadFolder(folder.folder, Math.max(0, folder.offset - PAGE_SIZE)), <ChevronLeftIcon size="22px" />, { disabled: busy || folder.offset === 0 })}
        <small>{t("mobile.mail.pageOf", { range: folder.total === 0 ? "0" : `${folder.offset + 1}–${Math.min(folder.offset + folder.messages.length, folder.total)}`, total: folder.total })}</small>
        {iconButton(t("common.next"), () => void loadFolder(folder.folder, folder.offset + PAGE_SIZE), <ChevronRightIcon size="22px" />, { disabled: busy || folder.offset + folder.messages.length >= folder.total })}
      </div>
    </> : accounts && <section className="mail-mobile-accounts">
      {account && <>
        <h2 className="tool-section-head">{t("mail.folders")}</h2>
        <div className="mail-mobile-folders tool-group">
          {shownFolders.map(folderRow)}
          {emptyFolders.length > 0 && <button className="tool-row mail-mobile-more" aria-expanded={showEmpty} onClick={() => setShowEmpty((open) => !open)}>
            <span>{t("mobile.mail.moreFolders")} · {t("mobile.mail.emptyFolders", { count: emptyFolders.length })}</span>
            <ChevronRightIcon className="mail-mobile-chevron" size="16px" />
          </button>}
          {showEmpty && emptyFolders.map(folderRow)}
        </div>
      </>}
      {accounts.length === 0 && <p className="mail-mobile-empty">{t("mobile.mail.noAccounts")}</p>}
    </section>}

    {sheet === "info" && <OptionSheet title={t("mobile.mail.infoTitle")} note={{ text: notice }} options={[]} waiting="" busy={false} onPick={() => {}} onClose={() => setSheet(null)} />}
    {sheet === "switch" && <OptionSheet title={t("mobile.mail.account")} options={switchOptions} waiting="" busy={busy} onPick={pickSwitch} onClose={() => setSheet(null)} />}
  </main>;
}
