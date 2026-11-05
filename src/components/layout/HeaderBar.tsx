import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../lib/platform";
import { startWindowDrag } from "../../lib/window/startWindowDrag";
import { useFullscreenMode } from "../../lib/window/fullscreenMode";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { Clock } from "../header/Clock";
import { StatusCluster } from "../header/StatusCluster";
import { WindowControls } from "../header/WindowControls";
import { HeaderSlot } from "../header/HeaderSlot";
import { headerWidthTier, isHeaderPinned, orderedHeaderIds, useHeaderPinDefaults, type HeaderWidthTier } from "../../lib/headerPins";
import { APP_ICONS } from "../header/appIcons";
import { useSettingsStore } from "../../stores/settings";
import { ProjectSwitcher } from "./ProjectSwitcher";

const NON_DRAG_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  ".no-drag",
  ".tab",
  ".tab-bar",
  ".tab-new-wrap",
].join(",");

function handleDrag(e: React.MouseEvent) {
  // Gate on `button` (singular: 0 = left) not `buttons` (the held-button bitmask).
  // WebKitGTK reports `buttons === 0` during the mousedown that begins a press —
  // the bit isn't set until the next event — so `buttons !== 1` swallowed every
  // drag on Linux (no grab ever started). `button === 0` is reliable on mousedown
  // across WebKitGTK/Chromium/WKWebView and also ignores middle/right clicks.
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!target.closest(NON_DRAG_SELECTOR)) startWindowDrag();
}

/** How long the fullscreen bar stays down after the pointer leaves it. */
const AUTOHIDE_LEAVE_MS = 450;
/** Something in the bar still needs it open: the pointer is on it, or a menu
 *  dropped out of it (hover menu or a click-opened one). */
function barBusy(header: HTMLElement | null): boolean {
  if (!header) return false;
  return (
    header.matches(":hover") ||
    useHeaderHoverMenuStore.getState().openId !== null ||
    header.querySelector("[role='menu'], .tab-new-menu, .project-switcher-add-menu") !== null
  );
}

export function HeaderBar() {
  // In the window's own fullscreen mode the bar steps out of the layout (the
  // content takes the whole screen) and slides down while the pointer is at the
  // top edge. Windowed, it is the ordinary always-visible bar.
  const fullscreen = useFullscreenMode((s) => s.on);
  const [revealed, setRevealed] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const clearHide = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const reveal = () => {
    clearHide();
    setRevealed(true);
  };
  const scheduleHide = () => {
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      // Busy (a menu is open, the pointer came back): look again shortly.
      if (barBusy(headerRef.current)) scheduleHide();
      else setRevealed(false);
    }, AUTOHIDE_LEAVE_MS);
  };
  useEffect(() => {
    if (!fullscreen) {
      clearHide();
      setRevealed(false);
    }
    return clearHide;
  }, [fullscreen]);
  const order = useSettingsStore((s) => s.settings?.header_order);
  const pins = useSettingsStore((s) => s.settings?.header_pins);
  const pinDefaults = useHeaderPinDefaults();
  const headerRef = useRef<HTMLElement>(null);
  const [widthTier, setWidthTier] = useState<HeaderWidthTier>(0);
  // The bar gives way by its own width (`headerWidthTier`): the badges and the
  // clock fold in CSS off `data-width-tier`, the cluster and the project strip's
  // box pills (`boxPillBudget`) through their props.
  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidthTier(headerWidthTier(entry.contentRect.width));
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  // (A `workspace_info` fetch whose answer was discarded, and a
  // `workspace-changed` listener unsubscribed the moment it resolved, used to
  // sit here. What the workspace backend can do is now said in Settings →
  // Layout, from `workspace_capabilities`.)

  return (
    <>
    {fullscreen && !revealed && (
      <div className="header-hotzone" aria-hidden="true" onMouseEnter={() => { reveal(); scheduleHide(); }} />
    )}
    <header
      ref={headerRef}
      className={`app-header${IS_MAC ? " is-mac" : ""}${
        fullscreen ? ` is-autohide${revealed ? " is-revealed" : ""}` : ""
      }`}
      data-width-tier={widthTier}
      onMouseDown={handleDrag}
      onMouseEnter={fullscreen ? reveal : undefined}
      onMouseLeave={fullscreen ? scheduleHide : undefined}
    >
      {/* The bar opens on the project strip itself: its leading box chip is the
          leftmost thing in the window. Its Tabtivity logo is the window's move
          handle (the ⠿ grip that stood ahead of it is gone; every empty
          stretch of the bar still drags too) and its ▾ opens the root/box
          list on hover. The clock moved to the far right, by the controls.
          The center is the project strip and nothing else. It used to carry the
          six global buttons as well, which made "center" mean both *where am I*
          and *what else can I open* — and, worse, made the one elastic thing in
          the whole bar (the pill strip) share its track with six fixed-width
          controls. Everything global now sits on the right, so the strip's only
          neighbours are separators. */}
      <div className="header-center no-drag">
        <ProjectSwitcher open widthTier={widthTier} />
      </div>
      {/* Right of the strip, in two groups separated by gap rather than by more
          hairlines: the global *apps and menus* (kept as their own buttons —
          mail, calendar and to-do each carry a live badge, which is exactly what
          a launcher menu would hide — and the ⚙, which belongs with them
          because settings are the machine's, not a project's; every one of them
          drags to any place in the run), then machine state.
          Machine state trails rather than leads: at rest it is one lamp, so it
          costs the bar nothing where it sits, and parking it past the controls
          keeps them contiguous instead of splitting them around a readout. Its
          widest members (the 280px machines list, the VPN and Mobile panels) can
          live this close to the window edge because every menu in this cluster is
          right-anchored and grows inward (see `.header-status-menu-anchor`). */}
      <div className="header-right no-drag">
        {orderedHeaderIds("apps", order)
          .filter((id) => isHeaderPinned(pins, id, pinDefaults))
          .map((id) => (
          <HeaderSlot key={id} id={id}>
            {APP_ICONS[id]}
          </HeaderSlot>
        ))}
        <span className="header-right-gap" aria-hidden="true" />
        <StatusCluster narrow={widthTier >= 3} />
        {/* The clock sits between the cluster's chevron and the window
            controls: machine-level, like the readouts it follows. */}
        <Clock />
        <span className="project-switcher-separator" aria-hidden="true" />
        <WindowControls />
      </div>
    </header>
    </>
  );
}
