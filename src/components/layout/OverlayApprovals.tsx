import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useMailStore } from "../../stores/mail";
import { useRootReviewStore } from "../../stores/rootReview";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { RootReviewStrip, useDomainReview, type ReviewDomain } from "./RootReviewStrip";

/**
 * The root console's ✓ Approvals pill, in a header overlay's title bar (mail,
 * calendar, to-do): the same button and the same dropped panel, narrowed to the
 * proposals that overlay's tools made — or, with no `domain` (the cockpit),
 * the whole queue, as the console shows it. The console keeps the full queue; this
 * is a second door onto the same store, so a decision made here is gone there.
 *
 * Open/closed is local: the store's `panel` is the console's own, and the two
 * panels must not open each other. The panel's click-away catcher covers the
 * window, so the overlay cannot move under it and a click-time anchor holds.
 */
export function OverlayApprovals({ domain }: { domain?: ReviewDomain }) {
  const t = useT();
  const { waiting } = useDomainReview(domain);
  const ref = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  // The host refreshes on `root-mcp-review-changed`; a read on open covers a
  // window that has not heard one yet (drafts are the mail store's own list).
  useEffect(() => {
    void useRootReviewStore.getState().refresh();
    if (domain === "mail") void useMailStore.getState().loadAgentDrafts();
  }, [domain]);

  const toggle = () => {
    if (anchor) return setAnchor(null);
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <>
      <button
        type="button"
        ref={ref}
        className={`root-overlay-rights root-overlay-approvals${waiting > 0 ? " on" : ""}`}
        aria-expanded={anchor != null}
        title={t("rootReview.badgeHint")}
        onClick={toggle}
      >
        {t("rootReview.badge")}{waiting > 0 ? ` ${waiting}` : ""} ▾
      </button>
      <UntestedTag id="overlayApprovals.button" />
      {anchor && (
        <ContextMenuPortal
          x={anchor.x}
          y={anchor.y}
          keepBelow
          className="context-menu root-review-panel"
          onClose={() => setAnchor(null)}
        >
          <RootReviewStrip domain={domain} />
        </ContextMenuPortal>
      )}
    </>
  );
}
