import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UntestedTag } from "../common/UntestedTag";
import {
  formatAddress,
  formatMailDate,
  formatSize,
  mailAiErrorKey,
  mailAttachPick,
  mailAttachRemove,
  mailDraftDiscard,
  mailDraftSave,
  mailDraftSend,
  mailFormalizeReply,
  mailPgpAvailable,
  mailPgpRecipientsReady,
  mailStagedPreview,
  stripFormatControls,
  useMailAiFeature,
} from "../../lib/mail";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type {
  MailAccount,
  MailBody,
  MailDraft,
  MailHeader,
  MailPreviewBlob,
  StagedAttachment,
} from "../../types/mail";
import { useMailStore, type MailComposeMode } from "../../stores/mail";
import { WarningIcon } from "../common/icons/Icon";
import { AttachmentPreview } from "./MailAttachmentPreview";
import { MailRecipientField } from "./MailRecipientField";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The composer.
 *
 * The one thing to understand before editing it: **attaching a file is a backend
 * action.** `mail_attach_pick` raises the OS open dialog *inside Rust*, copies
 * what the user picked into the mail sandbox directory, and hands back opaque
 * staged ids. This component never sees, constructs, or displays a filesystem
 * path — there is no path field to type into and no drag-and-drop (the app window
 * sets `dragDropEnabled: false`, and compose must not be the exception). Because
 * the pick is keyed by draft id, the draft is saved first when it has no id yet;
 * that is the only reason `ensureDraft` exists.
 *
 * Two hosts. As a dialog its chrome is the canonical `.modal-backdrop` >
 * `.settings-dialog`, and the portal sets its text color explicitly (`body`
 * carries none, so black would be inherited). `embedded`, it is the body of one
 * of the mail window's tabs (`MailOverlay`): no portal, no backdrop, no title
 * row — the tab strip names it and its × closes it — and it stays mounted while
 * another tab is on screen, which is what keeps an unfinished mail unfinished
 * rather than lost.
 */
export type ComposeMode = MailComposeMode;

export interface MailComposeDialogProps {
  accounts: MailAccount[];
  /** The account the message is sent from; the picker starts here. */
  accountId: string;
  mode: ComposeMode;
  /** The message being replied to / forwarded, when there is one. */
  source?: { header: MailHeader; body: MailBody | null };
  /** Pre-filled recipient (a `mailto:` link the user confirmed). */
  toAddress?: string;
  /** A stored draft an **agent** wrote (`origin` set), opened for review. The
   *  composer is the only way it leaves: Send is bound to what is on screen. */
  draft?: MailDraft;
  /** The mail is finished with — sent, or its draft discarded. Nothing is left
   *  to lose, so the host closes without asking. The dialog's × and backdrop
   *  use it too. */
  onClose: () => void;
  /** The Cancel button. Defaults to `onClose`; a tab host routes it through the
   *  same "throw this away?" question as its tab ×. */
  onCancel?: () => void;
  /** Render as a mail-window tab body instead of a modal dialog. */
  embedded?: boolean;
  /** Called while what is on screen differs from what the composer opened with
   *  (or last saved), with the current subject — the tab host's cue that
   *  closing now throws text away. */
  onDirty?: (subject: string) => void;
  /** The draft was saved and nothing on screen is unsaved any more. */
  onSaved?: (subject: string) => void;
}

/** Recipients are typed one per line or comma-separated, and parsed into a list —
 *  never concatenated into a header. A CR/LF in a recipient is how a `Bcc:` gets
 *  injected into an outgoing message (T16), and a list cannot carry one. */
export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/[\r\n]/.test(s));
}

function quotedBody(
  source: { header: MailHeader; body: MailBody | null } | undefined,
  mode: ComposeMode,
  intro: string,
  forwardMark: string,
): string {
  if (!source || mode === "new") return "";
  const text = source.body?.text ?? "";
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return mode === "forward" ? `\n\n${forwardMark}\n${text}` : `\n\n${intro}\n${quoted}`;
}

export function MailComposeDialog({
  accounts,
  accountId,
  mode,
  source,
  toAddress,
  draft,
  onClose,
  onCancel,
  embedded,
  onDirty,
  onSaved,
}: MailComposeDialogProps) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();

  const header = source?.header;
  const initialTo =
    toAddress ??
    (mode === "reply" || mode === "replyAll" ? (header?.from.address ?? "") : "");
  const initialCc =
    mode === "replyAll" && header
      ? [...header.to, ...header.cc]
          .map((a) => a.address)
          .filter((a) => a && a !== header.from.address)
          .join("\n")
      : "";
  const initialSubject = composeSubject(t, mode, header);

  const [from, setFrom] = useState(draft?.account_id ?? accountId);
  const [to, setTo] = useState(draft ? draft.to.join("\n") : initialTo);
  const [cc, setCc] = useState(draft ? draft.cc.join("\n") : initialCc);
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(draft ? stripFormatControls(draft.subject) : initialSubject);
  const [text, setText] = useState(() =>
    draft ? draft.body_text :
    quotedBody(
      source,
      mode,
      header
        ? t("mail.quotedIntro", {
            date: formatMailDate(header.date, lang, use24h),
            sender: formatAddress(header.from),
          })
        : "",
      t("mail.forwardedIntro"),
    ),
  );
  const [draftId, setDraftId] = useState(draft?.id ?? "");
  // Seeded from the draft: an agent's draft may already carry files it
  // attached by project and path, and Send attaches the store's set — a file
  // the composer did not show would go out unseen.
  const [staged, setStaged] = useState<StagedAttachment[]>(draft?.staged ?? []);
  const [preview, setPreview] = useState<{ stagedId: string; blob: MailPreviewBlob } | null>(null);
  const [busy, setBusy] = useState<"" | "attach" | "save" | "send">("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // End-to-end signing/encryption. **Both default off**, per message, and never
  // remembered — a sticky "encrypt" that silently turned itself off once would
  // be worse than one that always has to be chosen.
  //
  // The one exception is a reply or forward that quotes a message which arrived
  // **encrypted**: that starts ticked, because the quote is the decrypted
  // plaintext. Unticked, it would go out in the clear to whoever the reply is
  // addressed to — and a captured ciphertext resent under an attacker's From is
  // decrypted like any other, so "whoever" can be the attacker.
  const quotesDecrypted = mode !== "new" && source?.body?.crypto?.decrypted === true;
  const [sign, setSign] = useState(false);
  const [encrypt, setEncrypt] = useState(quotesDecrypted);
  const [pgpReady, setPgpReady] = useState(false);
  const [missingKeys, setMissingKeys] = useState<string[]>([]);

  // #206 — draft a formal reply from rough notes, on a **loopback** model. It
  // only ever fills the body below; it never sends. Gated by the **sending
  // account's** `formalize` toggle plus the global master switch and a resolvable
  // mail-role model — `from` is the account this reply goes out as.
  const fromAccount = accounts.find((a) => a.id === from);
  const canFormalize = useMailAiFeature(fromAccount, "formalize");
  const [notes, setNotes] = useState("");
  const [tone, setTone] = useState("");
  const [drafting, setDrafting] = useState(false);

  async function draftFromNotes() {
    if (!notes.trim()) return;
    setDrafting(true);
    setError("");
    setStatus("");
    try {
      const reply = await mailFormalizeReply(notes, {
        accountId: from,
        messageId: header?.id ?? null,
        tone: tone || null,
      });
      // Fill the body with the drafted reply, keeping any quoted original below
      // it. **Never sends** — the user reviews and sends explicitly.
      const tail = quotedBody(
        source,
        mode,
        header
          ? t("mail.quotedIntro", {
              date: formatMailDate(header.date, lang, use24h),
              sender: formatAddress(header.from),
            })
          : "",
        t("mail.forwardedIntro"),
      );
      setText(reply + tail);
      setStatus(t("mailAi.draftDone"));
    } catch (err) {
      const key = mailAiErrorKey(err);
      setError(key ? t(key) : typeof err === "string" ? err : String(err));
    } finally {
      setDrafting(false);
    }
  }

  useEffect(() => {
    void mailPgpAvailable().then(setPgpReady);
  }, []);

  // Which recipients have no key, asked **while the message is being written**
  // rather than on Send. Finding out at Send means either a refused send after
  // the work is done, or — the thing this exists to make impossible — a user who
  // ticked Encrypt and did not notice it could not be honoured.
  const recipientList = [...parseRecipients(to), ...parseRecipients(cc), ...parseRecipients(bcc)];
  const recipientKey = recipientList.join(",");
  useEffect(() => {
    if (!encrypt || !recipientKey) {
      setMissingKeys([]);
      return;
    }
    let live = true;
    void mailPgpRecipientsReady(from, recipientKey.split(","))
      .then((missing) => live && setMissingKeys(missing))
      .catch(() => live && setMissingKeys([]));
    return () => {
      live = false;
    };
  }, [encrypt, recipientKey, from]);

  // Dirty is "differs from the opening values", compared, not counted: a
  // reply's quoted text is not the user's work yet, and an effect that skipped
  // its first run would fire anyway under StrictMode's double mount. Staged
  // attachments count by id, not by array (a save hands back a new array of the
  // same files). A save moves the baseline to what was saved.
  const snapshot = [from, to, cc, bcc, subject, text, staged.map((a) => a.staged_id).join(",")].join(
    "\u0000",
  );
  const baseline = useRef(snapshot);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => {
    if (snapshot !== baseline.current) onDirtyRef.current?.(subject);
  }, [snapshot, subject]);

  function buildDraft(): MailDraft {
    return {
      id: draftId,
      account_id: from,
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject: subject.replace(/[\r\n]/g, " "),
      body_text: text,
      // `in_reply_to` must be the sender's RFC `Message-ID`, never `header.id` —
      // that is Tabtivity's own `{folder_id}-{uid}` store key, which no other mail
      // system has ever seen. Sending it would put a fabricated reference on the
      // wire: the reply threads nowhere and claims a message that does not exist.
      // A message that carried no `Message-ID` gets no `In-Reply-To` at all,
      // which is the honest degradation.
      ...(header?.rfc_message_id && mode !== "new" && mode !== "forward"
        ? { in_reply_to: header.rfc_message_id }
        : {}),
      // An agent's reply draft carries the threading the backend read from the
      // store; the composer passes it through and never invents it.
      ...(draft?.in_reply_to ? { in_reply_to: draft.in_reply_to, references: draft.references } : {}),
      staged,
    };
  }

  /** Persist the draft. The backend answers with the staged set it holds,
   *  which becomes what is on screen. `null` when the save failed. */
  async function saveDraft(): Promise<MailDraft | null> {
    const saved = await mailDraftSave(buildDraft()).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    if (!saved) return null;
    setDraftId(saved.id);
    setStaged(saved.staged ?? staged);
    return saved;
  }

  /** Persist the draft so it HAS an id — `mail_attach_pick` and `mail_draft_send`
   *  are both keyed by one. Returns the id, or `""` when the save failed. */
  async function ensureDraft(): Promise<string> {
    return (await saveDraft())?.id ?? "";
  }

  // An agent's suggested recipients not yet in To — each a pill the user adds
  // with a click. Never copied into To on their own.
  const suggestions = (draft?.suggested_to ?? []).filter(
    (a) => !parseRecipients(to).some((r) => r.toLowerCase() === a.toLowerCase()),
  );
  function addSuggestion(address: string) {
    setTo((prev) => (prev.trim() ? `${prev.trimEnd()}\n${address}` : address));
  }

  async function togglePreview(stagedId: string) {
    if (preview?.stagedId === stagedId) {
      setPreview(null);
      return;
    }
    if (!draftId) return;
    const blob = await mailStagedPreview(draftId, stagedId).catch(() => null);
    if (blob) setPreview({ stagedId, blob });
    else setStatus(t("mail.previewUnavailable"));
  }

  async function doAttach() {
    setBusy("attach");
    setError("");
    setStatus(t("mail.attaching"));
    const id = draftId || (await ensureDraft());
    if (!id) {
      setBusy("");
      setStatus("");
      return;
    }
    // The BACKEND raises the picker. Nothing here names a path, and a cancelled
    // dialog simply returns an empty list.
    const picked = await mailAttachPick(id).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    setStatus("");
    if (picked?.length) setStaged((s) => [...s, ...picked]);
  }

  async function doRemoveAttachment(stagedId: string) {
    if (draftId) await mailAttachRemove(draftId, stagedId).catch(() => {});
    setStaged((s) => s.filter((a) => a.staged_id !== stagedId));
    if (preview?.stagedId === stagedId) setPreview(null);
  }

  async function doSaveDraft() {
    setBusy("save");
    setError("");
    const saving = latest.current;
    const savedSubject = subject;
    const id = await ensureDraft();
    setBusy("");
    if (!id) return;
    setStatus(t("mail.draftSaved"));
    baseline.current = saving;
    // Typed on while the save was in flight: that text is not saved, so the
    // tab stays dirty.
    if (latest.current === saving) onSaved?.(savedSubject);
  }

  async function doDiscard() {
    if (!draftId) return onClose();
    setBusy("save");
    const ok = await mailDraftDiscard(draftId).then(
      () => true,
      (err) => {
        setError(typeof err === "string" ? err : String(err));
        return false;
      },
    );
    setBusy("");
    if (ok) onClose();
  }

  async function doSend() {
    if (parseRecipients(to).length === 0) {
      setError(t("mail.recipientsRequired"));
      return;
    }
    setBusy("send");
    setError("");
    setStatus("");
    // What the user is looking at, captured before the save. The save hands
    // back the store's set; if that differs (a file staged or dropped behind
    // the composer's back), stop here and show it rather than send it. The
    // backend holds Send to the same ids.
    const shown = staged.map((a) => a.staged_id).sort();
    const saved = await saveDraft();
    if (!saved) {
      setBusy("");
      return;
    }
    const kept = (saved.staged ?? []).map((a) => a.staged_id).sort();
    if (shown.length !== kept.length || shown.some((id, i) => id !== kept[i])) {
      setBusy("");
      setError(t("mail.attachmentsChangedBeforeSend"));
      return;
    }
    const result = await mailDraftSend(saved.id, kept, { sign, encrypt }).catch((err) => {
      setError(typeof err === "string" ? err : String(err));
      return null;
    });
    setBusy("");
    if (!result) return;
    if (result.error) {
      // Phase 3 sends directly and surfaces the failure — there is no retrying
      // outbox yet, so the message stays on screen rather than vanishing.
      // The backend's half of the reviewed-set binding (`mail_draft_send`
      // refuses a set that differs from `stagedIds`) says the same as ours.
      setError(
        result.error.includes("attachments changed")
          ? t("mail.attachmentsChangedBeforeSend")
          : `${t("mail.sendFailed")} ${result.error}`,
      );
      return;
    }
    setStatus(t("mail.sent"));
    // The send collected its recipients into the address book.
    void useMailStore.getState().loadContacts();
    onClose();
  }

  const form = (
        <div className="dialog-scroll">
          {draft?.origin && (
            <div className="mail-agent-banner" role="note">
              <strong>
                {t(draft.origin === "reader" ? "mail.agentDraftReaderBanner" : "mail.agentDraftBanner")}
              </strong>{" "}
              {t("mail.agentDraftBannerHint")}
              {parseRecipients(to).length === 0 && <div>{t("mail.agentDraftNoRecipient")}</div>}
              {/* A reader's recipients are the people on the replied-to mail —
                  the sender of a hostile message among them. The one thing Send
                  cannot check is whose text the body carries. */}
              {draft.origin === "reader" && parseRecipients(to).length > 0 && (
                <div><WarningIcon /> {t("mail.agentDraftReaderRecipients")}</div>
              )}
            </div>
          )}
          {accounts.length > 1 && (
            <label className="mail-field">
              <span className="mail-field-label">{t("mail.from")}</span>
              <select className="mail-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                {/* Several accounts often share one label (the owner's name),
                    so the address rides along here. Display only — the value
                    is the account id and the sent From: is untouched. */}
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label && a.label !== a.address ? `${a.label} <${a.address}>` : a.address}
                  </option>
                ))}
              </select>
            </label>
          )}
          {suggestions.length > 0 && (
            <div className="mail-suggested">
              {suggestions.map((address) => (
                <span key={address} className="mail-suggested-pill">
                  <span>{t("mail.agentSuggests", { address: stripFormatControls(address) })}</span>
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => addSuggestion(address)}
                  >
                    {t("mail.agentSuggestsAdd")}
                  </button>
                  <UntestedTag id="mail.agentSuggestedRecipient" />
                </span>
              ))}
            </div>
          )}
          {/* Address-book autocomplete; still plain parsed text underneath. */}
          <MailRecipientField
            label={t("mail.to")}
            className="mail-compose-to"
            rows={2}
            autoFocus
            value={to}
            onChange={setTo}
          />
          <MailRecipientField label={t("mail.cc")} value={cc} onChange={setCc} />
          <MailRecipientField label={t("mail.bcc")} value={bcc} onChange={setBcc} />
          <div className="settings-help">{t("mail.composeRecipientsHint")}</div>

          <label className="mail-field">
            <span className="mail-field-label">{t("mail.subject")}</span>
            <input
              className="mail-input"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          {canFormalize && (
            <div className="mail-ai-notes">
              <label className="mail-field">
                <span className="mail-field-label">
                  {t("mailAi.notesLabel")} <UntestedTag id="mailAi.notesLabel" />
                </span>
                <textarea
                  className="mail-input mail-textarea"
                  rows={3}
                  spellCheck={false}
                  placeholder={t("mailAi.notesPlaceholder")}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <div className="mail-ai-notes-row">
                <label className="mail-field-inline">
                  <span className="mail-field-label">{t("mailAi.toneLabel")}</span>
                  <select
                    className="mail-input"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                  >
                    <option value="">{t("mailAi.toneNeutral")}</option>
                    <option value="formal">{t("mailAi.toneFormal")}</option>
                    <option value="friendly">{t("mailAi.toneFriendly")}</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="settings-btn"
                  disabled={drafting || !notes.trim()}
                  onClick={() => void draftFromNotes()}
                >
                  {drafting ? t("mailAi.drafting") : t("mailAi.draftFromNotes")}
                </button>
              </div>
            </div>
          )}
          <textarea
            className="mail-input mail-compose-body"
            rows={14}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />

          <div className="mail-attach-row">
            <button
              type="button"
              className="settings-btn"
              disabled={busy !== ""}
              onClick={() => void doAttach()}
            >
              {busy === "attach" ? t("mail.attaching") : t("mail.attach")}
            </button>
            <span className="settings-help">{t("mail.attachHint")}</span>
          </div>
          {staged.length > 0 && (
            <div className="mail-staged">
              {staged.map((a) => {
                // An agent's file names its source (project/relative path), so
                // a `paper.pdf` from one project is not taken for another's.
                const agent = a.origin === "agent";
                return (
                  <span
                    key={a.staged_id}
                    className={`mail-staged-chip${agent ? " agent" : ""}`}
                    title={agent ? t("mail.agentAttachmentTitle") : undefined}
                  >
                    {agent && <span className="mail-agent-mark">{t("mail.agentAttachmentMark")}</span>}
                    {stripFormatControls(agent ? (a.source ?? a.filename) : a.filename)}
                    <span className="mail-staged-size">{formatSize(a.size)}</span>
                    {agent && <UntestedTag id="mail.agentAttachmentChip" />}
                    {agent && draftId && (
                      <button
                        type="button"
                        className="mail-staged-preview"
                        onClick={() => void togglePreview(a.staged_id)}
                      >
                        {preview?.stagedId === a.staged_id
                          ? t("mail.attachmentHidePreview")
                          : t("mail.attachmentPreview")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="mail-staged-remove"
                      title={t("mail.removeAttachment")}
                      onClick={() => void doRemoveAttachment(a.staged_id)}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {preview && staged.some((a) => a.staged_id === preview.stagedId) && (
            <AttachmentPreview blob={preview.blob} />
          )}

          {/* Offered only where it can actually be honoured: the keyring needs
              an encrypted local store, and a checkbox that fails on click is
              worse than one that is not there. */}
          {pgpReady && (
            <div className="mail-compose-crypto">
              <label className="mail-field-row">
                <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} />
                <span>{t("mail.crypto.signThis")}</span>
              </label>
              <label className="mail-field-row">
                <input
                  type="checkbox"
                  checked={encrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                />
                <span>{t("mail.crypto.encryptThis")}</span>
              </label>
              {encrypt && (
                <p className="mail-note">{t("mail.crypto.encryptSubjectVisible")}</p>
              )}
              {quotesDecrypted && !encrypt && (
                <div className="mail-warning-strip">{t("mail.crypto.quotesDecrypted")}</div>
              )}
              {/* Named, before the click. The send would refuse anyway — the
                  backend never downgrades to plaintext — but a refusal after the
                  message is written is a worse way to learn it. */}
              {encrypt && missingKeys.length > 0 && (
                <div className="mail-warning-strip">
                  {t("mail.crypto.missingKeys", { who: missingKeys.join(", ") })}
                </div>
              )}
            </div>
          )}

          {status && <div className="mail-note">{status}</div>}
          {error && <ErrorNote className="project-dialog-error" error={error} />}

          <div className="mail-dialog-actions">
            {embedded && <UntestedTag id="mailComposeDialog.1" />}
            <button type="button" className="settings-btn" onClick={onCancel ?? onClose}>
              {t("common.cancel")}
            </button>
            {draft && (
              <button
                type="button"
                className="settings-btn"
                disabled={busy !== ""}
                onClick={() => void doDiscard()}
              >
                {t("mail.discardDraft")}
              </button>
            )}
            <button
              type="button"
              className="settings-btn"
              disabled={busy !== ""}
              onClick={() => void doSaveDraft()}
            >
              {t("mail.saveDraft")}
            </button>
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy !== ""}
              onClick={() => void doSend()}
            >
              {busy === "send" ? t("mail.sending") : t("mail.send")}
            </button>
          </div>
        </div>
  );

  if (embedded) {
    return (
      <div className="mail-compose-tab">
        <div className="mail-compose-tab-form">{form}</div>
      </div>
    );
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog mail-compose-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>
            {composeTitle(t, mode)} <UntestedTag id="mailComposeDialog.1" />
          </h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        {form}
      </div>
    </div>,
    document.body,
  );
}

/** The subject a composer opens with — "Re: …" / "Fwd: …" off the source
 *  message, empty for a new mail. Also a reply or forward tab's label before
 *  anything is typed. */
export function composeSubject(
  t: ReturnType<typeof useT>,
  mode: ComposeMode,
  header: MailHeader | undefined,
): string {
  const base = stripFormatControls(header?.subject ?? "");
  return mode === "reply" || mode === "replyAll"
    ? base.toLowerCase().startsWith("re:")
      ? base
      : `${t("mail.replyPrefix")}${base}`
    : mode === "forward"
      ? `${t("mail.forwardPrefix")}${base}`
      : "";
}

/** The composer's name for what it is writing — the dialog's title and the
 *  label of a composer tab that has no subject yet. */
export function composeTitle(t: ReturnType<typeof useT>, mode: ComposeMode): string {
  return mode === "reply"
    ? t("mail.composeReply")
    : mode === "replyAll"
      ? t("mail.composeReplyAll")
      : mode === "forward"
        ? t("mail.composeForward")
        : t("mail.composeNew");
}
