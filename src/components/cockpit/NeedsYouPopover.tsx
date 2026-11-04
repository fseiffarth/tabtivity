import { useEffect, useRef } from "react";

import type { DecisionGroupId, Decisions } from "../../lib/cockpit/decisions";
import type { RosterRow } from "../../lib/cockpit/roster";
import type { AlertsFeed } from "../files/useAlertsFeed";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { CockpitRail } from "./CockpitRail";

/** Where the popover hangs from, and the group it opens scrolled to. */
export interface NeedsYouAnchor {
  x: number;
  y: number;
  group: DecisionGroupId | null;
}

/**
 * The Needs-you rail in the shared popover (`ContextMenuPortal`), for the
 * window's narrow bands: the "Needs you N" chip (under 820 px) and the icon rail
 * (820 to 1179 px) open it, and a picked row closes it. The real `CockpitRail`,
 * fed the Now view's own `Decisions`, so it is no second inbox and reads nothing
 * of its own. Escape and a click away close it (the portal's rules).
 */
export function NeedsYouPopover({
  anchor,
  decisions,
  alerts,
  selected,
  onPick,
  onClose,
}: {
  anchor: NeedsYouAnchor;
  decisions: Decisions;
  alerts: AlertsFeed;
  selected: string | null;
  onPick: (row: RosterRow) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchor.group) return;
    ref.current?.querySelector(`[data-group="${anchor.group}"]`)?.scrollIntoView?.({ block: "start" });
  }, [anchor.group]);
  return (
    <ContextMenuPortal x={anchor.x} y={anchor.y} keepBelow className="context-menu cockpit-needs-popover" onClose={onClose}>
      <div className="cockpit-needs-popover-body" ref={ref}>
        <CockpitRail
          decisions={decisions}
          selected={selected}
          alerts={alerts}
          onPick={(row) => {
            onPick(row);
            onClose();
          }}
        />
      </div>
    </ContextMenuPortal>
  );
}
