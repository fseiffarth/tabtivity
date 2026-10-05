import { useCallback, useEffect, useRef } from "react";
import {
  accountInboxUnread,
  backgroundCheckBlocked,
  inboxUnread,
  isAuthRejection,
  useMailStore,
} from "../../stores/mail";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { DEFAULT_MAIL_CHECK_MIN, onMailNew } from "../../lib/mail";
import { useVpnTunnelUp, vpnGateAllows, vpnTunnelUp } from "../../lib/remote/vpn/vpnGate";
import { useT } from "../../lib/i18n";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { MailGlyph } from "./HeaderGlyphs";

const MENU_ID = "mail";

/**
 * The header's mail button — mail as a **global app**, and now the only way in.
 *
 * A mail tab belongs to a scope: you open it in one project, and switching to
 * another leaves it behind. Mail does not belong to a project — its store is one
 * global mailbox — so the tab only ever duplicated this button, and it is gone.
 * What is left is one button in the header, always in the same place, opening
 * `MailPane` as an overlay over whatever is on screen (`MailOverlayHost`).
 *
 * One gate: `mail_client`, the experimental flag that owns the whole feature (off
 * for a non-debug user, so a header slot is not spent on mail for someone who
 * never asked for it). The old `mail_global_app` sub-toggle went with the tab —
 * once the overlay is the only surface, a switch that hides it while leaving the
 * feature "on" can only produce an unreachable mail client.
 *
 * **The badge is unread inbox mail, derived from the local index** — the store's
 * `inboxUnread`, not a counter this component accumulates. That distinction is
 * the whole reason the dot is visible at all: an accumulated count starts at
 * zero on every launch and only ever moves when a sync happens to run *while the
 * window is open*, so mail that arrived overnight — the case a badge exists for
 * — showed nothing. Derived, it is right at first paint (the arrivals are
 * already in the index), it survives a relaunch, and it falls on its own as
 * messages are read rather than needing to be dismissed. Inbox-only, because a
 * folder a filter already sorted into is not something to be alerted about.
 *
 * **The listener is this component's, not the pane's.** The whole point of the
 * badge is to report mail when no mail surface is open, and `MailPane` only
 * listens while it is mounted. It is installed once per window here (the header
 * is always mounted) and is why a popout — which has no header — never
 * double-counts the same delivery. What the event now does is refresh the counts
 * (`noteArrival`), so a delivery moves the dot in the same frame it lands.
 *
 * **The interval check is the one thing here that reaches the network**, and it
 * is gated on this button being on — which is off for everyone by default, so
 * the mail store's "nothing connects on its own" rule still holds for anyone who
 * has not asked for mail in the header. What it is *not* gated on any more is a
 * second opt-in: `mail_check_interval_min` used to default to never, which made
 * the badge unable to light up at all. It counts arrivals a *sync* found, and
 * the only sync left was a manual *Check mail* — a click nearly always made from
 * the overlay, which acknowledges the arrival in the same gesture. So an unset
 * interval now means `DEFAULT_MAIL_CHECK_MIN`; an explicit *Never* is still
 * honoured, because a stored `0` is a choice and only an absent value is unset.
 *
 * The first tick is a whole interval away on purpose: checking at mount would be
 * checking at launch, and a restored window must not open a socket by existing.
 *
 * **A VPN-only account** (`require_vpn`, `lib/remote/vpn/vpnGate.ts`) is skipped by the
 * tick while no tunnel is up — no request, no error, no red button for a server
 * that was never going to answer — and checked the moment a tunnel comes up,
 * since that is when the mail it has been missing becomes reachable. That
 * catch-up is a rising edge on the *reconciled* tunnel state only: the store
 * discovering at launch that a tunnel was up all along is not a tunnel coming
 * up, and must not turn into a check at mount by the back door.
 *
 * **Hovering the button reveals the way *into* a particular mailbox**, not a
 * second copy of the pane's rail. The ✉ opens mail wherever you left it, which
 * for someone with four accounts is a click on the button followed by a hunt down
 * the rail; the dropdown makes the destination the gesture — one click lands the
 * overlay on that account's inbox, or on Important/Urgent, which is why those two
 * are in the same list rather than behind the account they are not owned by (the
 * rail's reason for putting Priority above Accounts, said in a menu).
 *
 * It is **hover-opened**, the shape its header siblings already have
 * (`LocalModelMenu`, `VpnIndicator`): no second button, and the ✉ keeps its one
 * job — a click opens mail. That the pointer alone opens it is affordable here
 * for the one reason it is not on `MachinesIndicator`, whose menu had to be
 * demoted to click: revealing this list **touches no network**. Both reads behind
 * it are local (`refreshUnread`, `refreshPriorityCounts`), so a pointer crossing
 * the header costs nothing — and doing them on reveal rather than at mount is
 * what stops the menu quoting a count the pane has since moved past. A click on a
 * row is still the only thing that selects, so a menu that merely appeared under
 * the pointer changes nothing.
 */
export function MailIndicator() {
  const t = useT();
  const mailClient = useExperimental("mail_client");
  // Shared across every header hover-menu (stores/headerHoverMenu) so switching
  // straight from another one closes it instantly instead of racing its own
  // close-grace timer. `setMenuOpen` mirrors the old local-state setter's
  // boolean signature so the rest of this component reads unchanged.
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setMenuOpen = useCallback(
    (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [openMenu, closeMenu],
  );
  // The hover menu's grace period, so crossing the 4px gap between the button and
  // the list below it does not shut the list you are reaching for.
  const closeTimer = useRef<number | undefined>(undefined);
  const intervalMin = useSettingsStore(
    (s) => s.settings?.mail_check_interval_min ?? DEFAULT_MAIL_CHECK_MIN,
  );
  const unread = useMailStore((s) => inboxUnread(s.foldersByAccount));
  const newCount = useMailStore((s) => s.newCount);
  const overlayOpen = useMailStore((s) => s.overlayOpen);
  // The dropdown's rows. Read unconditionally rather than only while the menu is
  // open: these are already in the store (the badge's own `refreshUnread` puts
  // them there), and a hook cannot be conditional anyway.
  const accounts = useMailStore((s) => s.accounts);
  const foldersByAccount = useMailStore((s) => s.foldersByAccount);
  const selectedAccountId = useMailStore((s) => s.selectedAccountId);
  const selectedPriority = useMailStore((s) => s.selectedPriority);
  const priorityCounts = useMailStore((s) => s.priorityCounts);
  // A check that cannot run is the other way this button reads as "no mail".
  // The commonest case is an account whose password was never saved: after a
  // relaunch there is nothing to authenticate with, `mail_sync` refuses, and an
  // absent badge would report a quiet mailbox rather than a failed login. The
  // error strip that says so lives in the pane, which is exactly the surface
  // nobody has open when the poll runs.
  const checkError = useMailStore((s) => {
    for (const state of Object.values(s.sync)) {
      if (state?.phase === "error" && state.error) return state.error;
    }
    return null;
  });

  const live = mailClient;
  // `null` until the VPN store has reconciled once — see `useVpnTunnelUp`.
  const tunnelUp = useVpnTunnelUp();
  const vpnGatedCount = useMailStore((s) => s.accounts.filter((a) => a.require_vpn).length);
  const prevTunnelUp = useRef<boolean | null>(null);

  // Accounts *and their folder counts* are a local read, and the button needs
  // both before any mail surface is opened: the interval check below has nothing
  // to check without the accounts, and the badge has nothing to show without the
  // counts. This is the read that puts a number on the button at launch for mail
  // that arrived while Tabtivity was closed — no socket is involved.
  useEffect(() => {
    if (!live) return;
    void useMailStore.getState().refreshUnread();
  }, [live]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let off: (() => void) | undefined;
    // `listen` resolves asynchronously, so a settings flip that unmounts this
    // between the call and its resolution would otherwise leave it installed.
    void onMailNew((e) => useMailStore.getState().noteArrival(e.account_id, e.count)).then((un) => {
      if (cancelled) un();
      else off = un;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [live]);

  // The opt-in poll. `checkMail` is serialized per account by the backend's own
  // cancel/sync state, but a slow server plus a short interval could still stack
  // requests, so each tick skips an account that is already mid-sync — and one
  // whose last login was rejected, until the password is edited.
  useEffect(() => {
    if (!live || intervalMin <= 0) return;
    const tick = () => {
      const { accounts, sync } = useMailStore.getState();
      // Read at tick time, not captured: the tunnel state at the moment the
      // check would go out is the one that matters.
      const up = vpnTunnelUp();
      for (const account of accounts) {
        if (!vpnGateAllows(account, up)) continue;
        if (backgroundCheckBlocked(sync[account.id])) continue;
        void useMailStore.getState().checkMail(account.id, null);
      }
    };
    const id = setInterval(tick, intervalMin * 60_000);
    return () => clearInterval(id);
  }, [live, intervalMin]);

  // The catch-up: a tunnel coming up (`false → true`, never `null → true`) checks
  // every VPN-only account at once. Gated on the same interval setting as the
  // tick, because an explicit *Never* means no unattended check, and this is one.
  useEffect(() => {
    const rose = tunnelUp === true && prevTunnelUp.current === false;
    prevTunnelUp.current = tunnelUp;
    if (!rose || !live || intervalMin <= 0) return;
    const { accounts, sync } = useMailStore.getState();
    for (const account of accounts) {
      if (!account.require_vpn) continue;
      if (backgroundCheckBlocked(sync[account.id])) continue;
      void useMailStore.getState().checkMail(account.id, null);
    }
  }, [tunnelUp, live, intervalMin]);

  // Escape, for the menu that was opened by keyboard focus and therefore has no
  // mouse-leave coming to close it. Capture + `stopPropagation` because the
  // overlay's own Escape handler is window-level as well, and while this list is
  // up, closing it is what the key meant.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, setMenuOpen]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // A flag switched off with the menu open would otherwise leave it painted over
  // a feature the settings say is gone (`experimentalSweep`'s rule).
  useEffect(() => {
    if (!live) setMenuOpen(false);
  }, [live, setMenuOpen]);

  if (!live) return null;

  // The tooltip carries both facts, because they are both true and neither
  // replaces the other: how much unread mail is in the index, and whether the
  // reading is stale because the last check failed. A fresh arrival is called
  // out by name while it is still news — the count alone cannot say whether its
  // 7 is the same 7 that was there yesterday.
  const parts: string[] = [];
  if (unread > 0) parts.push(t("mail.unreadBadge", { count: unread }));
  if (newCount > 0) parts.push(t("mail.indicatorNew", { count: newCount }));
  if (checkError) parts.push(t("mail.indicatorFailed", { reason: checkError }));
  if (checkError && isAuthRejection(checkError)) parts.push(t("mail.indicatorAuthPaused"));
  // Said in the tooltip because the pane's strip is not open when it matters:
  // a VPN-only account that has not been checked is quiet by design, and the
  // reading should say so rather than pass as a mailbox with nothing in it.
  if (vpnGatedCount > 0 && tunnelUp === false) {
    parts.push(t("mail.indicatorVpnWait", { count: vpnGatedCount }));
  }
  const label = parts.length
    ? `${t("mail.indicator")} — ${parts.join(" · ")}`
    : t("mail.indicator");
  const failing = !!checkError;

  // Both reads are local — the accounts and their folder counts, and the two
  // priority totals — so revealing the menu costs no socket. They run on reveal
  // rather than at mount because the numbers are only *read* here: a menu quoting
  // a count the pane has since moved past would be worse than one that takes a
  // moment to fill in. Re-entering an already-open menu refetches nothing.
  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    if (menuOpen) return;
    setMenuOpen(true);
    const store = useMailStore.getState();
    void store.refreshUnread();
    void store.refreshPriorityCounts();
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 250);
  };

  return (
    /* Same wrapper the brain button uses. `.header-center` stretches its
       children to the full header height, so a bare 32px button would sit at the
       top of the frame instead of centered — this div is what centers it, and it
       is also the positioning context the badge and the dropdown are anchored to.
       The hover handlers are the WRAPPER's, not the button's: the list is a child
       of this element, so `mouseleave` holds off while the pointer is anywhere
       inside it — which is the whole reason a menu hanging below the button can
       be walked into at all. */
    <div className="global-apps-menu mail-indicator no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn mail-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={overlayOpen}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          // The button's own job is unchanged — open (or close) mail. The menu
          // goes with the click rather than staying up over the overlay it just
          // raised; the pointer is on its way there, not back to this list.
          setMenuOpen(false);
          window.clearTimeout(closeTimer.current);
          const store = useMailStore.getState();
          if (store.overlayOpen) store.closeOverlay();
          else store.openOverlay();
        }}
        // Keyboard reach: tabbing to the button is the one way in that no
        // pointer will ever open, and Escape is its way back out.
        onFocus={reveal}
      >
        <MailGlyph className="mail-indicator-icon" />
        {unread > 0 && (
          <span
            /* `fresh` only *emphasises* — the number is the same either way.
               Something arriving while you work is worth catching the eye; it is
               not worth a second number to reconcile against the first. */
            className={`mail-indicator-badge${newCount > 0 ? " fresh" : ""}`}
            aria-hidden="true"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        {/* Shown *beside* a count, not instead of it: the two say different
            things, and the failure is exactly what makes the count suspect —
            "3 unread, and the last check couldn't reach the server" is the
            reading that matters, which suppressing either half destroys. */}
        {failing && (
          <span className="mail-indicator-badge failed" aria-hidden="true">
            !
          </span>
        )}
      </button>
      {menuOpen && (
        <div className="tab-new-menu mail-indicator-menu" role="menu" aria-label={t("mail.menuAria")}>
          {/* Pinned title + scrolling region: the unified menu shape (the accent
              rail and the wash live on this element, so it must not be the thing
              that scrolls). */}
          <div className="tab-new-menu-group-label">
            {t("mail.overlayTitle")}
          </div>
          <div className="menu-scroll-region">
            {/* Priority first and outside Accounts, exactly as the rail orders
                them: these two lists are every account's marked mail, so putting
                them under an account would say the opposite of what they are. */}
            <div className="tab-new-menu-group-label mail-menu-priority-label">
              {t("mail.priority")}
              <span className="mail-menu-scope">{t("mail.priorityAllAccounts")}</span>
            </div>
            {(["important", "urgent"] as const).map((p) => {
              const total = p === "important" ? priorityCounts.important : priorityCounts.urgent;
              const unreadPart =
                p === "important"
                  ? priorityCounts.important_unread
                  : priorityCounts.urgent_unread;
              const name = t(p === "important" ? "mail.important" : "mail.urgent");
              return (
                <button
                  key={p}
                  type="button"
                  role="menuitem"
                  className={`tab-new-menu-item mail-menu-row mail-menu-priority ${p}${
                    selectedPriority === p ? " selected" : ""
                  }`}
                  title={
                    total > 0
                      ? t("mail.priorityBadgeTitle", { total, unread: unreadPart })
                      : t("mail.menuOpenList", { name })
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    void useMailStore.getState().openPriorityView(p);
                  }}
                >
                  {/* The rail's mark, and `MailList`'s: one glyph that means the
                      same thing on a row, in the rail and here. */}
                  <span className="mail-menu-priority-mark" aria-hidden="true">
                    {p === "urgent" ? "!!" : "!"}
                  </span>
                  <span className="mail-menu-name">{name}</span>
                  {/* The whole count, toned by unread — the rail's rule: a list
                      you file into is not an inbox and does not empty as it is
                      read, so the number must not be the unread part. */}
                  {total > 0 && (
                    <span className={`mail-menu-badge${unreadPart > 0 ? " unread" : ""}`}>
                      {total}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="tab-new-menu-group-label">{t("mail.accounts")}</div>
            {accounts.length === 0 && (
              <>
                <div className="tab-new-menu-hint">{t("mail.noAccounts")}</div>
                {/* The one row that only opens the surface: adding an account is
                    the pane's dialog, and a second copy of it in the header would
                    be a second account editor to keep in step. */}
                <button
                  type="button"
                  role="menuitem"
                  className="tab-new-menu-item mail-menu-row"
                  onClick={() => {
                    setMenuOpen(false);
                    useMailStore.getState().openOverlay();
                  }}
                >
                  <span className="mail-menu-name">{t("mail.menuOpenMail")}</span>
                </button>
              </>
            )}
            {accounts.map((a) => {
              // The local Display name first, as the accounts badge does:
              // `label` is the name sent in `From:`, often the same on every account.
              const name = a.display_name || a.label || a.address;
              // Inbox only, as the button's dot counts: the row opens the
              // inbox, and rows summing to a different number than the dot
              // above them read as one of the two being wrong.
              const count = accountInboxUnread(foldersByAccount[a.id]);
              return (
                <button
                  key={a.id}
                  type="button"
                  role="menuitem"
                  className={`tab-new-menu-item mail-menu-row${
                    // Only while a *folder* of it is on screen: an account stays
                    // selected behind a priority list, and marking it current
                    // there would point at a mailbox the list is not showing.
                    a.id === selectedAccountId && !selectedPriority ? " selected" : ""
                  }`}
                  title={t("mail.menuOpenAccount", { name: a.address })}
                  onClick={() => {
                    setMenuOpen(false);
                    void useMailStore.getState().openAccountView(a.id);
                  }}
                >
                  <span className="mail-menu-name">{name}</span>
                  {count > 0 && <span className="mail-menu-badge unread">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
