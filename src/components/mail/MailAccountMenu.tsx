import { useRef, useState } from "react";
import { accountInboxUnread, useMailStore } from "../../stores/mail";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { PencilIcon } from "../common/icons/Icon";

/**
 * The mail window's account switcher: a ▾ pill in the title bar, right of the
 * ✉, naming the account the Inbox tab is showing. It replaced the row of
 * account chips in the pane's header band — which mailbox you are in is the
 * window's question, not one folder list's.
 *
 * A row opens that account's inbox (`openAccountView`, the header ✉ menu's
 * action, so it also brings the Inbox tab forward); its ✎ opens the account
 * editor; Add account is the last entry. The editor is the store's
 * `accountDialog`, hosted by `MailPane`, so there is still one editor.
 *
 * Rows are marked by the header menu's rule: current only while a folder of
 * that account is on screen, never behind a cross-account priority list.
 */
export function MailAccountMenu() {
  const t = useT();
  const accounts = useMailStore((s) => s.accounts);
  const foldersByAccount = useMailStore((s) => s.foldersByAccount);
  const selectedAccountId = useMailStore((s) => s.selectedAccountId);
  const selectedPriority = useMailStore((s) => s.selectedPriority);
  const ref = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const selected = accounts.find((a) => a.id === selectedAccountId);
  // The local nickname first, `label` (the From: name) as the fallback — the
  // header menu's order.
  const nameOf = (a: (typeof accounts)[number]) =>
    a.display_name || a.label || a.address;

  const toggle = () => {
    if (anchor) return setAnchor(null);
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4 });
  };
  const close = () => setAnchor(null);

  return (
    <>
      <button
        type="button"
        ref={ref}
        className="root-overlay-rights mail-account-trigger"
        aria-expanded={anchor != null}
        title={
          selected
            ? `${t("mail.switchAccount")} — ${selected.address}`
            : t("mail.switchAccount")
        }
        onClick={toggle}
      >
        <span className="mail-account-trigger-name">
          {selected ? nameOf(selected) : t("mail.accounts")}
        </span>{" "}
        ▾
      </button>
      <UntestedTag id="mail.accountMenu" />
      {anchor && (
        <ContextMenuPortal
          x={anchor.x}
          y={anchor.y}
          keepBelow
          className="tab-new-menu mail-indicator-menu mail-account-menu"
          onClose={close}
        >
          <div className="tab-new-menu-group-label">{t("mail.accounts")}</div>
          <div className="menu-scroll-region">
            {accounts.length === 0 && (
              <div className="tab-new-menu-hint">{t("mail.noAccounts")}</div>
            )}
            {accounts.map((a) => {
              const name = nameOf(a);
              // Inbox only, as the ✉'s dot and its menu count.
              const count = accountInboxUnread(foldersByAccount[a.id]);
              return (
                <div key={a.id} className="mail-account-menu-row">
                  <button
                    type="button"
                    className={`tab-new-menu-item mail-menu-row${
                      a.id === selectedAccountId && !selectedPriority
                        ? " selected"
                        : ""
                    }`}
                    title={t("mail.menuOpenAccount", { name: a.address })}
                    onClick={() => {
                      close();
                      void useMailStore.getState().openAccountView(a.id);
                    }}
                  >
                    <span className="mail-menu-name">{name}</span>
                    {count > 0 && (
                      <span className="mail-menu-badge unread">{count}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="machines-row-action"
                    title={t("mail.editAccountNamed", { name })}
                    aria-label={t("mail.editAccountNamed", { name })}
                    onClick={() => {
                      close();
                      useMailStore.getState().openAccountDialog(a);
                    }}
                  >
                    <PencilIcon />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="tab-new-menu-item mail-menu-row mail-account-menu-add"
              onClick={() => {
                close();
                useMailStore.getState().openAccountDialog(null);
              }}
            >
              <span className="mail-menu-name">{t("mail.addAccount")}</span>
            </button>
          </div>
        </ContextMenuPortal>
      )}
    </>
  );
}
