import { createContext, useContext } from "react";
import { wrapStep } from "../../lib/wrapStep";
import { createPortal } from "react-dom";

/**
 * The window's title bar, as far as a view that is not Root needs it: the
 * sub-bar's strip (Mail's inbox + composer tabs, the Agents and Models
 * sections) and the slot before the approvals pill where a view with a docked
 * agent puts its ✦ button. `RootOverlay` fills it; a view portals into the
 * elements, so its state stays in the view while its controls sit in the bar.
 * A portal bubbles React events through the view, not the bar, so the strip's
 * slot forwards the bar's press-to-move and double-click-to-fill itself
 * (`RootView` does the same for Root's strip).
 */
export interface ViewBarSlots {
  strip: HTMLElement | null;
  agent: HTMLElement | null;
  onBarPointerDown?: (e: React.PointerEvent) => void;
  onBarDoubleClick?: (e: React.MouseEvent) => void;
}

export const ViewBarSlotsContext = createContext<ViewBarSlots>({ strip: null, agent: null });

export function useViewBarSlots(): ViewBarSlots {
  return useContext(ViewBarSlotsContext);
}

/** Portal `children` into the sub-bar's strip; nothing until the bar has one. */
export function ViewBarStrip({ children }: { children: React.ReactNode }) {
  const { strip, onBarPointerDown, onBarDoubleClick } = useViewBarSlots();
  if (!strip) return null;
  return createPortal(
    <div className="root-overlay-slot" onPointerDown={onBarPointerDown} onDoubleClick={onBarDoubleClick}>
      {children}
    </div>,
    strip,
  );
}

/** Portal `children` (the ✦ docked-agent button) into the title bar's controls. */
export function ViewBarAgentSlot({ children }: { children: React.ReactNode }) {
  const { agent } = useViewBarSlots();
  return agent ? createPortal(children, agent) : null;
}

/**
 * A view tab's press, click and keys: the left button picks on its press; a
 * click that is no mouse press (detail 0, steering's Enter on the window bar)
 * picks too, a real one has already picked on its mouse-down. Enter / Space
 * pick; the arrows walk focus over the tablist's tabs (roving), wrapping.
 */
export function viewTabHandlers(pick: () => void) {
  return {
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      if (e.button === 0) pick();
    },
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (e.detail === 0) pick();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tabs = Array.from(
        e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
      );
      const at = tabs.indexOf(e.currentTarget);
      const next = tabs[wrapStep(at, e.key === "ArrowRight" ? 1 : -1, tabs.length)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    },
  };
}

export interface ViewSubTab<T extends string> {
  id: T;
  label: string;
}

/**
 * A view's sections as tabs in the sub-bar: a tablist of the shipped `.tab`
 * look, roving arrows, Enter / Space to choose. Mail's tabs are its own
 * (inbox, messages and composers close and drag); these are the fixed sections
 * of the Agents and Models views.
 */
export function ViewSubTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  extra,
}: {
  items: readonly ViewSubTab<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** After the tabs, in the bar (the view's untested pill). */
  extra?: React.ReactNode;
}) {
  return (
    <ViewBarStrip>
      <div className="tab-strip root-view-substrip" role="tablist" aria-label={ariaLabel}>
        {items.map((item) => (
          <div
            key={item.id}
            role="tab"
            tabIndex={value === item.id ? 0 : -1}
            aria-selected={value === item.id}
            className={`tab root-view-subtab${value === item.id ? " active" : ""}`}
            data-view-section={item.id}
            {...viewTabHandlers(() => onChange(item.id))}
          >
            <span className="tab-label">{item.label}</span>
          </div>
        ))}
      </div>
      {extra}
    </ViewBarStrip>
  );
}
