import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorPhrase, liveControlAvailable, titleToTabLabel } from "../../lib/browser";
import { useT } from "../../lib/i18n";
import { useBrowserStore, EMPTY_BROWSER_TAB } from "../../stores/browser";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { BrowserAddressBar } from "./BrowserAddressBar";
import { BrowserBlockedNotice } from "./BrowserBlockedNotice";
import { BrowserReaderView } from "./BrowserReaderView";
import { BrowserStartPage } from "./BrowserStartPage";
import { useBrowserEvents } from "./useBrowserEvents";
import { MoreIcon, RefreshIcon } from "../common/icons/Icon";

/**
 * The in-app browser tab (TODO group J #61), behind the `web_browser`
 * experimental flag.
 *
 * **It is an ordinary DOM pane.** Plan A specified a native child webview
 * composited over the pane rect, with a suppression refcount for every overlay
 * and an LRU cap on live views; Plan C then proved that view cannot exist on
 * Linux (`set_bounds` is a no-op for a GtkBox-packed child under WebKitGTK), so
 * none of that machinery is here and none of it is missing. What the tab renders
 * is **reader mode**: HTML the backend fetched and sanitized with the mail
 * client's `ammonia` pipeline, in a script-less `sandbox=""` iframe. A real
 * engine is available as a **separate hardened window**, one explicit click
 * away, and only where the backend says it can host one.
 *
 * Three behaviours are worth knowing before editing this file:
 *
 *  1. **Mounting never dials out.** Including the mount a restored tab performs
 *     at launch: it shows the resume card holding its persisted URL, and only a
 *     click loads it. Nothing about a window being reopened is consent to make a
 *     request.
 *  2. **The live-page control is hidden, not disabled, where it cannot work.**
 *     The capability comes from `browser_capabilities()` at runtime — never from
 *     a platform check on this side — and where it is false the pane shows the
 *     backend's `platform_note` instead. A control that will lie is not
 *     rendered (the `GifView` / YAML `source only` rule).
 *  3. **A page may retitle its tab only until the user renames it.**
 *     `autoLabelRef` is the `fileTabSync` guard: the label is refreshed only
 *     while it still equals the last auto-derived one, so a user rename breaks
 *     the chain permanently for that tab. Titles are attacker-controlled text,
 *     rendered as plain text nodes, control-stripped and length-capped. (An
 *     `ownsTabs` prop used to gate the write entirely, because a popout had no
 *     channel back to the tab store — so a popped-out browser tab kept the label
 *     and address it was detached with, forever. Group B #239: the store seam
 *     forwards both, so the write is unconditional again.)
 */
export interface BrowserPaneProps {
  tab: TabEntry;
  scope: string;
  visible?: boolean;
}

export function BrowserPane({ tab, visible }: BrowserPaneProps) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const state = useBrowserStore((s) => s.byTab[tab.key]) ?? EMPTY_BROWSER_TAB;
  const capabilities = useBrowserStore((s) => s.capabilities);
  const downloadNote = useBrowserStore((s) => s.downloadNote);
  const live = useBrowserStore((s) => s.live);
  const liveBlocked = useBrowserStore((s) => s.liveBlocked);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [focusAddress, setFocusAddress] = useState(0);

  // One set of backend listeners per window, however many browser tabs exist.
  useBrowserEvents();

  // Register the tab and read what this build can do. Neither touches the
  // network; `browser_capabilities` is a local question.
  //
  // `allowLive: true` is the honest seed for every path that exists today: a
  // browser tab is only ever created by a user gesture — the tab bar's add menu
  // or a popout's — so the person who opened it named the destination, which is
  // exactly what `linkTarget`'s TRUSTED_ORIGINS means. **When #33's routing is
  // wired**, `openBrowserTab` must thread `LinkTarget.allowLive` through to
  // `setAllowLive`, because a URL that arrived from a mail body, terminal output
  // or an agent's answer must NOT offer a one-click path to a live engine.
  // `LinkTarget.test.ts` keeps that distinction alive in the routing table
  // meanwhile.
  useEffect(() => {
    useBrowserStore.getState().ensureTab(tab.key, tab.url ?? "", true);
    void useBrowserStore.getState().loadCapabilities();
  }, [tab.key, tab.url]);

  // The one opt-in that makes a mount reach the network, and it is OFF by
  // default: `browser_restore_navigate` means "load my open pages at startup".
  // Read once per tab, from a ref, so flipping the setting never retro-loads a
  // tab that is already sitting on its resume card.
  // It waits for settings to actually load before disarming, because `settings`
  // is null for the first frames of a launch and reading the opt-in as "off"
  // there would make the setting work only sometimes — the worst kind of
  // security-adjacent toggle. Once armed-and-answered it never fires again, so
  // flipping the setting later cannot retro-load a tab already sitting on its
  // resume card.
  const restoreArmed = useRef(true);
  useEffect(() => {
    if (!restoreArmed.current || !settings) return;
    restoreArmed.current = false;
    if (!settings.browser_restore_navigate) return;
    const url = tab.url;
    if (!url) return;
    void useBrowserStore.getState().load(tab.key, url);
  }, [tab.key, tab.url, settings]);

  // A closed tab's state is per-window runtime state with no persistence — the
  // committed URL already lives on the tab entry, so nothing is lost.
  useEffect(() => () => useBrowserStore.getState().dropTab(tab.key), [tab.key]);

  // The `fileTabSync` rename guard: seeded from the tab's label at mount, and a
  // page retitles only while the label still equals it.
  const autoLabelRef = useRef(tab.label);

  const page = state.page;
  const pageTitle = page?.title;
  useEffect(() => {
    if (!pageTitle) return;
    const next = titleToTabLabel(pageTitle);
    if (!next) return;
    // The payload lives in the main window's store; in a popout that lookup
    // finds nothing, so the guard falls back to this pane's own last auto-label
    // (seeded from the streamed tab and updated only by this effect — so a user
    // rename, which arrives on the next seed as a label this ref never wrote,
    // still breaks the chain).
    const current = useTabsStore.getState().tabs.find((x) => x.key === tab.key);
    const label = current?.label ?? tab.label;
    if (label !== autoLabelRef.current) return;
    autoLabelRef.current = next;
    useTabsStore.getState().renameTab(tab.key, next);
  }, [pageTitle, tab.key, tab.label]);

  // Record the address that actually loaded, so the tab restores holding it.
  const committed = page?.final_url;
  useEffect(() => {
    if (!committed) return;
    useTabsStore.getState().setTabUrl(tab.key, committed);
  }, [committed, tab.key]);

  const load = useCallback(
    (url: string) => {
      void useBrowserStore.getState().load(tab.key, url);
    },
    [tab.key],
  );

  const liveAvailable = liveControlAvailable(capabilities);
  const canGoLive = liveAvailable && state.allowLive;

  // Routed through `requestLive`, not `openLive`, so a loopback or private
  // address is confirmed once per tab whichever surface asks for it — otherwise
  // "Open live page" would be the way around the reader path's confirmation.
  const openLive = async (url: string) => {
    if (!url) return;
    setLiveError(null);
    const err = await useBrowserStore.getState().requestLive(tab.key, url);
    if (err) setLiveError(err);
  };

  const currentUrl = page?.final_url || state.url;

  return (
    /* Hidden by style, not by the `hidden` attribute: `.browser-pane` sets
       `display: flex`, which would override the UA's `[hidden] { display: none }`
       and leave the pane painted on top of its sibling. Same shape as
       `MailPane`/`CalendarPane`. */
    <div className="browser-pane" style={{ display: visible === false ? "none" : undefined }}>
      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-icon-btn"
          title={t("browser.reload")}
          disabled={!state.url || state.loading}
          onClick={() => load(state.url)}
        >
          <RefreshIcon />
        </button>

        <BrowserAddressBar
          editSignal={focusAddress}
          url={currentUrl}
          displayUrl={page?.display_url}
          security={page?.security ?? null}
          searchTemplate={settings?.browser_search_template ?? DEFAULT_SEARCH_TEMPLATE}
          onCommit={(commit) => {
            if (commit.kind === "url" || commit.kind === "search") load(commit.url);
          }}
        />

        {canGoLive && (
          <button
            type="button"
            className="browser-btn browser-btn-live untested"
            title={t("browser.openLiveHelp")}
            disabled={!currentUrl}
            onClick={() => void openLive(currentUrl)}
          >
            {t("browser.openLive")}
            <UntestedTag id="browserPane.1" />
          </button>
        )}

        <button
          type="button"
          className="browser-icon-btn"
          title={t("browser.menu")}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuPos(menuPos ? null : { x: rect.right - 190, y: rect.bottom + 4 });
          }}
        >
          <MoreIcon />
        </button>
      </div>

      {state.loading && <div className="browser-progress" />}

      {/* The backend's failures are typed strings (`http-status:404`,
          `fetch-failed: …`) and its live-window refusals are bare reason tokens
          (`scheme:file`). `errorPhrase` is what keeps either from reaching the
          user as an identifier. */}
      {liveError && (
        <div className="browser-error-strip">
          <span>{t(errorPhrase(liveError).key, errorPhrase(liveError).vars)}</span>
          <button type="button" className="browser-btn" onClick={() => setLiveError(null)}>
            {t("browser.dismiss")}
          </button>
        </div>
      )}
      {state.error && (
        <div className="browser-error-strip">
          <span>{t(errorPhrase(state.error).key, errorPhrase(state.error).vars)}</span>
          <button
            type="button"
            className="browser-btn"
            onClick={() => useBrowserStore.getState().clearError(tab.key)}
          >
            {t("browser.dismiss")}
          </button>
        </div>
      )}
      {/* A live window's refused navigation. It belongs to that window, so it is
          a strip naming the window rather than a page state that would replace
          whatever this tab is showing. */}
      {Object.entries(liveBlocked).map(([label, blk]) => (
        <div key={label} className="browser-error-strip">
          <span>{t("browser.liveBlocked", { url: blk.display_url })}</span>
          <span className="browser-live-reason">
            {t(errorPhrase(blk.reason).key, errorPhrase(blk.reason).vars)}
          </span>
          <button
            type="button"
            className="browser-btn"
            onClick={() => useBrowserStore.getState().dismissLiveBlocked(label)}
          >
            {t("browser.dismiss")}
          </button>
        </div>
      ))}
      {downloadNote != null && (
        <div className="browser-note-strip">
          <span>{t("browser.downloadSaved", { name: downloadNote })}</span>
          <button
            type="button"
            className="browser-btn"
            onClick={() => useBrowserStore.getState().setDownloadNote(null)}
          >
            {t("browser.dismiss")}
          </button>
        </div>
      )}
      {!liveAvailable && capabilities?.platform_note && (
        /* Not an alarm and not a disabled button: a plain sentence saying why
           live pages are not offered on this build, in place of the control. */
        <div className="browser-note-strip">{capabilities.platform_note}</div>
      )}

      <div className="browser-content">
        {state.confirm ? (
          /* The gate's third outcome: allowed, but not without being told. The
             Proceed button is the consent — a real user gesture, scoped to this
             tab, that no page and no redirect can supply. */
          <BrowserBlockedNotice
            blocked={{
              display_url: state.confirm.display_url,
              reason: state.confirm.reason,
            }}
            onBack={() => useBrowserStore.getState().cancelConfirm(tab.key)}
            onProceed={() => void useBrowserStore.getState().acceptConfirm(tab.key)}
          />
        ) : state.blocked ? (
          <BrowserBlockedNotice
            blocked={state.blocked}
            onBack={() => useBrowserStore.getState().clearError(tab.key)}
          />
        ) : state.loading ? (
          <div className="browser-empty">{t("browser.loading")}</div>
        ) : page ? (
          <BrowserReaderView page={page} />
        ) : (
          <BrowserStartPage
            url={state.url}
            onLoad={() => load(state.url)}
            onOpenAddress={() => setFocusAddress((n) => n + 1)}
          />
        )}
      </div>

      {live.length > 0 && (
        <div className="browser-live-strip">
          <span className="browser-live-title">{t("browser.liveWindows")}</span>
          {live.map((w) => (
            <button
              key={w.label}
              type="button"
              className="browser-btn"
              title={w.display_url}
              onClick={() => void useBrowserStore.getState().closeLive(w.label)}
            >
              {t("browser.closeLive", { url: w.display_url })}
            </button>
          ))}
        </div>
      )}

      {/* The download-consent dialog is deliberately NOT rendered here. It is
          portaled to <body>, and `CenterPanel` keeps every tab of every scope
          mounted — a portal escapes the `display: none`, so a pane-rendered
          dialog would appear once per browser tab in the app. It is mounted once
          per window by `BrowserDownloadHost` instead. */}

      {menuPos && (
          <ContextMenuPortal
            x={menuPos.x}
            y={menuPos.y}
            onClose={() => setMenuPos(null)}
            className="context-menu browser-menu"
          >
              <div className="context-menu-group">
                <button
                  disabled={!currentUrl}
                  onClick={() => {
                    navigator.clipboard?.writeText(currentUrl).catch(() => {});
                    setMenuPos(null);
                  }}
                >
                  {t("browser.copyLink")}
                </button>
                <button
                  disabled={!currentUrl}
                  onClick={() => {
                    openExternal(currentUrl);
                    setMenuPos(null);
                  }}
                >
                  {t("browser.openExternal")}
                </button>
                <button
                  className="untested"
                  onClick={() => {
                    void useBrowserStore.getState().clearData();
                    setMenuPos(null);
                  }}
                >
                  {t("browser.clearData")}
                  <UntestedTag id="browserPane.2" />
                </button>
              </div>
          </ContextMenuPortal>
        )}
    </div>
  );
}

/** The default the address bar falls back to when the user has set no template.
 *  A public, neutral engine; the setting may be cleared to disable search
 *  entirely, in which case non-URL text is refused rather than sent anywhere. */
export const DEFAULT_SEARCH_TEMPLATE = "https://duckduckgo.com/?q=%s";

/** Hand the current page to the user's real browser. Routed through the same
 *  `open_external_url` the rest of the app uses, which independently refuses
 *  anything that is not `http(s)`. */
function openExternal(url: string): void {
  void invoke("open_external_url", { url }).catch(() => {});
}
