import { useEffect, useRef, useState } from "react";
import {
  MAIL_INBOX_TAB,
  accountInboxUnread,
  useMailStore,
  type MailMessageTab,
  type MailTab,
} from "../../stores/mail";
import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { mailBody, stripFormatControls } from "../../lib/mail";
import type { MailBody } from "../../types/mail";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { useDialogs } from "../common/PromptDialogs";
import { MailGlyph } from "../header/HeaderGlyphs";
import { BookIcon } from "../common/icons/Icon";
import { OverlayApprovals } from "../layout/OverlayApprovals";
import { OverlayAgentColumn, OverlayAgentToggle } from "../layout/OverlayAgentColumn";
import { useOverlayAgent, useOverlayAgentMaxWidth } from "../layout/useOverlayAgent";
import { ScrollingTabStrip } from "../tabs/ScrollingTabStrip";
import { MailAccountMenu } from "./MailAccountMenu";
import { MailPane } from "./MailPane";
import { MailMessageView } from "./MailMessageView";
import { MailComposeDialog, composeSubject, composeTitle } from "./MailComposeDialog";
import { MailAddressBook } from "./MailAddressBook";
import { ErrorNote } from "../common/ErrorNote";
import { storageKey } from "../../lib/brand";

/**
 * The header mail button's overlay — **the** mail surface, floated over the
 * window instead of tiled into a scope.
 *
 * It wears the root console's chrome, not a dialog's: one floating subwindow
 * (`.root-overlay.subwindow`) whose title bar is a tab strip. The first tab is
 * the Inbox — `MailPane`, folders / full-width list — and never closes; every
 * message opened (a click on a row) and every unfinished mail (new, reply,
 * forward, an agent's draft) gets a tab after it.
 * The tabs are the mail store's (`mailTabs`), so the header's ✉ and the root
 * console's review strip can open one too.
 *
 * There was a mail *tab* in a project's strip as well, and it was redundant
 * from the start: the store is global (one mailbox across every scope), so the
 * tab showed the same mailbox wherever it was opened while still belonging to a
 * project you then switched away from. It is retired; this host is `MailPane`'s
 * only caller. The tabs here are the mail window's own, not a scope's.
 *
 * **An unfinished mail outlives closing the window.** A composer's text lives in
 * its mounted component, so while any composer tab is open this host stays
 * mounted with the window hidden rather than returning null — reopening mail
 * finds the half-written message where it was left. A composer tab that was
 * edited asks before its × throws the text away.
 *
 * One gate, `mail_client` — the experimental flag that owns the whole feature.
 * Switching it off takes the overlay away (composers included) rather than
 * leaving it on screen over a feature the settings say is gone, the same rule
 * `experimentalSweep` applies to a withdrawn tab. The composer tabs go with it:
 * a row whose composer is unmounted would reopen as an empty mail.
 */
export function MailOverlayHost() {
  const mailClient = useExperimental("mail_client");
  const open = useMailStore((s) => s.overlayOpen);
  const keepAlive = useMailStore((s) => s.mailTabs.some((tab) => tab.kind === "compose"));
  useEffect(() => {
    if (!mailClient) useMailStore.getState().dropComposeTabs();
  }, [mailClient]);
  if (!mailClient || (!open && !keepAlive)) return null;
  return <MailOverlay open={open} />;
}

function MailOverlay({ open }: { open: boolean }) {
  const t = useT();
  const { confirmAction, dialogs } = useDialogs();
  const tabs = useMailStore((s) => s.mailTabs);
  const active = useMailStore((s) => s.activeMailTab);
  const accounts = useMailStore((s) => s.accounts);
  const selectedAccountId = useMailStore((s) => s.selectedAccountId);
  // The shown account's inbox only — the tab is that one mailbox, not the
  // header ✉'s every-account total.
  const inboxUnread = useMailStore((s) =>
    s.selectedAccountId ? accountInboxUnread(s.foldersByAccount[s.selectedAccountId]) : 0,
  );
  // Moves, resizes and fills like the root console; remembered per overlay.
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("mailOverlayFrame"));
  const activeTab = tabs.find((tab) => tab.id === active);
  const inboxActive = !activeTab;
  const bodyRef = useRef<HTMLDivElement>(null);
  // `barProps.title` is the move hint; on the whole bar it would hover over
  // every tab, so it goes on the mark alone (the root console's placement).
  const { title: moveHint, ...barRest } = barProps;
  // The docked root agent beside the mailbox (Ctrl+1–9 here, or the bar's
  // button). Live only while the window SHOWS: hidden-but-mounted (composers
  // waiting) it answers no chord and draws no column, so no key of the
  // column's is marked shown while nobody can see it.
  const agent = useOverlayAgent("mail", open);
  const agentMaxWidth = useOverlayAgentMaxWidth(bodyRef, open);

  // Hidden, focus must not stay behind in the window: keys typed next would
  // land in a composer nobody can see.
  useEffect(() => {
    if (open) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && frameRef.current?.contains(el)) el.blur();
  }, [open, frameRef]);

  // A composer tab brought forward takes the keyboard at its first field,
  // unless something in it already has it.
  const activeComposeId = activeTab?.kind === "compose" ? activeTab.id : null;
  useEffect(() => {
    if (!open || !activeComposeId) return;
    // Tab ids are the store's own (`compose:<n>`), safe in a quoted selector.
    const pane = bodyRef.current?.querySelector<HTMLElement>(`[data-mail-tab="${activeComposeId}"]`);
    if (!pane || pane.contains(document.activeElement)) return;
    pane.querySelector<HTMLElement>(".mail-compose-to")?.focus();
  }, [open, activeComposeId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape typed into the docked agent is its cancel key, not "close" —
      // the root console's `regionRef` rule.
      if ((e.target as Element | null)?.closest?.(".overlay-agent-column")) return;
      // An Escape the approvals panel (or anything else) already took is not ours.
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        useMailStore.getState().closeOverlay();
      }
    };
    // Bubble phase, deliberately NOT capture: the pane hosts dialogs and a
    // search field, and a capturing window listener would run *before* them and
    // close the overlay out from under them. They stop propagation themselves,
    // so this only ever sees an unhandled Escape. Closing never loses a
    // composer — they stay mounted (see the module header).
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const closeTab = async (shown: MailTab) => {
    // The store's copy, not the render's: an edit may have landed since.
    const tab = useMailStore.getState().mailTabs.find((x) => x.id === shown.id) ?? shown;
    if (
      tab.kind === "compose" &&
      tab.dirty &&
      !(await confirmAction({
        title: t("mail.closeUnsentTitle"),
        body: t("mail.closeUnsentBody"),
        confirmLabel: t("mail.closeUnsentConfirm"),
        danger: true,
      }))
    ) {
      return;
    }
    useMailStore.getState().closeMailTab(tab.id);
    // An agent's draft that was sent, saved or discarded leaves the review list.
    if (tab.kind === "compose" && tab.draft) void useMailStore.getState().loadAgentDrafts();
  };

  const newMail = () => {
    const accountId = selectedAccountId ?? accounts[0]?.id;
    if (!accountId) return;
    useMailStore.getState().openComposeTab({ mode: "new", accountId });
  };

  // A reply or forward is labelled with the "Re: / Fwd:" subject its composer
  // opens with, until the first edit reports the typed one.
  const tabLabel = (tab: MailTab) =>
    tab.kind === "contacts"
      ? t("mail.contacts.title")
      : tab.kind === "message"
      ? stripFormatControls(tab.header.subject) || t("mail.noSubject")
      : stripFormatControls(
          tab.subject ?? tab.draft?.subject ?? composeSubject(t, tab.mode, tab.source?.header),
        ) || composeTitle(t, tab.mode);

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop mail-overlay-backdrop"
      // Hidden, not unmounted, while composers wait (see the module header).
      style={open ? undefined : { display: "none" }}
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the pane and ends out here
        // (selecting text, dragging the list) must not be read as "dismiss".
        if (e.target === e.currentTarget) useMailStore.getState().closeOverlay();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused mail-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("mail.overlayTitle")}
      >
        {grips}
        {/* The root console's bar: mark, tab strip, "+", controls. The bar is
            the move handle; tabs and buttons keep their own press. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark mail-overlay-mark" title={moveHint}>
            <MailGlyph className="mail-overlay-glyph" />
            {/* The account switcher sits where the other overlays put their
                name: which mailbox this is *is* the window's title. */}
            <MailAccountMenu />
            <UntestedTag id="mail.overlayTitle" />
          </div>
          {/* Scrolls with chevrons once the tabs hit their minimum width, like
              every other strip; the "+" stays outside so it never scrolls away. */}
          <ScrollingTabStrip
            className="mail-tab-strip"
            role="tablist"
            revision={tabs.map((tab) => tab.id).join(",")}
            activeKey={active}
          >
            {/* The Inbox: always first, never closes. */}
            <div
              role="tab"
              tabIndex={0}
              aria-selected={inboxActive}
              className={`tab mail-tab mail-tab-inbox${inboxActive ? " active" : ""}`}
              onMouseDown={(e) => {
                if (e.button === 0) useMailStore.getState().setActiveMailTab(MAIL_INBOX_TAB);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  useMailStore.getState().setActiveMailTab(MAIL_INBOX_TAB);
                }
              }}
            >
              <span className="tab-label">{t("mail.tabInbox")}</span>
              {inboxUnread > 0 && <span className="mail-rail-badge">{inboxUnread}</span>}
            </div>
            {tabs.map((tab) => {
              const isActive = tab.id === active;
              const label = tabLabel(tab);
              return (
                <div
                  key={tab.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActive}
                  className={`tab mail-tab mail-tab-${tab.kind}${isActive ? " active" : ""}`}
                  title={label}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useMailStore.getState().setActiveMailTab(tab.id);
                    }
                  }}
                  onMouseDown={(e) => {
                    // Middle click closes, as in every other strip.
                    if (e.button === 1) {
                      e.preventDefault();
                      void closeTab(tab);
                      return;
                    }
                    if (e.button === 0) useMailStore.getState().setActiveMailTab(tab.id);
                  }}
                >
                  {tab.kind === "compose" && (
                    <span className="mail-tab-kind" aria-hidden="true">
                      ✎
                    </span>
                  )}
                  {tab.kind === "contacts" && <BookIcon className="mail-tab-kind" />}
                  <span className="tab-label">{label}</span>
                  {tab.kind === "compose" && tab.dirty && (
                    <span className="mail-tab-dirty" title={t("mail.tabUnsent")} aria-label={t("mail.tabUnsent")}>
                      ●
                    </span>
                  )}
                  <button
                    type="button"
                    className="tab-close"
                    title={t("detachedTabs.closeTab")}
                    aria-label={t("detachedTabs.closeTab")}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(tab);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </ScrollingTabStrip>
          <div className="tab-new-wrap">
            <button
              type="button"
              className="tab-new-btn"
              title={t("mail.composeNew")}
              aria-label={t("mail.composeNew")}
              disabled={accounts.length === 0}
              onClick={newMail}
            >
              +
            </button>
          </div>
          <div className="tab-controls root-overlay-controls">
            <OverlayAgentToggle handle={agent} />
            <OverlayApprovals domain="mail" />
            <UntestedTag id="mail.overlayTabs" />
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => useMailStore.getState().closeOverlay()}
            >
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body mail-overlay-body app-overlay-body-row" ref={bodyRef}>
          {/* The tab panes stack in their own box, so the docked agent column
              can sit beside them rather than under their `inset: 0`. */}
          <div className="mail-overlay-panes">
            {/* Every tab stays mounted and is hidden by style: the Inbox keeps its
                scroll and selection, a composer its text. */}
            {/* `visible` is the window's, not the tab's: the pane's first show
                opens the store (the unlock prompt), and a window opened straight
                onto a composer needs that as much as one opened on the Inbox. */}
            <div className="mail-tab-pane" style={inboxActive ? undefined : { display: "none" }}>
              <MailPane visible={open} />
            </div>
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className="mail-tab-pane"
                role="tabpanel"
                data-mail-tab={tab.id}
                style={tab.id === active ? undefined : { display: "none" }}
              >
                {tab.kind === "contacts" ? (
                  <MailAddressBook tab={tab} />
                ) : tab.kind === "message" ? (
                  <MailMessageTabBody tab={tab} />
                ) : (
                  <MailComposeDialog
                    embedded
                    accounts={accounts}
                    accountId={tab.accountId}
                    mode={tab.mode}
                    source={tab.source}
                    toAddress={tab.toAddress}
                    draft={tab.draft}
                    onDirty={(subject) => useMailStore.getState().markComposeDirty(tab.id, subject)}
                    onSaved={(subject) => useMailStore.getState().markComposeClean(tab.id, subject)}
                    // Cancel is the tab × by another name: same question.
                    onCancel={() => void closeTab(tab)}
                    onClose={() => {
                      // Sent or discarded: nothing left to lose, so no question.
                      useMailStore.getState().closeMailTab(tab.id);
                      if (tab.draft) void useMailStore.getState().loadAgentDrafts();
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          {open && agent.showColumn && (
            <OverlayAgentColumn
              app="mail"
              tab={agent.tab}
              hint={agent.hint}
              maxWidth={agentMaxWidth}
              focusRequest={agent.focusRequest}
              onDismissHint={agent.dismissHint}
            />
          )}
        </div>
      </div>
      {dialogs}
    </div>
  );
}

/**
 * One message in its own tab — the only place a message is read; the Inbox has
 * no preview pane. It reads its own body, so it survives the list moving on, and
 * takes flag changes from the list's copy of the header while that is loaded.
 */
function MailMessageTabBody({ tab }: { tab: MailMessageTab }) {
  const listed = useMailStore((s) => s.headers.find((h) => h.id === tab.header.id));
  const header = listed ?? tab.header;
  const [body, setBody] = useState<MailBody | null>(null);
  const [loading, setLoading] = useState(true);
  // This tab's own failure, shown in this tab — the store's `error` strip is the
  // Inbox's and would report it where the user is not looking.
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    // Every message starts with remote content blocked.
    mailBody(tab.header.id, false)
      .then((b) => {
        if (!live) return;
        setBody(b);
        // Reading a message marks it seen, locally and on the server — the
        // list's copy when it has one, since the snapshot may be stale.
        const store = useMailStore.getState();
        const current = store.headers.find((h) => h.id === tab.header.id) ?? tab.header;
        if (!current.seen) void store.setFlag(tab.header.id, "seen", true);
      })
      .catch((err) => {
        if (live) setError(typeof err === "string" ? err : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // The tab's header snapshot is set once when the tab opens, never replaced.
  }, [tab.header]);

  return (
    <div className="mail-message-tab">
      {error && <ErrorNote className="mail-error-strip" error={error} />}
      <MailMessageView
        header={header}
        body={body}
        loading={loading}
        onReply={(mode) =>
          useMailStore
            .getState()
            .openComposeTab({ mode, accountId: header.account_id, source: { header, body } })
        }
        onComposeTo={(address) =>
          useMailStore
            .getState()
            .openComposeTab({ mode: "new", accountId: header.account_id, toAddress: address })
        }
      />
    </div>
  );
}
