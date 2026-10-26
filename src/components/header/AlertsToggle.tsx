import { useCallback, useEffect, useRef, useState } from "react";

import { useSettingsStore } from "../../stores/settings";
import { useHeaderStatusReport } from "../../stores/headerStatus";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useT } from "../../lib/i18n";
import { BellIcon } from "../common/BellIcon";
import { useAlertsFeed } from "../files/useAlertsFeed";
import { AlertsMenu } from "./AlertsMenu";

const MENU_ID = "alerts";

/**
 * The header's bell: the Alerts (urgent mail, the next appointments, due/overdue
 * cards) as a button like ✉ 🗓 ☑ — hover reads the list out, a click opens it
 * and keeps it open (`AlertsMenu`) until a click elsewhere, Esc, or the bell
 * again.
 *
 * It is no longer a show/hide switch. The list used to be a group stacked below
 * the side panel's file tree, and this button its on/off; now the button *is*
 * the way in, so there is nothing to hide. `files_alerts` stays as the machine-wide
 * master switch in Project Settings (with the per-source opt-outs); while it is
 * off the list says so instead of showing rows.
 *
 * It sits inside `StatusCluster` with the machine-state readouts: at rest it has
 * nothing to say, and a bar full of permanently lit controls is paid for by the
 * project strip. As a cluster member it reports `ok` while armed and `off` while
 * switched off in settings — dormant, not a problem, so it never colours the
 * summary lamp.
 *
 * It wears its neighbours' chrome exactly — `.global-apps-menu-btn` inside a
 * `.global-apps-menu`, with `.alerts-toggle-btn` joined to the ✉/🗓/☑ rule sets
 * in `styles/mail-todo.css`; `aria-pressed` is the same "open" fill they use.
 * The glyph is a **drawn** bell (monochrome, `currentColor`), like the cluster's
 * own SVGs.
 */
export function AlertsToggle() {
  const enabled = useSettingsStore((s) => s.settings?.files_alerts ?? true);
  const t = useT();
  const label = t("filesAlerts.title");
  // Called here, not in the menu, so the list is already read when the pointer
  // arrives. Switched off in settings, the feed arms nothing (see `useAlertsFeed`).
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
  // Opened by a click: the pointer leaving no longer closes it.
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useHeaderStatusReport("alerts", {
    tone: enabled ? "ok" : "off",
    label: enabled ? t("filesAlerts.statusOn") : t("filesAlerts.statusOff"),
  });

  const close = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    setPinned(false);
    setMenuOpen(false);
  }, [setMenuOpen]);

  // A neighbouring menu claiming the shared slot also ends a pin.
  useEffect(() => {
    if (!menuOpen) setPinned(false);
  }, [menuOpen]);

  // Escape, for the list opened by keyboard focus or a click, which has no
  // mouse-leave coming to close it; a click anywhere outside ends a pinned one.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      if (pinned && !wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [menuOpen, pinned, close]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = (e?: { clientY: number }) => {
    if (pinned) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), headerMenuCloseDelay(e));
  };

  return (
    /* The wrapper the mail, calendar, to-do and brain buttons share:
       `.header-right` stretches its children to the full header height, so a
       bare 32px button would sit at the top of the frame instead of centered.
       The hover handlers are the WRAPPER's, so `mouseleave` holds off while the
       pointer is anywhere inside the list hanging below the button. */
    <div
      ref={wrapRef}
      className="global-apps-menu alerts-toggle no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn alerts-toggle-btn"
        title={label}
        aria-label={label}
        aria-pressed={menuOpen && pinned}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          // Hover has usually opened it already, so a click on an open-but-
          // unpinned list pins it rather than toggling it shut.
          if (menuOpen && pinned) close();
          else {
            window.clearTimeout(closeTimer.current);
            setPinned(true);
            setMenuOpen(true);
          }
        }}
        onFocus={reveal}
      >
        <BellIcon className="alerts-toggle-icon" />
      </button>
      {menuOpen && (
        <div className="tab-new-menu alerts-indicator-menu" role="menu" aria-label={label}>
          <AlertsMenu feed={feed} onNavigate={close} />
        </div>
      )}
    </div>
  );
}
