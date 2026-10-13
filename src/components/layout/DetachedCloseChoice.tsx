import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * Group B #237: what the WM ✕ on a popout asks before it does anything.
 *
 * Closing a popped-out subwindow used to discard its tabs outright — PTYs
 * killed, nothing restored on relaunch — and until this group there was no
 * dock-back gesture at all, so the ✕ was simultaneously the most reachable
 * control on the window and the one irreversible one. The two outcomes are
 * genuinely different acts and neither is a safe default, so the window asks;
 * cancelling (Escape, the backdrop, or the button) leaves it open, which is the
 * right answer to a misclick.
 *
 * Portaled nowhere — a popout's root IS this window — but it must still set an
 * explicit color: `body` has none, so a dialog that inherits would render black
 * text on the dark panel (the unified-menu rule). It rides the app's canonical
 * `.modal-backdrop` + `.project-dialog` chrome like every other confirm.
 */
export function DetachedCloseChoice({
  onDock,
  onCloseTabs,
  onCancel,
}: {
  onDock: () => void;
  onCloseTabs: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const modalRef = useModalFocus(onCancel);

  // Escape cancels. Bound here rather than on the panel so it works with focus
  // anywhere in the window, including inside a terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="project-dialog detached-close-choice"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="detached-close-title">
          {t("detachedClose.title")} <UntestedTag id="detachedClose.title" />
        </h2>
        <p className="detached-close-body">{t("detachedClose.body")}</p>
        <div className="project-dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="danger" onClick={onCloseTabs}>
            {t("detachedClose.closeTabs")}
          </button>
          <button type="button" onClick={onDock}>
            {t("detachedClose.dock")}
          </button>
        </div>
      </div>
    </div>
  );
}
