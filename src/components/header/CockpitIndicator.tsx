import { useMemo } from "react";

import { useActivityStore } from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { cockpitBadge } from "../../lib/cockpit/decisions";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useDomainReview } from "../layout/RootReviewStrip";
import { CockpitGlyph } from "./HeaderGlyphs";

/**
 * The header's cockpit button, in the global-apps run beside ✉ 🗓 ☑. Its
 * badge is **derived, never acknowledged** (`cockpitBadge`): Asking +
 * Interrupted + proposals + approvals, read off the stores that already hold
 * them, so it starts no work of its own — no timer, no listener, no backend
 * read. A click opens the cockpit (the Now view of the root console's window)
 * or, when it is up on a cockpit view, closes it.
 */
export function CockpitIndicator() {
  const t = useT();
  // Up on one of the cockpit's views — Root being up is not the cockpit being up.
  const open = useRootOverlayStore((s) => s.open && s.view !== "root");
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const busyByTab = useActivityStore((s) => s.busyByTab);
  const attentionByTab = useActivityStore((s) => s.attentionByTab);
  const schedulesByTarget = useAgentSchedulesStore((s) => s.byTarget);
  const { waiting } = useDomainReview();
  const badge = useMemo(
    () => cockpitBadge({ tabsByScope, busyByTab, attentionByTab, schedulesByTarget, approvals: waiting }),
    [tabsByScope, busyByTab, attentionByTab, schedulesByTarget, waiting],
  );
  const label = badge.total > 0
    ? t("cockpit.indicatorCount", { asking: badge.asking, agentAsks: badge.agentAsks, interrupted: badge.interrupted, proposals: badge.proposals, approvals: badge.approvals })
    : t("cockpit.indicator");
  return (
    <div className="global-apps-menu cockpit-indicator no-drag">
      <button
        type="button"
        className="global-apps-menu-btn cockpit-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={open}
        onClick={() => {
          const overlay = useRootOverlayStore.getState();
          if (overlay.open && overlay.view !== "root") overlay.close();
          else overlay.openView("now");
        }}
      >
        <CockpitGlyph className="cockpit-indicator-icon" />
        {badge.total > 0 && (
          <span className={"cockpit-indicator-badge" + (badge.asking > 0 ? " asking" : "")} aria-hidden="true">
            {badge.total > 99 ? "99+" : badge.total}
          </span>
        )}
      </button>
      <UntestedTag id="cockpit.indicator" />
    </div>
  );
}
