import { useMemo, useState } from "react";
import { useRootOverlayStore, type RootOverlayView } from "../../stores/rootOverlay";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { attentionStateClass, busyStateClass, useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { VIEW_GROUPS } from "../../lib/cockpit/views";
import { viewEnabled } from "../../lib/cockpit/viewGates";
import { scopeLamp, type ScopeLamp } from "../../lib/cockpit/scopeLamp";
import type { FrameBand } from "../../lib/window/frameBand";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { ChevronDownIcon } from "../common/icons/Icon";
import { TabStatusMark } from "../tabs/TabLocalityBadges";
import { VIEW_LABEL, ViewIcon } from "../cockpit/viewIcons";
import { viewTabHandlers } from "./viewBarSlots";

/**
 * The Root tab's lamp: one scope's activity (root's) rolled into the tab's own
 * state classes, so it is the tab strip's ring and `?` / ▶ mark and inherits
 * its rules (a static dotted ring; the ▶ breathing stops under
 * `[data-software-paint]`). It reads the activity store and root's tab list
 * only, so it costs nothing while another view is shown, and it lives in its
 * own component so a busy terminal re-renders this tab and not the window.
 */
function RootTabLamp({ children }: { children: (lamp: ScopeLamp, stateClass: string) => React.ReactNode }) {
  const tabs = useTabsStore((s) => s.tabsByScope[ROOT_SCOPE]);
  const busy = useActivityStore((s) => s.busyByTab);
  const attention = useActivityStore((s) => s.attentionByTab);
  const lamp = useMemo(
    () => scopeLamp(ROOT_SCOPE, tabs ?? [], busy, attention),
    [tabs, busy, attention],
  );
  // A question outranks work (the strip's own order for a tab that does both).
  const stateClass =
    lamp.asking > 0
      ? attentionStateClass("decision")
      : lamp.working > 0
        ? busyStateClass(lamp.agentWorking ? "agent" : "shell", "agent")
        : "";
  return <>{children(lamp, stateClass)}</>;
}

const pick = (id: RootOverlayView) => useRootOverlayStore.getState().openView(id);

/**
 * The window's view strip: Root and the cockpit views on the left, system
 * views in the middle, and cross-project apps on the right. Feature gates
 * (`lib/cockpit/viewGates`) hide disabled views and dividers for empty groups.
 *
 * Three bands (`lib/window/frameBand`, the frame's width): `wide` shows icon +
 * label, `mid` icons only (the label is the tab's tooltip and accessible name;
 * CSS hides it), `narrow` folds the strip into the current view's tab and a ▾
 * that opens the rest as a menu.
 */
export function RootViewStrip({ view, band }: { view: RootOverlayView; band: FrameBand }) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const groups = VIEW_GROUPS.map((g) => g.filter((id) => viewEnabled(id, settings)));

  const viewTab = (id: RootOverlayView, children: React.ReactNode, extra = "") => {
    const label = t(VIEW_LABEL[id]);
    return (
      <div
        key={id}
        role="tab"
        tabIndex={view === id ? 0 : -1}
        aria-selected={view === id}
        aria-label={label}
        title={label}
        className={`tab root-view-tab${extra}${view === id ? " active" : ""}`}
        data-root-view={id}
        // Roving arrows across the groups; Enter / Space and steering's Enter pick.
        {...viewTabHandlers(() => pick(id))}
      >
        {children}
      </div>
    );
  };

  const plainTab = (id: Exclude<RootOverlayView, "root">) =>
    viewTab(
      id,
      <>
        <ViewIcon view={id} />
        <span className="tab-label">{t(VIEW_LABEL[id])}</span>
      </>,
      " cockpit-view-tab",
    );

  const rootTab = () => (
    <RootTabLamp key="root">
      {(lamp, stateClass) =>
        viewTab(
          "root",
          <>
            <TabStatusMark stateClass={stateClass} />
            <span className="root-view-star"><ViewIcon view="root" className="" /></span>
            <span className="tab-label">{t(VIEW_LABEL.root)}</span>
            {lamp.asking > 0 && (
              <span
                className="root-view-count"
                title={t("cockpit.view.rootAsking", { count: lamp.asking })}
                aria-label={t("cockpit.view.rootAsking", { count: lamp.asking })}
              >
                {lamp.asking}
              </span>
            )}
          </>,
          ` root-view-tab-root${stateClass}`,
        )
      }
    </RootTabLamp>
  );

  const tabOf = (id: RootOverlayView) => (id === "root" ? rootTab() : plainTab(id));

  if (band === "narrow") {
    return (
      <div className="tab-strip root-view-strip" role="tablist" aria-label={t("rootConsole.viewStrip")}>
        {viewEnabled(view, settings) && tabOf(view)}
        <button
          type="button"
          className="root-view-more"
          title={t("cockpit.view.more")}
          aria-label={t("cockpit.view.more")}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu ? null : { x: r.left, y: r.bottom });
          }}
        >
          <ChevronDownIcon />
        </button>
        {menu && (
          <ContextMenuPortal x={menu.x} y={menu.y} keepBelow className="tab-new-menu root-view-menu" onClose={() => setMenu(null)}>
            {groups.filter((g) => g.length > 0).map((g, i) => (
              <div key={g.join()} className="root-view-menu-group" role="group">
                {i > 0 && <div className="root-view-menu-sep" role="separator" />}
                {g.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className={`tab-new-menu-item root-view-menu-item${view === id ? " active" : ""}`}
                    aria-current={view === id ? "true" : undefined}
                    onClick={() => {
                      setMenu(null);
                      pick(id);
                    }}
                  >
                    <ViewIcon view={id} />
                    <span>{t(VIEW_LABEL[id])}</span>
                  </button>
                ))}
              </div>
            ))}
          </ContextMenuPortal>
        )}
      </div>
    );
  }

  return (
    <div className="tab-strip root-view-strip root-view-strip-expanded" role="tablist" aria-label={t("rootConsole.viewStrip")}>
      {/* Space on both sides of the system views, even when all apps are hidden. */}
      {groups.map((g, i) => [
        i > 1 && <span key={`space${i}`} className="root-view-spacer" aria-hidden="true" />,
        i > 0 && g.length > 0 && <span key={`sep${i}`} className="root-view-divider" role="presentation" />,
        ...g.map(tabOf),
      ])}
    </div>
  );
}
