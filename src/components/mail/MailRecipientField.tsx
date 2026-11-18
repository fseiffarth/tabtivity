import { isTabKey } from "../../lib/shortcuts/keyNames";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import {
  fieldAddresses,
  replaceToken,
  suggestRecipients,
  tokenAt,
  type RecipientSuggestion,
  type RecipientToken,
} from "../../lib/mailContacts";
import { useMailStore } from "../../stores/mail";
import { UntestedTag } from "../common/UntestedTag";

/**
 * A composer recipient field (To / Cc / Bcc) with address-book autocomplete —
 * Thunderbird's: type part of a name, nickname or address and pick from the
 * cards and lists that match. A list expands to its members' addresses.
 *
 * Still a plain textarea underneath, parsed by `parseRecipients`: the
 * suggestions insert **bare addresses** and nothing else, so everything the
 * composer already guarantees about a recipient (one address, no line break,
 * validated again at send) holds for a picked one too.
 *
 * Keys while the list is open: ↑/↓ move, Enter or Tab take the highlighted
 * entry, Escape closes the list (and only the list — the mail window stays).
 */
export function MailRecipientField({
  label,
  value,
  onChange,
  rows = 1,
  autoFocus,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
}) {
  const t = useT();
  const contacts = useMailStore((s) => s.contacts);
  const lists = useMailStore((s) => s.contactLists);
  const loaded = useMailStore((s) => s.contactsLoaded);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [token, setToken] = useState<RecipientToken | null>(null);
  const [items, setItems] = useState<RecipientSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    if (!loaded) void useMailStore.getState().loadContacts();
  }, [loaded]);

  // The caret goes after the inserted addresses once React has written the
  // new value; setting it before would land it in the old text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function refresh(text: string, caret: number) {
    const tok = tokenAt(text, caret);
    if (!tok.text.trim()) {
      close();
      return;
    }
    // What the other recipients already are — the word being typed is not one.
    const others = fieldAddresses(text.slice(0, tok.start) + text.slice(tok.end));
    const next = suggestRecipients(tok.text, contacts, lists, others);
    setToken(tok);
    setItems(next);
    setActive(0);
  }

  function close() {
    setToken(null);
    setItems([]);
  }

  function accept(s: RecipientSuggestion) {
    if (!token) return;
    const addresses = s.kind === "contact" ? [s.address] : s.members;
    const next = replaceToken(value, token, addresses);
    pendingCaret.current = next.caret;
    onChange(next.value);
    close();
    ref.current?.focus();
  }

  const open = items.length > 0 && token !== null;

  return (
    <label className="mail-field">
      <span className="mail-field-label">{label}</span>
      <div className="mail-recipient-wrap">
        <textarea
          ref={ref}
          className={`mail-input mail-textarea${className ? ` ${className}` : ""}`}
          rows={rows}
          autoFocus={autoFocus}
          spellCheck={false}
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onBlur={close}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + step + items.length) % items.length);
            } else if (e.key === "Enter" || isTabKey(e)) {
              e.preventDefault();
              accept(items[active]);
            } else if (e.key === "Escape") {
              // The list's Escape, not the mail window's.
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
        {open && (
          <ul className="mail-recipient-suggest" role="listbox" id={listId} aria-label={label}>
            {items.map((s, i) => (
              <li
                key={s.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`mail-recipient-option${i === active ? " active" : ""}`}
                // Keep the textarea focused: a blur would close the list first.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => accept(s)}
              >
                {s.kind === "contact" ? (
                  <>
                    {s.name && <span className="mail-recipient-name">{s.name}</span>}
                    <span className="mail-recipient-address">{s.address}</span>
                  </>
                ) : (
                  <>
                    <span className="mail-recipient-list-mark" aria-hidden="true">
                      ☰
                    </span>
                    <span className="mail-recipient-name">{s.name}</span>
                    <span className="mail-recipient-address">
                      {t("mail.contacts.listMembers", { count: s.members.length })}
                    </span>
                  </>
                )}
              </li>
            ))}
            <li className="mail-recipient-untested" aria-hidden="true">
              <UntestedTag id="mail.contacts.autocomplete" />
            </li>
          </ul>
        )}
      </div>
    </label>
  );
}
