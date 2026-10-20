import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TabEntry } from "../../stores/tabs";
import { TAB_ACCENT } from "./newTabItems";
import { tabColorCss } from "../../lib/theme/tabColors";
import { TabStatusMark, statusMarkSlots } from "./TabLocalityBadges";
import { UntestedTag } from "../common/UntestedTag";
import { useClampToViewport } from "../../hooks/useClampToViewport";
import { useT } from "../../lib/i18n";

/** How long the list stays up after the pointer leaves the chip or the list —
 *  long enough to cross the gap between them, short enough to feel like hover. */
const CLOSE_DELAY_MS = 180;

export interface StackMember {
  tab: TabEntry;
  /** Position in the bar's ordered tabs. */
  index: number;
  /** The tab's status-ring class (`busyStateClass` / `attentionStateClass`). */
  stateClass: string;
}

interface Props {
  name: string;
  /** The chip's slot in the bar — its first member's index. */
  index: number;
  members: StackMember[];
  activeKey: string | null;
  /** Hide the list (a drag or another menu is up). */
  suppressed: boolean;
  onActivate: (key: string) => void;
  onCloseTab: (key: string) => void;
  onTabContextMenu: (e: React.MouseEvent, key: string, index: number) => void;
  onStackContextMenu: (e: React.MouseEvent) => void;
}

/** The chip's state ring: the one most worth seeing among its members — a
 *  pending decision is about the user, so it outranks work in progress. */
function stackStateClass(members: StackMember[]): string {
  const pick = (needle: string) => members.find((m) => m.stateClass.includes(needle))?.stateClass;
  return pick("needs-decision") ?? pick("working") ?? pick("finished") ?? pick("interrupted") ?? "";
}

/**
 * A collapsed tab group in the tab strip (see `lib/tabStacks`). Hovering it
 * drops a list of its tabs underneath, each one click away; the chip itself
 * reads as the active tab when one of its members is.
 */
export function TabStackChip({
  name,
  index,
  members,
  activeKey,
  suppressed,
  onActivate,
  onCloseTab,
  onTabContextMenu,
  onStackContextMenu,
}: Props) {
  const t = useT();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setAnchor(null);
    }, CLOSE_DELAY_MS);
  };
  const open = () => {
    cancelClose();
    const r = chipRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left, y: r.bottom + 2 });
  };
  useEffect(() => cancelClose, []);
  useEffect(() => {
    if (suppressed) setAnchor(null);
  }, [suppressed]);

  const active = members.find((m) => m.tab.key === activeKey);
  const lead = active ?? members[0];
  const accent = tabColorCss(lead.tab.color) ?? TAB_ACCENT[lead.tab.kind];
  // Members' classes already leave out what the viewed tab needn't announce.
  const stateClass = stackStateClass(members);
  const style = { "--tab-accent": accent } as React.CSSProperties;
  const menuOpen = anchor !== null && !suppressed;

  return (
    <>
      <div
        ref={chipRef}
        className={`tab tab-stack${active ? " active" : ""}${stateClass}${menuOpen ? " stack-open" : ""}`}
        style={style}
        data-tab-index={index}
        data-stack={name}
        role="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        // A label, not a `title`: a native tooltip would sit over the list.
        aria-label={t("tabStack.chipTitle", { name, count: members.length })}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        // A click picks too: the group's current tab, else its first — and it
        // opens the list for a pointer that never hovered (touch, pen).
        onClick={() => {
          open();
          if (!active) onActivate(members[0].tab.key);
        }}
        onContextMenu={(e) => {
          setAnchor(null);
          onStackContextMenu(e);
        }}
      >
        <TabStatusMark
          stateClass={stateClass}
          slots={Math.max(...members.map((m) => statusMarkSlots(m.tab.kind))) as 0 | 1 | 2}
        />
        <span className="tab-stack-name">{name}</span>
        {active && <span className="tab-label tab-stack-current">{active.tab.label}</span>}
        <span className="tab-stack-count">{members.length}</span>
      </div>
      {menuOpen && (
        <StackMenu
          anchor={anchor}
          name={name}
          members={members}
          activeKey={activeKey}
          onEnter={cancelClose}
          onLeave={scheduleClose}
          onPick={(key) => {
            setAnchor(null);
            onActivate(key);
          }}
          onCloseTab={onCloseTab}
          onTabContextMenu={(e, key, i) => {
            setAnchor(null);
            onTabContextMenu(e, key, i);
          }}
        />
      )}
    </>
  );
}

function StackMenu({
  anchor,
  name,
  members,
  activeKey,
  onEnter,
  onLeave,
  onPick,
  onCloseTab,
  onTabContextMenu,
}: {
  anchor: { x: number; y: number };
  name: string;
  members: StackMember[];
  activeKey: string | null;
  onEnter: () => void;
  onLeave: () => void;
  onPick: (key: string) => void;
  onCloseTab: (key: string) => void;
  onTabContextMenu: (e: React.MouseEvent, key: string, index: number) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(anchor);
  useLayoutEffect(() => setPos(anchor), [anchor]);
  useClampToViewport(ref, pos, setPos, { axis: "x" });

  return createPortal(
    <div
      ref={ref}
      className="tab-new-menu context-menu-portal tab-stack-menu"
      style={{ left: pos?.x ?? anchor.x, top: pos?.y ?? anchor.y }}
      role="menu"
      aria-label={t("tabStack.menuAria", { name })}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // Keep presses inside the list out of the bar's and the panes' handlers.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="tab-new-menu-group-label">
        {name}
        <UntestedTag id="tabStackChip.1" />
      </div>
      {members.map(({ tab, index, stateClass }) => {
        const accent = tabColorCss(tab.color) ?? TAB_ACCENT[tab.kind];
        return (
          <button
            key={tab.key}
            type="button"
            role="menuitem"
            className={`tab-new-menu-item tab-stack-row${tab.key === activeKey ? " active" : ""}`}
            data-tab-key={tab.key}
            onClick={() => onPick(tab.key)}
            onContextMenu={(e) => onTabContextMenu(e, tab.key, index)}
          >
            <span className="tab-new-menu-dot" style={{ color: accent }}>●</span>
            <span className="tab-stack-row-label">{tab.label}</span>
            <TabStatusMark stateClass={stateClass} slots={statusMarkSlots(tab.kind)} />
            <span
              className="tab-close tab-stack-row-close"
              role="button"
              title={t("tabBar.closeTabTitle")}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.key);
              }}
            >
              ×
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
