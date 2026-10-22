import { useCallback, useEffect, useRef } from "react";

import { useSettingsStore } from "../../stores/settings";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useT } from "../../lib/i18n";
import { BellIcon } from "../common/BellIcon";
import { useAlertsFeed } from "../files/useAlertsFeed";
import { AlertsMenu } from "./AlertsMenu";

const MENU_ID = "alerts";

/**
 * The header's bell: the on/off switch for the Alerts (urgent mail, the next
 * appointments, due/overdue cards), and — on hover — the list itself
 * (`AlertsMenu`).
 *
 * The list used to be a group stacked below the side panel's file tree. The
 * rows are machine-wide, the same whichever project is open, so a per-project
 * panel was the wrong place for them and cost the tree its height all day; they
 * now open from the bell, the way the ✉ 🗓 ☑ buttons read their cards out. The
 * click keeps its one job: `files_alerts` is one machine-wide setting, and the
 * Project Settings checkbox writes the same key, so the two can never disagree.
 * Switched off, the bell hangs no list — there is nothing it may read.
 *
 * It sits inside `StatusCluster` with the machine-state readouts: at rest it has
 * nothing to say, and a bar full of permanently lit controls is paid for by the
 * project strip. As a cluster member it reports `ok` while armed and `off` while
 * switched off — dormant, not a problem, so it never colours the summary lamp.
 *
 * It wears its neighbours' chrome exactly — `.global-apps-menu-btn` inside a
 * `.global-apps-menu`, with `.alerts-toggle-btn` joined to the ✉/🗓/☑ rule sets
 * in `styles/mail-todo.css`. On is the same `aria-pressed` fill those use for
 * "the overlay is open"; here the pressed state stands rather than following an
 * overlay. The glyph is a **drawn** bell (monochrome, `currentColor`), matching
 * ✉ and ☑ and the cluster's own SVGs, and is the same whether alerts are on or
 * off.
 *
 * The button is deliberately always rendered, never gated on the setting it
 * writes: it IS the way back once the alerts are off.
 */
export function AlertsToggle() {
  const enabled = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const t = useT();
  const label = enabled ? t("filesAlerts.headerHide") : t("filesAlerts.headerShow");
  // Called here, not in the menu, so the list is already read when the pointer
  // arrives. Switched off, the feed arms nothing (see `useAlertsFeed`).
  const feed = useAlertsFeed();
  // Shared across every header hover-menu (stores/headerHoverMenu), so moving
  // straight from a neighbour closes it instead of racing its grace timer.
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setMenuOpen = useCallback(
    (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [openMenu, closeMenu],
  );
  // Grace period, so crossing the gap between the button and the list below it
  // does not shut the list you are reaching for.
  const closeTimer = useRef<number | undefined>(undefined);

  useHeaderStatusReport("alerts", {
    tone: enabled ? "ok" : "off",
    label: enabled ? t("filesAlerts.statusOn") : t("filesAlerts.statusOff"),
  });

  // Escape, for the list opened by keyboard focus, which has no mouse-leave
  // coming to close it.
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

  // Switched off with the list open would leave it painted over a bell that has
  // nothing to read.
  useEffect(() => {
    if (!enabled) setMenuOpen(false);
  }, [enabled, setMenuOpen]);

  const reveal = () => {
    if (!enabled) return;
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 250);
  };

  return (
    /* The wrapper the mail, calendar, to-do and brain buttons share:
       `.header-right` stretches its children to the full header height, so a
       bare 32px button would sit at the top of the frame instead of centered.
       The hover handlers are the WRAPPER's, so `mouseleave` holds off while the
       pointer is anywhere inside the list hanging below the button. */
    <div className="global-apps-menu alerts-toggle no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn alerts-toggle-btn"
        title={label}
        aria-label={label}
        aria-pressed={enabled}
        aria-haspopup={enabled ? "menu" : undefined}
        aria-expanded={enabled ? menuOpen : undefined}
        onClick={() => void updateSettings({ files_alerts: !enabled })}
        onFocus={reveal}
      >
        <BellIcon className="alerts-toggle-icon" />
      </button>
      {enabled && menuOpen && (
        <div className="tab-new-menu alerts-indicator-menu" role="menu" aria-label={t("filesAlerts.title")}>
          <AlertsMenu
            feed={feed}
            onNavigate={() => {
              window.clearTimeout(closeTimer.current);
              setMenuOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
