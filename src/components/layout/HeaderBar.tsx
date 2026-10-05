import { IS_MAC } from "../../lib/platform";
import { startWindowDrag } from "../../lib/window/startWindowDrag";
import { Clock } from "../header/Clock";
import { StatusCluster } from "../header/StatusCluster";
import { MailIndicator } from "../header/MailIndicator";
import { CalendarIndicator } from "../header/CalendarIndicator";
import { TodoIndicator } from "../header/TodoIndicator";
import { InboxIndicator } from "../header/InboxIndicator";
import { SettingsMenu } from "../header/SettingsMenu";
import { WindowControls } from "../header/WindowControls";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { LocalModelMenu } from "./LocalModelMenu";

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

export function HeaderBar() {
  // (A `workspace_info` fetch whose answer was discarded, and a
  // `workspace-changed` listener unsubscribed the moment it resolved, used to
  // sit here. What the workspace backend can do is now said in Settings →
  // Layout, from `workspace_capabilities`.)

  return (
    <header
      className={`app-header${IS_MAC ? " is-mac" : ""}`}
      onMouseDown={handleDrag}
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
        <ProjectSwitcher open />
      </div>
      {/* Right of the strip, in three groups separated by gap rather than by more
          hairlines: the global *apps* (kept as their own buttons — mail, calendar
          and to-do each carry a live badge, which is exactly what a launcher menu
          would hide), then the global *menus*, then machine state.
          Machine state trails rather than leads: at rest it is one lamp, so it
          costs the bar nothing where it sits, and parking it past the gear keeps
          the controls contiguous instead of splitting them around a readout. Its
          widest members (the 280px machines list, the VPN and Mobile panels) can
          live this close to the window edge because every menu in this cluster is
          right-anchored and grows inward (see `.header-status-menu-anchor`). */}
      <div className="header-right no-drag">
        <MailIndicator />
        <CalendarIndicator />
        <TodoIndicator />
        <InboxIndicator />
        <span className="header-right-gap" aria-hidden="true" />
        <LocalModelMenu />
        {/* Settings belong to the machine, not to a project, so the gear stays
            with the other global buttons rather than at the head of the project
            strip, where it put the switcher's own controls on both sides of a
            scrolling row. */}
        <SettingsMenu />
        <span className="header-right-gap" aria-hidden="true" />
        <StatusCluster />
        {/* The clock sits between the cluster's chevron and the window
            controls: machine-level, like the readouts it follows. */}
        <Clock />
        <span className="project-switcher-separator" aria-hidden="true" />
        <WindowControls />
      </div>
    </header>
  );
}
