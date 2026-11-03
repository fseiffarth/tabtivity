import { useEffect } from "react";

import { COCKPIT_VIEWS, useCockpitStore, type CockpitView } from "../../stores/cockpit";
import { useExperimental } from "../../lib/experimental";
import { useT, type TranslationKey } from "../../lib/i18n";
import { storageKey } from "../../lib/brand";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { CloseIcon } from "../common/icons/Icon";
import { CockpitGlyph } from "../header/HeaderGlyphs";
import { OverlayApprovals } from "../layout/OverlayApprovals";
import { CockpitViewBody } from "./CockpitViews";

const VIEW_LABEL: Record<CockpitView, TranslationKey> = {
  now: "cockpit.view.now",
  projects: "cockpit.view.projects",
  tonight: "cockpit.view.tonight",
  usage: "cockpit.view.usage",
};

/**
 * The desktop cockpit (`docs/desktop_cockpit_plan.md`): every project's agents,
 * decisions and machines in one header overlay — the Mail / Calendar / To-do
 * family's chrome (`TodoOverlay`'s shape: gate, Escape, backdrop, frame), with
 * four fixed view tabs in the strip where mail keeps its message tabs.
 *
 * Gated by the `cockpit` experiment. Switching it off takes the surface away
 * rather than leaving it on screen over a button that is gone.
 *
 * **Nothing runs while it is shut**: the lazy host in `AppShell` mounts this
 * only while the store says open, so no listener, timer or backend read of the
 * cockpit's exists until it is. A hidden view renders nothing either — only the
 * shown one mounts.
 *
 * **Not mounted in a popout** (`DetachedApp` has no header, and the store is
 * per window).
 */
export function CockpitOverlayHost() {
  const t = useT();
  const enabled = useExperimental("cockpit");
  const open = useCockpitStore((s) => s.overlayOpen);
  const view = useCockpitStore((s) => s.view);
  const live = enabled && open;
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("cockpitOverlayFrame"));

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      // An Escape something inside already took (a field, a menu, the
      // approvals panel, an agent pane) is not ours.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as Element | null)?.closest?.(".cockpit-detail-pane")) return;
      e.stopPropagation();
      useCockpitStore.getState().closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  if (!live) return null;
  const { title: moveHint, ...barRest } = barProps;

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useCockpitStore.getState().closeOverlay();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused cockpit-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("cockpit.title")}
      >
        {grips}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark" title={moveHint}>
            <CockpitGlyph className="cockpit-overlay-glyph" />
            <span className="app-overlay-label">{t("cockpit.title")}</span>
            <UntestedTag id="cockpit.title" />
          </div>
          <div className="tab-strip" role="tablist">
            {COCKPIT_VIEWS.map((id) => (
              <div
                key={id}
                role="tab"
                tabIndex={0}
                aria-selected={view === id}
                className={`tab cockpit-view-tab${view === id ? " active" : ""}`}
                data-cockpit-view={id}
                onMouseDown={(e) => {
                  if (e.button === 0) useCockpitStore.getState().setView(id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    useCockpitStore.getState().setView(id);
                  }
                }}
              >
                <span className="tab-label">{t(VIEW_LABEL[id])}</span>
              </div>
            ))}
          </div>
          <div className="tab-controls root-overlay-controls">
            <OverlayApprovals />
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => useCockpitStore.getState().closeOverlay()}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="subwindow-body cockpit-overlay-body">
          <CockpitViewBody view={view} />
        </div>
      </div>
    </div>
  );
}
