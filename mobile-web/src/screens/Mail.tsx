import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArchiveIcon, FolderIcon, InboxIcon, OutboxIcon, PaperclipIcon, PencilIcon, TrashIcon, WarningIcon } from "../../../src/components/common/icons/Icon";
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
import { isUntested } from "../../../src/lib/untested";
import { useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";

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

/** Longest reply the sidecar accepts (`protocol::MAX_MAIL_REPLY_BYTES`). */
const MAX_REPLY_BYTES = 16 * 1024;

function replyBytes(text: string) {
  return new TextEncoder().encode(text).length;
}

/** A refusal in the reader's words — never the code (`connection.ts`). */
const writeError = describeFailure;

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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
    } catch (reason) { setError(writeError(reason)); } finally { setBusy(false); }
  };

  /** A folder page carries the folder's own fresh counts; they replace the
   * overview's copy, so the pickers and the way back show what was just read. */
  const takeFolder = (page: Extract<MobileMailView, { view: "folder" }>) => {
    setFolder(page);
    setAccounts((current) => current?.map((item) => ({
      ...item,
      folders: item.folders.map((entry) => entry.id === page.folder.id ? page.folder : entry),
    })) ?? current);
  };

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

  const accountPicker = accounts && accounts.length > 1 && <select
    className="mail-mobile-account-select"
    aria-label={t("mobile.mail.account")}
    value={(folder ? folderAccount : account)?.id ?? ""}
    disabled={busy}
    onChange={(event) => chooseAccount(event.target.value)}
  >{accounts.map((item) => <option key={item.id} value={item.id}>{accountOption(item, t)}</option>)}</select>;

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
  const refresh = () => {
    if (message) void loadMessage(message.message);
    else if (folder) void loadFolder(folder.folder, folder.offset);
    else void loadOverview();
  };

  return <main className="screen mail-mobile-screen">
    <header>
      {goBack && <button className="back" onClick={goBack}>‹</button>}
      <h1>{message ? safeText(message.message.subject) || t("mobile.mail.noSubject") : folder ? safeText(folder.folder.name) : t("mobile.mail.title")}</h1>
      <button onClick={refresh} disabled={busy}>↻</button>
    </header>
    <p className="notice">{writes.actions || writes.reply
      ? [
        t("mobile.mail.noticeWrites"),
        writes.actions ? t("mobile.mail.noticeActions") : "",
        writes.reply ? t("mobile.mail.noticeReply") : "",
        t("mobile.mail.noticeLimits"),
      ].filter(Boolean).join(" ")
      : t("mobile.mail.noticeReadOnly")}</p>
    {error && <p className="error">{error}</p>}
    {busy && !accounts && <p className="mail-mobile-empty">{t("common.loading")}</p>}

    {message ? <article className="mail-mobile-message">
      <div className="mail-mobile-message-meta">
        <strong>{sender(message.message, t)}</strong>
        <span>{safeText(message.message.sender.address)}</span>
        <time>{dateLabel(message.message.date, lang)}</time>
      </div>
      {writes.actions && <div className="mail-mobile-actions">
        <button disabled={busy} onClick={() => void mark(message.message.seen ? "unseen" : "seen")}>
          {t(message.message.seen ? "mobile.mail.markUnread" : "mobile.mail.markRead")}
        </button>
        <button disabled={busy} onClick={() => void mark(message.message.flagged ? "unflag" : "flag")}>
          {t(message.message.flagged ? "mobile.mail.unstar" : "mobile.mail.star")}
        </button>
      </div>}
      {message.truncated && <p className="mail-mobile-warning">{t("mobile.mail.truncated")}</p>}
      <pre>{safeText(message.body) || t("mobile.mail.noBody")}</pre>
      {message.attachments.length > 0 && <section className="mail-mobile-attachments">
        <h2>{t("mail.attachments")}</h2>
        {message.attachments.map((attachment, index) => <div key={`${attachment.filename}-${index}`}>
          <span>{safeText(attachment.filename)}</span><small>{safeText(attachment.mime)} · {sizeLabel(attachment.size)}</small>
        </div>)}
      </section>}
      {writes.reply && <section className="mail-mobile-reply">
        <h2>{t("mail.composeReply")}</h2>
        <small>{t("mobile.mail.replyTo", { address: safeText(message.message.sender.address) })}</small>
        {sent && <p className="mail-mobile-sent">{t("mobile.mail.replySent")}</p>}
        <textarea
          aria-label={t("mobile.mail.replyText")}
          value={reply}
          disabled={busy}
          placeholder={t("mobile.mail.replyPlaceholder")}
          onChange={(event) => { setReply(event.target.value); setConfirmReply(false); setSent(false); }}
        />
        {confirmReply ? <div className="mail-mobile-reply-confirm">
          <span>{t("mobile.mail.replyConfirm", { address: safeText(message.message.sender.address) })}</span>
          <div>
            <button className="primary" disabled={busy} onClick={() => void sendReply()}>{t("mobile.question.typeSend")}</button>
            <button disabled={busy} onClick={() => setConfirmReply(false)}>{t("common.cancel")}</button>
          </div>
        </div> : <button
          className="primary"
          disabled={busy || !reply.trim() || replyBytes(reply) > MAX_REPLY_BYTES}
          onClick={() => setConfirmReply(true)}
        >{t("mobile.mail.sendReply")}</button>}
        {replyBytes(reply) > MAX_REPLY_BYTES && <p className="mail-mobile-warning">{t("mobile.mail.replyTooLong")}</p>}
      </section>}
    </article> : folder ? <>
      <div className="mail-mobile-switch">
        {accountPicker}
        {folderAccount && <select
          aria-label={t("mobile.mail.folder")}
          value={folder.folder.id}
          disabled={busy}
          onChange={(event) => {
            const target = folderAccount.folders.find((item) => item.id === event.target.value);
            if (target) void loadFolder(target);
          }}
        >{sortedFolders(folderAccount.folders).map((item) => <option key={item.id} value={item.id}>
          {safeText(item.name)}{item.unread > 0 ? ` (${item.unread})` : ""}
        </option>)}</select>}
      </div>
      <section className="mail-mobile-list">
        {folder.messages.map((item) => <button className={`mail-mobile-row${item.seen ? "" : " unread"}${item.flagged ? " flagged" : ""}${item.answered ? " answered" : ""}`} key={item.id} onClick={() => void loadMessage(item)} disabled={busy}>
          <div><strong>{sender(item, t)}</strong><time>{dateLabel(item.date, lang)}</time></div>
          <b>{safeText(item.subject) || t("mobile.mail.noSubject")}{item.has_attachments ? <> <PaperclipIcon /></> : null}</b>
          <span>{safeText(item.preview)}</span>
        </button>)}
        {!busy && folder.messages.length === 0 && <p className="mail-mobile-empty">{t("mobile.mail.noMessages")}</p>}
      </section>
      <div className="mail-mobile-pager">
        <button disabled={busy || folder.offset === 0} onClick={() => void loadFolder(folder.folder, Math.max(0, folder.offset - PAGE_SIZE))}>{t("mobile.mail.previous")}</button>
        <small>{t("mobile.mail.pageOf", { range: folder.total === 0 ? "0" : `${folder.offset + 1}–${Math.min(folder.offset + folder.messages.length, folder.total)}`, total: folder.total })}</small>
        <button disabled={busy || folder.offset + folder.messages.length >= folder.total} onClick={() => void loadFolder(folder.folder, folder.offset + PAGE_SIZE)}>{t("common.next")}</button>
      </div>
    </> : accounts && <section className="mail-mobile-accounts">
      {accountPicker && <label className="mail-mobile-picker"><span>{t("mobile.mail.accountLabel")} {isUntested("mobile.mail.accountPicker") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>{accountPicker}</label>}
      {account && <div className="mail-mobile-account">
        <div><strong>{safeText(account.label)}</strong><small>{safeText(account.address)}</small></div>
        <div className="mail-mobile-folders">{sortedFolders(account.folders).map((item) => <button className={item.unread > 0 ? "has-unread" : undefined} key={item.id} onClick={() => void loadFolder(item)} disabled={busy}>
          <i aria-hidden="true">{KIND_GLYPH[item.kind] ?? <FolderIcon />}</i><span>{safeText(item.name)}</span><small>{t("mobile.mail.folderCounts", { unread: item.unread, total: item.total })}</small>
        </button>)}</div>
      </div>}
      {accounts.length === 0 && <p className="mail-mobile-empty">{t("mobile.mail.noAccounts")}</p>}
    </section>}
  </main>;
}
