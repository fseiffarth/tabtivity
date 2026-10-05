import { useEffect, type ReactNode } from "react";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { MachinesGlyph } from "./HeaderGlyphs";
import { storageKey } from "../../lib/brand";

/**
 * The **Machines overlay**'s chrome — what a click on the header's Machines
 * button opens. The Models & agents overlay's frame (`models/ModelsOverlay`):
 * `.root-overlay.subwindow`, moved and resized by `useFloatingFrame`, a bar
 * with the mark, the fill button and ×, and a body that is its overview grid's
 * `.models-home` page.
 *
 * It owns no machine state. `header/MachinesIndicator` renders its own list
 * into `children` (`surface="overlay"`: every row a `.models-tile`, the rows
 * one grid), so the dropdown and the overlay are one implementation — the
 * probes, the connect/check/HPC rules, the forms — and can never disagree.
 *
 * Mounted at the shell before the host-key prompt, the HPC guard and the
 * machine monitor (`layout/AppShell`): each is raised by a gesture made in
 * here and has to land on top of it.
 */
export function MachinesOverlayFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const close = () => useMachinesOverlayStore.getState().close();
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame(storageKey("machinesOverlayFrame"));
  // The move hint on the mark alone, as the Models overlay places it.
  const { title: moveHint, ...barRest } = barProps;

  // Focus leaves the header button for the first control inside, so Escape
  // and the arrow keys are aimed here from the first keystroke.
  useEffect(() => {
    frameRef.current?.querySelector<HTMLElement>(".machines-home button:not(:disabled)")?.focus();
  }, [frameRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A terminal sign-in opens the root console above this overlay; its
      // Escape is its own. So is a key aimed outside this frame (focus on
      // <body> still counts — a click on the bar drops it there).
      if (useRootOverlayStore.getState().open) return;
      const tgt = e.target;
      if (tgt instanceof Node && tgt !== document.body && !frameRef.current?.contains(tgt)) return;
      e.stopPropagation();
      useMachinesOverlayStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frameRef]);

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop machines-overlay-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts in a form field and ends out here
        // is a text selection, not a dismissal.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused machines-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("machines.overlayTitle")}
      >
        {grips}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark models-overlay-mark" title={moveHint}>
            <MachinesGlyph className="machines-overlay-glyph" />
            <span className="app-overlay-label models-overlay-label">{t("machines.overlayTitle")}</span>
            <UntestedTag id="machines.overlayTitle" />
          </div>
          <div className="machines-overlay-spacer" />
          <div className="tab-controls root-overlay-controls">
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={close}
            >
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body models-overlay-body machines-overlay-body">
          <div className="models-home machines-home">
            <div className="models-home-inner machines-home-inner">
              <p className="models-home-lead">{t("machines.overlayLead")}</p>
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
