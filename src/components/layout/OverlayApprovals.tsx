import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useMailStore } from "../../stores/mail";
import { useRootReviewStore } from "../../stores/rootReview";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { RootReviewStrip, useDomainReview, type ReviewDomain } from "./RootReviewStrip";

/**
 * The ✓ Approvals pill, in the title bar of the root console and of the header
 * overlays (mail, calendar, to-do): one button, one dropped panel, narrowed to
 * the proposals that overlay's tools made — or, with no `domain` (the console,
 * the cockpit), the whole queue. Every pill is a door onto the same store, so a
 * decision made in one is gone from all. `advisory` (the console's) adds the
 * "review gate can be bypassed" note to the panel.
 *
 * Open/closed is local. The panel's click-away catcher covers the window, so the
 * overlay cannot move under it and a click-time anchor holds; its Escape is
 * marked handled (`defaultPrevented`), which is how the window under it knows
 * to stay open.
 */
export function OverlayApprovals({ domain, advisory = false }: { domain?: ReviewDomain; advisory?: boolean }) {
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
          <RootReviewStrip domain={domain} advisory={advisory} />
        </ContextMenuPortal>
      )}
    </>
  );
}
