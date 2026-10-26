import { useCallback, useEffect, useRef, useState } from "react";
import { useQuiesce, saverInterval } from "../../stores/power";
import { useSettingsStore } from "../../stores/settings";
import { useUse24h } from "../../lib/timeFormat";
import { headerMenuCloseDelay, useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { AppTimerDisplay } from "./AppTimerDisplay";
import { useT } from "../../lib/i18n";
import { OPEN_STATS_EVENT } from "../stats/StatsRecapHost";

const MENU_ID = "clock";

function fmt(n: number) {
  return String(n).padStart(2, "0");
}

export function Clock() {
  const t = useT();
  const [time, setTime] = useState(() => new Date());
  const quiesce = useQuiesce();
  const showSeconds = useSettingsStore((s) => s.settings?.show_clock_seconds ?? false);
  const use24h = useUse24h();
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const closeTimer = useRef<number | undefined>(undefined);
  const setMenuOpen = useCallback(
    (open: boolean) => (open ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [closeMenu, openMenu],
  );

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), saverInterval(1000, quiesce));
    return () => clearInterval(id);
  }, [quiesce]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, setMenuOpen]);

  const hours = time.getHours();
  // The hour is the only part the format changes: 12-hour drops the leading
  // zero (nobody writes "05:00 PM") while minutes and seconds stay padded.
  const h = use24h ? fmt(hours) : String(hours % 12 === 0 ? 12 : hours % 12);
  const m = fmt(time.getMinutes());
  const s = fmt(time.getSeconds());
  const suffix = use24h ? "" : hours < 12 ? " AM" : " PM";

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = (e?: { clientY: number }) => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), headerMenuCloseDelay(e));
  };
  const clock = `${h}:${m}${showSeconds ? `:${s}` : ""}${suffix}`;
  // Like the mail and calendar triggers, a click opens the full view behind the
  // hover menu — here the usage recap — and the menu goes with the click.
  const openStats = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(false);
    window.dispatchEvent(new CustomEvent(OPEN_STATS_EVENT));
  };

  return (
    <div
      className="global-apps-menu clock-menu no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn clock-menu-btn"
        title={clock}
        aria-label={clock}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={openStats}
        onFocus={reveal}
      >
        <span className="header-clock">{clock}</span>
      </button>
      {menuOpen && (
        <div className="tab-new-menu clock-menu-popover" role="menu" aria-label={clock}>
          <button
            type="button"
            className="tab-new-menu-group-label clock-menu-stats-link"
            title={t("settings.openUsageStats")}
            onClick={openStats}
          >
            {t("appTimer.todayStats")}
          </button>
          <AppTimerDisplay inMenu />
        </div>
      )}
    </div>
  );
}
