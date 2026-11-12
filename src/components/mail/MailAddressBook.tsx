import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import {
  mailContactListDelete,
  mailContactListUpsert,
  mailContactUpsert,
  mailContactsDelete,
  mailContactsExport,
  mailContactsHarvestInbox,
  mailContactsImport,
  mailContactsImportThunderbird,
  mailContactsSetCollect,
  stripFormatControls,
} from "../../lib/mail";
import {
  contactLabel,
  contactMatches,
  contactName,
  findContactByEmail,
  sortContacts,
} from "../../lib/mailContacts";
import { useMailStore, type MailContactsTab } from "../../stores/mail";
import type {
  MailContact,
  MailContactBook,
  MailContactList,
  MailContactPhone,
  MailContactsImportReport,
} from "../../types/mail";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { useDialogs } from "../common/PromptDialogs";
import { MailRecipientField } from "./MailRecipientField";
import { parseRecipients } from "./MailComposeDialog";
import { CloseIcon } from "../common/icons/Icon";

/**
 * The Address Book — the mail window's Thunderbird-style contacts tab.
 *
 * Three columns: the books and lists (rail), the cards of the chosen book
 * (searchable), and the chosen card or list — read-only until Edit. Two books,
 * as Thunderbird has them: **Personal**, which only the user writes, and
 * **Collected**, which every successful send fills with addresses no card
 * holds yet (switchable). Mailing lists expand to their members in a
 * recipient field.
 *
 * Everything is `contacts.json` through the store's one copy — the composer's
 * autocomplete reads the same copy, so a card saved here is suggested at once.
 * Import/export are vCard, with the file dialog raised by the backend.
 */

type Scope = "all" | MailContactBook;
type Selection = { kind: "contact"; id: string } | { kind: "list"; id: string } | null;
type Editing =
  | { kind: "contact"; draft: MailContact }
  | { kind: "list"; draft: MailContactList }
  | null;

const PHONE_KINDS: Array<{ value: string; key: TranslationKey }> = [
  { value: "mobile", key: "mail.contacts.phoneKind.mobile" },
  { value: "work", key: "mail.contacts.phoneKind.work" },
  { value: "home", key: "mail.contacts.phoneKind.home" },
  { value: "fax", key: "mail.contacts.phoneKind.fax" },
  { value: "pager", key: "mail.contacts.phoneKind.pager" },
  { value: "", key: "mail.contacts.phoneKind.other" },
];

function blankContact(book: MailContactBook = "personal"): MailContact {
  return {
    id: "",
    book,
    display_name: "",
    first_name: "",
    last_name: "",
    nickname: "",
    emails: [""],
    phones: [],
    organization: "",
    job_title: "",
    address: "",
    website: "",
    birthday: "",
    notes: "",
    popularity: 0,
    last_used: 0,
    created: 0,
    updated: 0,
  };
}

function blankList(): MailContactList {
  return { id: "", name: "", nickname: "", description: "", members: [] };
}

function errText(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}

export function MailAddressBook({ tab }: { tab: MailContactsTab }) {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const contacts = useMailStore((s) => s.contacts);
  const lists = useMailStore((s) => s.contactLists);
  const collectOutgoing = useMailStore((s) => s.collectOutgoing);
  const loaded = useMailStore((s) => s.contactsLoaded);
  const loadError = useMailStore((s) => s.contactsError);
  const accounts = useMailStore((s) => s.accounts);
  const selectedAccountId = useMailStore((s) => s.selectedAccountId);
  const writeAccount = selectedAccountId ?? accounts[0]?.id ?? null;

  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) void useMailStore.getState().loadContacts();
  }, [loaded]);

  // "Add to address book" from a message: the card that holds the address, or
  // a new one for it. Waits for the first load so it can tell which.
  const requestSeq = tab.request?.seq;
  useEffect(() => {
    const req = tab.request;
    if (!req || !loaded) return;
    const known = findContactByEmail(useMailStore.getState().contacts, req.address);
    setError("");
    setStatus("");
    if (known) {
      setScope("all");
      setQuery("");
      setEditing(null);
      setSelection({ kind: "contact", id: known.id });
    } else {
      setEditing({
        kind: "contact",
        draft: { ...blankContact(), display_name: req.name ?? "", emails: [req.address] },
      });
    }
    // One request per `seq`; the object itself is replaced on every open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSeq, loaded]);

  const counts = useMemo(
    () => ({
      all: contacts.length,
      personal: contacts.filter((c) => c.book === "personal").length,
      collected: contacts.filter((c) => c.book === "collected").length,
    }),
    [contacts],
  );
  const rows = useMemo(
    () =>
      sortContacts(
        contacts.filter((c) => (scope === "all" || c.book === scope) && contactMatches(c, query)),
      ),
    [contacts, scope, query],
  );
  const sortedLists = useMemo(
    () => [...lists].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [lists],
  );
  const selectedContact =
    selection?.kind === "contact" ? contacts.find((c) => c.id === selection.id) : undefined;
  const selectedList =
    selection?.kind === "list" ? lists.find((l) => l.id === selection.id) : undefined;

  const reload = () => useMailStore.getState().loadContacts();

  function write(addresses: string[]) {
    if (!writeAccount || addresses.length === 0) return;
    useMailStore
      .getState()
      .openComposeTab({ mode: "new", accountId: writeAccount, toAddress: addresses.join(", ") });
  }

  async function run<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      return await work();
    } catch (err) {
      setError(errText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveContact(draft: MailContact) {
    const saved = await run(() => mailContactUpsert(draft));
    if (!saved) return;
    await reload();
    setEditing(null);
    setSelection({ kind: "contact", id: saved.id });
  }

  async function saveList(draft: MailContactList) {
    const saved = await run(() => mailContactListUpsert(draft));
    if (!saved) return;
    await reload();
    setEditing(null);
    setSelection({ kind: "list", id: saved.id });
  }

  async function deleteContact(c: MailContact) {
    const ok = await confirmAction({
      title: t("mail.contacts.deleteTitle"),
      body: t("mail.contacts.deleteBody", { name: contactLabel(c) }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    if ((await run(() => mailContactsDelete([c.id]))) === null) return;
    await reload();
    setSelection(null);
  }

  async function deleteList(l: MailContactList) {
    const ok = await confirmAction({
      title: t("mail.contacts.deleteListTitle"),
      body: t("mail.contacts.deleteListBody", { name: stripFormatControls(l.name) }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    if ((await run(() => mailContactListDelete(l.id))) === null) return;
    await reload();
    setSelection(null);
  }

  async function doImport(work: () => Promise<MailContactsImportReport> = mailContactsImport) {
    const report = await run(work);
    if (!report || report.cancelled) return;
    await reload();
    const counts = { added: report.added, merged: report.merged, skipped: report.skipped };
    setStatus(
      report.lists
        ? t("mail.contacts.importDoneLists", { ...counts, lists: report.lists })
        : t("mail.contacts.importDone", counts),
    );
  }

  async function doHarvest() {
    const report = await run(() => mailContactsHarvestInbox());
    if (!report) return;
    await reload();
    setStatus(
      t("mail.contacts.fromInboxDone", {
        added: report.added,
        merged: report.merged,
        skipped: report.skipped,
      }),
    );
  }

  async function doExport(ids: string[] = []) {
    const count = await run(() => mailContactsExport(ids));
    if (count) setStatus(t("mail.contacts.exportDone", { count }));
  }

  async function setCollect(enabled: boolean) {
    if ((await run(() => mailContactsSetCollect(enabled))) === null) return;
    await reload();
  }

  const scopes: Array<{ id: Scope; key: TranslationKey; count: number }> = [
    { id: "all", key: "mail.contacts.allBooks", count: counts.all },
    { id: "personal", key: "mail.contacts.personal", count: counts.personal },
    { id: "collected", key: "mail.contacts.collected", count: counts.collected },
  ];

  return (
    <div className="mail-abook">
      <div className="mail-toolbar">
        <span className="mail-toolbar-title">
          {t("mail.contacts.title")} <UntestedTag id="mail.contacts.title" />
        </span>
        <button
          type="button"
          className="settings-btn primary"
          disabled={busy}
          onClick={() => {
            setSelection(null);
            setEditing({ kind: "contact", draft: blankContact() });
          }}
        >
          {t("mail.contacts.newContact")}
        </button>
        <button
          type="button"
          className="settings-btn"
          disabled={busy}
          onClick={() => {
            setSelection(null);
            setEditing({ kind: "list", draft: blankList() });
          }}
        >
          {t("mail.contacts.newList")}
        </button>
        <span className="mail-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          className="settings-btn"
          disabled={busy}
          title={t("mail.contacts.fromInboxHint")}
          onClick={() => void doHarvest()}
        >
          {t("mail.contacts.fromInbox")}
        </button>
        <UntestedTag id="mail.contacts.fromInbox" />
        <span className="mail-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          className="settings-btn"
          disabled={busy}
          title={t("mail.contacts.importHint")}
          onClick={() => void doImport()}
        >
          {t("mail.contacts.import")}
        </button>
        <button
          type="button"
          className="settings-btn"
          disabled={busy}
          title={t("mail.contacts.importThunderbirdHint")}
          onClick={() => void doImport(mailContactsImportThunderbird)}
        >
          {t("mail.contacts.importThunderbird")}
        </button>
        <UntestedTag id="mail.contacts.thunderbird" />
        <button
          type="button"
          className="settings-btn"
          disabled={busy || contacts.length === 0}
          onClick={() => void doExport()}
        >
          {t("mail.contacts.export")}
        </button>
        <UntestedTag id="mail.contacts.importExport" />
        <div className="mail-toolbar-spacer" />
      </div>

      {loadError && (
        <div className="mail-error-strip">{t("mail.contacts.loadError", { error: loadError })}</div>
      )}
      {error && (
        <div className="mail-error-strip">
          <span>{error}</span>
          <button type="button" className="settings-btn" onClick={() => setError("")}>
            {t("mail.dismissError")}
          </button>
        </div>
      )}
      {status && <div className="mail-note mail-abook-status">{status}</div>}

      <div className="mail-body-row">
        <nav className="mail-rail mail-abook-rail">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`mail-rail-folder${scope === s.id ? " selected" : ""}`}
              onClick={() => setScope(s.id)}
            >
              <span className="mail-rail-folder-name">{t(s.key)}</span>
              {s.count > 0 && <span className="mail-rail-badge">{s.count}</span>}
            </button>
          ))}
          <div className="mail-rail-title">{t("mail.contacts.lists")}</div>
          {sortedLists.length === 0 && (
            <div className="mail-rail-hint">{t("mail.contacts.noLists")}</div>
          )}
          {sortedLists.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`mail-rail-folder${
                selection?.kind === "list" && selection.id === l.id ? " selected" : ""
              }`}
              onClick={() => {
                setEditing(null);
                setSelection({ kind: "list", id: l.id });
              }}
            >
              <span aria-hidden="true">☰</span>
              <span className="mail-rail-folder-name">{stripFormatControls(l.name)}</span>
              <span className="mail-rail-badge">{l.members.length}</span>
            </button>
          ))}
          <div className="mail-abook-collect">
            <label className="mail-abook-collect-row">
              <Toggle
                checked={collectOutgoing}
                disabled={busy}
                onChange={(e) => void setCollect(e.target.checked)}
              />
              <span>{t("mail.contacts.collectToggle")}</span>
            </label>
            <div className="mail-rail-hint">{t("mail.contacts.collectHint")}</div>
          </div>
        </nav>

        <div className="mail-abook-list">
          <div className="mail-list-filter">
            <input
              className="mail-input mail-search"
              type="search"
              placeholder={t("mail.contacts.search")}
              aria-label={t("mail.contacts.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="mail-list-rows" role="listbox" aria-label={t("mail.contacts.title")}>
            {rows.length === 0 && (
              <div className="mail-empty mail-abook-empty">
                {contacts.length === 0 ? t("mail.contacts.empty") : t("mail.contacts.noMatch")}
              </div>
            )}
            {rows.map((c) => {
              const selected = selection?.kind === "contact" && selection.id === c.id;
              const name = contactName(c);
              return (
                <div
                  key={c.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={selected}
                  className={`mail-row mail-abook-row${selected ? " selected" : ""}`}
                  onClick={() => {
                    setEditing(null);
                    setSelection({ kind: "contact", id: c.id });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setEditing(null);
                      setSelection({ kind: "contact", id: c.id });
                    }
                  }}
                >
                  <div className="mail-abook-row-name">
                    {name || c.emails[0] || stripFormatControls(c.organization) || t("mail.contacts.unnamed")}
                    {c.book === "collected" && (
                      <span className="mail-abook-badge">{t("mail.contacts.collectedBadge")}</span>
                    )}
                  </div>
                  {name && c.emails[0] && <div className="mail-abook-row-sub">{c.emails[0]}</div>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mail-abook-card">
          {editing?.kind === "contact" ? (
            <ContactEditor
              key={editing.draft.id || "new"}
              initial={editing.draft}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(draft) => void saveContact(draft)}
            />
          ) : editing?.kind === "list" ? (
            <ListEditor
              key={editing.draft.id || "new"}
              initial={editing.draft}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(draft) => void saveList(draft)}
            />
          ) : selectedContact ? (
            <ContactCard
              contact={selectedContact}
              canWrite={writeAccount !== null}
              busy={busy}
              onEdit={() => setEditing({ kind: "contact", draft: { ...selectedContact } })}
              onWrite={(address) => write([address])}
              onDelete={() => void deleteContact(selectedContact)}
              onPromote={() => void saveContact({ ...selectedContact, book: "personal" })}
              onExport={() => void doExport([selectedContact.id])}
            />
          ) : selectedList ? (
            <ListCard
              list={selectedList}
              contacts={contacts}
              canWrite={writeAccount !== null}
              busy={busy}
              onEdit={() => setEditing({ kind: "list", draft: { ...selectedList } })}
              onWrite={() => write(selectedList.members)}
              onDelete={() => void deleteList(selectedList)}
            />
          ) : (
            <div className="mail-empty mail-abook-empty">{t("mail.contacts.nothingSelected")}</div>
          )}
        </div>
      </div>
      {dialogs}
    </div>
  );
}

// ── Read-only card ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mail-abook-field">
      <div className="mail-field-label">{label}</div>
      <div className="mail-abook-value">{children}</div>
    </div>
  );
}

function ContactCard({
  contact: c,
  canWrite,
  busy,
  onEdit,
  onWrite,
  onDelete,
  onPromote,
  onExport,
}: {
  contact: MailContact;
  canWrite: boolean;
  busy: boolean;
  onEdit: () => void;
  onWrite: (address: string) => void;
  onDelete: () => void;
  onPromote: () => void;
  onExport: () => void;
}) {
  const t = useT();
  const phoneLabel = (p: MailContactPhone) => {
    const k = PHONE_KINDS.find((x) => x.value === p.kind);
    return k ? t(k.key) : stripFormatControls(p.kind);
  };
  const subtitle = [c.job_title, c.organization].filter(Boolean).map(stripFormatControls).join(" · ");
  return (
    <div className="mail-abook-detail">
      <div className="mail-abook-head">
        <h2 className="mail-abook-name">{contactName(c) || c.emails[0] || t("mail.contacts.unnamed")}</h2>
        {c.book === "collected" && (
          <span className="mail-abook-badge">{t("mail.contacts.collectedBadge")}</span>
        )}
      </div>
      {subtitle && <div className="mail-abook-subtitle">{subtitle}</div>}
      {c.nickname && (
        <Field label={t("mail.contacts.nickname")}>{stripFormatControls(c.nickname)}</Field>
      )}
      {c.emails.length > 0 && (
        <Field label={t("mail.contacts.emails")}>
          {c.emails.map((e) => (
            <div key={e} className="mail-abook-email">
              <span className="mail-abook-address">{e}</span>
              <button
                type="button"
                className="settings-btn sm"
                disabled={!canWrite}
                onClick={() => onWrite(e)}
              >
                {t("mail.contacts.write")}
              </button>
            </div>
          ))}
        </Field>
      )}
      {c.phones.length > 0 && (
        <Field label={t("mail.contacts.phones")}>
          {c.phones.map((p, i) => (
            <div key={i}>
              <span className="mail-abook-phone-kind">{phoneLabel(p)}</span>{" "}
              {stripFormatControls(p.number)}
            </div>
          ))}
        </Field>
      )}
      {c.address && (
        <Field label={t("mail.contacts.address")}>
          <div className="mail-abook-pre">{stripFormatControls(c.address)}</div>
        </Field>
      )}
      {c.website && <Field label={t("mail.contacts.website")}>{stripFormatControls(c.website)}</Field>}
      {c.birthday && <Field label={t("mail.contacts.birthday")}>{c.birthday}</Field>}
      {c.notes && (
        <Field label={t("mail.contacts.notes")}>
          <div className="mail-abook-pre">{stripFormatControls(c.notes)}</div>
        </Field>
      )}
      {c.popularity > 0 && (
        <div className="mail-rail-hint">{t("mail.contacts.sentCount", { count: c.popularity })}</div>
      )}
      <div className="mail-dialog-actions mail-abook-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={onDelete}>
          {t("common.delete")}
        </button>
        <button type="button" className="settings-btn" disabled={busy} onClick={onExport}>
          {t("mail.contacts.exportOne")}
        </button>
        {c.book === "collected" && (
          <button type="button" className="settings-btn" disabled={busy} onClick={onPromote}>
            {t("mail.contacts.moveToPersonal")}
          </button>
        )}
        <button type="button" className="settings-btn primary" disabled={busy} onClick={onEdit}>
          {t("mail.contacts.edit")}
        </button>
      </div>
    </div>
  );
}

function ListCard({
  list,
  contacts,
  canWrite,
  busy,
  onEdit,
  onWrite,
  onDelete,
}: {
  list: MailContactList;
  contacts: MailContact[];
  canWrite: boolean;
  busy: boolean;
  onEdit: () => void;
  onWrite: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="mail-abook-detail">
      <div className="mail-abook-head">
        <h2 className="mail-abook-name">☰ {stripFormatControls(list.name)}</h2>
      </div>
      {list.nickname && (
        <Field label={t("mail.contacts.nickname")}>{stripFormatControls(list.nickname)}</Field>
      )}
      {list.description && (
        <Field label={t("mail.contacts.listDescription")}>
          <div className="mail-abook-pre">{stripFormatControls(list.description)}</div>
        </Field>
      )}
      <Field label={t("mail.contacts.listMembers", { count: list.members.length })}>
        {list.members.map((m) => {
          const known = findContactByEmail(contacts, m);
          const name = known ? contactName(known) : "";
          return (
            <div key={m} className="mail-abook-email">
              {name && <span className="mail-recipient-name">{name}</span>}
              <span className="mail-abook-address">{m}</span>
            </div>
          );
        })}
      </Field>
      <div className="mail-dialog-actions mail-abook-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={onDelete}>
          {t("common.delete")}
        </button>
        <button type="button" className="settings-btn" disabled={busy} onClick={onEdit}>
          {t("mail.contacts.edit")}
        </button>
        <button
          type="button"
          className="settings-btn primary"
          disabled={busy || !canWrite || list.members.length === 0}
          onClick={onWrite}
        >
          {t("mail.contacts.writeToList")}
        </button>
      </div>
    </div>
  );
}

// ── Editors ──────────────────────────────────────────────────────────────────

function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
}) {
  return (
    <label className="mail-field">
      <span className="mail-field-label">{label}</span>
      <input
        className="mail-input"
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="mail-field-hint">{hint}</span>}
    </label>
  );
}

function ContactEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: MailContact;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: MailContact) => void;
}) {
  const t = useT();
  const [d, setD] = useState<MailContact>(() => ({
    ...initial,
    emails: initial.emails.length ? initial.emails : [""],
  }));
  const set = <K extends keyof MailContact>(k: K, v: MailContact[K]) => setD((x) => ({ ...x, [k]: v }));
  const setEmail = (i: number, v: string) =>
    setD((x) => ({ ...x, emails: x.emails.map((e, j) => (j === i ? v : e)) }));
  const setPhone = (i: number, p: Partial<MailContactPhone>) =>
    setD((x) => ({ ...x, phones: x.phones.map((q, j) => (j === i ? { ...q, ...p } : q)) }));

  return (
    <form
      className="mail-abook-detail mail-abook-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...d, emails: d.emails.map((x) => x.trim()).filter(Boolean) });
      }}
    >
      <div className="mail-field-row">
        <TextField label={t("mail.contacts.firstName")} value={d.first_name} onChange={(v) => set("first_name", v)} />
        <TextField label={t("mail.contacts.lastName")} value={d.last_name} onChange={(v) => set("last_name", v)} />
      </div>
      <div className="mail-field-row">
        <TextField
          label={t("mail.contacts.displayName")}
          value={d.display_name}
          placeholder={`${d.first_name} ${d.last_name}`.trim()}
          onChange={(v) => set("display_name", v)}
        />
        <TextField
          label={t("mail.contacts.nickname")}
          value={d.nickname}
          hint={t("mail.contacts.nicknameHint")}
          onChange={(v) => set("nickname", v)}
        />
      </div>

      <div className="mail-field">
        <span className="mail-field-label">{t("mail.contacts.emails")}</span>
        {d.emails.map((e, i) => (
          <div key={i} className="mail-abook-multi">
            <input
              className="mail-input"
              type="email"
              spellCheck={false}
              value={e}
              autoFocus={i === 0 && !initial.id && !e}
              onChange={(ev) => setEmail(i, ev.target.value)}
            />
            <button
              type="button"
              className="settings-btn sm"
              title={t("mail.contacts.remove")}
              aria-label={t("mail.contacts.remove")}
              onClick={() => setD((x) => ({ ...x, emails: x.emails.filter((_, j) => j !== i) }))}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-btn sm mail-abook-add"
          onClick={() => setD((x) => ({ ...x, emails: [...x.emails, ""] }))}
        >
          {t("mail.contacts.addEmail")}
        </button>
      </div>

      <div className="mail-field">
        <span className="mail-field-label">{t("mail.contacts.phones")}</span>
        {d.phones.map((p, i) => (
          <div key={i} className="mail-abook-multi">
            <select
              className="mail-input"
              value={PHONE_KINDS.some((k) => k.value === p.kind) ? p.kind : ""}
              onChange={(e) => setPhone(i, { kind: e.target.value })}
            >
              {PHONE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {t(k.key)}
                </option>
              ))}
            </select>
            <input
              className="mail-input"
              type="tel"
              value={p.number}
              onChange={(e) => setPhone(i, { number: e.target.value })}
            />
            <button
              type="button"
              className="settings-btn sm"
              title={t("mail.contacts.remove")}
              aria-label={t("mail.contacts.remove")}
              onClick={() => setD((x) => ({ ...x, phones: x.phones.filter((_, j) => j !== i) }))}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-btn sm mail-abook-add"
          onClick={() => setD((x) => ({ ...x, phones: [...x.phones, { kind: "mobile", number: "" }] }))}
        >
          {t("mail.contacts.addPhone")}
        </button>
      </div>

      <div className="mail-field-row">
        <TextField
          label={t("mail.contacts.organization")}
          value={d.organization}
          onChange={(v) => set("organization", v)}
        />
        <TextField label={t("mail.contacts.jobTitle")} value={d.job_title} onChange={(v) => set("job_title", v)} />
      </div>
      <div className="mail-field-row">
        <TextField label={t("mail.contacts.website")} value={d.website} onChange={(v) => set("website", v)} />
        <TextField
          label={t("mail.contacts.birthday")}
          value={d.birthday}
          placeholder="YYYY-MM-DD"
          hint={t("mail.contacts.birthdayHint")}
          onChange={(v) => set("birthday", v)}
        />
      </div>
      <label className="mail-field">
        <span className="mail-field-label">{t("mail.contacts.address")}</span>
        <textarea
          className="mail-input mail-textarea"
          rows={3}
          value={d.address}
          onChange={(e) => set("address", e.target.value)}
        />
      </label>
      <label className="mail-field">
        <span className="mail-field-label">{t("mail.contacts.notes")}</span>
        <textarea
          className="mail-input mail-textarea"
          rows={4}
          value={d.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </label>
      <label className="mail-field">
        <span className="mail-field-label">{t("mail.contacts.book")}</span>
        <select
          className="mail-input"
          value={d.book}
          onChange={(e) => set("book", e.target.value as MailContactBook)}
        >
          <option value="personal">{t("mail.contacts.personal")}</option>
          <option value="collected">{t("mail.contacts.collected")}</option>
        </select>
      </label>
      <div className="mail-dialog-actions mail-abook-actions">
        <button type="button" className="settings-btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="settings-btn primary" disabled={busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

function ListEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: MailContactList;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: MailContactList) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [nickname, setNickname] = useState(initial.nickname);
  const [description, setDescription] = useState(initial.description);
  const [members, setMembers] = useState(initial.members.join("\n"));
  return (
    <form
      className="mail-abook-detail mail-abook-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...initial, name, nickname, description, members: parseRecipients(members) });
      }}
    >
      <div className="mail-field-row">
        <TextField label={t("mail.contacts.listName")} value={name} onChange={setName} />
        <TextField
          label={t("mail.contacts.nickname")}
          value={nickname}
          hint={t("mail.contacts.nicknameHint")}
          onChange={setNickname}
        />
      </div>
      <label className="mail-field">
        <span className="mail-field-label">{t("mail.contacts.listDescription")}</span>
        <textarea
          className="mail-input mail-textarea"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <MailRecipientField
        label={t("mail.contacts.listMembersField")}
        rows={8}
        value={members}
        onChange={setMembers}
      />
      <div className="mail-field-hint">{t("mail.contacts.listMembersHint")}</div>
      <div className="mail-dialog-actions mail-abook-actions">
        <button type="button" className="settings-btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="settings-btn primary" disabled={busy || !name.trim()}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}
