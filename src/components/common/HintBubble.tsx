import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { BUBBLE_W, placeBubble } from "../../lib/shortcuts/hintAnchor";
import { UntestedTag } from "./UntestedTag";

/**
 * A small floating coachmark anchored above/below a UI element, or a centered
 * top banner when `rect` is null. Portaled to `document.body` so it escapes the
 * side panel's `transform`/`overflow` stacking context (generalizes the
 * `LinkOpenHint` primitive in FileViewerPane, but interactive — it has buttons,
 * so no `pointer-events: none`). Positioning is computed by the caller (HintHost)
 * and passed in as `rect`; this component only paints.
 */
export function HintBubble({
  rect,
  placement,
  title,
  body,
  action,
  tag,
  onDismiss,
  onRead,
  onDisableAll,
}: {
  rect: DOMRect | null;
  placement: "top" | "bottom";
  title: string;
  body: string;
  /** Optional button that carries out what the hint describes. Running it also
   *  counts as reading the hint — the user has acted on it. */
  action?: { label: string; run: () => void };
  /** Rendered after the title (the untested pill of not-yet-verified hints). */
  tag?: ReactNode;
  /** × / Esc / Skip: closed for now, its chance unchanged. */
  onDismiss: () => void;
  /** Read: each press halves the hint's chance of showing again. */
  onRead: () => void;
  onDisableAll: () => void;
}) {
  const t = useT();
  let style: React.CSSProperties;
  let banner = false;
  if (rect) {
    // Flips to the roomier side and clamps horizontally, so an edge-anchored
    // hint never overflows off-screen.
    const spot = placeBubble(rect, placement, window.innerWidth, window.innerHeight);
    style = spot.above
      ? { left: spot.left, top: spot.top, transform: "translateY(-100%)" }
      : { left: spot.left, top: spot.top };
  } else {
    banner = true;
    style = {};
  }

  return createPortal(
    <div
      className={`hint-bubble${banner ? " hint-bubble--banner" : ""}`}
      role="dialog"
      aria-label={title}
      style={{ ...style, width: banner ? undefined : BUBBLE_W }}
    >
      <button
        type="button"
        className="hint-bubble-close"
        aria-label={t("hint.dismissAria")}
        onClick={onDismiss}
      >
        ×
      </button>
      <div className="hint-bubble-title">{title}{tag}</div>
      <div className="hint-bubble-body">{body}</div>
      <div className="hint-bubble-actions">
        <UntestedTag id="desktop.hints.read" />
        <button
          type="button"
          className="hint-bubble-link"
          title={t("hint.turnOffTitle")}
          onClick={onDisableAll}
        >
          {t("hint.turnOff")}
        </button>
        {action && (
          <button
            type="button"
            className="hint-bubble-got-it"
            onClick={() => {
              action.run();
              onRead();
            }}
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          className="hint-bubble-link"
          title={t("hint.skipTitle")}
          onClick={onDismiss}
        >
          {t("hint.skip")}
        </button>
        <button
          type="button"
          className="hint-bubble-got-it"
          title={t("hint.readTitle")}
          onClick={onRead}
        >
          {t("hint.read")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
