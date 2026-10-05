import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  bodyLooksUnsafe,
  buildMessageSrcdoc,
  formatAddress,
  formatMailDate,
  formatSize,
  linkIsMailto,
  linkIsOpenable,
  mailLinkLabel,
  mailLinkNeedsAttention,
  mailAttachmentPreview,
  mailAttachmentSave,
  mailAttachmentSaveToProject,
  mailBody,
  mailReplies,
  mailAuthDmarcCarried,
  mailAuthPanelTone,
  mailAuthShown,
  mailAuthSummary,
  mailAuthTone,
  mailCryptoNoteKey,
  mailCryptoTone,
  openMailLink,
  stripFormatControls,
} from "../../lib/mail";
import { useGeneratedDirName } from "../../lib/generatedDir";
import { useI18nStore, useT } from "../../lib/i18n";
import { useMailStore } from "../../stores/mail";
import { findContactByEmail } from "../../lib/mailContacts";
import { useProjectsStore } from "../../stores/projects";
import { useUse24h } from "../../lib/timeFormat";
import { UntestedTag } from "../common/UntestedTag";
import { MailAiMessageActions, MailAiProvenance } from "./MailAiMessageActions";
import { AttachmentPreview } from "./MailAttachmentPreview";
import type {
  MailAttachmentMeta,
  MailAuthResults,
  MailBody,
  MailCryptoInfo,
  MailHeader,
  MailLink,
  MailPreviewBlob,
} from "../../types/mail";
import { UndoIcon } from "../common/icons/Icon";

/**
 * The message pane: headers, the sandboxed body, the links panel, the remote
 * content banner and the attachment rows.
 *
 * **The body renders in an `<iframe sandbox="" …>` and nowhere else.** No
 * `allow-scripts` (so JS is disabled by the *sandbox*, not merely by the
 * sanitizer) and no `allow-same-origin` (the two together are a total escape —
 * the frame could reach `parent.document` and `__TAURI__`). Nothing may be added
 * to that attribute. The frame carries its own `<meta>` CSP as well, because the
 * backend's sanitizer, the sandbox and the policy are three independent layers
 * and the design assumes any one of them can fail.
 *
 * Consequences worth remembering when editing this file:
 *  - the frame has an **opaque origin**, so `blob:` URLs minted here are not
 *    loadable inside it — inline images are `data:` URIs (which is why this pane
 *    does not use the `useBlobUrl` every other viewer does);
 *  - there are **no scripts in the frame**, so this component installs no
 *    `message` listener at all;
 *  - the sanitized HTML carries **no `href`** — links are `data-lid` markers,
 *    resolved here against `MailBody.links` and opened only after an explicit
 *    confirm that names the real host. That is what makes display-text-vs-href
 *    phishing structurally impossible rather than filtered.
 */
export interface MailMessageViewProps {
  header?: MailHeader;
  body: MailBody | null;
  loading: boolean;
  onReply: (mode: "reply" | "replyAll" | "forward") => void;
  /** Open the composer pre-addressed to a `mailto:` link's recipient. */
  onComposeTo: (address: string) => void;
}

export function MailMessageView({
  header,
  body,
  loading,
  onReply,
  onComposeTo,
}: MailMessageViewProps) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [confirmLink, setConfirmLink] = useState<MailLink | null>(null);
  // Sharing with a contained reader agent (`docs/mail_mcp_plan.md` §1): the
  // same mark the list's right-click sets, reachable from the open message.
  const agentShareable = useMailStore(
    (s) => !!header && s.accounts.find((a) => a.id === header.account_id)?.ai?.agent_access === true,
  );
  const agentShared = useMailStore((s) => !!header && s.agentMarks.includes(header.id));

  const unsafe = !!body?.html && bodyLooksUnsafe(body.html);
  // Memoized: a multi-MB srcdoc must not be re-assembled on every render.
  const doc = useMemo(
    () => (body && !unsafe ? buildMessageSrcdoc(body) : ""),
    [body, unsafe],
  );

  // Assigned through the DOM property rather than as a React attribute: a large
  // body would otherwise be re-serialized through React's attribute path on every
  // render, and WebKitGTK pays for that in attribute parsing (plan B §2.8).
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.srcdoc = doc;
  }, [doc]);

  if (!header) {
    return <div className="mail-message mail-empty">{t("mail.selectMessage")}</div>;
  }

  return (
    <div className="mail-message">
      <div className="mail-message-head">
        <div className="mail-message-subject">
          {stripFormatControls(header.subject) || t("mail.noSubject")}
        </div>
        <div className="mail-message-meta">
          <span className="mail-meta-label">{t("mail.from")}</span>
          <span className="mail-meta-value">{formatAddress(header.from)}</span>
          <SenderContactStar name={header.from.name ?? ""} address={header.from.address} />
        </div>
        {header.to.length > 0 && (
          <div className="mail-message-meta">
            <span className="mail-meta-label">{t("mail.to")}</span>
            <span className="mail-meta-value">
              {header.to.map((a) => formatAddress(a)).join(", ")}
            </span>
          </div>
        )}
        {header.cc.length > 0 && (
          <div className="mail-message-meta">
            <span className="mail-meta-label">{t("mail.cc")}</span>
            <span className="mail-meta-value">
              {header.cc.map((a) => formatAddress(a)).join(", ")}
            </span>
          </div>
        )}
        <div className="mail-message-meta">
          <span className="mail-meta-label">{t("mail.date")}</span>
          <span className="mail-meta-value">{formatMailDate(header.date, lang, use24h)}</span>
        </div>
        {/* Who set the priority mark, read-only (#205) — a model classifier must
            not pass for a keyword rule the user wrote. */}
        <MailAiProvenance header={header} />
        <MailAuthPanel auth={header.auth} />
        {/* Beside the sender checks, not instead of them: they answer different
            questions. `Authentication-Results` is what YOUR server concluded
            about the hop that delivered the message; this is what the *sender*
            did to it before it left their machine. A message can pass one and
            fail the other, and folding them into one badge would hide exactly
            that case. */}
        {body?.crypto && <MailCryptoPanel info={body.crypto} />}
        <MailRepliesPanel header={header} />
        <div className="mail-message-actions">
          <button type="button" className="settings-btn" onClick={() => onReply("reply")}>
            {t("mail.composeReply")}
          </button>
          <button type="button" className="settings-btn" onClick={() => onReply("replyAll")}>
            {t("mail.composeReplyAll")}
          </button>
          <button type="button" className="settings-btn" onClick={() => onReply("forward")}>
            {t("mail.composeForward")}
          </button>
          {agentShareable && (
            <button
              type="button"
              className="settings-btn untested"
              title={t("mail.shareWithAgentsNote")}
              aria-pressed={agentShared}
              onClick={() => void useMailStore.getState().setAgentMark([header], !agentShared)}
            >
              {agentShared ? t("mail.stopSharingWithAgents") : t("mail.shareWithAgents")}
              <UntestedTag id="mailMessageView.5" />
            </button>
          )}
        </div>
        {/* Local-model actions (#204/#207/#208): summarize, extract an event,
            extract a to-do — each gated by its own toggle and a loopback model. */}
        <MailAiMessageActions header={header} />
        {!!header.malformed_headers?.length && (
          <div className="mail-warning-strip">
            {t("mail.malformedHeaders")} {header.malformed_headers.join(", ")}
          </div>
        )}
      </div>

      {loading && <div className="mail-empty">{t("mail.loading")}</div>}

      {body && (
        <>
          {/* Blocked, with no way to unblock — and the banner says exactly that
              rather than offering a button.

              There is deliberately no "Load remote content" action yet: the
              backend has no image proxy (see `docs/mail_client_plan_b.md` §2.6),
              so a button here would clear the banner, report success, and load
              nothing. Fetching remote content is a new outbound network path
              driven entirely by attacker-controlled URLs, which deserves its own
              deliberate pass rather than being tacked on — until then, blocked
              and honest about it beats a control that lies. */}
          {body.remote_refs > 0 && (
            <div className="mail-remote-banner">
              <span>{t("mail.remoteBlocked", { count: body.remote_refs })}</span>
            </div>
          )}
          {body.truncated && <div className="mail-warning-strip">{t("mail.truncatedBody")}</div>}

          {unsafe ? (
            /* The tripwire fired: the sanitized HTML still carried something
               active. Rendering anyway would be the one catastrophic failure
               (app-origin XSS with full IPC), so this refuses instead. */
            <div className="mail-unsafe-card">
              <strong>{t("mail.unsafeBody")}</strong>
              <p>{t("mail.unsafeBodyHint")}</p>
            </div>
          ) : (
            <iframe
              ref={frameRef}
              // sandbox="" is the whole policy and is load-bearing. NOTHING may be
              // added here — see the file comment.
              sandbox=""
              referrerPolicy="no-referrer"
              loading="eager"
              title={t("mail.messageBody")}
              className="mail-body-frame"
            />
          )}

          <MailLinksPanel links={body.links} onPick={setConfirmLink} />
          <MailAttachments messageId={body.id} attachments={body.attachments} />
        </>
      )}

      {confirmLink && (
        <LinkConfirmDialog
          link={confirmLink}
          onClose={() => setConfirmLink(null)}
          onComposeTo={(addr) => {
            setConfirmLink(null);
            onComposeTo(addr);
          }}
        />
      )}
    </div>
  );
}

/**
 * The answers the user already wrote to this message — Sent mail whose
 * `In-Reply-To` names it, from the local index (`mail_replies`). Absent when
 * there are none. A row unfolds the reply's plain text in place, as a text
 * node: the reply lives in another folder, and leaving the open message to read
 * it would lose the place the question was asked from.
 *
 * Re-read when the message's `\Answered` flag moves or the account finishes a
 * check, which is when a reply just sent has reached the Sent folder's index.
 */
function MailRepliesPanel({ header }: { header: MailHeader }) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const syncPhase = useMailStore((s) => s.sync[header.account_id]?.phase);
  const synced = syncPhase === "done";
  const [replies, setReplies] = useState<MailHeader[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    mailReplies(header.id)
      .then((found) => live && setReplies(found))
      .catch(() => live && setReplies([]));
    return () => {
      live = false;
    };
  }, [header.id, header.answered, synced]);

  useEffect(() => {
    setOpenId(null);
  }, [header.id]);

  useEffect(() => {
    setText(null);
    if (!openId) return;
    let live = true;
    // Remote content stays blocked, as for every body; only `text` is shown.
    mailBody(openId, false)
      .then((b) => live && setText(b.text?.trim() || t("mail.replyNoText")))
      .catch(() => live && setText(t("mail.replyNoText")));
    return () => {
      live = false;
    };
  }, [openId, t]);

  if (replies.length === 0) return null;
  return (
    <div className="mail-auth mail-replies">
      <div className="mail-auth-head">
        <span className="mail-meta-label"><UndoIcon /> {t("mail.replies", { count: replies.length })}</span>
        <UntestedTag id="mailMessageView.4" />
      </div>
      <div className="mail-links-rows">
        {replies.map((reply) => (
          <button
            key={reply.id}
            type="button"
            className="mail-link-row"
            aria-expanded={openId === reply.id}
            onClick={() => setOpenId((id) => (id === reply.id ? null : reply.id))}
          >
            <span className="mail-reply-when">
              {openId === reply.id ? "▾" : "▸"} {formatMailDate(reply.date, lang, use24h)}
              {reply.to.length > 0 &&
                ` · ${t("mail.repliesTo", { to: reply.to.map((a) => a.address).join(", ") })}`}
            </span>
            {openId === reply.id ? (
              <span className="mail-reply-text">{text ?? t("mail.loading")}</span>
            ) : (
              <span className="mail-reply-preview">{stripFormatControls(reply.preview)}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What the **receiving server** concluded about SPF/DKIM/DMARC, read out of the
 * message's `Authentication-Results` header.
 *
 * Three rules make this safe to show, and all three are load-bearing:
 *
 *  - **A verdict appears only in the `verified` state** — the account named a
 *    trusted `authserv-id` and the topmost header carried it. The backend clears
 *    `methods` in every other state and `mailAuthShown` refuses a second time,
 *    because a tick an attacker can draw is worse than no tick at all.
 *  - **A pass is never shown without the domain it applies to.**
 *    `dkim=pass header.d=evil.example` on a mail claiming to be a bank is a
 *    genuine pass by the wrong signer, so `mailAuthTone` tones an unaligned pass
 *    as a warning, not as good news.
 *  - **Absence is not failure.** A message with no such header renders nothing
 *    here; only a *configured* account that received a *foreign* header gets a
 *    warning, because that one really is a signal.
 */
/**
 * End-to-end signature/encryption, in `MailAuthPanel`'s shape and vocabulary.
 *
 * **The chrome rule is the backend's**, not this component's: `info.state`
 * already encodes it, and `mailCryptoTone` is the single mapping from state to
 * appearance. Recomputing "is this good" here would be a second opinion that can
 * disagree with the one the tests pin.
 *
 * Two things this panel must always say and never imply otherwise:
 *
 * - **The identity beside the verdict.** A good signature from a key nobody
 *   checked is a statement about bytes; the identity is what makes it a
 *   statement about a person, and only when the user has verified the key.
 * - **Headers are not signed.** From, Subject and Date sit outside the signature
 *   in both formats, so a tick never vouches for the sender line above it. That
 *   note is emitted by the backend for every signed message precisely so it
 *   cannot be forgotten here.
 */
function MailCryptoPanel({ info }: { info: MailCryptoInfo }) {
  const t = useT();
  const tone = mailCryptoTone(info);
  const notes = info.notes
    .map(mailCryptoNoteKey)
    .filter((k) => k !== null)
    .map((k) => k as NonNullable<typeof k>);

  const headline = info.encrypted
    ? info.decrypted
      ? "mail.crypto.encryptedOpened"
      : "mail.crypto.encryptedLocked"
    : "mail.crypto.signedOnly";

  return (
    <div className={`mail-auth mail-auth-${tone}`}>
      <div className="mail-auth-head">
        <span className="mail-meta-label">
          {t(info.format === "openpgp" ? "mail.crypto.titlePgp" : "mail.crypto.titleSmime")}
        </span>
        <span className="mail-auth-summary">{t(headline)}</span>
        <UntestedTag id="mailMessageView.1" />
      </div>
      {info.signed && (
        <div className="mail-auth-rows">
          <span className={`mail-auth-chip tone-${tone}`}>
            <span className="mail-auth-method">{t("mail.crypto.signature")}</span>
            <span className="mail-auth-result">{t(`mail.crypto.state.${info.state}`)}</span>
            {/* Always rendered when there is one — the verdict without the
                identity it applies to is the misreading this whole vocabulary
                exists to prevent. */}
            {info.identifier && (
              <span className="mail-auth-identity">
                {t(info.aligned ? "mail.authAligned" : "mail.authUnaligned", {
                  domain: info.identifier,
                })}
              </span>
            )}
          </span>
        </div>
      )}
      {notes.map((key) => (
        <p key={key} className="mail-auth-hint">
          {t(key)}
        </p>
      ))}
    </div>
  );
}

function MailAuthPanel({ auth }: { auth?: MailAuthResults }) {
  const t = useT();
  const summary = mailAuthSummary(auth);
  if (!auth || !summary) return null;

  const shown = mailAuthShown(auth);
  const tone = mailAuthPanelTone(auth);

  return (
    <div className={`mail-auth mail-auth-${tone}`}>
      <div className="mail-auth-head">
        <span className="mail-meta-label">{t("mail.authTitle")}</span>
        <span className="mail-auth-summary">{t(summary.key, summary.values)}</span>
        <UntestedTag id="mailMessageView.2" />
      </div>
      {shown.length > 0 && (
        <div className="mail-auth-rows">
          {/* Keyed by position, not by method: a message can carry **two** DKIM
              signatures (the sending service's and the brand's), and keying by
              name alone collides. */}
          {shown.map((m, i) => (
            <span key={`${m.method}-${i}`} className={`mail-auth-chip tone-${mailAuthTone(m)}`}>
              <span className="mail-auth-method">{m.method.toUpperCase()}</span>
              <span className="mail-auth-result">{m.result}</span>
              <span className="mail-auth-identity">
                {m.identifier
                  ? t(m.aligned ? "mail.authAligned" : "mail.authUnaligned", {
                      domain: m.identifier,
                    })
                  : t("mail.authNoIdentity")}
              </span>
            </span>
          ))}
        </div>
      )}
      {auth.state !== "verified" && (
        <p className="mail-auth-hint">
          {t(auth.state === "foreign" ? "mail.authForeignHint" : "mail.authUnconfiguredHint")}
        </p>
      )}
      {/* Without this, a green summary sitting above an orange chip reads as a
          contradiction rather than as a conclusion with its workings shown. */}
      {mailAuthDmarcCarried(auth) && (
        <p className="mail-auth-hint">{t("mail.authDmarcCarried")}</p>
      )}
      {auth.state === "verified" && auth.header_count > 1 && (
        <p className="mail-auth-hint">
          {t("mail.authMoreHeaders", { count: auth.header_count })}
        </p>
      )}
    </div>
  );
}

/**
 * The links panel — the *only* clickable surface for a message's links, because
 * the body itself has no `href` to click.
 *
 * It expands itself when any link is suspicious, since a collapsed panel is
 * exactly the state in which nobody reads the warning that was the point.
 */
function MailLinksPanel({
  links,
  onPick,
}: {
  links: MailLink[];
  onPick: (link: MailLink) => void;
}) {
  const t = useT();
  const suspicious = links.some(mailLinkNeedsAttention);
  const [open, setOpen] = useState(suspicious);

  if (links.length === 0) return null;
  return (
    <div className="mail-links">
      <button type="button" className="mail-links-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {t("mail.links", { count: links.length })}
      </button>
      {open && (
        <div className="mail-links-rows">
          {links.map((link) => (
            <button
              key={link.lid}
              type="button"
              className={`mail-link-row${mailLinkNeedsAttention(link) ? " warn" : ""}`}
              onClick={() => onPick(link)}
            >
              <span className="mail-link-host">{mailLinkLabel(link)}</span>
              {link.mismatch && (
                <span className="mail-link-flag">{t("mail.linkMismatch")}</span>
              )}
              {/* The scheme chip only where it says something the label does not.
                  On a `tel:` row the label already *is* the number, so repeating
                  "tel" beside it is noise dressed as a warning. */}
              {link.scheme_warning && mailLinkNeedsAttention(link) && (
                <span className="mail-link-flag">{link.scheme_warning}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The confirm before anything leaves the app.
 *
 * The **full** URL is shown, monospace and never truncated with an ellipsis —
 * truncation is itself the attack (`https://bank.example.evil.tld/…` reads as
 * `https://bank.example…`) — with the host called out separately, since the host
 * is the only part that decides where the click goes. A non-http(s) scheme gets
 * no *Open* button at all, only *Copy*; `mailto:` opens the internal composer
 * rather than the OS handler.
 */
function LinkConfirmDialog({
  link,
  onClose,
  onComposeTo,
}: {
  link: MailLink;
  onClose: () => void;
  onComposeTo: (address: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const openable = linkIsOpenable(link);
  const mailto = linkIsMailto(link);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog mail-link-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("mail.linkConfirmTitle")}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <div className="mail-link-detail">
            <div className="mail-link-detail-label">{t("mail.linkGoesTo")}</div>
            {/* The same label the row used — for a hostless scheme the bare word
                "tel" would tell the reader nothing about what they are copying. */}
            <div className="mail-link-detail-host">{mailLinkLabel(link) || "—"}</div>
            <div className="mail-link-detail-label">{t("mail.linkFull")}</div>
            <div className="mail-link-detail-url">{link.href}</div>
          </div>
          {link.mismatch && <div className="mail-warning-strip">{t("mail.linkMismatch")}</div>}
          {link.scheme_warning && (
            <div className="mail-warning-strip">
              {link.scheme_warning} {t("mail.linkSchemeRefused")}
            </div>
          )}
          <div className="mail-dialog-actions">
            <button type="button" className="settings-btn" autoFocus onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                navigator.clipboard?.writeText(link.href).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? t("mail.linkCopied") : t("mail.linkCopy")}
            </button>
            {mailto && (
              <button
                type="button"
                className="settings-btn primary"
                onClick={() => onComposeTo(link.href.slice("mailto:".length).split("?")[0])}
              >
                {t("mail.linkCompose")}
              </button>
            )}
            {openable && (
              <button
                type="button"
                className="settings-btn primary"
                onClick={() => {
                  void openMailLink(link.href).catch(() => {});
                  onClose();
                }}
              >
                {t("mail.linkOpen")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Attachment rows. Exactly two things can happen to an attachment, and both are
 * bounded by the capability boundary:
 *
 *  - **Save** opens a per-file confirmation offering two destinations, neither
 *    of which is a path this component constructs. *Save to tabtivity-emails* calls
 *    `mail_attachment_save_to_project` with the active project's **opaque id**
 *    (the backend resolves it to `<project>/tabtivity-emails/`, creating it);
 *    *Choose another location…* calls `mail_attachment_save`, whose OS save
 *    dialog the backend raises. That option is only shown while a
 *    project is active. There is no "save all" — one confirmation per file is
 *    deliberate friction at the point the boundary is crossed.
 *  - **Preview** calls `mail_attachment_preview`, which returns bounded bytes
 *    over IPC. Nothing touches the filesystem.
 *
 * There is deliberately **no** "open with the system app": that is an arbitrary
 * write plus exec, and it is the one hole this whole design exists to avoid.
 */
function MailAttachments({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: MailAttachmentMeta[];
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [preview, setPreview] = useState<{ partId: string; blob: MailPreviewBlob } | null>(null);
  const [confirm, setConfirm] = useState<MailAttachmentMeta | null>(null);
  // Mail is a global surface with no project of its own, so "the project" is the
  // active one; its opaque id — never its path — is what crosses to the backend.
  // A remote project's tree lives on its host, so the backend refuses a save
  // "into" it — and it is not offered here either.
  const activeProject = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeId && !p.remote) ?? null,
  );

  if (attachments.length === 0) return null;

  // A rejection must not be handed on as if it were a path: returning the
  // message from `catch` makes it truthy, and the pane then reports "saved to
  // <the error text>" for a write that never happened.
  const runSave = async (part: MailAttachmentMeta, save: () => Promise<string | null>) => {
    setConfirm(null);
    setBusy(part.part_id);
    setNote(t("mail.attachmentSaving"));
    const result = await save().then(
      (path) => ({ ok: true as const, path }),
      (err) => ({ ok: false as const, error: typeof err === "string" ? err : String(err) }),
    );
    setBusy(null);
    setNote(
      !result.ok
        ? result.error
        : result.path
          ? t("mail.attachmentSaved", { path: result.path })
          : t("mail.attachmentNotSaved"),
    );
  };

  const saveToEmails = (part: MailAttachmentMeta) => {
    if (!activeProject) return;
    void runSave(part, () =>
      mailAttachmentSaveToProject(messageId, part.part_id, activeProject.id),
    );
  };

  const saveElsewhere = (part: MailAttachmentMeta) =>
    void runSave(part, () => mailAttachmentSave(messageId, part.part_id));

  const doPreview = async (part: MailAttachmentMeta) => {
    if (preview?.partId === part.part_id) {
      setPreview(null);
      return;
    }
    setBusy(part.part_id);
    const blob = await mailAttachmentPreview(messageId, part.part_id).catch(() => null);
    setBusy(null);
    if (blob) setPreview({ partId: part.part_id, blob });
    else setNote(t("mail.previewUnavailable"));
  };

  return (
    <div className="mail-attachments">
      <div className="mail-attachments-title">{t("mail.attachments")}</div>
      {attachments.map((part) => (
        <div key={part.part_id} className="mail-attachment-row">
          <span className="mail-attachment-name">{stripFormatControls(part.filename)}</span>
          <span className="mail-attachment-size">{formatSize(part.size)}</span>
          <button
            type="button"
            className="settings-btn"
            disabled={busy === part.part_id}
            onClick={() => void doPreview(part)}
          >
            {preview?.partId === part.part_id
              ? t("mail.attachmentHidePreview")
              : t("mail.attachmentPreview")}
          </button>
          <button
            type="button"
            className="settings-btn"
            disabled={busy === part.part_id}
            onClick={() => setConfirm(part)}
          >
            {t("mail.attachmentSave")}
          </button>
          {part.type_mismatch && (
            /* Persistent, not a dismissible toast: a name that lies about the
               bytes is the single strongest signal an attachment is hostile. */
            <div className="mail-warning-strip">
              {t("mail.attachmentTypeMismatch")} {part.type_mismatch}
            </div>
          )}
          {preview?.partId === part.part_id && <AttachmentPreview blob={preview.blob} />}
        </div>
      ))}
      <div className="mail-note">{t("mail.attachmentNoOpen")}</div>
      {note && <div className="mail-note">{note}</div>}
      {confirm && (
        <AttachmentSaveDialog
          part={confirm}
          project={activeProject}
          onSaveToEmails={() => saveToEmails(confirm)}
          onSaveElsewhere={() => saveElsewhere(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/**
 * The per-file save confirmation. Two destinations, neither a path this
 * component builds: *Save to tabtivity-emails* (only while a project is active —
 * the backend resolves the project's opaque id to `<project>/tabtivity-emails/`) and
 * *Choose another location…* (the backend's OS save dialog). Wears the mail
 * client's canonical dialog chrome, exactly as `LinkConfirmDialog` does.
 */
function AttachmentSaveDialog({
  part,
  project,
  onSaveToEmails,
  onSaveElsewhere,
  onClose,
}: {
  part: MailAttachmentMeta;
  project: { directory?: string } | null;
  onSaveToEmails: () => void;
  onSaveElsewhere: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // A project with no local directory (never expected, but the type allows it)
  // is treated as "no tabtivity-emails folder": only the pick-a-location path is
  // offered. The folder name mirrors the backend's; this is a label, not the
  // path the write uses (that stays the backend's, resolved from an opaque id).
  const emailsDir = useGeneratedDirName(project?.directory ?? "", "emails");
  const emailsFolder = project?.directory
    ? `${project.directory.replace(/[/\\]+$/, "")}/${emailsDir}`
    : "";

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog mail-link-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>{t("mail.attachmentSaveTitle")}</h2>
          <UntestedTag id="mailMessageView.3" />
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-scroll">
          <div className="mail-link-detail">
            <div className="mail-link-detail-label">{t("mail.attachmentSaveNameLabel")}</div>
            <div className="mail-link-detail-host">{stripFormatControls(part.filename)}</div>
            {emailsFolder ? (
              <>
                <div className="mail-link-detail-label">{t("mail.attachmentSaveFolderLabel")}</div>
                <div className="mail-link-detail-url">{emailsFolder}</div>
              </>
            ) : (
              <div className="mail-note">{t("mail.attachmentNoProject")}</div>
            )}
          </div>
          <div className="mail-dialog-actions">
            <button type="button" className="settings-btn" autoFocus onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="settings-btn" onClick={onSaveElsewhere}>
              {t("mail.attachmentChooseLocation")}
            </button>
            {emailsFolder && (
              <button type="button" className="settings-btn primary" onClick={onSaveToEmails}>
                {t("mail.attachmentSaveToEmails")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Thunderbird's star beside the sender: hollow when no card holds the address
 * (a click opens a new card for it in the Address Book), filled when one does
 * (a click opens that card). The name only pre-fills an editor the user saves
 * — a message never writes to the address book on its own.
 */
function SenderContactStar({ name, address }: { name: string; address: string }) {
  const t = useT();
  const loaded = useMailStore((s) => s.contactsLoaded);
  const known = useMailStore((s) => !!findContactByEmail(s.contacts, address));
  useEffect(() => {
    if (!loaded) void useMailStore.getState().loadContacts();
  }, [loaded]);
  if (!address) return null;
  const label = known ? t("mail.contacts.editSender") : t("mail.contacts.addSender");
  return (
    <>
      <button
        type="button"
        className={`mail-contact-star${known ? " known" : ""}`}
        title={label}
        aria-label={label}
        onClick={() =>
          useMailStore
            .getState()
            .openContactsTab({ address, name: stripFormatControls(name).trim() || undefined })
        }
      >
        {known ? "★" : "☆"}
      </button>
      <UntestedTag id="mail.contacts.addSender" />
    </>
  );
}
